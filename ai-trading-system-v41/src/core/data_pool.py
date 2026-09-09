"""Feature data pool: OHLCV + microstructure + portfolio derived features."""

from __future__ import annotations

from typing import Any, Dict, Mapping, MutableMapping, Optional

import numpy as np
import pandas as pd

_EPS = 1e-12


class FeatureDataPool:
    """Maintains latest feature scalars and optional series for rule evaluation."""

    def __init__(self, config: Optional[Mapping[str, Any]] = None) -> None:
        self.config = config or {}
        self._values: Dict[str, Any] = {}
        self._series: Dict[str, pd.Series] = {}
        self._bars: Optional[pd.DataFrame] = None
        self._context: Dict[str, Any] = {}

    def set_context(self, updates: Mapping[str, Any]) -> None:
        """Set dotted context fields used by strategies (S3.regime, S6.level, ...)."""
        for key, value in updates.items():
            self._context[key] = value
            self._values[key] = value
            if "." in key:
                root, rest = key.split(".", 1)
                bucket = self._context.setdefault(root, {})
                if isinstance(bucket, dict):
                    bucket[rest] = value
                    self._values[root] = bucket

    def get(self, name: str, default: Any = None) -> Any:
        if name in self._values:
            return self._values[name]
        if name in self._context:
            return self._context[name]
        if "." in name:
            parts = name.split(".")
            cur: Any = self._context
            for p in parts:
                if isinstance(cur, Mapping) and p in cur:
                    cur = cur[p]
                else:
                    cur = None
                    break
            if cur is not None:
                return cur
        return default

    def get_series(self, name: str) -> Optional[pd.Series]:
        return self._series.get(name)

    def update_from_bars(
        self,
        bars: pd.DataFrame,
        microstructure: Optional[Mapping[str, Any]] = None,
        portfolio: Optional[Mapping[str, Any]] = None,
    ) -> None:
        """Recompute indicators from OHLCV bars and optional micro/portfolio inputs."""
        df = bars.copy()
        required = {"open", "high", "low", "close", "volume"}
        missing = required - set(df.columns)
        if missing:
            raise ValueError(f"bars missing columns: {sorted(missing)}")
        df = df.sort_index() if isinstance(df.index, pd.DatetimeIndex) else df.reset_index(drop=True)
        self._bars = df

        close = df["close"].astype(float)
        high = df["high"].astype(float)
        low = df["low"].astype(float)
        volume = df["volume"].astype(float)

        atr14 = self._atr(high, low, close, 14)
        ema20 = close.ewm(span=20, adjust=False).mean()
        ema50 = close.ewm(span=50, adjust=False).mean()
        ema200 = close.ewm(span=200, adjust=False).mean()
        adx14 = self._adx(high, low, close, 14)
        rsi14 = self._rsi(close, 14)

        trend_separation = (ema20 - ema50).abs() / (atr14.replace(0, np.nan))
        trend_slope_6 = ema20.diff(6) / 6.0
        efficiency_ratio_20 = self._efficiency_ratio(close, 20)
        atr_ratio_20 = atr14 / atr14.rolling(20, min_periods=1).mean().replace(0, np.nan)
        vol_mean = volume.rolling(20, min_periods=1).mean()
        vol_std = volume.rolling(20, min_periods=1).std().replace(0, np.nan)
        volume_z20 = (volume - vol_mean) / vol_std

        # Approximate 1m / 24h returns from bar index length (caller supplies matching TF)
        return_1m = close.pct_change(1)
        # 24h ≈ 288 bars on 5m, or 24 on 1h; use config-ish default 288 when enough bars
        lookback_24h = 288 if len(close) >= 50 else max(1, min(24, len(close) - 1))
        return_24h = close.pct_change(lookback_24h)

        log_ret = np.log(close / close.shift(1)).replace([np.inf, -np.inf], np.nan)
        realized_vol_5m = log_ret.rolling(5, min_periods=2).std() * np.sqrt(288)
        rv_mean_30d = realized_vol_5m.rolling(30 * 288 if len(close) > 1000 else max(30, len(close) // 2), min_periods=5).mean()
        rv5m_ratio_30d = realized_vol_5m / rv_mean_30d.replace(0, np.nan)

        # breadth placeholder: fraction of positive returns in window
        breadth_24h = (return_1m.rolling(lookback_24h, min_periods=1).apply(lambda x: float(np.mean(x > 0)), raw=True))

        series_map = {
            "close": close,
            "open": df["open"].astype(float),
            "high": high,
            "low": low,
            "volume": volume,
            "atr14": atr14,
            "ema20": ema20,
            "ema50": ema50,
            "ema200": ema200,
            "adx14": adx14,
            "rsi14": rsi14,
            "trend_separation": trend_separation,
            "trend_slope_6": trend_slope_6,
            "efficiency_ratio_20": efficiency_ratio_20,
            "atr_ratio_20": atr_ratio_20,
            "volume_z20": volume_z20,
            "return_1m": return_1m,
            "return_24h": return_24h,
            "breadth_24h": breadth_24h,
            "realized_vol_5m": realized_vol_5m,
            "rv5m_ratio_30d": rv5m_ratio_30d,
        }

        # Derived regime helpers
        trend_direction = np.sign(ema20 - ema50)
        trend_strength = (adx14 / 100.0).clip(0, 1)
        structure_score = (trend_separation.fillna(0).clip(0, 2) / 2.0).clip(0, 1)
        series_map["trend_direction"] = trend_direction
        series_map["trend_strength"] = trend_strength
        series_map["structure_score"] = structure_score

        for name, ser in series_map.items():
            self._series[name] = ser
            val = ser.iloc[-1] if len(ser) else np.nan
            self._values[name] = None if (isinstance(val, float) and np.isnan(val)) else (float(val) if pd.api.types.is_number(val) else val)

        micro = dict(microstructure or {})
        for key in (
            "spread_bps",
            "depth_imbalance",
            "aggressive_buy_ratio",
            "aggressive_sell_ratio",
            "price_impact_buy",
            "price_impact_sell",
            "top_book_depth",
            "market_data_stale_ms",
            "sequence_valid",
            "exchange_connected",
            "funding_rate",
            "funding_percentile_180d",
            "open_interest",
            "open_interest_change_1h",
            "rolling_30d_spread_bps_p80",
            "rolling_30d_spread_bps_p99",
            "rolling_price_impact_buy_p40",
            "rolling_price_impact_sell_p40",
            "rolling_30d_depth_p20",
            "rolling_180d_abs_return_1m_p999",
        ):
            if key in micro:
                self._values[key] = micro[key]
                self._series[key] = pd.Series([micro[key]])

        # Defaults for micro fields if absent (paper/mock)
        defaults = {
            "spread_bps": 2.0,
            "depth_imbalance": 0.0,
            "aggressive_buy_ratio": 1.0,
            "aggressive_sell_ratio": 1.0,
            "price_impact_buy": 0.0005,
            "price_impact_sell": 0.0005,
            "top_book_depth": 1_000_000.0,
            "market_data_stale_ms": 50.0,
            "sequence_valid": True,
            "exchange_connected": True,
            "funding_percentile_180d": 50.0,
            "open_interest_change_1h": 0.0,
            "rolling_30d_spread_bps_p80": 8.0,
            "rolling_30d_spread_bps_p99": 25.0,
            "rolling_price_impact_buy_p40": 0.001,
            "rolling_price_impact_sell_p40": 0.001,
            "rolling_30d_depth_p20": 100_000.0,
            "rolling_180d_abs_return_1m_p999": 0.05,
        }
        for k, v in defaults.items():
            if k not in self._values:
                self._values[k] = v

        if portfolio:
            for k, v in portfolio.items():
                self._values[k] = v

        # mid price alias
        self._values["mid"] = float(close.iloc[-1])
        self._values["current_mid_price"] = float(close.iloc[-1])

    @staticmethod
    def _atr(high: pd.Series, low: pd.Series, close: pd.Series, period: int) -> pd.Series:
        prev_close = close.shift(1)
        tr = pd.concat(
            [
                (high - low).abs(),
                (high - prev_close).abs(),
                (low - prev_close).abs(),
            ],
            axis=1,
        ).max(axis=1)
        return tr.ewm(alpha=1 / period, adjust=False).mean()

    @staticmethod
    def _rsi(close: pd.Series, period: int) -> pd.Series:
        delta = close.diff()
        gain = delta.clip(lower=0)
        loss = -delta.clip(upper=0)
        avg_gain = gain.ewm(alpha=1 / period, adjust=False).mean()
        avg_loss = loss.ewm(alpha=1 / period, adjust=False).mean()
        rs = avg_gain / avg_loss.replace(0, np.nan)
        return 100 - (100 / (1 + rs))

    @staticmethod
    def _adx(high: pd.Series, low: pd.Series, close: pd.Series, period: int) -> pd.Series:
        up = high.diff()
        down = -low.diff()
        plus_dm = np.where((up > down) & (up > 0), up, 0.0)
        minus_dm = np.where((down > up) & (down > 0), down, 0.0)
        tr = FeatureDataPool._atr(high, low, close, period)  # smoothed TR proxy
        # Use true ATR base separately
        prev_close = close.shift(1)
        true_range = pd.concat(
            [(high - low).abs(), (high - prev_close).abs(), (low - prev_close).abs()],
            axis=1,
        ).max(axis=1)
        atr = true_range.ewm(alpha=1 / period, adjust=False).mean()
        plus_di = 100 * pd.Series(plus_dm, index=high.index).ewm(alpha=1 / period, adjust=False).mean() / atr.replace(0, np.nan)
        minus_di = 100 * pd.Series(minus_dm, index=high.index).ewm(alpha=1 / period, adjust=False).mean() / atr.replace(0, np.nan)
        dx = (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan) * 100
        return dx.ewm(alpha=1 / period, adjust=False).mean()

    @staticmethod
    def _efficiency_ratio(close: pd.Series, period: int) -> pd.Series:
        change = (close - close.shift(period)).abs()
        volatility = close.diff().abs().rolling(period, min_periods=1).sum()
        return change / volatility.replace(0, np.nan)
