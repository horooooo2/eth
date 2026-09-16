"""Tests for deadline pressure curve."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.deadline.pressure import compute_deadline_pressure
from src.deadline.state import DeadlineStateManager


CFG = json.loads((ROOT / "config" / "deadline_config.json").read_text(encoding="utf-8"))
CURVE = CFG["pressure_curve"]


def test_day_1_to_30_zero_pressure() -> None:
    for d in (1, 15, 30):
        assert compute_deadline_pressure(d, 90, CURVE) == 0.0


def test_day_31_to_60_linear() -> None:
    p = compute_deadline_pressure(45, 90, CURVE)
    assert abs(p - 0.01) < 1e-4


def test_day_61_to_90_linear() -> None:
    p = compute_deadline_pressure(75, 90, CURVE)
    assert abs(p - 0.035) < 1e-4


def test_beyond_total_days_capped() -> None:
    p = compute_deadline_pressure(91, 90, CURVE)
    assert p <= 0.05 + 1e-9
    assert p == 0.05


def test_extend_resets_curve() -> None:
    mgr = DeadlineStateManager(
        CFG,
        {"deadline": {"enabled": True, "total_days": 90}},
        start_date="2026-01-01",
    )
    mgr.update("2026-03-31")  # day 90
    assert mgr.get_state().pressure >= 0.04
    mgr.extend_deadline(90, as_of="2026-03-31")
    st = mgr.get_state()
    assert st.current_day == 1
    assert st.pressure == 0.0
    assert st.total_days == 90
    mgr.update("2026-04-01")
    assert mgr.get_state().pressure == 0.0
