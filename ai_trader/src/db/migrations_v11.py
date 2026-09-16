"""Step-11 schema: conversation_messages."""
from __future__ import annotations

import sqlite3

CONVERSATION_SQL = """
CREATE TABLE IF NOT EXISTS conversation_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    state_snapshot TEXT,
    trigger_type TEXT DEFAULT 'passive',
    impact_applied TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_conv_timestamp ON conversation_messages(timestamp);
"""


def apply_v11_migrations(conn: sqlite3.Connection) -> None:
    conn.executescript(CONVERSATION_SQL)
    conn.commit()
