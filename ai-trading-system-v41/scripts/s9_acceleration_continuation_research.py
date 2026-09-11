"""Read-only S9 STRONG acceleration-continuation research.

Does not modify production strategy, parameters, exits, or place orders.
Does not relax EARLY, TREND breakout, volume, candle, ATR, or stop.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

from s9_early_funnel_audit import (  # noqa: E402
    fetch_ccxt_span,
    forward_excursions,
    last_closed_5m_ts,
    mean_or_none,
    precompute_5m,
    summarize_fwd,
)
from s9_pullback_resumption_research import trend_quality  # noqa: E402
from src.runtime.config_loader import load_strategy_config
from src.strategies.s9_momentum import STRONG_BEARISH, STRONG_BULLISH, ema

FEATURE_KEYS = (
    "roc1_bps",
    "roc2_bps",
    "roc3_bps",
    "roc5_bps",
    "slope3_bps",
    "slope5_bps",
    "consec_closes",
    "consec_candles",
    "dist_ema5_bps",
    "dist_ema9_bps",
    "dist_ema20_bps",
    "ema5_slope_bps",
    "ema9_slope_bps",
    "ema5_accel_bps",
    "ema9_accel_bps",
    "roc3_accel_bps",
    "momentum_acceleration_score",
    "body",
    "loc",
    "range_atr",
    "volume_ratio",
    "atr_bps",
    "cum_range3_atr",
    "dir_move5_bps",
    "eff3",
    "eff5",
    "dist_breakout_bps",
    "pause_duration",
    "pause_range_atr",
    "pause_ctr_atr",
    "structure_dist_atr",
)


def _pcts(vals: List[float]) -> Dict[str, Optional[float]]:
    if not vals:
        return {"n": 0, "p25": None, "p50": None, "p75": None, "mean": None}
    s = sorted(vals)
    n = len(s)

    def q(p: float) -> float:
        if n == 1:
            return round(s[0], 4)
        return round(s[min(n - 1, max(0, int(round((n - 1) * p))))], 4)

    return {"n": n, "p25": q(0.25), "p50": q(0.50), "p75": q(0.75), "mean": mean_or_none(s)}


def _sep(success: List[float], fail: List[float]) -> Dict[str, Any]:
    a, b = _pcts(success), _pcts(fail)
    if len(success) < 25 or len(fail) < 25:
        return {
            "success": a,
            "fail": b,
            "meaningful": False,
            "grade": "insufficient_n",
            "median_diff": None,
            "rel_iqr": 0.0,
            "iqr_no_overlap": False,
            "median_outside_fail_iqr": False,
        }
    sm, fm = a["p50"], b["p50"]
    iqr = (b["p75"] - b["p25"]) if b["p25"] is not None and b["p75"] is not None else 0.0
    if iqr <= 1e-12:
        iqr = 1e-12
    outside = sm < b["p25"] or sm > b["p75"]
    no_iqr_overlap = a["p25"] > b["p75"] or a["p75"] < b["p25"]
    rel = abs(sm - fm) / iqr
    if no_iqr_overlap:
        grade = "STRONG"
        meaningful = True
    elif outside and rel >= 0.50:
        grade = "MODERATE"
        meaningful = True
    elif rel >= 0.35:
        grade = "WEAK"
        meaningful = False
    else:
        grade = "NONE"
        meaningful = False
    return {
        "success": a,
        "fail": b,
        "meaningful": meaningful,
        "grade": grade,
        "median_diff": round(sm - fm, 4),
        "rel_iqr": round(rel, 3),
        "iqr_no_overlap": no_iqr_overlap,
        "median_outside_fail_iqr": outside,
    }


def _roc(close: pd.Series, i: int, n: int) -> Optional[float]:
    if i < n:
        return None
    prev = float(close.iloc[i - n])
    if prev == 0:
        return None
    return (float(close.iloc[i]) - prev) / prev * 10_000.0


def _efficiency(close: pd.Series, i: int, n: int) -> Optional[float]:
    if i < n:
        return None
    num = abs(float(close.iloc[i]) - float(close.iloc[i - n]))
    den = 0.0
    for j in range(i - n + 1, i + 1):
        den += abs(float(close.iloc[j]) - float(close.iloc[j - 1]))
    if den <= 0:
        return None
    return num / den


def _consec(one: pd.DataFrame, i: int, *, side: str, mode: str) -> int:
    n = 0
    j = i
    while j > 0:
        c = float(one["close"].iloc[j])
        if mode == "close":
            prev = float(one["close"].iloc[j - 1])
            ok = c > prev if side == "LONG" else c < prev
        else:
            o = float(one["open"].iloc[j])
            ok = c > o if side == "LONG" else c < o
        if not ok:
            break
        n += 1
        j -= 1
    return n


def _pause(one: pd.DataFrame, i: int, *, side: str, atr14: float) -> Dict[str, Any]:
    out = {
        "pause_detected": False,
        "pause_duration": None,
        "pause_range_atr": None,
        "pause_ctr_atr": None,
    }
    if i < 6 or atr14 <= 0:
        return out
    best = None
    for dur in range(1, 6):
        w = one.iloc[i - dur : i]
        hi = float(w["high"].max())
        lo = float(w["low"].min())
        rng_atr = (hi - lo) / atr14
        first = float(w["close"].iloc[0])
        last = float(w["close"].iloc[-1])
        ctr = (last - first) / atr14 if side == "LONG" else (first - last) / atr14
        # pause: compressed, little/no trend progress (ctr <= 0.15 ATR against or flat)
        if rng_atr <= 0.55 and ctr <= 0.15:
            score = rng_atr + max(0.0, -ctr)
            if best is None or score < best[0]:
                best = (score, dur, rng_atr, abs(min(ctr, 0.0)))
    if best:
        out.update(
            {
                "pause_detected": True,
                "pause_duration": best[1],
                "pause_range_atr": best[2],
                "pause_ctr_atr": best[3],
            }
        )
    return out


def _local_structure(one: pd.DataFrame, i: int, *, side: str, level: Optional[float], close: float) -> Dict[str, Any]:
    prev = one.iloc[max(0, i - 5) : i]
    if len(prev) < 2:
        return {
            "lower_high": False,
            "lower_low": False,
            "higher_high": False,
            "higher_low": False,
            "local_break_k3": False,
            "local_break_k5": False,
            "local_structure_break": False,
        }
    h = float(one["high"].iloc[i])
    l = float(one["low"].iloc[i])
    prev_h_max = float(prev["high"].max())
    prev_l_min = float(prev["low"].min())
    k3 = prev.iloc[-min(3, len(prev)) :]
    k3_high = float(k3["high"].max())
    k3_low = float(k3["low"].min())
    if side == "SHORT":
        lh = h < prev_h_max
        ll = l < prev_l_min
        local3 = close < k3_low
        local5 = close < prev_l_min
        no20 = level is None or close > float(level)
        brk = bool((local3 or local5) and no20)
        return {
            "lower_high": lh,
            "lower_low": ll,
            "higher_high": False,
            "higher_low": False,
            "local_break_k3": local3 and no20,
            "local_break_k5": local5 and no20,
            "local_structure_break": brk and lh,
        }
    hh = h > prev_h_max
    hl = l > prev_l_min
    local3 = close > k3_high
    local5 = close > prev_h_max
    no20 = level is None or close < float(level)
    brk = bool((local3 or local5) and no20)
    return {
        "lower_high": False,
        "lower_low": False,
        "higher_high": hh,
        "higher_low": hl,
        "local_break_k3": local3 and no20,
        "local_break_k5": local5 and no20,
        "local_structure_break": brk and hl,
    }


def precompute_1m(one: pd.DataFrame) -> Dict[str, pd.Series]:
    close = one["close"].astype(float)
    return {
        "ema5": ema(close, 5),
        "ema9": ema(close, 9),
        "ema20": ema(close, 20),
        "atr14": __import__("src.strategies.s9_momentum", fromlist=["atr"]).atr(one, 14),
    }


def features_at(
    one: pd.DataFrame,
    i: int,
    *,
    side: str,
    ind: Dict[str, pd.Series],
    tq: Dict[str, Any],
) -> Dict[str, Any]:
    close = one["close"].astype(float)
    c = float(close.iloc[i])
    atr14 = float(ind["atr14"].iloc[i] or 0.0)
    ema5 = float(ind["ema5"].iloc[i])
    ema9 = float(ind["ema9"].iloc[i])
    ema20 = float(ind["ema20"].iloc[i])
    sign = 1.0 if side == "LONG" else -1.0
    roc = {n: _roc(close, i, n) for n in (1, 2, 3, 5)}
    roc3_lag = _roc(close, i - 3, 3) if i >= 6 else None
    roc3_accel = None if roc[3] is None or roc3_lag is None else roc[3] - roc3_lag
    e5s = None if i < 3 else (ema5 - float(ind["ema5"].iloc[i - 3])) / c * 10_000.0
    e9s = None if i < 3 else (ema9 - float(ind["ema9"].iloc[i - 3])) / c * 10_000.0
    e5_prev = None if i < 6 else (float(ind["ema5"].iloc[i - 3]) - float(ind["ema5"].iloc[i - 6])) / c * 10_000.0
    e9_prev = None if i < 6 else (float(ind["ema9"].iloc[i - 3]) - float(ind["ema9"].iloc[i - 6])) / c * 10_000.0
    e5a = None if e5s is None or e5_prev is None else e5s - e5_prev
    e9a = None if e9s is None or e9_prev is None else e9s - e9_prev
    mom = 0.0
    parts = 0
    for raw in (roc3_accel, e5a, e9a):
        if raw is not None:
            mom += sign * float(raw)
            parts += 1
    mom_score = mom / parts if parts else None
    last = one.iloc[i]
    rng = float(last["high"]) - float(last["low"])
    rng3 = float(one["high"].iloc[max(0, i - 2) : i + 1].max()) - float(one["low"].iloc[max(0, i - 2) : i + 1].min())
    dir5 = None if i < 5 else sign * (c - float(close.iloc[i - 5])) / c * 10_000.0
    level = tq.get("level")
    if level is None:
        dist_bo = None
    elif side == "SHORT":
        dist_bo = (c - float(level)) / c * 10_000.0
    else:
        dist_bo = (float(level) - c) / c * 10_000.0
    pause = _pause(one, i, side=side, atr14=atr14)
    loc = _local_structure(one, i, side=side, level=level, close=c)
    resume = bool(pause["pause_detected"] and ((c > float(last["open"])) if side == "LONG" else (c < float(last["open"]))))
    return {
        "roc1_bps": roc[1],
        "roc2_bps": roc[2],
        "roc3_bps": roc[3],
        "roc5_bps": roc[5],
        "slope3_bps": None if i < 3 else (c - float(close.iloc[i - 3])) / 3.0 / c * 10_000.0,
        "slope5_bps": None if i < 5 else (c - float(close.iloc[i - 5])) / 5.0 / c * 10_000.0,
        "consec_closes": _consec(one, i, side=side, mode="close"),
        "consec_candles": _consec(one, i, side=side, mode="candle"),
        "dist_ema5_bps": sign * (c - ema5) / c * 10_000.0,
        "dist_ema9_bps": sign * (c - ema9) / c * 10_000.0,
        "dist_ema20_bps": sign * (c - ema20) / c * 10_000.0,
        "ema5_slope_bps": None if e5s is None else sign * e5s,
        "ema9_slope_bps": None if e9s is None else sign * e9s,
        "ema5_accel_bps": None if e5a is None else sign * e5a,
        "ema9_accel_bps": None if e9a is None else sign * e9a,
        "roc3_accel_bps": None if roc3_accel is None else sign * roc3_accel,
        "momentum_acceleration_score": mom_score,
        "body": tq.get("body"),
        "loc": tq.get("loc"),
        "range_atr": None if atr14 <= 0 else rng / atr14,
        "volume_ratio": tq.get("volume_ratio"),
        "atr_bps": tq.get("atr_bps"),
        "cum_range3_atr": None if atr14 <= 0 else rng3 / atr14,
        "dir_move5_bps": dir5,
        "eff3": _efficiency(close, i, 3),
        "eff5": _efficiency(close, i, 5),
        "dist_breakout_bps": dist_bo,
        "pause_detected": pause["pause_detected"],
        "pause_duration": pause["pause_duration"],
        "pause_range_atr": pause["pause_range_atr"],
        "pause_ctr_atr": pause["pause_ctr_atr"],
        "pause_then_resume": resume,
        **loc,
        "ema5": ema5,
        "ema9": ema9,
        "ema20": ema20,
        "atr14": atr14,
        "previous20_level": level,
        "structure_dist_atr": tq.get("dist_atr"),
    }


def _vals(rows: List[Dict[str, Any]], key: str) -> List[float]:
    out = []
    for r in rows:
        v = (r.get("feat") or {}).get(key)
        if v is not None:
            out.append(float(v))
    return out


def _bool_rate(rows: List[Dict[str, Any]], key: str) -> Optional[float]:
    if not rows:
        return None
    return round(100.0 * sum(1 for r in rows if (r.get("feat") or {}).get(key)) / len(rows), 2)


def analyze_window(
    one: pd.DataFrame,
    five_index: pd.DatetimeIndex,
    dirs: Dict[pd.Timestamp, Dict[str, Any]],
    ind: Dict[str, pd.Series],
    *,
    start_ts: pd.Timestamp,
) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    rows: List[Dict[str, Any]] = []
    breakout_n = 0
    for i in range(25, len(one)):
        ts = one.index[i]
        if ts < start_ts:
            continue
        ts5 = last_closed_5m_ts(ts, five_index)
        if ts5 is None or ts5 not in dirs:
            continue
        new_dir = dirs[ts5]["new"]
        state = str(new_dir.get("state") or "")
        if state not in {STRONG_BULLISH, STRONG_BEARISH}:
            continue
        side = "LONG" if state == STRONG_BULLISH else "SHORT"
        sl = one.iloc[: i + 1]
        tq = trend_quality(sl, side=side)
        if tq["trend_pre_s4"]:
            breakout_n += 1
        if tq["breakout_price"]:
            continue
        feat = features_at(one, i, side=side, ind=ind, tq=tq)
        fwd = forward_excursions(one, ts, side=side, close=float(tq["close"]))
        f15 = fwd.get("15") or {}
        fwd15 = f15.get("forward_return_bps")
        mfe15 = f15.get("mfe_bps")
        mae15 = f15.get("mae_bps")
        success = bool(fwd15 is not None and fwd15 >= 15.0)
        strong30 = bool(fwd15 is not None and fwd15 >= 30.0)
        adverse = bool(mae15 is not None and mfe15 is not None and mae15 >= mfe15)
        fail = (not success) or adverse and not success
        ratio = None
        if mfe15 is not None and mae15 is not None:
            ratio = (mfe15 / mae15) if mae15 > 1e-9 else (10.0 if mfe15 > 0 else 0.0)
        feat["mfe_mae_ratio_15"] = ratio
        rows.append(
            {
                "ts": ts,
                "state": state,
                "side": side,
                "score": new_dir.get("s9_direction_score"),
                "adx": new_dir.get("adx14"),
                "close": tq["close"],
                "feat": feat,
                "tq": tq,
                "forward": fwd,
                "fwd15": fwd15,
                "mfe15": mfe15,
                "mae15": mae15,
                "success": success,
                "strong30": strong30,
                "adverse": adverse,
                "fail": fail,
            }
        )
    success = [r for r in rows if r["success"]]
    fail = [r for r in rows if r["fail"]]
    strong30 = [r for r in rows if r["strong30"]]
    sep = {k: _sep(_vals(success, k), _vals(fail, k)) for k in FEATURE_KEYS}
    ranked = sorted(
        sep.items(),
        key=lambda kv: (
            {"STRONG": 3, "MODERATE": 2, "WEAK": 1, "NONE": 0, "insufficient_n": -1}[kv[1]["grade"]],
            abs(kv[1]["rel_iqr"] or 0),
        ),
        reverse=True,
    )
    bool_keys = (
        "pause_detected",
        "pause_then_resume",
        "local_structure_break",
        "local_break_k3",
        "local_break_k5",
        "lower_high",
        "lower_low",
        "higher_high",
        "higher_low",
    )
    bool_cmp = {
        k: {
            "success_pct": _bool_rate(success, k),
            "fail_pct": _bool_rate(fail, k),
            "delta_pp": None
            if not success or not fail
            else round((_bool_rate(success, k) or 0) - (_bool_rate(fail, k) or 0), 2),
        }
        for k in bool_keys
    }
    stop_s = {
        "n": len(success),
        "STRUCTURE_FOUND": sum(1 for r in success if r["tq"]["structure_found"]),
        "MIN_DISTANCE_PASS": sum(1 for r in success if r["tq"]["structure_min"]),
        "MAX_ATR_PASS": sum(1 for r in success if r["tq"]["structure_max"]),
        "stop_ok": sum(1 for r in success if r["tq"]["structure_found"] and r["tq"]["structure_min"] and r["tq"]["structure_max"]),
    }
    stop_s["stop_ok_pct"] = None if not success else round(100.0 * stop_s["stop_ok"] / len(success), 2)
    stop_all = {
        "n": len(rows),
        "STRUCTURE_FOUND": sum(1 for r in rows if r["tq"]["structure_found"]),
        "MIN_DISTANCE_PASS": sum(1 for r in rows if r["tq"]["structure_min"]),
        "MAX_ATR_PASS": sum(1 for r in rows if r["tq"]["structure_max"]),
        "stop_ok": sum(1 for r in rows if r["tq"]["structure_found"] and r["tq"]["structure_min"] and r["tq"]["structure_max"]),
    }
    stop_all["stop_ok_pct"] = None if not rows else round(100.0 * stop_all["stop_ok"] / len(rows), 2)
    summary = {
        "strong_breakout_fail_n": len(rows),
        "success_15_n": len(success),
        "strong_30_n": len(strong30),
        "fail_n": len(fail),
        "dual_breakout_pre_s4": breakout_n,
        "feature_separation": sep,
        "top_features": [
            {"feature": k, "grade": v["grade"], "meaningful": v["meaningful"], "median_diff": v["median_diff"], "rel_iqr": v["rel_iqr"], "success": v["success"], "fail": v["fail"]}
            for k, v in ranked[:8]
        ],
        "meaningful_features": [k for k, v in ranked if v["meaningful"]],
        "boolean_rates": bool_cmp,
        "breakout_distance": {
            "all": _pcts(_vals(rows, "dist_breakout_bps")),
            "success": _pcts(_vals(success, "dist_breakout_bps")),
            "fail": _pcts(_vals(fail, "dist_breakout_bps")),
            "success_within_5bps_pct": None
            if not success
            else round(100.0 * sum(1 for r in success if (r["feat"].get("dist_breakout_bps") or 99) <= 5) / len(success), 2),
            "fail_within_5bps_pct": None
            if not fail
            else round(100.0 * sum(1 for r in fail if (r["feat"].get("dist_breakout_bps") or 99) <= 5) / len(fail), 2),
        },
        "local_structure_coverage": {
            "success_local_break_pct": bool_cmp["local_structure_break"]["success_pct"],
            "fail_local_break_pct": bool_cmp["local_structure_break"]["fail_pct"],
            "success_local_k3_pct": bool_cmp["local_break_k3"]["success_pct"],
            "fail_local_k3_pct": bool_cmp["local_break_k3"]["fail_pct"],
        },
        "stop_feasibility_success": stop_s,
        "stop_feasibility_all_missed": stop_all,
        "forward_success": summarize_fwd(success),
        "forward_fail": summarize_fwd(fail),
        "forward_all_missed": summarize_fwd(rows),
        "forward_strong30": summarize_fwd(strong30),
    }
    return summary, rows


def yesterday_tape(
    one: pd.DataFrame,
    five_index: pd.DatetimeIndex,
    dirs: Dict[pd.Timestamp, Dict[str, Any]],
    ind: Dict[str, pd.Series],
) -> List[Dict[str, Any]]:
    start = pd.Timestamp("2026-09-10 12:15:00+00:00")
    end = pd.Timestamp("2026-09-10 12:50:00+00:00")
    out = []
    for i in range(25, len(one)):
        ts = one.index[i]
        if ts < start or ts > end:
            continue
        ts5 = last_closed_5m_ts(ts, five_index)
        d = dirs.get(ts5, {}) if ts5 is not None else {}
        new_dir = d.get("new") or {}
        state = str(new_dir.get("state") or "UNAVAILABLE")
        side = "SHORT" if state == STRONG_BEARISH else ("LONG" if state == STRONG_BULLISH else "SHORT")
        sl = one.iloc[: i + 1]
        tq = trend_quality(sl, side=side)
        feat = features_at(one, i, side=side, ind=ind, tq=tq)
        out.append(
            {
                "ts_utc": str(ts),
                "ts_cst": str(ts.tz_convert("Asia/Shanghai")) if getattr(ts, "tzinfo", None) else str(ts),
                "state": state,
                "score": new_dir.get("s9_direction_score"),
                "ADX": new_dir.get("adx14"),
                "close": tq["close"],
                "previous20low": feat.get("previous20_level") if side == "SHORT" else None,
                "previous20high": feat.get("previous20_level") if side == "LONG" else None,
                "dist_breakout_bps": feat.get("dist_breakout_bps"),
                "breakout_price": tq["breakout_price"],
                "ROC1": feat.get("roc1_bps"),
                "ROC3": feat.get("roc3_bps"),
                "ROC5": feat.get("roc5_bps"),
                "EMA5": feat.get("ema5"),
                "EMA9": feat.get("ema9"),
                "ema5_slope_bps": feat.get("ema5_slope_bps"),
                "ema9_slope_bps": feat.get("ema9_slope_bps"),
                "roc3_accel": feat.get("roc3_accel_bps"),
                "mom_accel": feat.get("momentum_acceleration_score"),
                "lower_high": feat.get("lower_high"),
                "lower_low": feat.get("lower_low"),
                "local_structure_break": feat.get("local_structure_break"),
                "pause_then_resume": feat.get("pause_then_resume"),
                "volume": tq.get("volume_ratio"),
                "body": tq.get("body"),
                "close_location": tq.get("loc"),
                "ATR_bps": tq.get("atr_bps"),
                "structure_distance_bps": tq.get("dist_bps"),
                "structure_ok": bool(tq["structure_found"] and tq["structure_min"] and tq["structure_max"]),
                "quality_except_breakout": bool(tq["volume_pass"] and tq["candle_pass"] and tq["atr_pass"] and tq["structure_found"] and tq["structure_min"] and tq["structure_max"]),
            }
        )
    return out


def frequency_label(n7: int) -> str:
    per_day = n7 / 7.0
    if per_day >= 6:
        return "HIGH_FREQUENCY"
    if per_day >= 1:
        return "MEDIUM_FREQUENCY"
    return "LOW_FREQUENCY"


def main() -> int:
    cfg = load_strategy_config("S9")
    import ccxt  # type: ignore

    exchange = ccxt.okx({"enableRateLimit": True, "options": {"defaultType": "swap"}})
    one_all = fetch_ccxt_span(exchange, "BTC/USDT:USDT", "1m", 7 * 24 * 60 * 60 * 1000 + 240 * 60 * 1000)
    five_all = fetch_ccxt_span(exchange, "BTC/USDT:USDT", "5m", 7 * 24 * 60 * 60 * 1000 + 160 * 5 * 60 * 1000)
    from src.adapters.okx_market_data import split_closed_bars

    one_c, _, _ = split_closed_bars(one_all, timeframe="1m")
    five_c, _, _ = split_closed_bars(five_all, timeframe="5m")
    if one_c is None or one_c.empty:
        one_c = one_all
    if five_c is None or five_c.empty:
        five_c = five_all
    dirs = precompute_5m(five_c, cfg)
    ind = precompute_1m(one_c)
    now = one_c.index[-1]
    cut24 = now - pd.Timedelta(hours=24)
    cut7 = now - pd.Timedelta(days=7)
    s24, _rows24 = analyze_window(one_c, five_c.index, dirs, ind, start_ts=cut24)
    s7, _rows7 = analyze_window(one_c, five_c.index, dirs, ind, start_ts=cut7)
    tape = yesterday_tape(one_c, five_c.index, dirs, ind)
    meaningful = s7["meaningful_features"]
    report = {
        "symbol": "BTC-USDT-SWAP",
        "source": "OKX public OHLCV. Read-only.",
        "write_requests": 0,
        "production_strategy_changed": False,
        "parameters_changed": False,
        "historical_microstructure": "unavailable",
        "end_ts": str(now),
        "label_note": "SUCCESS/FAIL labels use 15m future return for research only. Not a live feature.",
        "24h": s24,
        "7d": s7,
        "yesterday_2026_09_10_2023cst": tape,
        "rule": {
            "built": False,
            "reason": "NO_SUPPORTED_ACCELERATION_RULE"
            if not meaningful
            else "meaningful features exist; human rule applied only after review",
            "meaningful_7d": meaningful,
        },
        "frequency": {
            "breakout_7d": s7["dual_breakout_pre_s4"],
            "acceleration_only_24h": 0,
            "acceleration_only_7d": 0,
            "overlap": 0,
            "label": frequency_label(s7["dual_breakout_pre_s4"]),
        },
    }
    out = Path(__file__).resolve().parent / "_s9_accel_out.json"
    out.write_text(json.dumps(report, ensure_ascii=False, default=str), encoding="utf-8")
    print(
        json.dumps(
            {
                "wrote": str(out),
                "end_ts": str(now),
                "24h_n": s24["strong_breakout_fail_n"],
                "24h_s15": s24["success_15_n"],
                "24h_s30": s24["strong_30_n"],
                "7d_n": s7["strong_breakout_fail_n"],
                "7d_s15": s7["success_15_n"],
                "7d_s30": s7["strong_30_n"],
                "meaningful_7d": meaningful,
                "top7": s7["top_features"][:6],
                "bool7": s7["boolean_rates"],
                "bo_dist": s7["breakout_distance"],
                "stop_success": s7["stop_feasibility_success"],
                "tape_n": len(tape),
            },
            ensure_ascii=False,
            default=str,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
