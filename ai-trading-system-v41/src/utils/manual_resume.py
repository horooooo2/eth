"""Manual resume FastAPI control path for S6 hard system events."""

from __future__ import annotations

from typing import Any, Callable, Dict, Optional

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field


class ResumeRequest(BaseModel):
    operator_id: str
    reason: str = Field(min_length=3)
    incident_id: str
    new_level: int = 0
    precondition_snapshot: Dict[str, Any] = Field(default_factory=dict)


def create_resume_app(
    s6_detector: Any,
    *,
    auth_token: str = "dev-token",
    audit_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
    precondition_checker: Optional[Callable[[Dict[str, Any]], bool]] = None,
) -> FastAPI:
    app = FastAPI(title="AI Trading System Resume Control", version="4.1")

    @app.post("/api/v1/system/resume")
    def resume_system(
        body: ResumeRequest,
        authorization: Optional[str] = Header(default=None),
        x_operator_id: Optional[str] = Header(default=None),
    ) -> Dict[str, Any]:
        # Auth stub: Bearer token required
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="missing_bearer_token")
        token = authorization.split(" ", 1)[1].strip()
        if token != auth_token:
            raise HTTPException(status_code=403, detail="invalid_token")
        if x_operator_id and x_operator_id != body.operator_id:
            raise HTTPException(status_code=400, detail="operator_mismatch")

        snapshot = dict(body.precondition_snapshot)
        ok = True
        if precondition_checker:
            ok = bool(precondition_checker(snapshot))
        else:
            # Default preconditions: exchange connected + reconciled flags
            ok = bool(snapshot.get("exchange_connected", True)) and bool(
                snapshot.get("positions_reconciled", True)
            )

        def _audit(rec: Dict[str, Any]) -> None:
            rec = {
                **rec,
                "incident_id": body.incident_id,
                "source_ip": snapshot.get("source_ip"),
                "precondition_snapshot": snapshot,
                "reason": body.reason,
                "operator_id": body.operator_id,
            }
            if audit_callback:
                audit_callback(rec)

        result = s6_detector.manual_resume(
            operator_id=body.operator_id,
            reason=body.reason,
            preconditions_ok=ok,
            audit_callback=_audit,
            new_level=body.new_level,
        )
        if not result.get("ok"):
            raise HTTPException(status_code=409, detail=result)
        return result

    return app
