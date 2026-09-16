"""OKX public WebSocket for candle streams."""
from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any, Callable

logger = logging.getLogger(__name__)

try:
    import websocket  # type: ignore
except ImportError:  # pragma: no cover
    websocket = None  # type: ignore


CandleCallback = Callable[[dict[str, Any]], None]


class OKXWebSocket:
    """
    Subscribe to OKX candle channel.
    Only emits closed candles (confirm == '1').
    """

    def __init__(
        self,
        *,
        inst_id: str = "BTC-USDT-SWAP",
        bar: str = "1m",
        demo: bool = False,
        on_candle: CandleCallback | None = None,
        max_reconnects: int = 10,
    ) -> None:
        self.inst_id = inst_id
        self.bar = bar
        self.demo = demo
        self.on_candle = on_candle
        self.max_reconnects = max_reconnects
        self._ws: Any = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._ping_thread: threading.Thread | None = None
        self.url = (
            "wss://wspap.okx.com:8443/ws/v5/public?brokerId=9999"
            if demo
            else "wss://ws.okx.com:8443/ws/v5/public"
        )

    def subscribe_candles(self, bar: str | None = None) -> None:
        if bar:
            self.bar = bar
        if self._ws is None:
            return
        arg = {"channel": f"candle{self.bar}", "instId": self.inst_id}
        self._ws.send(json.dumps({"op": "subscribe", "args": [arg]}))

    def start(self, *, blocking: bool = True) -> None:
        if websocket is None:
            raise RuntimeError("websocket-client is not installed")
        self._stop.clear()
        if blocking:
            self._run_forever()
        else:
            self._thread = threading.Thread(target=self._run_forever, name="okx-ws", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        try:
            if self._ws is not None:
                self._ws.close()
        except Exception:
            pass

    def _run_forever(self) -> None:
        attempt = 0
        while not self._stop.is_set() and attempt <= self.max_reconnects:
            try:
                self._connect_once()
                attempt = 0
            except Exception as exc:
                attempt += 1
                wait = min(60.0, 0.5 * (2**attempt))
                logger.warning("OKX WS disconnected (%s); reconnect %s in %.1fs", exc, attempt, wait)
                time.sleep(wait)
        if attempt > self.max_reconnects:
            logger.error("OKX WS exceeded max reconnects=%s", self.max_reconnects)

    def _connect_once(self) -> None:
        assert websocket is not None
        self._ws = websocket.WebSocketApp(
            self.url,
            on_open=self._on_open,
            on_message=self._on_message,
            on_error=self._on_error,
            on_close=self._on_close,
        )
        self._ping_thread = threading.Thread(target=self._ping_loop, name="okx-ws-ping", daemon=True)
        self._ping_thread.start()
        self._ws.run_forever(ping_interval=None)

    def _ping_loop(self) -> None:
        while not self._stop.is_set():
            time.sleep(25)
            try:
                if self._ws is not None:
                    self._ws.send("ping")
            except Exception:
                break

    def _on_open(self, _ws: Any) -> None:
        logger.info("OKX WS connected")
        self.subscribe_candles()

    def _on_error(self, _ws: Any, error: Any) -> None:
        logger.warning("OKX WS error: %s", error)

    def _on_close(self, _ws: Any, *_args: Any) -> None:
        logger.info("OKX WS closed")

    def _on_message(self, _ws: Any, message: str) -> None:
        if message == "pong":
            return
        try:
            msg = json.loads(message)
        except json.JSONDecodeError:
            return
        self._handle_message(msg)

    def _handle_message(self, msg: dict[str, Any]) -> None:
        if "event" in msg:
            return
        arg = msg.get("arg") or {}
        channel = str(arg.get("channel") or "")
        if not channel.startswith("candle"):
            return
        for row in msg.get("data") or []:
            # OKX candle: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
            if not isinstance(row, (list, tuple)) or len(row) < 9:
                continue
            if str(row[8]) != "1":
                continue
            candle = {
                "timestamp": int(row[0]),
                "open": float(row[1]),
                "high": float(row[2]),
                "low": float(row[3]),
                "close": float(row[4]),
                "volume": float(row[5]),
                "confirm": str(row[8]),
                "inst_id": arg.get("instId") or self.inst_id,
                "bar": self.bar,
            }
            if self.on_candle:
                self.on_candle(candle)
