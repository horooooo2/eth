"""
合并多个 SQLite DB 到一个统一的 trader.db。

用法：
    python scripts/merge_dbs.py --sources data/trader_narrative.db --target data/trader.db
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.db.connection import get_connection  # noqa: E402
from src.db.migrations_v8 import apply_v8_migrations  # noqa: E402
from src.db.migrations_v9 import apply_v9_migrations  # noqa: E402
from src.db.migrations_v10 import apply_v10_migrations  # noqa: E402
from src.db.migrations_v11 import apply_v11_migrations  # noqa: E402
from src.db.migrations_v12 import apply_v12_migrations  # noqa: E402
from src.db.schema import init_database  # noqa: E402


def _table_names(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    return [str(r[0]) for r in rows]


def _pk_cols(conn: sqlite3.Connection, table: str) -> list[str]:
    info = conn.execute(f"PRAGMA table_info({table})").fetchall()
    pks = [str(r[1]) for r in info if int(r[5] or 0) > 0]
    return pks


def _ensure_schema(target: Path) -> sqlite3.Connection:
    conn = get_connection(target)
    init_database(conn)
    apply_v8_migrations(conn)
    apply_v9_migrations(conn)
    apply_v10_migrations(conn)
    apply_v11_migrations(conn)
    apply_v12_migrations(conn)
    return conn


def merge_one(src: Path, dest_conn: sqlite3.Connection) -> dict[str, int]:
    stats: dict[str, int] = {}
    if not src.exists():
        print(f"skip missing {src}")
        return stats
    src_conn = sqlite3.connect(str(src))
    src_conn.row_factory = sqlite3.Row
    for table in _table_names(src_conn):
        if table not in _table_names(dest_conn):
            # copy schema
            schema = src_conn.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
                (table,),
            ).fetchone()
            if schema and schema[0]:
                dest_conn.execute(schema[0])
        cols = [str(r[1]) for r in dest_conn.execute(f"PRAGMA table_info({table})").fetchall()]
        if not cols:
            continue
        pks = _pk_cols(dest_conn, table)
        inserted = 0
        for row in src_conn.execute(f"SELECT * FROM {table}"):
            data = {c: row[c] for c in row.keys() if c in cols}
            if not data:
                continue
            if pks and all(data.get(k) is not None for k in pks):
                where = " AND ".join(f"{k}=?" for k in pks)
                existing = dest_conn.execute(
                    f"SELECT * FROM {table} WHERE {where}",
                    tuple(data[k] for k in pks),
                ).fetchone()
                if existing:
                    # keep later timestamp if both have timestamp
                    if "timestamp" in data and "timestamp" in existing.keys():
                        if str(data["timestamp"] or "") <= str(existing["timestamp"] or ""):
                            continue
                        sets = ", ".join(f"{c}=?" for c in data if c not in pks)
                        if sets:
                            dest_conn.execute(
                                f"UPDATE {table} SET {sets} WHERE {where}",
                                tuple(data[c] for c in data if c not in pks)
                                + tuple(data[k] for k in pks),
                            )
                            inserted += 1
                    continue
            placeholders = ", ".join("?" for _ in data)
            col_list = ", ".join(data.keys())
            before = dest_conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            try:
                dest_conn.execute(
                    f"INSERT OR IGNORE INTO {table} ({col_list}) VALUES ({placeholders})",
                    tuple(data.values()),
                )
            except sqlite3.Error as exc:
                print(f"  skip row in {table}: {exc}")
                continue
            after = dest_conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            if after > before:
                inserted += 1
        stats[table] = inserted
    src_conn.close()
    dest_conn.commit()
    return stats


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--sources",
        nargs="+",
        default=["data/trader_narrative.db"],
    )
    parser.add_argument("--target", default="data/trader.db")
    args = parser.parse_args()
    target = Path(args.target)
    if not target.is_absolute():
        target = ROOT / target
    dest = _ensure_schema(target)
    print(f"target={target}")
    for raw in args.sources:
        src = Path(raw)
        if not src.is_absolute():
            src = ROOT / src
        if src.resolve() == target.resolve():
            print(f"skip self {src}")
            continue
        stats = merge_one(src, dest)
        print(f"merged {src}: {stats}")
    dest.close()
    print("done (sources kept)")


if __name__ == "__main__":
    main()
