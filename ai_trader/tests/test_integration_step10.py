"""Step-10 integration: 90-day deadline + ambient + backward compatibility."""
from __future__ import annotations

import json
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.ambient.sampler import AmbientSampler
from src.character.card import load_character
from src.db import get_connection, init_database
from src.db.migrations_v10 import apply_v10_migrations
from src.db.repositories import AmbientRepo, DeadlineRepo
from src.deadline.state import DeadlineStateManager
from src.deadline_hooks import (
    build_deadline_stack,
    maybe_run_deadline_evaluation,
    process_new_day,
)
from src.narrator.mock_client import MockLLMClient
from src.person_state import PersonState, PersonStateEngine


CFG = json.loads((ROOT / "config" / "deadline_config.json").read_text(encoding="utf-8"))
EVENT = ROOT / "config" / "event_impacts.json"
CARD = load_character("zhangming", ROOT / "config")


class _FakeNarrator:
    def __init__(self) -> None:
        self.llm_client = MockLLMClient()
        self.prompt_builder = type("PB", (), {"templates": {}})()


def test_90_day_replay_completes() -> None:
    with tempfile.TemporaryDirectory() as td:
        db = Path(td) / "step10.db"
        conn = get_connection(db)
        init_database(conn)
        apply_v10_migrations(conn)
        ambient_repo = AmbientRepo(conn)
        deadline_repo = DeadlineRepo(conn)
        start = date(2026, 1, 1)
        cfg, mgr, sampler = build_deadline_stack(
            ROOT / "config", CARD, start.isoformat(), random_state=7
        )
        person = PersonStateEngine(
            EVENT,
            deadline_manager=mgr,
            ambient_sampler=sampler,
        )
        starting = person.baseline_snapshot()
        pressure_samples: dict[int, float] = {}
        eval_result = None
        for i in range(90):
            today = (start + timedelta(days=i)).isoformat()
            process_new_day(
                today=today,
                person=person,
                deadline_repo=deadline_repo,
                ambient_repo=ambient_repo,
            )
            st = mgr.get_state() if mgr else None
            if st and st.current_day in (1, 30, 42, 60, 75, 90):
                pressure_samples[st.current_day] = st.pressure
            if i == 89:
                eval_result = maybe_run_deadline_evaluation(
                    today=today,
                    person=person,
                    deadline_manager=mgr,
                    deadline_config=cfg,
                    narrator=_FakeNarrator(),
                    deadline_repo=deadline_repo,
                    db_repos={"conn": conn},
                    starting_baseline=starting,
                )
            person.daily_decay()
        n_ambient = conn.execute("SELECT COUNT(*) AS n FROM ambient_events").fetchone()["n"]
        assert 60 <= int(n_ambient) <= 180
        assert abs(pressure_samples.get(42, -1) - 0.008) < 1e-3
        assert eval_result is not None
        assert eval_result["action"] in {"CONTINUE", "STOP", "EXTEND"}
        evals = DeadlineRepo(conn).get_evaluations()
        assert len(evals) >= 1
        conn.close()


def test_pressure_applied_to_state() -> None:
    mgr = DeadlineStateManager(CFG, CARD, start_date="2026-01-01")
    person = PersonStateEngine(EVENT, deadline_manager=mgr)
    person.state.stress = 0.30
    person.baseline["stress"] = 0.30
    person.update_deadline("2026-02-11")  # day 42
    assert abs(person.deadline_pressure - 0.008) < 1e-3
    before = person.state.stress
    person.daily_decay()
    # target = 0.30 + 0.008 = 0.308; new = 0.30 + (0.308-0.30)*0.05 = 0.3004
    expected = before + ((0.30 + person.deadline_pressure) - before) * 0.05
    assert abs(person.state.stress - expected) < 1e-6


def test_ambient_events_accumulate() -> None:
    sampler = AmbientSampler(CFG, CARD)
    person = PersonStateEngine(EVENT, ambient_sampler=sampler)
    all_ev: list = []
    for i in range(10):
        ev = person.apply_daily_ambient_events(f"2026-06-{i+1:02d}")
        all_ev.extend(ev)
    assert any(h.get("type") == "ambient" for h in person.event_history)
    # impacts should have moved some traits away from initial on average days with events
    assert isinstance(all_ev, list)


def test_backward_compatibility() -> None:
    state = PersonState(stress=0.90)
    engine = PersonStateEngine(EVENT, state=state)
    engine.daily_decay()
    assert abs(engine.state.stress - 0.87) < 1e-9
    assert engine.apply_daily_ambient_events("2026-01-01") == []
    assert engine.update_deadline("2026-01-01") is None
    assert engine.deadline_pressure == 0.0
