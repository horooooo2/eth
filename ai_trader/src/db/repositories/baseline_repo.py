"""Baseline traits history repository."""
from __future__ import annotations

import json
import sqlite3
from typing import Any


class BaselineRepo:
    """Persist baseline snapshots and evolution reasons."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def insert_snapshot(
        self,
        date: str,
        baseline: dict[str, Any],
        reason: str | None = None,
        detail: dict[str, Any] | list[Any] | None = None,
    ) -> int:
        cur = self.conn.execute(
            """
            INSERT INTO baseline_traits_history (
                date, risk_appetite, patience, focus, self_doubt,
                stubbornness, stress, sleep_debt, change_reason, change_detail
            ) VALUES (?,?,?,?,?,?,?,?,?,?)
            """,
            (
                date,
                baseline.get("risk_appetite"),
                baseline.get("patience"),
                baseline.get("focus"),
                baseline.get("self_doubt"),
                baseline.get("stubbornness"),
                baseline.get("stress"),
                baseline.get("sleep_debt"),
                reason,
                json.dumps(detail, ensure_ascii=False) if detail is not None else None,
            ),
        )
        return int(cur.lastrowid)

    def list_recent(self, days: int = 30) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            """
            SELECT * FROM baseline_traits_history
            ORDER BY id DESC
            LIMIT ?
            """,
            (max(1, int(days)),),
        ).fetchall()
        out: list[dict[str, Any]] = []
        for r in reversed(rows):
            item = dict(r)
            if item.get("change_detail"):
                try:
                    item["change_detail"] = json.loads(item["change_detail"])
                except (TypeError, json.JSONDecodeError):
                    pass
            out.append(item)
        return out

    def latest(self) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM baseline_traits_history ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if not row:
            return None
        item = dict(row)
        if item.get("change_detail"):
            try:
                item["change_detail"] = json.loads(item["change_detail"])
            except (TypeError, json.JSONDecodeError):
                pass
        return item
