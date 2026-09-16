"""Events table repository."""
from __future__ import annotations

import json
import sqlite3
from typing import Any


def _row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    data = dict(row)
    if data.get("psychology_impact"):
        data["psychology_impact"] = json.loads(data["psychology_impact"])
    return data


class EventsRepo:
    """CRUD helpers for the events table."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def insert(self, event: dict[str, Any]) -> int:
        """Insert event and return new id."""
        impact = event.get("psychology_impact")
        impact_json = json.dumps(impact, ensure_ascii=False) if impact is not None else None
        cur = self.conn.execute(
            """
            INSERT INTO events (
                timestamp, event_type, event_subtype, event_class,
                compound_id, name, description, psychology_impact
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event["timestamp"],
                event.get("event_type", "life"),
                event.get("event_subtype"),
                event.get("event_class", "atomic"),
                event.get("compound_id"),
                event["name"],
                event.get("description"),
                impact_json,
            ),
        )
        return int(cur.lastrowid)

    def list_by_timerange(self, start: str, end: str) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM events WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp",
            (start, end),
        ).fetchall()
        return [_row_to_dict(r) for r in rows if r]  # type: ignore[misc]

    def list_by_name(self, name: str, limit: int = 100) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM events WHERE name = ? ORDER BY timestamp DESC LIMIT ?",
            (name, limit),
        ).fetchall()
        return [_row_to_dict(r) for r in rows if r]  # type: ignore[misc]

    def count_by_class(self, event_class: str) -> int:
        row = self.conn.execute(
            "SELECT COUNT(*) AS c FROM events WHERE event_class = ?",
            (event_class,),
        ).fetchone()
        return int(row["c"]) if row else 0
