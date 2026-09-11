"""S9 高频动量突破 — signal, stop, direction. Minute-scale, not HFT."""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional, Sequence

import pandas as pd

from src.runtime.s9_candle_identity import closed_candle_id, closed_candle_iso

S9_ID = "S9"
S9_SYMBOL = "BTC-USDT-SWAP"


def _f(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def ema(series: pd.Series, span: int) -> pd.Series:
    return series.astype(float).ewm(span=int(span), adjust=False).mean()


def atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    high = df["high"].astype(float)
    low = df["low"].astype(float)
    close = df["close"].astype(float)
    prev = close.shift(1)
    tr = pd.concat([(high - low).abs(), (high - prev).abs(), (low - prev).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1.0 / period, adjust=False).mean()


def adx(df: pd.DataFrame, period: int = 14) -> pd.Series:
    high = df["high"].astype(float)
    low = df["low"].astype(float)
    up = high.diff()
    down = -low.diff()
    plus_dm = ((up > down) & (up > 0)).astype(float) * up.clip(lower=0)
    minus_dm = ((down > up) & (down > 0)).astype(float) * down.clip(lower=0)
    tr_atr = atr(df, period).replace(0, pd.NA)
    plus_di = 100 * (plus_dm.ewm(alpha=1.0 / period, adjust=False).mean() / tr_atr)
    minus_di = 100 * (minus_dm.ewm(alpha=1.0 / period, adjust=False).mean() / tr_atr)
    denom = (plus_di + minus_di).replace(0, pd.NA)
    dx = ((plus_di - minus_di).abs() / denom * 100).fillna(0.0).astype(float)
    return dx.ewm(alpha=1.0 / period, adjust=False).mean().fillna(0.0)


def closed_only(df: pd.DataFrame, *, timeframe: str, now: Optional[pd.Timestamp] = None) -> pd.DataFrame:
    if df is None or df.empty:
        return df
    tf = str(timeframe).lower()
    if tf in {"1m", "1min"}:
        delta = pd.Timedelta(minutes=1)
    elif tf in {"5m", "5min"}:
        delta = pd.Timedelta(minutes=5)
    elif tf in {"15m"}:
        delta = pd.Timedelta(minutes=15)
    else:
        delta = pd.Timedelta(hours=1)
    now_ts = now if now is not None else pd.Timestamp.now(tz="UTC")
    if now_ts.tzinfo is None:
        now_ts = now_ts.tz_localize("UTC")
    idx = df.index
    last_open = idx[-1]
    if getattr(last_open, "tzinfo", None) is None:
        last_open = last_open.tz_localize("UTC")
    if now_ts < last_open + delta:
        return df.iloc[:-1]
    return df


def bar_age_seconds(ts: Any, now: Optional[pd.Timestamp] = None, *, bar_seconds: float = 0.0) -> float:
    now_ts = now if now is not None else pd.Timestamp.now(tz="UTC")
    if now_ts.tzinfo is None:
        now_ts = now_ts.tz_localize("UTC")
    t = pd.Timestamp(ts)
    if t.tzinfo is None:
        t = t.tz_localize("UTC")
    return float((now_ts - t).total_seconds()) - float(bar_seconds)


def signal_key(direction: str, closed_1m_ts: Any) -> str:
    side = str(direction or "").upper()
    if side in ("BUY", "LONG"):
        side = "LONG"
    elif side in ("SELL", "SHORT"):
        side = "SHORT"
    stamp = closed_candle_iso(closed_1m_ts)
    return f"S9:{S9_SYMBOL}:{side}:{stamp}"


CLOSE_VS_EMA9_W = 0.30
EMA_STRUCTURE_W = 0.30
SLOPE_W = 0.20
ROC_W = 0.20
SCORE_STRONG = 0.80
SCORE_EARLY = 0.40
ADX_STRONG = 18.0
ADX_EARLY = 14.0

STRONG_BULLISH = "STRONG_BULLISH"
EARLY_BULLISH = "EARLY_BULLISH"
NEUTRAL = "NEUTRAL"
EARLY_BEARISH = "EARLY_BEARISH"
STRONG_BEARISH = "STRONG_BEARISH"
TREND_CONTINUATION = "TREND_CONTINUATION"
EARLY_MOMENTUM = "EARLY_MOMENTUM"
ENTRY_NONE = "NONE"

BULLISH_STATES = frozenset({STRONG_BULLISH, EARLY_BULLISH, "BULLISH"})
BEARISH_STATES = frozenset({STRONG_BEARISH, EARLY_BEARISH, "BEARISH"})
EARLY_STATES = frozenset({EARLY_BULLISH, EARLY_BEARISH})
STRONG_STATES = frozenset({STRONG_BULLISH, STRONG_BEARISH})


def _signed_component(value: float, weight: float) -> float:
    if value > 0:
        return float(weight)
    if value < 0:
        return -float(weight)
    return 0.0


def score_direction_components(
    *,
    close: float,
    ema9: float,
    ema21: float,
    slope: float,
    roc3: Optional[float],
) -> Dict[str, float]:
    close_vs_ema9 = _signed_component(float(close) - float(ema9), CLOSE_VS_EMA9_W)
    ema_structure = _signed_component(float(ema9) - float(ema21), EMA_STRUCTURE_W)
    slope_c = _signed_component(float(slope), SLOPE_W)
    roc_c = _signed_component(float(roc3), ROC_W) if roc3 is not None else 0.0
    score = close_vs_ema9 + ema_structure + slope_c + roc_c
    score = max(-1.0, min(1.0, score))
    return {
        "s9_close_vs_ema9_component": close_vs_ema9,
        "s9_ema_structure_component": ema_structure,
        "s9_slope_component": slope_c,
        "s9_roc_component": roc_c,
        "s9_direction_score": score,
    }


def classify_direction_state(score: float, adx14: Optional[float]) -> str:
    if adx14 is None:
        return NEUTRAL
    adx_v = float(adx14)
    if adx_v < ADX_EARLY:
        return NEUTRAL
    s = float(score)
    if s >= SCORE_STRONG and adx_v >= ADX_STRONG:
        return STRONG_BULLISH
    if s <= -SCORE_STRONG and adx_v >= ADX_STRONG:
        return STRONG_BEARISH
    if s >= SCORE_EARLY:
        return EARLY_BULLISH
    if s <= -SCORE_EARLY:
        return EARLY_BEARISH
    return NEUTRAL


def entry_mode_for_state(state: str) -> str:
    if state in STRONG_STATES or state in {"BULLISH", "BEARISH"}:
        return TREND_CONTINUATION
    if state in EARLY_STATES:
        return EARLY_MOMENTUM
    return ENTRY_NONE


def side_for_state(state: str) -> Optional[str]:
    if state in BULLISH_STATES:
        return "LONG"
    if state in BEARISH_STATES:
        return "SHORT"
    return None


def roc_n(close: pd.Series, bars: int = 3) -> Optional[float]:
    if close is None or len(close) < bars + 1:
        return None
    prev = float(close.iloc[-1 - int(bars)])
    if prev == 0:
        return None
    return (float(close.iloc[-1]) - prev) / prev


def _direction_metrics(closed_5m: pd.DataFrame, cfg: Mapping[str, Any] | None = None) -> Optional[Dict[str, Any]]:
    dcfg = dict((cfg or {}).get("direction") or cfg or {})
    fast_n = int(dcfg.get("ema_fast", 9))
    slow_n = int(dcfg.get("ema_slow", 21))
    slope_n = int(dcfg.get("slope_bars", 3))
    roc_bars = int(dcfg.get("roc_bars", 3))
    if closed_5m is None or len(closed_5m) < max(slow_n, 14) + max(slope_n, roc_bars):
        return None
    close = closed_5m["close"].astype(float)
    ema_fast = ema(close, fast_n)
    ema_slow = ema(close, slow_n)
    adx14 = adx(closed_5m, int(dcfg.get("adx_period", 14)))
    last_close = float(close.iloc[-1])
    last_fast = float(ema_fast.iloc[-1])
    last_slow = float(ema_slow.iloc[-1])
    last_adx = float(adx14.iloc[-1])
    slope = float(ema_fast.iloc[-1] - ema_fast.iloc[-1 - slope_n])
    roc3 = roc_n(close, roc_bars)
    parts = score_direction_components(
        close=last_close, ema9=last_fast, ema21=last_slow, slope=slope, roc3=roc3
    )
    return {
        "close": last_close,
        "ema9": last_fast,
        "ema21": last_slow,
        "ema9_slope_3": slope,
        "adx14": last_adx,
        "s9_roc3": roc3,
        "s9_adx14": last_adx,
        "source_5m_candle_timestamp": str(closed_5m.index[-1]),
        **parts,
    }


def evaluate_5m_direction_legacy(closed_5m: pd.DataFrame, cfg: Mapping[str, Any] | None = None) -> Dict[str, Any]:
    """OLD S9: single hard trend gate. Kept for replay comparison only."""
    dcfg = dict((cfg or {}).get("direction") or cfg or {})
    adx_min = _f(dcfg.get("adx_min", 18))
    metrics = _direction_metrics(closed_5m, cfg)
    if metrics is None:
        return {"state": "NEUTRAL", "reason": "S9_DATA_5M_STALE", "adx14": None}
    last_close = float(metrics["close"])
    last_fast = float(metrics["ema9"])
    last_slow = float(metrics["ema21"])
    slope = float(metrics["ema9_slope_3"])
    last_adx = float(metrics["adx14"])
    bullish = last_close > last_fast and last_fast > last_slow and slope > 0 and last_adx >= adx_min
    bearish = last_close < last_fast and last_fast < last_slow and slope < 0 and last_adx >= adx_min
    if bullish:
        state = "BULLISH"
    elif bearish:
        state = "BEARISH"
    else:
        state = "NEUTRAL"
    out = dict(metrics)
    out["state"] = state
    out["reason"] = None if state != "NEUTRAL" else "S9_DIRECTION_NEUTRAL"
    return out


def evaluate_5m_direction(closed_5m: pd.DataFrame, cfg: Mapping[str, Any] | None = None) -> Dict[str, Any]:
    metrics = _direction_metrics(closed_5m, cfg)
    if metrics is None:
        return {
            "state": NEUTRAL,
            "reason": "S9_DATA_5M_STALE",
            "adx14": None,
            "s9_direction_score": None,
            "s9_entry_mode": ENTRY_NONE,
        }
    score = float(metrics["s9_direction_score"])
    adx14 = float(metrics["adx14"])
    state = classify_direction_state(score, adx14)
    out = dict(metrics)
    out["state"] = state
    out["s9_direction_state"] = state
    out["s9_entry_mode"] = entry_mode_for_state(state)
    if state == NEUTRAL:
        out["reason"] = "S9_DIRECTION_NEUTRAL"
        out["s9_adx_insufficient"] = adx14 < ADX_EARLY
    else:
        out["reason"] = None
        out["s9_adx_insufficient"] = False
    return out


def s3_allows(
    direction: str,
    *,
    regime: str,
    bias: float,
    cfg: Mapping[str, Any] | None = None,
    entry_mode: str = TREND_CONTINUATION,
) -> Optional[str]:
    scfg = dict((cfg or {}).get("s3") or {})
    regime_l = str(regime or "").lower()
    side = str(direction).upper()
    mode = str(entry_mode or TREND_CONTINUATION).upper()
    if mode == EARLY_MOMENTUM:
        if regime_l == "panic":
            return "S9_S3_DIRECTION_BLOCK"
        long_min = _f(scfg.get("early_long_bias_min"), -0.25)
        short_max = _f(scfg.get("early_short_bias_max"), 0.25)
        if side == "LONG" and float(bias) < long_min:
            return "S9_EARLY_S3_OPPOSITION_BLOCK"
        if side == "SHORT" and float(bias) > short_max:
            return "S9_EARLY_S3_OPPOSITION_BLOCK"
        return None
    blocked = {str(x).lower() for x in (scfg.get("block_regimes") or ["panic", "range"])}
    if regime_l in blocked:
        return "S9_S3_DIRECTION_BLOCK"
    long_min = _f(scfg.get("long_bias_min", 0.20))
    short_max = _f(scfg.get("short_bias_max", -0.20))
    if side == "LONG" and float(bias) < long_min:
        return "S9_S3_DIRECTION_BLOCK"
    if side == "SHORT" and float(bias) > short_max:
        return "S9_S3_DIRECTION_BLOCK"
    return None


def breakout_level(closed_1m: pd.DataFrame, *, side: str, lookback: int = 20) -> Optional[float]:
    if closed_1m is None or len(closed_1m) < lookback + 1:
        return None
    window = closed_1m.iloc[-(lookback + 1) : -1]
    if str(side).upper() == "LONG":
        return float(window["high"].max())
    return float(window["low"].min())


def breakout_hit(close: float, level: float, *, side: str, buffer_bps: float = 1.0) -> bool:
    buf = float(buffer_bps) / 10_000.0
    if str(side).upper() == "LONG":
        return close > level * (1.0 + buf)
    return close < level * (1.0 - buf)


def volume_ratio(closed_1m: pd.DataFrame, period: int = 20) -> Optional[float]:
    if closed_1m is None or len(closed_1m) < period + 1:
        return None
    vol = closed_1m["volume"].astype(float)
    e = ema(vol.iloc[:-1], period)
    last_ema = float(e.iloc[-1]) if len(e) else 0.0
    if last_ema <= 0:
        return None
    return float(vol.iloc[-1]) / last_ema


def candle_quality(row: Mapping[str, Any], *, side: str, min_body: float = 0.55, min_loc: float = 0.65) -> Optional[str]:
    o, h, l, c = _f(row.get("open")), _f(row.get("high")), _f(row.get("low")), _f(row.get("close"))
    rng = h - l
    if rng <= 0:
        return "S9_CANDLE_QUALITY_BLOCK"
    body = abs(c - o) / rng
    if body < min_body:
        return "S9_CANDLE_QUALITY_BLOCK"
    if str(side).upper() == "LONG":
        loc = (c - l) / rng
    else:
        loc = (h - c) / rng
    if loc < min_loc:
        return "S9_CANDLE_QUALITY_BLOCK"
    return None


def find_micro_swing(
    closed_1m: pd.DataFrame,
    *,
    side: str,
    lookback: int = 10,
) -> Optional[Dict[str, Any]]:
    if closed_1m is None or len(closed_1m) < 3:
        return None
    n = len(closed_1m)
    start = max(1, n - lookback)
    # Prefer nearest confirmed structure; i+1 must be closed (i <= n-2).
    for i in range(n - 2, start - 1, -1):
        if i < 1:
            break
        low_i = float(closed_1m["low"].iloc[i])
        high_i = float(closed_1m["high"].iloc[i])
        if str(side).upper() == "LONG":
            if low_i < float(closed_1m["low"].iloc[i - 1]) and low_i < float(closed_1m["low"].iloc[i + 1]):
                return {"price": low_i, "index": i, "timestamp": str(closed_1m.index[i])}
        else:
            if high_i > float(closed_1m["high"].iloc[i - 1]) and high_i > float(closed_1m["high"].iloc[i + 1]):
                return {"price": high_i, "index": i, "timestamp": str(closed_1m.index[i])}
    return None


def validate_stop(
    *,
    side: str,
    entry: float,
    stop: float,
    atr14: float,
    min_bps: float = 6.0,
    max_atr_mult: float = 1.2,
) -> Optional[str]:
    if str(side).upper() == "LONG":
        if stop >= entry:
            return "S9_STRUCTURE_STOP_NOT_FOUND"
        dist = entry - stop
    else:
        if stop <= entry:
            return "S9_STRUCTURE_STOP_NOT_FOUND"
        dist = stop - entry
    if entry <= 0:
        return "S9_STRUCTURE_STOP_NOT_FOUND"
    dist_bps = dist / entry * 10_000.0
    if dist_bps < min_bps:
        return "S9_STRUCTURE_STOP_TOO_TIGHT"
    if atr14 > 0 and dist > max_atr_mult * atr14:
        return "S9_STRUCTURE_STOP_TOO_WIDE"
    return None


def _mode_entry_params(cfg: Mapping[str, Any], entry_mode: str) -> Dict[str, Any]:
    if str(entry_mode).upper() == EARLY_MOMENTUM:
        br = dict(cfg.get("early_breakout") or {})
        vol = dict(cfg.get("early_volume") or {})
        candle = dict(cfg.get("early_candle") or {})
        return {
            "lookback": int(br.get("lookback_bars") or 10),
            "buffer_bps": _f(br.get("buffer_bps"), 2.0),
            "vol_period": int(vol.get("ema_period") or 20),
            "min_ratio": _f(vol.get("min_ratio"), 1.50),
            "min_body": _f(candle.get("min_body_ratio"), 0.65),
            "min_loc": _f(candle.get("min_close_location"), 0.75),
            "breakout_code": "S9_EARLY_BREAKOUT_NOT_TRIGGERED",
            "volume_code": "S9_EARLY_VOLUME_NOT_EXPANDED",
            "candle_code": "S9_EARLY_CANDLE_QUALITY_BLOCK",
        }
    br = dict(cfg.get("breakout") or {})
    vol = dict(cfg.get("volume") or {})
    candle = dict(cfg.get("candle") or {})
    return {
        "lookback": int(br.get("lookback_bars") or 20),
        "buffer_bps": _f(br.get("buffer_bps"), 1.0),
        "vol_period": int(vol.get("ema_period") or 20),
        "min_ratio": _f(vol.get("min_ratio"), 1.30),
        "min_body": _f(candle.get("min_body_ratio"), 0.55),
        "min_loc": _f(candle.get("min_close_location"), 0.65),
        "breakout_code": "S9_NO_BREAKOUT",
        "volume_code": "S9_VOLUME_NOT_EXPANDED",
        "candle_code": "S9_CANDLE_QUALITY_BLOCK",
    }


def evaluate_entry(
    *,
    closed_1m: pd.DataFrame,
    closed_5m: pd.DataFrame,
    s3_regime: str,
    s3_bias: float,
    cfg: Mapping[str, Any],
    now: Optional[pd.Timestamp] = None,
    last_signal_key: Optional[str] = None,
    direction_version: str = "v1_1",
) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "decision": "NO_TRADE",
        "direction": None,
        "reason_codes": [],
        "signal_key": None,
        "diagnostics": {},
        "s9_entry_mode": ENTRY_NONE,
    }
    fresh_1m = int((cfg.get("freshness") or {}).get("closed_1m_max_age_seconds") or 90)
    fresh_5m = int((cfg.get("freshness") or {}).get("closed_5m_max_age_seconds") or 360)
    if closed_5m is None or closed_5m.empty:
        out["reason_codes"] = ["S9_DATA_5M_STALE"]
        out["diagnostics"]["s9_data_state"] = "OFF"
        return out
    age5 = bar_age_seconds(closed_5m.index[-1], now, bar_seconds=300)
    if age5 > float((cfg.get("direction") or {}).get("max_age_seconds") or fresh_5m):
        out["reason_codes"] = ["S9_DATA_5M_STALE"]
        out["diagnostics"]["s9_data_state"] = "OFF"
        return out
    if str(direction_version or "v1_1") == "legacy":
        direction = evaluate_5m_direction_legacy(closed_5m, cfg)
        mode = TREND_CONTINUATION if direction["state"] in {"BULLISH", "BEARISH"} else ENTRY_NONE
    else:
        direction = evaluate_5m_direction(closed_5m, cfg)
        mode = str(direction.get("s9_entry_mode") or entry_mode_for_state(direction["state"]))
    diag = out["diagnostics"]
    diag.update(
        {
            "s9_direction_state": direction["state"],
            "s9_direction_reason": direction.get("reason"),
            "s9_direction_score": direction.get("s9_direction_score"),
            "s9_close_vs_ema9_component": direction.get("s9_close_vs_ema9_component"),
            "s9_ema_structure_component": direction.get("s9_ema_structure_component"),
            "s9_slope_component": direction.get("s9_slope_component"),
            "s9_roc_component": direction.get("s9_roc_component"),
            "s9_roc3": direction.get("s9_roc3"),
            "s9_adx14": direction.get("adx14"),
            "s9_entry_mode": mode,
            "close": direction.get("close"),
            "ema9": direction.get("ema9"),
            "ema21": direction.get("ema21"),
            "ema9_slope_3": direction.get("ema9_slope_3"),
            "s9_adx_insufficient": direction.get("s9_adx_insufficient"),
            "source_5m_candle_timestamp": direction.get("source_5m_candle_timestamp"),
        }
    )
    out["s9_entry_mode"] = mode
    if mode == ENTRY_NONE or direction["state"] in {NEUTRAL, "NEUTRAL"}:
        out["reason_codes"] = ["S9_DIRECTION_NEUTRAL"]
        return out
    side = side_for_state(direction["state"])
    if not side:
        out["reason_codes"] = ["S9_DIRECTION_NEUTRAL"]
        return out
    s3_block = s3_allows(side, regime=s3_regime, bias=s3_bias, cfg=cfg, entry_mode=mode)
    if s3_block:
        out["reason_codes"] = [s3_block]
        return out
    if closed_1m is None or closed_1m.empty:
        out["reason_codes"] = ["S9_DATA_1M_STALE"]
        diag["s9_data_state"] = "OFF"
        return out
    if bar_age_seconds(closed_1m.index[-1], now, bar_seconds=60) > fresh_1m:
        out["reason_codes"] = ["S9_DATA_1M_STALE"]
        diag["s9_data_state"] = "OFF"
        return out
    params = _mode_entry_params(cfg, mode)
    level = breakout_level(closed_1m, side=side, lookback=params["lookback"])
    last = closed_1m.iloc[-1]
    close = float(last["close"])
    rng = float(last["high"]) - float(last["low"])
    loc = None
    if rng > 0:
        loc = (close - float(last["low"])) / rng if side == "LONG" else (float(last["high"]) - close) / rng
    body = abs(close - float(last["open"])) / rng if rng else None
    diag["s9_breakout_level"] = level
    diag["source_1m_candle_timestamp"] = closed_candle_iso(closed_1m.index[-1])
    diag["s9_body_ratio"] = body
    diag["s9_close_location"] = loc
    if mode == EARLY_MOMENTUM:
        diag["early_breakout_level"] = level
        diag["early_body_ratio"] = body
        diag["early_close_location"] = loc
    if level is None or not breakout_hit(close, level, side=side, buffer_bps=params["buffer_bps"]):
        out["reason_codes"] = [params["breakout_code"]]
        return out
    vr = volume_ratio(closed_1m, params["vol_period"])
    diag["s9_volume_ratio"] = vr
    if mode == EARLY_MOMENTUM:
        diag["early_volume_ratio"] = vr
    if vr is None or vr < params["min_ratio"]:
        out["reason_codes"] = [params["volume_code"]]
        return out
    cq = candle_quality(last, side=side, min_body=params["min_body"], min_loc=params["min_loc"])
    if cq:
        out["reason_codes"] = [params["candle_code"]]
        return out
    atr14 = float(atr(closed_1m, int((cfg.get("atr") or {}).get("period") or 14)).iloc[-1])
    atr_bps = atr14 / close * 10_000.0 if close else 0.0
    diag["s9_atr14"] = atr14
    diag["s9_atr_bps"] = atr_bps
    min_bps = _f((cfg.get("atr") or {}).get("min_bps"), 5)
    max_bps = _f((cfg.get("atr") or {}).get("max_bps"), 50)
    if atr_bps < min_bps:
        out["reason_codes"] = ["S9_VOLATILITY_TOO_LOW"]
        return out
    if atr_bps > max_bps:
        out["reason_codes"] = ["S9_VOLATILITY_TOO_HIGH"]
        return out
    swing = find_micro_swing(closed_1m, side=side, lookback=int((cfg.get("stop") or {}).get("lookback_bars") or 10))
    if not swing:
        out["reason_codes"] = ["S9_STRUCTURE_STOP_NOT_FOUND"]
        return out
    stop_px = float(swing["price"])
    stop_err = validate_stop(
        side=side,
        entry=close,
        stop=stop_px,
        atr14=atr14,
        min_bps=_f((cfg.get("stop") or {}).get("min_distance_bps"), 6),
        max_atr_mult=_f((cfg.get("stop") or {}).get("max_atr_mult"), 1.2),
    )
    dist = abs(close - stop_px)
    diag.update(
        {
            "s9_structure_price": stop_px,
            "s9_structure_distance": dist,
            "s9_stop_price": stop_px,
            "s9_risk_pct": _f(cfg.get("risk_per_trade_pct_equity"), 0.001),
        }
    )
    if stop_err:
        out["reason_codes"] = [stop_err]
        return out
    key = signal_key(side, closed_1m.index[-1])
    if last_signal_key and last_signal_key == key:
        out["reason_codes"] = ["S9_SIGNAL_ALREADY_USED"]
        return out
    r = abs(close - stop_px)
    tp = close + 1.5 * r if side == "LONG" else close - 1.5 * r
    out.update(
        {
            "decision": "CANDIDATE",
            "direction": side,
            "reason_codes": [],
            "signal_key": key,
            "trigger_reference_price": close,
            "stop_price": stop_px,
            "take_profit_price": tp,
            "s9_entry_mode": mode,
        }
    )
    diag["s9_take_profit_price"] = tp
    diag["s9_entry_trigger"] = "EARLY_BREAKOUT" if mode == EARLY_MOMENTUM else "BREAKOUT"
    return out


class S9MomentumStrategy:
    def __init__(self, config: Mapping[str, Any]) -> None:
        self.config = config
        self.cfg = config.get("S9_high_frequency_momentum") or config.get("S9") or {}
        self._last_signal_key: Optional[str] = None
        self._last_eval_1m: Optional[int] = None
        self._last_direction_5m_ts: Optional[str] = None
        self._last_direction_state: Optional[str] = None

    def generate(
        self,
        *,
        closed_1m: pd.DataFrame,
        closed_5m: pd.DataFrame,
        context: Dict[str, Any],
        emit_intents: bool = True,
    ) -> List[Dict[str, Any]]:
        if not self.cfg.get("enabled", True):
            return []
        if closed_1m is None or closed_1m.empty:
            return []
        candle_id = closed_candle_id(closed_1m.index[-1])
        if candle_id is None:
            return []
        if self._last_eval_1m == candle_id:
            context["s9"] = {
                "decision": "NO_TRADE",
                "reason_codes": [],
                "skipped": True,
                "skip_reason": "SAME_CLOSED_CANDLE",
                "signal_key": self._last_signal_key,
                "diagnostics": {
                    "source_1m_candle_timestamp": closed_candle_iso(candle_id),
                    "repeat_evaluation": True,
                },
            }
            return []
        self._last_eval_1m = candle_id
        result = evaluate_entry(
            closed_1m=closed_1m,
            closed_5m=closed_5m,
            s3_regime=str(context.get("S3.regime") or context.get("s3_regime") or ""),
            s3_bias=_f(context.get("S3.direction_bias") or context.get("s3_bias")),
            cfg=self.cfg,
            last_signal_key=self._last_signal_key,
        )
        context["s9"] = result
        diag = result.setdefault("diagnostics", {})
        ts5 = str(diag.get("source_5m_candle_timestamp") or "")
        state = str(diag.get("s9_direction_state") or "")
        if ts5 and ts5 == self._last_direction_5m_ts:
            diag["s9_direction_repeat"] = True
        else:
            diag["s9_direction_repeat"] = False
            diag["s9_direction_updated"] = bool(ts5)
            self._last_direction_5m_ts = ts5 or self._last_direction_5m_ts
            self._last_direction_state = state or self._last_direction_state
        if result.get("decision") != "CANDIDATE" or not emit_intents:
            return []
        return [result]

    def mark_signal_used(self, key: str) -> None:
        """Consume a signal only after PRE_S4 candidate is actually committed."""
        raw = str(key or "").strip()
        if raw:
            self._last_signal_key = raw
