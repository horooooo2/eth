"""OKX v5 REST client (HMAC-SHA256 signed)."""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import time
from base64 import b64encode
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlencode

import requests

logger = logging.getLogger(__name__)


class OKXAPIError(RuntimeError):
    """OKX business or transport error."""

    def __init__(self, message: str, *, code: str | None = None, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.data = data


@dataclass
class OKXClient:
    """Thin REST wrapper for OKX v5."""

    api_key: str = ""
    secret_key: str = ""
    passphrase: str = ""
    demo: bool = False
    base_url: str = "https://www.okx.com"
    timeout: float = 10.0
    max_retries: int = 3

    def __post_init__(self) -> None:
        if not self.api_key:
            self.api_key = os.environ.get("OKX_API_KEY", "")
        if not self.secret_key:
            self.secret_key = os.environ.get("OKX_SECRET_KEY", "")
        if not self.passphrase:
            self.passphrase = os.environ.get("OKX_PASSPHRASE", "")
        if not self.demo:
            self.demo = os.environ.get("OKX_DEMO", "false").lower() in {"1", "true", "yes"}

    # ---- signing ---------------------------------------------------------

    @staticmethod
    def _timestamp() -> str:
        return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

    def _sign(self, timestamp: str, method: str, path: str, body: str) -> str:
        message = f"{timestamp}{method.upper()}{path}{body}"
        digest = hmac.new(
            self.secret_key.encode("utf-8"),
            message.encode("utf-8"),
            hashlib.sha256,
        ).digest()
        return b64encode(digest).decode("utf-8")

    def _headers(self, method: str, path: str, body: str) -> dict[str, str]:
        ts = self._timestamp()
        headers = {
            "OK-ACCESS-KEY": self.api_key,
            "OK-ACCESS-SIGN": self._sign(ts, method, path, body),
            "OK-ACCESS-TIMESTAMP": ts,
            "OK-ACCESS-PASSPHRASE": self.passphrase,
            "Content-Type": "application/json",
        }
        if self.demo:
            headers["x-simulated-trading"] = "1"
        return headers

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        body: dict[str, Any] | None = None,
        auth: bool = True,
    ) -> Any:
        query = ""
        if params:
            query = "?" + urlencode({k: v for k, v in params.items() if v is not None})
        full_path = path + query
        payload = "" if body is None else json.dumps(body, separators=(",", ":"))
        url = self.base_url + full_path
        headers = self._headers(method, full_path, payload) if auth else {"Content-Type": "application/json"}

        last_err: Exception | None = None
        for attempt in range(self.max_retries):
            try:
                resp = requests.request(
                    method.upper(),
                    url,
                    headers=headers,
                    data=payload if body is not None else None,
                    timeout=self.timeout,
                )
                data = resp.json()
                code = str(data.get("code", ""))
                logger.info("OKX %s %s -> code=%s", method.upper(), path, code)
                if code != "0":
                    raise OKXAPIError(
                        str(data.get("msg") or f"OKX error code={code}"),
                        code=code,
                        data=data.get("data"),
                    )
                return data.get("data")
            except OKXAPIError:
                raise
            except (requests.RequestException, ValueError, json.JSONDecodeError) as exc:
                last_err = exc
                wait = 0.5 * (2**attempt)
                logger.warning(
                    "OKX network error %s %s attempt=%s: %s; retry in %.1fs",
                    method.upper(),
                    path,
                    attempt + 1,
                    exc,
                    wait,
                )
                time.sleep(wait)
        raise OKXAPIError(f"network failed after retries: {last_err}")

    # ---- public / private endpoints --------------------------------------

    def get_balance(self) -> list[dict[str, Any]]:
        data = self._request("GET", "/api/v5/account/balance")
        return list(data or [])

    def get_positions(self, inst_type: str = "SWAP") -> list[dict[str, Any]]:
        data = self._request("GET", "/api/v5/account/positions", params={"instType": inst_type})
        return list(data or [])

    def place_order(
        self,
        inst_id: str,
        side: str,
        ord_type: str,
        sz: str,
        *,
        pos_side: str | None = None,
        reduce_only: bool = False,
        attach_algo_ords: list[dict[str, Any]] | None = None,
        td_mode: str = "cross",
        px: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "instId": inst_id,
            "tdMode": td_mode,
            "side": side,
            "ordType": ord_type,
            "sz": sz,
        }
        if pos_side:
            body["posSide"] = pos_side
        if reduce_only:
            body["reduceOnly"] = True
        if px is not None:
            body["px"] = px
        if attach_algo_ords:
            body["attachAlgoOrds"] = attach_algo_ords
        data = self._request("POST", "/api/v5/trade/order", body=body)
        if isinstance(data, list) and data:
            return dict(data[0])
        return dict(data or {})

    def cancel_order(self, inst_id: str, ord_id: str) -> dict[str, Any]:
        data = self._request(
            "POST",
            "/api/v5/trade/cancel-order",
            body={"instId": inst_id, "ordId": ord_id},
        )
        if isinstance(data, list) and data:
            return dict(data[0])
        return dict(data or {})

    def get_order(self, inst_id: str, ord_id: str) -> dict[str, Any]:
        data = self._request(
            "GET",
            "/api/v5/trade/order",
            params={"instId": inst_id, "ordId": ord_id},
        )
        if isinstance(data, list) and data:
            return dict(data[0])
        return dict(data or {})

    def get_instruments(self, inst_type: str = "SWAP") -> list[dict[str, Any]]:
        data = self._request(
            "GET",
            "/api/v5/public/instruments",
            params={"instType": inst_type},
            auth=False,
        )
        return list(data or [])

    def get_candles(self, inst_id: str, bar: str = "1m", limit: int = 100) -> list[list[str]]:
        data = self._request(
            "GET",
            "/api/v5/market/candles",
            params={"instId": inst_id, "bar": bar, "limit": str(limit)},
            auth=False,
        )
        return list(data or [])
