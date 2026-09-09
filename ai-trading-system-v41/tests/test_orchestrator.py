"""Tests for orchestrator decision cycle."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from src.core.orchestrator import Orchestrator

ROOT = Path(__file__).resolve().parents[1]
CFG_PATH = ROOT / "config" / "system_config.json"


def _bars(n: int = 300, seed: int = 42) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    rets = rng.normal(0.0005, 0.002, size=n)  # mild uptrend
    close = 100.0 * np.cumprod(1 + rets)
    high = close * 1.001
    low = close * 0.999
    open_ = np.roll(close, 1)
    open_[0] = close[0]
    idx = pd.date_range(end=pd.Timestamp.now(tz="UTC"), periods=n, freq="5min")
    return pd.DataFrame(
        {"open": open_, "high": high, "low": low, "close": close, "volume": rng.uniform(5, 20, n)},
        index=idx,
    )


@pytest.mark.asyncio
async def test_decision_order_length():
    orch = Orchestrator.from_config_path(CFG_PATH, mode="paper")
    assert len(orch.decision_order()) == 11
    assert orch.decision_order()[0] == "S6_safety_gate"
    assert orch.decision_order()[-1] == "final_order_creation"


@pytest.mark.asyncio
async def test_run_cycle_completes():
    cfg = json.loads(CFG_PATH.read_text(encoding="utf-8"))
    assert cfg["meta"]["live_trading_allowed"] is False
    assert cfg["S5_risk_budget"]["reserve_fraction"] == 0.15
    assert cfg["S6_anomaly"]["evaluation_interval_seconds"] == 5

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
    ctx = await orch.run_cycle(bars=_bars(), microstructure=micro)
    assert "S6.level" in ctx
    assert "S3" in ctx or "S3.regime" in ctx
    assert "S5" in ctx
    assert ctx.get("data_quality_ok") is True
    assert "step::final_order_creation" in ctx
    # reserve invariant
    final = (ctx.get("S5") or {}).get("final_shares") or {}
    assert sum(final.values()) <= 0.85 + 1e-9


@pytest.mark.asyncio
async def test_s5_reserve_fraction():
    orch = Orchestrator.from_config_path(CFG_PATH, mode="paper")
    orch.context = {"S3.risk_multiplier": 1.0, "global_drawdown_multiplier": 1.0, "daily_loss_multiplier": 1.0}
    result = orch.s5.allocate(
        regime="strong_trend",
        health_scores={"S1": 90, "S2": 80, "S4": 80},
        context=orch.context,
    )
    assert result["reserve_fraction"] == 0.15
    assert sum(result["final_shares"].values()) <= 0.85 + 1e-9
