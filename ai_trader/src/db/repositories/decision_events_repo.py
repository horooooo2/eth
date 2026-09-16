"""decision_events link table repository."""
from __future__ import annotations

import json
import sqlite3
from typing import Any


class DecisionEventsRepo:
    """Many-to-many links between decisions and events."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def link(self, decision_id: str, event_id: int) -> None:
        self.conn.execute(
            "INSERT INTO decision_events (decision_id, event_id) VALUES (?, ?)",
            (decision_id, event_id),
        )

    def link_many(self, decision_id: str, event_ids: list[int]) -> None:
        self.conn.executemany(
            "INSERT INTO decision_events (decision_id, event_id) VALUES (?, ?)",
            [(decision_id, eid) for eid in event_ids],
        )

    def get_events_for_decision(self, decision_id: str) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            """
            SELECT e.* FROM events e
            JOIN decision_events de ON de.event_id = e.id
            WHERE de.decision_id = ?
            ORDER BY e.timestamp
            """,
            (decision_id,),
        ).fetchall()
        out: list[dict[str, Any]] = []
        for row in rows:
            data = dict(row)
            if data.get("psychology_impact"):
                data["psychology_impact"] = json.loads(data["psychology_impact"])
            out.append(data)
        return out

    def get_decisions_for_event(self, event_id: int) -> list[str]:
        rows = self.conn.execute(
            "SELECT decision_id FROM decision_events WHERE event_id = ?",
            (event_id,),
        ).fetchall()
        return [str(r["decision_id"]) for r in rows]
