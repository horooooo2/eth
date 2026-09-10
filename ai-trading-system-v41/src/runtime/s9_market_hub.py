"""S9 production market hub: public WS + REST seed, freshness, data_state.

Forming candles are cached for diagnostics only. Signal evaluation uses
closed 1m / latest closed 5m exclusively.
"""

from __future__ import annotations

import time
from collections import deque
from typing import Any, Callable, Deque, Dict, List, Mapping, Optional, Sequence

import pandas as pd

from src.adapters.okx_public_ws import (
    CANDLE_INTERVAL_MS,
    CONN_CONNECTED,
    CONN_DISCONNECTED,
    CONN_RECONNECTING,
    OkxPublicWsClient,
    S9_INST_ID,
    parse_books5_payload,
)
from src.runtime.s9_microstructure import SpreadWindow, aggressive_flow, spread_bps

CLOSED_1M_MAX_AGE = 90
CLOSED_5M_MAX_AGE = 360
BOOK_MAX_AGE = 2.0
TRADE_MAX_AGE = 3.0
TRADE_WINDOW = 15.0
WARMUP_1M = 200
WARMUP_5M = 100
SPREAD_REQUIRED = 60
REST_REASON_STARTUP = "startup_seed"
REST_REASON_GAP = "gap_recovery"
CANDLE_WS_LIVE_MAX_AGE = 90.0


def _ts_to_index(ts_ms: int) -> pd.Timestamp:
    return pd.to_datetime(int(ts_ms), unit="ms", utc=True)


def _bars_from_map(store: Dict[int, Dict[str, Any]]) -> pd.DataFrame:
    if not store:
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])
    rows = []
    for ts in sorted(store):
        row = store[ts]
        rows.append(
            {
                "ts": _ts_to_index(ts),
                "open": row["open"],
                "high": row["high"],
                "low": row["low"],
                "close": row["close"],
                "volume": row["volume"],
            }
        )
    df = pd.DataFrame(rows).set_index("ts")
    return df


class S9MarketHub:
    def __init__(
        self,
        *,
        inst_id: str = S9_INST_ID,
        client: Optional[OkxPublicWsClient] = None,
        on_event: Optional[Callable[[str, Dict[str, Any]], None]] = None,
        now_fn: Optional[Callable[[], float]] = None,
    ) -> None:
        self.inst_id = inst_id
        self.on_event = on_event
        self._now = now_fn or time.time
        self.client = client
        self.clients: List[OkxPublicWsClient] = []
        self.public_client: Optional[OkxPublicWsClient] = None
        self.candle_client: Optional[OkxPublicWsClient] = None
        self.connection_state = CONN_DISCONNECTED
        self.closed_1m: Dict[int, Dict[str, Any]] = {}
        self.closed_5m: Dict[int, Dict[str, Any]] = {}
        self.forming_1m: Optional[Dict[str, Any]] = None
        self.forming_5m: Optional[Dict[str, Any]] = None
        self.book: Optional[Dict[str, Any]] = None
        self.trades: Deque[Dict[str, Any]] = deque(maxlen=400)
        self.spread = SpreadWindow()
        self.last_closed_1m_eval_ts: Optional[int] = None
        self.last_trade_ts: Optional[int] = None
        self.last_1m_open_at: Optional[int] = None
        self.last_1m_close_at: Optional[int] = None
        self.last_1m_received_at: Optional[int] = None
        self.last_1m_confirmed: Optional[bool] = None
        self.last_5m_open_at: Optional[int] = None
        self.last_5m_close_at: Optional[int] = None
        self.last_5m_received_at: Optional[int] = None
        self.last_5m_confirmed: Optional[bool] = None
        self.last_candle_ws_received_at: Optional[float] = None
        self.last_rest_reason: Optional[str] = None
        self.last_rest_hydrate_at: Optional[float] = None
        self.rest_hydrate_count: int = 0
        self.data_state = "OFF"
        self.warmup_state = "WARMING_UP"
        self._last_data_event: Optional[str] = None
        self._last_conn_event: Optional[str] = None
        self._ever_connected = False
        self._fee_ready = False
        if client is not None:
            self.attach_client(client)

    def attach_client(self, client: OkxPublicWsClient, *, role: Optional[str] = None) -> None:
        if client not in self.clients:
            self.clients.append(client)
        if role == "public" or (role is None and "/business" not in str(getattr(client, "url", ""))):
            self.public_client = client
            if self.client is None:
                self.client = client
        if role == "candle" or (role is None and "/business" in str(getattr(client, "url", ""))):
            self.candle_client = client
        if self.client is None:
            self.client = client
        client.on_message = self.ingest_ws
        client.on_state = lambda state, c=client: self._on_conn_from(c, state)

    def _emit(self, event_type: str, details: Optional[Dict[str, Any]] = None) -> None:
        if not self.on_event:
            return
        self.on_event(event_type, {"strategy_id": "S9", "symbol": self.inst_id, **(details or {})})

    def _aggregate_conn(self) -> str:
        clients = list(self.clients)
        if not clients and self.client is not None:
            clients = [self.client]
        if not clients:
            return self.connection_state
        states = [getattr(c, "connection_state", CONN_DISCONNECTED) for c in clients]
        if all(s == CONN_CONNECTED for s in states):
            return CONN_CONNECTED
        if any(s == CONN_RECONNECTING for s in states):
            return CONN_RECONNECTING
        if any(s == CONN_CONNECTED for s in states):
            return CONN_RECONNECTING
        return CONN_DISCONNECTED

    def _on_conn(self, state: str) -> None:
        self._on_conn_from(None, state)

    def _on_conn_from(self, _client: Optional[OkxPublicWsClient], state: str) -> None:
        self.connection_state = self._aggregate_conn() if self.clients else state
        current = self.connection_state
        if current == CONN_CONNECTED:
            self._ever_connected = True
            evt = "S9_MARKET_DATA_CONNECTED"
        elif self._ever_connected:
            evt = "S9_MARKET_DATA_DISCONNECTED"
        else:
            evt = "S9_MARKET_DATA_CONNECTING"
        if evt != self._last_conn_event:
            self._last_conn_event = evt
            self._emit(evt, {"connection_state": current, "source_state": state})
        self.refresh_state()

    def ingest_ws(self, parsed: Mapping[str, Any]) -> None:
        channel = str(parsed.get("channel") or "")
        if channel.startswith("candle"):
            self.last_candle_ws_received_at = self._now()
        for item in parsed.get("items") or []:
            if channel.startswith("candle"):
                self.ingest_candle(channel, item, source="ws")
            elif channel == "books5":
                self.ingest_book(item)
            elif channel == "trades":
                self.ingest_trade(item)
        self.refresh_state()

    def _record_candle_diag(self, channel: str, item: Mapping[str, Any], *, source: str) -> None:
        ts = int(item.get("ts") or item.get("open_at") or 0)
        interval = int(CANDLE_INTERVAL_MS.get(channel) or 0)
        close_at = item.get("close_at")
        if close_at is None and ts and interval:
            close_at = ts + interval
        received_at = int(self._now() * 1000)
        confirmed = bool(item.get("closed") or item.get("confirmed"))
        if channel == "candle1m":
            self.last_1m_received_at = received_at
            if confirmed:
                self.last_1m_confirmed = True
                self.last_1m_open_at = ts or self.last_1m_open_at
                self.last_1m_close_at = int(close_at) if close_at else self.last_1m_close_at
            elif self.last_1m_confirmed is None:
                self.last_1m_confirmed = False
        elif channel == "candle5m":
            self.last_5m_received_at = received_at
            if confirmed:
                self.last_5m_confirmed = True
                self.last_5m_open_at = ts or self.last_5m_open_at
                self.last_5m_close_at = int(close_at) if close_at else self.last_5m_close_at
            elif self.last_5m_confirmed is None:
                self.last_5m_confirmed = False
        if source == "ws":
            self.last_candle_ws_received_at = self._now()

    def ingest_candle(
        self,
        channel: str,
        item: Mapping[str, Any],
        *,
        source: str = "manual",
    ) -> Optional[Dict[str, Any]]:
        ts = int(item.get("ts") or 0)
        if ts <= 0:
            return None
        closed = bool(item.get("closed") or item.get("confirmed"))
        store = self.closed_1m if channel == "candle1m" else self.closed_5m if channel == "candle5m" else None
        if store is None:
            return None
        self._record_candle_diag(channel, item, source=source)
        if closed:
            row = dict(item)
            row["closed"] = True
            row["confirm"] = str(item.get("confirm") or "1")
            interval = int(CANDLE_INTERVAL_MS.get(channel) or 0)
            row.setdefault("open_at", ts)
            if interval:
                row.setdefault("close_at", ts + interval)
            store[ts] = row
            if channel == "candle1m":
                if self.forming_1m and int(self.forming_1m.get("ts") or 0) == ts:
                    self.forming_1m = None
            elif self.forming_5m and int(self.forming_5m.get("ts") or 0) == ts:
                self.forming_5m = None
        else:
            if channel == "candle1m":
                self.forming_1m = dict(item)
            else:
                self.forming_5m = dict(item)
        return dict(item)

    def ingest_book(self, item: Mapping[str, Any]) -> None:
        parsed = item if item.get("bids") and item.get("asks") else parse_books5_payload(dict(item))
        if not parsed:
            return
        self.book = dict(parsed)
        spr = spread_bps(float(parsed["best_bid"]), float(parsed["best_ask"]))
        if spr is not None:
            ts = parsed.get("timestamp")
            ts_sec = (float(ts) / 1000.0) if ts and float(ts) > 1e12 else (float(ts) if ts else self._now())
            self.spread.observe(ts_sec, spr)

    def ingest_trade(self, item: Mapping[str, Any]) -> None:
        ts = int(item.get("timestamp") or 0)
        if ts <= 0:
            return
        self.trades.append(dict(item))
        self.last_trade_ts = ts

    def seed_closed_bars(self, timeframe: str, df: pd.DataFrame) -> None:
        if df is None or getattr(df, "empty", True):
            return
        store = self.closed_1m if timeframe in {"1m", "1min", "candle1m"} else self.closed_5m
        for idx, row in df.iterrows():
            ts = int(pd.Timestamp(idx).timestamp() * 1000)
            store[ts] = {
                "ts": ts,
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
                "volume": float(row["volume"]),
                "closed": True,
                "confirm": "1",
            }

    def closed_1m_df(self) -> pd.DataFrame:
        return _bars_from_map(self.closed_1m)

    def closed_5m_df(self) -> pd.DataFrame:
        return _bars_from_map(self.closed_5m)

    def new_closed_1m_timestamp(self) -> Optional[int]:
        if not self.closed_1m:
            return None
        latest = max(self.closed_1m)
        if latest == self.last_closed_1m_eval_ts:
            return None
        return latest

    def mark_1m_evaluated(self, ts: int) -> None:
        self.last_closed_1m_eval_ts = int(ts)

    def recent_trades(self, now_ts: Optional[float] = None) -> List[Dict[str, Any]]:
        now = now_ts if now_ts is not None else self._now()
        out = []
        for row in self.trades:
            ts = float(row.get("timestamp") or 0)
            ts_sec = ts / 1000.0 if ts > 1e12 else ts
            if now - ts_sec <= TRADE_WINDOW:
                out.append(row)
        return out

    def book_age_sec(self, now_ts: Optional[float] = None) -> Optional[float]:
        if not self.book or not self.book.get("timestamp"):
            return None
        now = now_ts if now_ts is not None else self._now()
        ts = float(self.book["timestamp"])
        ts_sec = ts / 1000.0 if ts > 1e12 else ts
        return max(0.0, now - ts_sec)

    def trades_age_sec(self, now_ts: Optional[float] = None) -> Optional[float]:
        if not self.last_trade_ts:
            return None
        now = now_ts if now_ts is not None else self._now()
        ts = float(self.last_trade_ts)
        ts_sec = ts / 1000.0 if ts > 1e12 else ts
        return max(0.0, now - ts_sec)

    def closed_age_sec(
        self,
        store: Mapping[int, Any],
        now_ts: Optional[float] = None,
        *,
        bar_seconds: float = 0.0,
    ) -> Optional[float]:
        if not store:
            return None
        now = now_ts if now_ts is not None else self._now()
        latest = max(store)
        return max(0.0, now - latest / 1000.0 - float(bar_seconds))

    def _candle_stream_live(self, now_ts: Optional[float] = None) -> bool:
        now = now_ts if now_ts is not None else self._now()
        if self.candle_client is not None:
            if self.candle_client.connection_state != CONN_CONNECTED:
                return False
            if self.last_candle_ws_received_at is None:
                return False
            return (now - float(self.last_candle_ws_received_at)) <= CANDLE_WS_LIVE_MAX_AGE
        if self.last_candle_ws_received_at is not None:
            return (now - float(self.last_candle_ws_received_at)) <= CANDLE_WS_LIVE_MAX_AGE
        age1 = self.closed_age_sec(self.closed_1m, now, bar_seconds=60)
        age5 = self.closed_age_sec(self.closed_5m, now, bar_seconds=300)
        return (
            age1 is not None
            and age1 <= CLOSED_1M_MAX_AGE
            and age5 is not None
            and age5 <= CLOSED_5M_MAX_AGE
        )

    def rest_hydrate_reason(self, now_ts: Optional[float] = None) -> Optional[str]:
        """REST is only startup seed or reconnect/gap recovery. Never a per-minute feed."""
        if not self.closed_1m or not self.closed_5m:
            return REST_REASON_STARTUP
        if self._candle_stream_live(now_ts):
            return None
        age1 = self.closed_age_sec(self.closed_1m, now_ts, bar_seconds=60)
        age5 = self.closed_age_sec(self.closed_5m, now_ts, bar_seconds=300)
        stale = (
            age1 is None
            or age1 > CLOSED_1M_MAX_AGE
            or age5 is None
            or age5 > CLOSED_5M_MAX_AGE
        )
        return REST_REASON_GAP if stale else None

    def needs_rest_seed(self, now_ts: Optional[float] = None) -> bool:
        return self.rest_hydrate_reason(now_ts) is not None

    def mark_rest_hydrate(self, reason: str) -> None:
        self.last_rest_reason = str(reason)
        self.last_rest_hydrate_at = self._now()
        self.rest_hydrate_count += 1

    def snapshot(self, *, fee_ready: Optional[bool] = None, now_ts: Optional[float] = None) -> Dict[str, Any]:
        if fee_ready is None:
            fee_ready = self._fee_ready
        else:
            self._fee_ready = bool(fee_ready)
        now = now_ts if now_ts is not None else self._now()
        n1 = len(self.closed_1m)
        n5 = len(self.closed_5m)
        age1 = self.closed_age_sec(self.closed_1m, now, bar_seconds=60)
        age5 = self.closed_age_sec(self.closed_5m, now, bar_seconds=300)
        book_age = self.book_age_sec(now)
        trades_age = self.trades_age_sec(now)
        conn = self._aggregate_conn() if self.clients else self.connection_state
        if not self.clients and self.client is not None:
            conn = self.client.connection_state
        self.connection_state = conn
        core_ok = (
            n1 > 0
            and n5 > 0
            and age1 is not None
            and age1 <= CLOSED_1M_MAX_AGE
            and age5 is not None
            and age5 <= CLOSED_5M_MAX_AGE
            and conn == CONN_CONNECTED
        )
        book_ok = book_age is not None and book_age <= BOOK_MAX_AGE and bool(self.book)
        trades_ok = trades_age is not None and trades_age <= TRADE_MAX_AGE
        spread_ok = self.spread.ready()
        warmup_ok = (
            n1 >= WARMUP_1M
            and n5 >= WARMUP_5M
            and book_ok
            and trades_ok
            and spread_ok
            and fee_ready
        )
        self.warmup_state = "READY" if warmup_ok else "WARMING_UP"
        reasons: List[str] = []
        if conn != CONN_CONNECTED or n1 <= 0 or n5 <= 0 or age1 is None or age5 is None:
            data_state = "OFF"
            if conn != CONN_CONNECTED:
                reasons.append("S9_MARKET_DATA_DISCONNECTED")
            if age1 is not None and age1 > CLOSED_1M_MAX_AGE:
                reasons.append("S9_DATA_1M_STALE")
            if age5 is not None and age5 > CLOSED_5M_MAX_AGE:
                reasons.append("S9_DATA_5M_STALE")
        elif age1 > CLOSED_1M_MAX_AGE or age5 > CLOSED_5M_MAX_AGE:
            data_state = "OFF"
            if age1 > CLOSED_1M_MAX_AGE:
                reasons.append("S9_DATA_1M_STALE")
            if age5 > CLOSED_5M_MAX_AGE:
                reasons.append("S9_DATA_5M_STALE")
        else:
            if not book_ok:
                reasons.append("S9_ORDERBOOK_STALE")
            if not trades_ok:
                reasons.append("S9_TRADES_STALE")
            if not spread_ok:
                reasons.append("SPREAD_WINDOW_WARMING_UP")
            if not fee_ready:
                reasons.append("S9_COST_DATA_UNAVAILABLE")
            if not warmup_ok:
                reasons.append("MARKET_DATA_WARMING_UP")
            if book_ok and trades_ok and spread_ok and fee_ready and warmup_ok:
                data_state = "READY"
            else:
                data_state = "DEGRADED"
        self.data_state = data_state
        return {
            "connection_state": conn,
            "data_state": data_state,
            "warmup_state": self.warmup_state,
            "closed_1m_bars": n1,
            "closed_5m_bars": n5,
            "closed_1m_age_seconds": age1,
            "closed_5m_age_seconds": age5,
            "orderbook_age_seconds": book_age,
            "trades_age_seconds": trades_age,
            "spread_samples": self.spread.count,
            "spread_ready": spread_ok,
            "fee_ready": fee_ready,
            "book": None
            if not self.book
            else {
                "timestamp": self.book.get("timestamp"),
                "best_bid": self.book.get("best_bid"),
                "best_ask": self.book.get("best_ask"),
                "bids": list(self.book.get("bids") or [])[:5],
                "asks": list(self.book.get("asks") or [])[:5],
            },
            "forming_1m": bool(self.forming_1m),
            "forming_5m": bool(self.forming_5m),
            "last_1m_open_at": self.last_1m_open_at,
            "last_1m_close_at": self.last_1m_close_at,
            "last_1m_received_at": self.last_1m_received_at,
            "last_1m_confirmed": self.last_1m_confirmed,
            "last_5m_open_at": self.last_5m_open_at,
            "last_5m_close_at": self.last_5m_close_at,
            "last_5m_received_at": self.last_5m_received_at,
            "last_5m_confirmed": self.last_5m_confirmed,
            "rest_hydrate_reason": self.last_rest_reason,
            "rest_hydrate_count": self.rest_hydrate_count,
            "candle_ws_live": self._candle_stream_live(now),
            "reasons": reasons,
            "opening_allowed": data_state == "READY",
        }

    def refresh_state(self, *, fee_ready: Optional[bool] = None) -> Dict[str, Any]:
        snap = self.snapshot(fee_ready=fee_ready)
        evt = None
        if snap["data_state"] == "READY":
            evt = "S9_MARKET_DATA_READY"
        elif snap["data_state"] == "DEGRADED":
            evt = "S9_MARKET_DATA_DEGRADED"
        elif snap["connection_state"] != CONN_CONNECTED:
            evt = "S9_MARKET_DATA_DISCONNECTED" if self._ever_connected else "S9_MARKET_DATA_CONNECTING"
        if evt and evt != self._last_data_event:
            self._last_data_event = evt
            self._emit(evt, {"data_state": snap["data_state"], "connection_state": snap["connection_state"]})
        return snap

    def flow_imbalance(self, now_ts: Optional[float] = None) -> Optional[float]:
        return aggressive_flow(self.recent_trades(now_ts))


def ingest_rest_books5(raw: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    data = raw.get("data")[0] if isinstance(raw.get("data"), list) and raw.get("data") else raw
    return parse_books5_payload(data if isinstance(data, dict) else {})
