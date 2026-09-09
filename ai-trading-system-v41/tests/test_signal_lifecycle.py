"""Tests for signal lifecycle manager."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from src.core.signal_lifecycle import SignalLifecycleManager

ROOT = Path(__file__).resolve().parents[1]
CFG = json.loads((ROOT / "config" / "system_config.json").read_text(encoding="utf-8"))


def test_s1_s2_policy_values():
    pol = CFG["signal_lifecycle"]["strategy_policy"]
    assert pol["S1"]["expiry_seconds"] == 120
    assert pol["S1"]["max_price_drift_bps"] == 30
    assert pol["S1"]["max_price_drift_atr_fraction"] == 0.25
    assert pol["S2"]["expiry_seconds"] == 60
    assert pol["S2"]["max_price_drift_bps"] == 20
    assert pol["S2"]["max_price_drift_atr_fraction"] == 0.2


def test_create_and_transition():
    mgr = SignalLifecycleManager(CFG)
    intent = mgr.create_intent(
        strategy_id="S1",
        symbol="BTC/USDT:USDT",
        direction="long",
        reference_price=100.0,
        reference_atr=2.0,
    )
    assert intent.status == "CREATED"
    assert (intent.expires_at - intent.created_at).total_seconds() == 120
    mgr.transition(intent, "WAITING_EXECUTION_CONFIRMATION")
    mgr.transition(intent, "CONFIRMED")
    mgr.transition(intent, "EXECUTED")
    assert intent.status == "EXECUTED"


def test_expiry():
    mgr = SignalLifecycleManager(CFG)
    now = datetime.now(timezone.utc)
    intent = mgr.create_intent(
        strategy_id="S2",
        symbol="BTC/USDT:USDT",
        direction="short",
        reference_price=100.0,
        reference_atr=1.0,
        created_at=now - timedelta(seconds=61),
    )
    result = mgr.validate_intent(intent, current_mid=100.0, now=now)
    assert result["valid"] is False
    assert intent.status == "EXPIRED"


def test_price_drift_bps():
    mgr = SignalLifecycleManager(CFG)
    intent = mgr.create_intent(
        strategy_id="S1",
        symbol="BTC/USDT:USDT",
        direction="long",
        reference_price=100.0,
        reference_atr=10.0,
    )
    # 40 bps > 30
    result = mgr.validate_intent(intent, current_mid=100.4)
    assert result["valid"] is False
    assert intent.status == "PRICE_DRIFT_INVALID"


def test_price_drift_atr_fraction():
    mgr = SignalLifecycleManager(CFG)
    intent = mgr.create_intent(
        strategy_id="S2",
        symbol="BTC/USDT:USDT",
        direction="long",
        reference_price=100.0,
        reference_atr=1.0,
    )
    # drift 0.25 ATR > 0.2
    result = mgr.validate_intent(intent, current_mid=100.25)
    assert result["valid"] is False
    assert intent.status == "PRICE_DRIFT_INVALID"


def test_condition_invalid():
    mgr = SignalLifecycleManager(CFG)
    intent = mgr.create_intent(
        strategy_id="S1",
        symbol="BTC/USDT:USDT",
        direction="long",
        reference_price=100.0,
        reference_atr=2.0,
    )
    result = mgr.validate_intent(
        intent, current_mid=100.0, original_signal_conditions_still_valid=False
    )
    assert result["valid"] is False
    assert intent.status == "CONDITION_INVALID"
