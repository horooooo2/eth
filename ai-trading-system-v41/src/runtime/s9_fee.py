"""S9 OKX account taker fee via Node trusted-owner chain.

Never uses frontend / query / body / localStorage user_id.
Never invents a default fee.

Cache is stale-while-revalidate: reaching the soft TTL schedules a refresh but
keeps the last-known-good fee usable, so a routine refresh no longer flips
fee_ready to false for the duration of the fetch. Readiness is lost only when
no fee was ever fetched, or when the last-known-good fee passes hard expiry.
"""

from __future__ import annotations

import os
import time
from typing import Any, Callable, Dict, Optional

import httpx

from src.runtime.s9_capabilities import register_capability

S9_FEE_TTL_SEC = 60.0
S9_FEE_TIMEOUT_SEC = 8.0
# Last-known-good fee survives failed refreshes up to this age, then S9 fails
# closed. 5x TTL tolerates four consecutive refresh failures.
S9_FEE_HARD_EXPIRY_SEC = 300.0
S9_INST_ID = "BTC-USDT-SWAP"
FEE_CACHE_HARD_EXPIRED = "FEE_CACHE_HARD_EXPIRED"
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
        hard_expiry_sec: float = S9_FEE_HARD_EXPIRY_SEC,
        now_fn: Optional[Callable[[], float]] = None,
    ) -> None:
        self.node_url = (node_url or os.getenv("V41_NODE_GATEWAY_URL") or "http://127.0.0.1:80").rstrip("/")
        self.token = token or os.getenv("V41_ENGINE_INTERNAL_TOKEN") or "dev-internal-token"
        self._fetcher = fetcher
        self.ttl_sec = float(ttl_sec)
        self.hard_expiry_sec = max(float(hard_expiry_sec), float(ttl_sec))
        self._now = now_fn or time.time
        self._cache: Optional[Dict[str, Any]] = None
        self.last_event: Optional[str] = None
        self.last_reason_code: Optional[str] = None
        self.last_success_at: Optional[float] = None
        self.last_refresh_error: Optional[str] = None
        self.last_refresh_error_at: Optional[float] = None

    def clear(self) -> None:
        self._cache = None
        self.last_reason_code = None
        self.last_success_at = None
        self.last_refresh_error = None
        self.last_refresh_error_at = None

    def _age_sec(self, now_ts: Optional[float] = None) -> Optional[float]:
        if not self._cache:
            return None
        now = now_ts if now_ts is not None else self._now()
        return max(0.0, now - float(self._cache.get("updated_at_epoch") or 0))

    def _soft_expired(self, now_ts: Optional[float] = None) -> bool:
        """Due for refresh. Does NOT make the cached fee unusable."""
        age = self._age_sec(now_ts)
        return age is None or age > self.ttl_sec

    def _hard_expired(self, now_ts: Optional[float] = None) -> bool:
        """Too old to trust. S9 must fail closed."""
        age = self._age_sec(now_ts)
        return age is None or age > self.hard_expiry_sec

    def _last_success_iso(self) -> Optional[str]:
        if self.last_success_at is None:
            return None
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.last_success_at))

    def _fail(self, code: str) -> None:
        self._cache = None
        self.last_event = "S9_FEE_UNAVAILABLE"
        self.last_reason_code = code if code in FEE_SUBREASONS else "FEE_API_ERROR"

    def _note_refresh_failure(self, code: str) -> None:
        """Record a failed refresh, keeping last-known-good until hard expiry."""
        now = self._now()
        normalized = code if code in FEE_SUBREASONS else "FEE_API_ERROR"
        self.last_refresh_error = normalized
        self.last_refresh_error_at = now
        if not self._cache or self._hard_expired(now):
            self._fail(normalized)

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
        now = self._now()
        row = self._cache or {}
        age = self._age_sec(now)
        hard_expired = self._hard_expired(now)
        ready = bool(row.get("ready")) and not hard_expired
        if ready:
            reason_code = None
        elif row and hard_expired:
            reason_code = FEE_CACHE_HARD_EXPIRED
        else:
            reason_code = self.last_reason_code or self.last_refresh_error or "S9_COST_DATA_UNAVAILABLE"
        return {
            "ready": ready,
            "taker_bps": row.get("taker_bps"),
            "maker_bps": row.get("maker_bps"),
            "source": row.get("source"),
            "updated_at": row.get("updated_at"),
            "owner_bound": row.get("owner_bound"),
            "account_environment": row.get("account_environment"),
            # Serving last-known-good while a refresh is due or in flight.
            "stale": bool(ready and self._soft_expired(now)),
            "fee_age": age,
            "ttl_sec": self.ttl_sec,
            "hard_expiry_sec": self.hard_expiry_sec,
            # Survives fail-closed so operators can see when the fee last worked.
            "last_success_at": row.get("updated_at") or self._last_success_iso(),
            "last_success_at_epoch": self.last_success_at,
            "fee_refresh_error": self.last_refresh_error,
            "fee_refresh_error_at": self.last_refresh_error_at,
            "reason": None if ready else "S9_COST_DATA_UNAVAILABLE",
            "reason_code": reason_code,
        }

    def refresh(self) -> Dict[str, Any]:
        try:
            body = self._get()
        except FeeFetchError as exc:
            self._note_refresh_failure(exc.code)
            return self.snapshot()
        except Exception:
            self._note_refresh_failure("FEE_API_ERROR")
            return self.snapshot()
        taker = body.get("taker_bps")
        try:
            taker_bps = float(taker)
        except (TypeError, ValueError):
            taker_bps = None
        if taker_bps is None or taker_bps <= 0 or body.get("ok") is False:
            self._note_refresh_failure("FEE_RESPONSE_INVALID")
            return self.snapshot()
        now = self._now()
        # Single rebind: readers never observe a half-updated fee.
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
        self.last_success_at = now
        self.last_refresh_error = None
        self.last_refresh_error_at = None
        self.last_event = "S9_FEE_READY"
        self.last_reason_code = None
        return self.snapshot()

    def get_taker_bps(self) -> Optional[float]:
        if self._soft_expired():
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
