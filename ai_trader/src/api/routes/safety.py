"""Kill Switch: flatten all OKX positions immediately."""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel

from ...exchange.live_executor import LiveExecutor
from ...exchange.okx_client import OKXAPIError, OKXClient
from ...runtime_flags import get_okx_client, set_kill_switch

logger = logging.getLogger(__name__)
router = APIRouter()


class KillSwitchResult(BaseModel):
    ok: bool
    closed: list[dict[str, Any]]
    errors: list[str]
    paused: bool = True


@router.post("/safety/kill-switch", response_model=KillSwitchResult)
def kill_switch(request: Request) -> KillSwitchResult:
    set_kill_switch(True)
    client: OKXClient | None = getattr(request.app.state, "okx_client", None) or get_okx_client()  # type: ignore[assignment]
    if client is None:
        client = OKXClient()
        request.app.state.okx_client = client
    closed: list[dict[str, Any]] = []
    errors: list[str] = []
    try:
        positions = client.get_positions("SWAP")
    except OKXAPIError as exc:
        return KillSwitchResult(ok=False, closed=[], errors=[str(exc)], paused=True)

    executor = LiveExecutor(client=client)
    for pos in positions or []:
        qty = abs(float(pos.get("pos") or 0))
        if qty <= 0:
            continue
        inst_id = str(pos.get("instId") or "BTC-USDT-SWAP")
        executor.inst_id = inst_id
        try:
            result = executor.close_position(
                {
                    "side": "LONG" if str(pos.get("posSide") or "").lower() == "long" or float(pos.get("pos") or 0) > 0 else "SHORT",
                    "pos": str(qty),
                    "position_id": str(pos.get("posId") or inst_id),
                },
                reason="KILL_SWITCH",
            )
            closed.append(
                {
                    "instId": inst_id,
                    "status": result.status,
                    "reject_reason": result.reject_reason,
                }
            )
            if result.status != "FILLED":
                errors.append(f"{inst_id}: {result.reject_reason}")
        except Exception as exc:  # noqa: BLE001
            logger.exception("kill switch close failed for %s", inst_id)
            errors.append(f"{inst_id}: {exc}")

    return KillSwitchResult(ok=len(errors) == 0, closed=closed, errors=errors, paused=True)
