"""SQLite connection helpers."""
from __future__ import annotations

import sqlite3
from pathlib import Path


def get_connection(db_path: str | Path) -> sqlite3.Connection:
    """Open DB with Row factory, FK enforcement, and WAL."""
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def close_connection(conn: sqlite3.Connection) -> None:
    """Commit and close."""
    conn.commit()
    conn.close()
