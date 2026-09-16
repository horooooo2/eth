"""Step-8 schema additions (balance_history, exchange_config_log, position cols)."""
from __future__ import annotations

import sqlite3


BALANCE_SQL = """
CREATE TABLE IF NOT EXISTS balance_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    balance REAL NOT NULL,
    equity REAL NOT NULL,
    source TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_balance_timestamp ON balance_history(timestamp);
"""

EXCHANGE_LOG_SQL = """
CREATE TABLE IF NOT EXISTS exchange_config_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, col_type: str) -> None:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    names = {str(r[1]) for r in rows}
    if column not in names:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}")


def apply_v8_migrations(conn: sqlite3.Connection) -> None:
    conn.executescript(BALANCE_SQL)
    conn.executescript(EXCHANGE_LOG_SQL)
    try:
        _ensure_column(conn, "positions", "exchange_order_id", "TEXT")
        _ensure_column(conn, "positions", "exchange_position_id", "TEXT")
    except sqlite3.Error:
        pass
    conn.commit()
