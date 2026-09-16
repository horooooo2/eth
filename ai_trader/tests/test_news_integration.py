"""NewsChecker integration tests (mocked search)."""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

from src.db.migrations_v13 import apply_v13_migrations
from src.db.repositories.news_assessments_repo import NewsAssessmentsRepo
from src.db.repositories.news_repo import NewsRepo
from src.db.repositories.psychology_repo import PsychologyRepo
from src.db.schema import init_database
from src.news.assessor import NewsAssessor
from src.news.checker import NewsChecker
from src.news.memory import NewsMemory
from src.news.query_builder import QueryBuilder
from src.news.search_client import SearchError, SearchResult
from src.news.trigger import NewsTrigger
from src.person_state import PersonStateEngine
from src.conversation.prompt_builder import ConversationPromptBuilder

ROOT = Path(__file__).resolve().parents[1]
CARD = ROOT / "config" / "character_defaults" / "zhangming.json"
EVENT = ROOT / "config" / "event_impacts.json"


@pytest.fixture
def card() -> dict:
    return json.loads(CARD.read_text(encoding="utf-8"))


@pytest.fixture
def conn(tmp_path):
    db = tmp_path / "t.db"
    c = sqlite3.connect(str(db))
    c.row_factory = sqlite3.Row
    init_database(c)
    apply_v13_migrations(c)
    yield c
    c.close()


class FakeSearch:
    def __init__(self, fail: bool = False):
        self.fail = fail
        self.calls = 0

    def search(self, query: str, max_results: int = 5) -> SearchResult:
        self.calls += 1
        if self.fail:
            raise SearchError("boom")
        return SearchResult(
            query=query,
            answer="美联储释放降息信号，市场情绪回暖。",
            sources=[{"title": "CoinDesk", "url": "https://example.com", "snippet": "dovish"}],
            latency_ms=800,
            token_usage={"prompt": 100, "completion": 50},
        )


class FakeNarrator:
    def __init__(self):
        self.llm_client = self
        self.enabled = True
        self.prompt_builder = SimpleNamespace(
            templates={"system": "s", "user_news_check": "u"},
            render=lambda *a, **k: "x",
        )

    def complete(self, system, user):
        return {
            "psychology": {"text": "降息预期升温，先记着。", "mood": "calm", "mood_label": "平静"},
            "body_action": {"text": "喝了口咖啡继续看。", "location": "书房", "activity": "看新闻"},
            "news_assessment": {
                "direction": "bullish",
                "impact_level": "medium",
                "key_point": "降息预期升温",
                "event_type": "FED_DOVISH_SIGNAL",
            },
        }


class Bridge:
    def __init__(self):
        self.calls = []

    def on_news_check(self, payload, *, state=None, behavior=None):
        self.calls.append(payload)
        return None


def _engine(card):
    # Prefer card event impacts path via temp materialization-like: use project event file
    # and inject news_events from card
    path = EVENT if EVENT.exists() else CARD
    eng = PersonStateEngine(path)
    if card.get("traits_baseline"):
        for k, v in card["traits_baseline"].items():
            if hasattr(eng.state, k):
                setattr(eng.state, k, float(v))
    return eng


def _checker(card, conn, search, bridge, engine):
    nb = card["news_behavior"]
    assessments = NewsAssessmentsRepo(conn)
    return NewsChecker(
        nb,
        search,
        NewsTrigger(nb, random_seed=0),
        QueryBuilder(nb, random_seed=0),
        NewsAssessor(nb, FakeNarrator()),
        NewsMemory(assessments),
        bridge,
        engine,
        {
            "news_repo": NewsRepo(conn),
            "psychology_repo": PsychologyRepo(conn),
        },
        event_impacts=card.get("event_impacts") or {},
        enabled=True,
    )


def test_full_news_cycle(card, conn):
    engine = _engine(card)
    bridge = Bridge()
    checker = _checker(card, conn, FakeSearch(), bridge, engine)
    result = checker.tick(
        datetime(2026, 9, 16, 9, 0),
        {"position_count": 1, "positions": [{"symbol": "BTC", "side": "long"}]},
        {},
    )
    assert result is not None
    assert result.event_type == "FED_DOVISH_SIGNAL"
    assert bridge.calls


def test_impact_applied_to_state(card, conn):
    engine = _engine(card)
    before = float(engine.state.risk_appetite)
    checker = _checker(card, conn, FakeSearch(), Bridge(), engine)
    result = checker.tick(
        datetime(2026, 9, 16, 9, 0),
        {"position_count": 1, "positions": [{"symbol": "BTC", "side": "long"}]},
        {},
    )
    assert result is not None
    assert result.impact_applied
    assert float(engine.state.risk_appetite) != before or "risk_appetite" not in result.impact_applied


def test_news_recorded_in_db(card, conn):
    engine = _engine(card)
    checker = _checker(card, conn, FakeSearch(), Bridge(), engine)
    checker.tick(
        datetime(2026, 9, 16, 9, 0),
        {"position_count": 1, "positions": [{"symbol": "BTC", "side": "long"}]},
        {},
    )
    assert NewsRepo(conn).count_today("2026-09-16") >= 1
    assert NewsAssessmentsRepo(conn).list_by_day("2026-09-16")


def test_timeline_entry_generated(card, conn):
    engine = _engine(card)
    bridge = Bridge()
    checker = _checker(card, conn, FakeSearch(), bridge, engine)
    checker.tick(
        datetime(2026, 9, 16, 9, 0),
        {"position_count": 1, "positions": [{"symbol": "BTC", "side": "long"}]},
        {},
    )
    assert bridge.calls
    # psychology_log also written by checker
    n = conn.execute("SELECT COUNT(*) AS c FROM psychology_log").fetchone()["c"]
    assert int(n) >= 1


def test_conversation_reads_news_memory(card, conn):
    engine = _engine(card)
    assessments = NewsAssessmentsRepo(conn)
    mem = NewsMemory(assessments)
    checker = _checker(card, conn, FakeSearch(), Bridge(), engine)
    # ensure memory uses assessments repo
    checker.memory = mem
    checker.tick(
        datetime(2026, 9, 16, 9, 0),
        {"position_count": 1, "positions": [{"symbol": "BTC", "side": "long"}]},
        {},
    )
    summary = mem.get_today_summary(today="2026-09-16")
    assert "今天看到的消息" in summary or "降息" in summary
    msgs = ConversationPromptBuilder().build(
        {},
        {"primary_mode": "NORMAL"},
        {"equity": 1, "today_pnl": 0, "position_count": 0},
        {"current_day": 1},
        [],
        "今天有什么新闻",
        news_memory=summary,
    )
    assert any("今天看到的新闻" in m["content"] for m in msgs if m["role"] == "system")


def test_search_failure_does_not_block(card, conn):
    engine = _engine(card)
    checker = _checker(card, conn, FakeSearch(fail=True), Bridge(), engine)
    result = checker.tick(
        datetime(2026, 9, 16, 9, 0),
        {"position_count": 1, "positions": [{"symbol": "BTC", "side": "long"}]},
        {},
    )
    assert result is None


def test_state_reset_daily(card, conn):
    engine = _engine(card)
    engine.bump_news_awareness(0.3)
    assert engine.state.news_awareness >= 0.3
    engine.reset_news_awareness()
    assert engine.state.news_awareness == 0.0
    engine.bump_news_awareness(0.3)
    engine.daily_decay()
    assert engine.state.news_awareness == 0.0
