"""Lightweight SQLite persistence for V4.1 engine state."""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB = ROOT / "data" / "v41_engine.db"


class EngineStore:
    def __init__(self, path: Optional[Path] = None) -> None:
        self.path = Path(path or DEFAULT_DB)
        if os.environ.get("PYTEST_CURRENT_TEST") and self.path.resolve() == Path(DEFAULT_DB).resolve():
            raise RuntimeError(
                "tests must use an explicit temp EngineStore path; "
                "do not write ai-trading-system-v41/data/v41_engine.db"
            )
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
            CREATE TABLE IF NOT EXISTS runtime_events (
              event_id TEXT PRIMARY KEY,
              occurred_at TEXT NOT NULL,
              created_at TEXT NOT NULL,
              event_type TEXT NOT NULL,
              severity TEXT NOT NULL,
              strategy_id TEXT,
              symbol TEXT,
              direction TEXT,
              decision TEXT,
              reason_code TEXT,
              reason_codes_json TEXT,
              source_closed_candle_timestamp TEXT,
              trade_intent_id TEXT,
              order_intent_id TEXT,
              position_id TEXT,
              signal_key TEXT,
              message TEXT,
              details_json TEXT,
              reason_signature TEXT,
              no_trade_key TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_runtime_events_occurred
              ON runtime_events(occurred_at DESC, event_id DESC);
            CREATE INDEX IF NOT EXISTS idx_runtime_events_type
              ON runtime_events(event_type, occurred_at DESC);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_events_no_trade
              ON runtime_events(no_trade_key)
              WHERE event_type = 'STRATEGY_NO_TRADE'
                AND no_trade_key IS NOT NULL
                AND no_trade_key != '';
            CREATE TABLE IF NOT EXISTS s9_microstructure_research (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              strategy_id TEXT NOT NULL,
              symbol TEXT NOT NULL,
              closed_1m_timestamp TEXT NOT NULL,
              direction TEXT NOT NULL,
              recorded_at TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              outcome_json TEXT,
              outcome_updated_at TEXT,
              UNIQUE(strategy_id, symbol, closed_1m_timestamp, direction)
            );
            CREATE INDEX IF NOT EXISTS idx_s9_msr_recorded
              ON s9_microstructure_research(recorded_at DESC);
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

    def insert_runtime_event(self, row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        event_id = str(row.get("event_id") or "").strip()
        if not event_id:
            return None
        codes = row.get("reason_codes")
        if isinstance(codes, str):
            reason_codes_json = codes
        else:
            reason_codes_json = json.dumps(list(codes or []), ensure_ascii=False)
        details = row.get("details") if isinstance(row.get("details"), dict) else {}
        try:
            self._conn.execute(
                """
                INSERT INTO runtime_events(
                  event_id, occurred_at, created_at, event_type, severity,
                  strategy_id, symbol, direction, decision, reason_code,
                  reason_codes_json, source_closed_candle_timestamp,
                  trade_intent_id, order_intent_id, position_id, signal_key,
                  message, details_json, reason_signature, no_trade_key
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    event_id,
                    str(row.get("occurred_at") or ""),
                    str(row.get("created_at") or row.get("occurred_at") or ""),
                    str(row.get("event_type") or ""),
                    str(row.get("severity") or "info"),
                    str(row.get("strategy_id") or ""),
                    str(row.get("symbol") or ""),
                    str(row.get("direction") or ""),
                    str(row.get("decision") or ""),
                    str(row.get("reason_code") or ""),
                    reason_codes_json,
                    str(row.get("source_closed_candle_timestamp") or ""),
                    str(row.get("trade_intent_id") or ""),
                    str(row.get("order_intent_id") or ""),
                    str(row.get("position_id") or ""),
                    str(row.get("signal_key") or ""),
                    str(row.get("message") or ""),
                    json.dumps(details, ensure_ascii=False, default=str),
                    str(row.get("reason_signature") or ""),
                    str(row.get("no_trade_key") or ""),
                ),
            )
            self._conn.commit()
        except sqlite3.IntegrityError:
            return None
        return self.get_runtime_event(event_id)

    def get_runtime_event(self, event_id: str) -> Optional[Dict[str, Any]]:
        row = self._conn.execute(
            "SELECT * FROM runtime_events WHERE event_id = ?",
            (event_id,),
        ).fetchone()
        return self._runtime_event_from_row(row) if row else None

    def list_runtime_events(
        self,
        *,
        limit: int = 200,
        before: Optional[str] = None,
        after: Optional[str] = None,
        before_event_id: Optional[str] = None,
        after_event_id: Optional[str] = None,
        strategy_id: Optional[str] = None,
        symbol: Optional[str] = None,
        event_type: Optional[str] = None,
        severity: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        clauses = ["1=1"]
        args: List[Any] = []
        if before:
            before_id = str(before_event_id or "").strip()
            if before_id:
                clauses.append("(occurred_at < ? OR (occurred_at = ? AND event_id < ?))")
                args.extend([before, before, before_id])
            else:
                clauses.append("occurred_at < ?")
                args.append(before)
        if after:
            after_id = str(after_event_id or "").strip()
            if after_id:
                clauses.append("(occurred_at > ? OR (occurred_at = ? AND event_id > ?))")
                args.extend([after, after, after_id])
            else:
                clauses.append("occurred_at > ?")
                args.append(after)
        if strategy_id:
            clauses.append("UPPER(strategy_id) = UPPER(?)")
            args.append(strategy_id)
        if symbol:
            clauses.append("UPPER(symbol) = UPPER(?)")
            args.append(symbol)
        if event_type:
            clauses.append("event_type = ?")
            args.append(event_type)
        if severity:
            clauses.append("severity = ?")
            args.append(severity)
        lim = max(1, min(int(limit or 200), 500))
        args.append(lim)
        rows = self._conn.execute(
            f"""
            SELECT * FROM runtime_events
            WHERE {' AND '.join(clauses)}
            ORDER BY occurred_at DESC, event_id DESC
            LIMIT ?
            """,
            args,
        ).fetchall()
        return [self._runtime_event_from_row(r) for r in rows if r]

    @staticmethod
    def _runtime_event_from_row(row: sqlite3.Row) -> Dict[str, Any]:
        codes: List[Any] = []
        try:
            parsed = json.loads(row["reason_codes_json"] or "[]")
            if isinstance(parsed, list):
                codes = parsed
        except Exception:
            codes = []
        details: Dict[str, Any] = {}
        try:
            parsed_d = json.loads(row["details_json"] or "{}")
            if isinstance(parsed_d, dict):
                details = parsed_d
        except Exception:
            details = {}
        return {
            "event_id": row["event_id"],
            "occurred_at": row["occurred_at"],
            "created_at": row["created_at"],
            "event_type": row["event_type"],
            "severity": row["severity"],
            "strategy_id": row["strategy_id"],
            "symbol": row["symbol"],
            "direction": row["direction"],
            "decision": row["decision"],
            "reason_code": row["reason_code"],
            "reason_codes": codes,
            "reason_codes_json": row["reason_codes_json"],
            "source_closed_candle_timestamp": row["source_closed_candle_timestamp"],
            "trade_intent_id": row["trade_intent_id"],
            "order_intent_id": row["order_intent_id"],
            "position_id": row["position_id"],
            "signal_key": row["signal_key"],
            "message": row["message"],
            "details": details,
            "details_json": row["details_json"],
            "reason_signature": row["reason_signature"],
            "no_trade_key": row["no_trade_key"],
            "source": "python",
        }

    def insert_s9_microstructure_research(
        self,
        *,
        strategy_id: str,
        symbol: str,
        closed_1m_timestamp: str,
        direction: str,
        recorded_at: str,
        payload: Dict[str, Any],
    ) -> bool:
        cur = self._conn.execute(
            """
            INSERT OR IGNORE INTO s9_microstructure_research(
              strategy_id, symbol, closed_1m_timestamp, direction, recorded_at, payload_json
            ) VALUES(?,?,?,?,?,?)
            """,
            (
                strategy_id,
                symbol,
                closed_1m_timestamp,
                direction,
                recorded_at,
                json.dumps(payload, ensure_ascii=False, default=str),
            ),
        )
        self._conn.commit()
        return int(cur.rowcount or 0) > 0

    def update_s9_microstructure_outcome(self, row_id: int, outcome: Dict[str, Any], updated_at: str) -> None:
        self._conn.execute(
            """
            UPDATE s9_microstructure_research
            SET outcome_json=?, outcome_updated_at=?
            WHERE id=?
            """,
            (json.dumps(outcome, ensure_ascii=False, default=str), updated_at, int(row_id)),
        )
        self._conn.commit()

    def list_s9_microstructure_research(
        self,
        *,
        since: Optional[str] = None,
        pending_outcome: bool = False,
        limit: int = 5000,
    ) -> List[Dict[str, Any]]:
        sql = "SELECT * FROM s9_microstructure_research"
        args: List[Any] = []
        clauses: List[str] = []
        if since:
            clauses.append("recorded_at >= ?")
            args.append(since)
        if pending_outcome:
            clauses.append("(outcome_json IS NULL OR outcome_json = '')")
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY recorded_at ASC LIMIT ?"
        args.append(int(limit))
        rows = self._conn.execute(sql, args).fetchall()
        out: List[Dict[str, Any]] = []
        for row in rows:
            payload = {}
            outcome = None
            try:
                payload = json.loads(row["payload_json"] or "{}")
            except Exception:
                payload = {}
            try:
                if row["outcome_json"]:
                    outcome = json.loads(row["outcome_json"])
            except Exception:
                outcome = None
            out.append(
                {
                    "id": row["id"],
                    "strategy_id": row["strategy_id"],
                    "symbol": row["symbol"],
                    "closed_1m_timestamp": row["closed_1m_timestamp"],
                    "direction": row["direction"],
                    "recorded_at": row["recorded_at"],
                    "payload": payload,
                    "outcome": outcome,
                    "outcome_updated_at": row["outcome_updated_at"],
                }
            )
        return out

    def close(self) -> None:
        self._conn.close()
