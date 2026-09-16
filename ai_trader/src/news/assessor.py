"""Map search results to structured news assessment + narrative."""
from __future__ import annotations

import json
import logging
import re
from dataclasses import asdict, dataclass, field
from typing import Any

from ..narrator.llm_log import log_llm_call
from .search_client import SearchResult

logger = logging.getLogger(__name__)


class AssessorError(RuntimeError):
    """Raised when assessment LLM fails hard (before fallback)."""


@dataclass
class NewsAssessment:
    psychology: dict[str, str]
    body_action: dict[str, str]
    news_assessment: dict[str, Any]
    event_type: str = "NO_SIGNIFICANT_NEWS"
    raw: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _extract_json(text: str) -> dict[str, Any]:
    text = (text or "").strip()
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            return data
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{[\s\S]*\}", text)
    if not match:
        raise AssessorError("LLM response missing JSON object")
    data = json.loads(match.group(0))
    if not isinstance(data, dict):
        raise AssessorError("LLM JSON is not an object")
    return data


class NewsAssessor:
    def __init__(self, news_behavior_config: dict[str, Any], narrator: Any) -> None:
        self.news_behavior_config = news_behavior_config or {}
        self.narrator = narrator

    def assess(
        self,
        query: str,
        search_result: SearchResult,
        state: dict[str, Any],
        behavior: dict[str, Any],
        *,
        check_label: str = "",
        check_intent: str = "",
    ) -> NewsAssessment:
        news_content = search_result.answer
        if search_result.sources:
            src_bits = []
            for s in search_result.sources[:3]:
                title = s.get("title") or s.get("url") or ""
                if title:
                    src_bits.append(str(title))
            if src_bits:
                news_content = f"{news_content}\n来源倾向：{', '.join(src_bits)}"

        variables = {
            "stress": state.get("stress"),
            "risk_appetite": state.get("risk_appetite"),
            "patience": state.get("patience"),
            "focus": state.get("focus"),
            "self_doubt": state.get("self_doubt"),
            "sleep_debt": state.get("sleep_debt"),
            "primary_mode": behavior.get("primary_mode") or "NORMAL",
            "check_label": check_label or "新闻浏览",
            "check_intent": check_intent or query,
            "news_content": news_content,
            "query": query,
        }

        try:
            raw = self._call_narrator(variables)
            log_llm_call(
                component="assessor",
                scene="news_check",
                latency_ms=0,
                status="ok",
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("news assessor LLM failed: %s", exc)
            log_llm_call(
                component="assessor",
                scene="news_check",
                latency_ms=0,
                status=type(exc).__name__,
                fallback="default",
            )
            return self._fallback(query, search_result)

        return self._from_raw(raw, search_result)

    def _call_narrator(self, variables: dict[str, Any]) -> dict[str, Any]:
        narr = self.narrator
        if narr is None:
            raise AssessorError("narrator missing")
        if hasattr(narr, "narrate_news_check"):
            result = narr.narrate_news_check(variables)
            if hasattr(result, "raw") and isinstance(result.raw, dict) and result.raw:
                return result.raw
            return {
                "psychology": {
                    "text": getattr(result, "psychology_text", ""),
                    "mood": getattr(result, "mood", "calm"),
                    "mood_label": getattr(result, "mood_label", "平静"),
                },
                "body_action": {
                    "text": getattr(result, "body_text", "")
                    or getattr(result, "body_action_text", ""),
                    "location": getattr(result, "location", "书房"),
                    "activity": getattr(result, "activity", "看新闻"),
                },
                "news_assessment": (getattr(result, "raw", {}) or {}).get("news_assessment")
                or {
                    "direction": "neutral",
                    "impact_level": "low",
                    "key_point": variables.get("check_intent") or "",
                    "event_type": "NO_SIGNIFICANT_NEWS",
                },
            }
        pb = getattr(narr, "prompt_builder", None)
        if pb is None:
            raise AssessorError("prompt_builder missing")
        system = pb.templates.get("system", "")
        user = pb.render("user_news_check", variables)
        if hasattr(narr, "llm_client") and narr.llm_client is not None:
            raw = narr.llm_client.complete(system, user)
            if isinstance(raw, dict):
                return raw
            return _extract_json(str(raw))
        if getattr(narr, "enabled", False) and hasattr(narr, "_call_llm"):
            return narr._call_llm(system, user)  # noqa: SLF001
        raise AssessorError("no LLM path for news assessment")

    def _from_raw(self, raw: dict[str, Any], search_result: SearchResult) -> NewsAssessment:
        psych = raw.get("psychology") or {}
        body = raw.get("body_action") or {}
        na = raw.get("news_assessment") or {}
        direction = str(na.get("direction") or "neutral").lower()
        key_point = str(na.get("key_point") or search_result.answer[:80] or "")
        mapped = self._map_to_event_type(direction, key_point, self.news_behavior_config)
        confidence = float(na.get("confidence") if na.get("confidence") is not None else 0.6)
        assessment = {
            "direction": direction
            if direction in ("bullish", "bearish", "neutral", "mixed")
            else "neutral",
            "impact_level": str(na.get("impact_level") or "low"),
            "key_point": key_point,
            "event_type": mapped,
            "confidence": confidence,
        }
        return NewsAssessment(
            psychology={
                "text": str(psych.get("text") or "")[:120],
                "mood": str(psych.get("mood") or "calm"),
                "mood_label": str(psych.get("mood_label") or "平静"),
            },
            body_action={
                "text": str(body.get("text") or "")[:80],
                "location": str(body.get("location") or "书房"),
                "activity": str(body.get("activity") or "看新闻"),
            },
            news_assessment=assessment,
            event_type=mapped,
            raw=raw,
        )

    def _map_to_event_type(
        self,
        direction: str,
        key_point: str,
        news_behavior: dict[str, Any],
    ) -> str:
        mapping = (news_behavior or {}).get("assessment_to_event_mapping") or {}
        text = key_point or ""
        for bucket in ("negative_keywords", "positive_keywords", "neutral_keywords"):
            table = mapping.get(bucket) or {}
            if not isinstance(table, dict):
                continue
            for kw, event_name in table.items():
                if kw and str(kw) in text:
                    return str(event_name)
        d = (direction or "").lower()
        if d == "bullish":
            return "POSITIVE_MACRO_DATA"
        if d == "bearish":
            return "MACRO_DATA_DISAPPOINT"
        if d == "mixed":
            return "MIXED_SIGNALS"
        return "NO_SIGNIFICANT_NEWS"

    def _fallback(self, query: str, search_result: SearchResult) -> NewsAssessment:
        key_point = (search_result.answer or query or "无明显新闻")[:80]
        event_type = self._map_to_event_type("neutral", key_point, self.news_behavior_config)
        return NewsAssessment(
            psychology={
                "text": "看了一眼消息，没什么需要立刻反应的。",
                "mood": "calm",
                "mood_label": "平静",
            },
            body_action={
                "text": "放下手机，回到桌前。",
                "location": "书房",
                "activity": "看新闻",
            },
            news_assessment={
                "direction": "neutral",
                "impact_level": "none" if event_type == "NO_SIGNIFICANT_NEWS" else "low",
                "key_point": key_point,
                "event_type": event_type,
                "confidence": 0.3,
            },
            event_type=event_type,
            raw={"fallback": True},
        )
