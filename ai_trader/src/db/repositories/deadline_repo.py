"""Deadline history repository."""
from __future__ import annotations

import sqlite3
from typing import Any


class DeadlineRepo:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def insert_snapshot(
        self,
        state: Any,
        *,
        evaluation_action: str | None = None,
        evaluation_reason: str | None = None,
        new_deadline_days: int | None = None,
        date: str | None = None,
    ) -> int:
        data = state.to_dict() if hasattr(state, "to_dict") else dict(state)
        cur = self.conn.execute(
            """
            INSERT INTO deadline_history (
                date, day_number, days_left, pressure,
                evaluation_action, evaluation_reason, new_deadline_days
            ) VALUES (?,?,?,?,?,?,?)
            """,
            (
                date or data.get("start_date") or "",
                int(data.get("current_day") or 0),
                data.get("days_left"),
                data.get("pressure"),
                evaluation_action,
                evaluation_reason,
                new_deadline_days,
            ),
        )
        return int(cur.lastrowid)

    def get_latest(self) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM deadline_history ORDER BY id DESC LIMIT 1"
        ).fetchone()
        return dict(row) if row else None

    def list_recent(self, days: int = 30) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM deadline_history ORDER BY id DESC LIMIT ?",
            (max(1, int(days)),),
        ).fetchall()
        return [dict(r) for r in reversed(rows)]

    def get_evaluations(self) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            """
            SELECT * FROM deadline_history
            WHERE evaluation_action IS NOT NULL AND evaluation_action != ''
            ORDER BY id ASC
            """
        ).fetchall()
        return [dict(r) for r in rows]
