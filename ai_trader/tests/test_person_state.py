"""Unit tests for PersonStateEngine and BehaviorClassifier."""
from __future__ import annotations

import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.behavior_classifier import BehaviorClassifier
from src.person_state import PersonState, PersonStateEngine

EVENT_CONFIG = ROOT / "config" / "event_impacts.json"
MODE_CONFIG = ROOT / "config" / "behavior_modes.json"


def _engine(state: PersonState | None = None) -> PersonStateEngine:
    return PersonStateEngine(EVENT_CONFIG, state=state.copy() if state else None)


def test_atomic_event_applies() -> None:
    engine = _engine()
    before = engine.state.stress
    engine.apply_events([{"name": "ARGUMENT_WITH_WIFE", "type": "atomic"}])
    assert engine.state.stress > before
    assert abs(engine.state.stress - (0.30 + 0.20)) < 1e-9


def test_compound_event_deduplicates() -> None:
    engine = _engine()
    engine.apply_events(
        [
            {"name": "LOSS_STREAK_3", "type": "compound"},
            {"name": "LOSS_STREAK_3", "type": "compound"},
        ]
    )
    assert abs(engine.state.stress - 0.45) < 1e-9


def test_atomic_and_compound_combined() -> None:
    engine = _engine()
    engine.apply_events(
        [
            {"name": "STOP_LOSS_TRIGGERED", "type": "atomic"},
            {"name": "LOSS_STREAK_3", "type": "compound"},
        ]
    )
    assert abs(engine.state.stress - 0.55) < 1e-9


def test_bounds_clipping() -> None:
    state = PersonState(stress=0.95)
    engine = _engine(state)
    engine.apply_events([{"name": "CHILD_SICK", "type": "atomic"}])
    assert engine.state.stress <= 1.00
    assert abs(engine.state.stress - 1.00) < 1e-9


def test_daily_decay() -> None:
    state = PersonState(stress=0.90)
    engine = _engine(state)
    engine.daily_decay()
    # 0.90 + (0.30 - 0.90) * 0.05 = 0.87
    assert abs(engine.state.stress - 0.87) < 1e-9


def test_behavior_revenge_trading() -> None:
    classifier = BehaviorClassifier(MODE_CONFIG)
    state = PersonState(stress=0.80, patience=0.30, risk_appetite=0.65)
    result = classifier.classify(state)
    assert result.primary_mode == "REVENGE_TRADING"


def test_behavior_normal_fallback() -> None:
    classifier = BehaviorClassifier(MODE_CONFIG)
    result = classifier.classify(PersonState())
    assert result.primary_mode in {"NORMAL", "CAUTIOUS"}
    assert result.primary_mode == "NORMAL"


def run() -> int:
    tests = [
        test_atomic_event_applies,
        test_compound_event_deduplicates,
        test_atomic_and_compound_combined,
        test_bounds_clipping,
        test_daily_decay,
        test_behavior_revenge_trading,
        test_behavior_normal_fallback,
    ]
    passed = 0
    failed = 0
    details: list[str] = []
    for fn in tests:
        name = fn.__name__
        try:
            fn()
            passed += 1
            details.append(f"PASS  {name}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            details.append(f"FAIL  {name}: {exc}")
            details.append(traceback.format_exc())
    print("=== test_person_state ===")
    for line in details:
        print(line)
    print(f"---\npassed={passed} failed={failed} total={len(tests)}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(run())
