"""S9 高频动量突破 — signal, stop, direction. Minute-scale, not HFT."""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional, Sequence

import pandas as pd

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


def bar_age_seconds(ts: Any, now: Optional[pd.Timestamp] = None) -> float:
    now_ts = now if now is not None else pd.Timestamp.now(tz="UTC")
    if now_ts.tzinfo is None:
        now_ts = now_ts.tz_localize("UTC")
    t = pd.Timestamp(ts)
    if t.tzinfo is None:
        t = t.tz_localize("UTC")
    return float((now_ts - t).total_seconds())


def signal_key(direction: str, closed_1m_ts: Any) -> str:
    side = str(direction or "").upper()
    if side in ("BUY", "LONG"):
        side = "LONG"
    elif side in ("SELL", "SHORT"):
        side = "SHORT"
    ts = pd.Timestamp(closed_1m_ts)
    if ts.tzinfo is None:
        ts = ts.tz_localize("UTC")
    stamp = ts.strftime("%Y-%m-%dT%H:%M:%SZ")
    return f"S9:{S9_SYMBOL}:{side}:{stamp}"


def evaluate_5m_direction(closed_5m: pd.DataFrame, cfg: Mapping[str, Any] | None = None) -> Dict[str, Any]:
    dcfg = dict((cfg or {}).get("direction") or cfg or {})
    fast_n = int(dcfg.get("ema_fast", 9))
    slow_n = int(dcfg.get("ema_slow", 21))
    slope_n = int(dcfg.get("slope_bars", 3))
    adx_min = _f(dcfg.get("adx_min", 18))
    if closed_5m is None or len(closed_5m) < max(slow_n, 14) + slope_n:
        return {"state": "NEUTRAL", "reason": "S9_DATA_5M_STALE", "adx14": None}
    close = closed_5m["close"].astype(float)
    ema_fast = ema(close, fast_n)
    ema_slow = ema(close, slow_n)
    adx14 = adx(closed_5m, int(dcfg.get("adx_period", 14)))
    last_close = float(close.iloc[-1])
    last_fast = float(ema_fast.iloc[-1])
    last_slow = float(ema_slow.iloc[-1])
    last_adx = float(adx14.iloc[-1])
    slope = float(ema_fast.iloc[-1] - ema_fast.iloc[-1 - slope_n])
    bullish = last_close > last_fast and last_fast > last_slow and slope > 0 and last_adx >= adx_min
    bearish = last_close < last_fast and last_fast < last_slow and slope < 0 and last_adx >= adx_min
    if bullish:
        state = "BULLISH"
    elif bearish:
        state = "BEARISH"
    else:
        state = "NEUTRAL"
    return {
        "state": state,
        "reason": None if state != "NEUTRAL" else "S9_DIRECTION_NEUTRAL",
        "close": last_close,
        "ema9": last_fast,
        "ema21": last_slow,
        "ema9_slope_3": slope,
        "adx14": last_adx,
        "source_5m_candle_timestamp": str(closed_5m.index[-1]),
    }


def s3_allows(direction: str, *, regime: str, bias: float, cfg: Mapping[str, Any] | None = None) -> Optional[str]:
    scfg = dict((cfg or {}).get("s3") or {})
    blocked = {str(x).lower() for x in (scfg.get("block_regimes") or ["panic", "range"])}
    if str(regime or "").lower() in blocked:
        return "S9_S3_DIRECTION_BLOCK"
    side = str(direction).upper()
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


def evaluate_entry(
    *,
    closed_1m: pd.DataFrame,
    closed_5m: pd.DataFrame,
    s3_regime: str,
    s3_bias: float,
    cfg: Mapping[str, Any],
    now: Optional[pd.Timestamp] = None,
    last_signal_key: Optional[str] = None,
) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "decision": "NO_TRADE",
        "direction": None,
        "reason_codes": [],
        "signal_key": None,
        "diagnostics": {},
    }
    fresh_1m = int((cfg.get("freshness") or {}).get("closed_1m_max_age_seconds") or 90)
    fresh_5m = int((cfg.get("freshness") or {}).get("closed_5m_max_age_seconds") or 360)
    if closed_5m is None or closed_5m.empty:
        out["reason_codes"] = ["S9_DATA_5M_STALE"]
        out["diagnostics"]["s9_data_state"] = "OFF"
        return out
    age5 = bar_age_seconds(closed_5m.index[-1], now)
    if age5 > float((cfg.get("direction") or {}).get("max_age_seconds") or fresh_5m):
        out["reason_codes"] = ["S9_DATA_5M_STALE"]
        out["diagnostics"]["s9_data_state"] = "OFF"
        return out
    direction = evaluate_5m_direction(closed_5m, cfg)
    out["diagnostics"].update(
        {
            "s9_direction_state": direction["state"],
            "s9_direction_reason": direction.get("reason"),
            "source_5m_candle_timestamp": direction.get("source_5m_candle_timestamp"),
        }
    )
    if direction["state"] == "NEUTRAL":
        out["reason_codes"] = ["S9_DIRECTION_NEUTRAL"]
        return out
    side = "LONG" if direction["state"] == "BULLISH" else "SHORT"
    s3_block = s3_allows(side, regime=s3_regime, bias=s3_bias, cfg=cfg)
    if s3_block:
        out["reason_codes"] = [s3_block]
        return out
    if closed_1m is None or closed_1m.empty:
        out["reason_codes"] = ["S9_DATA_1M_STALE"]
        out["diagnostics"]["s9_data_state"] = "OFF"
        return out
    if bar_age_seconds(closed_1m.index[-1], now) > fresh_1m:
        out["reason_codes"] = ["S9_DATA_1M_STALE"]
        out["diagnostics"]["s9_data_state"] = "OFF"
        return out
    lookback = int((cfg.get("breakout") or {}).get("lookback_bars") or 20)
    level = breakout_level(closed_1m, side=side, lookback=lookback)
    last = closed_1m.iloc[-1]
    close = float(last["close"])
    buffer = _f((cfg.get("breakout") or {}).get("buffer_bps"), 1.0)
    out["diagnostics"]["s9_breakout_level"] = level
    out["diagnostics"]["source_1m_candle_timestamp"] = str(closed_1m.index[-1])
    if level is None or not breakout_hit(close, level, side=side, buffer_bps=buffer):
        out["reason_codes"] = ["S9_NO_BREAKOUT"]
        return out
    vr = volume_ratio(closed_1m, int((cfg.get("volume") or {}).get("ema_period") or 20))
    out["diagnostics"]["s9_volume_ratio"] = vr
    if vr is None or vr < _f((cfg.get("volume") or {}).get("min_ratio"), 1.30):
        out["reason_codes"] = ["S9_VOLUME_NOT_EXPANDED"]
        return out
    cq = candle_quality(
        last,
        side=side,
        min_body=_f((cfg.get("candle") or {}).get("min_body_ratio"), 0.55),
        min_loc=_f((cfg.get("candle") or {}).get("min_close_location"), 0.65),
    )
    rng = float(last["high"]) - float(last["low"])
    out["diagnostics"]["s9_body_ratio"] = abs(float(last["close"]) - float(last["open"])) / rng if rng else None
    if cq:
        out["reason_codes"] = [cq]
        return out
    atr14 = float(atr(closed_1m, int((cfg.get("atr") or {}).get("period") or 14)).iloc[-1])
    atr_bps = atr14 / close * 10_000.0 if close else 0.0
    out["diagnostics"]["s9_atr14"] = atr14
    out["diagnostics"]["s9_atr_bps"] = atr_bps
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
    out["diagnostics"].update(
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
        }
    )
    out["diagnostics"]["s9_take_profit_price"] = tp
    out["diagnostics"]["s9_entry_trigger"] = "BREAKOUT"
    return out


class S9MomentumStrategy:
    def __init__(self, config: Mapping[str, Any]) -> None:
        self.config = config
        self.cfg = config.get("S9_high_frequency_momentum") or config.get("S9") or {}
        self._last_signal_key: Optional[str] = None
        self._last_eval_1m: Optional[str] = None

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
        stamp = str(closed_1m.index[-1])
        if self._last_eval_1m == stamp:
            context["s9"] = {
                "decision": "NO_TRADE",
                "reason_codes": ["S9_SIGNAL_ALREADY_USED"],
                "signal_key": self._last_signal_key,
                "diagnostics": {"source_1m_candle_timestamp": stamp, "repeat_evaluation": False},
            }
            return []
        self._last_eval_1m = stamp
        result = evaluate_entry(
            closed_1m=closed_1m,
            closed_5m=closed_5m,
            s3_regime=str(context.get("S3.regime") or context.get("s3_regime") or ""),
            s3_bias=_f(context.get("S3.direction_bias") or context.get("s3_bias")),
            cfg=self.cfg,
            last_signal_key=self._last_signal_key,
        )
        context["s9"] = result
        if result.get("signal_key"):
            self._last_signal_key = str(result["signal_key"])
        if result.get("decision") != "CANDIDATE" or not emit_intents:
            return []
        return [result]
