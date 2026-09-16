"""Step-10 schema: ambient_events + deadline_history."""
from __future__ import annotations

import sqlite3

AMBIENT_SQL = """
CREATE TABLE IF NOT EXISTS ambient_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    date TEXT NOT NULL,
    name TEXT NOT NULL,
    impacts TEXT,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ambient_date ON ambient_events(date);
"""

DEADLINE_SQL = """
CREATE TABLE IF NOT EXISTS deadline_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    day_number INTEGER NOT NULL,
    days_left INTEGER,
    pressure REAL,
    evaluation_action TEXT,
    evaluation_reason TEXT,
    new_deadline_days INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_deadline_date ON deadline_history(date);
"""


def apply_v10_migrations(conn: sqlite3.Connection) -> None:
    conn.executescript(AMBIENT_SQL)
    conn.executescript(DEADLINE_SQL)
    conn.commit()
