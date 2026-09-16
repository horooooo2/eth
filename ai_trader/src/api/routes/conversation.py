"""Conversation API routes."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from ...db.migrations_v11 import apply_v11_migrations
from ...db.repositories import ConversationRepo
from ...envutil import env_path, load_dotenv

router = APIRouter()


class SendMessageRequest(BaseModel):
    message: str = Field(..., min_length=1)


class SendMessageResponse(BaseModel):
    reply: str
    silence: bool = False
    impact_applied: dict[str, float] = Field(default_factory=dict)
    mood: str = "calm"
    mood_label: str = "平静"
    timestamp: str = ""
    category: str | None = None
    llm_backend: str = "unknown"


class ConversationHistoryResponse(BaseModel):
    messages: list[dict[str, Any]] = Field(default_factory=list)


@router.post("/conversation/send", response_model=SendMessageResponse)
def send_message(request: Request, body: SendMessageRequest) -> SendMessageResponse:
    text = (body.message or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="empty message")
    controller = getattr(request.app.state, "chat_controller", None)
    if controller is None:
        raise HTTPException(status_code=503, detail="chat not initialized")
    # Pick up DeepSeek key saved via API modal without full restart
    try:
        load_dotenv(env_path(Path(request.app.state.project_root)))
    except Exception:
        pass
    try:
        result = controller.send(text)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return SendMessageResponse(
        reply=str(result.get("reply") or ""),
        silence=bool(result.get("silence")),
        impact_applied=dict(result.get("impact_applied") or {}),
        mood=str(result.get("mood") or "calm"),
        mood_label=str(result.get("mood_label") or "平静"),
        timestamp=str(result.get("timestamp") or ""),
        category=result.get("category"),
        llm_backend=str(result.get("llm_backend") or "unknown"),
    )


@router.get("/conversation/history", response_model=ConversationHistoryResponse)
def get_history(
    request: Request, limit: int = Query(40, ge=1, le=200)
) -> ConversationHistoryResponse:
    conn = request.app.state.db
    apply_v11_migrations(conn)
    repo = getattr(request.app.state, "conversation_repo", None) or ConversationRepo(conn)
    return ConversationHistoryResponse(messages=repo.list_recent(limit))
