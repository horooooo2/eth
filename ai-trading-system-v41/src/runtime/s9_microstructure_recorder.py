"""Read-only S9 microstructure research recorder. Never emits intents or orders."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import pandas as pd

from src.adapters.okx_public_ws import S9_INST_ID
from src.runtime.s9_microstructure import aggressive_flow, depth_imbalance_5, spread_bps
from src.strategies.s9_momentum import (
    STRONG_BEARISH,
    STRONG_BULLISH,
    atr,
    breakout_hit,
    breakout_level,
    find_micro_swing,
    volume_ratio,
)

CT_VAL = 0.01
HORIZONS = (5, 10, 15, 30)


def _f(value: Any, default: Optional[float] = None) -> Optional[float]:
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _roc_bps(close: pd.Series, n: int) -> Optional[float]:
    if close is None or len(close) <= n:
        return None
    prev = float(close.iloc[-1 - n])
    last = float(close.iloc[-1])
    if prev == 0:
        return None
    return (last - prev) / prev * 10_000.0


def _flat(orch: Any) -> bool:
    ctx = getattr(orch, "context", None) or {}
    net = abs(_f(ctx.get("exchange_net_position_contracts"), 0.0) or 0.0)
    if net > 1e-12:
        return False
    owned = 0.0
    for pos in ctx.get("owned_open_positions") or []:
        if str((pos or {}).get("origin_strategy_id") or "").upper() != "S9":
            if abs(_f((pos or {}).get("quantity"), 0.0) or 0.0) > 1e-12:
                return False
            continue
        owned += abs(_f((pos or {}).get("quantity"), 0.0) or 0.0)
    return owned <= 1e-12


def _level_notional(levels: Any, *, ct_val: float = CT_VAL) -> Optional[float]:
    total = 0.0
    n = 0
    for level in list(levels or [])[:5]:
        if not level or len(level) < 2:
            continue
        px = _f(level[0])
        sz = _f(level[1])
        if px is None or sz is None or px <= 0:
            continue
        total += px * sz * float(ct_val)
        n += 1
    return None if n == 0 else total


def _trade_notional(trades: List[Dict[str, Any]], side: str, *, ct_val: float = CT_VAL) -> float:
    total = 0.0
    for row in trades:
        if str(row.get("side") or row.get("taker_side") or "").lower() not in {side, side[:1]}:
            continue
        px = _f(row.get("price") or row.get("px"))
        sz = _f(row.get("qty") or row.get("sz") or row.get("size"))
        if px and sz:
            total += px * sz * float(ct_val)
    return total


def _ws_state(client: Any, fallback: Optional[str] = None) -> Optional[str]:
    if client is None:
        return fallback
    return str(getattr(client, "connection_state", None) or fallback or "")


def _snapshot_micro(hub: Any) -> Dict[str, Any]:
    if hub is None:
        return {
            "spread_bps": None,
            "top5_bid_notional": None,
            "top5_ask_notional": None,
            "depth_imbalance": None,
            "aggressive_buy_notional": None,
            "aggressive_sell_notional": None,
            "flow_imbalance": None,
            "books_age": None,
            "trades_age": None,
            "public_ws_state": None,
            "business_ws_state": None,
        }
    now = hub._now() if callable(getattr(hub, "_now", None)) else None
    book = dict(getattr(hub, "book", None) or {})
    bids = list(book.get("bids") or [])
    asks = list(book.get("asks") or [])
    bid = _f(book.get("best_bid"))
    ask = _f(book.get("best_ask"))
    trades = hub.recent_trades(now) if hasattr(hub, "recent_trades") else []
    return {
        "spread_bps": None if bid is None or ask is None else spread_bps(bid, ask),
        "top5_bid_notional": _level_notional(bids),
        "top5_ask_notional": _level_notional(asks),
        "depth_imbalance": depth_imbalance_5(bids, asks) if bids and asks else None,
        "aggressive_buy_notional": _trade_notional(trades, "buy"),
        "aggressive_sell_notional": _trade_notional(trades, "sell"),
        "flow_imbalance": aggressive_flow(trades) if trades else None,
        "books_age": hub.book_age_sec(now) if hasattr(hub, "book_age_sec") else None,
        "trades_age": hub.trades_age_sec(now) if hasattr(hub, "trades_age_sec") else None,
        "public_ws_state": _ws_state(getattr(hub, "public_client", None), getattr(hub, "connection_state", None)),
        "business_ws_state": _ws_state(getattr(hub, "candle_client", None)),
    }


def _forward(one: pd.DataFrame, ts: pd.Timestamp, *, side: str, close: float) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    if close <= 0 or ts not in one.index:
        return out
    pos = one.index.get_loc(ts)
    if isinstance(pos, slice):
        pos = pos.start
    pos = int(pos)
    for h in HORIZONS:
        end = min(pos + h, len(one) - 1)
        if end <= pos:
            continue
        window = one.iloc[pos + 1 : end + 1]
        if window.empty:
            continue
        last_c = float(window["close"].iloc[-1])
        hi = float(window["high"].max())
        lo = float(window["low"].min())
        if side == "LONG":
            fwd = (last_c - close) / close
            mfe = (hi - close) / close
            mae = (close - lo) / close
        else:
            fwd = (close - last_c) / close
            mfe = (close - lo) / close
            mae = (hi - close) / close
        key = str(h)
        out[f"{key}m_directional_return"] = fwd * 10_000.0
        out[f"{key}m_mfe"] = mfe * 10_000.0
        out[f"{key}m_mae"] = mae * 10_000.0
        out[f"{key}m_bars"] = int(len(window))
    return out


def maybe_record(orch: Any) -> bool:
    store = getattr(orch, "engine_store", None)
    if store is None or not _flat(orch):
        return False
    one = getattr(orch, "s9_closed_1m", None)
    if one is None or getattr(one, "empty", True) or len(one) < 21:
        return False
    ctx = getattr(orch, "context", None) or {}
    diag = dict((ctx.get("s9") or {}).get("diagnostics") or {})
    state = str(diag.get("s9_direction_state") or "")
    if state not in {STRONG_BULLISH, STRONG_BEARISH}:
        return False
    side = "LONG" if state == STRONG_BULLISH else "SHORT"
    last = one.iloc[-1]
    close = float(last["close"])
    high = float(last["high"])
    low = float(last["low"])
    open_ = float(last["open"])
    rng = high - low
    level = breakout_level(one, side=side, lookback=20)
    if level is not None and breakout_hit(close, level, side=side, buffer_bps=0.0):
        return False
    body = abs(close - open_) / rng if rng > 0 else None
    loc = ((close - low) / rng if side == "LONG" else (high - close) / rng) if rng > 0 else None
    atr14 = float(atr(one, 14).iloc[-1]) if len(one) >= 15 else 0.0
    atr_bps = atr14 / close * 10_000.0 if close else None
    swing = find_micro_swing(one, side=side, lookback=10)
    dist_bps = None
    dist_atr = None
    if swing and close > 0:
        stop = float(swing["price"])
        dist = (close - stop) if side == "LONG" else (stop - close)
        dist_bps = dist / close * 10_000.0
        dist_atr = dist / atr14 if atr14 > 0 else None
    if level is None or close <= 0:
        dist_bo = None
    elif side == "SHORT":
        dist_bo = (close - float(level)) / close * 10_000.0
    else:
        dist_bo = (float(level) - close) / close * 10_000.0
    ts = str(one.index[-1])
    payload = {
        "timestamp": ts,
        "symbol": S9_INST_ID,
        "direction_state": state,
        "direction_score": diag.get("s9_direction_score"),
        "ADX": diag.get("s9_adx14") or diag.get("adx14"),
        "close": close,
        "EMA9": diag.get("ema9"),
        "EMA21": diag.get("ema21"),
        "ROC1": _roc_bps(one["close"].astype(float), 1),
        "ROC3": _roc_bps(one["close"].astype(float), 3),
        "ROC5": _roc_bps(one["close"].astype(float), 5),
        "ATR": atr14,
        "ATR_bps": atr_bps,
        "previous20_breakout_level": level,
        "distance_to_breakout_bps": dist_bo,
        "volume_ratio": volume_ratio(one, 20),
        "body_ratio": body,
        "close_location": loc,
        "structure_found": bool(swing),
        "structure_distance_bps": dist_bps,
        "structure_distance_atr": dist_atr,
        "research_only": True,
        **_snapshot_micro(getattr(orch, "s9_hub", None)),
    }
    return bool(
        store.insert_s9_microstructure_research(
            strategy_id="S9",
            symbol=str(payload["symbol"]),
            closed_1m_timestamp=ts,
            direction=side,
            recorded_at=_now_iso(),
            payload=payload,
        )
    )


def backfill_outcomes(orch: Any) -> int:
    store = getattr(orch, "engine_store", None)
    one = getattr(orch, "s9_closed_1m", None)
    if store is None or one is None or getattr(one, "empty", True):
        return 0
    updated = 0
    for row in store.list_s9_microstructure_research(pending_outcome=False, limit=2000):
        outcome = dict(row.get("outcome") or {})
        if all(outcome.get(f"{h}m_directional_return") is not None for h in HORIZONS):
            continue
        ts = pd.Timestamp(row["closed_1m_timestamp"])
        if ts.tzinfo is None:
            ts = ts.tz_localize("UTC")
        if ts not in one.index:
            continue
        close = _f((row.get("payload") or {}).get("close"))
        if close is None:
            close = float(one.loc[ts, "close"])
        side = str(row.get("direction") or "LONG")
        filled = _forward(one, ts, side=side, close=float(close))
        if not filled:
            continue
        merged = {**outcome, **filled}
        store.update_s9_microstructure_outcome(int(row["id"]), merged, _now_iso())
        updated += 1
    return updated


def research_tick(orch: Any, *, skipped: bool) -> None:
    """Safe hook. Swallows errors. Does not change strategy decision."""
    try:
        if not skipped:
            maybe_record(orch)
        backfill_outcomes(orch)
    except Exception:
        return
