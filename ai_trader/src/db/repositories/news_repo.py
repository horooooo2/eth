"""Repository for news_checks table."""
from __future__ import annotations

import json
import sqlite3
from typing import Any


class NewsRepo:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def insert_check(self, entry: dict[str, Any]) -> int:
        tags = entry.get("context_tags")
        if not isinstance(tags, str):
            tags = json.dumps(tags or [], ensure_ascii=False)
        sources = entry.get("sources")
        if not isinstance(sources, str):
            sources = json.dumps(sources or [], ensure_ascii=False)
        usage = entry.get("token_usage")
        if not isinstance(usage, str):
            usage = json.dumps(usage or {}, ensure_ascii=False)
        cur = self.conn.execute(
            """
            INSERT INTO news_checks (
                timestamp, window, context_tags, query, search_answer,
                sources, latency_ms, token_usage
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                entry.get("timestamp"),
                entry.get("window"),
                tags,
                entry.get("query"),
                entry.get("search_answer"),
                sources,
                entry.get("latency_ms"),
                usage,
            ),
        )
        self.conn.commit()
        return int(cur.lastrowid)

    def list_recent(self, days: int = 7) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            """
            SELECT * FROM news_checks
            WHERE timestamp >= datetime('now', ?)
            ORDER BY timestamp DESC
            """,
            (f"-{max(1, int(days))} days",),
        ).fetchall()
        return [self._decode(r) for r in rows]

    def get_today(self, day: str | None = None) -> list[dict[str, Any]]:
        if day:
            rows = self.conn.execute(
                """
                SELECT * FROM news_checks
                WHERE substr(timestamp, 1, 10) = ?
                ORDER BY timestamp
                """,
                (day,),
            ).fetchall()
        else:
            rows = self.conn.execute(
                """
                SELECT * FROM news_checks
                WHERE substr(timestamp, 1, 10) = date('now')
                ORDER BY timestamp
                """
            ).fetchall()
        return [self._decode(r) for r in rows]

    def count_today(self, day: str | None = None) -> int:
        if day:
            row = self.conn.execute(
                "SELECT COUNT(*) AS n FROM news_checks WHERE substr(timestamp, 1, 10) = ?",
                (day,),
            ).fetchone()
        else:
            row = self.conn.execute(
                "SELECT COUNT(*) AS n FROM news_checks WHERE substr(timestamp, 1, 10) = date('now')"
            ).fetchone()
        return int(row["n"] if row else 0)

    @staticmethod
    def _decode(row: sqlite3.Row) -> dict[str, Any]:
        item = dict(row)
        for key in ("context_tags", "sources", "token_usage"):
            val = item.get(key)
            if isinstance(val, str) and val:
                try:
                    item[key] = json.loads(val)
                except (TypeError, json.JSONDecodeError):
                    pass
        return item
