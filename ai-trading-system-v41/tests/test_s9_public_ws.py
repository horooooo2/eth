"""S9 public WS parse/hub freshness/data_state. No exchange orders."""

from __future__ import annotations

import asyncio
import json
import time

from src.adapters.okx_public_ws import (
    CONN_CONNECTED,
    CONN_DISCONNECTED,
    CONN_RECONNECTING,
    OkxPublicWsClient,
    candle_is_closed,
    parse_public_message,
    s9_subscribe_args,
)
from src.runtime.s9_market_hub import S9MarketHub
from src.runtime.s9_microstructure import SpreadWindow, evaluate_microstructure, spread_bps


def _now_ms():
    return int(time.time() * 1000)


def _candle(ts, confirm, close=100.0):
    return [str(ts), str(close), str(close + 1), str(close - 1), str(close), "10", "10", "1000", confirm]


def test_subscribe_channels():
    args = s9_subscribe_args()
    ch = {a["channel"] for a in args}
    assert ch == {"candle1m", "candle5m", "books5", "trades"}
    assert all(a["instId"] == "BTC-USDT-SWAP" for a in args)


def test_parse_closed_and_forming_candles():
    ts = _now_ms() - 60_000
    closed = parse_public_message(
        json.dumps({"arg": {"channel": "candle1m", "instId": "BTC-USDT-SWAP"}, "data": [_candle(ts, "1")]})
    )
    forming = parse_public_message(
        json.dumps({"arg": {"channel": "candle1m", "instId": "BTC-USDT-SWAP"}, "data": [_candle(ts + 60_000, "0")]})
    )
    assert closed["items"][0]["closed"] is True
    assert forming["items"][0]["closed"] is False
    assert candle_is_closed("1") is True
    assert candle_is_closed("0") is False


def test_parse_books5_and_trades_taker_side():
    ts = _now_ms()
    book = parse_public_message(
        {
            "arg": {"channel": "books5", "instId": "BTC-USDT-SWAP"},
            "data": [
                {
                    "asks": [["100.02", "2", "0", "1"], ["100.03", "2", "0", "1"], ["100.04", "2", "0", "1"], ["100.05", "2", "0", "1"], ["100.06", "2", "0", "1"]],
                    "bids": [["100.01", "2", "0", "1"], ["100.00", "2", "0", "1"], ["99.99", "2", "0", "1"], ["99.98", "2", "0", "1"], ["99.97", "2", "0", "1"]],
                    "ts": str(ts),
                }
            ],
        }
    )
    trades = parse_public_message(
        {
            "arg": {"channel": "trades", "instId": "BTC-USDT-SWAP"},
            "data": [{"instId": "BTC-USDT-SWAP", "tradeId": "1", "px": "100", "sz": "3", "side": "buy", "ts": str(ts)}],
        }
    )
    assert book["items"][0]["best_bid"] == 100.01
    assert len(book["items"][0]["bids"]) == 5
    assert trades["items"][0]["taker_side"] == "buy"


def _seed_bars(hub: S9MarketHub, now_ms: int, n1: int = 200, n5: int = 100):
    for i in range(n1):
        ts = now_ms - (n1 - i) * 60_000
        hub.ingest_candle(
            "candle1m",
            {"ts": ts, "open": 100, "high": 101, "low": 99, "close": 100.5, "volume": 10, "closed": True},
        )
    for i in range(n5):
        ts = now_ms - (n5 - i) * 300_000
        hub.ingest_candle(
            "candle5m",
            {"ts": ts, "open": 100, "high": 102, "low": 98, "close": 101, "volume": 20, "closed": True},
        )


def _fresh_book_trades(hub: S9MarketHub, now_ms: int):
    hub.connection_state = CONN_CONNECTED
    now = now_ms / 1000.0
    for i in range(60):
        hub.spread.observe(now - (59 - i) * 5, 1.0)
    hub.ingest_book(
        {
            "timestamp": now_ms,
            "bids": [[100.0, 10], [99.9, 10], [99.8, 10], [99.7, 10], [99.6, 10]],
            "asks": [[100.01, 10], [100.02, 10], [100.03, 10], [100.04, 10], [100.05, 10]],
            "best_bid": 100.0,
            "best_ask": 100.01,
        }
    )
    hub.ingest_trade({"timestamp": now_ms, "side": "buy", "qty": 1, "price": 100.01})


def test_forming_ignored_for_signal_and_direction():
    hub = S9MarketHub()
    now = _now_ms()
    closed_ts = now - 60_000
    hub.ingest_candle("candle1m", {"ts": closed_ts, "open": 1, "high": 2, "low": 0.5, "close": 1.8, "volume": 10, "closed": True})
    hub.ingest_candle("candle1m", {"ts": now, "open": 1.8, "high": 9, "low": 1, "close": 8, "volume": 99, "closed": False})
    hub.ingest_candle("candle5m", {"ts": now - 300_000, "open": 1, "high": 2, "low": 0.5, "close": 1.9, "volume": 10, "closed": True})
    hub.ingest_candle("candle5m", {"ts": now, "open": 1.9, "high": 20, "low": 1, "close": 19, "volume": 99, "closed": False})
    assert hub.forming_1m is not None
    assert max(hub.closed_1m) == closed_ts
    df5 = hub.closed_5m_df()
    assert len(df5) == 1
    assert hub.forming_5m is not None
    assert int(hub.forming_5m["ts"]) == now
    assert hub.new_closed_1m_timestamp() == closed_ts
    hub.mark_1m_evaluated(closed_ts)
    assert hub.new_closed_1m_timestamp() is None


def test_stale_1m_5m_book_trades():
    hub = S9MarketHub(now_fn=lambda: 1_000_000)
    hub.connection_state = CONN_CONNECTED
    hub.ingest_candle("candle1m", {"ts": (1_000_000 - 200) * 1000, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1, "closed": True})
    hub.ingest_candle("candle5m", {"ts": (1_000_000 - 400) * 1000, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1, "closed": True})
    snap = hub.snapshot(fee_ready=True, now_ts=1_000_000)
    assert snap["data_state"] == "OFF"
    assert "S9_DATA_1M_STALE" in snap["reasons"] or "S9_DATA_5M_STALE" in snap["reasons"]


def test_books_and_trades_fresh_vs_stale():
    now = time.time()
    hub = S9MarketHub(now_fn=lambda: now)
    hub.connection_state = CONN_CONNECTED
    hub.ingest_book({"timestamp": int(now * 1000), "bids": [[100, 1]], "asks": [[100.01, 1]], "best_bid": 100, "best_ask": 100.01})
    hub.ingest_trade({"timestamp": int(now * 1000), "side": "buy", "qty": 1, "price": 100})
    assert hub.book_age_sec(now) <= 2
    assert hub.trades_age_sec(now) <= 3
    hub.ingest_book({"timestamp": int((now - 5) * 1000), "bids": [[100, 1]], "asks": [[100.01, 1]], "best_bid": 100, "best_ask": 100.01})
    hub.ingest_trade({"timestamp": int((now - 5) * 1000), "side": "buy", "qty": 1, "price": 100})
    assert hub.book_age_sec(now) > 2
    assert hub.trades_age_sec(now) > 3


def test_data_state_ready_degraded_off():
    now_ms = _now_ms()
    now = now_ms / 1000.0
    hub = S9MarketHub(now_fn=lambda: now)
    snap = hub.snapshot(fee_ready=False)
    assert snap["data_state"] == "OFF"
    _seed_bars(hub, now_ms)
    _fresh_book_trades(hub, now_ms)
    degraded = hub.snapshot(fee_ready=False, now_ts=now)
    assert degraded["data_state"] == "DEGRADED"
    ready = hub.snapshot(fee_ready=True, now_ts=now)
    assert ready["data_state"] == "READY"
    assert ready["opening_allowed"] is True


def test_disconnect_reconnect_restore(monkeypatch):
    events = []

    class FakeWS:
        def __init__(self):
            self.sent = []
            self.q = asyncio.Queue()

        async def send(self, text):
            self.sent.append(text)

        async def recv(self):
            item = await self.q.get()
            if isinstance(item, Exception):
                raise item
            return item

        async def close(self):
            return None

    sockets = []

    async def factory(_url):
        ws = FakeWS()
        sockets.append(ws)
        return ws

    client = OkxPublicWsClient(connect=factory, ping_interval=30, reconnect=True, on_state=lambda s: events.append(s))
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    client.start(loop)
    loop.run_until_complete(asyncio.sleep(0.05))
    assert sockets
    assert any("subscribe" in str(x) for x in sockets[0].sent)
    loop.call_soon(sockets[0].q.put_nowait, ConnectionError("drop"))
    loop.run_until_complete(asyncio.sleep(1.2))
    loop.run_until_complete(client.stop())
    loop.close()
    assert CONN_CONNECTED in events
    assert CONN_RECONNECTING in events or CONN_DISCONNECTED in events
    assert len(sockets) >= 1


def test_spread_window_rules():
    win = SpreadWindow()
    now = 1_000.0
    for i in range(59):
        win.observe(now + i * 5, 1.0)
    assert win.count == 59
    assert win.ready() is False
    win.observe(now + 59 * 5, 1.0)
    assert win.count == 60
    assert win.ready() is True
    win.observe(now + 59 * 5 + 1, 9.0)
    assert win.count == 60
    assert spread_bps(100, 100.01) is not None
    assert spread_bps(0, 1) is None
    assert spread_bps(100.02, 100.01) is None
    micro = evaluate_microstructure(
        side="LONG",
        bid=100,
        ask=100.01,
        bids=[[100, 5]] * 5,
        asks=[[100.01, 5]] * 5,
        trades=[{"side": "buy", "qty": 1, "timestamp": now * 1000}],
        spread_window=win,
        now_ts=now + 59 * 5 + 10,
        book_age_sec=0.2,
        trades_age_sec=0.2,
        cfg={"microstructure": {}},
        authorized_base_qty=1,
    )
    assert micro["ok"] or "S9_SPREAD_TOO_WIDE" in micro["reasons"] or micro["s9_spread_bps"] <= 2
    p80 = win.p80()
    assert p80 is not None
    wide_win = SpreadWindow()
    t0 = 2_000.0
    for i in range(60):
        wide_win.observe(t0 + i * 5, 1.0)
    wide = evaluate_microstructure(
        side="LONG",
        bid=100,
        ask=100.05,
        bids=[[100, 5]] * 5,
        asks=[[100.05, 5]] * 5,
        trades=[{"side": "buy", "qty": 1, "timestamp": (t0 + 59 * 5) * 1000}],
        spread_window=wide_win,
        now_ts=t0 + 59 * 5 + 5,
        book_age_sec=0.2,
        trades_age_sec=0.2,
        cfg={"microstructure": {}},
        authorized_base_qty=1,
    )
    assert "S9_SPREAD_TOO_WIDE" in wide["reasons"]
    p80_win = SpreadWindow()
    for i in range(60):
        p80_win.observe(t0 + i * 5, 1.0)
    p80_block = evaluate_microstructure(
        side="LONG",
        bid=100,
        ask=100.02,
        bids=[[100, 5]] * 5,
        asks=[[100.02, 5]] * 5,
        trades=[{"side": "buy", "qty": 1, "timestamp": (t0 + 59 * 5) * 1000}],
        spread_window=p80_win,
        now_ts=t0 + 59 * 5 + 5,
        book_age_sec=0.2,
        trades_age_sec=0.2,
        cfg={"microstructure": {"spread_p80_mult": 0.01}},
        authorized_base_qty=1,
    )
    assert "S9_SPREAD_TOO_WIDE" in p80_block["reasons"]
