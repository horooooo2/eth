"""Signal rules engine: breakout / pullback / flow with score calibration."""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def clamp(value: float, lo: float, hi: float) -> float:
    """Clamp value into [lo, hi]."""
    return max(lo, min(hi, value))


@dataclass
class Signal:
    """A calibrated trading opportunity from a single rule."""

    symbol: str
    direction: str
    rule_name: str
    raw_score: float
    score: float
    reason: str
    timestamp: str
    rule_version: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class SignalEngine:
    """Generate calibrated signals from OHLCV bars using JSON rule config."""

    config_path: Path
    rules: dict[str, Any] = field(init=False)
    calibration: dict[str, Any] = field(init=False)
    version: str = field(init=False)
    history: dict[str, list[float]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.config_path = Path(self.config_path)
        data = json.loads(self.config_path.read_text(encoding="utf-8"))
        self.rules = dict(data.get("rules") or {})
        self.calibration = dict(data.get("calibration") or {})
        self.version = str(data.get("version") or "0.0.0")
        for name in self.rules:
            self.history.setdefault(name, [])

    def generate_signals(
        self,
        ohlcv_data: list[dict[str, Any]],
        symbol: str,
    ) -> list[Signal]:
        """Run enabled rules and return calibrated signals."""
        signals: list[Signal] = []
        for rule_name, rule_def in self.rules.items():
            if not rule_def.get("enabled", True):
                continue
            params = dict(rule_def.get("params") or {})
            if rule_name == "BREAKOUT":
                found = self._check_breakout(ohlcv_data, symbol, params)
            elif rule_name == "PULLBACK":
                found = self._check_pullback(ohlcv_data, symbol, params)
            elif rule_name == "FLOW":
                found = self._check_flow(ohlcv_data, symbol, params)
            else:
                continue
            for sig in found:
                self.history.setdefault(rule_name, []).append(sig.raw_score)
                sig.score = self._calibrate(sig.raw_score, rule_name)
                signals.append(sig)
        return signals

    def _calibrate(self, raw_score: float, rule_name: str) -> float:
        """Map raw_score into unified [0.50, 0.95] semantics."""
        out_lo, out_hi = self.calibration.get("output_range", [0.50, 0.95])
        min_samples = int(self.calibration.get("min_samples_for_percentile", 100))
        hist = self.history.get(rule_name, [])
        # Exclude current sample for percentile if already appended
        prior = hist[:-1] if hist and hist[-1] == raw_score else hist
        if len(prior) < min_samples:
            fallback = self.calibration.get("fallback_linear") or {}
            base = float(fallback.get("base", 0.50))
            scale = float(fallback.get("scale", 0.45))
            return clamp(base + float(raw_score) * scale, float(out_lo), float(out_hi))

        below = sum(1 for x in prior if x <= raw_score)
        pct = below / len(prior)
        score = float(out_lo) + pct * (float(out_hi) - float(out_lo))
        return clamp(score, float(out_lo), float(out_hi))

    def _check_breakout(
        self,
        bars: list[dict[str, Any]],
        symbol: str,
        params: dict[str, Any],
    ) -> list[Signal]:
        lookback = int(params.get("lookback_bars", 20))
        min_pct = float(params.get("min_breakout_pct", 0.001))
        if len(bars) < lookback + 1:
            return []
        current = bars[-1]
        window = bars[-(lookback + 1) : -1]
        close = float(current["close"])
        hh = self._highest_high(window, lookback)
        ll = self._lowest_low(window, lookback)
        ts = self._bar_ts(current)
        out: list[Signal] = []

        if hh > 0:
            strength = (close - hh) / hh
            if strength >= min_pct:
                raw = clamp(min(1.0, strength / 0.02), 0.0, 1.0)
                out.append(
                    Signal(
                        symbol=symbol,
                        direction="LONG",
                        rule_name="BREAKOUT",
                        raw_score=raw,
                        score=0.0,
                        reason=f"收盘突破近{lookback}根高点 {hh:.2f}，强度 {strength:.4f}",
                        timestamp=ts,
                        rule_version=self.version,
                    )
                )
        if ll > 0:
            strength = (ll - close) / ll
            if strength >= min_pct:
                raw = clamp(min(1.0, strength / 0.02), 0.0, 1.0)
                out.append(
                    Signal(
                        symbol=symbol,
                        direction="SHORT",
                        rule_name="BREAKOUT",
                        raw_score=raw,
                        score=0.0,
                        reason=f"收盘跌破近{lookback}根低点 {ll:.2f}，强度 {strength:.4f}",
                        timestamp=ts,
                        rule_version=self.version,
                    )
                )
        return out

    def _check_pullback(
        self,
        bars: list[dict[str, Any]],
        symbol: str,
        params: dict[str, Any],
    ) -> list[Signal]:
        ema_fast_n = int(params.get("ema_fast", 20))
        ema_slow_n = int(params.get("ema_slow", 50))
        tol = float(params.get("touch_tolerance", 0.003))
        recent_n = int(params.get("recent_bars", 3))
        need = max(ema_slow_n, ema_fast_n) + recent_n
        if len(bars) < need:
            return []

        closes = [float(b["close"]) for b in bars]
        ema_fast = self._ema(closes, ema_fast_n)
        ema_slow = self._ema(closes, ema_slow_n)
        if ema_fast is None or ema_slow is None:
            return []

        current = bars[-1]
        recent = bars[-recent_n:]
        ts = self._bar_ts(current)
        close = float(current["close"])
        out: list[Signal] = []

        # LONG: uptrend, touch EMA fast from above zone, close back above
        if ema_fast > ema_slow and close > ema_fast:
            dists = []
            touched = False
            for bar in recent:
                low = float(bar["low"])
                dist = (low - ema_fast) / ema_fast if ema_fast else 0.0
                dists.append(dist)
                if abs(dist) <= tol or (dist <= 0 and abs(dist) <= tol * 2):
                    touched = True
                # touch near EMA: low within tolerance band
                if abs(low - ema_fast) / ema_fast <= tol:
                    touched = True
            if touched:
                best = min(dists, key=lambda d: abs(d))
                raw = clamp(1.0 - abs(best) / 0.005, 0.0, 1.0)
                out.append(
                    Signal(
                        symbol=symbol,
                        direction="LONG",
                        rule_name="PULLBACK",
                        raw_score=raw,
                        score=0.0,
                        reason=f"上涨趋势回踩 EMA{ema_fast_n} 后站上，偏差 {best:.4f}",
                        timestamp=ts,
                        rule_version=self.version,
                    )
                )

        # SHORT: downtrend, touch EMA, close back below
        if ema_fast < ema_slow and close < ema_fast:
            dists = []
            touched = False
            for bar in recent:
                high = float(bar["high"])
                dist = (high - ema_fast) / ema_fast if ema_fast else 0.0
                dists.append(dist)
                if abs(high - ema_fast) / ema_fast <= tol:
                    touched = True
            if touched:
                best = min(dists, key=lambda d: abs(d))
                raw = clamp(1.0 - abs(best) / 0.005, 0.0, 1.0)
                out.append(
                    Signal(
                        symbol=symbol,
                        direction="SHORT",
                        rule_name="PULLBACK",
                        raw_score=raw,
                        score=0.0,
                        reason=f"下跌趋势反弹触及 EMA{ema_fast_n} 后跌破，偏差 {best:.4f}",
                        timestamp=ts,
                        rule_version=self.version,
                    )
                )
        return out

    def _check_flow(
        self,
        bars: list[dict[str, Any]],
        symbol: str,
        params: dict[str, Any],
    ) -> list[Signal]:
        window = int(params.get("volume_window", 20))
        recent_n = int(params.get("recent_bars", 3))
        ratio_th = float(params.get("volume_ratio_threshold", 1.5))
        if len(bars) < window + recent_n:
            return []

        baseline = bars[-(window + recent_n) : -recent_n]
        recent = bars[-recent_n:]
        base_vol = self._avg_volume(baseline, len(baseline))
        recent_vol = self._avg_volume(recent, len(recent))
        if base_vol <= 0:
            return []
        volume_ratio = recent_vol / base_vol
        if volume_ratio <= ratio_th:
            return []

        first_open = float(recent[0]["open"])
        last_close = float(recent[-1]["close"])
        if first_open <= 0:
            return []
        price_change_pct = (last_close - first_open) / first_open
        price_move = abs(price_change_pct)
        raw = clamp(
            (volume_ratio - ratio_th) / ratio_th * 0.5 + price_move / 0.01 * 0.5,
            0.0,
            1.0,
        )
        direction = "LONG" if price_change_pct > 0 else "SHORT" if price_change_pct < 0 else ""
        if not direction:
            return []
        ts = self._bar_ts(bars[-1])
        return [
            Signal(
                symbol=symbol,
                direction=direction,
                rule_name="FLOW",
                raw_score=raw,
                score=0.0,
                reason=(
                    f"近{recent_n}根放量×{volume_ratio:.2f}，"
                    f"价格变动 {price_change_pct:+.4f}"
                ),
                timestamp=ts,
                rule_version=self.version,
            )
        ]

    @staticmethod
    def _ema(prices: list[float], period: int) -> float | None:
        if len(prices) < period or period <= 0:
            return None
        seed = sum(prices[:period]) / period
        alpha = 2.0 / (period + 1)
        value = seed
        for price in prices[period:]:
            value = alpha * price + (1.0 - alpha) * value
        return value

    @staticmethod
    def _highest_high(bars: list[dict[str, Any]], lookback: int) -> float:
        window = bars[-lookback:] if len(bars) >= lookback else bars
        return max(float(b["high"]) for b in window) if window else 0.0

    @staticmethod
    def _lowest_low(bars: list[dict[str, Any]], lookback: int) -> float:
        window = bars[-lookback:] if len(bars) >= lookback else bars
        return min(float(b["low"]) for b in window) if window else 0.0

    @staticmethod
    def _avg_volume(bars: list[dict[str, Any]], lookback: int) -> float:
        window = bars[-lookback:] if len(bars) >= lookback else bars
        if not window:
            return 0.0
        return sum(float(b["volume"]) for b in window) / len(window)

    @staticmethod
    def _bar_ts(bar: dict[str, Any]) -> str:
        raw = bar.get("timestamp")
        if isinstance(raw, str) and raw:
            return raw
        return datetime.now(timezone.utc).isoformat()
