"""Ambient events repository."""
from __future__ import annotations

import json
import sqlite3
from typing import Any


class AmbientRepo:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def insert_events(self, events: list[dict[str, Any]]) -> int:
        n = 0
        for evt in events:
            self.conn.execute(
                """
                INSERT INTO ambient_events (timestamp, date, name, impacts, description)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    evt.get("timestamp"),
                    evt.get("date") or str(evt.get("timestamp") or "")[:10],
                    evt.get("name"),
                    json.dumps(evt.get("impacts") or {}, ensure_ascii=False),
                    evt.get("description"),
                ),
            )
            n += 1
        return n

    def list_by_date(self, date: str) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM ambient_events WHERE date = ? ORDER BY timestamp",
            (date,),
        ).fetchall()
        return [self._decode(r) for r in rows]

    def list_recent(self, days: int = 30) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM ambient_events ORDER BY id DESC LIMIT ?",
            (max(1, int(days) * 5),),
        ).fetchall()
        return [self._decode(r) for r in reversed(rows)]

    def stats_by_name(self) -> dict[str, int]:
        rows = self.conn.execute(
            "SELECT name, COUNT(*) AS n FROM ambient_events GROUP BY name"
        ).fetchall()
        return {str(r["name"]): int(r["n"]) for r in rows}

    @staticmethod
    def _decode(row: sqlite3.Row) -> dict[str, Any]:
        item = dict(row)
        if item.get("impacts"):
            try:
                item["impacts"] = json.loads(item["impacts"])
            except (TypeError, json.JSONDecodeError):
                pass
        return item
