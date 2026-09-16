"""Tests for conversation memory."""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.conversation.memory import ConversationMemory
from src.db import get_connection, init_database
from src.db.migrations_v11 import apply_v11_migrations
from src.db.repositories import ConversationRepo


def _mem(tmp: Path, max_turns: int = 20) -> tuple[ConversationMemory, Any]:
    conn = get_connection(tmp / "c.db")
    init_database(conn)
    apply_v11_migrations(conn)
    return ConversationMemory(ConversationRepo(conn), max_turns=max_turns), conn


def test_add_and_retrieve_message() -> None:
    with tempfile.TemporaryDirectory() as td:
        mem, conn = _mem(Path(td))
        try:
            mem.add_message("user", "你好", state_snapshot={"stress": 0.3})
            mem.add_message("zhangming", "在。", state_snapshot={"stress": 0.3})
            rows = mem.get_recent()
            assert len(rows) == 2
            assert rows[0]["role"] == "user"
            assert rows[1]["content"] == "在。"
        finally:
            conn.close()


def test_max_turns_limit() -> None:
    with tempfile.TemporaryDirectory() as td:
        mem, conn = _mem(Path(td), max_turns=2)
        try:
            for i in range(6):
                mem.add_message("user", f"u{i}")
                mem.add_message("zhangming", f"z{i}")
            rows = mem.get_recent()
            assert len(rows) == 4  # 2 turns * 2 messages
        finally:
            conn.close()


def test_prompt_format_conversion() -> None:
    mem = ConversationMemory(repo=object(), max_turns=5)
    fmt = mem.to_prompt_format(
        [
            {"role": "user", "content": "hi"},
            {"role": "zhangming", "content": "hello"},
        ]
    )
    assert fmt == [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "hello"},
    ]


def test_state_snapshot_preserved() -> None:
    with tempfile.TemporaryDirectory() as td:
        mem, conn = _mem(Path(td))
        try:
            mem.add_message("user", "x", state_snapshot={"risk_appetite": 0.42})
            row = mem.get_recent()[0]
            assert row["state_snapshot"]["risk_appetite"] == 0.42
        finally:
            conn.close()
