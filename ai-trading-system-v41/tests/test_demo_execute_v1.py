import asyncio
from pathlib import Path

from src.runtime.demo_execute_v1 import (
    assert_stop_direction,
    clord_id_from_signal,
    compute_base_quantity,
    demo_execute_v1_allowed,
    opening_signal_already_used,
    resolve_s1_stop_price,
    signal_key,
)
from src.runtime.engine_runtime import EngineRuntime

ROOT = Path(__file__).resolve().parents[1]
CFG = ROOT / "config" / "system_config.json"


def test_base_qty_10k_equity_40bp():
    out = compute_base_quantity(
        equity=10_000,
        risk_pct=0.004,
        entry_price=100_000,
        stop_price=98_000,
    )
    assert abs(out["risk_amount_quote"] - 40.0) < 1e-9
    assert abs(out["base_quantity"] - 0.02) < 1e-12
    assert out["stop_distance"] == 2000


def test_s2_s8_s9_not_in_demo_execute_v1():
    assert demo_execute_v1_allowed("S1") is True
    assert demo_execute_v1_allowed("S2") is False
    assert demo_execute_v1_allowed("S8") is False
    assert demo_execute_v1_allowed("S9") is False


def test_stop_incomplete_without_structure():
    out = resolve_s1_stop_price(
        direction="long",
        entry_price=100_000,
        atr14=800,
        s1_cfg={"stop": {"minimum_stop_distance_bps": 10}},
        closed_candles=None,
    )
    assert out["stop_price"] is None
    assert out["reason"] == "S1_STRUCTURE_STOP_NOT_FOUND"


def test_stop_uses_existing_formula_when_structure_present():
    import pandas as pd

    idx = pd.date_range("2026-09-09T00:00:00Z", periods=20, freq="1h", tz="UTC")
    candles = pd.DataFrame(
        {"open": 100_000.0, "high": 100_200.0, "low": 99_800.0, "close": 100_000.0, "volume": 10.0},
        index=idx,
    )
    candles.iloc[15, candles.columns.get_loc("low")] = 99_000.0
    out = resolve_s1_stop_price(
        direction="long",
        entry_price=100_000,
        atr14=800,
        s1_cfg={"stop": {"minimum_stop_distance_bps": 10}},
        closed_candles=candles,
    )
    assert out is not None
    assert out["structure_invalidation_price"] == 99_000
    assert out["structure_invalidation_distance"] == 1000
    assert out["stop_distance"] == min(1.5 * 800, 1000)
    assert out["stop_price"] == 100_000 - out["stop_distance"]
    assert_stop_direction(direction="long", entry_price=100_000, stop_price=out["stop_price"])
    try:
        assert_stop_direction(direction="long", entry_price=100_000, stop_price=101_000)
        raise AssertionError("invalid long stop must fail")
    except ValueError as err:
        assert "INVALID_STOP_PRICE" in str(err)
    assert_stop_direction(direction="short", entry_price=100_000, stop_price=102_000)


def test_python_restart_same_signal_does_not_reopen():
    key = signal_key(
        strategy_id="S1",
        symbol="BTC-USDT-SWAP",
        direction="LONG",
        closed_candle_at="2026-09-10T02:00:00Z",
    )
    restored = [
        {"signal_key": key, "status": "SUBMITTED", "order_intent_id": "oi-old"},
    ]
    assert opening_signal_already_used(restored, key) is True


def test_signal_key_idempotent():
    key = signal_key(
        strategy_id="S1",
        symbol="BTC-USDT-SWAP",
        direction="LONG",
        closed_candle_at="2026-09-10T02:00:00Z",
    )
    assert key == "S1:BTC-USDT-SWAP:LONG:2026-09-10T02:00:00Z"
    cl = clord_id_from_signal(key)
    assert len(cl) <= 32
    assert cl.isalnum()
    existing = [{"signal_key": key, "status": "SUBMITTED"}]
    assert opening_signal_already_used(existing, key) is True
    assert opening_signal_already_used([{"signal_key": key, "status": "REJECTED"}], key) is False


def test_s1_order_intent_not_ready_without_structure(monkeypatch, tmp_path):
    monkeypatch.setenv("V41_ENGINE_AUTOSTART", "0")
    rt = EngineRuntime(config_path=CFG, mode="paper", store_path=tmp_path / "s1stop.db")
    from datetime import datetime, timezone
    from src.core.signal_lifecycle import TradeIntent

    now = datetime.now(timezone.utc)
    intent = TradeIntent(
        intent_id="ti-s1-stop",
        strategy_id="S1",
        symbol="BTC-USDT-SWAP",
        direction="long",
        created_at=now,
        expires_at=now,
        reference_price=100000.0,
        reference_atr=800.0,
        status="CONFIRMED",
    )
    rt.orchestrator.lifecycle.intents[intent.intent_id] = intent
    rt.orchestrator.lifecycle.validate_intent = lambda *a, **k: {"valid": True}
    rt.orchestrator.config.setdefault("router", {})["final_order_gate"] = {}
    rt.orchestrator.context.update(
        {
            "confirmed_intents": [intent],
            "active_strategy_id": "S1",
            "S5": {"strategy_risk_budget_pct_equity": {"S1": 0.004}},
            "S6.level": 0,
            "equity": 10000.0,
            "market_data": {"latest_closed_candle_at": "2026-09-10T02:00:00Z"},
        }
    )
    rt.orchestrator.active_strategy_id = "S1"
    created = rt.orchestrator.final_order_creation()
    oi = created["orders"][0]["order_intent"]
    assert oi["stop_price"] is None
    assert oi["base_quantity"] is None
    assert oi["demo_execute_v1_ready"] is False
    assert "S1_STRUCTURE_STOP_NOT_FOUND" in oi["demo_execute_v1_missing"]
    assert "quantity" not in oi


def test_kill_v1_locks_and_does_not_flatten(monkeypatch, tmp_path):
    monkeypatch.setenv("V41_ENGINE_AUTOSTART", "0")
    rt = EngineRuntime(config_path=CFG, mode="paper", store_path=tmp_path / "kill.db")
    rt.order_intents = [
        {
            "order_intent_id": "oi-open",
            "status": "SUBMITTED",
            "reduce_only": False,
            "exchange_order_id": "ord-1",
            "signal_key": "S1:BTC-USDT-SWAP:LONG:2026-09-10T02:00:00Z",
        }
    ]
    rt._request_node_cancel_order = lambda oi: True  # noqa: ARG005
    rt.register_owned_position(
        {
            "symbol": "BTC-USDT-SWAP",
            "side": "long",
            "quantity": 0.02,
            "origin_strategy_id": "S1",
            "origin_trade_intent_id": "ti-1",
        }
    )

    async def _run():
        out = await rt.kill(reason="TEST_KILL")
        assert out["state"] == "LOCKED"
        assert rt.alpha_opening_enabled is False
        assert out["kill_v1"]["flatten_account"] is False
        assert out["kill_v1"]["touch_external"] is False
        assert out["kill_v1"]["reduce_only_exit"]["reduce_only"] is True
        assert out["kill_v1"]["reduce_only_exit"]["base_quantity"] == 0.02
        await rt.shutdown()

    asyncio.run(_run())
