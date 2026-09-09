"""HTTP client: QA-HFT → Node Execution Gateway / QA helpers."""

from __future__ import annotations

import os
from typing import Any, Dict, Optional

import httpx


class NodeGatewayClient:
    def __init__(
        self,
        base_url: Optional[str] = None,
        token: Optional[str] = None,
        timeout: float = 60.0,
    ) -> None:
        self.base_url = (base_url or os.getenv("V41_NODE_GATEWAY_URL") or "http://127.0.0.1:80").rstrip("/")
        self.token = token or os.getenv("V41_ENGINE_INTERNAL_TOKEN") or "dev-internal-token"
        self.timeout = timeout

    def _headers(self) -> Dict[str, str]:
        return {
            "X-Engine-Token": self.token,
            "Content-Type": "application/json",
        }

    def submit_order_intent(self, intent: Dict[str, Any]) -> Dict[str, Any]:
        with httpx.Client(timeout=self.timeout, trust_env=False) as client:
            res = client.post(
                f"{self.base_url}/api/whale-ai/engine/internal/order-intent",
                headers=self._headers(),
                json=intent,
            )
            if res.status_code >= 300:
                detail = res.json() if "application/json" in res.headers.get("content-type", "") else {}
                err = RuntimeError(detail.get("error") or detail.get("message") or res.text or f"HTTP {res.status_code}")
                setattr(err, "code", detail.get("code") or "GATEWAY_REJECT")
                setattr(err, "details", detail)
                raise err
            return res.json()

    def ensure_leverage(self, *, inst_id: str, lever: float) -> Dict[str, Any]:
        with httpx.Client(timeout=self.timeout, trust_env=False) as client:
            res = client.post(
                f"{self.base_url}/api/whale-ai/engine/internal/qa/ensure-leverage",
                headers=self._headers(),
                json={"instId": inst_id, "lever": lever, "mgnMode": "cross"},
            )
            if res.status_code >= 300:
                detail = res.json() if "application/json" in res.headers.get("content-type", "") else {}
                err = RuntimeError(detail.get("error") or detail.get("message") or res.text or f"HTTP {res.status_code}")
                setattr(err, "code", detail.get("code") or "LEVERAGE_SET_FAILED")
                raise err
            return res.json()

    def get_position(self, inst_id: str = "BTC-USDT-SWAP") -> Dict[str, Any]:
        with httpx.Client(timeout=self.timeout, trust_env=False) as client:
            res = client.get(
                f"{self.base_url}/api/whale-ai/engine/internal/qa/position",
                headers=self._headers(),
                params={"instId": inst_id},
            )
            ctype = res.headers.get("content-type", "")
            detail: Dict[str, Any] = {}
            if "application/json" in ctype:
                try:
                    detail = res.json()
                except Exception:
                    detail = {}
            if res.status_code >= 300:
                err = RuntimeError(
                    detail.get("error")
                    or detail.get("message")
                    or detail.get("code")
                    or res.text
                    or f"HTTP {res.status_code}"
                )
                setattr(err, "code", detail.get("code") or "POSITION_QUERY_FAILED")
                setattr(err, "details", detail)
                raise err
            return detail if isinstance(detail, dict) else {}
