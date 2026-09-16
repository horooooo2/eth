"""Tests for ambient friction sampler."""
from __future__ import annotations

import json
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.ambient.sampler import AmbientSampler
from src.character.card import load_character


CFG = json.loads((ROOT / "config" / "deadline_config.json").read_text(encoding="utf-8"))
CARD = load_character("zhangming", ROOT / "config")


def test_sample_zero_to_two() -> None:
    s = AmbientSampler(CFG, CARD)
    for i in range(40):
        ev = s.sample_today(day="2026-01-01", random_state=i)
        assert 0 <= len(ev) <= 2


def test_no_duplicate_in_one_day() -> None:
    s = AmbientSampler(CFG, CARD)
    for i in range(50):
        ev = s.sample_today(day="2026-02-01", random_state=100 + i)
        names = [e["name"] for e in ev]
        assert len(names) == len(set(names))


def test_weighted_distribution() -> None:
    s = AmbientSampler(CFG, CARD)
    counts: Counter[str] = Counter()
    for i in range(500):
        for e in s.sample_today(day="2026-03-01", random_state=i):
            counts[e["name"]] += 1
    # QUIET should appear more often than KID
    assert counts["QUIET_EVENING_ALONE"] > counts["KID_QUESTION_WHY_HOME"]


def test_timestamps_in_range() -> None:
    s = AmbientSampler(CFG, CARD)
    for e in s.sample_today(day="2026-04-10", random_state=7):
        ts = datetime.fromisoformat(e["timestamp"].replace("Z", "+00:00"))
        assert 8 <= ts.hour <= 21 or (ts.hour == 21 and ts.minute < 60)
        # upper bound is exclusive of 22:00
        minutes = ts.hour * 60 + ts.minute
        assert 8 * 60 <= minutes < 22 * 60


def test_random_state_reproducible() -> None:
    a = AmbientSampler(CFG, CARD).sample_today(day="2026-05-01", random_state=123)
    b = AmbientSampler(CFG, CARD).sample_today(day="2026-05-01", random_state=123)
    assert [e["name"] for e in a] == [e["name"] for e in b]
    assert [e["timestamp"] for e in a] == [e["timestamp"] for e in b]
