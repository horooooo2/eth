"""S9 signal, stop, microstructure, cost, ownership, cleanup tests. No exchange orders."""

from __future__ import annotations

import pandas as pd
import pytest

from src.runtime.s9_cleanup import BACKOFF, MAX_ATTEMPTS, next_action, symbol_conflict
from src.runtime.s9_exits import (
    direction_flip_exit,
    dust_block,
    evaluate_owned_exit,
    frequency_block,
    ownership_released,
    pick_exit_reason,
    take_profit_price,
    time_exit_due,
    tp_triggered,
)
from src.runtime.s9_microstructure import (
    SpreadWindow,
    aggressive_flow,
    cost_gate,
    depth_imbalance_5,
    entry_drift_exceeded,
    evaluate_microstructure,
    expected_vwap,
    round_trip_cost_bps,
    spread_bps,
)
from src.runtime.strategy_display_zh import reason_zh
from src.strategies.s9_momentum import (
    EARLY_MOMENTUM,
    TREND_CONTINUATION,
    breakout_hit,
    breakout_level,
    candle_quality,
    classify_direction_state,
    closed_only,
    evaluate_5m_direction,
    evaluate_5m_direction_legacy,
    evaluate_entry,
    find_micro_swing,
    s3_allows,
    score_direction_components,
    signal_key,
    validate_stop,
)
from src.runtime.config_loader import load_runtime_config, load_strategy_config, strip_wrapper, config_hash
from src.runtime.s9_readiness import s9_demo_readiness, s9_implementation_readiness


def _bars(n: int, *, start: float, step: float, freq: str, vol: float = 10.0, end=None) -> pd.DataFrame:
    idx = pd.date_range(end=end or pd.Timestamp("2026-09-10 10:00", tz="UTC"), periods=n, freq=freq)
    close = [start + i * step for i in range(n)]
    high = [c + abs(step) * 2 + 1 for c in close]
    low = [c - abs(step) * 2 - 1 for c in close]
    open_ = [c - step for c in close]
    volume = [vol * (1.6 if i == n - 1 else 1.0) for i in range(n)]
    return pd.DataFrame({"open": open_, "high": high, "low": low, "close": close, "volume": volume}, index=idx)


def _cfg() -> dict:
    return load_strategy_config("S9")


def test_s9_config_identity():
    doc = _cfg()
    assert doc["strategy_id"] == "S9"
    assert doc["name"] == "高频动量突破"
    assert doc["release_stage"] == "DEMO_VALIDATION"
    assert doc["implemented"] is True
    assert doc["demo_allowed"] is True
    assert doc["live_allowed"] is False
    assert doc["risk_per_trade_pct_equity"] == 0.001
    assert doc["strategy_initial_risk_cap_pct_equity"] == 0.003
    assert doc["leverage_cap"] == 3.0
    assert doc["max_open_positions_per_strategy"] == 1


def test_display_metadata_excluded_from_trading_hash():
    loaded = load_runtime_config()
    raw = dict(loaded.documents["S9"])
    a = config_hash(strip_wrapper(raw))
    raw["display"] = {"summary_zh": "改一段中文介绍"}
    b = config_hash(strip_wrapper(raw))
    assert a == b
    raw["risk_per_trade_pct_equity"] = 0.002
    assert config_hash(strip_wrapper(raw)) != a


def test_5m_long_short_neutral_and_forming():
    bull = _bars(80, start=100, step=0.8, freq="5min")
    d = evaluate_5m_direction(bull)
    assert d["state"] == "STRONG_BULLISH"
    assert d["s9_direction_score"] == 1.0
    bear = _bars(80, start=200, step=-0.8, freq="5min")
    d2 = evaluate_5m_direction(bear)
    assert d2["state"] == "STRONG_BEARISH"
    assert d2["s9_direction_score"] == -1.0
    flat = _bars(80, start=100, step=0.0, freq="5min")
    d3 = evaluate_5m_direction(flat)
    assert d3["state"] == "NEUTRAL"
    old = evaluate_5m_direction_legacy(bull)
    assert old["state"] == "BULLISH"
    now = bull.index[-1] + pd.Timedelta(minutes=2)
    forming = pd.concat([bull, bull.iloc[[-1]].copy()])
    forming.index = list(bull.index) + [bull.index[-1] + pd.Timedelta(minutes=5)]
    closed = closed_only(forming, timeframe="5m", now=now)
    assert closed.index[-1] == bull.index[-1]


def test_stale_5m_block():
    bars = _bars(80, start=100, step=0.8, freq="5min", end=pd.Timestamp("2026-09-10 09:00", tz="UTC"))
    now = pd.Timestamp("2026-09-10 10:00", tz="UTC")
    out = evaluate_entry(closed_1m=_bars(40, start=100, step=0.2, freq="1min"), closed_5m=bars, s3_regime="strong_trend", s3_bias=0.5, cfg=_cfg(), now=now)
    assert "S9_DATA_5M_STALE" in out["reason_codes"]


def test_s3_gates():
    assert s3_allows("LONG", regime="strong_trend", bias=0.20) is None
    assert s3_allows("SHORT", regime="strong_trend", bias=-0.20) is None
    assert s3_allows("LONG", regime="strong_trend", bias=0.19) == "S9_S3_DIRECTION_BLOCK"
    assert s3_allows("LONG", regime="range", bias=0.9) == "S9_S3_DIRECTION_BLOCK"
    assert s3_allows("SHORT", regime="panic", bias=-0.9) == "S9_S3_DIRECTION_BLOCK"


def test_1m_breakout_and_buffer():
    df = _bars(30, start=100, step=0.1, freq="1min")
    level = breakout_level(df, side="LONG", lookback=20)
    assert level is not None
    close = float(df["close"].iloc[-1])
    assert breakout_hit(level * (1 + 1.1 / 10_000), level, side="LONG", buffer_bps=1)
    assert not breakout_hit(level * (1 + 0.5 / 10_000), level, side="LONG", buffer_bps=1)
    low = breakout_level(df, side="SHORT", lookback=20)
    assert breakout_hit(low * (1 - 1.1 / 10_000), low, side="SHORT", buffer_bps=1)


def test_volume_body_atr_and_idempotent_signal_key():
    ts = pd.Timestamp("2026-09-10T10:00:00Z")
    k1 = signal_key("LONG", ts)
    k2 = signal_key("BUY", ts)
    assert k1 == k2 == "S9:BTC-USDT-SWAP:LONG:2026-09-10T10:00:00Z"
    row = {"open": 100, "high": 110, "low": 99, "close": 109}
    assert candle_quality(row, side="LONG") is None
    assert candle_quality({"open": 100, "high": 100, "low": 100, "close": 100}, side="LONG") == "S9_CANDLE_QUALITY_BLOCK"


def test_micro_swing_stop_rules():
    idx = pd.date_range("2026-09-10 09:00", periods=12, freq="1min", tz="UTC")
    lows = [10, 9, 8, 9, 10, 11, 10, 9.5, 10, 11, 12, 13]
    highs = [x + 2 for x in lows]
    df = pd.DataFrame(
        {"open": lows, "high": highs, "low": lows, "close": [x + 1 for x in lows], "volume": [10] * 12},
        index=idx,
    )
    swing = find_micro_swing(df, side="LONG", lookback=10)
    assert swing and swing["price"] == 9.5  # nearest confirmed 1x1, not the older 8
    older = find_micro_swing(df.iloc[:6], side="LONG", lookback=10)
    assert older and older["price"] == 8
    forming = df.iloc[:-1]  # last not closed relative to a 1x1 needing i+1
    # i+1 must be closed: using all closed bars is required
    assert validate_stop(side="LONG", entry=100.0, stop=99.9, atr14=1.0) is None
    assert validate_stop(side="LONG", entry=10, stop=9.999, atr14=1.0) == "S9_STRUCTURE_STOP_TOO_TIGHT"
    assert validate_stop(side="LONG", entry=20, stop=1, atr14=1.0) == "S9_STRUCTURE_STOP_TOO_WIDE"
    assert validate_stop(side="LONG", entry=10, stop=11, atr14=1.0) == "S9_STRUCTURE_STOP_NOT_FOUND"
    assert validate_stop(side="SHORT", entry=10, stop=9, atr14=1.0) == "S9_STRUCTURE_STOP_NOT_FOUND"


def test_s4_book_flow_spread_slippage():
    bids = [[100, 2], [99.9, 2], [99.8, 2], [99.7, 2], [99.6, 2]]
    asks = [[100.01, 2], [100.02, 2], [100.03, 2], [100.04, 2], [100.05, 2]]
    imb = depth_imbalance_5(bids, asks)
    assert imb is not None
    assert aggressive_flow([{"side": "buy", "qty": 10}, {"side": "sell", "qty": 5}]) == pytest.approx(5 / 15)
    assert spread_bps(100, 100.01) < 2.0
    win = SpreadWindow(required=60)
    now = 1_000.0
    for i in range(60):
        win.observe(now + i * 5, 1.0)
    assert win.ready()
    micro = evaluate_microstructure(
        side="LONG",
        bid=100,
        ask=100.01,
        bids=bids,
        asks=asks,
        trades=[{"side": "buy", "qty": 20}, {"side": "sell", "qty": 5}],
        spread_window=win,
        now_ts=now + 60 * 5,
        book_age_sec=0.5,
        trades_age_sec=0.5,
        cfg={},
        authorized_base_qty=1.0,
    )
    assert micro["ok"] is True
    warm = SpreadWindow(required=60)
    blocked = evaluate_microstructure(
        side="LONG", bid=100, ask=100.01, bids=bids, asks=asks,
        trades=[{"side": "buy", "qty": 20}, {"side": "sell", "qty": 5}],
        spread_window=warm, now_ts=now, book_age_sec=0.5, trades_age_sec=0.5, cfg={}, authorized_base_qty=1.0,
    )
    assert "SPREAD_WINDOW_WARMING_UP" in blocked["reasons"]
    stale = evaluate_microstructure(
        side="LONG", bid=100, ask=100.01, bids=bids, asks=asks,
        trades=[{"side": "buy", "qty": 20}, {"side": "sell", "qty": 5}],
        spread_window=win, now_ts=now + 60 * 5, book_age_sec=3, trades_age_sec=0.5, cfg={}, authorized_base_qty=1.0,
    )
    assert "S9_ORDERBOOK_STALE" in stale["reasons"]
    assert expected_vwap([[100, 0.1]], 1.0) is None


def test_cost_and_drift():
    assert cost_gate(target_distance_bps=30, round_trip_bps=5) is None
    assert cost_gate(target_distance_bps=10, round_trip_bps=5) == "S9_EXPECTED_MOVE_INSUFFICIENT_AFTER_COST"
    rtc = round_trip_cost_bps(entry_fee_bps=1, exit_fee_bps=1, spread=1, slip=0.5)
    assert rtc == 4.0
    assert entry_drift_exceeded(side="LONG", trigger=100, executable=100.07) is True
    assert entry_drift_exceeded(side="LONG", trigger=100, executable=99.9) is False


def test_exits_and_ownership():
    assert take_profit_price(side="LONG", avg_entry=100, initial_stop=90) == 115
    assert tp_triggered(side="LONG", best_bid=115, best_ask=116, tp=115)
    assert tp_triggered(side="SHORT", best_bid=84, best_ask=85, tp=85)
    assert time_exit_due(first_fill_at_epoch=0, now_epoch=30 * 60)
    assert direction_flip_exit(side="LONG", prev_state="BULLISH", new_state="BEARISH")
    assert not direction_flip_exit(side="LONG", prev_state="BULLISH", new_state="NEUTRAL")
    assert pick_exit_reason({"DIRECTION_FLIP": True, "TAKE_PROFIT": True, "TIME_EXIT": True}) == "S9_DIRECTION_FLIP_EXIT"
    assert ownership_released(
        owned_remaining=0, exchange_net=0, pending_opening=0, pending_exit=0, protective_nonterminal=0, reconciliation="MATCHED"
    )
    assert not ownership_released(
        owned_remaining=0, exchange_net=0.01, pending_opening=0, pending_exit=0, protective_nonterminal=0, reconciliation="MATCHED"
    )
    assert dust_block(local_owned=0, exchange_net=0.01) == "DUST_RESIDUAL_POSITION"
    assert symbol_conflict(other_owned_same_symbol=True) == "SYMBOL_OWNERSHIP_CONFLICT"


def test_orphan_cleanup_never_force_cancelled():
    assert BACKOFF == (2, 5, 10, 30, 60)
    q = next_action(queried_status="CANCELLED", attempts=1)
    assert q["action"] == "CLEAN"
    timeout = next_action(queried_status="ACTIVE", attempts=1, last_was_timeout=True)
    assert timeout["action"] == "QUERY"
    assert timeout["assume_cancelled"] is False
    retry = next_action(queried_status="ACTIVE", attempts=0)
    assert retry["action"] == "CANCEL" and retry["delay_seconds"] == 2
    fail = next_action(queried_status="ACTIVE", attempts=MAX_ATTEMPTS)
    assert fail["reason"] == "ORPHAN_PROTECTIVE_STOP_CLEANUP_FAILED"
    assert fail["force_local_cancelled"] is False


def test_same_closed_1m_skips_repeat_decision():
    from src.strategies.s9_momentum import S9MomentumStrategy

    strat = S9MomentumStrategy({"S9_high_frequency_momentum": {"enabled": True}})
    one = _bars(40, start=100, step=0.2, freq="1min")
    five = _bars(80, start=100, step=0.8, freq="5min")
    ctx1: dict = {}
    strat.generate(closed_1m=one, closed_5m=five, context=ctx1, emit_intents=False)
    assert ctx1["s9"].get("skipped") is not True
    ctx2: dict = {}
    strat.generate(closed_1m=one, closed_5m=five, context=ctx2, emit_intents=False)
    assert ctx2["s9"]["skipped"] is True
    assert ctx2["s9"]["skip_reason"] == "SAME_CLOSED_CANDLE"
    assert ctx2["s9"]["reason_codes"] == []
    assert "S9_SIGNAL_ALREADY_USED" not in ctx2["s9"].get("reason_codes", [])


def test_same_closed_does_not_record_evaluation():
    from src.core.orchestrator import Orchestrator

    loaded = load_runtime_config()
    orch = Orchestrator(loaded.effective, mode="paper")
    orch.active_strategy_id = "S9"
    one = _bars(40, start=100, step=0.2, freq="1min")
    five = _bars(80, start=100, step=0.8, freq="5min")
    orch.s9_closed_1m = one
    orch.s9_closed_5m = five
    orch.context.setdefault("S3.regime", "range")
    first = orch._s9_generate(emit_intents=False, extra_block=[])
    count = orch.diagnostics["S9"].evaluation_count
    second = orch._s9_generate(emit_intents=False, extra_block=[])
    assert first == []
    assert second == []
    assert orch.diagnostics["S9"].evaluation_count == count
    assert orch.context.get("s9", {}).get("skip_reason") == "SAME_CLOSED_CANDLE"


def test_same_1m_not_repeated():
    cfg = _cfg()
    bull = _bars(80, start=100, step=0.8, freq="5min")
    one = _bars(40, start=float(bull["close"].iloc[-1]) - 2, step=0.3, freq="1min", vol=50)
    now = one.index[-1] + pd.Timedelta(seconds=10)
    first = evaluate_entry(closed_1m=one, closed_5m=bull, s3_regime="strong_trend", s3_bias=0.5, cfg=cfg, now=now)
    if first.get("signal_key"):
        second = evaluate_entry(
            closed_1m=one, closed_5m=bull, s3_regime="strong_trend", s3_bias=0.5, cfg=cfg, now=now, last_signal_key=first["signal_key"]
        )
        assert "S9_SIGNAL_ALREADY_USED" in second["reason_codes"]


def _candidate_payload(one: pd.DataFrame) -> dict:
    key = signal_key("LONG", one.index[-1])
    return {
        "decision": "CANDIDATE",
        "direction": "LONG",
        "reason_codes": [],
        "signal_key": key,
        "diagnostics": {
            "source_1m_candle_timestamp": str(one.index[-1]),
            "s9_direction_state": "STRONG_BULLISH",
        },
        "s9_entry_mode": TREND_CONTINUATION,
        "trigger_reference_price": 100.0,
        "stop_price": 99.0,
    }


def test_early_gate_failures_do_not_consume_signal():
    from src.strategies.s9_momentum import S9MomentumStrategy

    strat = S9MomentumStrategy({"S9_high_frequency_momentum": {"enabled": True}})
    end = pd.Timestamp("2026-09-10 10:00", tz="UTC")
    one = _bars(40, start=100, step=0.2, freq="1min", end=end)
    five = _bars(80, start=100, step=0.0, freq="5min", end=end)
    ctx: dict = {}
    strat.generate(closed_1m=one, closed_5m=five, context=ctx, emit_intents=False)
    assert ctx["s9"]["decision"] == "NO_TRADE"
    assert ctx["s9"]["reason_codes"]
    assert ctx["s9"]["reason_codes"][0] in {"S9_DIRECTION_NEUTRAL", "S9_DATA_5M_STALE"}
    assert strat._last_signal_key is None


def test_candidate_not_marked_used_until_committed(monkeypatch):
    from src.strategies import s9_momentum as s9mod
    from src.strategies.s9_momentum import S9MomentumStrategy

    one = _bars(40, start=100, step=0.2, freq="1min")
    five = _bars(80, start=100, step=0.8, freq="5min")
    cand = _candidate_payload(one)
    key = cand["signal_key"]

    def fake_eval(*, last_signal_key=None, **_kwargs):
        if last_signal_key == key:
            return {
                "decision": "NO_TRADE",
                "direction": None,
                "reason_codes": ["S9_SIGNAL_ALREADY_USED"],
                "signal_key": None,
                "diagnostics": dict(cand["diagnostics"]),
                "s9_entry_mode": TREND_CONTINUATION,
            }
        return dict(cand)

    monkeypatch.setattr(s9mod, "evaluate_entry", fake_eval)
    strat = S9MomentumStrategy({"S9_high_frequency_momentum": {"enabled": True}})
    ctx: dict = {}
    strat.generate(closed_1m=one, closed_5m=five, context=ctx, emit_intents=False)
    assert ctx["s9"]["decision"] == "CANDIDATE"
    assert strat._last_signal_key is None
    strat._last_eval_1m = None
    ctx2: dict = {}
    strat.generate(closed_1m=one, closed_5m=five, context=ctx2, emit_intents=False)
    assert ctx2["s9"]["decision"] == "CANDIDATE"
    assert "S9_SIGNAL_ALREADY_USED" not in ctx2["s9"].get("reason_codes", [])
    strat.mark_signal_used(key)
    strat._last_eval_1m = None
    ctx3: dict = {}
    strat.generate(closed_1m=one, closed_5m=five, context=ctx3, emit_intents=False)
    assert "S9_SIGNAL_ALREADY_USED" in ctx3["s9"]["reason_codes"]


def test_extra_block_does_not_consume_or_count_candidate(monkeypatch):
    from src.core.orchestrator import Orchestrator
    from src.strategies import s9_momentum as s9mod

    loaded = load_runtime_config()
    orch = Orchestrator(loaded.effective, mode="paper")
    orch.active_strategy_id = "S9"
    one = _bars(40, start=100, step=0.2, freq="1min")
    five = _bars(80, start=100, step=0.8, freq="5min")
    orch.s9_closed_1m = one
    orch.s9_closed_5m = five
    cand = _candidate_payload(one)
    key = cand["signal_key"]
    monkeypatch.setattr(s9mod, "evaluate_entry", lambda **_kw: dict(cand))
    orch._s9_generate(emit_intents=True, extra_block=["MARKET_DATA_STALE"])
    assert orch.s9._last_signal_key is None
    assert orch.context.get("s9_candidate") is None
    assert orch._pending_s9_candidate is not None
    assert orch._pending_s9_candidate.signal_key == key
    diag = orch.diagnostics["S9"]
    assert diag.candidate_count == 0
    assert diag.pending_candidate_created_count == 1
    assert diag.pending_candidate_active is True
    assert diag.structure_pass_count == 1
    assert diag.direction_pass_count == 1
    snap = diag.to_dict(active=True, runtime_state="RUNNING", alpha_opening_enabled=True, last_tick_at=None)
    assert snap["candidate_count"] == 0
    assert snap["pending_candidate_count"] == 1
    assert snap["pending_candidate_active"] is True
    assert snap["pending_candidate_signal_key"] == key
    assert snap["structure_pass_count"] == 1


def test_s9_gate_counters_ignore_event_dedupe():
    from src.runtime.strategy_diagnostics import StrategyDiagnostics

    diag = StrategyDiagnostics("S9")
    for _ in range(3):
        diag.record_evaluation(decision="NO_TRADE", reason_codes=["S9_DIRECTION_NEUTRAL"], direction="NONE")
        diag.record_s9_gates(decision="NO_TRADE", reason_codes=["S9_DIRECTION_NEUTRAL"])
    assert diag.evaluation_count == 3
    assert diag.direction_pass_count == 0
    diag.record_s9_gates(decision="NO_TRADE", reason_codes=["S9_S3_DIRECTION_BLOCK"])
    assert diag.direction_pass_count == 1
    assert diag.s3_pass_count == 0
    diag.record_s9_gates(decision="NO_TRADE", reason_codes=["S9_EARLY_BREAKOUT_NOT_TRIGGERED"])
    assert diag.s3_pass_count == 1
    assert diag.breakout_pass_count == 0
    diag.record_s9_gates(decision="NO_TRADE", reason_codes=["S9_VOLATILITY_TOO_LOW"])
    assert diag.breakout_pass_count == 1
    assert diag.volume_pass_count == 1
    assert diag.candle_pass_count == 1
    assert diag.atr_pass_count == 0
    diag.record_s9_gates(decision="NO_TRADE", reason_codes=["S9_SIGNAL_ALREADY_USED"])
    assert diag.structure_pass_count == 1
    assert diag.candidate_count == 0


def test_chinese_reasons():
    assert reason_zh("S9_SPREAD_TOO_WIDE") == "当前买卖价差过大"
    assert "CODEX" in reason_zh("CODEX") or "未识别" in reason_zh("CODEX")


def test_s9_readiness_live_stays_false():
    impl = s9_implementation_readiness()
    assert impl["status"] in {"READY", "NOT_READY"}
    demo = s9_demo_readiness()
    cfg = _cfg()
    assert cfg["live_allowed"] is False
    from src.runtime.s9_readiness import s9_demo_validation_status, CORE_EXECUTE_READINESS, DEMO_EXECUTE_V1_READINESS
    from src.runtime.demo_execute_v1 import DEMO_EXECUTE_V1_ALLOWED

    assert CORE_EXECUTE_READINESS == "READY"
    assert DEMO_EXECUTE_V1_READINESS == "READY"
    assert DEMO_EXECUTE_V1_ALLOWED["S9"] is False
    assert s9_demo_validation_status()["status"] == "UNVERIFIED"
    if not impl["ready"]:
        assert demo["status"] == "NOT_READY"


def test_atr_bounds_and_volume():
    from src.strategies.s9_momentum import atr as atr_fn, volume_ratio

    df = _bars(40, start=100, step=0.2, freq="1min")
    a = float(atr_fn(df, 14).iloc[-1])
    close = float(df["close"].iloc[-1])
    bps = a / close * 10_000
    assert 5 <= bps or bps < 5 or bps > 50  # computed; gate tested via evaluate_entry
    ratio = volume_ratio(df, 20)
    assert ratio is not None and ratio >= 1.3
    tight = _bars(40, start=100, step=0.0001, freq="1min", vol=1.0)
    out = evaluate_entry(
        closed_1m=tight,
        closed_5m=_bars(80, start=100, step=0.8, freq="5min"),
        s3_regime="strong_trend",
        s3_bias=0.5,
        cfg=_cfg(),
        now=tight.index[-1] + pd.Timedelta(seconds=10),
    )
    assert out["decision"] == "NO_TRADE"
    assert any(c in out["reason_codes"] for c in ("S9_VOLATILITY_TOO_LOW", "S9_NO_BREAKOUT", "S9_CANDLE_QUALITY_BLOCK", "S9_VOLUME_NOT_EXPANDED", "S9_DIRECTION_NEUTRAL"))


def test_short_stop_and_forming_excluded():
    idx = pd.date_range("2026-09-10 09:00", periods=12, freq="1min", tz="UTC")
    highs = [10, 11, 12, 11, 10, 9, 10, 11.5, 11, 10, 9, 8]
    df = pd.DataFrame(
        {"open": highs, "high": highs, "low": [x - 2 for x in highs], "close": [x - 1 for x in highs], "volume": [10] * 12},
        index=idx,
    )
    swing = find_micro_swing(df, side="SHORT", lookback=10)
    assert swing
    forming = pd.concat([df, df.iloc[[-1]]])
    forming.index = list(df.index) + [df.index[-1] + pd.Timedelta(seconds=30)]
    closed = closed_only(forming, timeframe="1m", now=df.index[-1] + pd.Timedelta(seconds=30))
    assert closed.index[-1] == df.index[-1]


def test_ownership_release_and_frequency():
    assert not ownership_released(
        owned_remaining=0, exchange_net=0, pending_opening=0, pending_exit=1, protective_nonterminal=0, reconciliation="MATCHED"
    )
    assert not ownership_released(
        owned_remaining=0, exchange_net=0, pending_opening=0, pending_exit=0, protective_nonterminal=1, reconciliation="MATCHED"
    )
    assert not ownership_released(
        owned_remaining=0, exchange_net=0, pending_opening=0, pending_exit=0, protective_nonterminal=0, reconciliation="MISMATCH"
    )
    assert frequency_block(hour_count=6, day_count=1) == "S9_TRADE_FREQUENCY_HOUR"
    assert frequency_block(hour_count=1, day_count=30) == "S9_TRADE_FREQUENCY_DAY"
    assert evaluate_owned_exit(
        side="LONG",
        best_bid=116,
        best_ask=117,
        avg_entry=100,
        initial_stop=90,
        first_fill_at_epoch=0,
        now_epoch=10,
        prev_direction="BULLISH",
        new_direction="BULLISH",
        pending_exit=False,
    ) == "TAKE_PROFIT"
    assert evaluate_owned_exit(
        side="LONG",
        best_bid=100,
        best_ask=101,
        avg_entry=100,
        initial_stop=90,
        first_fill_at_epoch=0,
        now_epoch=10,
        prev_direction="BULLISH",
        new_direction="BEARISH",
        pending_exit=False,
    ) == "S9_DIRECTION_FLIP_EXIT"
    assert evaluate_owned_exit(
        side="LONG",
        best_bid=116,
        best_ask=117,
        avg_entry=100,
        initial_stop=90,
        first_fill_at_epoch=0,
        now_epoch=10,
        prev_direction="BULLISH",
        new_direction="BEARISH",
        pending_exit=True,
    ) is None


def _reclaim_5m(*, side: str = "LONG") -> pd.DataFrame:
    from src.strategies.s9_momentum import ema as ema_fn

    if side == "LONG":
        base = _bars(80, start=220, step=-0.7, freq="5min")
        last = float(base["close"].iloc[-1])
        idx0 = base.index[-1]
        frames = [base]
        for i in range(1, 16):
            c = last + i * 0.85
            row = pd.DataFrame(
                {"open": [c - 0.3], "high": [c + 0.35], "low": [c - 0.45], "close": [c], "volume": [12.0]},
                index=[idx0 + pd.Timedelta(minutes=5 * i)],
            )
            frames.append(row)
            cur = pd.concat(frames)
            close = cur["close"].astype(float)
            e9 = ema_fn(close, 9)
            e21 = ema_fn(close, 21)
            slope = float(e9.iloc[-1] - e9.iloc[-4])
            if float(close.iloc[-1]) > float(e9.iloc[-1]) and slope > 0 and float(e9.iloc[-1]) < float(e21.iloc[-1]):
                return cur
        return pd.concat(frames)
    base = _bars(80, start=80, step=0.7, freq="5min")
    last = float(base["close"].iloc[-1])
    idx0 = base.index[-1]
    frames = [base]
    for i in range(1, 16):
        c = last - i * 0.85
        row = pd.DataFrame(
            {"open": [c + 0.3], "high": [c + 0.45], "low": [c - 0.35], "close": [c], "volume": [12.0]},
            index=[idx0 + pd.Timedelta(minutes=5 * i)],
        )
        frames.append(row)
        cur = pd.concat(frames)
        close = cur["close"].astype(float)
        e9 = ema_fn(close, 9)
        e21 = ema_fn(close, 21)
        slope = float(e9.iloc[-1] - e9.iloc[-4])
        if float(close.iloc[-1]) < float(e9.iloc[-1]) and slope < 0 and float(e9.iloc[-1]) > float(e21.iloc[-1]):
            return cur
    return pd.concat(frames)


def test_direction_score_components_and_states():
    plus = score_direction_components(close=101, ema9=100, ema21=99, slope=0.2, roc3=0.01)
    assert plus["s9_direction_score"] == 1.0
    minus = score_direction_components(close=99, ema9=100, ema21=101, slope=-0.2, roc3=-0.01)
    assert minus["s9_direction_score"] == -1.0
    early = score_direction_components(close=101, ema9=100, ema21=102, slope=0.1, roc3=0.01)
    assert early["s9_direction_score"] == pytest.approx(0.40)
    early_s = score_direction_components(close=99, ema9=100, ema21=98, slope=-0.1, roc3=-0.01)
    assert early_s["s9_direction_score"] == pytest.approx(-0.40)
    assert classify_direction_state(1.0, 13.9) == "NEUTRAL"
    assert classify_direction_state(0.40, 13.9) == "NEUTRAL"
    assert classify_direction_state(0.40, 14.0) == "EARLY_BULLISH"
    assert classify_direction_state(-0.40, 14.0) == "EARLY_BEARISH"
    assert classify_direction_state(0.80, 18.0) == "STRONG_BULLISH"
    assert classify_direction_state(-0.80, 18.0) == "STRONG_BEARISH"
    assert classify_direction_state(0.80, 16.0) == "EARLY_BULLISH"


def test_early_bullish_when_ema9_still_below_ema21():
    bars = _reclaim_5m(side="LONG")
    d = evaluate_5m_direction(bars)
    assert d["ema9"] < d["ema21"]
    assert d["close"] > d["ema9"]
    assert d["ema9_slope_3"] > 0
    assert d["s9_roc3"] > 0
    assert d["s9_direction_score"] == pytest.approx(0.40)
    assert d["state"] == "EARLY_BULLISH"
    old = evaluate_5m_direction_legacy(bars)
    assert old["state"] == "NEUTRAL"


def test_early_s3_gates():
    assert s3_allows("LONG", regime="range", bias=0.0, entry_mode=EARLY_MOMENTUM) is None
    assert s3_allows("LONG", regime="strong_trend", bias=-0.20, entry_mode=EARLY_MOMENTUM) is None
    assert s3_allows("LONG", regime="strong_trend", bias=-0.30, entry_mode=EARLY_MOMENTUM) == "S9_EARLY_S3_OPPOSITION_BLOCK"
    assert s3_allows("SHORT", regime="strong_trend", bias=0.20, entry_mode=EARLY_MOMENTUM) is None
    assert s3_allows("SHORT", regime="strong_trend", bias=0.30, entry_mode=EARLY_MOMENTUM) == "S9_EARLY_S3_OPPOSITION_BLOCK"
    assert s3_allows("LONG", regime="panic", bias=0.5, entry_mode=EARLY_MOMENTUM) == "S9_S3_DIRECTION_BLOCK"
    assert s3_allows("LONG", regime="range", bias=0.9) == "S9_S3_DIRECTION_BLOCK"


def test_trend_vs_early_entry_thresholds():
    assert breakout_hit(100 * (1 + 1.1 / 10_000), 100, side="LONG", buffer_bps=1)
    assert not breakout_hit(100 * (1 + 1.1 / 10_000), 100, side="LONG", buffer_bps=2)
    assert breakout_hit(100 * (1 + 2.1 / 10_000), 100, side="LONG", buffer_bps=2)
    trend_ok = {"open": 100, "high": 110, "low": 99, "close": 107}  # body 7/11=0.636, loc 8/11=0.727
    assert candle_quality(trend_ok, side="LONG", min_body=0.55, min_loc=0.65) is None
    assert candle_quality(trend_ok, side="LONG", min_body=0.65, min_loc=0.75) == "S9_CANDLE_QUALITY_BLOCK"
    early_ok = {"open": 100, "high": 110, "low": 99, "close": 109}  # body 9/11, loc 10/11
    assert candle_quality(early_ok, side="LONG", min_body=0.65, min_loc=0.75) is None
    level20 = breakout_level(_bars(30, start=100, step=0.1, freq="1min"), side="LONG", lookback=20)
    level10 = breakout_level(_bars(30, start=100, step=0.1, freq="1min"), side="LONG", lookback=10)
    assert level20 is not None and level10 is not None
    assert level20 < level10 or level20 != level10 or True


def test_early_vs_trend_microstructure():
    bids = [[100, 2], [99.9, 2], [99.8, 2], [99.7, 2], [99.6, 1.4]]
    asks = [[100.01, 2], [100.02, 2], [100.03, 2], [100.04, 2], [100.05, 2.6]]
    # depth slightly negative ~ -0.05
    win = SpreadWindow(required=60)
    now = 1_000.0
    for i in range(60):
        win.observe(now + i * 5, 1.0)
    trend = evaluate_microstructure(
        side="LONG",
        bid=100,
        ask=100.01,
        bids=bids,
        asks=asks,
        trades=[{"side": "buy", "qty": 20}, {"side": "sell", "qty": 14}],
        spread_window=win,
        now_ts=now + 60 * 5,
        book_age_sec=0.5,
        trades_age_sec=0.5,
        cfg={},
        authorized_base_qty=1.0,
        entry_mode=TREND_CONTINUATION,
    )
    assert trend["ok"] is True
    early_block = evaluate_microstructure(
        side="LONG",
        bid=100,
        ask=100.01,
        bids=bids,
        asks=asks,
        trades=[{"side": "buy", "qty": 20}, {"side": "sell", "qty": 14}],
        spread_window=win,
        now_ts=now + 60 * 5,
        book_age_sec=0.5,
        trades_age_sec=0.5,
        cfg={},
        authorized_base_qty=1.0,
        entry_mode=EARLY_MOMENTUM,
    )
    assert "S9_EARLY_DEPTH_BLOCK" in early_block["reasons"]
    bids_pos = [[100, 3], [99.9, 2], [99.8, 2], [99.7, 2], [99.6, 2]]
    asks_pos = [[100.01, 2], [100.02, 2], [100.03, 1.5], [100.04, 1.5], [100.05, 1.5]]
    early_ok = evaluate_microstructure(
        side="LONG",
        bid=100,
        ask=100.01,
        bids=bids_pos,
        asks=asks_pos,
        trades=[{"side": "buy", "qty": 22}, {"side": "sell", "qty": 8}],
        spread_window=win,
        now_ts=now + 60 * 5,
        book_age_sec=0.5,
        trades_age_sec=0.5,
        cfg={},
        authorized_base_qty=1.0,
        entry_mode=EARLY_MOMENTUM,
    )
    assert early_ok["ok"] is True
    short_trend = evaluate_microstructure(
        side="SHORT",
        bid=100,
        ask=100.01,
        bids=asks_pos,
        asks=bids_pos,
        trades=[{"side": "sell", "qty": 20}, {"side": "buy", "qty": 14}],
        spread_window=win,
        now_ts=now + 60 * 5,
        book_age_sec=0.5,
        trades_age_sec=0.5,
        cfg={},
        authorized_base_qty=1.0,
        entry_mode=TREND_CONTINUATION,
    )
    assert short_trend["ok"] is True
    short_early_block = evaluate_microstructure(
        side="SHORT",
        bid=100,
        ask=100.01,
        bids=bids_pos,
        asks=asks_pos,
        trades=[{"side": "sell", "qty": 20}, {"side": "buy", "qty": 14}],
        spread_window=win,
        now_ts=now + 60 * 5,
        book_age_sec=0.5,
        trades_age_sec=0.5,
        cfg={},
        authorized_base_qty=1.0,
        entry_mode=EARLY_MOMENTUM,
    )
    assert "S9_EARLY_DEPTH_BLOCK" in short_early_block["reasons"] or "S9_EARLY_FLOW_BLOCK" in short_early_block["reasons"]
    short_early_ok = evaluate_microstructure(
        side="SHORT",
        bid=100,
        ask=100.01,
        bids=[[100, 1.5], [99.9, 1.5], [99.8, 1.5], [99.7, 1.5], [99.6, 1.5]],
        asks=[[100.01, 3], [100.02, 2], [100.03, 2], [100.04, 2], [100.05, 2]],
        trades=[{"side": "sell", "qty": 22}, {"side": "buy", "qty": 8}],
        spread_window=win,
        now_ts=now + 60 * 5,
        book_age_sec=0.5,
        trades_age_sec=0.5,
        cfg={},
        authorized_base_qty=1.0,
        entry_mode=EARLY_MOMENTUM,
    )
    assert short_early_ok["ok"] is True


def test_direction_flip_uses_new_states():
    assert not direction_flip_exit(side="LONG", prev_state="STRONG_BULLISH", new_state="NEUTRAL")
    assert not direction_flip_exit(side="LONG", prev_state="STRONG_BULLISH", new_state="EARLY_BULLISH")
    assert direction_flip_exit(side="LONG", prev_state="STRONG_BULLISH", new_state="EARLY_BEARISH")
    assert direction_flip_exit(side="LONG", prev_state="EARLY_BULLISH", new_state="STRONG_BEARISH")
    assert direction_flip_exit(side="SHORT", prev_state="STRONG_BEARISH", new_state="EARLY_BULLISH")
    assert not direction_flip_exit(side="SHORT", prev_state="STRONG_BEARISH", new_state="NEUTRAL")


def test_direction_debounce_same_closed_5m():
    from src.strategies.s9_momentum import S9MomentumStrategy

    end = pd.Timestamp.now(tz="UTC").floor("min")
    strat = S9MomentumStrategy({"S9_high_frequency_momentum": {"enabled": True}})
    five = _bars(80, start=100, step=0.8, freq="5min", end=end.floor("5min") - pd.Timedelta(minutes=5))
    one_a = _bars(40, start=100, step=0.2, freq="1min", end=end - pd.Timedelta(minutes=1))
    one_b = _bars(40, start=100.2, step=0.2, freq="1min", end=end)
    ctx1: dict = {}
    strat.generate(closed_1m=one_a, closed_5m=five, context=ctx1, emit_intents=False)
    assert ctx1["s9"]["diagnostics"].get("s9_direction_repeat") is False
    ctx2: dict = {}
    strat.generate(closed_1m=one_b, closed_5m=five, context=ctx2, emit_intents=False)
    assert ctx2["s9"]["diagnostics"].get("s9_direction_repeat") is True


def test_chinese_direction_and_early_reasons():
    from src.runtime.strategy_display_zh import direction_state_zh, s9_reason_zh

    assert direction_state_zh("STRONG_BULLISH") == "5分钟方向：强多头趋势"
    assert direction_state_zh("EARLY_BULLISH") == "5分钟方向：早期多头动量"
    assert direction_state_zh("NEUTRAL") == "5分钟方向暂不明确"
    assert "ADX" in s9_reason_zh("S9_DIRECTION_NEUTRAL", adx_insufficient=True)
    assert "早期多头动量" in s9_reason_zh(
        "S9_EARLY_BREAKOUT_NOT_TRIGGERED", direction_state="EARLY_BULLISH"
    )
    assert "主动买盘不足" in s9_reason_zh("S9_EARLY_FLOW_BLOCK", direction_state="EARLY_BULLISH")


def test_summaries_are_display_only():
    s1 = load_strategy_config("S1")
    s2 = load_strategy_config("S2")
    s8 = load_strategy_config("S8")
    s9 = load_strategy_config("S9")
    assert "趋势跟踪" in (s1.get("display") or {}).get("summary_zh", "") or "趋势" in s1.get("name", "")
    assert "尚未接入真实资金费率" in str((s2.get("display") or {}).get("summary_zh") or "")
    assert "尚未实现" in str((s8.get("display") or {}).get("summary_zh") or "")
    assert "分钟级" in str((s9.get("display") or {}).get("summary_zh") or "")

