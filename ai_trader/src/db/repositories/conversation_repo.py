"""Conversation messages repository."""
from __future__ import annotations

import json
import sqlite3
from typing import Any


class ConversationRepo:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def insert_message(self, msg: dict[str, Any]) -> int:
        snap = msg.get("state_snapshot")
        impact = msg.get("impact_applied")
        cur = self.conn.execute(
            """
            INSERT INTO conversation_messages (
                timestamp, role, content, state_snapshot, trigger_type, impact_applied
            ) VALUES (?,?,?,?,?,?)
            """,
            (
                msg.get("timestamp"),
                msg.get("role"),
                msg.get("content"),
                json.dumps(snap, ensure_ascii=False) if snap is not None else None,
                msg.get("trigger_type") or "passive",
                json.dumps(impact, ensure_ascii=False) if impact is not None else None,
            ),
        )
        self.conn.commit()
        return int(cur.lastrowid)

    def list_recent(self, limit: int = 40) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            """
            SELECT * FROM (
                SELECT * FROM conversation_messages
                ORDER BY id DESC
                LIMIT ?
            ) ORDER BY id ASC
            """,
            (max(1, int(limit)),),
        ).fetchall()
        return [self._decode(r) for r in rows]

    def list_by_timerange(self, start: str, end: str) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            """
            SELECT * FROM conversation_messages
            WHERE timestamp >= ? AND timestamp <= ?
            ORDER BY id ASC
            """,
            (start, end),
        ).fetchall()
        return [self._decode(r) for r in rows]

    def count_by_role(self) -> dict[str, int]:
        rows = self.conn.execute(
            "SELECT role, COUNT(*) AS n FROM conversation_messages GROUP BY role"
        ).fetchall()
        return {str(r["role"]): int(r["n"]) for r in rows}

    @staticmethod
    def _decode(row: sqlite3.Row) -> dict[str, Any]:
        item = dict(row)
        for key in ("state_snapshot", "impact_applied"):
            if item.get(key):
                try:
                    item[key] = json.loads(item[key])
                except (TypeError, json.JSONDecodeError):
                    pass
        return item
