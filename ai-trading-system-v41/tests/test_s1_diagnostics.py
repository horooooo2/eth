"""S1 diagnostics + closed-bar market path (no threshold changes)."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from src.adapters.okx_market_data import split_closed_bars, use_real_okx_market
from src.core.orchestrator import Orchestrator

ROOT = Path(__file__).resolve().parents[1]
CFG_PATH = ROOT / "config" / "system_config.json"


def _bars_1h(n: int = 220, seed: int = 7) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    rets = rng.normal(0.0002, 0.004, size=n)
    close = 100_000 * np.cumprod(1 + rets)
    high = close * 1.002
    low = close * 0.998
    open_ = np.roll(close, 1)
    open_[0] = close[0]
    idx = pd.date_range(end=pd.Timestamp.now(tz="UTC").floor("h"), periods=n, freq="1h")
    return pd.DataFrame(
        {"open": open_, "high": high, "low": low, "close": close, "volume": rng.uniform(10, 40, n)},
        index=idx,
    )


def test_pytest_defaults_to_mock_market(monkeypatch):
    monkeypatch.delenv("V41_MARKET_DATA_SOURCE", raising=False)
    assert use_real_okx_market() is False


def test_explicit_okx_source_overrides_pytest(monkeypatch):
    monkeypatch.setenv("V41_MARKET_DATA_SOURCE", "okx")
    assert use_real_okx_market() is True
    monkeypatch.setenv("V41_MARKET_DATA_SOURCE", "mock")
    assert use_real_okx_market() is False


def test_split_closed_bars_drops_forming_hour():
    now = pd.Timestamp.now(tz="UTC")
    idx = pd.date_range(end=now.floor("h"), periods=5, freq="1h")
    df = pd.DataFrame(
        {"open": 1, "high": 1, "low": 1, "close": 1, "volume": 1},
        index=idx,
    )
    # last bar open is this hour → forming
    forming_idx = pd.DatetimeIndex([*idx[:-1], now.floor("h")])
    df.index = forming_idx
    closed, forming, candle_closed = split_closed_bars(df, timeframe="1h")
    if now < now.floor("h") + pd.Timedelta(hours=1):
        assert candle_closed is False
        assert forming is not None
        assert len(closed) == len(df) - 1


@pytest.mark.asyncio
async def test_evaluation_count_grows_only_on_cycle():
    cfg = json.loads(CFG_PATH.read_text(encoding="utf-8"))
    orch = Orchestrator(cfg, mode="paper")
    micro = {
        "spread_bps": 2.0,
        "depth_imbalance": 0.25,
        "aggressive_buy_ratio": 4.0,
        "aggressive_sell_ratio": 0.5,
        "price_impact_buy": 0.0003,
        "price_impact_sell": 0.0003,
        "market_data_stale_ms": 20,
        "sequence_valid": True,
        "exchange_connected": True,
    }
    d0 = orch.diagnostics["S1"].evaluation_count
    ctx = await orch.run_cycle(bars=_bars_1h(), microstructure=micro)
    d1 = orch.diagnostics["S1"].evaluation_count
    assert d1 == d0 + 1
    snap = orch.diagnostics["S1"].to_dict(
        active=True,
        runtime_state="RUNNING",
        alpha_opening_enabled=True,
        last_tick_at=None,
        market_data=orch.market_meta,
    )
    assert snap["evaluation_count"] == d1
    assert snap["last_evaluated_at"]
    assert snap["last_decision"] in {"NO_TRADE", "ALLOW", "BLOCK"}
    assert isinstance(snap["last_reason_codes"], list)
    assert snap["evaluation_count"] == orch.diagnostics["S1"].evaluation_count
    assert ctx.get("market_data", {}).get("timeframe") == orch.s1_timeframe
    assert orch.market_meta.get("bars_loaded", 0) >= 100
    assert orch.market_state in {"READY", "WARMING_UP", "STALE"}


@pytest.mark.asyncio
async def test_warmup_blocks_intents_without_fake_trade():
    cfg = json.loads(CFG_PATH.read_text(encoding="utf-8"))
    orch = Orchestrator(cfg, mode="paper")
    orch.market_warmup_bars = 100
    micro = {
        "spread_bps": 2.0,
        "depth_imbalance": 0.25,
        "aggressive_buy_ratio": 4.0,
        "aggressive_sell_ratio": 0.5,
        "price_impact_buy": 0.0003,
        "price_impact_sell": 0.0003,
        "market_data_stale_ms": 20,
        "sequence_valid": True,
        "exchange_connected": True,
    }
    ctx = await orch.run_cycle(bars=_bars_1h(40), microstructure=micro)
    assert orch.market_state == "WARMING_UP"
    assert ctx.get("trade_intents") in ([], None) or len(ctx.get("trade_intents") or []) == 0
    reasons = orch.diagnostics["S1"].last_reason_codes
    assert "MARKET_DATA_WARMING_UP" in reasons or orch.diagnostics["S1"].last_decision in {
        "NO_TRADE",
        "BLOCK",
    }
