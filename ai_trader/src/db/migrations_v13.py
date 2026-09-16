"""Step-13 schema: news_checks + news_assessments."""
from __future__ import annotations

import sqlite3

DDL = """
CREATE TABLE IF NOT EXISTS news_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    window TEXT,
    context_tags TEXT,
    query TEXT,
    search_answer TEXT,
    sources TEXT,
    latency_ms INTEGER,
    token_usage TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_news_checks_timestamp ON news_checks(timestamp);

CREATE TABLE IF NOT EXISTS news_assessments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    check_id INTEGER,
    timestamp TEXT NOT NULL,
    direction TEXT,
    impact_level TEXT,
    key_point TEXT,
    event_type TEXT,
    confidence REAL,
    psychology_text TEXT,
    body_action_text TEXT,
    impact_applied TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (check_id) REFERENCES news_checks(id)
);
CREATE INDEX IF NOT EXISTS idx_news_assessments_timestamp ON news_assessments(timestamp);
CREATE INDEX IF NOT EXISTS idx_news_assessments_event_type ON news_assessments(event_type);
"""


def apply_v13_migrations(conn: sqlite3.Connection) -> None:
    conn.executescript(DDL)
    cols = {str(r[1]) for r in conn.execute("PRAGMA table_info(news_assessments)").fetchall()}
    if "window" not in cols:
        conn.execute("ALTER TABLE news_assessments ADD COLUMN window TEXT")
    conn.commit()
