"""Clear timeline-related tables for a fresh live AI run."""
from __future__ import annotations

import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
import sys

sys.path.insert(0, str(ROOT))
from src.db.path import get_db_path

TARGETS = [get_db_path()]
WIPE = (
    "decision_events",
    "psychology_log",
    "ambient_events",
    "decision_log",
    "events",
    "trauma_events",
)


def clear(path: Path) -> None:
    if not path.exists():
        print("skip", path)
        return
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA foreign_keys = OFF")
    tables = {
        r[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }
    print("===", path)
    if "positions" in tables:
        try:
            conn.execute(
                "UPDATE positions SET decision_id = NULL WHERE decision_id IS NOT NULL"
            )
        except sqlite3.Error as exc:
            print("  positions update:", exc)
    for name in WIPE:
        if name not in tables:
            print(f"  {name}: (no table)")
            continue
        n = conn.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0]
        conn.execute(f"DELETE FROM {name}")
        print(f"  {name}: deleted {n}")
    conn.commit()
    conn.execute("PRAGMA foreign_keys = ON")
    conn.close()


if __name__ == "__main__":
    for p in TARGETS:
        clear(p)
