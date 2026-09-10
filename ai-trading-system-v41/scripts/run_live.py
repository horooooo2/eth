#!/usr/bin/env python3
"""Live trading entrypoint — respects meta.live_trading_allowed."""

from __future__ import annotations

import asyncio
import os
import sys
import warnings
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.adapters.okx_adapter import OkxAdapter
from src.core.orchestrator import Orchestrator


async def main() -> None:
    load_dotenv(ROOT / ".env")
    orch = Orchestrator.from_runtime(mode="live", symbol=os.getenv("TRADE_SYMBOL", "BTC/USDT:USDT"))

    if not orch.config.get("meta", {}).get("live_trading_allowed", False):
        warnings.warn(
            "meta.live_trading_allowed=false — live orders will be blocked. "
            "Running cycle in observation mode only.",
            RuntimeWarning,
            stacklevel=1,
        )

    adapter = OkxAdapter(
        orch.config,
        mode="live",
        mock=False,
        api_key=os.getenv("OKX_API_KEY"),
        api_secret=os.getenv("OKX_API_SECRET"),
        passphrase=os.getenv("OKX_PASSPHRASE"),
    )
    orch.adapter = adapter
    orch.reconciler.adapter = adapter

    ctx = await orch.run_cycle()
    print("S6.level=", ctx.get("S6.level"))
    print("S3.regime=", ctx.get("S3.regime"))
    print("orders=", ctx.get("orders_created"))
    print("blocked=", ctx.get("order_blocked_reason"))


if __name__ == "__main__":
    asyncio.run(main())
