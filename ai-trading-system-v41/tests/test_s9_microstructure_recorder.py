"""S9 microstructure research recorder. Read-only. No exchange orders."""

from __future__ import annotations

from types import SimpleNamespace

import pandas as pd

from src.runtime.engine_store import EngineStore
from src.runtime.s9_microstructure_recorder import backfill_outcomes, maybe_record
from src.strategies.s9_momentum import STRONG_BEARISH


def _one(n: int = 30, *, breakout_fail: bool = True) -> pd.DataFrame:
    idx = pd.date_range("2026-09-10 12:00:00", periods=n, freq="1min", tz="UTC")
    close = [78000.0 + i * 2 for i in range(n)]
    if not breakout_fail:
        close[-1] = min(close[:-1]) - 20
    high = [c + 8 for c in close]
    low = [c - 8 for c in close]
    if breakout_fail:
        low[-1] = close[-1] - 2
    return pd.DataFrame(
        {"open": close, "high": high, "low": low, "close": close, "volume": [10.0] * n},
        index=idx,
    )


def _orch(store: EngineStore, one: pd.DataFrame, **ctx_extra) -> SimpleNamespace:
    ctx = {
        "s9": {
            "diagnostics": {
                "s9_direction_state": STRONG_BEARISH,
                "s9_direction_score": -1.0,
                "s9_adx14": 22.0,
                "ema9": 78100.0,
                "ema21": 78150.0,
            }
        },
        "exchange_net_position_contracts": 0.0,
        "owned_open_positions": [],
    }
    ctx.update(ctx_extra)
    hub = SimpleNamespace(
        book={
            "timestamp": one.index[-1].timestamp() * 1000,
            "best_bid": 77990.0,
            "best_ask": 78000.0,
            "bids": [[77990.0, 12.0], [77980.0, 8.0]],
            "asks": [[78000.0, 10.0], [78010.0, 6.0]],
        },
        trades=[
            {"timestamp": one.index[-1].timestamp() * 1000, "side": "sell", "price": 77995.0, "qty": 2.0},
            {"timestamp": one.index[-1].timestamp() * 1000, "side": "buy", "price": 77996.0, "qty": 1.0},
        ],
        public_client=SimpleNamespace(connection_state="CONNECTED"),
        candle_client=SimpleNamespace(connection_state="CONNECTED"),
        connection_state="CONNECTED",
        _now=lambda: one.index[-1].timestamp() + 2,
    )

    def recent_trades(_now=None):
        return list(hub.trades)

    def book_age_sec(_now=None):
        return 0.4

    def trades_age_sec(_now=None):
        return 0.3

    hub.recent_trades = recent_trades
    hub.book_age_sec = book_age_sec
    hub.trades_age_sec = trades_age_sec
    return SimpleNamespace(
        engine_store=store,
        symbol="BTC/USDT:USDT",
        s9_closed_1m=one,
        s9_closed_5m=one,
        s9_hub=hub,
        context=ctx,
    )


def test_records_strong_breakout_fail_and_dedups(tmp_path):
    store = EngineStore(tmp_path / "r.db")
    orch = _orch(store, _one())
    assert maybe_record(orch) is True
    assert maybe_record(orch) is False
    rows = store.list_s9_microstructure_research()
    assert len(rows) == 1
    payload = rows[0]["payload"]
    assert payload["direction_state"] == STRONG_BEARISH
    assert payload["distance_to_breakout_bps"] is not None
    assert payload["depth_imbalance"] is not None
    assert payload["flow_imbalance"] is not None
    assert payload["spread_bps"] is not None
    assert payload["research_only"] is True
    store.close()


def test_skips_early_position_and_breakout_pass(tmp_path):
    store = EngineStore(tmp_path / "r2.db")
    early = _orch(store, _one())
    early.context["s9"]["diagnostics"]["s9_direction_state"] = "EARLY_BEARISH"
    assert maybe_record(early) is False
    pos = _orch(store, _one(), exchange_net_position_contracts=0.2)
    assert maybe_record(pos) is False
    hit = _orch(store, _one(breakout_fail=False))
    assert maybe_record(hit) is False
    assert store.list_s9_microstructure_research() == []
    store.close()


def test_outcome_backfill_not_used_for_decision(tmp_path):
    store = EngineStore(tmp_path / "r3.db")
    base = _one(30)
    orch = _orch(store, base)
    assert maybe_record(orch) is True
    extra = pd.date_range(base.index[-1] + pd.Timedelta(minutes=1), periods=30, freq="1min", tz="UTC")
    more = pd.DataFrame(
        {
            "open": [float(base["close"].iloc[-1]) - i for i in range(30)],
            "high": [float(base["close"].iloc[-1]) - i + 5 for i in range(30)],
            "low": [float(base["close"].iloc[-1]) - i - 8 for i in range(30)],
            "close": [float(base["close"].iloc[-1]) - i - 3 for i in range(30)],
            "volume": [10.0] * 30,
        },
        index=extra,
    )
    orch.s9_closed_1m = pd.concat([base, more])
    assert backfill_outcomes(orch) == 1
    row = store.list_s9_microstructure_research()[0]
    assert row["outcome"]["15m_directional_return"] is not None
    assert row["outcome"]["15m_mfe"] is not None
    assert row["payload"].get("research_only") is True
    store.close()


def test_generate_hook_does_not_emit_intents(tmp_path):
    from src.core.orchestrator import Orchestrator
    from src.runtime.config_loader import load_runtime_config

    loaded = load_runtime_config()
    orch = Orchestrator(loaded.effective, mode="paper")
    orch.active_strategy_id = "S9"
    orch.engine_store = EngineStore(tmp_path / "r4.db")
    orch.s9_closed_1m = _one()
    orch.s9_closed_5m = _one(80)
    orch.context.setdefault("S3.regime", "range")
    out = orch._s9_generate(emit_intents=True, extra_block=[])
    assert out == []
    assert orch.context.get("s9_candidate") in (None, {})
    orch.engine_store.close()
