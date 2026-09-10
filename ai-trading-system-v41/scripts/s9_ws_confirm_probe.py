"""Read-only: dump candle confirm semantics from OKX business WS. No orders."""

from __future__ import annotations

import asyncio
import json
import time
from collections import Counter

from src.adapters.okx_public_ws import BUSINESS_WS_URL, S9_CANDLE_CHANNELS, OkxPublicWsClient


async def main(seconds: float = 80.0) -> None:
    confirms: Counter[str] = Counter()
    channels: Counter[str] = Counter()
    samples = []
    events = []

    def on_message(parsed):
        ch = str(parsed.get("channel") or "")
        channels[ch] += 1
        for item in parsed.get("items") or []:
            key = f"{item.get('confirm')}|closed={item.get('closed')}"
            confirms[key] += 1
            if len(samples) < 6 or (item.get("closed") and len(samples) < 12):
                samples.append(
                    {
                        "ch": ch,
                        "ts": item.get("ts"),
                        "confirm": item.get("confirm"),
                        "closed": item.get("closed"),
                        "open_at": item.get("open_at"),
                        "close_at": item.get("close_at"),
                    }
                )

    def on_event(parsed):
        events.append(
            {
                "event": parsed.get("event"),
                "channel": parsed.get("channel"),
                "code": parsed.get("code"),
                "msg": parsed.get("msg"),
            }
        )

    raws = []
    client = OkxPublicWsClient(
        url=BUSINESS_WS_URL,
        channels=S9_CANDLE_CHANNELS,
        on_message=on_message,
        on_event=on_event,
        reconnect=False,
    )
    orig = client.handle_raw

    def handle_raw(raw):
        text = raw.decode("utf-8", errors="replace") if isinstance(raw, (bytes, bytearray)) else str(raw)
        try:
            payload = json.loads(text) if text and text[:1] in "{[" else {}
        except Exception:
            payload = {}
        arg = payload.get("arg") or {}
        data = payload.get("data")
        if payload.get("event") or (isinstance(data, list) and data and len(raws) < 10):
            row = data[0] if isinstance(data, list) and data else None
            raws.append(
                {
                    "event": payload.get("event"),
                    "channel": arg.get("channel"),
                    "row_type": type(row).__name__ if row is not None else None,
                    "row_len": len(row) if isinstance(row, list) else None,
                    "confirm_idx8": row[8] if isinstance(row, list) and len(row) > 8 else None,
                    "ts": row[0] if isinstance(row, list) and row else (row.get("ts") if isinstance(row, dict) else None),
                }
            )
        return orig(raw)

    client.handle_raw = handle_raw
    client.start()
    await asyncio.sleep(seconds)
    await client.stop()
    print(
        json.dumps(
            {
                "events": events[:8],
                "channels": dict(channels),
                "confirms": dict(confirms),
                "samples": samples,
                "raws": raws[:10],
                "last_error": client.last_error,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
