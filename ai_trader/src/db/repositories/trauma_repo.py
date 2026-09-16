"""Trauma events repository."""
from __future__ import annotations

import json
import sqlite3
from typing import Any


class TraumaRepo:
    """Persist trauma baseline jumps."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def insert_event(
        self,
        timestamp: str,
        event_type: str,
        description: str | None = None,
        impact: dict[str, Any] | None = None,
    ) -> int:
        cur = self.conn.execute(
            """
            INSERT INTO trauma_events (timestamp, event_type, description, baseline_impact)
            VALUES (?, ?, ?, ?)
            """,
            (
                timestamp,
                event_type,
                description,
                json.dumps(impact, ensure_ascii=False) if impact is not None else None,
            ),
        )
        return int(cur.lastrowid)

    def list_recent(self, days: int = 30, *, since: str | None = None) -> list[dict[str, Any]]:
        if since:
            rows = self.conn.execute(
                """
                SELECT * FROM trauma_events
                WHERE timestamp > ?
                ORDER BY timestamp ASC, id ASC
                """,
                (since,),
            ).fetchall()
        else:
            rows = self.conn.execute(
                """
                SELECT * FROM trauma_events
                ORDER BY id DESC
                LIMIT ?
                """,
                (max(1, int(days) * 5),),
            ).fetchall()
            rows = list(reversed(rows))
        out: list[dict[str, Any]] = []
        for r in rows:
            item = dict(r)
            if item.get("baseline_impact"):
                try:
                    item["baseline_impact"] = json.loads(item["baseline_impact"])
                except (TypeError, json.JSONDecodeError):
                    pass
            out.append(item)
        return out
