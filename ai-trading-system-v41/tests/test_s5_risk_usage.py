"""S5 real initial-risk usage accounting (owned positions, not handwritten context)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

import pytest

from src.core.signal_lifecycle import TradeIntent
from src.runtime.alpha_execution import LEGACY_PAPER_SOURCE
from src.runtime.engine_runtime import EngineRuntime
from src.runtime.engine_store import EngineStore
from src.runtime.position_ownership import PositionOwnershipRegistry
from src.runtime.risk_usage import (
    PORTFOLIO_RISK_BUDGET_EXCEEDED,
    STRATEGY_RISK_CAP_EXCEEDED,
    authorize_opening,
    compute_risk_usage,
    enrich_entry_risk_snapshot,
    is_countable_owned_position,
    planned_trade_risk_pct,
    strategy_initial_risk_cap,
)
from src.strategies.s5_risk_budget import S5RiskBudgetAllocator
from src.telemetry.dashboard_snapshot import build_dashboard_snapshot, serialize_s5

ROOT = Path(__file__).resolve().parents[1]
CFG_PATH = ROOT / "config" / "system_config.json"
CFG = json.loads(CFG_PATH.read_text(encoding="utf-8"))

EQUITY = 10_000.0
S1_PLANNED = 0.004
ENTRY = 100_000.0
STOP = 99_000.0  # 1000 USDT / BTC → 0.4% of 10k = 0.04 BTC planned


def _snap(*, filled: float, planned: float = 0.04, risk_pct: float = S1_PLANNED, sid: str = "S1") -> dict:
    return enrich_entry_risk_snapshot(
        {"risk_pct": risk_pct, "equity": EQUITY, "base_quantity": planned},
        filled_base_quantity=filled,
        origin_strategy_id=sid,
        entry_price=ENTRY,
        stop_price=STOP,
        equity=EQUITY,
        planned_base_quantity=planned,
        planned_risk_pct=risk_pct,
    )


def _owned(
    *,
    sid: str = "S1",
    qty: float = 0.04,
    planned: float = 0.04,
    status: str = "OPEN",
    meta: Optional[dict] = None,
    risk_pct: float = S1_PLANNED,
    ti: str = "ti-1",
) -> dict:
    return {
        "position_id": f"pos-{ti}",
        "symbol": "BTC-USDT-SWAP",
        "side": "long",
        "quantity": qty,
        "origin_strategy_id": sid,
        "origin_trade_intent_id": ti,
        "status": status,
        "entry_risk_snapshot": _snap(filled=qty, planned=planned, risk_pct=risk_pct, sid=sid),
        "stop_policy_snapshot": {"stop_price": STOP},
        "metadata": dict(meta or {"source": "node_gateway_filled", "execution_status": "FILLED"}),
    }


def _runtime(monkeypatch, tmp_path, name: str = "risk.db") -> EngineRuntime:
    monkeypatch.setenv("V41_ENGINE_AUTOSTART", "0")
    rt = EngineRuntime(config_path=CFG_PATH, mode="paper")
    rt.store = EngineStore(tmp_path / name)
    rt.positions = PositionOwnershipRegistry()
    rt.orchestrator.context = {"equity": EQUITY}
    return rt


def test_config_caps_unchanged():
    assert CFG["S1_trend"]["risk_per_trade_pct_equity"] == pytest.approx(0.004)
    assert CFG["S1_trend"]["strategy_initial_risk_cap_pct_equity"] == pytest.approx(0.0125)
    assert CFG["global_risk"]["max_initial_risk_all_open_positions_pct_equity"] == pytest.approx(0.025)
    assert CFG["S3_regime"]["risk_multiplier_by_regime"]["range"] == pytest.approx(0.4)
    assert "per_strategy_initial_risk_cap_pct_equity" not in (CFG.get("global_risk") or {})
    assert strategy_initial_risk_cap(CFG, "S1") == pytest.approx(0.0125)
    assert strategy_initial_risk_cap(CFG, "S2") == pytest.approx(0.0075)
    assert planned_trade_risk_pct(CFG, "S1") == pytest.approx(0.004)


def test_1_no_position_used_zero():
    usage = compute_risk_usage([], current_equity=EQUITY)
    assert usage["portfolio_risk_used_pct_equity"] == pytest.approx(0.0)
    assert usage["strategy_risk_used_pct_equity"]["S1"] == pytest.approx(0.0)
    assert usage["counted_positions"] == 0


def test_2_s1_filled_0_4():
    usage = compute_risk_usage([_owned()], current_equity=EQUITY)
    assert usage["portfolio_risk_used_pct_equity"] == pytest.approx(0.004)
    assert usage["strategy_risk_used_pct_equity"]["S1"] == pytest.approx(0.004)
    assert usage["strategy_risk_used_pct_equity"]["S2"] == pytest.approx(0.0)


def test_3_partial_50_percent():
    usage = compute_risk_usage([_owned(qty=0.02, planned=0.04)], current_equity=EQUITY)
    assert usage["portfolio_risk_used_pct_equity"] == pytest.approx(0.002)
    assert usage["strategy_risk_used_pct_equity"]["S1"] == pytest.approx(0.002)


def test_4_two_s1_positions_sum():
    rows = [
        _owned(qty=0.04, ti="ti-a"),
        _owned(qty=0.04, ti="ti-b"),
    ]
    usage = compute_risk_usage(rows, current_equity=EQUITY)
    assert usage["portfolio_risk_used_pct_equity"] == pytest.approx(0.008)
    assert usage["strategy_risk_used_pct_equity"]["S1"] == pytest.approx(0.008)


def test_5_s1_plus_s2_split():
    rows = [
        _owned(sid="S1", qty=0.04, ti="ti-s1"),
        _owned(sid="S2", qty=0.04, ti="ti-s2", risk_pct=0.004),
    ]
    usage = compute_risk_usage(rows, current_equity=EQUITY)
    assert usage["strategy_risk_used_pct_equity"]["S1"] == pytest.approx(0.004)
    assert usage["strategy_risk_used_pct_equity"]["S2"] == pytest.approx(0.004)
    assert usage["portfolio_risk_used_pct_equity"] == pytest.approx(0.008)


def test_6_shadow_position_does_not_count():
    shadow = _owned(meta={"source": "node_gateway_filled", "shadow": True, "alpha_execution": "SHADOW"})
    usage = compute_risk_usage([shadow], current_equity=EQUITY)
    assert is_countable_owned_position(shadow) is False
    assert usage["portfolio_risk_used_pct_equity"] == pytest.approx(0.0)
    assert usage["strategy_risk_used_pct_equity"]["S1"] == pytest.approx(0.0)


def test_7_would_submit_does_not_count():
    row = _owned(meta={"execution_status": "WOULD_SUBMIT", "source": "node_gateway"})
    usage = compute_risk_usage([row], current_equity=EQUITY)
    assert is_countable_owned_position(row) is False
    assert usage["portfolio_risk_used_pct_equity"] == pytest.approx(0.0)


def test_8_submitted_zero_fill_does_not_count():
    row = _owned(qty=0.0, meta={"execution_status": "SUBMITTED"})
    usage = compute_risk_usage([row], current_equity=EQUITY)
    assert is_countable_owned_position(row) is False
    assert usage["portfolio_risk_used_pct_equity"] == pytest.approx(0.0)


def test_9_legacy_paper_does_not_count():
    row = _owned(meta={"source": LEGACY_PAPER_SOURCE, "legacy_mark": "LEGACY_PAPER_POSITION"})
    usage = compute_risk_usage([row], current_equity=EQUITY)
    assert is_countable_owned_position(row) is False
    assert usage["portfolio_risk_used_pct_equity"] == pytest.approx(0.0)


def test_10_manual_exchange_position_does_not_count():
    row = _owned(meta={"origin_kind": "exchange_observed", "source": "exchange_observed"})
    usage = compute_risk_usage([row], current_equity=EQUITY)
    assert is_countable_owned_position(row) is False
    assert usage["portfolio_risk_used_pct_equity"] == pytest.approx(0.0)


def test_11_full_close_releases_risk(monkeypatch, tmp_path):
    rt = _runtime(monkeypatch, tmp_path, "close.db")
    rt.register_owned_position(
        {
            "symbol": "BTC-USDT-SWAP",
            "side": "long",
            "quantity": 0.04,
            "origin_strategy_id": "S1",
            "origin_trade_intent_id": "ti-close",
            "entry_price": ENTRY,
            "stop_price": STOP,
            "entry_risk_snapshot": _snap(filled=0.04),
            "metadata": {"source": "node_gateway_filled", "execution_status": "FILLED"},
        }
    )
    before = compute_risk_usage(rt.positions.list_open(), current_equity=EQUITY)
    assert before["portfolio_risk_used_pct_equity"] == pytest.approx(0.004)
    closed = rt.positions.list_open()[0]
    rt.positions.close(closed.position_id)
    after = compute_risk_usage(rt.positions.list_open(), current_equity=EQUITY)
    assert after["portfolio_risk_used_pct_equity"] == pytest.approx(0.0)
    assert after["strategy_risk_used_pct_equity"]["S1"] == pytest.approx(0.0)


def test_12_partial_exit_proportional(monkeypatch, tmp_path):
    rt = _runtime(monkeypatch, tmp_path, "pexit.db")
    pos = rt.register_owned_position(
        {
            "symbol": "BTC-USDT-SWAP",
            "side": "long",
            "quantity": 0.04,
            "origin_strategy_id": "S1",
            "origin_trade_intent_id": "ti-exit",
            "entry_price": ENTRY,
            "stop_price": STOP,
            "entry_risk_snapshot": _snap(filled=0.04),
            "metadata": {"source": "node_gateway_filled", "execution_status": "FILLED"},
        }
    )
    rt.reduce_owned_position(position_id=pos["position_id"], close_qty=0.02)
    usage = compute_risk_usage(rt.positions.list_open(), current_equity=EQUITY)
    assert usage["portfolio_risk_used_pct_equity"] == pytest.approx(0.002)
    still = rt.positions.list_open()
    assert len(still) == 1
    assert still[0].quantity == pytest.approx(0.02)


def test_13_portfolio_projected_over_cap_shrinks():
    usage = compute_risk_usage(
        [_owned(ti="a"), _owned(ti="b")],
        current_equity=EQUITY,
    )
    assert usage["portfolio_risk_used_pct_equity"] == pytest.approx(0.008)
    auth = authorize_opening(
        strategy_id="S1",
        planned_trade_risk_pct_equity=0.004,
        usage=usage,
        portfolio_risk_limit_pct_equity=0.01,
        strategy_risk_limit_pct_equity=0.0125,
    )
    assert auth.action == "SHRINK"
    assert auth.reason_code == PORTFOLIO_RISK_BUDGET_EXCEEDED
    assert auth.allowed_risk_pct_equity == pytest.approx(0.002)
    assert auth.projected_portfolio_risk_pct_equity == pytest.approx(0.01)
    assert auth.projected_portfolio_risk_pct_equity <= 0.01 + 1e-12


def test_13b_portfolio_full_blocks():
    usage = compute_risk_usage(
        [_owned(ti="a"), _owned(ti="b"), _owned(qty=0.02, planned=0.04, ti="c")],
        current_equity=EQUITY,
    )
    assert usage["portfolio_risk_used_pct_equity"] == pytest.approx(0.01)
    auth = authorize_opening(
        strategy_id="S1",
        planned_trade_risk_pct_equity=0.004,
        usage=usage,
        portfolio_risk_limit_pct_equity=0.01,
        strategy_risk_limit_pct_equity=0.0125,
    )
    assert auth.action == "BLOCK"
    assert auth.reason_code == PORTFOLIO_RISK_BUDGET_EXCEEDED
    assert auth.allowed_risk_pct_equity == pytest.approx(0.0)


def test_14_s1_strategy_cap_1_25_shrinks():
    # 1.1% used via frozen pct so we do not need 11 identical fills
    usage = {
        "portfolio_risk_used_pct_equity": 0.011,
        "strategy_risk_used_pct_equity": {"S1": 0.011, "S2": 0.0},
    }
    auth = authorize_opening(
        strategy_id="S1",
        planned_trade_risk_pct_equity=0.004,
        usage=usage,
        portfolio_risk_limit_pct_equity=0.025,
        strategy_risk_limit_pct_equity=0.0125,
    )
    assert auth.action == "SHRINK"
    assert auth.reason_code == STRATEGY_RISK_CAP_EXCEEDED
    assert auth.allowed_risk_pct_equity == pytest.approx(0.0015)


def test_15_range_portfolio_budget_1_percent():
    alloc = S5RiskBudgetAllocator(CFG)
    ctx = {
        "active_strategy_id": "S1",
        "S3.risk_multiplier": 0.4,
        "global_drawdown_multiplier": 1.0,
        "daily_loss_multiplier": 1.0,
        "risk_usage": compute_risk_usage([], current_equity=EQUITY),
    }
    out = alloc.allocate(regime="range", health_scores={"S1": 90, "S2": 80}, context=ctx)
    assert out["portfolio_risk_budget_pct_equity"] == pytest.approx(0.025 * 0.4)
    assert out["portfolio_risk_budget_pct_equity"] == pytest.approx(0.01)
    assert out["strategy_risk_cap_pct_equity"]["S1"] == pytest.approx(0.0125)
    assert out["strategy_risk_used_pct_equity"]["S1"] == pytest.approx(0.0)

    usage1 = compute_risk_usage([_owned(ti="t1")], current_equity=EQUITY)
    assert usage1["portfolio_risk_used_pct_equity"] == pytest.approx(0.004)
    rem1 = out["portfolio_risk_budget_pct_equity"] - usage1["portfolio_risk_used_pct_equity"]
    assert rem1 == pytest.approx(0.006)

    usage2 = compute_risk_usage([_owned(ti="t1"), _owned(ti="t2")], current_equity=EQUITY)
    assert usage2["portfolio_risk_used_pct_equity"] == pytest.approx(0.008)
    rem2 = out["portfolio_risk_budget_pct_equity"] - usage2["portfolio_risk_used_pct_equity"]
    assert rem2 == pytest.approx(0.002)

    auth3 = authorize_opening(
        strategy_id="S1",
        planned_trade_risk_pct_equity=0.004,
        usage=usage2,
        portfolio_risk_limit_pct_equity=out["portfolio_risk_budget_pct_equity"],
        strategy_risk_limit_pct_equity=out["strategy_risk_cap_pct_equity"]["S1"],
    )
    assert auth3.allowed_risk_pct_equity == pytest.approx(0.002)
    assert usage2["portfolio_risk_used_pct_equity"] + auth3.allowed_risk_pct_equity <= 0.01 + 1e-12
    assert usage2["portfolio_risk_used_pct_equity"] + 0.004 > 0.01


def test_16_dashboard_shows_real_0_4_over_1_0(monkeypatch, tmp_path):
    rt = _runtime(monkeypatch, tmp_path, "dash.db")
    rt.state = "RUNNING"
    rt.register_owned_position(
        {
            "symbol": "BTC-USDT-SWAP",
            "side": "long",
            "quantity": 0.04,
            "origin_strategy_id": "S1",
            "origin_trade_intent_id": "ti-dash",
            "entry_price": ENTRY,
            "stop_price": STOP,
            "entry_risk_snapshot": _snap(filled=0.04),
            "metadata": {"source": "node_gateway_filled", "execution_status": "FILLED"},
        }
    )
    rt.orchestrator.context = {
        "equity": EQUITY,
        "S3.regime": "range",
        "S3.risk_multiplier": 0.4,
        "S6.level": 0,
        "positions_reconciled": True,
        "orders_reconciled": True,
        "S5": {
            "portfolio_risk_budget_pct_equity": 0.01,
            "reserve_fraction": 0.15,
            "strategy_risk_budget_pct_equity": {"S1": 0.00255, "S2": 0.0},
            "strategy_risk_cap_pct_equity": {"S1": 0.0125, "S2": 0.0075},
            "final_shares": {"S1": 0.255, "S2": 0.0},
            "raw_shares": {"S1": 0.255, "S2": 0.0},
            "scale": 1.0,
        },
        "S7": {"S1": {"health_score": 86.0, "state": "ON"}},
    }
    snap = build_dashboard_snapshot(rt)
    view = snap["view"]
    assert view["market_risk"]["portfolio_risk_used_pct_equity"] == pytest.approx(0.004)
    assert view["market_risk"]["portfolio_risk_limit_pct_equity"] == pytest.approx(0.01)
    assert view["active_strategy"]["strategy_risk_used_pct_equity"] == pytest.approx(0.004)
    assert view["active_strategy"]["strategy_risk_limit_pct_equity"] == pytest.approx(0.0125)
    # Must not mix the two caps
    assert view["active_strategy"]["strategy_risk_limit_pct_equity"] != pytest.approx(
        view["market_risk"]["portfolio_risk_limit_pct_equity"]
    )


def test_handwritten_context_field_is_not_truth_source():
    ctx = {
        "open_portfolio_risk_pct_equity": 0.99,
        "risk_usage": {
            "portfolio_risk_used_pct_equity": 0.004,
            "strategy_risk_used_pct_equity": {"S1": 0.004, "S2": 0.0},
        },
        "S5": {
            "portfolio_risk_budget_pct_equity": 0.01,
            "strategy_risk_cap_pct_equity": {"S1": 0.0125, "S2": 0.0075},
            "strategy_risk_budget_pct_equity": {"S1": 0.0, "S2": 0.0},
            "final_shares": {"S1": 0.0, "S2": 0.0},
            "raw_shares": {},
            "scale": 1.0,
            "reserve_fraction": 0.15,
        },
    }
    s5 = serialize_s5(ctx)
    assert s5["portfolio"]["risk_used"] == pytest.approx(0.004)
    assert s5["portfolio"]["risk_used"] != pytest.approx(0.99)


def test_shadow_trade_intent_and_would_submit_do_not_increase_used(monkeypatch, tmp_path):
    """Explicit: TradeIntent / OrderIntent / WOULD_SUBMIT never write used risk."""
    from datetime import datetime, timezone

    rt = _runtime(monkeypatch, tmp_path, "shadow.db")
    before = compute_risk_usage(rt.positions.list_open(), current_equity=EQUITY)
    assert before["portfolio_risk_used_pct_equity"] == pytest.approx(0.0)

    now = datetime.now(timezone.utc)
    intent = TradeIntent(
        intent_id="ti-shadow",
        strategy_id="S1",
        symbol="BTC-USDT-SWAP",
        direction="long",
        created_at=now,
        expires_at=now,
        reference_price=ENTRY,
        reference_atr=800.0,
        status="CONFIRMED",
    )
    rt.orchestrator.lifecycle.intents[intent.intent_id] = intent
    oi = {
        "order_intent_id": "oi-shadow",
        "trade_intent_id": intent.intent_id,
        "origin_strategy_id": "S1",
        "symbol": "BTC-USDT-SWAP",
        "position_side": "long",
        "shadow": True,
        "alpha_execution": "SHADOW",
        "reduce_only": False,
        "entry_risk_snapshot": _snap(filled=0.04),
        "base_quantity": 0.04,
        "risk_pct": 0.004,
    }
    rt.order_intents = [oi]
    rt.apply_execution_report(
        {
            "order_intent_id": "oi-shadow",
            "status": "WOULD_SUBMIT",
            "shadow": True,
            "filled_quantity": "0.04",
        }
    )
    after = compute_risk_usage(rt.positions.list_open(), current_equity=EQUITY)
    assert after["portfolio_risk_used_pct_equity"] == pytest.approx(0.0)
    assert after["strategy_risk_used_pct_equity"]["S1"] == pytest.approx(0.0)
    assert rt.positions.list_open() == []


def test_submitted_no_fill_runtime_zero(monkeypatch, tmp_path):
    from datetime import datetime, timezone

    rt = _runtime(monkeypatch, tmp_path, "sub.db")
    now = datetime.now(timezone.utc)
    intent = TradeIntent(
        intent_id="ti-sub",
        strategy_id="S1",
        symbol="BTC-USDT-SWAP",
        direction="long",
        created_at=now,
        expires_at=now,
        reference_price=ENTRY,
        reference_atr=800.0,
        status="CONFIRMED",
    )
    rt.orchestrator.lifecycle.intents[intent.intent_id] = intent
    rt.order_intents = [
        {
            "order_intent_id": "oi-sub",
            "trade_intent_id": intent.intent_id,
            "origin_strategy_id": "S1",
            "symbol": "BTC-USDT-SWAP",
            "reduce_only": False,
        }
    ]
    rt.apply_execution_report({"order_intent_id": "oi-sub", "status": "SUBMITTED", "filled_quantity": 0})
    usage = compute_risk_usage(rt.positions.list_open(), current_equity=EQUITY)
    assert usage["portfolio_risk_used_pct_equity"] == pytest.approx(0.0)


def test_trailing_stop_does_not_release_initial_risk():
    row = _owned()
    usage_open = compute_risk_usage([row], current_equity=EQUITY)
    # Protective stop later moved toward profit — snapshot stop stays at entry.
    row["stop_policy_snapshot"] = {"stop_price": 100_500.0}
    row["current_stop_price"] = 100_500.0
    usage_trail = compute_risk_usage([row], current_equity=EQUITY)
    assert usage_trail["portfolio_risk_used_pct_equity"] == pytest.approx(usage_open["portfolio_risk_used_pct_equity"])
    assert usage_trail["portfolio_risk_used_pct_equity"] == pytest.approx(0.004)


def test_s5_reads_strategy_caps_not_missing_global_map():
    alloc = S5RiskBudgetAllocator(CFG)
    ctx = {
        "active_strategy_id": "S2",
        "S3.risk_multiplier": 1.0,
        "global_drawdown_multiplier": 1.0,
        "daily_loss_multiplier": 1.0,
        "risk_usage": compute_risk_usage([], current_equity=EQUITY),
    }
    out = alloc.allocate(regime="range", health_scores={"S1": 80, "S2": 90}, context=ctx)
    assert out["strategy_risk_cap_pct_equity"]["S2"] == pytest.approx(0.0075)
    assert out["strategy_risk_cap_pct_equity"]["S1"] == pytest.approx(0.0125)


def test_equity_denominator_is_current_when_provided():
    usage = compute_risk_usage([_owned()], current_equity=EQUITY)
    assert usage["equity_denominator"] == "current_authoritative_equity"
    frozen = compute_risk_usage([_owned()], current_equity=None)
    assert frozen["equity_denominator"] == "equity_at_entry_frozen"
    assert frozen["portfolio_risk_used_pct_equity"] == pytest.approx(0.004)
