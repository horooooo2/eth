"""Execution-architecture migration: SHADOW / Live gates / no paper fake fill."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from src.core.signal_lifecycle import TradeIntent
from src.runtime.alpha_execution import (
    ALPHA_EXECUTE,
    ALPHA_SHADOW,
    DEPRECATED_PAPER,
    LEGACY_PAPER_MARK,
    is_legacy_paper_position,
    live_trading_enabled,
    normalize_alpha_execution,
    strategy_live_allowed,
)
from src.runtime.engine_runtime import EngineRuntime
from src.runtime.engine_store import EngineStore
from src.runtime.position_ownership import PositionOwnershipRegistry

ROOT = Path(__file__).resolve().parents[1]
CFG = ROOT / "config" / "system_config.json"


def _runtime(monkeypatch, tmp_path, **kwargs) -> EngineRuntime:
    monkeypatch.setenv("V41_ENGINE_AUTOSTART", "0")
    monkeypatch.delenv("V41_ALPHA_EXECUTION", raising=False)
    monkeypatch.delenv("V41_ENGINE_EXECUTION_MODE", raising=False)
    monkeypatch.setenv("V41_LIVE_TRADING_ENABLED", "false")
    rt = EngineRuntime(config_path=CFG, mode="paper", **kwargs)
    rt.store = EngineStore(tmp_path / "mig.db")
    rt.positions = PositionOwnershipRegistry()
    return rt


def _intent(strategy_id: str = "S1", intent_id: str = "ti-1") -> TradeIntent:
    now = datetime.now(timezone.utc)
    return TradeIntent(
        intent_id=intent_id,
        strategy_id=strategy_id,
        symbol="BTC-USDT-SWAP",
        direction="long",
        created_at=now,
        expires_at=now,
        reference_price=100000.0,
        reference_atr=200.0,
        status="CONFIRMED",
    )


def test_legacy_paper_normalizes_to_shadow(monkeypatch):
    monkeypatch.delenv("V41_ALPHA_EXECUTION", raising=False)
    out = normalize_alpha_execution(raw_legacy="paper", warn=False)
    assert out["alpha_execution"] == ALPHA_SHADOW
    assert out["gateway_mode"] == "node_gateway_shadow"
    assert out["deprecated"] is True
    assert out["deprecation_code"] == DEPRECATED_PAPER
    assert out["replacement"] == ALPHA_SHADOW


def test_unset_normalizes_to_shadow(monkeypatch):
    monkeypatch.delenv("V41_ALPHA_EXECUTION", raising=False)
    monkeypatch.delenv("V41_ENGINE_EXECUTION_MODE", raising=False)
    out = normalize_alpha_execution(warn=False)
    assert out["alpha_execution"] == ALPHA_SHADOW


def test_legacy_gateway_aliases(monkeypatch):
    monkeypatch.delenv("V41_ALPHA_EXECUTION", raising=False)
    assert normalize_alpha_execution(raw_legacy="node_gateway_shadow")["alpha_execution"] == ALPHA_SHADOW
    assert normalize_alpha_execution(raw_legacy="node_gateway")["alpha_execution"] == ALPHA_EXECUTE


def test_alpha_execution_env_wins(monkeypatch):
    monkeypatch.setenv("V41_ALPHA_EXECUTION", "SHADOW")
    monkeypatch.setenv("V41_ENGINE_EXECUTION_MODE", "node_gateway")
    out = normalize_alpha_execution()
    assert out["alpha_execution"] == ALPHA_SHADOW


def test_runtime_default_is_shadow(monkeypatch, tmp_path):
    rt = _runtime(monkeypatch, tmp_path)
    assert rt.alpha_execution == ALPHA_SHADOW
    assert rt.execution_mode == "node_gateway_shadow"
    assert live_trading_enabled() is False


def test_s1_s2_do_not_emit_paper_adapter_candidates(monkeypatch, tmp_path):
    rt = _runtime(monkeypatch, tmp_path)
    rt.orchestrator.execution_mode = "paper"
    rt.orchestrator.alpha_execution = None
    rt.orchestrator.context = {
        "confirmed_intents": [_intent("S1", "ti-s1"), _intent("S2", "ti-s2")],
        "active_strategy_id": "S1",
        "S5": {"strategy_risk_budget_pct_equity": {"S1": 0.01, "S2": 0.01}},
        "S6.level": 0,
        "equity": 100000.0,
        "data_quality_ok": True,
        "positions_reconciled": True,
        "orders_reconciled": True,
        "expected_edge_after_cost_R": 0.4,
        "edge_estimate_available": True,
    }
    rt.orchestrator.active_strategy_id = "S1"
    rt.orchestrator.lifecycle.intents["ti-s1"] = rt.orchestrator.context["confirmed_intents"][0]
    rt.orchestrator.lifecycle.validate_intent = lambda *a, **k: {"valid": True}
    rt.orchestrator.config.setdefault("router", {})["final_order_gate"] = {}
    created = rt.orchestrator.final_order_creation()
    assert not rt.orchestrator.context.get("opened_position_candidates")
    orders = created["orders"]
    assert orders
    assert "order_intent" in orders[0]
    assert orders[0]["order_intent"]["shadow"] is True
    assert orders[0]["order_intent"]["alpha_execution"] == ALPHA_SHADOW
    assert "paper_adapter" not in str(orders)


def test_would_submit_does_not_open_position(monkeypatch, tmp_path):
    rt = _runtime(monkeypatch, tmp_path, execution_mode="SHADOW")
    intent = _intent()
    rt.orchestrator.lifecycle.intents[intent.intent_id] = intent
    oi = {
        "order_intent_id": "oi-shadow-1",
        "trade_intent_id": intent.intent_id,
        "origin_strategy_id": "S1",
        "symbol": "BTC-USDT-SWAP",
        "position_side": "long",
        "quantity": "0.01",
        "reduce_only": False,
    }
    rt.order_intents = [oi]
    before = len(rt.positions.list_open())
    s7_before = len(rt.orchestrator.s7.trade_history.get("S1") or [])
    rt.apply_execution_report(
        {
            "order_intent_id": "oi-shadow-1",
            "status": "WOULD_SUBMIT",
            "shadow": True,
            "filled_quantity": "0.01",
        }
    )
    assert len(rt.positions.list_open()) == before
    assert oi["status"] == "WOULD_SUBMIT"
    assert len(rt.orchestrator.s7.trade_history.get("S1") or []) == s7_before


def test_partial_fill_owns_filled_qty_not_request(monkeypatch, tmp_path):
    rt = _runtime(monkeypatch, tmp_path, execution_mode="EXECUTE")
    intent = _intent()
    rt.orchestrator.lifecycle.intents[intent.intent_id] = intent
    oi = {
        "order_intent_id": "oi-partial-1",
        "trade_intent_id": intent.intent_id,
        "origin_strategy_id": "S1",
        "symbol": "BTC-USDT-SWAP",
        "position_side": "long",
        "quantity": "100",
        "reduce_only": False,
    }
    rt.order_intents = [oi]
    s7_before = len(rt.orchestrator.s7.trade_history.get("S1") or [])
    rt.apply_execution_report(
        {
            "order_intent_id": "oi-partial-1",
            "status": "PARTIAL",
            "filled_quantity": "40",
        }
    )
    opened = rt.positions.list_open()
    assert len(opened) == 1
    assert opened[0].quantity == 40.0
    assert opened[0].origin_trade_intent_id == intent.intent_id
    assert oi["status"] == "PARTIAL"
    assert len(rt.orchestrator.s7.trade_history.get("S1") or []) == s7_before
    rt.apply_execution_report(
        {
            "order_intent_id": "oi-partial-1",
            "status": "FILLED",
            "filled_quantity": "100",
            "realized_R": 0.1,
        }
    )
    still = rt.positions.list_open()
    assert len(still) == 1
    assert still[0].quantity == 100.0


def test_filled_creates_position_ownership(monkeypatch, tmp_path):
    rt = _runtime(monkeypatch, tmp_path, execution_mode="EXECUTE")
    intent = _intent()
    rt.orchestrator.lifecycle.intents[intent.intent_id] = intent
    oi = {
        "order_intent_id": "oi-fill-1",
        "trade_intent_id": intent.intent_id,
        "origin_strategy_id": "S1",
        "symbol": "BTC-USDT-SWAP",
        "position_side": "long",
        "quantity": "0.02",
        "reduce_only": False,
        "entry_risk_snapshot": {"risk_pct": 0.01},
        "exit_policy_snapshot": {"origin_strategy_id": "S1"},
    }
    rt.order_intents = [oi]
    rt.apply_execution_report(
        {
            "order_intent_id": "oi-fill-1",
            "status": "FILLED",
            "filled_quantity": "0.02",
            "realized_R": 0.2,
        }
    )
    opened = rt.positions.list_open()
    assert len(opened) == 1
    assert opened[0].origin_strategy_id == "S1"
    assert opened[0].origin_trade_intent_id == intent.intent_id
    assert opened[0].metadata.get("source") == "node_gateway_filled"


def test_legacy_paper_position_not_okx(monkeypatch, tmp_path):
    rt = _runtime(monkeypatch, tmp_path)
    payload = {
        "position_id": "legacy-1",
        "symbol": "BTC-USDT-SWAP",
        "side": "long",
        "quantity": 0.01,
        "origin_strategy_id": "S1",
        "origin_trade_intent_id": "ti-old",
        "status": "OPEN",
        "metadata": {"source": "paper_adapter"},
    }
    rt.store.upsert_open_position(payload, datetime.now(timezone.utc).isoformat())
    rt.positions.load(rt.store.list_open_positions())
    rt._annotate_loaded_positions()
    rows = rt._serialize_open_positions()
    assert rows
    assert is_legacy_paper_position(rows[0])
    assert rows[0]["legacy_mark"] == LEGACY_PAPER_MARK
    assert rows[0]["metadata"]["exclude_from_okx_reconciliation"] is True
    assert rt.list_exchange_open_positions() == []


def test_register_rejects_paper_and_would_submit(monkeypatch, tmp_path):
    rt = _runtime(monkeypatch, tmp_path)
    try:
        rt.register_owned_position(
            {
                "symbol": "BTC-USDT-SWAP",
                "side": "long",
                "quantity": 0.01,
                "origin_strategy_id": "S1",
                "origin_trade_intent_id": "ti-x",
                "metadata": {"source": "paper_adapter"},
            }
        )
        raise AssertionError("paper_adapter should be rejected")
    except ValueError as err:
        assert "LEGACY_PAPER_POSITION" in str(err)
    try:
        rt.register_owned_position(
            {
                "symbol": "BTC-USDT-SWAP",
                "side": "long",
                "quantity": 0.01,
                "origin_strategy_id": "S1",
                "origin_trade_intent_id": "ti-y",
                "metadata": {"execution_status": "WOULD_SUBMIT"},
            }
        )
        raise AssertionError("WOULD_SUBMIT should be rejected")
    except ValueError as err:
        assert "WOULD_SUBMIT" in str(err)


def test_s8_live_not_allowed():
    assert strategy_live_allowed("S1") is True
    assert strategy_live_allowed("S2") is True
    assert strategy_live_allowed("S8") is False
    assert strategy_live_allowed("S8", explicit=True) is False


def test_s8_selection_is_research(monkeypatch, tmp_path):
    rt = _runtime(monkeypatch, tmp_path)
    items = {i["id"]: i for i in rt.list_execution_selections()["items"]}
    assert items["S8"]["available"] is False
    assert items["S8"]["release_stage"] == "RESEARCH"
    assert items["S8"]["live_allowed"] is False
    assert items["S8"].get("paper_only") in (None, False)
    assert items["QA-HFT-SIM"]["name"] == "QA 开平仓测试"


def test_snapshot_architecture_fields(monkeypatch, tmp_path):
    rt = _runtime(monkeypatch, tmp_path, execution_mode="SHADOW")
    rt.state = "RUNNING"
    snap = rt.snapshot()
    assert snap["alpha_execution"] == ALPHA_SHADOW
    assert snap["live_permission"] is False
    assert snap["strategy"]["live_allowed"] is True
    assert "user_id_ready" in snap
    assert snap["execution"]["alpha_execution"] == ALPHA_SHADOW
    assert snap["view"]["engine"].get("mode") in (None, "")
    assert snap["view"]["engine"]["alpha_execution"] == ALPHA_SHADOW


def test_bind_user_stamps_order_intent(monkeypatch, tmp_path):
    rt = _runtime(monkeypatch, tmp_path)
    assert rt.bind_user("user_session_abc")["user_id_ready"] is True
    rt.orchestrator.user_id = "user_session_abc"
    rt.orchestrator.context["user_id"] = "user_session_abc"
    intent = _intent("S1", "ti-uid-1")
    rt.orchestrator.lifecycle.intents[intent.intent_id] = intent
    rt.orchestrator.execution_mode = "node_gateway_shadow"
    rt.orchestrator.alpha_execution = ALPHA_SHADOW
    rt.orchestrator.context.update(
        {
            "confirmed_intents": [intent],
            "active_strategy_id": "S1",
            "S5": {"strategy_risk_budget_pct_equity": {"S1": 0.01}},
            "S6.level": 0,
            "equity": 100000.0,
            "data_quality_ok": True,
            "positions_reconciled": True,
            "orders_reconciled": True,
            "expected_edge_after_cost_R": 0.4,
            "edge_estimate_available": True,
            "user_id": "user_session_abc",
        }
    )
    rt.orchestrator.active_strategy_id = "S1"
    rt.orchestrator.lifecycle.validate_intent = lambda *a, **k: {"valid": True}
    rt.orchestrator.config.setdefault("router", {})["final_order_gate"] = {}
    created = rt.orchestrator.final_order_creation()
    oi = created["orders"][0]["order_intent"]
    assert oi["user_id"] == "user_session_abc"


def test_fixture_order_intents_hidden_from_current_snapshot(monkeypatch, tmp_path):
    rt = _runtime(monkeypatch, tmp_path)
    rt.state = "RUNNING"
    rt.order_intents = [
        {
            "order_intent_id": "oi-open-1",
            "client_order_id": "cl-1",
            "status": "STRATEGY_SWITCH_CANCELLED",
        },
        {
            "order_intent_id": "oi-real-now",
            "client_order_id": "cl-real",
            "status": "WOULD_SUBMIT",
        },
    ]
    snap = rt.snapshot()
    ids = {str(i.get("order_intent_id")) for i in snap["order_intents"]}
    assert "oi-open-1" not in ids
    assert "oi-real-now" in ids
    view_ids = {str(i.get("order_intent_id")) for i in snap["view"]["recent_order_intents"]}
    assert "oi-open-1" not in view_ids


def test_qa_simulator_still_importable():
    from src.qa.exchange_simulator import ExchangeSimulator
    from src.qa.hft_sim_runner import HftSimRunner

    sim = ExchangeSimulator(mark_price=100_000)
    assert sim is not None
    runner = HftSimRunner()
    assert runner.execution_mode in ("simulator", "exchange")
