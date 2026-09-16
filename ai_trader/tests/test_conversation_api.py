"""API tests for conversation endpoints."""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient

from src.api.server import create_app
from src.narrator.mock_client import MockLLMClient


def _client(tmp: Path) -> tuple[TestClient, Any]:
    app = create_app(tmp / "api_chat.db")
    if app.state.chat_controller is not None:
        app.state.chat_controller.llm_client = MockLLMClient()
    return TestClient(app), app


def test_send_endpoint() -> None:
    with tempfile.TemporaryDirectory() as td:
        c, app = _client(Path(td))
        try:
            r = c.post("/api/conversation/send", json={"message": "你好"})
            assert r.status_code == 200
            data = r.json()
            assert "reply" in data
            assert data["silence"] is False
        finally:
            app.state.db.close()


def test_history_endpoint() -> None:
    with tempfile.TemporaryDirectory() as td:
        c, app = _client(Path(td))
        try:
            c.post("/api/conversation/send", json={"message": "你好"})
            r = c.get("/api/conversation/history?limit=20")
            assert r.status_code == 200
            assert len(r.json()["messages"]) >= 2
        finally:
            app.state.db.close()


def test_empty_message_rejected() -> None:
    with tempfile.TemporaryDirectory() as td:
        c, app = _client(Path(td))
        try:
            r = c.post("/api/conversation/send", json={"message": "  "})
            assert r.status_code == 422 or r.status_code == 400
        finally:
            app.state.db.close()
