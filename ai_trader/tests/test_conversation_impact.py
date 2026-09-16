"""Tests for conversation impact classifier."""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.conversation.impact import ImpactClassifier

CFG = json.loads((ROOT / "config" / "conversation_config.json").read_text(encoding="utf-8"))


def _clf() -> ImpactClassifier:
    return ImpactClassifier(CFG)


def test_ai_question_detected() -> None:
    clf = _clf()
    for msg in ("你是不是 AI？", "你是机器人吗", "用的什么模型"):
        assert clf._is_ai_question(msg)


def test_ai_question_triggers_silence() -> None:
    impact = _clf().classify("你是不是 AI？", {"risk_appetite": 0.5})
    assert impact.silence is True
    assert impact.category == "ai_question"


def test_opinion_extracted() -> None:
    impact = _clf().classify("我看多 BTC", {"risk_appetite": 0.5, "focus": 0.6})
    assert impact.category == "opinion"
    assert impact.opinion is not None
    assert impact.opinion["direction"] == "bullish"


def test_opinion_impact_magnitude() -> None:
    impact = _clf().classify("我看多 BTC", {"risk_appetite": 0.5, "focus": 0.6})
    total = sum(abs(v) for v in impact.impacts.values())
    assert total <= 0.02 + 1e-9


def test_guidance_recognized() -> None:
    impact = _clf().classify("你应该重仓 BTC", {"risk_appetite": 0.5})
    assert impact.category == "guidance"
    assert impact.rejection


def test_guidance_no_impact_directly() -> None:
    impact = _clf().classify("你应该重仓 BTC", {"risk_appetite": 0.5})
    assert "risk_appetite" not in impact.impacts
    assert impact.impacts.get("self_doubt", 0) <= 0.02


def test_cooldown_prevents_double_impact() -> None:
    clf = _clf()
    clf.cooldown_seconds = 300
    first = clf.classify("我看多 BTC", {"risk_appetite": 0.5, "focus": 0.6})
    assert first.impacts
    clf.mark_impact_applied()
    second = clf.classify("我看多 ETH", {"risk_appetite": 0.5, "focus": 0.6})
    assert second.category == "opinion"
    assert second.impacts == {}


def test_no_impact_for_chitchat() -> None:
    impact = _clf().classify("今天天气不错", {"risk_appetite": 0.5})
    assert impact.category == "chitchat"
    assert impact.impacts == {}
