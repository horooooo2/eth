"""Canonical closed-1m identity. No Alpha param changes. No orders."""

from __future__ import annotations

import pandas as pd

from src.runtime.engine_store import EngineStore
from src.runtime.s9_candle_identity import closed_candle_id, closed_candle_iso
from src.runtime.s9_market_hub import S9MarketHub
from src.runtime.s9_microstructure_recorder import maybe_record
from src.strategies.s9_momentum import S9MomentumStrategy, signal_key
from tests.test_s9_microstructure_recorder import _one, _orch

CANDLE_UTC = "2026-09-10T12:57:00Z"
CANDLE_MS = 1789045020000


def _assert_canonical():
    assert closed_candle_id(CANDLE_UTC) == CANDLE_MS
    assert closed_candle_iso(CANDLE_MS) == CANDLE_UTC


def _df(ts) -> pd.DataFrame:
    if isinstance(ts, int):
        stamp = pd.Timestamp(ts, unit="ms", tz="UTC")
    else:
        stamp = pd.Timestamp(ts)
    return pd.DataFrame(
        {"open": [100.0], "high": [101.0], "low": [99.0], "close": [100.5], "volume": [10.0]},
        index=pd.DatetimeIndex([stamp]),
    )


def _five() -> pd.DataFrame:
    return pd.DataFrame(
        {"open": [100.0], "high": [101.0], "low": [99.0], "close": [100.5], "volume": [10.0]},
        index=pd.date_range("2026-09-10 12:00", periods=1, freq="5min", tz="UTC"),
    )


def test_canonical_forms_collapse_to_one_id():
    _assert_canonical()
    forms = [
        CANDLE_MS,
        CANDLE_MS / 1000.0,
        CANDLE_UTC,
        "2026-09-10T12:57:00+00:00",
        "2026-09-10 12:57:00+00:00",
        "2026-09-10 20:57:00+08:00",
        pd.Timestamp(CANDLE_UTC),
        pd.Timestamp("2026-09-10 12:57:00", tz="UTC"),
        pd.Timestamp("2026-09-10 20:57:00+08:00"),
        pd.to_datetime(CANDLE_MS, unit="ms", utc=True),
    ]
    ids = {closed_candle_id(x) for x in forms}
    assert ids == {CANDLE_MS}
    assert {closed_candle_iso(x) for x in forms} == {CANDLE_UTC}


def test_signal_key_unchanged_and_stable_across_text_forms():
    a = signal_key("LONG", CANDLE_UTC)
    b = signal_key("LONG", CANDLE_MS)
    c = signal_key("LONG", "2026-09-10 20:57:00+08:00")
    assert a == b == c == f"S9:BTC-USDT-SWAP:LONG:{CANDLE_UTC}"


def test_same_candle_same_source_evaluates_once():
    strat = S9MomentumStrategy({"S9_high_frequency_momentum": {"enabled": True}})
    one = _df(CANDLE_UTC)
    five = _five()
    strat.generate(closed_1m=one, closed_5m=five, context={}, emit_intents=False)
    assert strat._last_eval_1m == CANDLE_MS
    ctx2: dict = {}
    strat.generate(closed_1m=one, closed_5m=five, context=ctx2, emit_intents=False)
    assert ctx2["s9"]["skipped"] is True
    assert ctx2["s9"]["skip_reason"] == "SAME_CLOSED_CANDLE"


def test_same_candle_rest_vs_ws_and_iso_vs_epoch():
    strat = S9MomentumStrategy({"S9_high_frequency_momentum": {"enabled": True}})
    five = _five()
    rest = _df(pd.to_datetime(CANDLE_MS, unit="ms", utc=True))
    ws = _df("2026-09-10T12:57:00+00:00")
    epoch_idx = _df(CANDLE_MS)
    tz_text = _df("2026-09-10 20:57:00+08:00")
    strat.generate(closed_1m=rest, closed_5m=five, context={}, emit_intents=False)
    for nxt in (ws, epoch_idx, tz_text):
        ctx: dict = {}
        strat.generate(closed_1m=nxt, closed_5m=five, context=ctx, emit_intents=False)
        assert ctx["s9"]["skipped"] is True, nxt.index[-1]
        assert strat._last_eval_1m == CANDLE_MS


def test_next_candle_evaluates_again():
    strat = S9MomentumStrategy({"S9_high_frequency_momentum": {"enabled": True}})
    five = _five()
    first = _df(CANDLE_UTC)
    nxt = _df("2026-09-10T12:58:00Z")
    ctx1: dict = {}
    strat.generate(closed_1m=first, closed_5m=five, context=ctx1, emit_intents=False)
    assert ctx1["s9"].get("skipped") is not True
    ctx2: dict = {}
    strat.generate(closed_1m=nxt, closed_5m=five, context=ctx2, emit_intents=False)
    assert ctx2["s9"].get("skipped") is not True
    assert strat._last_eval_1m == closed_candle_id("2026-09-10T12:58:00Z")


def test_gap_recovery_replay_same_closed_is_one_eval():
    hub = S9MarketHub()
    hub.ingest_candle(
        "candle1m",
        {"ts": CANDLE_MS, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1, "closed": True, "confirm": "1"},
        source="ws",
    )
    assert hub.new_closed_1m_timestamp() == CANDLE_MS
    hub.mark_1m_evaluated(CANDLE_MS)
    rest = pd.DataFrame(
        {"open": [1], "high": [1], "low": [1], "close": [1], "volume": [1]},
        index=[pd.Timestamp("2026-09-10 20:57:00+08:00")],
    )
    hub.seed_closed_bars("1m", rest)
    assert list(hub.closed_1m) == [CANDLE_MS]
    assert hub.new_closed_1m_timestamp() is None
    strat = S9MomentumStrategy({"S9_high_frequency_momentum": {"enabled": True}})
    five = _five()
    ws_df = hub.closed_1m_df()
    strat.generate(closed_1m=ws_df, closed_5m=five, context={}, emit_intents=False)
    ctx: dict = {}
    strat.generate(closed_1m=rest, closed_5m=five, context=ctx, emit_intents=False)
    assert ctx["s9"]["skip_reason"] == "SAME_CLOSED_CANDLE"


def test_raw_strings_are_not_equal_but_identity_is():
    space = "2026-09-10 12:57:00+00:00"
    iso_t = "2026-09-10T12:57:00+00:00"
    plus8 = "2026-09-10 20:57:00+08:00"
    assert space != iso_t != plus8
    assert str(pd.Timestamp(space)) != str(pd.Timestamp(plus8))
    assert closed_candle_id(space) == closed_candle_id(iso_t) == closed_candle_id(plus8) == CANDLE_MS


def test_recorder_same_candle_direction_one_row(tmp_path):
    store = EngineStore(tmp_path / "id.db")
    base = _one()
    # force last bar to canonical 12:57 via rebuild
    idx = list(base.index[:-1]) + [pd.Timestamp(CANDLE_UTC)]
    base = base.copy()
    base.index = pd.DatetimeIndex(idx)
    orch = _orch(store, base)
    assert maybe_record(orch) is True
    alt = base.copy()
    last = pd.Timestamp("2026-09-10 20:57:00+08:00").tz_convert("UTC")
    alt.index = pd.DatetimeIndex([*base.index[:-1], last])
    orch.s9_closed_1m = alt
    assert maybe_record(orch) is False
    assert len(store.list_s9_microstructure_research()) == 1
    assert store.list_s9_microstructure_research()[0]["closed_1m_timestamp"] == CANDLE_UTC
    store.close()
