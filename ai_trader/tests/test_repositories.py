"""Repository layer unit tests."""
from __future__ import annotations

import sqlite3
import sys
import tempfile
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.db import get_connection, init_database
from src.db.repositories import (
    DecisionEventsRepo,
    DecisionRepo,
    EventsRepo,
    PositionsRepo,
    PsychologyRepo,
    TraitsRepo,
)


def _conn(tmp: str) -> sqlite3.Connection:
    conn = get_connection(Path(tmp) / "repo.db")
    init_database(conn)
    return conn


def test_events_insert_and_query() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        conn = _conn(tmp)
        repo = EventsRepo(conn)
        eid = repo.insert(
            {
                "timestamp": "2026-01-01T00:00:00+00:00",
                "event_type": "life",
                "event_class": "atomic",
                "name": "ARGUMENT_WITH_WIFE",
                "description": "fight",
                "psychology_impact": {"stress": 0.2},
            }
        )
        assert eid > 0
        rows = repo.list_by_name("ARGUMENT_WITH_WIFE")
        assert rows[0]["psychology_impact"]["stress"] == 0.2
        assert repo.count_by_class("atomic") == 1
        conn.close()


def test_decision_insert_with_json_fields() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        conn = _conn(tmp)
        repo = DecisionRepo(conn)
        payload = {
            "decision_id": "D1",
            "timestamp": "2026-01-01T00:00:00+00:00",
            "symbol": "BTC",
            "direction": "LONG",
            "signal_rule": "BREAKOUT",
            "signal_raw_score": 0.5,
            "signal_score": 0.7,
            "psychology_before": {"a": 1},
            "primary_mode": "NORMAL",
            "modifiers": ["LOW_FOCUS"],
            "decision_reason": {"base_threshold": 0.7},
            "decision": "OPEN_LONG",
            "position_multiplier": 1.0,
            "risk_check": "PASS",
            "config_snapshot_hash": "abc123",
        }
        repo.insert(payload)
        got = repo.get_by_id("D1")
        assert got is not None
        assert got["psychology_before"] == {"a": 1}
        assert got["modifiers"] == ["LOW_FOCUS"]
        assert got["decision_reason"]["base_threshold"] == 0.7
        conn.close()


def test_decision_events_link() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        conn = _conn(tmp)
        events = EventsRepo(conn)
        decisions = DecisionRepo(conn)
        links = DecisionEventsRepo(conn)
        decisions.insert(
            {
                "decision_id": "D2",
                "timestamp": "2026-01-01T00:00:00+00:00",
                "decision": "SKIP",
                "primary_mode": "NORMAL",
                "psychology_before": {},
                "modifiers": [],
                "decision_reason": {},
            }
        )
        eid = events.insert(
            {
                "timestamp": "2026-01-01T00:00:00+00:00",
                "event_type": "life",
                "event_class": "atomic",
                "name": "RENT_DUE",
                "psychology_impact": {"stress": 0.1},
            }
        )
        links.link("D2", eid)
        assert links.get_events_for_decision("D2")[0]["name"] == "RENT_DUE"
        assert links.get_decisions_for_event(eid) == ["D2"]
        try:
            links.link("D2", eid)
            raise AssertionError("duplicate link should fail")
        except sqlite3.IntegrityError:
            pass
        conn.close()


def test_positions_open_and_close() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        conn = _conn(tmp)
        DecisionRepo(conn).insert(
            {
                "decision_id": "D3",
                "timestamp": "2026-01-01T00:00:00+00:00",
                "decision": "OPEN_LONG",
                "primary_mode": "NORMAL",
                "psychology_before": {},
                "modifiers": [],
                "decision_reason": {},
            }
        )
        repo = PositionsRepo(conn)
        repo.insert(
            {
                "position_id": "P1",
                "decision_id": "D3",
                "symbol": "BTC",
                "side": "LONG",
                "leverage": 3,
                "margin": 100,
                "notional": 300,
                "entry_price": 100,
                "stop_loss": 99,
                "status": "OPEN",
                "entry_time": "2026-01-01T00:00:00+00:00",
                "psychology_at_entry": {"stress": 0.3},
            }
        )
        assert len(repo.list_open()) == 1
        repo.update_close(
            "P1",
            {
                "exit_price": 99,
                "exit_time": "2026-01-01T01:00:00+00:00",
                "exit_reason": "STOP_LOSS",
                "realized_pnl": -3.0,
                "max_favorable_excursion": 0.01,
                "max_adverse_excursion": -0.01,
                "psychology_at_exit": {"stress": 0.4},
            },
        )
        closed = repo.get_by_id("P1")
        assert closed is not None
        assert closed["status"] == "CLOSED"
        assert closed["psychology_at_exit"]["stress"] == 0.4
        assert repo.win_rate() == 0.0
        conn.close()


def test_traits_history_append() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        conn = _conn(tmp)
        repo = TraitsRepo(conn)
        repo.insert(
            {
                "date": "day-000",
                "risk_appetite": 0.55,
                "patience": 0.5,
                "focus": 0.6,
                "self_doubt": 0.4,
                "stubbornness": 0.65,
                "stress": 0.3,
                "sleep_debt": 1.0,
            }
        )
        repo.insert(
            {
                "date": "day-001",
                "risk_appetite": 0.6,
                "patience": 0.4,
                "focus": 0.5,
                "self_doubt": 0.5,
                "stubbornness": 0.7,
                "stress": 0.5,
                "sleep_debt": 2.0,
            }
        )
        assert repo.latest()["date"] == "day-001"
        assert len(repo.list_by_daterange("day-000", "day-001")) == 2
        conn.close()


def test_psychology_latest() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        conn = _conn(tmp)
        repo = PsychologyRepo(conn)
        repo.insert(
            {
                "timestamp": "2026-01-01T00:00:00+00:00",
                "mood": "calm",
                "mood_label": "平静",
                "state_snapshot": {"stress": 0.3},
            }
        )
        repo.insert(
            {
                "timestamp": "2026-01-01T01:00:00+00:00",
                "mood": "anxious",
                "mood_label": "焦虑",
                "state_snapshot": {"stress": 0.8},
            }
        )
        latest = repo.latest()
        assert latest is not None
        assert latest["state_snapshot"]["stress"] == 0.8
        conn.close()


def test_positions_foreign_key_enforced() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        conn = _conn(tmp)
        repo = PositionsRepo(conn)
        try:
            repo.insert(
                {
                    "position_id": "PX",
                    "decision_id": "MISSING",
                    "symbol": "BTC",
                    "side": "LONG",
                    "status": "OPEN",
                }
            )
            conn.commit()
            raise AssertionError("FK should reject missing decision_id")
        except sqlite3.IntegrityError:
            pass
        conn.close()


def run() -> int:
    tests = [
        test_events_insert_and_query,
        test_decision_insert_with_json_fields,
        test_decision_events_link,
        test_positions_open_and_close,
        test_traits_history_append,
        test_psychology_latest,
        test_positions_foreign_key_enforced,
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
    print("=== test_repositories ===")
    for line in details:
        print(line)
    print(f"---\npassed={passed} failed={failed} total={len(tests)}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(run())
