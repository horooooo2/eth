"""OKX V5 public WebSocket client.

Contract (OKX V5 public market data):
- URL: wss://ws.okx.com:8443/ws/v5/public
- Channels: candle1m, candle5m, books5, trades
- Candle array: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
  confirm "0" = forming, "1" = closed
- books5 level: [price, size, deprecated, orderCount]; SWAP size is contracts
- trades.side is the taker side: "buy" | "sell"
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Awaitable, Callable, Dict, Iterable, List, Mapping, Optional, Sequence

PUBLIC_WS_URL = "wss://ws.okx.com:8443/ws/v5/public"
S9_INST_ID = "BTC-USDT-SWAP"
S9_PUBLIC_CHANNELS = ("candle1m", "candle5m", "books5", "trades")
CONN_CONNECTED = "CONNECTED"
CONN_RECONNECTING = "RECONNECTING"
CONN_DISCONNECTED = "DISCONNECTED"

logger = logging.getLogger(__name__)


def s9_subscribe_args(inst_id: str = S9_INST_ID) -> List[Dict[str, str]]:
    inst = str(inst_id or S9_INST_ID).strip() or S9_INST_ID
    return [{"channel": ch, "instId": inst} for ch in S9_PUBLIC_CHANNELS]


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


def parse_candle_row(row: Sequence[Any]) -> Optional[Dict[str, Any]]:
    if not isinstance(row, (list, tuple)) or len(row) < 6:
        return None
    ts = parse_ts_ms(row[0])
    if ts is None:
        return None
    try:
        o, h, l, c = float(row[1]), float(row[2]), float(row[3]), float(row[4])
        vol = float(row[5])
    except (TypeError, ValueError):
        return None
    confirm = row[8] if len(row) > 8 else "0"
    return {
        "ts": ts,
        "open": o,
        "high": h,
        "low": l,
        "close": c,
        "volume": vol,
        "volCcy": row[6] if len(row) > 6 else None,
        "volCcyQuote": row[7] if len(row) > 7 else None,
        "confirm": str(confirm),
        "closed": candle_is_closed(confirm),
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
        return {"type": "event", "event": payload.get("event"), "arg": payload.get("arg"), "code": payload.get("code"), "msg": payload.get("msg")}
    arg = payload.get("arg") or {}
    channel = str((arg or {}).get("channel") or "")
    inst = str((arg or {}).get("instId") or "")
    rows = payload.get("data")
    if not isinstance(rows, list) or not rows:
        return {"type": "data", "channel": channel, "instId": inst, "items": []}
    items: List[Dict[str, Any]] = []
    if channel.startswith("candle"):
        for row in rows:
            parsed = parse_candle_row(row) if isinstance(row, (list, tuple)) else None
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
        reconnect: bool = True,
        ping_interval: float = 20.0,
        connect: Optional[Callable[..., Awaitable[Any]]] = None,
        on_message: Optional[Callable[[Dict[str, Any]], None]] = None,
        on_state: Optional[Callable[[str], None]] = None,
    ) -> None:
        self.url = url
        self.inst_id = inst_id
        self.reconnect = reconnect
        self.ping_interval = float(ping_interval)
        self._connect_factory = connect
        self.on_message = on_message
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
        args = s9_subscribe_args(self.inst_id)
        await self._send(ws, {"op": "subscribe", "args": args})
        self.subscribed = list(args)

    def handle_raw(self, raw: Any) -> Optional[Dict[str, Any]]:
        parsed = parse_public_message(raw)
        if parsed is None:
            return None
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
        runner = loop or asyncio.get_event_loop()
        self._task = runner.create_task(self._loop(), name="okx-public-ws")

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
