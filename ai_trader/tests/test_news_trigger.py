"""NewsTrigger unit tests."""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from src.news.trigger import NewsTrigger

ROOT = Path(__file__).resolve().parents[1]
CARD = ROOT / "config" / "character_defaults" / "zhangming.json"


@pytest.fixture
def news_behavior() -> dict:
    card = json.loads(CARD.read_text(encoding="utf-8"))
    return dict(card["news_behavior"])


def _state(**kwargs):
    base = {
        "stress": 0.3,
        "sleep_debt": 1.0,
        "risk_appetite": 0.45,
    }
    base.update(kwargs)
    return base


def test_no_trigger_outside_window(news_behavior):
    trig = NewsTrigger(news_behavior, random_seed=1)
    ok, reason = trig.should_check(
        current_time=datetime(2026, 9, 16, 15, 0),
        state=_state(),
        portfolio={"position_count": 0},
        recent_activity={},
        daily_check_count=0,
        last_check_time=None,
    )
    assert ok is False
    assert reason["reason"] == "outside_window"


def test_no_trigger_when_frequency_limit_reached(news_behavior):
    trig = NewsTrigger(news_behavior, random_seed=1)
    ok, reason = trig.should_check(
        current_time=datetime(2026, 9, 16, 9, 0),
        state=_state(),
        portfolio={"position_count": 0},
        recent_activity={},
        daily_check_count=6,
        last_check_time=None,
    )
    assert ok is False
    assert reason["reason"] == "frequency_limit"


def test_no_trigger_when_min_interval_not_passed(news_behavior):
    trig = NewsTrigger(news_behavior, random_seed=1)
    now = datetime(2026, 9, 16, 9, 0)
    ok, reason = trig.should_check(
        current_time=now,
        state=_state(),
        portfolio={"position_count": 0},
        recent_activity={},
        daily_check_count=1,
        last_check_time=now - timedelta(minutes=30),
    )
    assert ok is False
    assert reason["reason"] == "min_interval"


def test_state_modifier_increases_probability(news_behavior):
    trig = NewsTrigger(news_behavior, random_seed=0)
    # Force high probability path: morning base 0.70 * 1.5 = 1.05 -> clamp 1.0
    ok, reason = trig.should_check(
        current_time=datetime(2026, 9, 16, 9, 0),
        state=_state(),
        portfolio={"position_count": 1, "positions": [{"symbol": "BTC-USDT-SWAP", "side": "long"}]},
        recent_activity={},
        daily_check_count=0,
        last_check_time=None,
    )
    assert "has_open_position" in reason["triggered_modifiers"]
    assert reason["final_probability"] >= 0.70 * 1.5 - 1e-9 or reason["final_probability"] == 1.0
    assert ok is True


def test_multiple_modifiers_stack(news_behavior):
    trig = NewsTrigger(news_behavior, random_seed=0)
    ok, reason = trig.should_check(
        current_time=datetime(2026, 9, 16, 9, 0),
        state=_state(stress=0.7),
        portfolio={"position_count": 1, "positions": [{"symbol": "BTC-USDT-SWAP", "side": "long"}]},
        recent_activity={},
        daily_check_count=0,
        last_check_time=None,
    )
    mods = reason["triggered_modifiers"]
    assert "has_open_position" in mods
    assert "high_stress" in mods
    assert reason["final_probability"] == 1.0
    assert ok is True


def test_high_stress_multiplier_applies(news_behavior):
    trig = NewsTrigger(news_behavior, random_seed=0)
    _, reason = trig.should_check(
        current_time=datetime(2026, 9, 16, 9, 0),
        state=_state(stress=0.7),
        portfolio={"position_count": 0},
        recent_activity={},
        daily_check_count=0,
        last_check_time=None,
    )
    assert "high_stress" in reason["triggered_modifiers"]
    assert abs(reason["final_probability"] - 0.70 * 1.4) < 1e-9 or reason["final_probability"] == 1.0


def test_random_seed_reproducible(news_behavior):
    # noon base 0.35 — some seeds trigger, use same seed twice
    a = NewsTrigger(news_behavior, random_seed=42)
    b = NewsTrigger(news_behavior, random_seed=42)
    kwargs = dict(
        current_time=datetime(2026, 9, 16, 12, 0),
        state=_state(),
        portfolio={"position_count": 0},
        recent_activity={},
        daily_check_count=0,
        last_check_time=None,
    )
    assert a.should_check(**kwargs) == b.should_check(**kwargs)
