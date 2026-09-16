"""NewsChecker: state-driven search → assess → impact → timeline."""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

from .assessor import AssessorError, NewsAssessment, NewsAssessor
from .memory import NewsMemory
from .query_builder import QueryBuilder
from .search_client import SearchClient, SearchError, SearchResult
from .trigger import NewsTrigger

logger = logging.getLogger(__name__)


@dataclass
class NewsCheckResult:
    window: str
    query: str
    event_type: str
    assessment: NewsAssessment
    search_result: SearchResult
    impact_applied: dict[str, float] = field(default_factory=dict)
    check_id: int | None = None
    triggered_reason: dict[str, Any] = field(default_factory=dict)


def _lookup_news_impact(event_impacts: dict[str, Any], event_type: str) -> dict[str, float]:
    news = (event_impacts or {}).get("news_events") or {}
    for bucket in ("positive", "negative", "neutral"):
        table = news.get(bucket) or {}
        if not isinstance(table, dict):
            continue
        entry = table.get(event_type)
        if isinstance(entry, dict):
            impacts = entry.get("impacts")
            if isinstance(impacts, dict):
                return {k: float(v) for k, v in impacts.items()}
            # flat impacts without nesting
            return {
                k: float(v)
                for k, v in entry.items()
                if k not in ("label", "note") and isinstance(v, (int, float))
            }
    return {}


class NewsChecker:
    def __init__(
        self,
        news_behavior_config: dict[str, Any],
        search_client: SearchClient | None,
        trigger: NewsTrigger,
        query_builder: QueryBuilder,
        assessor: NewsAssessor,
        memory: NewsMemory,
        event_bridge: Any,
        state_engine: Any,
        db_repos: dict[str, Any],
        *,
        event_impacts: dict[str, Any] | None = None,
        behavior_classifier: Any | None = None,
        enabled: bool | None = None,
    ) -> None:
        self.cfg = news_behavior_config or {}
        self.search_client = search_client
        self.trigger = trigger
        self.query_builder = query_builder
        self.assessor = assessor
        self.memory = memory
        self.event_bridge = event_bridge
        self.state_engine = state_engine
        self.db_repos = db_repos or {}
        self.event_impacts = event_impacts or {}
        self.behavior_classifier = behavior_classifier
        self.enabled = bool(self.cfg.get("enabled", True) if enabled is None else enabled)
        self._last_check_time: datetime | None = None
        self._last_check_day: str | None = None
        self._daily_count = 0

    def tick(
        self,
        current_time: datetime,
        portfolio: dict[str, Any],
        recent_activity: dict[str, Any],
    ) -> Optional[NewsCheckResult]:
        if not self.enabled:
            return None
        if self.search_client is None:
            return None

        day = current_time.strftime("%Y-%m-%d")
        if self._last_check_day != day:
            self._last_check_day = day
            self._daily_count = 0
            if hasattr(self.state_engine, "reset_news_awareness"):
                self.state_engine.reset_news_awareness()

        news_repo = self.db_repos.get("news_repo")
        if news_repo is not None and hasattr(news_repo, "count_today"):
            try:
                self._daily_count = int(news_repo.count_today(day))
            except Exception:  # noqa: BLE001
                pass

        state = self.state_engine.snapshot()
        ok, reason = self.trigger.should_check(
            current_time=current_time,
            state=state,
            portfolio=portfolio or {},
            recent_activity=recent_activity or {},
            daily_check_count=self._daily_count,
            last_check_time=self._last_check_time,
        )
        if not ok:
            return None

        window = str(reason.get("window") or "")
        window_cfg = ((self.cfg.get("daily_windows") or {}).get(window) or {})
        tags = list(reason.get("context_tags") or [])
        query = self.query_builder.build(tags, state=state, current_time=current_time)

        try:
            search_result = self.search_client.search(query)
        except SearchError as exc:
            logger.warning("news search failed (non-blocking): %s", exc)
            return None

        behavior = {"primary_mode": "NORMAL", "modifiers": []}
        if self.behavior_classifier is not None:
            try:
                br = self.behavior_classifier.classify(self.state_engine.state)
                behavior = {
                    "primary_mode": br.primary_mode,
                    "modifiers": list(br.modifiers),
                }
            except Exception:  # noqa: BLE001
                pass

        try:
            assessment = self.assessor.assess(
                query,
                search_result,
                state,
                behavior,
                check_label=str(window_cfg.get("label") or window),
                check_intent=str(window_cfg.get("intent") or ""),
            )
        except AssessorError as exc:
            logger.warning("news assess failed, using fallback: %s", exc)
            assessment = self.assessor._fallback(query, search_result)  # noqa: SLF001

        impact = self._apply_news_impact(assessment)
        ts = current_time.astimezone(timezone.utc).isoformat() if current_time.tzinfo else current_time.isoformat()

        check_id = None
        if news_repo is not None and hasattr(news_repo, "insert_check"):
            try:
                check_id = int(
                    news_repo.insert_check(
                        {
                            "timestamp": ts,
                            "window": window,
                            "context_tags": tags,
                            "query": query,
                            "search_answer": search_result.answer,
                            "sources": search_result.sources,
                            "latency_ms": search_result.latency_ms,
                            "token_usage": search_result.token_usage,
                        }
                    )
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("news_checks insert failed: %s", exc)

        try:
            self.memory.record(
                assessment,
                ts,
                check_id=check_id,
                window=window,
                impact_applied=impact,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("news memory record failed: %s", exc)

        # psychology_log as event trail
        psych_repo = self.db_repos.get("psychology_repo")
        if psych_repo is not None and hasattr(psych_repo, "insert"):
            try:
                psych_repo.insert(
                    {
                        "timestamp": ts,
                        "mood": assessment.psychology.get("mood"),
                        "mood_label": assessment.psychology.get("mood_label"),
                        "state_snapshot": {
                            **self.state_engine.snapshot(),
                            "primary_mode": behavior.get("primary_mode"),
                            "news_event_type": assessment.event_type,
                        },
                        "narrative_text": assessment.psychology.get("text"),
                        "prompt_version": "news_check",
                    }
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("psychology_log insert failed: %s", exc)

        if self.event_bridge is not None and hasattr(self.event_bridge, "on_news_check"):
            try:
                self.event_bridge.on_news_check(
                    {
                        "timestamp": ts,
                        "window": window,
                        "query": query,
                        "assessment": assessment,
                        "search_result": search_result,
                        "impact_applied": impact,
                        "check_id": check_id,
                    },
                    state=self.state_engine.snapshot(),
                    behavior=behavior,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("event_bridge.on_news_check failed: %s", exc)

        if hasattr(self.state_engine, "bump_news_awareness"):
            self.state_engine.bump_news_awareness(0.3)

        self._last_check_time = current_time
        self._daily_count += 1
        return NewsCheckResult(
            window=window,
            query=query,
            event_type=assessment.event_type,
            assessment=assessment,
            search_result=search_result,
            impact_applied=impact,
            check_id=check_id,
            triggered_reason=reason,
        )

    def _apply_news_impact(self, assessment: NewsAssessment) -> dict[str, float]:
        event_type = assessment.event_type or "NO_SIGNIFICANT_NEWS"
        impacts = _lookup_news_impact(self.event_impacts, event_type)
        if not impacts:
            return {}
        if hasattr(self.state_engine, "apply_delta"):
            self.state_engine.apply_delta(impacts)
        elif hasattr(self.state_engine, "apply_conversation_impact"):
            self.state_engine.apply_conversation_impact(impacts)
        return dict(impacts)
