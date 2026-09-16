"""NewsAssessor unit tests with mock LLM."""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from src.news.assessor import NewsAssessor
from src.news.search_client import SearchResult

ROOT = Path(__file__).resolve().parents[1]
CARD = ROOT / "config" / "character_defaults" / "zhangming.json"


@pytest.fixture
def news_behavior() -> dict:
    return dict(json.loads(CARD.read_text(encoding="utf-8"))["news_behavior"])


class MockNarrator:
    def __init__(self, payload: dict):
        self._payload = payload
        self.llm_client = self
        self.enabled = True
        self.prompt_builder = SimpleNamespace(
            templates={"system": "sys", "user_news_check": "{{news_content}}"},
            render=lambda name, vars: json.dumps(payload, ensure_ascii=False),
        )

    def complete(self, system: str, user: str):
        return self._payload


def _search(answer: str = "市场平静") -> SearchResult:
    return SearchResult(query="q", answer=answer, sources=[], latency_ms=10, token_usage={})


def test_assess_returns_structured_output(news_behavior):
    payload = {
        "psychology": {"text": "看看而已。", "mood": "calm", "mood_label": "平静"},
        "body_action": {"text": "刷手机。", "location": "书房", "activity": "看新闻"},
        "news_assessment": {
            "direction": "neutral",
            "impact_level": "low",
            "key_point": "无明显新闻",
            "event_type": "NO_SIGNIFICANT_NEWS",
        },
    }
    assessor = NewsAssessor(news_behavior, MockNarrator(payload))
    result = assessor.assess("q", _search(), {"stress": 0.3}, {"primary_mode": "NORMAL"})
    assert result.psychology["text"]
    assert result.news_assessment["direction"] == "neutral"
    assert result.event_type


def test_event_type_mapping_positive(news_behavior):
    assessor = NewsAssessor(news_behavior, MockNarrator({}))
    assert assessor._map_to_event_type("bullish", "美联储暗示降息", news_behavior) == "FED_DOVISH_SIGNAL"


def test_event_type_mapping_negative(news_behavior):
    assessor = NewsAssessor(news_behavior, MockNarrator({}))
    assert (
        assessor._map_to_event_type("bearish", "监管收紧加剧", news_behavior)
        == "REGULATORY_CRACKDOWN"
    )


def test_event_type_mapping_fallback(news_behavior):
    assessor = NewsAssessor(news_behavior, MockNarrator({}))
    assert assessor._map_to_event_type("neutral", "天气不错", news_behavior) == "NO_SIGNIFICANT_NEWS"


def test_llm_failure_uses_fallback(news_behavior):
    class Broken:
        llm_client = None
        enabled = False
        prompt_builder = None

    assessor = NewsAssessor(news_behavior, Broken())
    result = assessor.assess("q", _search("平静"), {"stress": 0.2}, {"primary_mode": "NORMAL"})
    assert result.psychology["text"]
    assert result.event_type
