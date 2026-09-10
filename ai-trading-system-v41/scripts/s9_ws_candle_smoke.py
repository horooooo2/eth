"""Read-only OKX public/business WS smoke. No REST candle refresh. No orders."""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Dict, List

from src.adapters.okx_public_ws import (
    BUSINESS_WS_URL,
    PUBLIC_WS_URL,
    S9_CANDLE_CHANNELS,
    S9_PUBLIC_CHANNELS,
    OkxPublicWsClient,
)
from src.runtime.s9_market_hub import S9MarketHub

MAX_WAIT_SEC = 360


async def main() -> int:
    hub = S9MarketHub()
    closed_1m: List[int] = []
    closed_5m: List[int] = []
    counts: Dict[str, int] = {}
    wrote = {"n": 0}

    def on_public(parsed: Dict[str, Any]) -> None:
        ch = str(parsed.get("channel") or "")
        counts[ch] = counts.get(ch, 0) + 1
        hub.ingest_ws(parsed)

    def on_candle(parsed: Dict[str, Any]) -> None:
        ch = str(parsed.get("channel") or "")
        counts[ch] = counts.get(ch, 0) + 1
        before_1m = max(hub.closed_1m) if hub.closed_1m else None
        before_5m = max(hub.closed_5m) if hub.closed_5m else None
        hub.ingest_ws(parsed)
        after_1m = max(hub.closed_1m) if hub.closed_1m else None
        after_5m = max(hub.closed_5m) if hub.closed_5m else None
        if after_1m and after_1m != before_1m:
            closed_1m.append(int(after_1m))
        if after_5m and after_5m != before_5m:
            closed_5m.append(int(after_5m))

    public = OkxPublicWsClient(url=PUBLIC_WS_URL, channels=S9_PUBLIC_CHANNELS)
    candle = OkxPublicWsClient(url=BUSINESS_WS_URL, channels=S9_CANDLE_CHANNELS)
    hub.attach_client(public, role="public")
    hub.attach_client(candle, role="candle")
    public.on_message = on_public
    candle.on_message = on_candle
    public.start()
    candle.start()
    deadline = time.time() + MAX_WAIT_SEC
    try:
        while time.time() < deadline:
            if len(closed_1m) >= 2 and len(closed_5m) >= 1:
                break
            await asyncio.sleep(1)
    finally:
        await public.stop()
        await candle.stop()
    report = {
        "ok": len(closed_1m) >= 2 and len(closed_5m) >= 1,
        "rest_used": False,
        "counts": counts,
        "closed_1m": closed_1m[:4] or sorted(hub.closed_1m)[-4:],
        "closed_5m": closed_5m[:2] or sorted(hub.closed_5m)[-2:],
        "hub_closed_1m": sorted(hub.closed_1m)[-4:],
        "hub_closed_5m": sorted(hub.closed_5m)[-2:],
        "last_1m_open_at": hub.last_1m_open_at,
        "last_1m_close_at": hub.last_1m_close_at,
        "last_1m_received_at": hub.last_1m_received_at,
        "last_1m_confirmed": hub.last_1m_confirmed,
        "last_5m_open_at": hub.last_5m_open_at,
        "last_5m_close_at": hub.last_5m_close_at,
        "last_5m_received_at": hub.last_5m_received_at,
        "last_5m_confirmed": hub.last_5m_confirmed,
        "public_error": public.last_error,
        "candle_error": candle.last_error,
        "wrote_orders": wrote["n"],
    }
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
