"""News autonomy API routes."""
from __future__ import annotations

from fastapi import APIRouter, Query, Request

from ...db.migrations_v12 import apply_v12_migrations
from ...db.migrations_v13 import apply_v13_migrations
from ...db.repositories import NewsAssessmentsRepo, NewsRepo

router = APIRouter(prefix="/news", tags=["news"])


def _ensure_tables(conn) -> None:
    try:
        apply_v12_migrations(conn)
    except Exception:  # noqa: BLE001
        pass
    try:
        apply_v13_migrations(conn)
    except Exception:  # noqa: BLE001
        pass


@router.get("/today")
def news_today(request: Request) -> dict:
    conn = request.app.state.db
    _ensure_tables(conn)
    checks = NewsRepo(conn).get_today()
    assessments = NewsAssessmentsRepo(conn).list_by_day(
        __import__("datetime").datetime.utcnow().strftime("%Y-%m-%d")
    )
    return {"checks": checks, "assessments": assessments, "count": len(checks)}


@router.get("/assessments")
def news_assessments(
    request: Request,
    days: int = Query(7, ge=1, le=90),
) -> dict:
    conn = request.app.state.db
    _ensure_tables(conn)
    rows = NewsAssessmentsRepo(conn).list_recent(days)
    return {"assessments": rows, "days": days, "count": len(rows)}


@router.get("/stats")
def news_stats(request: Request) -> dict:
    conn = request.app.state.db
    _ensure_tables(conn)
    return {"by_event_type": NewsAssessmentsRepo(conn).stats_by_event_type()}
