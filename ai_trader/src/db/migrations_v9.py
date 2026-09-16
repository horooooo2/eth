"""Step-9 schema: baseline_traits_history + trauma_events."""
from __future__ import annotations

import sqlite3

BASELINE_SQL = """
CREATE TABLE IF NOT EXISTS baseline_traits_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    risk_appetite REAL,
    patience REAL,
    focus REAL,
    self_doubt REAL,
    stubbornness REAL,
    stress REAL,
    sleep_debt REAL,
    change_reason TEXT,
    change_detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_baseline_date ON baseline_traits_history(date);
"""

TRAUMA_SQL = """
CREATE TABLE IF NOT EXISTS trauma_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    event_type TEXT NOT NULL,
    description TEXT,
    baseline_impact TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trauma_timestamp ON trauma_events(timestamp);
"""


def apply_v9_migrations(conn: sqlite3.Connection) -> None:
    conn.executescript(BASELINE_SQL)
    conn.executescript(TRAUMA_SQL)
    conn.commit()
