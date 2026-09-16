"""Schema / connection / config hash tests."""
from __future__ import annotations

import json
import sys
import tempfile
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.db import compute_config_hash, get_connection, init_database

REQUIRED_TABLES = {
    "events",
    "psychology_log",
    "decision_log",
    "decision_events",
    "positions",
    "traits_history",
}


def test_schema_creates_all_tables() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        conn = get_connection(Path(tmp) / "t.db")
        init_database(conn)
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
        names = {r["name"] for r in rows}
        assert REQUIRED_TABLES.issubset(names)
        conn.close()


def test_schema_is_idempotent() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        conn = get_connection(Path(tmp) / "t.db")
        init_database(conn)
        init_database(conn)
        conn.close()


def test_foreign_keys_enabled() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        conn = get_connection(Path(tmp) / "t.db")
        row = conn.execute("PRAGMA foreign_keys").fetchone()
        assert int(row[0]) == 1
        conn.close()


def test_config_hash_changes() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        cfg = Path(tmp)
        (cfg / "a.json").write_text(json.dumps({"v": 1}), encoding="utf-8")
        (cfg / "b.json").write_text(json.dumps({"x": 2}), encoding="utf-8")
        h1 = compute_config_hash(cfg)
        h2 = compute_config_hash(cfg)
        assert h1 == h2
        assert len(h1) == 16
        (cfg / "a.json").write_text(json.dumps({"v": 2}), encoding="utf-8")
        h3 = compute_config_hash(cfg)
        assert h3 != h1


def run() -> int:
    tests = [
        test_schema_creates_all_tables,
        test_schema_is_idempotent,
        test_foreign_keys_enabled,
        test_config_hash_changes,
    ]
    passed = failed = 0
    details: list[str] = []
    for fn in tests:
        try:
            fn()
            passed += 1
            details.append(f"PASS  {fn.__name__}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            details.append(f"FAIL  {fn.__name__}: {exc}")
            details.append(traceback.format_exc())
    print("=== test_db_schema ===")
    for line in details:
        print(line)
    print(f"---\npassed={passed} failed={failed} total={len(tests)}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(run())
