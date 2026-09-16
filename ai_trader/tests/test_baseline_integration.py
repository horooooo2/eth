"""Baseline evolution integration tests."""
from __future__ import annotations

import sys
import tempfile
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.baseline_integration import apply_and_persist_evolution, collect_daily_stats
from src.db import get_connection, init_database
from src.db.migrations_v9 import apply_v9_migrations
from src.db.repositories import BaselineRepo, TraumaRepo
from src.person_state import DEFAULT_BASELINE_BOUNDS, PersonState, PersonStateEngine, TRAIT_BASELINE

EVENT = ROOT / "config" / "event_impacts.json"
EVO = ROOT / "config" / "baseline_evolution.json"


def _person_with_evo() -> PersonStateEngine:
    return PersonStateEngine(
        EVENT,
        baseline_evolution_config=EVO,
        baseline_bounds=DEFAULT_BASELINE_BOUNDS,
    )


def test_30_day_simulation() -> None:
    person = _person_with_evo()
    start = person.baseline_snapshot()["self_doubt"]
    for day in range(30):
        # Keep elevated self_doubt in state so baseline drifts up
        person.state.self_doubt = 0.60
        person._clip(warn=False)
        stats = collect_daily_stats(
            daily_pnl=-200,
            start_equity=20000,
            equity=20000 - day * 50,
            peak_equity=20000,
            consecutive_losses=min(day, 10),
            days_profitable_streak=0,
            days_losing_streak=day + 1,
        )
        person.evolve_baseline(stats)
        person.daily_decay()
    end = person.baseline_snapshot()["self_doubt"]
    assert end > start


def test_growth_scenario() -> None:
    person = _person_with_evo()
    # Stress elevated repeatedly but win streak trauma reduces self_doubt
    start_stress = person.baseline_snapshot()["stress"]
    for day in range(35):
        person.state.stress = 0.20  # below baseline -> drift down
        person._clip(warn=False)
        stats = collect_daily_stats(
            daily_pnl=100,
            start_equity=20000,
            equity=20000 + day * 20,
            peak_equity=20000 + day * 20,
            consecutive_losses=0,
            days_profitable_streak=day + 1,
            days_losing_streak=0,
        )
        person.evolve_baseline(stats)
        person.daily_decay()
    end_stress = person.baseline_snapshot()["stress"]
    # stress baseline should not rise; preferably fall or stay
    assert end_stress <= start_stress + 1e-9


def test_backward_compatibility() -> None:
    state = PersonState(stress=0.90)
    engine = PersonStateEngine(EVENT, state=state)
    assert engine.evolver is None
    engine.daily_decay()
    assert abs(engine.state.stress - 0.87) < 1e-9


def test_database_persistence() -> None:
    tmp = Path(tempfile.mkdtemp()) / "t.db"
    conn = get_connection(tmp)
    init_database(conn)
    apply_v9_migrations(conn)
    repo = BaselineRepo(conn)
    person = _person_with_evo()
    for _ in range(14):
        person.state.self_doubt = 0.58
        person.evolve_baseline({"daily_pnl_pct": -0.02, "consecutive_losses": 0,
                                "drawdown_from_peak": 0, "days_profitable_streak": 0,
                                "days_losing_streak": 5})
    apply_and_persist_evolution(
        person,
        {"daily_pnl_pct": -0.02, "consecutive_losses": 0, "drawdown_from_peak": 0,
         "days_profitable_streak": 0, "days_losing_streak": 5},
        date="day-014",
        timestamp="2026-09-16T00:00:00+00:00",
        baseline_repo=repo,
    )
    conn.commit()
    rows = repo.list_recent(30)
    assert len(rows) >= 1
    assert rows[-1]["date"] == "day-014"


def test_trauma_recorded() -> None:
    tmp = Path(tempfile.mkdtemp()) / "t2.db"
    conn = get_connection(tmp)
    init_database(conn)
    apply_v9_migrations(conn)
    trauma_repo = TraumaRepo(conn)
    baseline_repo = BaselineRepo(conn)
    person = _person_with_evo()
    apply_and_persist_evolution(
        person,
        {
            "daily_pnl_pct": -0.15,
            "consecutive_losses": 7,
            "drawdown_from_peak": 0.0,
            "days_profitable_streak": 0,
            "days_losing_streak": 0,
        },
        date="day-001",
        timestamp="2026-09-16T12:00:00+00:00",
        baseline_repo=baseline_repo,
        trauma_repo=trauma_repo,
    )
    conn.commit()
    events = trauma_repo.list_recent(30)
    types = {e["event_type"] for e in events}
    assert "big_loss" in types
    assert "loss_streak_7" in types


def main() -> None:
    tests = [
        test_30_day_simulation,
        test_growth_scenario,
        test_backward_compatibility,
        test_database_persistence,
        test_trauma_recorded,
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
