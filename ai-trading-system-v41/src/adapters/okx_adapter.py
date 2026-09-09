"""OKX exchange adapter via ccxt (supports mock / sandbox / live)."""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd


class OkxAdapter:
    def __init__(
        self,
        config: Optional[Dict[str, Any]] = None,
        *,
        mode: str = "paper",
        mock: bool = False,
        api_key: Optional[str] = None,
        api_secret: Optional[str] = None,
        passphrase: Optional[str] = None,
    ) -> None:
        self.config = config or {}
        self.mode = mode
        self.mock = mock or mode == "mock"
        self.api_key = api_key or os.getenv("OKX_API_KEY", "")
        self.api_secret = api_secret or os.getenv("OKX_API_SECRET", "")
        self.passphrase = passphrase or os.getenv("OKX_PASSPHRASE", "")
        self._exchange = None
        self._orders: List[Dict[str, Any]] = []
        self._order_seq = 1
        self._mock_equity = 100_000.0
        self._mock_positions: List[Dict[str, Any]] = []

        self._init_error = None
        # Execution credentials only — public candles use OkxPublicMarket (never sandbox).
        if not self.mock and (self.api_key or mode == "live"):
            try:
                import ccxt  # type: ignore

                self._exchange = ccxt.okx(
                    {
                        "apiKey": self.api_key,
                        "secret": self.api_secret,
                        "password": self.passphrase,
                        "enableRateLimit": True,
                        "options": {"defaultType": "swap"},
                    }
                )
                if mode in {"sandbox", "testnet"}:
                    self._exchange.set_sandbox_mode(True)
            except Exception as exc:  # pragma: no cover
                self._exchange = None
                self._init_error = str(exc)

    def _mock_ohlcv(self, symbol: str, timeframe: str, limit: int) -> pd.DataFrame:
        rng = np.random.default_rng(abs(hash(symbol)) % (2**32))
        n = max(limit, 250)
        rets = rng.normal(0, 0.0015, size=n)
        close = 100_000 * np.cumprod(1 + rets)
        high = close * (1 + rng.uniform(0, 0.001, size=n))
        low = close * (1 - rng.uniform(0, 0.001, size=n))
        open_ = np.roll(close, 1)
        open_[0] = close[0]
        volume = rng.uniform(10, 100, size=n)
        freq = "1h" if str(timeframe).lower() in {"1h", "1H", "60m"} else "5min"
        idx = pd.date_range(end=pd.Timestamp.now(tz="UTC"), periods=n, freq=freq)
        return pd.DataFrame(
            {"open": open_, "high": high, "low": low, "close": close, "volume": volume},
            index=idx,
        ).tail(limit)

    def get_klines(self, symbol: str, timeframe: str = "1h", limit: int = 200) -> pd.DataFrame:
        from src.adapters.okx_market_data import get_okx_public_market, use_real_okx_market

        if use_real_okx_market():
            return get_okx_public_market().fetch_ohlcv(symbol, timeframe=timeframe, limit=limit)
        if self.mock or self._exchange is None:
            return self._mock_ohlcv(symbol, timeframe, limit)
        rows = self._exchange.fetch_ohlcv(symbol, timeframe=timeframe, limit=limit)
        df = pd.DataFrame(rows, columns=["ts", "open", "high", "low", "close", "volume"])
        df["ts"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
        return df.set_index("ts")

    def get_funding_rate(self, symbol: str) -> float:
        if self.mock or self._exchange is None:
            return 0.0001
        try:
            fr = self._exchange.fetch_funding_rate(symbol)
            return float(fr.get("fundingRate") or 0.0)
        except Exception:
            return 0.0

    def get_open_interest(self, symbol: str) -> float:
        if self.mock or self._exchange is None:
            return 1_000_000.0
        try:
            oi = self._exchange.fetch_open_interest(symbol)
            return float(oi.get("openInterestAmount") or oi.get("openInterest") or 0.0)
        except Exception:
            return 0.0

    def get_order_book(self, symbol: str, depth: int = 20) -> Dict[str, Any]:
        if self.mock or self._exchange is None:
            mid = float(self.get_klines(symbol, limit=5)["close"].iloc[-1])
            bids = [[mid * (1 - 0.0001 * i), 1.0] for i in range(1, depth + 1)]
            asks = [[mid * (1 + 0.0001 * i), 1.0] for i in range(1, depth + 1)]
            return {"bids": bids, "asks": asks, "symbol": symbol}
        return self._exchange.fetch_order_book(symbol, limit=depth)

    def get_account_info(self) -> Dict[str, Any]:
        if self.mock or self._exchange is None:
            return {
                "equity": self._mock_equity,
                "cash": self._mock_equity,
                "positions": list(self._mock_positions),
            }
        bal = self._exchange.fetch_balance()
        positions = []
        try:
            positions = self._exchange.fetch_positions()
        except Exception:
            positions = []
        total = bal.get("total", {})
        equity = float(total.get("USDT") or bal.get("USDT", {}).get("total") or 0.0)
        free = float(bal.get("USDT", {}).get("free") or equity)
        return {"equity": equity, "cash": free, "positions": positions}

    def place_order(
        self,
        symbol: str,
        side: str,
        order_type: str,
        quantity: float,
        price: Optional[float] = None,
    ) -> Dict[str, Any]:
        meta = self.config.get("meta", {})
        if self.mode == "live" and not meta.get("live_trading_allowed", False):
            return {
                "ok": False,
                "error": "live_trading_not_allowed",
                "symbol": symbol,
                "side": side,
            }
        if self.mock or self._exchange is None:
            order = {
                "id": f"mock-{self._order_seq}",
                "symbol": symbol,
                "side": side,
                "type": order_type,
                "amount": quantity,
                "price": price,
                "status": "closed" if order_type == "market" else "open",
                "mode": self.mode,
            }
            self._order_seq += 1
            self._orders.append(order)
            return {"ok": True, "order": order}
        params: Dict[str, Any] = {}
        if order_type == "market":
            raw = self._exchange.create_order(symbol, order_type, side, quantity, None, params)
        else:
            raw = self._exchange.create_order(symbol, order_type, side, quantity, price, params)
        return {"ok": True, "order": raw}

    def get_open_orders(self, symbol: Optional[str] = None) -> List[Dict[str, Any]]:
        if self.mock or self._exchange is None:
            return [o for o in self._orders if o.get("status") == "open" and (symbol is None or o["symbol"] == symbol)]
        if symbol:
            return self._exchange.fetch_open_orders(symbol)
        return self._exchange.fetch_open_orders()

    def cancel_order(self, symbol: str, order_id: str) -> Dict[str, Any]:
        if self.mock or self._exchange is None:
            for o in self._orders:
                if o["id"] == order_id and o["symbol"] == symbol:
                    o["status"] = "canceled"
                    return {"ok": True, "order": o}
            return {"ok": False, "error": "not_found"}
        raw = self._exchange.cancel_order(order_id, symbol)
        return {"ok": True, "order": raw}
