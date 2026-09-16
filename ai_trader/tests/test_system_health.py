"""System health endpoint + heartbeat tests."""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from src.api.server import create_app  # noqa: E402
from src.runtime_heartbeat import (  # noqa: E402
    HEARTBEAT_PATH,
    is_scheduler_running,
    write_scheduler_heartbeat,
)


def test_health_endpoint_returns_all_fields() -> None:
    client = TestClient(create_app())
    r = client.get("/api/system/health")
    assert r.status_code == 200
    data = r.json()
    for key in (
        "key_ready",
        "scheduler_running",
        "narrator_mode",
        "db_path",
        "db_writable",
        "details",
    ):
        assert key in data
    assert "trader.db" in data["db_path"].replace("\\", "/")


def test_scheduler_running_when_heartbeat_fresh() -> None:
    write_scheduler_heartbeat(pid=1, narrator_mode="real", started_at="2026-01-01T00:00:00Z")
    assert is_scheduler_running() is True


def test_scheduler_not_running_when_heartbeat_stale() -> None:
    HEARTBEAT_PATH.parent.mkdir(parents=True, exist_ok=True)
    HEARTBEAT_PATH.write_text(
        json.dumps(
            {
                "pid": 1,
                "narrator_mode": "mock",
                "started_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-01-01T00:00:00Z",
                "ts": time.time() - 120,
            }
        ),
        encoding="utf-8",
    )
    assert is_scheduler_running() is False


def test_narrator_mode_reflects_config() -> None:
    client = TestClient(create_app())
    write_scheduler_heartbeat(pid=9, narrator_mode="mock")
    r = client.get("/api/system/health")
    data = r.json()
    assert data["narrator_mode"] in {"real", "mock", "disabled"}
    assert data["scheduler_running"] is True
    assert data["narrator_mode"] == "mock"


if __name__ == "__main__":
    test_health_endpoint_returns_all_fields()
    test_scheduler_running_when_heartbeat_fresh()
    test_scheduler_not_running_when_heartbeat_stale()
    test_narrator_mode_reflects_config()
    print("ok")
