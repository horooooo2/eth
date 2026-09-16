"""QueryBuilder unit tests."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.news.query_builder import QueryBuilder

ROOT = Path(__file__).resolve().parents[1]
CARD = ROOT / "config" / "character_defaults" / "zhangming.json"


@pytest.fixture
def news_behavior() -> dict:
    return dict(json.loads(CARD.read_text(encoding="utf-8"))["news_behavior"])


def test_query_for_holding_long_btc(news_behavior):
    qb = QueryBuilder(news_behavior, random_seed=1)
    q = qb.build(["holding_long_btc"], state={}, current_time=None)
    allowed = news_behavior["search_queries_by_context"]["holding_long_btc"]
    assert q in allowed


def test_query_for_before_major_event(news_behavior):
    qb = QueryBuilder(news_behavior, random_seed=2)
    q = qb.build(["before_major_event"], state={}, current_time=None)
    allowed = news_behavior["search_queries_by_context"]["before_major_event"]
    assert q in allowed


def test_fallback_when_no_match(news_behavior):
    qb = QueryBuilder(news_behavior, random_seed=3)
    q = qb.build(["unknown_tag_xyz"], state={}, current_time=None)
    allowed = news_behavior["search_queries_by_context"]["no_position_watching"]
    assert q in allowed


def test_multiple_context_tags_pick_one(news_behavior):
    qb = QueryBuilder(news_behavior, random_seed=4)
    tags = ["holding_long_btc", "before_major_event"]
    q = qb.build(tags, state={}, current_time=None)
    pool = (
        news_behavior["search_queries_by_context"]["holding_long_btc"]
        + news_behavior["search_queries_by_context"]["before_major_event"]
    )
    assert q in pool
