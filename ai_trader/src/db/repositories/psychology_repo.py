"""Psychology log repository."""
from __future__ import annotations

import json
import sqlite3
from typing import Any


def _decode(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    data = dict(row)
    data["state_snapshot"] = json.loads(data["state_snapshot"])
    return data


class PsychologyRepo:
    """CRUD for psychology_log."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def insert(self, entry: dict[str, Any]) -> int:
        snap = entry["state_snapshot"]
        snap_json = snap if isinstance(snap, str) else json.dumps(snap, ensure_ascii=False)
        cur = self.conn.execute(
            """
            INSERT INTO psychology_log (
                timestamp, mood, mood_label, state_snapshot, narrative_text, prompt_version
            )
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                entry["timestamp"],
                entry.get("mood"),
                entry.get("mood_label"),
                snap_json,
                entry.get("narrative_text"),
                entry.get("prompt_version"),
            ),
        )
        return int(cur.lastrowid)

    def latest(self) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM psychology_log ORDER BY timestamp DESC, id DESC LIMIT 1"
        ).fetchone()
        return _decode(row)

    def list_by_timerange(self, start: str, end: str) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            """
            SELECT * FROM psychology_log
            WHERE timestamp >= ? AND timestamp <= ?
            ORDER BY timestamp
            """,
            (start, end),
        ).fetchall()
        return [_decode(r) for r in rows if r]  # type: ignore[misc]
