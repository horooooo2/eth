"""Decision log repository."""
from __future__ import annotations

import json
import sqlite3
from typing import Any


def _encode_json(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


def _decode(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    data = dict(row)
    for key in ("psychology_before", "modifiers", "decision_reason"):
        if data.get(key):
            data[key] = json.loads(data[key])
    return data


class DecisionRepo:
    """CRUD for decision_log."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def insert(self, decision: dict[str, Any]) -> None:
        self.conn.execute(
            """
            INSERT INTO decision_log (
                decision_id, timestamp, symbol, direction, signal_rule,
                signal_raw_score, signal_score, signal_reason, signal_rule_version,
                psychology_before, primary_mode, modifiers, behavior_rule_version,
                decision_reason, decision_rule_version, decision, position_multiplier,
                risk_check, risk_reject_reason, narrative_thought, narrative_body_action,
                narrative_generated_at, position_id, config_snapshot_hash, prompt_version
            ) VALUES (
                ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
            )
            """,
            (
                decision["decision_id"],
                decision["timestamp"],
                decision.get("symbol"),
                decision.get("direction"),
                decision.get("signal_rule"),
                decision.get("signal_raw_score"),
                decision.get("signal_score"),
                decision.get("signal_reason"),
                decision.get("signal_rule_version"),
                _encode_json(decision.get("psychology_before")),
                decision.get("primary_mode"),
                _encode_json(decision.get("modifiers")),
                decision.get("behavior_rule_version"),
                _encode_json(decision.get("decision_reason")),
                decision.get("decision_rule_version"),
                decision.get("decision"),
                decision.get("position_multiplier"),
                decision.get("risk_check"),
                decision.get("risk_reject_reason"),
                decision.get("narrative_thought"),
                decision.get("narrative_body_action"),
                decision.get("narrative_generated_at"),
                decision.get("position_id"),
                decision.get("config_snapshot_hash"),
                decision.get("prompt_version"),
            ),
        )

    def update_narrative(
        self,
        decision_id: str,
        narrative_thought: str,
        narrative_body_action: str,
        prompt_version: str,
    ) -> None:
        """Update narrative fields on an existing decision row."""
        self.conn.execute(
            """
            UPDATE decision_log
            SET narrative_thought = ?,
                narrative_body_action = ?,
                narrative_generated_at = datetime('now'),
                prompt_version = ?
            WHERE decision_id = ?
            """,
            (narrative_thought, narrative_body_action, prompt_version, decision_id),
        )

    def update_position_id(self, decision_id: str, position_id: str) -> None:
        self.conn.execute(
            "UPDATE decision_log SET position_id = ? WHERE decision_id = ?",
            (position_id, decision_id),
        )

    def get_by_id(self, decision_id: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM decision_log WHERE decision_id = ?",
            (decision_id,),
        ).fetchone()
        return _decode(row)

    def list_by_mode(self, primary_mode: str, limit: int = 100) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            """
            SELECT * FROM decision_log
            WHERE primary_mode = ?
            ORDER BY timestamp DESC LIMIT ?
            """,
            (primary_mode, limit),
        ).fetchall()
        return [_decode(r) for r in rows if r]  # type: ignore[misc]

    def count_by_mode(self) -> dict[str, int]:
        rows = self.conn.execute(
            """
            SELECT primary_mode, COUNT(*) AS c
            FROM decision_log
            GROUP BY primary_mode
            """
        ).fetchall()
        return {str(r["primary_mode"] or "UNKNOWN"): int(r["c"]) for r in rows}

    def list_open_decisions(self) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            """
            SELECT d.* FROM decision_log d
            WHERE d.decision LIKE 'OPEN_%'
              AND (d.position_id IS NULL OR d.position_id IN (
                  SELECT position_id FROM positions WHERE status = 'OPEN'
              ))
            ORDER BY d.timestamp DESC
            """
        ).fetchall()
        return [_decode(r) for r in rows if r]  # type: ignore[misc]
