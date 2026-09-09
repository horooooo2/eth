"""Lightweight SQLite persistence for V4.1 engine state."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB = ROOT / "data" / "v41_engine.db"


class EngineStore:
    def __init__(self, path: Optional[Path] = None) -> None:
        self.path = Path(path or DEFAULT_DB)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._migrate()

    def _migrate(self) -> None:
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS closed_trades (
              id TEXT PRIMARY KEY,
              strategy_id TEXT,
              symbol TEXT,
              payload_json TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS trade_intents (
              intent_id TEXT PRIMARY KEY,
              strategy_id TEXT,
              status TEXT,
              payload_json TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS order_intents (
              order_intent_id TEXT PRIMARY KEY,
              trade_intent_id TEXT,
              status TEXT,
              payload_json TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS system_incidents (
              incident_id TEXT PRIMARY KEY,
              payload_json TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS strategy_health_snapshots (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              payload_json TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS market_regime_snapshots (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              payload_json TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS risk_budget_snapshots (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              payload_json TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS execution_metrics (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              payload_json TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS kv_state (
              key TEXT PRIMARY KEY,
              value_json TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS open_positions (
              position_id TEXT PRIMARY KEY,
              symbol TEXT NOT NULL,
              origin_strategy_id TEXT NOT NULL,
              origin_trade_intent_id TEXT NOT NULL,
              status TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            """
        )
        self._conn.commit()

    def upsert_intent(self, intent_id: str, strategy_id: str, status: str, payload: Dict[str, Any], updated_at: str) -> None:
        self._conn.execute(
            """
            INSERT INTO trade_intents(intent_id, strategy_id, status, payload_json, updated_at)
            VALUES(?,?,?,?,?)
            ON CONFLICT(intent_id) DO UPDATE SET
              strategy_id=excluded.strategy_id,
              status=excluded.status,
              payload_json=excluded.payload_json,
              updated_at=excluded.updated_at
            """,
            (intent_id, strategy_id, status, json.dumps(payload, ensure_ascii=False, default=str), updated_at),
        )
        self._conn.commit()

    def upsert_order_intent(self, order_intent_id: str, trade_intent_id: str, status: str, payload: Dict[str, Any], updated_at: str) -> None:
        self._conn.execute(
            """
            INSERT INTO order_intents(order_intent_id, trade_intent_id, status, payload_json, updated_at)
            VALUES(?,?,?,?,?)
            ON CONFLICT(order_intent_id) DO UPDATE SET
              trade_intent_id=excluded.trade_intent_id,
              status=excluded.status,
              payload_json=excluded.payload_json,
              updated_at=excluded.updated_at
            """,
            (
                order_intent_id,
                trade_intent_id,
                status,
                json.dumps(payload, ensure_ascii=False, default=str),
                updated_at,
            ),
        )
        self._conn.commit()

    def upsert_incident(self, incident_id: str, payload: Dict[str, Any], updated_at: str) -> None:
        self._conn.execute(
            """
            INSERT INTO system_incidents(incident_id, payload_json, updated_at)
            VALUES(?,?,?)
            ON CONFLICT(incident_id) DO UPDATE SET
              payload_json=excluded.payload_json,
              updated_at=excluded.updated_at
            """,
            (incident_id, json.dumps(payload, ensure_ascii=False, default=str), updated_at),
        )
        self._conn.commit()

    def add_closed_trade(self, trade_id: str, strategy_id: str, symbol: str, payload: Dict[str, Any], created_at: str) -> None:
        self._conn.execute(
            """
            INSERT OR REPLACE INTO closed_trades(id, strategy_id, symbol, payload_json, created_at)
            VALUES(?,?,?,?,?)
            """,
            (trade_id, strategy_id, symbol, json.dumps(payload, ensure_ascii=False, default=str), created_at),
        )
        self._conn.commit()

    def snapshot_row(self, table: str, payload: Dict[str, Any], created_at: str) -> None:
        allowed = {
            "strategy_health_snapshots",
            "market_regime_snapshots",
            "risk_budget_snapshots",
            "execution_metrics",
        }
        if table not in allowed:
            return
        self._conn.execute(
            f"INSERT INTO {table}(payload_json, created_at) VALUES(?,?)",
            (json.dumps(payload, ensure_ascii=False, default=str), created_at),
        )
        self._conn.commit()

    def set_kv(self, key: str, value: Any, updated_at: str) -> None:
        self._conn.execute(
            """
            INSERT INTO kv_state(key, value_json, updated_at) VALUES(?,?,?)
            ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
            """,
            (key, json.dumps(value, ensure_ascii=False, default=str), updated_at),
        )
        self._conn.commit()

    def get_kv(self, key: str) -> Any:
        row = self._conn.execute("SELECT value_json FROM kv_state WHERE key=?", (key,)).fetchone()
        if not row:
            return None
        try:
            return json.loads(row["value_json"])
        except Exception:
            return None

    def list_incidents(self, limit: int = 50) -> List[Dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT payload_json FROM system_incidents ORDER BY updated_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        out = []
        for r in rows:
            try:
                out.append(json.loads(r["payload_json"]))
            except Exception:
                pass
        return out

    def list_order_intents(self, limit: int = 100) -> List[Dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT payload_json FROM order_intents ORDER BY updated_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        out: List[Dict[str, Any]] = []
        for r in rows:
            try:
                item = json.loads(r["payload_json"])
                if isinstance(item, dict):
                    out.append(item)
            except Exception:
                pass
        return out

    def list_trade_intents(self, limit: int = 100) -> List[Dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT payload_json FROM trade_intents ORDER BY updated_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        out: List[Dict[str, Any]] = []
        for r in rows:
            try:
                item = json.loads(r["payload_json"])
                if isinstance(item, dict):
                    out.append(item)
            except Exception:
                pass
        return out

    def upsert_open_position(self, position: Dict[str, Any], updated_at: str) -> None:
        pid = str(position.get("position_id") or "")
        if not pid:
            return
        self._conn.execute(
            """
            INSERT INTO open_positions(
              position_id, symbol, origin_strategy_id, origin_trade_intent_id,
              status, payload_json, updated_at
            ) VALUES(?,?,?,?,?,?,?)
            ON CONFLICT(position_id) DO UPDATE SET
              symbol=excluded.symbol,
              origin_strategy_id=excluded.origin_strategy_id,
              origin_trade_intent_id=excluded.origin_trade_intent_id,
              status=excluded.status,
              payload_json=excluded.payload_json,
              updated_at=excluded.updated_at
            """,
            (
                pid,
                str(position.get("symbol") or ""),
                str(position.get("origin_strategy_id") or ""),
                str(position.get("origin_trade_intent_id") or ""),
                str(position.get("status") or "OPEN"),
                json.dumps(position, ensure_ascii=False, default=str),
                updated_at,
            ),
        )
        self._conn.commit()

    def list_open_positions(self, limit: int = 200) -> List[Dict[str, Any]]:
        rows = self._conn.execute(
            """
            SELECT payload_json FROM open_positions
            WHERE status='OPEN'
            ORDER BY updated_at DESC LIMIT ?
            """,
            (limit,),
        ).fetchall()
        out: List[Dict[str, Any]] = []
        for r in rows:
            try:
                item = json.loads(r["payload_json"])
                if isinstance(item, dict):
                    out.append(item)
            except Exception:
                pass
        return out

    def close(self) -> None:
        self._conn.close()
