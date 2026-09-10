"""S9 OKX account taker fee via Node trusted-owner chain.

Never uses frontend / query / body / localStorage user_id.
Never invents a default fee. Stale cache after failed refresh is unusable.
"""

from __future__ import annotations

import os
import time
from typing import Any, Callable, Dict, Optional

import httpx

from src.runtime.s9_capabilities import register_capability

S9_FEE_TTL_SEC = 60.0
S9_FEE_TIMEOUT_SEC = 8.0
S9_INST_ID = "BTC-USDT-SWAP"
FEE_SUBREASONS = {
    "OWNER_NOT_READY",
    "CREDENTIAL_NOT_FOUND",
    "ACCOUNT_ENV_NOT_READY",
    "FEE_API_TIMEOUT",
    "FEE_API_ERROR",
    "FEE_RESPONSE_INVALID",
}

register_capability("fee_capability", ready=True, source="s9_fee.S9FeeClient")


class FeeFetchError(RuntimeError):
    def __init__(self, message: str, code: str = "FEE_API_ERROR") -> None:
        super().__init__(message)
        self.code = code if code in FEE_SUBREASONS else "FEE_API_ERROR"


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
        self.last_reason_code: Optional[str] = None

    def clear(self) -> None:
        self._cache = None
        self.last_reason_code = None

    def _expired(self, now_ts: Optional[float] = None) -> bool:
        if not self._cache:
            return True
        now = now_ts if now_ts is not None else self._now()
        updated = float(self._cache.get("updated_at_epoch") or 0)
        return now - updated > self.ttl_sec

    def _fail(self, code: str) -> None:
        self._cache = None
        self.last_event = "S9_FEE_UNAVAILABLE"
        self.last_reason_code = code if code in FEE_SUBREASONS else "FEE_API_ERROR"

    def _parse_error_body(self, body: Any, status_code: int) -> FeeFetchError:
        row = body if isinstance(body, dict) else {}
        code = str(row.get("code") or "")
        if status_code == 403 and code not in FEE_SUBREASONS:
            code = "OWNER_NOT_READY"
        if status_code == 504:
            code = "FEE_API_TIMEOUT"
        if code not in FEE_SUBREASONS:
            code = "FEE_API_ERROR"
        return FeeFetchError(str(row.get("error") or f"fee http {status_code}"), code)

    def _get(self) -> Dict[str, Any]:
        if self._fetcher is not None:
            try:
                return dict(self._fetcher() or {})
            except FeeFetchError:
                raise
            except TimeoutError as exc:
                raise FeeFetchError(str(exc), "FEE_API_TIMEOUT") from exc
            except Exception as exc:
                msg = str(exc).lower()
                if "timeout" in msg:
                    raise FeeFetchError(str(exc), "FEE_API_TIMEOUT") from exc
                raise FeeFetchError(str(exc), "FEE_API_ERROR") from exc
        if os.getenv("PYTEST_CURRENT_TEST"):
            raise FeeFetchError("fee unavailable in tests without fetcher", "FEE_API_ERROR")
        url = f"{self.node_url}/api/whale-ai/engine/internal/okx-trade-fee"
        headers = {"X-Engine-Token": self.token}
        try:
            with httpx.Client(timeout=S9_FEE_TIMEOUT_SEC) as client:
                res = client.get(url, headers=headers, params={"instId": S9_INST_ID})
        except httpx.TimeoutException as exc:
            raise FeeFetchError(str(exc), "FEE_API_TIMEOUT") from exc
        body: Any = None
        try:
            body = res.json()
        except Exception:
            body = None
        if res.status_code >= 300:
            raise self._parse_error_body(body, res.status_code)
        if not isinstance(body, dict):
            raise FeeFetchError("fee response invalid", "FEE_RESPONSE_INVALID")
        return body

    def snapshot(self) -> Dict[str, Any]:
        row = self._cache or {}
        ready = bool(row.get("ready")) and not self._expired()
        return {
            "ready": ready,
            "taker_bps": row.get("taker_bps"),
            "maker_bps": row.get("maker_bps"),
            "source": row.get("source"),
            "updated_at": row.get("updated_at"),
            "owner_bound": row.get("owner_bound"),
            "account_environment": row.get("account_environment"),
            "reason": None if ready else "S9_COST_DATA_UNAVAILABLE",
            "reason_code": None if ready else (self.last_reason_code or "S9_COST_DATA_UNAVAILABLE"),
        }

    def refresh(self) -> Dict[str, Any]:
        try:
            body = self._get()
        except FeeFetchError as exc:
            self._fail(exc.code)
            return self.snapshot()
        except Exception:
            self._fail("FEE_API_ERROR")
            return self.snapshot()
        taker = body.get("taker_bps")
        try:
            taker_bps = float(taker)
        except (TypeError, ValueError):
            taker_bps = None
        if taker_bps is None or taker_bps <= 0 or body.get("ok") is False:
            self._fail("FEE_RESPONSE_INVALID")
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
            "reason_code": None,
        }
        self.last_event = "S9_FEE_READY"
        self.last_reason_code = None
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
