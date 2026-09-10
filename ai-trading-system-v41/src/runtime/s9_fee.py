"""S9 OKX account taker fee via Node trusted-owner chain.

Never uses frontend / query / body / localStorage user_id.
Never invents a default fee. Stale cache after failed refresh is unusable.
"""

from __future__ import annotations

import os
import time
from typing import Any, Callable, Dict, Optional

import httpx

S9_FEE_TTL_SEC = 60.0
S9_FEE_TIMEOUT_SEC = 8.0
S9_INST_ID = "BTC-USDT-SWAP"


class S9FeeClient:
    def __init__(
        self,
        *,
        node_url: Optional[str] = None,
        token: Optional[str] = None,
        fetcher: Optional[Callable[[], Dict[str, Any]]] = None,
        ttl_sec: float = S9_FEE_TTL_SEC,
        now_fn: Optional[Callable[[], float]] = None,
    ) -> None:
        self.node_url = (node_url or os.getenv("V41_NODE_GATEWAY_URL") or "http://127.0.0.1:80").rstrip("/")
        self.token = token or os.getenv("V41_ENGINE_INTERNAL_TOKEN") or "dev-internal-token"
        self._fetcher = fetcher
        self.ttl_sec = float(ttl_sec)
        self._now = now_fn or time.time
        self._cache: Optional[Dict[str, Any]] = None
        self.last_event: Optional[str] = None

    def clear(self) -> None:
        self._cache = None

    def _expired(self, now_ts: Optional[float] = None) -> bool:
        if not self._cache:
            return True
        now = now_ts if now_ts is not None else self._now()
        updated = float(self._cache.get("updated_at_epoch") or 0)
        return now - updated > self.ttl_sec

    def _get(self) -> Dict[str, Any]:
        if self._fetcher is not None:
            return dict(self._fetcher() or {})
        if os.getenv("PYTEST_CURRENT_TEST"):
            raise RuntimeError("fee unavailable in tests without fetcher")
        url = f"{self.node_url}/api/whale-ai/engine/internal/okx-trade-fee"
        headers = {"X-Engine-Token": self.token}
        with httpx.Client(timeout=S9_FEE_TIMEOUT_SEC) as client:
            res = client.get(url, headers=headers, params={"instId": S9_INST_ID})
        if res.status_code >= 300:
            raise RuntimeError(f"fee http {res.status_code}")
        body = res.json()
        if not isinstance(body, dict):
            raise RuntimeError("fee response invalid")
        return body

    def snapshot(self) -> Dict[str, Any]:
        row = self._cache or {}
        return {
            "ready": bool(row.get("ready")) and not self._expired(),
            "taker_bps": row.get("taker_bps"),
            "maker_bps": row.get("maker_bps"),
            "source": row.get("source"),
            "updated_at": row.get("updated_at"),
            "owner_bound": row.get("owner_bound"),
            "account_environment": row.get("account_environment"),
            "reason": None if (row.get("ready") and not self._expired()) else "S9_COST_DATA_UNAVAILABLE",
        }

    def refresh(self) -> Dict[str, Any]:
        try:
            body = self._get()
        except Exception:
            self._cache = None
            self.last_event = "S9_FEE_UNAVAILABLE"
            return self.snapshot()
        taker = body.get("taker_bps")
        try:
            taker_bps = float(taker)
        except (TypeError, ValueError):
            taker_bps = None
        if taker_bps is None or taker_bps <= 0 or body.get("ok") is False:
            self._cache = None
            self.last_event = "S9_FEE_UNAVAILABLE"
            return self.snapshot()
        now = self._now()
        self._cache = {
            "ready": True,
            "ok": True,
            "taker_bps": taker_bps,
            "maker_bps": body.get("maker_bps"),
            "source": body.get("source") or "okx_account_trade_fee",
            "updated_at": body.get("updated_at") or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
            "updated_at_epoch": now,
            "owner_bound": body.get("owner_bound"),
            "account_environment": body.get("account_environment"),
            "instId": body.get("instId") or S9_INST_ID,
        }
        self.last_event = "S9_FEE_READY"
        return self.snapshot()

    def get_taker_bps(self) -> Optional[float]:
        if self._expired():
            snap = self.refresh()
        else:
            snap = self.snapshot()
        if not snap.get("ready"):
            return None
        try:
            fee = float(snap["taker_bps"])
        except (TypeError, ValueError, KeyError):
            return None
        return fee if fee > 0 else None
