"""System health: keys / scheduler heartbeat / narrator mode."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from ...db.path import get_db_path
from ...envutil import env_path, load_dotenv, read_env_file
from ...narrator.llm_log import count_llm_calls_today
from ...narrator.mode import resolve_narrator_mode
from ...runtime_heartbeat import is_scheduler_running, read_scheduler_heartbeat

router = APIRouter()


class SystemHealthResponse(BaseModel):
    key_ready: bool = False
    scheduler_running: bool = False
    narrator_mode: str = "disabled"
    db_path: str = ""
    db_writable: bool = False
    last_scheduler_heartbeat: str | None = None
    details: dict[str, Any] = Field(default_factory=dict)


@router.get("/system/health", response_model=SystemHealthResponse)
def get_system_health(request: Request) -> SystemHealthResponse:
    root = Path(request.app.state.project_root)
    load_dotenv(env_path(root))
    vals = read_env_file(env_path(root))
    deepseek = bool((os.environ.get("DEEPSEEK_API_KEY") or vals.get("DEEPSEEK_API_KEY") or "").strip())
    okx = bool(
        (vals.get("OKX_API_KEY") or os.environ.get("OKX_API_KEY") or "").strip()
        and (vals.get("OKX_SECRET_KEY") or os.environ.get("OKX_SECRET_KEY") or "").strip()
        and (vals.get("OKX_PASSPHRASE") or os.environ.get("OKX_PASSPHRASE") or "").strip()
    )

    hb = read_scheduler_heartbeat()
    running = is_scheduler_running()
    narrator_cfg = root / "config" / "narrator_config.json"
    mode_from_cfg, _ = resolve_narrator_mode(config_path=narrator_cfg)
    if running and hb and hb.get("narrator_mode"):
        narrator_mode = str(hb.get("narrator_mode"))
    else:
        narrator_mode = mode_from_cfg

    db_path = Path(getattr(request.app.state, "db_path", None) or get_db_path())
    writable = False
    try:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        writable = os.access(db_path.parent, os.W_OK)
        if db_path.exists():
            writable = os.access(db_path, os.W_OK)
    except OSError:
        writable = False

    return SystemHealthResponse(
        key_ready=deepseek,
        scheduler_running=running,
        narrator_mode=narrator_mode,
        db_path=str(db_path),
        db_writable=writable,
        last_scheduler_heartbeat=(hb or {}).get("updated_at"),
        details={
            "deepseek_key_present": deepseek,
            "okx_key_present": okx,
            "scheduler_pid": (hb or {}).get("pid"),
            "scheduler_started_at": (hb or {}).get("started_at"),
            "llm_calls_today": count_llm_calls_today(),
            "character_ready": bool(
                list((root / "config" / "characters").glob("*.json"))
                if (root / "config" / "characters").is_dir()
                else False
            ),
        },
    )
