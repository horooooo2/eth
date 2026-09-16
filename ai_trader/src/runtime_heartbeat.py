"""Scheduler heartbeat + narrator mode status for /system/health."""
from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
HEARTBEAT_PATH = ROOT / "data" / "scheduler_heartbeat.json"
STALE_SEC = 90.0


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_scheduler_heartbeat(
    *,
    pid: int | None = None,
    narrator_mode: str = "mock",
    started_at: str | None = None,
    path: Path | None = None,
) -> Path:
    out = Path(path or HEARTBEAT_PATH)
    out.parent.mkdir(parents=True, exist_ok=True)
    existing: dict[str, Any] = {}
    if out.exists():
        try:
            existing = json.loads(out.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            existing = {}
    payload = {
        "pid": int(pid if pid is not None else os.getpid()),
        "narrator_mode": str(narrator_mode or existing.get("narrator_mode") or "mock"),
        "started_at": started_at or existing.get("started_at") or _now_iso(),
        "updated_at": _now_iso(),
        "ts": time.time(),
    }
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return out


def read_scheduler_heartbeat(path: Path | None = None) -> dict[str, Any] | None:
    p = Path(path or HEARTBEAT_PATH)
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (json.JSONDecodeError, OSError):
        return None


def is_scheduler_running(path: Path | None = None, *, stale_sec: float = STALE_SEC) -> bool:
    data = read_scheduler_heartbeat(path)
    if not data:
        return False
    ts = data.get("ts")
    if ts is None and data.get("updated_at"):
        try:
            dt = datetime.fromisoformat(str(data["updated_at"]).replace("Z", "+00:00"))
            ts = dt.timestamp()
        except ValueError:
            return False
    try:
        return (time.time() - float(ts)) <= float(stale_sec)
    except (TypeError, ValueError):
        return False
