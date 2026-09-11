"""Read-only S9 STRONG pullback-resumption research + exit replay.

Does not modify production strategy, risk, stops, or place orders.
EARLY gates are not relaxed. TREND breakout params are not changed.
"""

from __future__ import annotations

import json
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

from s9_early_funnel_audit import (  # noqa: E402
    HORIZONS,
    evaluate_early_gates,
    fetch_ccxt_span,
    forward_excursions,
    last_closed_5m_ts,
    mean_or_none,
    precompute_5m,
    summarize_fwd,
)
from src.runtime.config_loader import load_strategy_config
from src.runtime.s9_exits import direction_flip_exit
from src.strategies.s9_momentum import (
    EARLY_BEARISH,
    EARLY_BULLISH,
    STRONG_BEARISH,
    STRONG_BULLISH,
    TREND_CONTINUATION,
    atr,
    breakout_hit,
    breakout_level,
    find_micro_swing,
    s3_allows,
    validate_stop,
    volume_ratio,
)

PB_GATES = (
    "PULLBACK_DETECTED",
    "RESUMPTION_TRIGGERED",
    "VOLUME",
    "CANDLE",
    "ATR",
    "STRUCTURE_FOUND",
    "STRUCTURE_MIN",
    "STRUCTURE_MAX_ATR",
)

# Research-only structural defaults. Not grid-searched. Not production.
# Depth band is a "had a real pullback, did not break the trend" description.
# Candle/volume/ATR/stop reuse TREND_CONTINUATION unchanged.
PB_LOOKBACK = 12
PB_MIN_DEPTH_ATR = 0.20
PB_MAX_DEPTH_ATR = 1.00
PB_MIN_BARS = 2
PB_MAX_BARS = 10
PB_NEAR_EMA9_BPS = 8.0


def _pcts(vals: List[float]) -> Dict[str, Optional[float]]:
    if not vals:
        return {"n": 0, "p25": None, "p50": None, "p75": None, "mean": None}
    s = sorted(vals)
    n = len(s)

    def q(p: float) -> float:
        if n == 1:
            return round(s[0], 4)
        idx = min(n - 1, max(0, int(round((n - 1) * p))))
        return round(s[idx], 4)

    return {"n": n, "p25": q(0.25), "p50": q(0.50), "p75": q(0.75), "mean": mean_or_none(s)}


def _sep(success: List[float], fail: List[float]) -> Dict[str, Any]:
    a, b = _pcts(success), _pcts(fail)
    if not success or not fail:
        return {"success": a, "fail": b, "separated": False, "note": "insufficient"}
    sm, fm = a["p50"], b["p50"]
    separated = False
    note = "overlap"
    if sm is not None and fm is not None and b["p25"] is not None and b["p75"] is not None:
        if sm < b["p25"] or sm > b["p75"]:
            separated = True
            note = "success median outside fail IQR"
        elif abs(sm - fm) >= 0.25 * max(1e-9, (b["p75"] - b["p25"])):
            note = "median shift inside IQR"
        else:
            note = "weak median difference"
    return {"success": a, "fail": b, "separated": separated, "note": note, "median_diff": None if sm is None or fm is None else round(sm - fm, 4)}


def measure_pullback(
    one: pd.DataFrame,
    i: int,
    *,
    side: str,
    ema9: Optional[float],
    ema21: Optional[float],
    atr14: float,
) -> Optional[Dict[str, Any]]:
    start = max(0, i - PB_LOOKBACK)
    prior = one.iloc[start:i]
    if len(prior) < 3 or atr14 <= 0 or ema9 is None or ema21 is None:
        return None
    close = float(one["close"].iloc[i])
    if close <= 0:
        return None
    if side == "LONG":
        peak_pos = int(prior["high"].values.argmax())
        peak = float(prior["high"].iloc[peak_pos])
        after = one.iloc[start + peak_pos : i + 1]
        trough = float(after["low"].min())
        depth = peak - trough
        touched9 = bool((after["low"] <= float(ema9)).any())
        touched21 = bool((after["low"] <= float(ema21)).any())
        near9 = abs(trough - float(ema9)) / close * 10_000.0
        still = close >= float(ema21)
        dist9 = (close - float(ema9)) / close * 10_000.0
        dist21 = (close - float(ema21)) / close * 10_000.0
    else:
        trough_pos = int(prior["low"].values.argmin())
        trough = float(prior["low"].iloc[trough_pos])
        after = one.iloc[start + trough_pos : i + 1]
        peak = float(after["high"].max())
        depth = peak - trough
        touched9 = bool((after["high"] >= float(ema9)).any())
        touched21 = bool((after["high"] >= float(ema21)).any())
        near9 = abs(peak - float(ema9)) / close * 10_000.0
        still = close <= float(ema21)
        dist9 = (float(ema9) - close) / close * 10_000.0
        dist21 = (float(ema21) - close) / close * 10_000.0
        peak_pos = trough_pos
    duration = int(i - (start + peak_pos))
    return {
        "depth_bps": depth / close * 10_000.0,
        "depth_atr": depth / atr14,
        "duration": duration,
        "touched_ema9": touched9,
        "touched_ema21": touched21,
        "near_ema9_bps": near9,
        "dist_ema9_bps": dist9,
        "dist_ema21_bps": dist21,
        "still_in_5m_structure": still,
    }


def trend_quality(one: pd.DataFrame, *, side: str) -> Dict[str, Any]:
    last = one.iloc[-1]
    close = float(last["close"])
    high = float(last["high"])
    low = float(last["low"])
    open_ = float(last["open"])
    rng = high - low
    body = abs(close - open_) / rng if rng > 0 else None
    loc = ((close - low) / rng if side == "LONG" else (high - close) / rng) if rng > 0 else None
    level = breakout_level(one, side=side, lookback=20)
    price_pass = bool(level is not None and breakout_hit(close, level, side=side, buffer_bps=0.0))
    buffer_pass = bool(level is not None and breakout_hit(close, level, side=side, buffer_bps=1.0))
    vr = volume_ratio(one, 20)
    vol_pass = bool(vr is not None and vr >= 1.30)
    body_pass = bool(body is not None and body >= 0.55)
    loc_pass = bool(loc is not None and loc >= 0.65)
    candle_pass = body_pass and loc_pass
    atr14 = float(atr(one, 14).iloc[-1]) if len(one) >= 15 else 0.0
    atr_bps = atr14 / close * 10_000.0 if close else 0.0
    atr_pass = 5.0 <= atr_bps <= 50.0
    swing = find_micro_swing(one, side=side, lookback=10)
    found = bool(swing)
    min_pass = False
    max_pass = False
    dist_bps = None
    dist_atr = None
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
        dist_bps = dist / close * 10_000.0
        dist_atr = dist / atr14 if atr14 > 0 else None
        if stop_err is None:
            min_pass = True
            max_pass = True
        elif stop_err == "S9_STRUCTURE_STOP_TOO_TIGHT":
            min_pass = False
            max_pass = True
        elif stop_err == "S9_STRUCTURE_STOP_TOO_WIDE":
            min_pass = True
            max_pass = False
    s3 = s3_allows(side, regime="strong_trend", bias=0.5 if side == "LONG" else -0.5, cfg=None, entry_mode=TREND_CONTINUATION)
    prev = float(one["close"].iloc[-2]) if len(one) >= 2 else close
    roc1 = (close - prev) / prev if prev else None
    roc3 = None
    if len(one) >= 4:
        p3 = float(one["close"].iloc[-4])
        roc3 = (close - p3) / p3 if p3 else None
    return {
        "close": close,
        "level": level,
        "breakout_price": price_pass,
        "breakout_buffer": buffer_pass,
        "volume_ratio": None if vr is None else float(vr),
        "volume_pass": vol_pass,
        "body": body,
        "loc": loc,
        "body_pass": body_pass,
        "loc_pass": loc_pass,
        "candle_pass": candle_pass,
        "atr14": atr14,
        "atr_bps": atr_bps,
        "atr_pass": atr_pass,
        "structure_found": found,
        "structure_min": min_pass,
        "structure_max": max_pass,
        "dist_bps": dist_bps,
        "dist_atr": dist_atr,
        "s3_pass": s3 is None,
        "roc1": roc1,
        "roc3_1m": roc3,
        "trend_pre_s4": bool(
            buffer_pass and vol_pass and candle_pass and atr_pass and found and min_pass and max_pass
        ),
    }


def pullback_detected(pb: Optional[Dict[str, Any]]) -> bool:
    if not pb:
        return False
    return (
        PB_MIN_BARS <= int(pb["duration"]) <= PB_MAX_BARS
        and PB_MIN_DEPTH_ATR <= float(pb["depth_atr"]) <= PB_MAX_DEPTH_ATR
        and bool(pb["still_in_5m_structure"])
        and (bool(pb["touched_ema9"]) or float(pb["near_ema9_bps"]) <= PB_NEAR_EMA9_BPS)
    )


def resumption_triggered(*, side: str, one: pd.DataFrame, pb: Optional[Dict[str, Any]], tq: Dict[str, Any], ema9: Optional[float]) -> bool:
    if not pb or ema9 is None:
        return False
    last = one.iloc[-1]
    close = float(last["close"])
    open_ = float(last["open"])
    prev = float(one["close"].iloc[-2]) if len(one) >= 2 else close
    if side == "LONG":
        resume_px = close > open_ and close > prev
        reclaim = close >= float(ema9)
    else:
        resume_px = close < open_ and close < prev
        reclaim = close <= float(ema9)
    # Path B is exclusive of a fresh 20-bar breakout. Do not chase acceleration.
    not_breakout = not bool(tq["breakout_price"])
    return bool(resume_px and reclaim and not_breakout)


def evaluate_pullback_gates(
    one: pd.DataFrame,
    *,
    side: str,
    ema9: Optional[float],
    ema21: Optional[float],
) -> Dict[str, Any]:
    tq = trend_quality(one, side=side)
    i = len(one) - 1
    pb = measure_pullback(one, i, side=side, ema9=ema9, ema21=ema21, atr14=float(tq["atr14"] or 0.0))
    flags = {
        "PULLBACK_DETECTED": pullback_detected(pb),
        "RESUMPTION_TRIGGERED": resumption_triggered(side=side, one=one, pb=pb, tq=tq, ema9=ema9),
        "VOLUME": bool(tq["volume_pass"]),
        "CANDLE": bool(tq["candle_pass"]),
        "ATR": bool(tq["atr_pass"]),
        "STRUCTURE_FOUND": bool(tq["structure_found"]),
        "STRUCTURE_MIN": bool(tq["structure_min"]),
        "STRUCTURE_MAX_ATR": bool(tq["structure_max"]),
    }
    first = None
    for name in PB_GATES:
        if not flags[name]:
            first = name
            break
    remaining = []
    ok = True
    for name in PB_GATES:
        ok = ok and flags[name]
        remaining.append(ok)
    return {
        "flags": flags,
        "first": first,
        "remaining": remaining,
        "pre_s4": first is None,
        "pb": pb,
        "tq": tq,
    }


def pb_funnel(samples: List[Dict[str, Any]]) -> Dict[str, Any]:
    n = len(samples)
    empty = {
        "STRONG_STATE": n,
        "PULLBACK_DETECTED": 0,
        "RESUMPTION_TRIGGERED": 0,
        "VOLUME_PASS": 0,
        "CANDLE_PASS": 0,
        "ATR_PASS": 0,
        "STRUCTURE_FOUND": 0,
        "STRUCTURE_MIN_PASS": 0,
        "STRUCTURE_MAX_ATR_PASS": 0,
        "PRE_S4_CANDIDATE": 0,
        "first_blocker": {},
        "independent_pass_pct": {},
    }
    if n == 0:
        return empty
    remain = [n]
    for i, _n in enumerate(PB_GATES):
        remain.append(sum(1 for s in samples if s["remaining"][i]))
    first = Counter(s["first"] or "PRE_S4_CANDIDATE" for s in samples)
    indep = {name: sum(1 for s in samples if s["flags"][name]) for name in PB_GATES}
    return {
        "STRONG_STATE": n,
        "PULLBACK_DETECTED": remain[1],
        "RESUMPTION_TRIGGERED": remain[2],
        "VOLUME_PASS": remain[3],
        "CANDLE_PASS": remain[4],
        "ATR_PASS": remain[5],
        "STRUCTURE_FOUND": remain[6],
        "STRUCTURE_MIN_PASS": remain[7],
        "STRUCTURE_MAX_ATR_PASS": remain[8],
        "PRE_S4_CANDIDATE": remain[8],
        "first_blocker": dict(first),
        "first_blocker_pct": {k: round(100.0 * v / n, 2) for k, v in first.items()},
        "independent_pass": indep,
        "independent_pass_pct": {k: round(100.0 * v / n, 2) for k, v in indep.items()},
    }


def feature_lists(rows: List[Dict[str, Any]]) -> Dict[str, List[float]]:
    keys = (
        "depth_atr",
        "depth_bps",
        "duration",
        "dist_ema9_bps",
        "dist_ema21_bps",
        "near_ema9_bps",
        "volume_ratio",
        "body",
        "loc",
        "roc1_bps",
        "roc3_bps",
        "atr_bps",
        "dist_atr",
        "dist_bps",
    )
    out: Dict[str, List[float]] = {k: [] for k in keys}
    for r in rows:
        pb, tq = r.get("pb") or {}, r.get("tq") or {}
        mapping = {
            "depth_atr": pb.get("depth_atr"),
            "depth_bps": pb.get("depth_bps"),
            "duration": pb.get("duration"),
            "dist_ema9_bps": pb.get("dist_ema9_bps"),
            "dist_ema21_bps": pb.get("dist_ema21_bps"),
            "near_ema9_bps": pb.get("near_ema9_bps"),
            "volume_ratio": tq.get("volume_ratio"),
            "body": tq.get("body"),
            "loc": tq.get("loc"),
            "roc1_bps": None if tq.get("roc1") is None else float(tq["roc1"]) * 10_000.0,
            "roc3_bps": None if tq.get("roc3_1m") is None else float(tq["roc3_1m"]) * 10_000.0,
            "atr_bps": tq.get("atr_bps"),
            "dist_atr": tq.get("dist_atr"),
            "dist_bps": tq.get("dist_bps"),
        }
        for k, v in mapping.items():
            if v is not None:
                out[k].append(float(v))
    return out


def analyze_window(
    one: pd.DataFrame,
    five_index: pd.DatetimeIndex,
    dirs: Dict[pd.Timestamp, Dict[str, Any]],
    cfg: Dict[str, Any],
    *,
    start_ts: pd.Timestamp,
) -> Dict[str, Any]:
    strong_rows: List[Dict[str, Any]] = []
    early_max_atr: List[Dict[str, Any]] = []
    old_break = 0
    dual_break = 0
    pullback_cands: List[Dict[str, Any]] = []
    unique_strong = {"STRONG_BULLISH": set(), "STRONG_BEARISH": set()}

    for i in range(25, len(one)):
        ts = one.index[i]
        if ts < start_ts:
            continue
        ts5 = last_closed_5m_ts(ts, five_index)
        if ts5 is None or ts5 not in dirs:
            continue
        new_dir = dirs[ts5]["new"]
        old_dir = dirs[ts5]["old"]
        state = str(new_dir.get("state") or "")
        old_state = str(old_dir.get("state") or "")
        sl = one.iloc[: i + 1]

        if state in {EARLY_BULLISH, EARLY_BEARISH}:
            side = "LONG" if state == EARLY_BULLISH else "SHORT"
            eg = evaluate_early_gates(sl, side=side, cfg=cfg)
            if eg["first"] == "STRUCTURE_MAX_ATR":
                early_max_atr.append(
                    {
                        "ts": str(ts),
                        "side": side,
                        "structure_distance_bps": eg["dist_bps"],
                        "ATR_bps": eg["atr_bps"],
                        "structure_distance_over_atr": None
                        if not eg["atr_bps"]
                        else None
                        if eg["dist_bps"] is None
                        else round(float(eg["dist_bps"]) / float(eg["atr_bps"]), 3),
                        "forward": forward_excursions(one, ts, side=side, close=float(eg["close"])),
                    }
                )
            if eg["pre_s4"]:
                dual_break += 1

        if old_state in {"BULLISH", "BEARISH"}:
            tq_old = trend_quality(sl, side="LONG" if old_state == "BULLISH" else "SHORT")
            if tq_old["trend_pre_s4"]:
                old_break += 1

        if state not in {STRONG_BULLISH, STRONG_BEARISH}:
            continue
        side = "LONG" if state == STRONG_BULLISH else "SHORT"
        unique_strong[state].add(ts5)
        tq = trend_quality(sl, side=side)
        if tq["trend_pre_s4"]:
            dual_break += 1
        ema9 = new_dir.get("ema9")
        ema21 = new_dir.get("ema21")
        pb = measure_pullback(sl, len(sl) - 1, side=side, ema9=ema9, ema21=ema21, atr14=float(tq["atr14"] or 0.0))
        gates = evaluate_pullback_gates(sl, side=side, ema9=ema9, ema21=ema21)
        fwd = forward_excursions(one, ts, side=side, close=float(tq["close"]))
        f15 = fwd.get("15") or {}
        fwd15 = f15.get("forward_return_bps")
        mfe15 = f15.get("mfe_bps")
        mae15 = f15.get("mae_bps")
        label = "weak"
        if fwd15 is not None and mfe15 is not None and mae15 is not None:
            if fwd15 >= 15.0 and mfe15 > mae15:
                label = "success"
            elif fwd15 <= -10.0 or mae15 >= mfe15:
                label = "fail"
        missed_breakout = not tq["breakout_price"]
        row = {
            "ts": str(ts),
            "state": state,
            "side": side,
            "score": new_dir.get("s9_direction_score"),
            "adx": new_dir.get("adx14"),
            "missed_breakout": missed_breakout,
            "label": label,
            "fwd15": fwd15,
            "mfe15": mfe15,
            "mae15": mae15,
            "obvious_15m": bool(fwd15 is not None and fwd15 >= 30.0),
            "noticeable_15m": bool(fwd15 is not None and fwd15 >= 15.0),
            "pb": pb,
            "tq": tq,
            "forward": fwd,
            "flags": gates["flags"],
            "first": gates["first"],
            "remaining": gates["remaining"],
            "pre_s4": gates["pre_s4"],
        }
        strong_rows.append(row)
        if gates["pre_s4"] and missed_breakout:
            pullback_cands.append(
                {
                    "timestamp": str(ts),
                    "direction": side,
                    "entry_reference": tq["close"],
                    "direction_score": new_dir.get("s9_direction_score"),
                    "ADX": new_dir.get("adx14"),
                    "pullback_depth_atr": None if not pb else round(float(pb["depth_atr"]), 3),
                    "pullback_depth_bps": None if not pb else round(float(pb["depth_bps"]), 2),
                    "pullback_duration_1m": None if not pb else pb["duration"],
                    "EMA9_distance_bps": None if not pb else round(float(pb["dist_ema9_bps"]), 2),
                    "EMA21_distance_bps": None if not pb else round(float(pb["dist_ema21_bps"]), 2),
                    "touched_ema9": None if not pb else pb["touched_ema9"],
                    "volume": None if tq["volume_ratio"] is None else round(float(tq["volume_ratio"]), 3),
                    "body": None if tq["body"] is None else round(float(tq["body"]), 3),
                    "close_location": None if tq["loc"] is None else round(float(tq["loc"]), 3),
                    "ATR_bps": round(float(tq["atr_bps"]), 3),
                    "structure_distance_bps": None if tq["dist_bps"] is None else round(float(tq["dist_bps"]), 2),
                    "structure_distance_atr": None if tq["dist_atr"] is None else round(float(tq["dist_atr"]), 3),
                    "future": {
                        h: {
                            "mfe_bps": None if rec.get("mfe_bps") is None else round(float(rec["mfe_bps"]), 2),
                            "mae_bps": None if rec.get("mae_bps") is None else round(float(rec["mae_bps"]), 2),
                            "fwd_bps": None if rec.get("forward_return_bps") is None else round(float(rec["forward_return_bps"]), 2),
                        }
                        for h, rec in fwd.items()
                    },
                }
            )

    missed = [r for r in strong_rows if r["missed_breakout"]]
    success = [r for r in missed if r["label"] == "success"]
    fail = [r for r in missed if r["label"] == "fail"]
    sf, ff = feature_lists(success), feature_lists(fail)
    sep = {k: _sep(sf[k], ff[k]) for k in sf}
    return {
        "s3_assumption": "TREND uses assumed strong_trend / aligned bias. Historical S3 unavailable.",
        "s4_note": "Historical microstructure unavailable. Stop at PRE_S4_CANDIDATE.",
        "old_breakout_pre_s4": old_break,
        "dual_mode_breakout_pre_s4": dual_break,
        "pullback_pre_s4": len(pullback_cands),
        "total_research_pre_s4": dual_break + len(pullback_cands),
        "strong_1m": {
            "ALL": len(strong_rows),
            "STRONG_BULLISH": sum(1 for r in strong_rows if r["state"] == STRONG_BULLISH),
            "STRONG_BEARISH": sum(1 for r in strong_rows if r["state"] == STRONG_BEARISH),
            "unique_5m": {k: len(v) for k, v in unique_strong.items()},
        },
        "missed_breakout": {
            "n": len(missed),
            "noticeable_15m_fwd_ge_15bps": sum(1 for r in missed if r["noticeable_15m"]),
            "obvious_15m_fwd_ge_30bps": sum(1 for r in missed if r["obvious_15m"]),
            "success_n": len(success),
            "fail_n": len(fail),
            "success_touch_ema9_pct": None
            if not success
            else round(100.0 * sum(1 for r in success if (r.get("pb") or {}).get("touched_ema9")) / len(success), 2),
            "fail_touch_ema9_pct": None
            if not fail
            else round(100.0 * sum(1 for r in fail if (r.get("pb") or {}).get("touched_ema9")) / len(fail), 2),
            "success_touch_ema21_pct": None
            if not success
            else round(100.0 * sum(1 for r in success if (r.get("pb") or {}).get("touched_ema21")) / len(success), 2),
            "fail_touch_ema21_pct": None
            if not fail
            else round(100.0 * sum(1 for r in fail if (r.get("pb") or {}).get("touched_ema21")) / len(fail), 2),
        },
        "feature_separation": sep,
        "pullback_funnel": pb_funnel(strong_rows),
        "pullback_candidates": pullback_cands,
        "pullback_candidate_forward": summarize_fwd(
            [{"forward": c["future"] and {h: {"forward_return_bps": v["fwd_bps"], "mfe_bps": v["mfe_bps"], "mae_bps": v["mae_bps"]} for h, v in c["future"].items()}} for c in pullback_cands]
        ),
        "early_structure_max_atr": {
            "n": len(early_max_atr),
            "distance_bps": _pcts([float(x["structure_distance_bps"]) for x in early_max_atr if x["structure_distance_bps"] is not None]),
            "atr_bps": _pcts([float(x["ATR_bps"]) for x in early_max_atr if x["ATR_bps"] is not None]),
            "distance_over_atr": _pcts(
                [float(x["structure_distance_over_atr"]) for x in early_max_atr if x["structure_distance_over_atr"] is not None]
            ),
            "forward": summarize_fwd(early_max_atr),
            "share_fwd15_negative": None
            if not early_max_atr
            else round(
                100.0
                * sum(1 for x in early_max_atr if ((x.get("forward") or {}).get("15") or {}).get("forward_return_bps", 0) < 0)
                / len(early_max_atr),
                2,
            ),
            "samples": early_max_atr[:12],
        },
        "research_rule": {
            "lookback_1m": PB_LOOKBACK,
            "min_depth_atr": PB_MIN_DEPTH_ATR,
            "max_depth_atr": PB_MAX_DEPTH_ATR,
            "duration_1m": [PB_MIN_BARS, PB_MAX_BARS],
            "near_ema9_bps": PB_NEAR_EMA9_BPS,
            "must_hold_5m_ema21": True,
            "must_reclaim_ema9": True,
            "forbid_20bar_breakout_chase": True,
            "volume": 1.30,
            "body": 0.55,
            "close_location": 0.65,
            "atr_bps": [5, 50],
            "stop": "MICRO_SWING_1X1 6bps / 1.2ATR unchanged",
            "early_forbidden": True,
            "not_optimized": True,
        },
    }


def _origin_set(side: str) -> set:
    return {EARLY_BULLISH, STRONG_BULLISH, "BULLISH"} if side == "LONG" else {EARLY_BEARISH, STRONG_BEARISH, "BEARISH"}


def _opp_early_strong(side: str) -> set:
    return {EARLY_BEARISH, STRONG_BEARISH} if side == "LONG" else {EARLY_BULLISH, STRONG_BULLISH}


def old_flip(side: str, old_state: str) -> bool:
    return old_state == ("BEARISH" if side == "LONG" else "BULLISH")


def current_flip(side: str, new_state: str) -> bool:
    return direction_flip_exit(side=side, prev_state="", new_state=new_state)


def persistent_flip(side: str, prev_new: str, new_state: str) -> bool:
    opp = _opp_early_strong(side)
    strong_opp = STRONG_BEARISH if side == "LONG" else STRONG_BULLISH
    if new_state == strong_opp or new_state == ("BEARISH" if side == "LONG" else "BULLISH"):
        return True
    if new_state in opp and prev_new in opp:
        return True
    return False


def stop_hit(side: str, bar: pd.Series, stop: Optional[float], tp: Optional[float]) -> Optional[str]:
    if stop is None:
        return None
    if side == "LONG":
        if float(bar["low"]) <= float(stop):
            return "STOP"
        if tp is not None and float(bar["high"]) >= float(tp):
            return "TAKE_PROFIT"
    else:
        if float(bar["high"]) >= float(stop):
            return "STOP"
        if tp is not None and float(bar["low"]) <= float(tp):
            return "TAKE_PROFIT"
    return None


def walk_exits(
    *,
    series: List[Tuple[Any, str, str]],
    one: pd.DataFrame,
    five: pd.DataFrame,
    start_i: int,
    side: str,
    stop: Optional[float],
    tp: Optional[float],
    model: str,
) -> Dict[str, Any]:
    ts0, old0, new0 = series[start_i]
    prev_new = new0
    exit_ts = None
    reason = None
    for j in range(start_i + 1, len(series)):
        tsj, old_s, new_s = series[j]
        mins = (tsj - ts0).total_seconds() / 60.0
        # 1m stop/tp between previous 5m and this 5m
        win = one[(one.index > series[j - 1][0]) & (one.index <= tsj)]
        for _, bar in win.iterrows():
            hit = stop_hit(side, bar, stop, tp)
            if hit:
                exit_ts, reason = bar.name, hit
                break
        if exit_ts is not None:
            break
        if model == "OLD" and old_flip(side, old_s):
            exit_ts, reason = tsj, "DIRECTION_FLIP"
            break
        if model == "CURRENT" and current_flip(side, new_s):
            exit_ts, reason = tsj, "DIRECTION_FLIP"
            break
        if model == "PERSISTENT_EARLY" and persistent_flip(side, prev_new, new_s):
            exit_ts, reason = tsj, "DIRECTION_FLIP"
            break
        if mins >= 30:
            exit_ts, reason = tsj, "TIME_EXIT"
            break
        prev_new = new_s
    if exit_ts is None:
        exit_ts, reason = series[-1][0], "TIME_EXIT"
    hold = (pd.Timestamp(exit_ts) - ts0).total_seconds() / 60.0
    # next 5m states after exit
    exit_pos = next((k for k, row in enumerate(series) if row[0] >= pd.Timestamp(exit_ts)), len(series) - 1)
    nxt = [series[k][2] for k in range(exit_pos + 1, min(exit_pos + 3, len(series)))]
    origin = _origin_set(side)
    flipped_early = reason == "DIRECTION_FLIP" and model in {"CURRENT", "PERSISTENT_EARLY"}
    if model == "CURRENT" and exit_pos < len(series):
        flipped_early = reason == "DIRECTION_FLIP" and series[exit_pos][2] in {EARLY_BULLISH, EARLY_BEARISH}
    if model == "PERSISTENT_EARLY" and exit_pos < len(series):
        flipped_early = reason == "DIRECTION_FLIP" and series[exit_pos][2] in {EARLY_BULLISH, EARLY_BEARISH}
    px = float(five.loc[ts0, "close"]) if ts0 in five.index else None
    exit_px = None
    if pd.Timestamp(exit_ts) in one.index:
        exit_px = float(one.loc[pd.Timestamp(exit_ts), "close"])
    elif pd.Timestamp(exit_ts) in five.index:
        exit_px = float(five.loc[pd.Timestamp(exit_ts), "close"])
    cont = {}
    if exit_px and exit_px > 0 and pd.Timestamp(exit_ts) in one.index:
        # continuation in the exit direction (against the old position)
        cont = forward_excursions(one, pd.Timestamp(exit_ts), side=("SHORT" if side == "LONG" else "LONG"), close=exit_px)
    return {
        "exit_ts": str(exit_ts),
        "reason": reason,
        "hold_min": hold,
        "early_flip": bool(flipped_early),
        "reversed_5m": bool(flipped_early and nxt and (nxt[0] == "NEUTRAL" or nxt[0] in origin)),
        "reversed_10m": bool(flipped_early and nxt and any(s == "NEUTRAL" or s in origin for s in nxt[:2])),
        "exit_continue": cont,
        "entry_px": px,
    }


def exit_compare(five: pd.DataFrame, one: pd.DataFrame, dirs: Dict[pd.Timestamp, Dict[str, Any]]) -> Dict[str, Any]:
    series = [(ts, dirs[ts]["old"]["state"], dirs[ts]["new"]["state"]) for ts in five.index if ts in dirs]
    models = ("OLD", "CURRENT", "PERSISTENT_EARLY")
    bags: Dict[str, List[Dict[str, Any]]] = {m: [] for m in models}
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
        sl = one[one.index <= ts]
        tq = trend_quality(sl, side=side) if sl is not None and len(sl) >= 15 else None
        stop = None
        tp = None
        if tq and tq["structure_found"] and tq["dist_bps"] is not None and tq["close"]:
            # use swing if min+max valid; otherwise still attach raw swing for stop replay only if validate passed
            swing = find_micro_swing(sl, side=side, lookback=10)
            if swing and tq["structure_min"] and tq["structure_max"]:
                stop = float(swing["price"])
                r = abs(float(tq["close"]) - stop)
                tp = float(tq["close"]) + (1.5 * r if side == "LONG" else -1.5 * r)
        later = ts
        for model in models:
            rec = walk_exits(series=series, one=one, five=five, start_i=i, side=side, stop=stop, tp=tp, model=model)
            rec["side"] = side
            rec["entry_ts"] = str(ts)
            bags[model].append(rec)
            later = max(later, pd.Timestamp(rec["exit_ts"]))
        nxt = next((k for k, row in enumerate(series) if row[0] > later), i + 1)
        i = max(nxt, i + 1)

    def pack(name: str, rows: List[Dict[str, Any]]) -> Dict[str, Any]:
        n = len(rows)
        reasons = Counter(r["reason"] for r in rows)
        holds = [float(r["hold_min"]) for r in rows]
        early_n = sum(1 for r in rows if r["early_flip"])
        cont = summarize_fwd([{"forward": r.get("exit_continue") or {}} for r in rows if r.get("reason") == "DIRECTION_FLIP"])
        return {
            "model": name,
            "exit_count": n,
            "average_hold_min": mean_or_none(holds),
            "direction_exit_count": reasons.get("DIRECTION_FLIP", 0),
            "time_exit_count": reasons.get("TIME_EXIT", 0),
            "stop_exit_count": reasons.get("STOP", 0),
            "tp_exit_count": reasons.get("TAKE_PROFIT", 0),
            "EARLY_FLIP_EXIT_COUNT": early_n,
            "EARLY_FLIP_REVERSED_WITHIN_5M": sum(1 for r in rows if r["reversed_5m"]),
            "EARLY_FLIP_REVERSED_WITHIN_10M": sum(1 for r in rows if r["reversed_10m"]),
            "whipsaw_5m_pct": None if not early_n else round(100.0 * sum(1 for r in rows if r["reversed_5m"]) / early_n, 2),
            "whipsaw_10m_pct": None if not early_n else round(100.0 * sum(1 for r in rows if r["reversed_10m"]) / early_n, 2),
            "after_direction_exit_continue": cont,
        }

    out = {m: pack(m, bags[m]) for m in models}
    # NEW vs OLD hold lead for CURRENT and PERSISTENT
    for m in ("CURRENT", "PERSISTENT_EARLY"):
        deltas = []
        for a, b in zip(bags["OLD"], bags[m]):
            da = (pd.Timestamp(b["exit_ts"]) - pd.Timestamp(a["exit_ts"])).total_seconds() / 60.0
            deltas.append(da)
        earlier = [d for d in deltas if d < -1e-9]
        out[m]["NEW_earlier"] = sum(1 for d in deltas if d < -1e-9)
        out[m]["NEW_later"] = sum(1 for d in deltas if d > 1e-9)
        out[m]["same_exit"] = sum(1 for d in deltas if abs(d) <= 1e-9)
        out[m]["avg_early_minutes"] = None if not earlier else round(-sum(earlier) / len(earlier), 2)
    return out


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
    w24 = analyze_window(one_c, five_c.index, dirs, cfg, start_ts=cut24)
    w7 = analyze_window(one_c, five_c.index, dirs, cfg, start_ts=cut7)
    five24 = five_c[five_c.index >= cut24 - pd.Timedelta(hours=2)]
    exits24 = exit_compare(five24, one_c, dirs)
    exits7 = exit_compare(five_c, one_c, dirs)
    report = {
        "symbol": "BTC-USDT-SWAP",
        "source": "OKX public OHLCV via ccxt. Read-only.",
        "write_requests": 0,
        "parameters_changed": False,
        "production_strategy_changed": False,
        "end_ts": str(now),
        "24h": w24,
        "7d": w7,
        "exit_24h": exits24,
        "exit_7d": exits7,
        "frequency": {
            "dual_breakout_7d": w7["dual_mode_breakout_pre_s4"],
            "pullback_7d": w7["pullback_pre_s4"],
            "total_research_7d": w7["total_research_pre_s4"],
            "label_breakout_only": frequency_label(w7["dual_mode_breakout_pre_s4"]),
            "label_with_pullback": frequency_label(w7["total_research_pre_s4"]),
        },
    }
    print(json.dumps(report, ensure_ascii=False, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
