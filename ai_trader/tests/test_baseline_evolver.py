"""BaselineEvolver unit tests."""
from __future__ import annotations

import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.baseline_evolver import BaselineEvolver
from src.person_state import DEFAULT_BASELINE_BOUNDS, TRAIT_BASELINE

CONFIG = ROOT / "config" / "baseline_evolution.json"
BOUNDS = DEFAULT_BASELINE_BOUNDS


def _evolver() -> BaselineEvolver:
    return BaselineEvolver(CONFIG, BOUNDS)


def test_no_evolution_when_gap_small() -> None:
    ev = _evolver()
    base = dict(TRAIT_BASELINE)
    # recent avg almost equal to baseline
    recent = [{**base, "self_doubt": base["self_doubt"] + 0.01} for _ in range(14)]
    new_b, changes = ev.evolve(base, recent)
    assert changes == []
    assert abs(new_b["self_doubt"] - base["self_doubt"]) < 1e-9


def test_evolve_toward_recent_average() -> None:
    ev = _evolver()
    base = dict(TRAIT_BASELINE)
    recent = [{**base, "self_doubt": 0.60} for _ in range(14)]
    new_b, changes = ev.evolve(base, recent)
    assert any(c["trait"] == "self_doubt" for c in changes)
    assert new_b["self_doubt"] > base["self_doubt"]


def test_step_clamped_to_max_daily() -> None:
    ev = _evolver()
    base = dict(TRAIT_BASELINE)
    recent = [{**base, "self_doubt": 0.90} for _ in range(14)]
    new_b, changes = ev.evolve(base, recent)
    ch = next(c for c in changes if c["trait"] == "self_doubt")
    assert abs(ch["new"] - ch["old"]) <= 0.01 + 1e-9


def test_baseline_bounds_enforced() -> None:
    ev = _evolver()
    base = dict(TRAIT_BASELINE)
    base["self_doubt"] = 0.64  # near upper bound 0.65
    recent = [{**base, "self_doubt": 0.90} for _ in range(14)]
    new_b, _ = ev.evolve(base, recent)
    assert new_b["self_doubt"] <= BOUNDS["self_doubt"][1] + 1e-9


def test_evolve_returns_changes() -> None:
    ev = _evolver()
    base = dict(TRAIT_BASELINE)
    recent = [{**base, "stress": 0.50, "self_doubt": 0.55} for _ in range(14)]
    _, changes = ev.evolve(base, recent)
    assert isinstance(changes, list)
    for ch in changes:
        assert "trait" in ch and "old" in ch and "new" in ch and "reason" in ch


def main() -> None:
    tests = [
        test_no_evolution_when_gap_small,
        test_evolve_toward_recent_average,
        test_step_clamped_to_max_daily,
        test_baseline_bounds_enforced,
        test_evolve_returns_changes,
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
