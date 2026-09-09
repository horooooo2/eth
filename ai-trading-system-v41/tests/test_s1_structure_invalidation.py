"""S1 STRUCTURE INVALIDATION V1 — CONFIRMED_SWING_2X2."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from src.core.signal_lifecycle import TradeIntent
from src.runtime.demo_execute_v1 import (
    find_confirmed_swing_2x2,
    resolve_s1_stop_price,
    signal_key,
)
from src.runtime.engine_runtime import EngineRuntime
from src.runtime.engine_store import EngineStore

ROOT = Path(__file__).resolve().parents[1]
CFG = ROOT / "config" / "system_config.json"

ENTRY = 100_000.0
ATR14 = 800.0
S1_STOP_CFG = {"stop": {"minimum_stop_distance_bps": 10}}
START = "2026-09-09T00:00:00Z"


def closed_1h_bars(
    n: int = 20,
    *,
    close: float = ENTRY,
    high: float = 100_200.0,
    low: float = 99_800.0,
    start: str = START,
) -> pd.DataFrame:
    idx = pd.date_range(start, periods=n, freq="1h", tz="UTC")
    return pd.DataFrame(
        {
            "open": float(close),
            "high": float(high),
            "low": float(low),
            "close": float(close),
            "volume": 10.0,
        },
        index=idx,
    )


def with_swing_low(df: pd.DataFrame, i: int, price: float) -> pd.DataFrame:
    out = df.copy()
    out.iloc[i, out.columns.get_loc("low")] = float(price)
    return out


def with_swing_high(df: pd.DataFrame, i: int, price: float) -> pd.DataFrame:
    out = df.copy()
    out.iloc[i, out.columns.get_loc("high")] = float(price)
    return out


def _resolve(direction: str, candles, *, atr14: float = ATR14, entry: float = ENTRY):
    return resolve_s1_stop_price(
        direction=direction,
        entry_price=entry,
        atr14=atr14,
        s1_cfg=S1_STOP_CFG,
        closed_candles=candles,
    )


def _make_runtime(tmp_path, monkeypatch):
    monkeypatch.setenv("V41_ENGINE_AUTOSTART", "0")
    rt = EngineRuntime(config_path=CFG, mode="paper")
    rt.store = EngineStore(tmp_path / "s1-structure.db")
    return rt


def _confirmed_intent(*, direction: str = "long", price: float = ENTRY, atr: float = ATR14):
    now = datetime.now(timezone.utc)
    return TradeIntent(
        intent_id="ti-s1-structure",
        strategy_id="S1",
        symbol="BTC-USDT-SWAP",
        direction=direction,
        created_at=now,
        expires_at=now,
        reference_price=price,
        reference_atr=atr,
        status="CONFIRMED",
    )


def test_1_long_confirmed_swing_low():
    candles = with_swing_low(closed_1h_bars(20), 15, 99_000.0)
    swing = find_confirmed_swing_2x2(direction="long", closed_candles=candles)
    assert swing is not None
    assert swing["kind"] == "swing_low"
    assert swing["price"] == 99_000.0
    assert swing["timestamp"] == "2026-09-09T15:00:00Z"
    out = _resolve("long", candles)
    assert out["reason"] is None
    assert out["structure_method"] == "CONFIRMED_SWING_2X2"
    assert out["structure_lookback_bars"] == 20
    assert out["structure_invalidation_price"] == 99_000.0
    assert out["structure_invalidation_distance"] == 1_000.0
    assert out["structure_candle_timestamp"] == "2026-09-09T15:00:00Z"
    assert out["stop_price"] == 99_000.0


def test_2_short_confirmed_swing_high():
    candles = with_swing_high(closed_1h_bars(20), 15, 101_000.0)
    swing = find_confirmed_swing_2x2(direction="short", closed_candles=candles)
    assert swing is not None
    assert swing["kind"] == "swing_high"
    assert swing["price"] == 101_000.0
    out = _resolve("short", candles)
    assert out["structure_invalidation_price"] == 101_000.0
    assert out["structure_invalidation_distance"] == 1_000.0
    assert out["stop_price"] == 101_000.0


def test_3_multiple_swings_select_most_recent():
    candles = with_swing_low(closed_1h_bars(20), 8, 98_000.0)
    candles = with_swing_low(candles, 15, 98_500.0)
    swing = find_confirmed_swing_2x2(direction="long", closed_candles=candles)
    assert swing["price"] == 98_500.0
    assert swing["timestamp"] == "2026-09-09T15:00:00Z"
    older = closed_1h_bars(25)
    older = with_swing_low(older, 3, 97_000.0)
    older = with_swing_low(older, 20, 98_200.0)
    swing2 = find_confirmed_swing_2x2(direction="long", closed_candles=older)
    assert swing2["price"] == 98_200.0
    assert swing2["timestamp"] == "2026-09-09T20:00:00Z"


def test_4_forming_candle_does_not_confirm():
    closed = with_swing_low(closed_1h_bars(20), 18, 98_000.0)
    assert find_confirmed_swing_2x2(direction="long", closed_candles=closed) is None
    forming_idx = pd.date_range("2026-09-09T20:00:00Z", periods=1, freq="1h", tz="UTC")
    forming = pd.DataFrame(
        {"open": ENTRY, "high": 100_200.0, "low": 99_800.0, "close": ENTRY, "volume": 10.0},
        index=forming_idx,
    )
    leaked = pd.concat([closed, forming])
    leaked_swing = find_confirmed_swing_2x2(direction="long", closed_candles=leaked)
    assert leaked_swing is not None
    assert leaked_swing["price"] == 98_000.0
    out = resolve_s1_stop_price(
        direction="long",
        entry_price=ENTRY,
        atr14=ATR14,
        s1_cfg=S1_STOP_CFG,
        closed_candles=closed,
        forming_candle=forming.iloc[0],
    )
    assert out["stop_price"] is None
    assert out["reason"] == "S1_STRUCTURE_STOP_NOT_FOUND"


def test_5_no_swing_fail_closed():
    candles = closed_1h_bars(20)
    out = _resolve("long", candles)
    assert out["stop_price"] is None
    assert out["reason"] == "S1_STRUCTURE_STOP_NOT_FOUND"
    assert out["structure_invalidation_price"] is None
    assert out.get("atr_only_fallback") is None


def test_6_structure_distance_wins_vs_atr_cap():
    candles = with_swing_low(closed_1h_bars(20), 15, 99_500.0)
    out = _resolve("long", candles)
    assert out["structure_invalidation_distance"] == 500.0
    assert out["atr_stop_distance"] == 1.5 * ATR14
    assert 500.0 < out["atr_stop_distance"]
    assert out["raw_stop_distance"] == 500.0
    assert out["final_stop_distance"] == 500.0
    assert out["stop_price"] == 99_500.0


def test_7_atr_cap_wins_when_structure_is_wider():
    candles = with_swing_low(closed_1h_bars(20), 15, 97_000.0)
    out = _resolve("long", candles)
    assert out["structure_invalidation_distance"] == 3_000.0
    assert out["atr_stop_distance"] == 1_200.0
    assert out["raw_stop_distance"] == 1_200.0
    assert out["final_stop_distance"] == 1_200.0
    assert out["stop_price"] == 98_800.0


def test_8_minimum_10bps_floor():
    candles = closed_1h_bars(20, low=99_980.0)
    candles = with_swing_low(candles, 15, 99_950.0)
    out = _resolve("long", candles)
    assert out["structure_invalidation_distance"] == 50.0
    assert out["minimum_stop_distance"] == 100.0
    assert out["raw_stop_distance"] == 50.0
    assert out["final_stop_distance"] == 100.0
    assert out["stop_price"] == 99_900.0


def test_9_long_stop_below_entry():
    candles = with_swing_low(closed_1h_bars(20), 15, 99_000.0)
    out = _resolve("long", candles)
    assert out["stop_price"] < ENTRY
    wrong_side = with_swing_low(closed_1h_bars(20, low=100_800.0), 15, 100_500.0)
    bad = _resolve("long", wrong_side)
    assert bad["stop_price"] is None
    assert bad["reason"] == "INVALID_STOP_PRICE"
    assert bad["structure_invalidation_price"] == 100_500.0


def test_10_short_stop_above_entry():
    candles = with_swing_high(closed_1h_bars(20), 15, 101_000.0)
    out = _resolve("short", candles)
    assert out["stop_price"] > ENTRY
    wrong_side = with_swing_high(closed_1h_bars(20, high=99_400.0), 15, 99_600.0)
    bad = _resolve("short", wrong_side)
    assert bad["stop_price"] is None
    assert bad["reason"] == "INVALID_STOP_PRICE"
    assert bad["structure_invalidation_price"] == 99_600.0


def test_11_base_quantity_risk_math(monkeypatch, tmp_path):
    candles = with_swing_low(closed_1h_bars(20), 15, 99_000.0)
    out = _resolve("long", candles)
    assert out["final_stop_distance"] == 1_000.0
    rt = _make_runtime(tmp_path, monkeypatch)
    intent = _confirmed_intent()
    rt.orchestrator.lifecycle.intents[intent.intent_id] = intent
    rt.orchestrator.lifecycle.validate_intent = lambda *a, **k: {"valid": True}
    rt.orchestrator.config.setdefault("router", {})["final_order_gate"] = {}
    rt.orchestrator.data_pool.set_closed_bars(candles)
    rt.orchestrator.context.update(
        {
            "confirmed_intents": [intent],
            "active_strategy_id": "S1",
            "S5": {"strategy_risk_budget_pct_equity": {"S1": 0.004}},
            "S6.level": 0,
            "equity": 10_000.0,
            "market_data": {"latest_closed_candle_at": "2026-09-09T19:00:00Z"},
        }
    )
    rt.orchestrator.active_strategy_id = "S1"
    created = rt.orchestrator.final_order_creation()
    oi = created["orders"][0]["order_intent"]
    assert oi["quantity_unit"] == "BASE"
    assert oi["risk_amount_quote"] == 40.0
    assert oi["risk_pct"] == 0.004
    assert abs(oi["base_quantity"] - 0.04) < 1e-12
    assert oi["entry_price"] == ENTRY
    assert oi["stop_price"] == 99_000.0
    assert oi["structure_invalidation_price"] == 99_000.0
    assert oi["structure_candle_timestamp"] == "2026-09-09T15:00:00Z"
    assert oi["atr14"] == ATR14
    assert oi["risk_snapshot"]["base_quantity"] == oi["base_quantity"]
    assert oi["exit_policy_snapshot"]["origin_strategy_id"] == "S1"
    assert oi["demo_execute_v1_ready"] is True
    snap = rt.orchestrator.diagnostics["S1"].to_dict(
        active=True,
        runtime_state="RUNNING",
        alpha_opening_enabled=True,
        last_tick_at=None,
    )
    assert snap["structure_method"] == "CONFIRMED_SWING_2X2"
    assert snap["structure_lookback_bars"] == 20
    assert snap["structure_invalidation_price"] == 99_000.0
    assert snap["structure_candle_timestamp"] == "2026-09-09T15:00:00Z"
    assert snap["stop_price"] == 99_000.0
    assert snap["atr_stop_distance"] == 1_200.0
    assert snap["final_stop_distance"] == 1_000.0


def test_12_restart_same_closed_candle_same_structure_and_signal_key(monkeypatch, tmp_path):
    candles = with_swing_low(closed_1h_bars(20), 15, 99_000.0)
    first = _resolve("long", candles)
    second = _resolve("long", candles)
    assert first["structure_invalidation_price"] == second["structure_invalidation_price"]
    assert first["stop_price"] == second["stop_price"]
    assert first["structure_candle_timestamp"] == second["structure_candle_timestamp"]
    closed_at = str(candles.index[-1])
    key1 = signal_key(
        strategy_id="S1",
        symbol="BTC-USDT-SWAP",
        direction="LONG",
        closed_candle_at=closed_at,
    )
    key2 = signal_key(
        strategy_id="S1",
        symbol="BTC-USDT-SWAP",
        direction="LONG",
        closed_candle_at=closed_at,
    )
    assert key1 == key2

    def _run_once(name: str):
        rt = _make_runtime(tmp_path / name, monkeypatch)
        intent = _confirmed_intent()
        intent.intent_id = f"ti-{name}"
        rt.orchestrator.lifecycle.intents[intent.intent_id] = intent
        rt.orchestrator.lifecycle.validate_intent = lambda *a, **k: {"valid": True}
        rt.orchestrator.config.setdefault("router", {})["final_order_gate"] = {}
        rt.orchestrator.data_pool.set_closed_bars(candles)
        latest = "2026-09-09T19:00:00Z"
        rt.orchestrator.context.update(
            {
                "confirmed_intents": [intent],
                "active_strategy_id": "S1",
                "S5": {"strategy_risk_budget_pct_equity": {"S1": 0.004}},
                "S6.level": 0,
                "equity": 10_000.0,
                "market_data": {"latest_closed_candle_at": latest},
            }
        )
        rt.orchestrator.active_strategy_id = "S1"
        created = rt.orchestrator.final_order_creation()
        return created["orders"][0]["order_intent"]

    a = _run_once("restart-a")
    b = _run_once("restart-b")
    assert a["structure_invalidation_price"] == b["structure_invalidation_price"] == 99_000.0
    assert a["stop_price"] == b["stop_price"] == 99_000.0
    assert a["structure_candle_timestamp"] == b["structure_candle_timestamp"]
    assert a["signal_key"] == b["signal_key"]
    assert a["signal_key"] == "S1:BTC-USDT-SWAP:LONG:2026-09-09T19:00:00Z"
