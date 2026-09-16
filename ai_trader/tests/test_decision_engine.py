"""Unit tests for DecisionEngine."""
from __future__ import annotations

import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.behavior_classifier import BehaviorClassification, BehaviorClassifier
from src.decision_engine import DecisionEngine
from src.person_state import PersonState
from src.signal_engine import Signal

MODE_CONFIG = ROOT / "config" / "behavior_modes.json"
DECISION_CONFIG = ROOT / "config" / "decision_rules.json"


def _signal(score: float = 0.70, direction: str = "LONG") -> Signal:
    return Signal(
        symbol="BTC",
        direction=direction,
        rule_name="BREAKOUT",
        raw_score=0.5,
        score=score,
        reason="test",
        timestamp="2026-01-01T00:00:00+00:00",
        rule_version="0.8.1",
    )


def _engine() -> DecisionEngine:
    return DecisionEngine(DECISION_CONFIG)


def _classify(state: PersonState) -> BehaviorClassification:
    return BehaviorClassifier(MODE_CONFIG).classify(state)


def test_threshold_clamp_lower() -> None:
    # Extreme: REVENGE + modifiers that lower threshold hard
    state = PersonState(stress=0.90, patience=0.20, risk_appetite=0.75, sleep_debt=6.0, focus=0.30)
    behavior = _classify(state)
    # force revenge-like adjustment stack
    behavior = BehaviorClassification(
        primary_mode="REVENGE_TRADING",
        modifiers=["EXHAUSTED", "LOW_FOCUS", "HIGH_STRESS", "HIGH_DOUBT"],
        confidence=1.0,
        triggered_rules=["REVENGE_TRADING"],
        rule_version="1.0.0",
        threshold_adjustment=-0.10,
    )
    thr, _ = _engine()._compute_threshold(state, behavior)
    assert thr >= 0.50


def test_threshold_clamp_upper() -> None:
    state = PersonState(self_doubt=0.80, patience=0.25, stress=0.20, risk_appetite=0.30)
    behavior = BehaviorClassification(
        primary_mode="FROZEN",
        modifiers=["HIGH_DOUBT", "EXHAUSTED", "LOW_FOCUS"],
        confidence=1.0,
        triggered_rules=["FROZEN"],
        rule_version="1.0.0",
        threshold_adjustment=0.15,
    )
    thr, _ = _engine()._compute_threshold(state, behavior)
    assert thr <= 0.90


def test_revenge_trading_lowers_threshold() -> None:
    eng = _engine()
    normal_state = PersonState()
    normal_beh = BehaviorClassification(
        primary_mode="NORMAL",
        modifiers=[],
        confidence=1.0,
        triggered_rules=[],
        rule_version="1.0.0",
        threshold_adjustment=0.0,
    )
    thr_a, _ = eng._compute_threshold(normal_state, normal_beh)
    assert abs(thr_a - 0.70) < 1e-9

    revenge_state = PersonState(stress=0.80, patience=0.30, risk_appetite=0.65)
    revenge_beh = BehaviorClassification(
        primary_mode="REVENGE_TRADING",
        modifiers=[],
        confidence=1.0,
        triggered_rules=["REVENGE_TRADING"],
        rule_version="1.0.0",
        threshold_adjustment=-0.10,
    )
    thr_b, _ = eng._compute_threshold(revenge_state, revenge_beh)
    assert thr_b < thr_a

    # same score 0.70: NORMAL may SKIP/edge, REVENGE more likely OPEN
    d_a = eng.decide(_signal(0.70), normal_state, normal_beh)
    d_b = eng.decide(_signal(0.70), revenge_state, revenge_beh)
    assert d_a.threshold > d_b.threshold


def test_position_multiplier_direction() -> None:
    eng = _engine()
    state = PersonState()
    normal = BehaviorClassification(
        primary_mode="NORMAL",
        modifiers=[],
        confidence=1.0,
        triggered_rules=[],
        rule_version="1.0.0",
        threshold_adjustment=0.0,
    )
    revenge = BehaviorClassification(
        primary_mode="REVENGE_TRADING",
        modifiers=[],
        confidence=1.0,
        triggered_rules=["REVENGE_TRADING"],
        rule_version="1.0.0",
        threshold_adjustment=-0.10,
    )
    frozen = BehaviorClassification(
        primary_mode="FROZEN",
        modifiers=[],
        confidence=1.0,
        triggered_rules=["FROZEN"],
        rule_version="1.0.0",
        threshold_adjustment=0.15,
    )
    m_n = eng._compute_position_multiplier(state, normal)
    m_r = eng._compute_position_multiplier(state, revenge)
    m_f = eng._compute_position_multiplier(state, frozen)
    assert m_r > m_n
    assert m_f < m_n


def test_decision_reason_completeness() -> None:
    eng = _engine()
    state = PersonState()
    behavior = BehaviorClassification(
        primary_mode="NORMAL",
        modifiers=[],
        confidence=1.0,
        triggered_rules=[],
        rule_version="1.0.0",
        threshold_adjustment=0.0,
    )
    decision = eng.decide(_signal(0.80), state, behavior)
    reason = decision.decision_reason
    for key in (
        "base_threshold",
        "behavior_mode",
        "adjustments",
        "final_threshold",
        "signal_score",
        "decision",
    ):
        assert key in reason


def test_signal_below_threshold_skips() -> None:
    eng = _engine()
    state = PersonState()
    behavior = BehaviorClassification(
        primary_mode="NORMAL",
        modifiers=[],
        confidence=1.0,
        triggered_rules=[],
        rule_version="1.0.0",
        threshold_adjustment=0.0,
    )
    decision = eng.decide(_signal(0.60), state, behavior)
    assert decision.action == "SKIP"


def test_signal_above_threshold_opens() -> None:
    eng = _engine()
    state = PersonState()
    behavior = BehaviorClassification(
        primary_mode="NORMAL",
        modifiers=[],
        confidence=1.0,
        triggered_rules=[],
        rule_version="1.0.0",
        threshold_adjustment=0.0,
    )
    long_d = eng.decide(_signal(0.80, "LONG"), state, behavior)
    short_d = eng.decide(_signal(0.80, "SHORT"), state, behavior)
    assert long_d.action == "OPEN_LONG"
    assert short_d.action == "OPEN_SHORT"


def test_position_multiplier_clamp() -> None:
    eng = _engine()
    # maxed revenge + high risk + no sleep debt
    state_hi = PersonState(risk_appetite=0.75, sleep_debt=0.0)
    revenge = BehaviorClassification(
        primary_mode="REVENGE_TRADING",
        modifiers=[],
        confidence=1.0,
        triggered_rules=["REVENGE_TRADING"],
        rule_version="1.0.0",
        threshold_adjustment=-0.10,
    )
    # min frozen + low risk + max sleep
    state_lo = PersonState(risk_appetite=0.15, sleep_debt=8.0)
    frozen = BehaviorClassification(
        primary_mode="FROZEN",
        modifiers=[],
        confidence=1.0,
        triggered_rules=["FROZEN"],
        rule_version="1.0.0",
        threshold_adjustment=0.15,
    )
    hi = eng._compute_position_multiplier(state_hi, revenge)
    lo = eng._compute_position_multiplier(state_lo, frozen)
    assert 0.30 <= lo <= 1.50
    assert 0.30 <= hi <= 1.50


def run() -> int:
    tests = [
        test_threshold_clamp_lower,
        test_threshold_clamp_upper,
        test_revenge_trading_lowers_threshold,
        test_position_multiplier_direction,
        test_decision_reason_completeness,
        test_signal_below_threshold_skips,
        test_signal_above_threshold_opens,
        test_position_multiplier_clamp,
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
    print("=== test_decision_engine ===")
    for line in details:
        print(line)
    print(f"---\npassed={passed} failed={failed} total={len(tests)}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(run())
