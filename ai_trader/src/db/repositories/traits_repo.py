"""Traits history repository."""
from __future__ import annotations

import sqlite3
from typing import Any


class TraitsRepo:
    """Daily trait snapshots."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def insert(self, traits: dict[str, Any]) -> None:
        self.conn.execute(
            """
            INSERT INTO traits_history (
                date, risk_appetite, patience, focus, self_doubt,
                stubbornness, stress, sleep_debt
            ) VALUES (?,?,?,?,?,?,?,?)
            """,
            (
                traits["date"],
                traits.get("risk_appetite"),
                traits.get("patience"),
                traits.get("focus"),
                traits.get("self_doubt"),
                traits.get("stubbornness"),
                traits.get("stress"),
                traits.get("sleep_debt"),
            ),
        )

    def list_by_daterange(self, start: str, end: str) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            """
            SELECT * FROM traits_history
            WHERE date >= ? AND date <= ?
            ORDER BY date
            """,
            (start, end),
        ).fetchall()
        return [dict(r) for r in rows]

    def latest(self) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM traits_history ORDER BY date DESC, id DESC LIMIT 1"
        ).fetchone()
        return dict(row) if row else None
