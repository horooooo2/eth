"""Read-only OKX public WS probe. No orders. Prints channel counts only."""

from __future__ import annotations

import asyncio
import json
import time
from collections import Counter

from src.adapters.okx_public_ws import OkxPublicWsClient, parse_public_message


async def main(seconds: float = 25.0) -> None:
    counts: Counter[str] = Counter()
    samples: dict[str, dict] = {}
    events = []

    def on_message(parsed):
        ch = str(parsed.get("channel") or parsed.get("type") or "?")
        counts[ch] += 1
        items = parsed.get("items") or []
        if items and ch not in samples:
            row = dict(items[0])
            samples[ch] = {
                "ts": row.get("ts") or row.get("timestamp"),
                "closed": row.get("closed"),
                "confirm": row.get("confirm"),
                "keys": sorted(row.keys()),
            }

    def on_state(state):
        events.append(state)

    client = OkxPublicWsClient(on_message=on_message, on_state=on_state, reconnect=False)
    raws = []

    orig_handle = client.handle_raw

    def handle_raw(raw):
        text = raw.decode("utf-8", errors="replace") if isinstance(raw, (bytes, bytearray)) else str(raw)
        try:
            payload = json.loads(text) if text and text[0] in "{[" else {}
        except Exception:
            payload = {}
        ev = payload.get("event")
        arg = payload.get("arg") or {}
        if ev:
            events.append({"event": ev, "channel": arg.get("channel"), "code": payload.get("code"), "msg": payload.get("msg")})
            counts[f"event:{ev}:{arg.get('channel') or ''}"] += 1
        if ev == "error" or (arg.get("channel") or "").startswith("candle"):
            if len(raws) < 8:
                raws.append({"event": ev, "channel": arg.get("channel"), "has_data": bool(payload.get("data")), "data_type": type((payload.get("data") or [None])[0]).__name__ if payload.get("data") else None})
        return orig_handle(raw)

    client.handle_raw = handle_raw
    client.start()
    await asyncio.sleep(seconds)
    await client.stop()
    print("STATE", events[:12], "counts", dict(counts), "samples", samples, "raws", raws)


if __name__ == "__main__":
    asyncio.run(main())
