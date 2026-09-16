"""Integration tests for ChatController with MockLLMClient."""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from typing import Any

from src.behavior_classifier import BehaviorClassifier
from src.conversation.chat import ChatController
from src.conversation.impact import ImpactClassifier
from src.conversation.memory import ConversationMemory
from src.conversation.prompt_builder import ConversationPromptBuilder
from src.db import get_connection, init_database
from src.db.migrations_v11 import apply_v11_migrations
from src.db.repositories import ConversationRepo
from src.narrator.mock_client import MockLLMClient
from src.person_state import PersonStateEngine

CFG = json.loads((ROOT / "config" / "conversation_config.json").read_text(encoding="utf-8"))
EVENT = ROOT / "config" / "event_impacts.json"
MODES = ROOT / "config" / "behavior_modes.json"


def _controller(tmp: Path, llm: MockLLMClient | None = None) -> tuple[ChatController, Any]:
    conn = get_connection(tmp / "c.db")
    init_database(conn)
    apply_v11_migrations(conn)
    repo = ConversationRepo(conn)
    person = PersonStateEngine(EVENT)
    ctrl = ChatController(
        CFG,
        llm or MockLLMClient(),
        ConversationMemory(repo, max_turns=20),
        ConversationPromptBuilder(CFG),
        ImpactClassifier(CFG),
        person,
        behavior_classifier=BehaviorClassifier(MODES),
    )
    return ctrl, conn


def test_send_message_returns_reply() -> None:
    with tempfile.TemporaryDirectory() as td:
        ctrl, conn = _controller(Path(td))
        try:
            out = ctrl.send("你好")
            assert out["silence"] is False
            assert out["reply"]
        finally:
            conn.close()


def test_ai_question_silence() -> None:
    with tempfile.TemporaryDirectory() as td:
        llm = MockLLMClient()
        ctrl, conn = _controller(Path(td), llm)
        try:
            before = llm.call_count
            out = ctrl.send("你是不是 AI？")
            assert out["silence"] is True
            assert llm.call_count == before  # no LLM call
        finally:
            conn.close()


def test_guidance_gets_polite_refusal() -> None:
    with tempfile.TemporaryDirectory() as td:
        ctrl, conn = _controller(Path(td))
        try:
            out = ctrl.send("你应该重仓 BTC")
            assert out["silence"] is False
            assert any(k in out["reply"] for k in ("想法", "规则", "考虑", "谢谢"))
        finally:
            conn.close()


def test_opinion_affects_state() -> None:
    with tempfile.TemporaryDirectory() as td:
        ctrl, conn = _controller(Path(td))
        try:
            before = ctrl.state_engine.state.risk_appetite
            out = ctrl.send("我看多 BTC")
            after = ctrl.state_engine.state.risk_appetite
            assert after >= before
            assert (after - before) <= 0.02 + 1e-9
            assert out.get("impact_applied")
        finally:
            conn.close()


def test_conversation_persisted() -> None:
    with tempfile.TemporaryDirectory() as td:
        ctrl, conn = _controller(Path(td))
        try:
            ctrl.send("你好")
            rows = ctrl.memory.get_recent()
            assert len(rows) >= 2
        finally:
            conn.close()


def test_llm_failure_handled() -> None:
    with tempfile.TemporaryDirectory() as td:
        llm = MockLLMClient(fail_on_call=1)
        ctrl, conn = _controller(Path(td), llm)
        try:
            out = ctrl.send("今天怎么样")
            assert out["reply"]  # fallback
        finally:
            conn.close()


def test_state_snapshot_recorded() -> None:
    with tempfile.TemporaryDirectory() as td:
        ctrl, conn = _controller(Path(td))
        try:
            ctrl.send("你好")
            rows = ctrl.memory.get_recent()
            assert rows[0].get("state_snapshot")
        finally:
            conn.close()
