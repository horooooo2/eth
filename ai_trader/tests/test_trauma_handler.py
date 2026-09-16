"""TraumaHandler unit tests."""
from __future__ import annotations

import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.person_state import DEFAULT_BASELINE_BOUNDS, TRAIT_BASELINE
from src.trauma_handler import TraumaHandler

CONFIG = ROOT / "config" / "baseline_evolution.json"
BOUNDS = DEFAULT_BASELINE_BOUNDS


def _handler() -> TraumaHandler:
    return TraumaHandler(CONFIG, BOUNDS)


def test_big_loss_triggered() -> None:
    h = _handler()
    base = dict(TRAIT_BASELINE)
    new_b, events = h.check_trauma(base, {"daily_pnl_pct": -0.15})
    types = {e["event_type"] for e in events}
    assert "big_loss" in types
    assert new_b["risk_appetite"] < base["risk_appetite"]
    assert new_b["self_doubt"] > base["self_doubt"]


def test_no_trigger_below_threshold() -> None:
    h = _handler()
    base = dict(TRAIT_BASELINE)
    _, events = h.check_trauma(base, {"daily_pnl_pct": -0.05})
    assert not any(e["event_type"] == "big_loss" for e in events)


def test_multiple_trauma_events() -> None:
    h = _handler()
    base = dict(TRAIT_BASELINE)
    new_b, events = h.check_trauma(
        base,
        {
            "daily_pnl_pct": -0.12,
            "consecutive_losses": 7,
            "drawdown_from_peak": 0.0,
            "days_profitable_streak": 0,
            "days_losing_streak": 0,
        },
    )
    types = {e["event_type"] for e in events}
    assert "big_loss" in types
    assert "loss_streak_7" in types
    assert new_b["self_doubt"] > base["self_doubt"]
    assert new_b["patience"] < base["patience"]


def test_trauma_respects_baseline_bounds() -> None:
    h = _handler()
    base = dict(TRAIT_BASELINE)
    base["self_doubt"] = 0.63
    new_b, _ = h.check_trauma(base, {"daily_pnl_pct": -0.20, "days_losing_streak": 30})
    assert new_b["self_doubt"] <= BOUNDS["self_doubt"][1] + 1e-9


def test_trauma_returns_impact_detail() -> None:
    h = _handler()
    base = dict(TRAIT_BASELINE)
    _, events = h.check_trauma(base, {"consecutive_losses": 7})
    assert events
    evt = events[0]
    assert "impacts" in evt and "description" in evt and "baseline_after" in evt
    assert "applied" in evt


def main() -> None:
    tests = [
        test_big_loss_triggered,
        test_no_trigger_below_threshold,
        test_multiple_trauma_events,
        test_trauma_respects_baseline_bounds,
        test_trauma_returns_impact_detail,
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
