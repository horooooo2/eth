"""Deadline status / history / evaluation API routes."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from ...db.migrations_v10 import apply_v10_migrations
from ...db.repositories import DeadlineRepo
from ...deadline.state import DeadlineStateManager

router = APIRouter()


class DeadlineStatusResponse(BaseModel):
    enabled: bool = False
    start_date: str | None = None
    current_day: int = 0
    total_days: int = 90
    days_left: int = 0
    pressure: float = 0.0
    next_evaluation_day: int | None = None
    last_evaluation: dict[str, Any] | None = None
    extend_count: int = 0
    paused: bool = False


class DeadlineHistoryResponse(BaseModel):
    history: list[dict[str, Any]] = Field(default_factory=list)


class DeadlineEvaluationsResponse(BaseModel):
    evaluations: list[dict[str, Any]] = Field(default_factory=list)


class ExtendBody(BaseModel):
    additional_days: int = Field(90, ge=1, le=365)
    as_of: str | None = None


def _load_cfg(config_dir: Path) -> dict[str, Any]:
    path = config_dir / "deadline_config.json"
    if not path.exists():
        return {"enabled": False, "default_total_days": 90, "evaluation": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def _status_from_db(conn: Any, config_dir: Path) -> DeadlineStatusResponse:
    apply_v10_migrations(conn)
    repo = DeadlineRepo(conn)
    latest = repo.get_latest()
    evals = repo.get_evaluations()
    last_eval = evals[-1] if evals else None
    cfg = _load_cfg(config_dir)
    if not latest:
        return DeadlineStatusResponse(
            enabled=bool(cfg.get("enabled", True)),
            total_days=int(cfg.get("default_total_days") or 90),
            next_evaluation_day=int((cfg.get("evaluation") or {}).get("trigger_day") or 90),
        )
    return DeadlineStatusResponse(
        enabled=True,
        start_date=str(latest.get("date") or ""),
        current_day=int(latest.get("day_number") or 0),
        total_days=int(
            (last_eval or {}).get("new_deadline_days")
            or cfg.get("default_total_days")
            or 90
        )
        if not latest.get("day_number")
        else max(
            int(latest.get("day_number") or 0) + int(latest.get("days_left") or 0),
            int(cfg.get("default_total_days") or 90),
        ),
        days_left=int(latest.get("days_left") or 0),
        pressure=float(latest.get("pressure") or 0),
        next_evaluation_day=int((cfg.get("evaluation") or {}).get("trigger_day") or 90),
        last_evaluation=(
            {
                "action": last_eval.get("evaluation_action"),
                "reason": last_eval.get("evaluation_reason"),
                "new_deadline_days": last_eval.get("new_deadline_days"),
                "date": last_eval.get("date"),
            }
            if last_eval
            else None
        ),
        paused=bool(
            last_eval and str(last_eval.get("evaluation_action") or "").upper() == "STOP"
        ),
    )


@router.get("/deadline/status", response_model=DeadlineStatusResponse)
def deadline_status(request: Request) -> DeadlineStatusResponse:
    return _status_from_db(request.app.state.db, Path(request.app.state.config_dir))


@router.get("/deadline/history", response_model=DeadlineHistoryResponse)
def deadline_history(
    request: Request, days: int = Query(30, ge=1, le=365)
) -> DeadlineHistoryResponse:
    conn = request.app.state.db
    apply_v10_migrations(conn)
    return DeadlineHistoryResponse(history=DeadlineRepo(conn).list_recent(days))


@router.get("/deadline/evaluations", response_model=DeadlineEvaluationsResponse)
def deadline_evaluations(request: Request) -> DeadlineEvaluationsResponse:
    conn = request.app.state.db
    apply_v10_migrations(conn)
    return DeadlineEvaluationsResponse(evaluations=DeadlineRepo(conn).get_evaluations())


@router.post("/deadline/extend")
def deadline_extend(request: Request, body: ExtendBody) -> dict[str, Any]:
    """Manual extend for testing — records a snapshot with EXTEND action."""
    conn = request.app.state.db
    apply_v10_migrations(conn)
    cfg = _load_cfg(Path(request.app.state.config_dir))
    as_of = (body.as_of or "")[:10]
    if not as_of:
        from datetime import date

        as_of = date.today().isoformat()
    mgr = DeadlineStateManager(cfg, {"deadline": {"enabled": True}}, start_date=as_of)
    mgr.update(as_of)
    mgr.extend_deadline(body.additional_days, as_of=as_of)
    st = mgr.get_state()
    DeadlineRepo(conn).insert_snapshot(
        st,
        date=as_of,
        evaluation_action="EXTEND",
        evaluation_reason="manual extend",
        new_deadline_days=body.additional_days,
    )
    conn.commit()
    return {"ok": True, "state": st.to_dict()}
