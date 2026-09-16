"""Step-12 schema: system_status for health / heartbeat mirror."""
from __future__ import annotations

import sqlite3

DDL = """
CREATE TABLE IF NOT EXISTS system_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    component TEXT NOT NULL,
    status TEXT NOT NULL,
    details TEXT,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_system_status_component ON system_status(component);
"""


def apply_v12_migrations(conn: sqlite3.Connection) -> None:
    conn.executescript(DDL)
    conn.commit()
