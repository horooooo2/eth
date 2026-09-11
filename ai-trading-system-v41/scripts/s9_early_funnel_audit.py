"""Read-only S9 EARLY gate funnel + OLD/NEW exit audit. No orders. No param changes."""

from __future__ import annotations

import json
import time
from collections import Counter, defaultdict
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd

from src.runtime.config_loader import load_strategy_config
from src.runtime.s9_exits import direction_flip_exit
from src.strategies.s9_momentum import (
    EARLY_BEARISH,
    EARLY_BULLISH,
    EARLY_MOMENTUM,
    STRONG_BEARISH,
    STRONG_BULLISH,
    atr,
    breakout_hit,
    breakout_level,
    evaluate_5m_direction,
    evaluate_5m_direction_legacy,
    find_micro_swing,
    s3_allows,
    validate_stop,
    volume_ratio,
)

GATES = (
    "BREAKOUT_PRICE",
    "BREAKOUT_BUFFER",
    "VOLUME",
    "CANDLE_BODY",
    "CLOSE_LOCATION",
    "ATR",
    "S3",
    "STRUCTURE_FOUND",
    "STRUCTURE_MIN_DISTANCE",
    "STRUCTURE_MAX_ATR",
)
HORIZONS = (5, 10, 15, 30)
GROUPED_FIRST = (
    ("Breakout", ("BREAKOUT_PRICE", "BREAKOUT_BUFFER")),
    ("Volume", ("VOLUME",)),
    ("Candle", ("CANDLE_BODY", "CLOSE_LOCATION")),
    ("ATR", ("ATR",)),
    ("S3", ("S3",)),
    ("Structure", ("STRUCTURE_FOUND", "STRUCTURE_MIN_DISTANCE", "STRUCTURE_MAX_ATR")),
)


def _df(rows: List[list]) -> pd.DataFrame:
    df = pd.DataFrame(rows, columns=["ts", "open", "high", "low", "close", "volume"])
    df["ts"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
    return df.drop_duplicates("ts").set_index("ts").sort_index()


def fetch_ccxt_span(exchange, symbol: str, timeframe: str, span_ms: int) -> pd.DataFrame:
    now_ms = int(exchange.milliseconds())
    start_ms = now_ms - int(span_ms)
    rows: List[list] = []
    chunk = 12 * 60 * 60 * 1000
    cursor = start_ms
    while cursor < now_ms:
        end = min(cursor + chunk, now_ms)
        inner = cursor
        for _ in range(12):
            batch = exchange.fetch_ohlcv(symbol, timeframe, since=inner, limit=200)
            if not batch:
                break
            rows.extend(batch)
            nxt = int(batch[-1][0]) + 1
            if nxt <= inner:
                break
            inner = nxt
            if int(batch[-1][0]) >= end:
                break
            time.sleep(0.08)
        cursor = end
    return _df(rows) if rows else pd.DataFrame(columns=["open", "high", "low", "close", "volume"])


def last_closed_5m_ts(one_open: pd.Timestamp, five_index: pd.DatetimeIndex) -> Optional[pd.Timestamp]:
    now = one_open + pd.Timedelta(minutes=1)
    cutoff = now - pd.Timedelta(minutes=5)
    pos = five_index.searchsorted(cutoff, side="right") - 1
    if pos < 0:
        return None
    return five_index[pos]


def precompute_5m(five: pd.DataFrame, cfg: Dict[str, Any]) -> Dict[pd.Timestamp, Dict[str, Any]]:
    out: Dict[pd.Timestamp, Dict[str, Any]] = {}
    for i in range(30, len(five) + 1):
        sl = five.iloc[:i]
        out[sl.index[-1]] = {
            "new": evaluate_5m_direction(sl, cfg),
            "old": evaluate_5m_direction_legacy(sl, cfg),
        }
    return out


def evaluate_early_gates(one: pd.DataFrame, *, side: str, cfg: Dict[str, Any]) -> Dict[str, Any]:
    last = one.iloc[-1]
    close = float(last["close"])
    high = float(last["high"])
    low = float(last["low"])
    open_ = float(last["open"])
    rng = high - low
    body = abs(close - open_) / rng if rng > 0 else None
    loc = ((close - low) / rng if side == "LONG" else (high - close) / rng) if rng > 0 else None
    level = breakout_level(one, side=side, lookback=10)
    price_pass = bool(level is not None and breakout_hit(close, level, side=side, buffer_bps=0.0))
    buffer_pass = bool(level is not None and breakout_hit(close, level, side=side, buffer_bps=2.0))
    vr = volume_ratio(one, 20)
    vol_pass = bool(vr is not None and vr >= 1.50)
    body_pass = bool(body is not None and body >= 0.65)
    loc_pass = bool(loc is not None and loc >= 0.75)
    atr14 = float(atr(one, 14).iloc[-1]) if len(one) >= 15 else 0.0
    atr_bps = atr14 / close * 10_000.0 if close else 0.0
    atr_pass = 5.0 <= atr_bps <= 50.0
    s3 = s3_allows(side, regime="range", bias=0.0, cfg=cfg, entry_mode=EARLY_MOMENTUM)
    s3_pass = s3 is None
    swing = find_micro_swing(one, side=side, lookback=10)
    found = bool(swing)
    min_pass = False
    max_pass = False
    dist_bps = None
    if swing and close > 0:
        stop_err = validate_stop(
            side=side,
            entry=close,
            stop=float(swing["price"]),
            atr14=atr14,
            min_bps=6.0,
            max_atr_mult=1.2,
        )
        dist = (close - float(swing["price"])) if side == "LONG" else (float(swing["price"]) - close)
        dist_bps = dist / close * 10_000.0 if close else None
        if stop_err is None:
            min_pass = True
            max_pass = True
        elif stop_err == "S9_STRUCTURE_STOP_TOO_TIGHT":
            min_pass = False
            max_pass = True
        elif stop_err == "S9_STRUCTURE_STOP_TOO_WIDE":
            min_pass = True
            max_pass = False
        else:
            min_pass = False
            max_pass = False
    flags = {
        "BREAKOUT_PRICE": price_pass,
        "BREAKOUT_BUFFER": buffer_pass,
        "VOLUME": vol_pass,
        "CANDLE_BODY": body_pass,
        "CLOSE_LOCATION": loc_pass,
        "ATR": atr_pass,
        "S3": s3_pass,
        "STRUCTURE_FOUND": found,
        "STRUCTURE_MIN_DISTANCE": min_pass,
        "STRUCTURE_MAX_ATR": max_pass,
    }
    first = None
    for name in GATES:
        if not flags[name]:
            first = name
            break
    remaining = []
    ok = True
    for name in GATES:
        ok = ok and flags[name]
        remaining.append(ok)
    return {
        "flags": flags,
        "first": first,
        "remaining": remaining,
        "pre_s4": first is None,
        "level": level,
        "volume_ratio": None if vr is None else round(float(vr), 4),
        "body": None if body is None else round(float(body), 4),
        "loc": None if loc is None else round(float(loc), 4),
        "atr_bps": round(float(atr_bps), 3),
        "dist_bps": None if dist_bps is None else round(float(dist_bps), 3),
        "s3_reason": s3,
        "close": close,
    }


def forward_excursions(one_all: pd.DataFrame, ts: pd.Timestamp, *, side: str, close: float) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    if close <= 0 or ts not in one_all.index:
        return out
    pos = one_all.index.get_loc(ts)
    if isinstance(pos, slice):
        pos = pos.start
    pos = int(pos)
    for h in HORIZONS:
        end = min(pos + h, len(one_all) - 1)
        if end <= pos:
            continue
        window = one_all.iloc[pos + 1 : end + 1]
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
        out[str(h)] = {
            "forward_return_bps": fwd * 10_000.0,
            "mfe_bps": mfe * 10_000.0,
            "mae_bps": mae * 10_000.0,
            "bars": int(len(window)),
        }
    return out


def mean_or_none(vals: List[float]) -> Optional[float]:
    return round(sum(vals) / len(vals), 3) if vals else None


def summarize_fwd(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    by_h: Dict[str, Dict[str, List[float]]] = {str(h): defaultdict(list) for h in HORIZONS}
    for row in rows:
        fwd = row.get("forward") or {}
        for h, rec in fwd.items():
            by_h[str(h)]["forward_return_bps"].append(float(rec["forward_return_bps"]))
            by_h[str(h)]["mfe_bps"].append(float(rec["mfe_bps"]))
            by_h[str(h)]["mae_bps"].append(float(rec["mae_bps"]))
            by_h[str(h)]["hit_positive"].append(1.0 if float(rec["forward_return_bps"]) > 0 else 0.0)
    return {
        h: {
            "n": len(rec.get("forward_return_bps") or []),
            "forward_return_bps": mean_or_none(rec.get("forward_return_bps") or []),
            "mfe_bps": mean_or_none(rec.get("mfe_bps") or []),
            "mae_bps": mean_or_none(rec.get("mae_bps") or []),
            "positive_fwd_pct": None if not rec.get("hit_positive") else round(100.0 * sum(rec["hit_positive"]) / len(rec["hit_positive"]), 2),
        }
        for h, rec in by_h.items()
    }


def grouped_first(first: Counter, n: int) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for label, names in GROUPED_FIRST:
        c = sum(int(first.get(name, 0)) for name in names)
        out[label] = {"count": c, "pct": 0.0 if n == 0 else round(100.0 * c / n, 2)}
    out["PRE_S4_CANDIDATE"] = {
        "count": int(first.get("PRE_S4_CANDIDATE", 0)),
        "pct": 0.0 if n == 0 else round(100.0 * int(first.get("PRE_S4_CANDIDATE", 0)) / n, 2),
    }
    return out


def funnel_block(samples: List[Dict[str, Any]]) -> Dict[str, Any]:
    n = len(samples)
    if n == 0:
        return {
            "EARLY_STATE_COUNT": 0,
            "BREAKOUT_PRICE_PASS": 0,
            "BREAKOUT_BUFFER_PASS": 0,
            "VOLUME_PASS": 0,
            "CANDLE_BODY_PASS": 0,
            "CLOSE_LOCATION_PASS": 0,
            "ATR_PASS": 0,
            "S3_PASS": 0,
            "STRUCTURE_FOUND": 0,
            "STRUCTURE_MIN_DISTANCE_PASS": 0,
            "STRUCTURE_MAX_ATR_PASS": 0,
            "PRE_S4_CANDIDATE": 0,
            "first_blocker": {},
            "first_blocker_pct": {},
            "first_blocker_grouped": grouped_first(Counter(), 0),
            "independent_pass": {name: 0 for name in GATES},
            "independent_pass_pct": {name: 0.0 for name in GATES},
            "forward": {},
            "forward_rejected": {},
        }
    remain = [n]
    for i, _name in enumerate(GATES):
        remain.append(sum(1 for s in samples if s["remaining"][i]))
    first = Counter(s["first"] or "PRE_S4_CANDIDATE" for s in samples)
    indep = {name: sum(1 for s in samples if s["flags"][name]) for name in GATES}
    rejected = [s for s in samples if not s["pre_s4"]]
    return {
        "EARLY_STATE_COUNT": n,
        "BREAKOUT_PRICE_PASS": remain[1],
        "BREAKOUT_BUFFER_PASS": remain[2],
        "VOLUME_PASS": remain[3],
        "CANDLE_BODY_PASS": remain[4],
        "CLOSE_LOCATION_PASS": remain[5],
        "ATR_PASS": remain[6],
        "S3_PASS": remain[7],
        "STRUCTURE_FOUND": remain[8],
        "STRUCTURE_MIN_DISTANCE_PASS": remain[9],
        "STRUCTURE_MAX_ATR_PASS": remain[10],
        "PRE_S4_CANDIDATE": remain[10],
        "independent_pass": indep,
        "independent_pass_pct": {k: round(100.0 * v / n, 2) for k, v in indep.items()},
        "first_blocker": dict(first),
        "first_blocker_pct": {k: round(100.0 * v / n, 2) for k, v in first.items()},
        "first_blocker_grouped": grouped_first(first, n),
        "forward_all_early": summarize_fwd(samples),
        "forward_rejected": summarize_fwd(rejected),
        "forward_by_first_blocker": {
            gate: summarize_fwd([s for s in samples if (s["first"] or "PRE_S4_CANDIDATE") == gate])
            for gate in list(GATES) + ["PRE_S4_CANDIDATE"]
            if any((s["first"] or "PRE_S4_CANDIDATE") == gate for s in samples)
        },
    }


def old_flip(side: str, new: str) -> bool:
    if str(side).upper() in {"LONG", "BUY"}:
        return new == "BEARISH"
    return new == "BULLISH"


def new_flip(side: str, new: str) -> bool:
    return direction_flip_exit(side=side, prev_state="", new_state=new)


def analyze_window(
    one: pd.DataFrame,
    five_index: pd.DatetimeIndex,
    dirs: Dict[pd.Timestamp, Dict[str, Any]],
    cfg: Dict[str, Any],
    *,
    label: str,
    start_ts: pd.Timestamp,
) -> Dict[str, Any]:
    samples_l: List[Dict[str, Any]] = []
    samples_s: List[Dict[str, Any]] = []
    unique_5m_l = set()
    unique_5m_s = set()
    for i in range(25, len(one)):
        ts = one.index[i]
        if ts < start_ts:
            continue
        ts5 = last_closed_5m_ts(ts, five_index)
        if ts5 is None or ts5 not in dirs:
            continue
        new_dir = dirs[ts5]["new"]
        state = str(new_dir.get("state") or "")
        if state not in {EARLY_BULLISH, EARLY_BEARISH}:
            continue
        side = "LONG" if state == EARLY_BULLISH else "SHORT"
        sl = one.iloc[: i + 1]
        gates = evaluate_early_gates(sl, side=side, cfg=cfg)
        row = {
            **gates,
            "ts": str(ts),
            "ts5": str(ts5),
            "state": state,
            "side": side,
            "forward": forward_excursions(one, ts, side=side, close=float(gates["close"])),
        }
        if side == "LONG":
            samples_l.append(row)
            unique_5m_l.add(ts5)
        else:
            samples_s.append(row)
            unique_5m_s.add(ts5)
    all_s = samples_l + samples_s
    first_all = Counter(s["first"] or "PRE_S4_CANDIDATE" for s in all_s)
    top3 = first_all.most_common(3)
    n = len(all_s)
    return {
        "window": label,
        "s3_assumption": "range / direction_bias=0. Historical S3 unavailable. EARLY allows RANGE, so assumed S3 always passes.",
        "s4_note": "Historical microstructure unavailable. Funnel stops at PRE_S4_CANDIDATE. No fabricated S4 PASS.",
        "write_requests": 0,
        "early_1m_samples": {"EARLY_BULLISH": len(samples_l), "EARLY_BEARISH": len(samples_s), "ALL": n},
        "early_unique_5m": {"EARLY_BULLISH": len(unique_5m_l), "EARLY_BEARISH": len(unique_5m_s)},
        "funnel_ALL": funnel_block(all_s),
        "funnel_EARLY_BULLISH": funnel_block(samples_l),
        "funnel_EARLY_BEARISH": funnel_block(samples_s),
        "top3_first_blockers": [
            {"gate": g, "count": c, "pct": 0.0 if n == 0 else round(100.0 * c / n, 2)} for g, c in top3
        ],
        "asymmetric": {
            "bullish_pre_s4": funnel_block(samples_l).get("PRE_S4_CANDIDATE", 0),
            "bearish_pre_s4": funnel_block(samples_s).get("PRE_S4_CANDIDATE", 0),
        },
    }


def largest_15m_moves(
    one: pd.DataFrame,
    five_index: pd.DatetimeIndex,
    dirs: Dict[pd.Timestamp, Dict[str, Any]],
    cfg: Dict[str, Any],
    *,
    start_ts: pd.Timestamp,
    n: int = 6,
) -> List[Dict[str, Any]]:
    moves: List[Tuple[float, int]] = []
    for i in range(25, len(one) - 15):
        ts = one.index[i]
        if ts < start_ts:
            continue
        c0 = float(one["close"].iloc[i])
        c1 = float(one["close"].iloc[i + 15])
        if c0 <= 0:
            continue
        moves.append((abs(c1 - c0) / c0, i))
    moves.sort(reverse=True)
    picked = []
    used = set()
    for _mag, i in moves:
        if any(abs(i - u) < 15 for u in used):
            continue
        used.add(i)
        ts = one.index[i]
        ts5 = last_closed_5m_ts(ts, five_index)
        d = dirs.get(ts5, {}) if ts5 is not None else {}
        new_dir = d.get("new") or {}
        state = str(new_dir.get("state") or "UNAVAILABLE")
        sl = one.iloc[: i + 1]
        c0 = float(one["close"].iloc[i])
        c1 = float(one["close"].iloc[i + 15])
        market = "UP" if c1 >= c0 else "DOWN"
        market_side = "LONG" if market == "UP" else "SHORT"
        aligned = (
            (market == "UP" and state in {EARLY_BULLISH, STRONG_BULLISH})
            or (market == "DOWN" and state in {EARLY_BEARISH, STRONG_BEARISH})
        )
        gates = None
        if state in {EARLY_BULLISH, EARLY_BEARISH}:
            gates = evaluate_early_gates(sl, side="LONG" if state == EARLY_BULLISH else "SHORT", cfg=cfg)
        elif state in {STRONG_BULLISH, STRONG_BEARISH}:
            # TREND path is out of EARLY funnel scope; still show EARLY-style gates for the move side.
            gates = evaluate_early_gates(sl, side=market_side, cfg=cfg)
        else:
            gates = evaluate_early_gates(sl, side=market_side, cfg=cfg)
        if state in {"NEUTRAL", "UNAVAILABLE"}:
            first = "DIRECTION_NEUTRAL"
            why = f"S9 state={state} at move start; direction gate never opened."
        elif not aligned:
            first = "DIRECTION_OPPOSITE_TO_MOVE"
            why = f"S9 state={state} while market moved {market}."
        elif gates and gates["first"]:
            first = gates["first"]
            why = f"State {state} aligned with {market}, first EARLY gate fail={gates['first']}."
        elif gates and gates["pre_s4"]:
            first = "PRE_S4_CANDIDATE"
            why = "All EARLY price gates passed; S4 not evaluable (historical microstructure unavailable)."
        else:
            first = "UNKNOWN"
            why = f"state={state}"
        picked.append(
            {
                "start": str(ts),
                "end": str(one.index[i + 15]),
                "market_direction": market,
                "price_from": round(c0, 2),
                "price_to": round(c1, 2),
                "change_bps": round((c1 - c0) / c0 * 10_000.0, 2),
                "abs_change_bps": round(abs(c1 - c0) / c0 * 10_000.0, 2),
                "s9_direction_state": state,
                "direction_score": new_dir.get("s9_direction_score"),
                "ADX": new_dir.get("adx14"),
                "EMA9": new_dir.get("ema9"),
                "EMA21": new_dir.get("ema21"),
                "slope": new_dir.get("ema9_slope_3"),
                "ROC3": new_dir.get("s9_roc3"),
                "aligned_with_move": aligned,
                "breakout": None
                if not gates
                else {"level": gates["level"], "price": gates["flags"]["BREAKOUT_PRICE"], "buffer": gates["flags"]["BREAKOUT_BUFFER"]},
                "volume": None if not gates else gates["volume_ratio"],
                "candle_quality": None if not gates else {"body": gates["body"], "close_location": gates["loc"]},
                "ATR_bps": None if not gates else gates["atr_bps"],
                "structure": None
                if not gates
                else {
                    "found": gates["flags"]["STRUCTURE_FOUND"],
                    "min": gates["flags"]["STRUCTURE_MIN_DISTANCE"],
                    "max": gates["flags"]["STRUCTURE_MAX_ATR"],
                    "dist_bps": gates["dist_bps"],
                },
                "S3": "ASSUMED_RANGE_BIAS0_PASS" if gates and gates["flags"]["S3"] else "ASSUMED_RANGE_BIAS0",
                "FIRST_BLOCKER": first,
                "why_no_trade": why,
            }
        )
        if len(picked) >= n:
            break
    return picked


def exit_audit(five: pd.DataFrame, dirs: Dict[pd.Timestamp, Dict[str, Any]]) -> Dict[str, Any]:
    series = [(ts, dirs[ts]["old"]["state"], dirs[ts]["new"]["state"]) for ts in five.index if ts in dirs]
    entries: List[Dict[str, Any]] = []
    i = 0
    while i < len(series):
        ts, old_s, new_s = series[i]
        if new_s in {STRONG_BULLISH, EARLY_BULLISH} or old_s == "BULLISH":
            side = "LONG"
        elif new_s in {STRONG_BEARISH, EARLY_BEARISH} or old_s == "BEARISH":
            side = "SHORT"
        else:
            i += 1
            continue
        old_exit = None
        new_exit = None
        old_reason = None
        new_reason = None
        nxt_states: List[str] = []
        for j in range(i + 1, len(series)):
            tsj, o, n = series[j]
            mins = (tsj - ts).total_seconds() / 60.0
            if old_exit is None:
                if old_flip(side, o):
                    old_exit, old_reason = tsj, "DIRECTION_FLIP"
                elif mins >= 30:
                    old_exit, old_reason = tsj, "TIME_EXIT"
            if new_exit is None:
                if new_flip(side, n):
                    new_exit = tsj
                    new_reason = "EARLY_OPPOSITE" if n in {EARLY_BULLISH, EARLY_BEARISH} else "STRONG_OPPOSITE"
                    nxt_states = [series[k][2] for k in range(j + 1, min(j + 3, len(series)))]
                elif mins >= 30:
                    new_exit, new_reason = tsj, "TIME_EXIT"
            if old_exit is not None and new_exit is not None:
                break
        if old_exit is None or new_exit is None:
            i += 1
            continue
        delta = (new_exit - old_exit).total_seconds() / 60.0
        origin_set = {EARLY_BULLISH, STRONG_BULLISH} if side == "LONG" else {EARLY_BEARISH, STRONG_BEARISH}
        entries.append(
            {
                "side": side,
                "entry_ts": str(ts),
                "old_exit_ts": str(old_exit),
                "new_exit_ts": str(new_exit),
                "old_reason": old_reason,
                "new_reason": new_reason,
                "delta_min_new_minus_old": round(delta, 2),
                "relation": "NEW_EARLIER" if delta < -1e-9 else ("NEW_LATER" if delta > 1e-9 else "SAME"),
                "early_flip": new_reason == "EARLY_OPPOSITE",
                "reversed_5m": bool(
                    new_reason == "EARLY_OPPOSITE"
                    and nxt_states
                    and (nxt_states[0] == "NEUTRAL" or nxt_states[0] in origin_set)
                ),
                "reversed_10m": bool(
                    new_reason == "EARLY_OPPOSITE"
                    and nxt_states
                    and any(s == "NEUTRAL" or s in origin_set for s in nxt_states[:2])
                ),
            }
        )
        later = max(old_exit, new_exit)
        nxt = next((k for k, row in enumerate(series) if row[0] > later), i + 1)
        i = max(nxt, i + 1)
    rel = Counter(e["relation"] for e in entries)
    earlier = [e["delta_min_new_minus_old"] for e in entries if e["relation"] == "NEW_EARLIER"]
    return {
        "simulated_positions": len(entries),
        "note": "Hypothetical 5m-episode positions. Not live fills. Cap 30m TIME_EXIT. No orders.",
        "NEW_earlier": rel.get("NEW_EARLIER", 0),
        "NEW_later": rel.get("NEW_LATER", 0),
        "same_exit": rel.get("SAME", 0),
        "avg_early_minutes": None if not earlier else round(-sum(earlier) / len(earlier), 2),
        "EARLY_FLIP_EXIT_COUNT": sum(1 for e in entries if e["early_flip"]),
        "EARLY_FLIP_REVERSED_WITHIN_5M": sum(1 for e in entries if e["reversed_5m"]),
        "EARLY_FLIP_REVERSED_WITHIN_10M": sum(1 for e in entries if e["reversed_10m"]),
        "old_reasons": dict(Counter(e["old_reason"] for e in entries)),
        "new_reasons": dict(Counter(e["new_reason"] for e in entries)),
        "samples": entries[:8],
    }


def frequency_label(pre_s4_7d: int) -> str:
    per_day = pre_s4_7d / 7.0
    if per_day >= 6:
        return "HIGH_FREQUENCY"
    if per_day >= 1:
        return "MEDIUM_FREQUENCY"
    return "LOW_FREQUENCY"


def main() -> int:
    cfg = load_strategy_config("S9")
    import ccxt  # type: ignore

    exchange = ccxt.okx({"enableRateLimit": True, "options": {"defaultType": "swap"}})
    warmup_1m = 240 * 60 * 1000
    warmup_5m = 160 * 5 * 60 * 1000
    one_all = fetch_ccxt_span(exchange, "BTC/USDT:USDT", "1m", 7 * 24 * 60 * 60 * 1000 + warmup_1m)
    five_all = fetch_ccxt_span(exchange, "BTC/USDT:USDT", "5m", 7 * 24 * 60 * 60 * 1000 + warmup_5m)
    from src.adapters.okx_market_data import split_closed_bars

    one_c, _, _ = split_closed_bars(one_all, timeframe="1m")
    five_c, _, _ = split_closed_bars(five_all, timeframe="5m")
    if one_c is None or one_c.empty:
        one_c = one_all
    if five_c is None or five_c.empty:
        five_c = five_all
    dirs = precompute_5m(five_c, cfg)
    now = one_c.index[-1]
    cut24 = now - pd.Timedelta(hours=24)
    cut7 = now - pd.Timedelta(days=7)
    w24 = analyze_window(one_c, five_c.index, dirs, cfg, label="24h", start_ts=cut24)
    w7 = analyze_window(one_c, five_c.index, dirs, cfg, label="7d", start_ts=cut7)
    moves = largest_15m_moves(one_c, five_c.index, dirs, cfg, start_ts=cut24, n=6)
    five24 = five_c[five_c.index >= cut24 - pd.Timedelta(hours=2)]
    exits24 = exit_audit(five24, dirs)
    exits7 = exit_audit(five_c, dirs)
    pre24 = int(w24["funnel_ALL"].get("PRE_S4_CANDIDATE", 0))
    pre7 = int(w7["funnel_ALL"].get("PRE_S4_CANDIDATE", 0))
    report = {
        "symbol": "BTC-USDT-SWAP",
        "source": "OKX public OHLCV via ccxt. Read-only.",
        "write_requests": 0,
        "parameters_changed": False,
        "historical_microstructure": "unavailable",
        "bars_1m_24h": int((one_c.index >= cut24).sum()),
        "bars_1m_7d": int(len(one_c)),
        "bars_5m_7d": int(len(five_c)),
        "end_ts": str(now),
        "24h": w24,
        "7d": w7,
        "largest_15m_moves_24h": moves,
        "exit_audit_24h": exits24,
        "exit_audit_7d": exits7,
        "frequency": {
            "pre_s4_24h": pre24,
            "pre_s4_7d": pre7,
            "label": frequency_label(pre7),
            "note": "Based on PRE_S4 candidate count, not 1m evaluation cadence.",
        },
    }
    print(json.dumps(report, ensure_ascii=False, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
