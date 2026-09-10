"""Demo Execute V1 helpers: S1 BTC sizing, signal_key, strategy allowlist.

S1 STRUCTURE INVALIDATION V1: CONFIRMED_SWING_2X2 on closed OKX 1h candles.
Forming candles never confirm a swing. No ATR/EMA/HHV-LLV fallback.
"""

from __future__ import annotations

import hashlib
from typing import Any, Dict, List, Mapping, Optional, Sequence

DEMO_EXECUTE_V1_ALLOWED = {
    "S1": True,
    "S2": False,
    "S8": False,
}

V1_SYMBOL = "BTC-USDT-SWAP"
NONTERMINAL = {
    "CREATED",
    "PENDING_GATEWAY",
    "SUBMITTED",
    "PARTIALLY_FILLED",
    "PARTIAL",
    "CANCEL_REQUESTED",
}


def demo_execute_v1_allowed(strategy_id: Optional[str]) -> bool:
    sid = str(strategy_id or "").strip().upper()
    return bool(DEMO_EXECUTE_V1_ALLOWED.get(sid))


def normalize_swap_symbol(symbol: str) -> str:
    s = str(symbol or "").strip()
    if not s:
        return ""
    if s.endswith("-SWAP"):
        return s
    if "/" in s:
        base = s.split("/")[0]
        return f"{base}-USDT-SWAP"
    return s.replace("USDT", "").replace(":USDT", "") + "-USDT-SWAP" if "USDT" in s else s


def signal_key(*, strategy_id: str, symbol: str, direction: str, closed_candle_at: str) -> str:
    sid = str(strategy_id or "").strip().upper()
    sym = normalize_swap_symbol(symbol)
    side = str(direction or "").strip().upper()
    if side in ("BUY", "LONG"):
        side = "LONG"
    elif side in ("SELL", "SHORT"):
        side = "SHORT"
    candle = str(closed_candle_at or "").strip()
    return f"{sid}:{sym}:{side}:{candle}"


def clord_id_from_signal(signal: str, *, suffix: str = "op") -> str:
    digest = hashlib.sha256(f"{signal}|{suffix}".encode("utf-8")).hexdigest()
    raw = f"s1{digest}"
    return "".join(ch for ch in raw if ch.isalnum())[:32]


def compute_base_quantity(
    *,
    equity: float,
    risk_pct: float,
    entry_price: float,
    stop_price: float,
) -> Dict[str, float]:
    eq = float(equity)
    rp = float(risk_pct)
    entry = float(entry_price)
    stop = float(stop_price)
    if eq <= 0 or rp <= 0:
        raise ValueError("invalid equity/risk_pct")
    if entry <= 0 or stop <= 0 or entry == stop:
        raise ValueError("invalid entry/stop")
    risk_amount_quote = eq * rp
    stop_distance = abs(entry - stop)
    base_quantity = risk_amount_quote / stop_distance
    return {
        "risk_amount_quote": risk_amount_quote,
        "stop_distance": stop_distance,
        "base_quantity": base_quantity,
        "entry_price": entry,
        "stop_price": stop,
        "risk_pct": rp,
        "equity": eq,
    }


STRUCTURE_METHOD = "CONFIRMED_SWING_2X2"
STRUCTURE_LOOKBACK_BARS = 20
ATR_STOP_MULTIPLIER = 1.5
DEFAULT_MIN_STOP_BPS = 10


def _norm_ts(value: Any) -> Optional[str]:
    if value is None:
        return None
    try:
        import pandas as pd

        ts = pd.Timestamp(value)
        if pd.isna(ts):
            return None
        if ts.tzinfo is None:
            ts = ts.tz_localize("UTC")
        else:
            ts = ts.tz_convert("UTC")
        return ts.strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:
        text = str(value).strip()
        return text or None


def _as_float(value: Any) -> Optional[float]:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    if out != out:
        return None
    return out


def closed_candle_rows(candles: Any) -> List[Dict[str, Any]]:
    """Normalize closed candles to {high, low, timestamp}. Forming bars must not be passed in."""
    if candles is None:
        return []
    rows: List[Dict[str, Any]] = []
    if hasattr(candles, "iterrows"):
        columns = set(list(getattr(candles, "columns", [])))
        for idx, row in candles.iterrows():
            ts = row["timestamp"] if "timestamp" in columns else idx
            high = _as_float(row["high"] if "high" in columns else None)
            low = _as_float(row["low"] if "low" in columns else None)
            rows.append({"high": high, "low": low, "timestamp": _norm_ts(ts)})
        return rows
    if isinstance(candles, Mapping):
        return closed_candle_rows([candles])
    if not isinstance(candles, Sequence) or isinstance(candles, (str, bytes)):
        return []
    for item in candles:
        if not isinstance(item, Mapping):
            continue
        ts = item.get("timestamp", item.get("ts", item.get("time")))
        rows.append(
            {
                "high": _as_float(item.get("high")),
                "low": _as_float(item.get("low")),
                "timestamp": _norm_ts(ts),
            }
        )
    return rows


def find_confirmed_swing_2x2(
    *,
    direction: str,
    closed_candles: Any,
    lookback: int = STRUCTURE_LOOKBACK_BARS,
) -> Optional[Dict[str, Any]]:
    """Most recent confirmed 2x2 swing on closed candles only.

    LONG swing low at i:
      Low[i] < Low[i-1] and Low[i] < Low[i-2]
      and Low[i] < Low[i+1] and Low[i] < Low[i+2]
    SHORT swing high at i:
      High[i] > High[i-1] and High[i] > High[i-2]
      and High[i] > High[i+1] and High[i] > High[i+2]
    i-2..i+2 must already be closed. Search newest → oldest.
    """
    rows = closed_candle_rows(closed_candles)
    if not rows:
        return None
    window = rows[-int(lookback) :] if len(rows) > lookback else rows
    n = len(window)
    if n < 5:
        return None
    side = str(direction or "").strip().lower()
    long_side = side in ("long", "buy")
    for i in range(n - 3, 1, -1):
        left2 = window[i - 2]
        left1 = window[i - 1]
        mid = window[i]
        right1 = window[i + 1]
        right2 = window[i + 2]
        if long_side:
            pivot = mid.get("low")
            neighbors = (
                left1.get("low"),
                left2.get("low"),
                right1.get("low"),
                right2.get("low"),
            )
            if pivot is None or any(v is None for v in neighbors):
                continue
            if pivot < neighbors[0] and pivot < neighbors[1] and pivot < neighbors[2] and pivot < neighbors[3]:
                return {
                    "price": float(pivot),
                    "timestamp": mid.get("timestamp"),
                    "index": i,
                    "kind": "swing_low",
                }
        else:
            pivot = mid.get("high")
            neighbors = (
                left1.get("high"),
                left2.get("high"),
                right1.get("high"),
                right2.get("high"),
            )
            if pivot is None or any(v is None for v in neighbors):
                continue
            if pivot > neighbors[0] and pivot > neighbors[1] and pivot > neighbors[2] and pivot > neighbors[3]:
                return {
                    "price": float(pivot),
                    "timestamp": mid.get("timestamp"),
                    "index": i,
                    "kind": "swing_high",
                }
    return None


def _stop_fail(
    reason: str,
    *,
    atr14: Optional[float] = None,
    entry_price: Optional[float] = None,
    minimum_stop_distance: Optional[float] = None,
    structure_invalidation_price: Optional[float] = None,
    structure_invalidation_distance: Optional[float] = None,
    structure_candle_timestamp: Optional[str] = None,
) -> Dict[str, Any]:
    atr = _as_float(atr14)
    return {
        "stop_price": None,
        "reason": reason,
        "structure_method": STRUCTURE_METHOD,
        "structure_lookback_bars": STRUCTURE_LOOKBACK_BARS,
        "structure_invalidation_price": structure_invalidation_price,
        "structure_invalidation_distance": structure_invalidation_distance,
        "structure_candle_timestamp": structure_candle_timestamp,
        "atr14": atr,
        "atr_stop_distance": (ATR_STOP_MULTIPLIER * atr) if atr and atr > 0 else None,
        "minimum_stop_distance": minimum_stop_distance,
        "final_stop_distance": None,
        "stop_distance": None,
        "source": "S1.structure_invalidation.v1",
        "entry_price": entry_price,
    }


def resolve_s1_stop_price(
    *,
    direction: str,
    entry_price: float,
    atr14: float,
    s1_cfg: Optional[Mapping[str, Any]] = None,
    closed_candles: Any = None,
    forming_candle: Any = None,
    structure_invalidation_distance: Optional[float] = None,
) -> Optional[Dict[str, Any]]:
    """CONFIRMED_SWING_2X2 stop, then min(1.5*ATR14, structure) with 10bps floor.

    forming_candle is accepted only so callers can pass it explicitly; it is never used.
    structure_invalidation_distance is ignored — swing must come from closed candles.
    No ATR-only / EMA / HHV-LLV fallback.
    """
    _ = forming_candle
    _ = structure_invalidation_distance
    entry = _as_float(entry_price)
    atr = _as_float(atr14)
    if entry is None or entry <= 0:
        return _stop_fail("INVALID_STOP_PRICE", atr14=atr, entry_price=entry)
    if atr is None or atr <= 0:
        return _stop_fail("S1_STRUCTURE_STOP_NOT_FOUND", atr14=atr, entry_price=entry)

    swing = find_confirmed_swing_2x2(direction=direction, closed_candles=closed_candles)
    if not swing:
        return _stop_fail("S1_STRUCTURE_STOP_NOT_FOUND", atr14=atr, entry_price=entry)

    struct_price = float(swing["price"])
    side = str(direction or "").lower()
    long_side = side in ("long", "buy")
    if long_side:
        struct_dist = entry - struct_price
    else:
        struct_dist = struct_price - entry
    if struct_dist <= 0:
        return _stop_fail(
            "INVALID_STOP_PRICE",
            atr14=atr,
            entry_price=entry,
            structure_invalidation_price=struct_price,
            structure_invalidation_distance=struct_dist,
            structure_candle_timestamp=swing.get("timestamp"),
        )

    stop_cfg = (s1_cfg or {}).get("stop") or {}
    min_bps = _as_float(stop_cfg.get("minimum_stop_distance_bps"))
    if min_bps is None:
        min_bps = DEFAULT_MIN_STOP_BPS
    min_dist = entry * (min_bps / 10_000.0)
    atr_stop = ATR_STOP_MULTIPLIER * atr
    raw_stop = min(atr_stop, struct_dist)
    final_stop = max(min_dist, raw_stop)
    if long_side:
        stop = entry - final_stop
    else:
        stop = entry + final_stop
    if stop <= 0 or (long_side and stop >= entry) or ((not long_side) and stop <= entry):
        return _stop_fail(
            "INVALID_STOP_PRICE",
            atr14=atr,
            entry_price=entry,
            minimum_stop_distance=min_dist,
            structure_invalidation_price=struct_price,
            structure_invalidation_distance=struct_dist,
            structure_candle_timestamp=swing.get("timestamp"),
        )
    return {
        "stop_price": stop,
        "stop_distance": final_stop,
        "final_stop_distance": final_stop,
        "raw_stop_distance": raw_stop,
        "atr14": atr,
        "atr_stop_distance": atr_stop,
        "minimum_stop_distance": min_dist,
        "structure_invalidation_distance": struct_dist,
        "structure_invalidation_price": struct_price,
        "structure_candle_timestamp": swing.get("timestamp"),
        "structure_method": STRUCTURE_METHOD,
        "structure_lookback_bars": STRUCTURE_LOOKBACK_BARS,
        "source": "S1.structure_invalidation.v1",
        "entry_price": entry,
        "reason": None,
    }


def assert_stop_direction(*, direction: str, entry_price: float, stop_price: float) -> None:
    entry = float(entry_price)
    stop = float(stop_price)
    if entry <= 0 or stop <= 0 or abs(entry - stop) <= 0:
        raise ValueError("INVALID_STOP_PRICE")
    side = str(direction or "").lower()
    if side in ("long", "buy") and not stop < entry:
        raise ValueError("INVALID_STOP_PRICE")
    if side in ("short", "sell") and not stop > entry:
        raise ValueError("INVALID_STOP_PRICE")


def opening_signal_already_used(existing: list, key: str) -> bool:
    want = str(key or "")
    if not want:
        return False
    for row in existing or []:
        if not isinstance(row, dict):
            continue
        if str(row.get("signal_key") or "") != want:
            continue
        st = str(row.get("status") or "").upper()
        if st in NONTERMINAL or st in {"FILLED", "WOULD_SUBMIT"}:
            return True
    return False
