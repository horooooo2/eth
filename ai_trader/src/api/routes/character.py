"""Character profile + import/export routes."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from ...character.card import (
    CharacterCardError,
    characters_dir,
    get_active_character,
    list_characters,
    load_character,
)
from ...character.exporter import export_to_json
from ...character.importer import import_from_json
from ...db.repositories import BaselineRepo, PsychologyRepo, TraitsRepo, TraumaRepo
from ..helpers import EVENT_ICONS, relative_time, request_owner
from ..schemas import CharacterResponse, RecentEventItem, TraitItem

router = APIRouter()

TRAIT_MAP = [
    ("风险偏好", "risk_appetite"),
    ("耐心", "patience"),
    ("固执", "stubbornness"),
    ("自省", "self_doubt"),
    ("纪律", "focus"),
]


class BaselineHistoryResponse(BaseModel):
    history: list[dict[str, Any]] = Field(default_factory=list)


class TraumaEventsResponse(BaseModel):
    events: list[dict[str, Any]] = Field(default_factory=list)


@router.get("/character/baseline-history", response_model=BaselineHistoryResponse)
def baseline_history(request: Request, days: int = Query(30, ge=1, le=365)) -> BaselineHistoryResponse:
    from ...db.migrations_v9 import apply_v9_migrations

    conn = request.app.state.db
    apply_v9_migrations(conn)
    rows = BaselineRepo(conn).list_recent(days)
    return BaselineHistoryResponse(history=rows)


@router.get("/character/trauma-events", response_model=TraumaEventsResponse)
def trauma_events(
    request: Request,
    days: int = Query(30, ge=1, le=365),
    since: str | None = Query(None),
) -> TraumaEventsResponse:
    from ...db.migrations_v9 import apply_v9_migrations

    conn = request.app.state.db
    apply_v9_migrations(conn)
    rows = TraumaRepo(conn).list_recent(days, since=since)
    return TraumaEventsResponse(events=rows)


class CharacterListItem(BaseModel):
    id: str
    name: str
    tags: list[str] = Field(default_factory=list)


class CharacterListResponse(BaseModel):
    active: str
    characters: list[CharacterListItem]


class ImportBody(BaseModel):
    card: dict[str, Any] | None = None
    json_text: str | None = None
    force: bool = True


@router.get("/character/list", response_model=CharacterListResponse)
def character_list(request: Request) -> CharacterListResponse:
    config_dir = Path(request.app.state.config_dir)
    owner = request_owner(request)
    items = [CharacterListItem(**c) for c in list_characters(config_dir, owner)]
    if not items:
        return CharacterListResponse(active="", characters=[])
    active = get_active_character(config_dir, owner)
    if active not in {c.id for c in items}:
        active = items[0].id
    return CharacterListResponse(active=active, characters=items)


@router.get("/character/export")
def character_export(
    request: Request,
    character_id: str | None = Query(None),
) -> PlainTextResponse:
    config_dir = Path(request.app.state.config_dir)
    owner = request_owner(request)
    cid = character_id or get_active_character(config_dir, owner)
    try:
        text = export_to_json(cid, config_dir, owner=owner)
    except CharacterCardError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return PlainTextResponse(
        text,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{cid}.json"'},
    )


@router.post("/character/import")
def character_import(body: ImportBody, request: Request) -> dict[str, Any]:
    config_dir = Path(request.app.state.config_dir)
    owner = request_owner(request)
    raw = (body.json_text or "").strip() or None
    if not raw and body.card is not None:
        raw = json.dumps(body.card, ensure_ascii=False)
    if not raw:
        raise HTTPException(status_code=400, detail="card or json_text required")
    try:
        path = import_from_json(
            raw, config_dir, force=True, owner=owner, replace_all=True
        )
    except CharacterCardError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "path": str(path)}


@router.post("/character/import-default")
def character_import_default(
    request: Request,
    character_id: str = Query("zhangming"),
) -> dict[str, Any]:
    """Import shipped default card (no file upload). Prefer this on first setup."""
    from ...character.importer import import_default_character

    config_dir = Path(request.app.state.config_dir)
    owner = request_owner(request)
    try:
        path = import_default_character(
            config_dir, character_id=character_id, owner=owner, force=True
        )
    except CharacterCardError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "path": str(path), "character_id": character_id}


@router.post("/character/import-file")
async def character_import_file(
    request: Request,
    file: UploadFile = File(...),
    force: bool = True,
) -> dict[str, Any]:
    config_dir = Path(request.app.state.config_dir)
    owner = request_owner(request)
    content = (await file.read()).decode("utf-8")
    try:
        path = import_from_json(
            content, config_dir, force=True, owner=owner, replace_all=True
        )
    except CharacterCardError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "path": str(path)}


def _empty_character() -> CharacterResponse:
    """Placeholder when no character card is imported."""
    return CharacterResponse(
        available=False,
        id=None,
        name="",
        age=None,
        occupation="",
        location="",
        tags=[],
        traits=[TraitItem(name=label, value=0.0, change_7d=0.0) for label, _ in TRAIT_MAP],
        emotion_arc="",
        recent_events=[],
    )


@router.get("/character", response_model=CharacterResponse)
def get_character(request: Request) -> CharacterResponse:
    conn = request.app.state.db
    config_dir = Path(request.app.state.config_dir)
    owner = request_owner(request)
    available_chars = list_characters(config_dir, owner)
    if not available_chars:
        return _empty_character()

    active_id = get_active_character(config_dir, owner)
    if not active_id or active_id not in {c["id"] for c in available_chars}:
        # No activated imported card → UI shows placeholders
        return _empty_character()

    try:
        # Only imported cards under this owner's characters/ count for UI
        imported_path = characters_dir(config_dir, owner) / f"{active_id}.json"
        if not imported_path.exists():
            return _empty_character()
        card = load_character(active_id, config_dir, owner=owner)
    except CharacterCardError:
        return _empty_character()

    traits_repo = TraitsRepo(conn)
    latest = traits_repo.latest() or {}
    rows = conn.execute(
        "SELECT * FROM traits_history ORDER BY id DESC LIMIT 14"
    ).fetchall()
    older = dict(rows[-1]) if len(rows) >= 2 else latest

    traits: list[TraitItem] = []
    for label, key in TRAIT_MAP:
        cur = float(latest.get(key) or 0.5)
        prev = float(older.get(key) or cur)
        if key == "self_doubt":
            cur_v = max(0.0, min(1.0, 1.0 - cur))
            prev_v = max(0.0, min(1.0, 1.0 - prev))
            traits.append(TraitItem(name=label, value=round(cur_v, 2), change_7d=round(cur_v - prev_v, 2)))
        else:
            traits.append(TraitItem(name=label, value=round(cur, 2), change_7d=round(cur - prev, 2)))

    psych = PsychologyRepo(conn).latest()
    emotion_arc = "状态平稳，继续观察市场。"
    if psych and psych.get("narrative_text"):
        emotion_arc = str(psych["narrative_text"])

    event_rows = conn.execute(
        "SELECT timestamp, name, description FROM events ORDER BY timestamp DESC LIMIT 8"
    ).fetchall()
    recent: list[RecentEventItem] = []
    for er in event_rows[:5]:
        name = str(er["name"] or "")
        recent.append(
            RecentEventItem(
                time=relative_time(str(er["timestamp"] or "")),
                icon=EVENT_ICONS.get(name, "•"),
                text=str(er["description"] or name),
            )
        )

    tags = list(card.get("tags") or [])
    stress = float(latest.get("stress") or 0.5)
    if stress > 0.7 and tags:
        tags = ["高压状态", "报复倾向", "睡眠不足"]

    from ...db.migrations_v9 import apply_v9_migrations

    apply_v9_migrations(conn)
    baseline_repo = BaselineRepo(conn)
    trauma_repo = TraumaRepo(conn)
    hist = baseline_repo.list_recent(30)
    baseline: dict[str, float] = {}
    baseline_trend: dict[str, float] = {}
    if hist:
        last = hist[-1]
        first = hist[0]
        for key, _ in TRAIT_MAP:
            # map label back - use raw keys
            pass
        for key in (
            "risk_appetite",
            "patience",
            "focus",
            "self_doubt",
            "stubbornness",
            "stress",
            "sleep_debt",
        ):
            if last.get(key) is not None:
                baseline[key] = float(last[key])
            if first.get(key) is not None and last.get(key) is not None:
                baseline_trend[key] = float(last[key]) - float(first[key])
    else:
        tb = card.get("traits_baseline") or {}
        baseline = {k: float(v) for k, v in tb.items()}

    recent_trauma = trauma_repo.list_recent(14)

    deadline_info: dict[str, Any] | None = None
    try:
        from ...db.migrations_v10 import apply_v10_migrations
        from ...db.repositories import DeadlineRepo

        apply_v10_migrations(conn)
        latest_dl = DeadlineRepo(conn).get_latest()
        evals = DeadlineRepo(conn).get_evaluations()
        card_dl = dict(card.get("deadline") or {})
        if latest_dl or card_dl.get("enabled", True):
            total = int(card_dl.get("total_days") or 90)
            cur = int((latest_dl or {}).get("day_number") or 0)
            left = int((latest_dl or {}).get("days_left") or max(0, total - cur))
            last = evals[-1] if evals else None
            deadline_info = {
                "enabled": bool(card_dl.get("enabled", True)),
                "current_day": cur,
                "total_days": total if cur == 0 else cur + left,
                "days_left": left,
                "pressure": float((latest_dl or {}).get("pressure") or 0),
                "last_evaluation": (
                    {
                        "action": last.get("evaluation_action"),
                        "reason": last.get("evaluation_reason"),
                        "new_deadline_days": last.get("new_deadline_days"),
                    }
                    if last
                    else None
                ),
            }
    except Exception:
        deadline_info = None

    return CharacterResponse(
        available=True,
        id=str(card.get("id") or active_id),
        name=str(card.get("name") or ""),
        age=int(card["age"]) if card.get("age") is not None else None,
        occupation=str(card.get("occupation") or ""),
        location=str(card.get("location") or ""),
        tags=tags,
        traits=traits,
        emotion_arc=emotion_arc,
        recent_events=recent,
        baseline=baseline,
        baseline_trend=baseline_trend,
        recent_trauma=recent_trauma[:5],
        deadline=deadline_info,
    )
