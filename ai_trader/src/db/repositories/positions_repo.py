"""Positions repository."""
from __future__ import annotations

import json
import sqlite3
from typing import Any


def _encode(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


def _decode(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    data = dict(row)
    for key in ("psychology_at_entry", "psychology_at_exit"):
        if data.get(key):
            data[key] = json.loads(data[key])
    return data


class PositionsRepo:
    """CRUD for positions with close updates and stats."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def insert(self, position: dict[str, Any]) -> None:
        self.conn.execute(
            """
            INSERT INTO positions (
                position_id, decision_id, symbol, side, leverage, margin, notional,
                entry_price, exit_price, stop_loss, take_profit, status,
                realized_pnl, fees, max_favorable_excursion, max_adverse_excursion,
                entry_time, exit_time, exit_reason, psychology_at_entry, psychology_at_exit
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                position["position_id"],
                position.get("decision_id"),
                position["symbol"],
                position["side"],
                position.get("leverage"),
                position.get("margin"),
                position.get("notional"),
                position.get("entry_price"),
                position.get("exit_price"),
                position.get("stop_loss"),
                position.get("take_profit"),
                position.get("status", "OPEN"),
                position.get("realized_pnl", 0.0),
                position.get("fees", 0.0),
                position.get("max_favorable_excursion", 0.0),
                position.get("max_adverse_excursion", 0.0),
                position.get("entry_time"),
                position.get("exit_time"),
                position.get("exit_reason"),
                _encode(position.get("psychology_at_entry")),
                _encode(position.get("psychology_at_exit")),
            ),
        )

    def get_by_id(self, position_id: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM positions WHERE position_id = ?",
            (position_id,),
        ).fetchone()
        return _decode(row)

    def update_close(self, position_id: str, exit_data: dict[str, Any]) -> None:
        self.conn.execute(
            """
            UPDATE positions SET
                exit_price = ?,
                exit_time = ?,
                exit_reason = ?,
                realized_pnl = ?,
                fees = COALESCE(?, fees),
                max_favorable_excursion = COALESCE(?, max_favorable_excursion),
                max_adverse_excursion = COALESCE(?, max_adverse_excursion),
                psychology_at_exit = ?,
                status = 'CLOSED'
            WHERE position_id = ?
            """,
            (
                exit_data.get("exit_price"),
                exit_data.get("exit_time"),
                exit_data.get("exit_reason"),
                exit_data.get("realized_pnl", 0.0),
                exit_data.get("fees"),
                exit_data.get("max_favorable_excursion"),
                exit_data.get("max_adverse_excursion"),
                _encode(exit_data.get("psychology_at_exit")),
                position_id,
            ),
        )

    def list_open(self) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM positions WHERE status = 'OPEN' ORDER BY entry_time"
        ).fetchall()
        return [_decode(r) for r in rows if r]  # type: ignore[misc]

    def list_closed(self, limit: int = 100) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            """
            SELECT * FROM positions WHERE status = 'CLOSED'
            ORDER BY exit_time DESC LIMIT ?
            """,
            (limit,),
        ).fetchall()
        return [_decode(r) for r in rows if r]  # type: ignore[misc]

    def stats_by_mode(self) -> dict[str, Any]:
        rows = self.conn.execute(
            """
            SELECT d.primary_mode AS mode,
                   COUNT(*) AS n,
                   SUM(CASE WHEN p.realized_pnl > 0 THEN 1 ELSE 0 END) AS wins,
                   AVG(p.realized_pnl) AS avg_pnl
            FROM positions p
            LEFT JOIN decision_log d ON d.decision_id = p.decision_id
            WHERE p.status = 'CLOSED'
            GROUP BY d.primary_mode
            """
        ).fetchall()
        out: dict[str, Any] = {}
        for r in rows:
            n = int(r["n"] or 0)
            wins = int(r["wins"] or 0)
            out[str(r["mode"] or "UNKNOWN")] = {
                "count": n,
                "wins": wins,
                "win_rate": (wins / n) if n else 0.0,
                "avg_pnl": float(r["avg_pnl"] or 0.0),
            }
        return out

    def win_rate(self) -> float:
        row = self.conn.execute(
            """
            SELECT
                SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) AS wins,
                COUNT(*) AS n
            FROM positions WHERE status = 'CLOSED'
            """
        ).fetchone()
        if not row or not row["n"]:
            return 0.0
        return float(row["wins"] or 0) / float(row["n"])

    def avg_mfe_mae(self) -> dict[str, float]:
        row = self.conn.execute(
            """
            SELECT AVG(max_favorable_excursion) AS mfe,
                   AVG(max_adverse_excursion) AS mae
            FROM positions WHERE status = 'CLOSED'
            """
        ).fetchone()
        return {
            "avg_mfe": float(row["mfe"] or 0.0) if row else 0.0,
            "avg_mae": float(row["mae"] or 0.0) if row else 0.0,
        }
