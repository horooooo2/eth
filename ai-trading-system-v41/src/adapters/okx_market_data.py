"""Public OKX perpetual OHLCV (no API key, never sandbox, never mock)."""

from __future__ import annotations

import os
import time
from typing import Any, Dict, Optional, Tuple

import pandas as pd


def use_real_okx_market() -> bool:
    src = str(os.getenv("V41_MARKET_DATA_SOURCE", "")).strip().lower()
    if src in {"mock", "fake"}:
        return False
    if src in {"okx", "live", "real"}:
        return True
    return os.getenv("PYTEST_CURRENT_TEST") is None


def to_ccxt_swap_symbol(symbol: str) -> str:
    raw = str(symbol or "BTC/USDT:USDT").strip()
    if raw.endswith("-SWAP"):
        base = raw.replace("-USDT-SWAP", "").replace("-SWAP", "")
        return f"{base}/USDT:USDT"
    if "/" in raw:
        return raw if ":" in raw else f"{raw}:USDT"
    return "BTC/USDT:USDT"


def to_okx_inst_id(symbol: str) -> str:
    raw = str(symbol or "BTC-USDT-SWAP").strip()
    if raw.endswith("-SWAP"):
        return raw
    if "/" in raw:
        base = raw.split("/")[0]
        return f"{base}-USDT-SWAP"
    return "BTC-USDT-SWAP"


def split_closed_bars(
    df: pd.DataFrame,
    *,
    timeframe: str = "1h",
) -> Tuple[pd.DataFrame, Optional[pd.Series], bool]:
    """Return (closed_bars, forming_row_or_none, candle_closed)."""
    if df is None or df.empty or not isinstance(df.index, pd.DatetimeIndex):
        return df, None, True
    delta = pd.Timedelta(hours=1) if str(timeframe).lower() in {"1h", "1H", "60m"} else pd.Timedelta(minutes=5)
    last_open = df.index[-1]
    if last_open.tzinfo is None:
        last_open = last_open.tz_localize("UTC")
    now = pd.Timestamp.now(tz="UTC")
    if now < last_open + delta:
        forming = df.iloc[-1]
        closed = df.iloc[:-1] if len(df) > 1 else df.iloc[0:0]
        return closed, forming, False
    return df, None, True


class OkxPublicMarket:
    """Production OKX swap candles. Failures stay visible — no silent mock."""

    def __init__(self) -> None:
        self._exchange = None
        self.last_error: Optional[str] = None
        self._cache: Dict[Tuple[str, str, int], Tuple[float, pd.DataFrame]] = {}
        self._cache_ttl_sec = 30.0
        self._init()

    def _init(self) -> None:
        try:
            import ccxt  # type: ignore

            self._exchange = ccxt.okx(
                {
                    "enableRateLimit": True,
                    "options": {"defaultType": "swap"},
                }
            )
            self.last_error = None
        except Exception as exc:  # pragma: no cover
            self._exchange = None
            self.last_error = str(exc)

    def fetch_ohlcv(self, symbol: str, timeframe: str = "1h", limit: int = 200) -> pd.DataFrame:
        if self._exchange is None:
            self._init()
        if self._exchange is None:
            raise RuntimeError(self.last_error or "OKX market client unavailable")
        ccxt_symbol = to_ccxt_swap_symbol(symbol)
        key = (ccxt_symbol, str(timeframe), int(limit))
        now = time.time()
        hit = self._cache.get(key)
        if hit and now - hit[0] < self._cache_ttl_sec:
            return hit[1].copy()
        rows = self._exchange.fetch_ohlcv(ccxt_symbol, timeframe=timeframe, limit=int(limit))
        if not rows:
            raise RuntimeError(f"OKX returned empty OHLCV for {ccxt_symbol} {timeframe}")
        df = pd.DataFrame(rows, columns=["ts", "open", "high", "low", "close", "volume"])
        df["ts"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
        out = df.set_index("ts")
        self._cache[key] = (now, out)
        self.last_error = None
        return out.copy()

    def status(self) -> Dict[str, Any]:
        return {
            "source": "OKX",
            "connected": self._exchange is not None and not self.last_error,
            "error": self.last_error,
        }


_MARKET: Optional[OkxPublicMarket] = None


def get_okx_public_market() -> OkxPublicMarket:
    global _MARKET
    if _MARKET is None:
        _MARKET = OkxPublicMarket()
    return _MARKET
