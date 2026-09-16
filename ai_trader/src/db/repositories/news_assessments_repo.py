"""Repository for news_assessments table."""
from __future__ import annotations

import json
import sqlite3
from typing import Any


class NewsAssessmentsRepo:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def insert(self, assessment: dict[str, Any]) -> int:
        impact = assessment.get("impact_applied")
        if not isinstance(impact, str):
            impact = json.dumps(impact or {}, ensure_ascii=False)
        cur = self.conn.execute(
            """
            INSERT INTO news_assessments (
                check_id, timestamp, direction, impact_level, key_point,
                event_type, confidence, psychology_text, body_action_text,
                impact_applied, window
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                assessment.get("check_id"),
                assessment.get("timestamp"),
                assessment.get("direction"),
                assessment.get("impact_level"),
                assessment.get("key_point"),
                assessment.get("event_type"),
                assessment.get("confidence"),
                assessment.get("psychology_text"),
                assessment.get("body_action_text"),
                impact,
                assessment.get("window"),
            ),
        )
        self.conn.commit()
        return int(cur.lastrowid)

    def list_by_day(self, date: str) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            """
            SELECT * FROM news_assessments
            WHERE substr(timestamp, 1, 10) = ?
            ORDER BY timestamp
            """,
            (date,),
        ).fetchall()
        return [self._decode(r) for r in rows]

    def list_recent(self, days: int = 7) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            """
            SELECT * FROM news_assessments
            WHERE timestamp >= datetime('now', ?)
            ORDER BY timestamp DESC
            """,
            (f"-{max(1, int(days))} days",),
        ).fetchall()
        return [self._decode(r) for r in rows]

    def stats_by_event_type(self) -> dict[str, int]:
        rows = self.conn.execute(
            """
            SELECT event_type, COUNT(*) AS n
            FROM news_assessments
            GROUP BY event_type
            """
        ).fetchall()
        return {str(r["event_type"] or "UNKNOWN"): int(r["n"]) for r in rows}

    @staticmethod
    def _decode(row: sqlite3.Row) -> dict[str, Any]:
        item = dict(row)
        if item.get("impact_applied"):
            try:
                item["impact_applied"] = json.loads(item["impact_applied"])
            except (TypeError, json.JSONDecodeError):
                pass
        return item
