"""Tests for replay + Narrator event bridge (Mock only)."""
from __future__ import annotations

import json
import sys
import tempfile
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.db import get_connection, init_database, close_connection
from src.db.repositories import DecisionRepo, PsychologyRepo
from src.narrator.event_bridge import NarratorEventBridge
from src.narrator.mock_client import MockLLMClient
from src.narrator.narrator import Narrator
from src.replay import generate_sample_ohlcv
from src.replay_with_narrator import generate_narrative_timeline, replay_with_narrator

CONFIG = ROOT / "config"


def _mini_bars(n: int = 280) -> list[dict]:
    path = Path(tempfile.mkdtemp()) / "ohlcv.json"
    return generate_sample_ohlcv(path, n=n, seed=11)


def test_replay_with_mock_completes() -> None:
    bars = _mini_bars(280)
    db = Path(tempfile.mkdtemp()) / "t.db"
    result = replay_with_narrator(bars, CONFIG, db, use_mock=True)
    assert result["decision_count"] > 0
    assert "timeline" in result
    assert "## " in result["timeline"]


def test_narrative_written_to_db() -> None:
    bars = _mini_bars(280)
    db = Path(tempfile.mkdtemp()) / "t.db"
    replay_with_narrator(bars, CONFIG, db, use_mock=True)
    conn = get_connection(db)
    n = conn.execute(
        "SELECT COUNT(*) AS c FROM decision_log WHERE narrative_thought IS NOT NULL"
    ).fetchone()["c"]
    close_connection(conn)
    assert n > 0


def test_psychology_log_written() -> None:
    bars = _mini_bars(280)
    db = Path(tempfile.mkdtemp()) / "t.db"
    replay_with_narrator(bars, CONFIG, db, use_mock=True)
    conn = get_connection(db)
    n = conn.execute(
        "SELECT COUNT(*) AS c FROM psychology_log WHERE narrative_text IS NOT NULL"
    ).fetchone()["c"]
    close_connection(conn)
    assert n > 0


def test_narrative_timeline_generated() -> None:
    bars = _mini_bars(280)
    db = Path(tempfile.mkdtemp()) / "t.db"
    result = replay_with_narrator(bars, CONFIG, db, use_mock=True)
    md = result["timeline"]
    assert "# 张明的一天" in md
    assert "### 💬 心理活动" in md
    assert "**Mood**:" in md


def test_fail_closed_when_llm_error() -> None:
    bars = _mini_bars(220)
    db = Path(tempfile.mkdtemp()) / "t.db"
    mock = MockLLMClient(fail_on_call=1)
    # Narrator will fallback on error; replay must still finish
    result = replay_with_narrator(bars, CONFIG, db, use_mock=True, mock_client=mock)
    assert result["decision_count"] > 0
    assert result["timeline"]


def test_prompt_version_recorded() -> None:
    bars = _mini_bars(280)
    db = Path(tempfile.mkdtemp()) / "t.db"
    replay_with_narrator(bars, CONFIG, db, use_mock=True)
    conn = get_connection(db)
    row = conn.execute(
        """
        SELECT prompt_version FROM decision_log
        WHERE narrative_thought IS NOT NULL LIMIT 1
        """
    ).fetchone()
    close_connection(conn)
    assert row is not None
    assert row["prompt_version"]
    assert len(str(row["prompt_version"])) >= 8


def test_cooldown_prevents_duplicate_calls() -> None:
    db = Path(tempfile.mkdtemp()) / "c.db"
    conn = get_connection(db)
    init_database(conn)
    mock = MockLLMClient()
    narrator = Narrator(CONFIG / "narrator_config.json", project_root=ROOT, llm_client=mock)
    bridge = NarratorEventBridge(
        narrator, DecisionRepo(conn), PsychologyRepo(conn), cooldown_minutes=30
    )
    now = datetime(2026, 9, 16, 12, 0, tzinfo=timezone.utc)
    state = {
        "stress": 0.5,
        "risk_appetite": 0.5,
        "patience": 0.5,
        "focus": 0.5,
        "self_doubt": 0.5,
        "sleep_debt": 2.0,
    }
    behavior = {"primary_mode": "NORMAL", "modifiers": []}
    event = {"name": "ARGUMENT_WITH_WIFE", "description": "吵了一架", "timestamp": now.isoformat()}
    r1 = bridge.on_event(event, state, behavior, [], now=now)
    r2 = bridge.on_event(event, state, behavior, [], now=now + timedelta(minutes=5))
    r3 = bridge.on_event(event, state, behavior, [], now=now + timedelta(minutes=35))
    close_connection(conn)
    assert r1 is not None
    assert r2 is None
    assert r3 is not None
    assert bridge.stats["skipped_cooldown"] >= 1


def test_narrator_disabled_fallback() -> None:
    db = Path(tempfile.mkdtemp()) / "f.db"
    conn = get_connection(db)
    init_database(conn)
    # No llm_client, enabled false → fallback still writes
    narrator = Narrator(CONFIG / "narrator_config.json", project_root=ROOT, api_key="")
    assert narrator.enabled is False
    bridge = NarratorEventBridge(narrator, DecisionRepo(conn), PsychologyRepo(conn))
    decision_id = "dec-fallback-1"
    DecisionRepo(conn).insert(
        {
            "decision_id": decision_id,
            "timestamp": "2026-09-16T12:00:00+00:00",
            "symbol": "BTC",
            "direction": "LONG",
            "signal_rule": "BREAKOUT",
            "signal_raw_score": 0.8,
            "signal_score": 0.8,
            "signal_reason": "test",
            "psychology_before": {},
            "primary_mode": "CAUTIOUS",
            "modifiers": [],
            "decision": "SKIP",
            "position_multiplier": 0.0,
            "risk_check": "SKIP",
            "config_snapshot_hash": "abc",
        }
    )
    result = bridge.on_decision(
        decision_id=decision_id,
        state={
            "stress": 0.7,
            "risk_appetite": 0.3,
            "patience": 0.4,
            "focus": 0.5,
            "self_doubt": 0.4,
            "sleep_debt": 3.0,
        },
        behavior={"primary_mode": "CAUTIOUS", "modifiers": []},
        signal={
            "symbol": "BTC",
            "direction": "LONG",
            "score": 0.8,
            "rule_name": "BREAKOUT",
            "reason": "test",
        },
        decision={
            "timestamp": "2026-09-16T12:00:00+00:00",
            "action": "SKIP",
            "threshold": 0.65,
        },
        recent_events=[],
    )
    conn.commit()
    row = DecisionRepo(conn).get_by_id(decision_id)
    close_connection(conn)
    assert result is not None
    assert result.source == "fallback"
    assert row is not None
    assert row["narrative_thought"]


def main() -> None:
    tests = [
        test_replay_with_mock_completes,
        test_narrative_written_to_db,
        test_psychology_log_written,
        test_narrative_timeline_generated,
        test_fail_closed_when_llm_error,
        test_prompt_version_recorded,
        test_cooldown_prevents_duplicate_calls,
        test_narrator_disabled_fallback,
    ]
    failed = 0
    for fn in tests:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except Exception:
            failed += 1
            print(f"FAIL {fn.__name__}")
            traceback.print_exc()
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    raise SystemExit(failed)


if __name__ == "__main__":
    main()
