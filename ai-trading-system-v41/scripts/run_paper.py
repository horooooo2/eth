#!/usr/bin/env python3
"""Paper / mock trading entrypoint — no API keys required."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.core.orchestrator import Orchestrator


async def main() -> None:
    orch = Orchestrator.from_runtime(mode="paper", symbol="BTC/USDT:USDT")
    # Force friendly microstructure for demo cycle
    micro = {
        "spread_bps": 2.0,
        "depth_imbalance": 0.2,
        "aggressive_buy_ratio": 3.5,
        "aggressive_sell_ratio": 1.0,
        "price_impact_buy": 0.0004,
        "price_impact_sell": 0.0004,
        "market_data_stale_ms": 40,
        "sequence_valid": True,
        "exchange_connected": True,
    }
    ctx = await orch.run_cycle(microstructure=micro)
    summary = {
        "mode": ctx.get("mode"),
        "S6.level": ctx.get("S6.level"),
        "S3": ctx.get("S3"),
        "S5_final_shares": (ctx.get("S5") or {}).get("final_shares"),
        "intents": (ctx.get("step::S1_S2_signal_generation") or {}).get("count"),
        "confirmed": len(ctx.get("confirmed_intents") or []),
        "orders": ctx.get("orders_created"),
        "data_quality_ok": ctx.get("data_quality_ok"),
        "cost_gate_pass": ctx.get("cost_gate_pass"),
        "live_trading_allowed": ctx.get("live_trading_allowed"),
    }
    print(json.dumps(summary, indent=2, ensure_ascii=False, default=str))


if __name__ == "__main__":
    asyncio.run(main())
