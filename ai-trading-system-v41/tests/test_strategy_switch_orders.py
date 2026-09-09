"""Phase B: opening OrderIntent cancel on strategy switch; preserve reduce-only."""

from __future__ import annotations

from pathlib import Path

from src.runtime.engine_runtime import EngineRuntime
from src.telemetry.dashboard_snapshot import build_dashboard_snapshot

ROOT = Path(__file__).resolve().parents[1]


def _runtime(monkeypatch) -> EngineRuntime:
    monkeypatch.setenv("V41_ENGINE_AUTOSTART", "0")
    rt = EngineRuntime(config_path=ROOT / "config" / "system_config.json", mode="paper")
    rt.active_strategy = "S1"
    rt.orchestrator.active_strategy_id = "S1"
    rt.execution_mode = "paper"
    return rt


def test_strategy_switch_cancels_opening_orders(monkeypatch):
    rt = _runtime(monkeypatch)
    opening = {
        "order_intent_id": "oi-open-1",
        "trade_intent_id": "ti-1",
        "strategy_id": "S1",
        "symbol": "BTC-USDT-SWAP",
        "reduce_only": False,
        "status": "PENDING_GATEWAY",
        "client_order_id": "cl-1",
    }
    rt.order_intents = [opening]
    rt.orchestrator.context = {"pending_order_intents": [dict(opening)], "trade_intents": []}

    result = rt.switch_strategy(strategy_id="S2", operator_id="tester")
    assert result["ok"] is True
    assert "oi-open-1" in result["cancelled_order_intent_ids"]
    assert opening["status"] == "STRATEGY_SWITCH_CANCELLED"
    pending = rt.orchestrator.context.get("pending_order_intents") or []
    assert all(str(x.get("order_intent_id")) != "oi-open-1" for x in pending if isinstance(x, dict))


def test_strategy_switch_preserves_reduce_only(monkeypatch):
    rt = _runtime(monkeypatch)
    protective = {
        "order_intent_id": "oi-ro-1",
        "trade_intent_id": "ti-2",
        "strategy_id": "S1",
        "symbol": "BTC-USDT-SWAP",
        "reduce_only": True,
        "status": "SUBMITTED",
        "exchange_order_id": "ex-99",
        "client_order_id": "cl-ro",
    }
    rt.order_intents = [protective]
    result = rt.switch_strategy(strategy_id="S2", operator_id="tester")
    assert result["ok"] is True
    assert "oi-ro-1" not in result["cancelled_order_intent_ids"]
    assert protective["status"] == "SUBMITTED"


def test_personal_view_uses_active_strategy_only(monkeypatch):
    rt = _runtime(monkeypatch)
    rt.state = "RUNNING"
    # Ensure context has enough for snapshot builders
    rt.orchestrator.context = {
        "S3.regime": "range",
        "S3.direction_bias": 0.2,
        "S6.level": 0,
        "open_portfolio_risk_pct_equity": 0.01,
        "positions_reconciled": True,
        "orders_reconciled": True,
        "S5": {
            "portfolio_risk_budget_pct_equity": 0.025,
            "reserve_fraction": 0.15,
            "strategy_risk_budget_pct_equity": {"S1": 0.012, "S2": 0.008},
            "final_shares": {"S1": 0.5, "S2": 0.35},
            "raw_shares": {"S1": 0.5, "S2": 0.35},
            "scale": 1.0,
        },
        "S7": {
            "S1": {"health_score": 86.0, "state": "ON"},
            "S2": {"health_score": 71.0, "state": "REDUCED"},
        },
    }
    snap = build_dashboard_snapshot(rt)
    view = snap["view"]
    assert view["active_strategy"]["id"] == "S1"
    assert view["market_risk"]["regime"] == "range"
    assert view["market_risk"]["portfolio_risk_used_pct_equity"] == 0.01
    assert "signals" in view
