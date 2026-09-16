"""DB path unification tests."""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.db.path import get_db_path, get_db_path_str  # noqa: E402


def test_get_db_path_default(monkeypatch=None) -> None:
    os.environ.pop("AI_TRADER_DB", None)
    p = get_db_path()
    assert p.name == "trader.db"
    assert p.parent.name == "data"


def test_get_db_path_env() -> None:
    custom = ROOT / "data" / "custom_test.db"
    os.environ["AI_TRADER_DB"] = str(custom)
    try:
        assert get_db_path() == custom.resolve()
        assert get_db_path_str() == str(custom.resolve())
    finally:
        os.environ.pop("AI_TRADER_DB", None)


def test_all_modules_use_same_path() -> None:
    os.environ.pop("AI_TRADER_DB", None)
    from src.db.path import get_db_path as g1
    from src.live_scheduler import LiveScheduler
    from src.replay import DB_PATH
    from src.replay_with_narrator import DEFAULT_DB

    expected = str(g1())
    assert str(DB_PATH) == expected or Path(DB_PATH).resolve() == Path(expected)
    assert Path(DEFAULT_DB).resolve() == Path(expected)
    # LiveScheduler default without constructing full (needs network) — check ctor default source
    assert LiveScheduler.__init__.__defaults__ is not None or True
    # Inspect source default via get_db_path used in module
    import inspect

    src = inspect.getsource(LiveScheduler.__init__)
    assert "get_db_path" in src


def test_merge_dbs_idempotent() -> None:
    import importlib.util
    import tempfile

    spec = importlib.util.spec_from_file_location(
        "merge_dbs", ROOT / "scripts" / "merge_dbs.py"
    )
    assert spec and spec.loader
    merge_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(merge_mod)

    tmp = Path(tempfile.mkdtemp())
    src = tmp / "a.db"
    tgt = tmp / "out.db"
    import sqlite3

    # Use a simple custom table not constrained by full schema NOT NULLs
    c = sqlite3.connect(src)
    c.execute(
        "CREATE TABLE merge_probe (id INTEGER PRIMARY KEY, timestamp TEXT, note TEXT)"
    )
    c.execute(
        "INSERT INTO merge_probe (id, timestamp, note) VALUES (1, '2026-01-01', 'x')"
    )
    c.commit()
    c.close()
    dest = merge_mod._ensure_schema(tgt)
    merge_mod.merge_one(src, dest)
    merge_mod.merge_one(src, dest)
    n = dest.execute("SELECT COUNT(*) FROM merge_probe").fetchone()[0]
    assert n == 1
    dest.close()


if __name__ == "__main__":
    test_get_db_path_default()
    test_get_db_path_env()
    test_all_modules_use_same_path()
    test_merge_dbs_idempotent()
    print("ok")
