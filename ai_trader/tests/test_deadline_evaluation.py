"""Tests for day-90 deadline evaluation."""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.db import get_connection, init_database
from src.db.migrations_v10 import apply_v10_migrations
from src.db.repositories import DeadlineRepo
from src.deadline.evaluator import DeadlineEvaluator
from src.deadline.state import DeadlineStateManager
from src.deadline_hooks import maybe_run_deadline_evaluation
from src.narrator.mock_client import MockLLMClient
from src.person_state import PersonStateEngine


CFG = json.loads((ROOT / "config" / "deadline_config.json").read_text(encoding="utf-8"))
EVENT = ROOT / "config" / "event_impacts.json"
CARD = {"deadline": {"enabled": True, "total_days": 90}}


class _FakeNarrator:
    def __init__(self, client: MockLLMClient) -> None:
        self.llm_client = client
        self.prompt_builder = type("PB", (), {"templates": {}})()


def _mgr(start: str = "2026-01-01") -> DeadlineStateManager:
    return DeadlineStateManager(CFG, CARD, start_date=start)


def test_evaluation_on_day_90() -> None:
    mgr = _mgr()
    assert not mgr.is_evaluation_day("2026-01-15")
    assert mgr.is_evaluation_day("2026-03-31")  # day 90


def test_continue_keeps_running() -> None:
    mgr = _mgr()
    mgr.update("2026-03-31")
    client = MockLLMClient(
        responses=[
            {
                "action": "CONTINUE",
                "reason": "再看看",
                "new_deadline_days": None,
                "narrative": {"psychology": {"text": "再看看", "mood": "calm", "mood_label": "平静"}},
            }
        ]
    )
    ev = DeadlineEvaluator(CFG, _FakeNarrator(client), {}, deadline_manager=mgr)
    result = ev.evaluate(mgr.get_state(), {}, {}, {}, {}, today="2026-03-31")
    assert result["action"] == "CONTINUE"
    assert mgr.get_state().paused is False
    assert mgr.get_state().next_evaluation_day == 97


def test_stop_pauses_trading() -> None:
    mgr = _mgr()
    mgr.update("2026-03-31")
    paused = {"v": False}

    def pause() -> None:
        paused["v"] = True

    person = PersonStateEngine(EVENT, deadline_manager=mgr)
    client = MockLLMClient(
        responses=[
            {
                "action": "STOP",
                "reason": "停了",
                "new_deadline_days": None,
                "narrative": {"psychology": {"text": "停", "mood": "tired", "mood_label": "疲惫"}},
            }
        ]
    )
    with tempfile.TemporaryDirectory() as td:
        db = Path(td) / "t.db"
        conn = get_connection(db)
        init_database(conn)
        apply_v10_migrations(conn)
        repo = DeadlineRepo(conn)
        maybe_run_deadline_evaluation(
            today="2026-03-31",
            person=person,
            deadline_manager=mgr,
            deadline_config=CFG,
            narrator=_FakeNarrator(client),
            deadline_repo=repo,
            db_repos={"conn": conn},
            starting_baseline=person.baseline_snapshot(),
            pause_trading=pause,
        )
        assert mgr.get_state().paused is True
        assert paused["v"] is True
        conn.close()


def test_extend_resets_deadline() -> None:
    mgr = _mgr()
    mgr.update("2026-03-31")
    client = MockLLMClient(
        responses=[
            {
                "action": "EXTEND",
                "reason": "再来",
                "new_deadline_days": 60,
                "narrative": {"psychology": {"text": "再来", "mood": "confident", "mood_label": "自信"}},
            }
        ]
    )
    ev = DeadlineEvaluator(CFG, _FakeNarrator(client), {}, deadline_manager=mgr)
    result = ev.evaluate(mgr.get_state(), {}, {}, {}, {}, today="2026-03-31")
    assert result["action"] == "EXTEND"
    st = mgr.get_state()
    assert st.total_days == 60
    assert st.current_day == 1
    assert st.pressure == 0.0
    assert st.extend_count == 1


def test_evaluation_recorded() -> None:
    mgr = _mgr()
    mgr.update("2026-03-31")
    person = PersonStateEngine(EVENT, deadline_manager=mgr)
    client = MockLLMClient()  # default EXTEND
    with tempfile.TemporaryDirectory() as td:
        db = Path(td) / "t.db"
        conn = get_connection(db)
        init_database(conn)
        apply_v10_migrations(conn)
        repo = DeadlineRepo(conn)
        maybe_run_deadline_evaluation(
            today="2026-03-31",
            person=person,
            deadline_manager=mgr,
            deadline_config=CFG,
            narrator=_FakeNarrator(client),
            deadline_repo=repo,
            db_repos={"conn": conn},
            starting_baseline=person.baseline_snapshot(),
        )
        evals = repo.get_evaluations()
        assert len(evals) >= 1
        assert evals[-1]["evaluation_action"] in {"CONTINUE", "STOP", "EXTEND"}
        conn.close()
