"""OKX V5 public + business WebSocket client.

Contract (OKX V5 market data):
- books5 / trades: wss://ws.okx.com:8443/ws/v5/public
- candle1m / candle5m: wss://ws.okx.com:8443/ws/v5/business
  (candles left /public on 20 June 2023)
- Candle array: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
  ts = bar open time (ms)
  confirm "0" = forming, "1" = closed
  close time = open + interval
- books5 level: [price, size, deprecated, orderCount]; SWAP size is contracts
- trades.side is the taker side: "buy" | "sell"
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Any, Awaitable, Callable, Dict, Iterable, List, Mapping, Optional, Sequence

from src.runtime.s9_capabilities import register_capability

PUBLIC_WS_URL = "wss://ws.okx.com:8443/ws/v5/public"
BUSINESS_WS_URL = "wss://ws.okx.com:8443/ws/v5/business"
S9_INST_ID = "BTC-USDT-SWAP"
S9_PUBLIC_CHANNELS = ("books5", "trades")
S9_CANDLE_CHANNELS = ("candle1m", "candle5m")
S9_ALL_CHANNELS = S9_CANDLE_CHANNELS + S9_PUBLIC_CHANNELS
CANDLE_INTERVAL_MS = {"candle1m": 60_000, "candle5m": 300_000}
CONN_CONNECTED = "CONNECTED"
CONN_RECONNECTING = "RECONNECTING"
CONN_DISCONNECTED = "DISCONNECTED"

logger = logging.getLogger(__name__)
_CHANNEL_IN_MSG = re.compile(r"channel:([A-Za-z0-9_-]+)")

register_capability(
    "public_ws_capability",
    ready=(
        "business" in BUSINESS_WS_URL
        and set(S9_CANDLE_CHANNELS) >= {"candle1m", "candle5m"}
        and set(S9_PUBLIC_CHANNELS) >= {"books5", "trades"}
    ),
    source="okx_public_ws.public+business",
)


def s9_subscribe_args(
    inst_id: str = S9_INST_ID,
    channels: Optional[Sequence[str]] = None,
) -> List[Dict[str, str]]:
    inst = str(inst_id or S9_INST_ID).strip() or S9_INST_ID
    chans = tuple(channels) if channels else S9_ALL_CHANNELS
    return [{"channel": ch, "instId": inst} for ch in chans]


def default_channels_for_url(url: str) -> Sequence[str]:
    if "/business" in str(url or ""):
        return S9_CANDLE_CHANNELS
    return S9_PUBLIC_CHANNELS


def parse_ts_ms(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if n > 1e12:
        return int(n)
    if n > 1e9:
        return int(n * 1000.0)
    return None


def candle_is_closed(confirm: Any) -> bool:
    return str(confirm).strip() in {"1", "true", "True"}


def parse_candle_row(row: Any, *, channel: str = "") -> Optional[Dict[str, Any]]:
    confirm: Any = "0"
    if isinstance(row, dict):
        ts = parse_ts_ms(row.get("ts") or row.get("timestamp") or row.get("open_at"))
        try:
            o = float(row.get("o") if row.get("o") is not None else row.get("open"))
            h = float(row.get("h") if row.get("h") is not None else row.get("high"))
            l = float(row.get("l") if row.get("l") is not None else row.get("low"))
            c = float(row.get("c") if row.get("c") is not None else row.get("close"))
            vol = float(row.get("vol") if row.get("vol") is not None else row.get("volume") or 0)
        except (TypeError, ValueError):
            return None
        confirm = row.get("confirm") if row.get("confirm") is not None else row.get("closed")
        extra_vol = row.get("volCcy")
        extra_quote = row.get("volCcyQuote")
    elif isinstance(row, (list, tuple)) and len(row) >= 6:
        ts = parse_ts_ms(row[0])
        try:
            o, h, l, c = float(row[1]), float(row[2]), float(row[3]), float(row[4])
            vol = float(row[5])
        except (TypeError, ValueError):
            return None
        confirm = row[8] if len(row) > 8 else "0"
        extra_vol = row[6] if len(row) > 6 else None
        extra_quote = row[7] if len(row) > 7 else None
    else:
        return None
    if ts is None:
        return None
    interval = CANDLE_INTERVAL_MS.get(str(channel) or "", 0)
    closed = candle_is_closed(confirm)
    return {
        "ts": ts,
        "open": o,
        "high": h,
        "low": l,
        "close": c,
        "volume": vol,
        "volCcy": extra_vol,
        "volCcyQuote": extra_quote,
        "confirm": str(confirm),
        "closed": closed,
        "confirmed": closed,
        "open_at": ts,
        "close_at": ts + interval if interval else None,
        "interval": channel or None,
    }


def parse_book_levels(levels: Any) -> List[List[float]]:
    out: List[List[float]] = []
    for level in list(levels or [])[:5]:
        if not isinstance(level, (list, tuple)) or len(level) < 2:
            continue
        try:
            px = float(level[0])
            sz = float(level[1])
        except (TypeError, ValueError):
            continue
        if px <= 0 or sz < 0:
            continue
        out.append([px, sz])
    return out


def parse_books5_payload(data: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    if not isinstance(data, dict):
        return None
    ts = parse_ts_ms(data.get("ts") or data.get("timestamp"))
    bids = parse_book_levels(data.get("bids"))
    asks = parse_book_levels(data.get("asks"))
    if not bids or not asks:
        return None
    return {
        "timestamp": ts,
        "bids": bids,
        "asks": asks,
        "best_bid": bids[0][0],
        "best_ask": asks[0][0],
        "instId": data.get("instId") or S9_INST_ID,
    }


def parse_trade_payload(row: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    if not isinstance(row, dict):
        return None
    side = str(row.get("side") or "").strip().lower()
    if side not in {"buy", "sell"}:
        return None
    try:
        px = float(row.get("px") or row.get("price") or 0)
        sz = float(row.get("sz") or row.get("size") or row.get("qty") or 0)
    except (TypeError, ValueError):
        return None
    ts = parse_ts_ms(row.get("ts") or row.get("timestamp"))
    if px <= 0 or sz <= 0 or ts is None:
        return None
    return {
        "id": row.get("tradeId") or row.get("id"),
        "timestamp": ts,
        "side": side,
        "taker_side": side,
        "price": px,
        "qty": sz,
        "sz": sz,
        "instId": row.get("instId") or S9_INST_ID,
    }


def parse_public_message(raw: Any) -> Optional[Dict[str, Any]]:
    """Parse one OKX public WS text/json frame. Returns None for ping/pong/empty."""
    if raw is None:
        return None
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", errors="replace")
    if isinstance(raw, str):
        text = raw.strip()
        if not text or text in {"ping", "pong"}:
            return {"type": text or "empty"}
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            return None
    elif isinstance(raw, dict):
        payload = raw
    else:
        return None
    if not isinstance(payload, dict):
        return None
    if payload.get("event") in {"subscribe", "unsubscribe", "error", "channel-connCount"}:
        arg = payload.get("arg") or {}
        channel = str((arg or {}).get("channel") or "")
        if not channel:
            match = _CHANNEL_IN_MSG.search(str(payload.get("msg") or ""))
            channel = match.group(1) if match else ""
        return {
            "type": "event",
            "event": payload.get("event"),
            "arg": arg,
            "channel": channel or None,
            "code": payload.get("code"),
            "msg": payload.get("msg"),
        }
    arg = payload.get("arg") or {}
    channel = str((arg or {}).get("channel") or "")
    inst = str((arg or {}).get("instId") or "")
    rows = payload.get("data")
    if not isinstance(rows, list) or not rows:
        return {"type": "data", "channel": channel, "instId": inst, "items": []}
    items: List[Dict[str, Any]] = []
    if channel.startswith("candle"):
        for row in rows:
            parsed = parse_candle_row(row, channel=channel)
            if parsed:
                parsed["channel"] = channel
                parsed["instId"] = inst
                items.append(parsed)
    elif channel == "books5":
        for row in rows:
            parsed = parse_books5_payload(row) if isinstance(row, dict) else None
            if parsed:
                parsed["channel"] = channel
                parsed["instId"] = parsed.get("instId") or inst
                items.append(parsed)
    elif channel == "trades":
        for row in rows:
            parsed = parse_trade_payload(row) if isinstance(row, dict) else None
            if parsed:
                parsed["channel"] = channel
                parsed["instId"] = parsed.get("instId") or inst
                items.append(parsed)
    return {"type": "data", "channel": channel, "instId": inst, "items": items, "arg": arg}


class OkxPublicWsClient:
    """Production public WS. Connection state is independent of socket object identity."""

    def __init__(
        self,
        *,
        url: str = PUBLIC_WS_URL,
        inst_id: str = S9_INST_ID,
        channels: Optional[Sequence[str]] = None,
        reconnect: bool = True,
        ping_interval: float = 20.0,
        connect: Optional[Callable[..., Awaitable[Any]]] = None,
        on_message: Optional[Callable[[Dict[str, Any]], None]] = None,
        on_event: Optional[Callable[[Dict[str, Any]], None]] = None,
        on_state: Optional[Callable[[str], None]] = None,
    ) -> None:
        self.url = url
        self.inst_id = inst_id
        self.channels = tuple(channels) if channels else tuple(default_channels_for_url(url))
        self.reconnect = reconnect
        self.ping_interval = float(ping_interval)
        self._connect_factory = connect
        self.on_message = on_message
        self.on_event = on_event
        self.on_state = on_state
        self.connection_state = CONN_DISCONNECTED
        self.subscribed: List[Dict[str, str]] = []
        self.last_error: Optional[str] = None
        self._stop = asyncio.Event()
        self._task: Optional[asyncio.Task] = None
        self._ws: Any = None
        self._attempt = 0

    def _set_state(self, state: str) -> None:
        if self.connection_state == state:
            return
        self.connection_state = state
        if self.on_state:
            self.on_state(state)

    async def _open(self) -> Any:
        if self._connect_factory is not None:
            return await self._connect_factory(self.url)
        import websockets  # type: ignore

        return await websockets.connect(self.url, ping_interval=None)

    async def _send(self, ws: Any, payload: Any) -> None:
        text = payload if isinstance(payload, str) else json.dumps(payload)
        send = getattr(ws, "send", None)
        if send is None:
            raise RuntimeError("websocket missing send")
        await send(text)

    async def _subscribe(self, ws: Any) -> None:
        args = s9_subscribe_args(self.inst_id, self.channels)
        await self._send(ws, {"op": "subscribe", "args": args})
        self.subscribed = list(args)

    def handle_raw(self, raw: Any) -> Optional[Dict[str, Any]]:
        parsed = parse_public_message(raw)
        if parsed is None:
            return None
        if parsed.get("type") == "event":
            if parsed.get("event") == "error":
                self.last_error = str(parsed.get("msg") or parsed.get("code") or "subscribe error")
                logger.warning(
                    "OKX WS event error url=%s channel=%s code=%s",
                    self.url,
                    parsed.get("channel"),
                    parsed.get("code"),
                )
            if self.on_event:
                self.on_event(parsed)
        if parsed.get("type") == "data" and self.on_message:
            self.on_message(parsed)
        return parsed

    async def _run_socket(self) -> None:
        ws = await self._open()
        self._ws = ws
        self._attempt = 0
        self._set_state(CONN_CONNECTED)
        await self._subscribe(ws)
        last_ping = time.monotonic()
        try:
            while not self._stop.is_set():
                timeout = max(0.1, self.ping_interval - (time.monotonic() - last_ping))
                recv = getattr(ws, "recv", None)
                if recv is None:
                    raise RuntimeError("websocket missing recv")
                try:
                    raw = await asyncio.wait_for(recv(), timeout=timeout)
                except asyncio.TimeoutError:
                    await self._send(ws, "ping")
                    last_ping = time.monotonic()
                    continue
                if raw in ("pong", b"pong"):
                    continue
                if raw in ("ping", b"ping"):
                    await self._send(ws, "pong")
                    continue
                self.handle_raw(raw)
                if time.monotonic() - last_ping >= self.ping_interval:
                    await self._send(ws, "ping")
                    last_ping = time.monotonic()
        finally:
            closer = getattr(ws, "close", None)
            if closer:
                try:
                    await closer()
                except Exception:
                    pass
            self._ws = None

    async def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                await self._run_socket()
                if self._stop.is_set() or not self.reconnect:
                    self._set_state(CONN_DISCONNECTED)
                    return
                self.last_error = "socket closed"
                self._set_state(CONN_RECONNECTING)
            except asyncio.CancelledError:
                self._set_state(CONN_DISCONNECTED)
                raise
            except Exception as exc:  # noqa: BLE001
                self.last_error = str(exc)
                logger.warning("OKX public WS error: %s", exc)
                if self._stop.is_set() or not self.reconnect:
                    self._set_state(CONN_DISCONNECTED)
                    return
                self._set_state(CONN_RECONNECTING)
            delay = min(30.0, 1.0 * (2 ** min(self._attempt, 4)))
            self._attempt += 1
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=delay)
            except asyncio.TimeoutError:
                continue

    def start(self, loop: Optional[asyncio.AbstractEventLoop] = None) -> None:
        if self._task and not self._task.done():
            return
        self._stop = asyncio.Event()
        runner = loop
        if runner is None:
            try:
                runner = asyncio.get_running_loop()
            except RuntimeError:
                runner = asyncio.get_event_loop()
        role = "business" if "/business" in str(self.url) else "public"
        self._task = runner.create_task(self._loop(), name=f"okx-{role}-ws")

    async def stop(self) -> None:
        self.reconnect = False
        self._stop.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        self._set_state(CONN_DISCONNECTED)


def channels_from_args(args: Iterable[Mapping[str, Any]]) -> List[str]:
    return [str(a.get("channel")) for a in args if isinstance(a, dict)]
