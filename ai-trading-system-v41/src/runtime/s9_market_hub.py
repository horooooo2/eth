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
        self.data_state = "OFF"
        self.warmup_state = "WARMING_UP"
        self._last_data_event: Optional[str] = None
        self._last_conn_event: Optional[str] = None
        self._fee_ready = False

    def attach_client(self, client: OkxPublicWsClient) -> None:
        self.client = client
        client.on_message = self.ingest_ws
        client.on_state = self._on_conn

    def _emit(self, event_type: str, details: Optional[Dict[str, Any]] = None) -> None:
        if not self.on_event:
            return
        self.on_event(event_type, {"strategy_id": "S9", "symbol": self.inst_id, **(details or {})})

    def _on_conn(self, state: str) -> None:
        self.connection_state = state
        if state == CONN_CONNECTED:
            evt = "S9_MARKET_DATA_CONNECTED"
        elif state == CONN_RECONNECTING:
            evt = "S9_MARKET_DATA_DISCONNECTED"
        else:
            evt = "S9_MARKET_DATA_DISCONNECTED"
        if evt != self._last_conn_event:
            self._last_conn_event = evt
            self._emit(evt, {"connection_state": state})
        self.refresh_state()

    def ingest_ws(self, parsed: Mapping[str, Any]) -> None:
        channel = str(parsed.get("channel") or "")
        for item in parsed.get("items") or []:
            if channel.startswith("candle"):
                self.ingest_candle(channel, item)
            elif channel == "books5":
                self.ingest_book(item)
            elif channel == "trades":
                self.ingest_trade(item)
        self.refresh_state()

    def ingest_candle(self, channel: str, item: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
        ts = int(item.get("ts") or 0)
        if ts <= 0:
            return None
        closed = bool(item.get("closed"))
        store = self.closed_1m if channel == "candle1m" else self.closed_5m if channel == "candle5m" else None
        if store is None:
            return None
        if closed:
            store[ts] = dict(item)
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

    def closed_age_sec(self, store: Mapping[int, Any], now_ts: Optional[float] = None) -> Optional[float]:
        if not store:
            return None
        now = now_ts if now_ts is not None else self._now()
        latest = max(store)
        return max(0.0, now - latest / 1000.0)

    def snapshot(self, *, fee_ready: Optional[bool] = None, now_ts: Optional[float] = None) -> Dict[str, Any]:
        if fee_ready is None:
            fee_ready = self._fee_ready
        else:
            self._fee_ready = bool(fee_ready)
        now = now_ts if now_ts is not None else self._now()
        n1 = len(self.closed_1m)
        n5 = len(self.closed_5m)
        age1 = self.closed_age_sec(self.closed_1m, now)
        age5 = self.closed_age_sec(self.closed_5m, now)
        book_age = self.book_age_sec(now)
        trades_age = self.trades_age_sec(now)
        conn = self.connection_state
        if self.client is not None:
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
            evt = "S9_MARKET_DATA_DISCONNECTED"
        if evt and evt != self._last_data_event:
            self._last_data_event = evt
            self._emit(evt, {"data_state": snap["data_state"], "connection_state": snap["connection_state"]})
        return snap

    def flow_imbalance(self, now_ts: Optional[float] = None) -> Optional[float]:
        return aggressive_flow(self.recent_trades(now_ts))


def ingest_rest_books5(raw: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    data = raw.get("data")[0] if isinstance(raw.get("data"), list) and raw.get("data") else raw
    return parse_books5_payload(data if isinstance(data, dict) else {})
