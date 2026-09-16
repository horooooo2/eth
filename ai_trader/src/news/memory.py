"""Daily news memory summaries for conversation injection."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .assessor import NewsAssessment

WINDOW_LABELS = {
    "morning": "早上",
    "noon": "中午",
    "evening": "晚上",
    "late_night": "深夜",
}


class NewsMemory:
    def __init__(self, repo: Any, retention_days: int = 7) -> None:
        self.repo = repo
        self.retention_days = max(1, int(retention_days))

    def record(
        self,
        assessment: NewsAssessment | dict[str, Any],
        timestamp: str,
        *,
        check_id: int | None = None,
        window: str | None = None,
        impact_applied: dict[str, float] | None = None,
    ) -> int | None:
        """Persist assessment via news_assessments repo when available."""
        if assessment is None:
            return None
        data = assessment.to_dict() if hasattr(assessment, "to_dict") else dict(assessment)
        na = data.get("news_assessment") or {}
        psych = data.get("psychology") or {}
        body = data.get("body_action") or {}
        payload = {
            "check_id": check_id,
            "timestamp": timestamp,
            "window": window,
            "direction": na.get("direction"),
            "impact_level": na.get("impact_level"),
            "key_point": na.get("key_point"),
            "event_type": data.get("event_type") or na.get("event_type"),
            "confidence": na.get("confidence"),
            "psychology_text": psych.get("text"),
            "body_action_text": body.get("text"),
            "impact_applied": impact_applied or {},
        }
        if hasattr(self.repo, "insert"):
            return int(self.repo.insert(payload))
        return None

    def get_today_summary(self, *, today: str | None = None) -> str:
        day = today or datetime.now(timezone.utc).strftime("%Y-%m-%d")
        rows: list[dict[str, Any]] = []
        if hasattr(self.repo, "list_by_day"):
            rows = list(self.repo.list_by_day(day) or [])
        elif hasattr(self.repo, "get_today_assessments"):
            rows = list(self.repo.get_today_assessments(day) or [])
        if not rows:
            return ""
        lines = ["今天看到的消息："]
        for row in rows:
            window = str(row.get("window") or "")
            label = WINDOW_LABELS.get(window, window or "某时")
            point = str(row.get("key_point") or row.get("psychology_text") or "").strip()
            if not point:
                continue
            lines.append(f"- {label}：{point}")
        if len(lines) == 1:
            return ""
        return "\n".join(lines)

    def get_recent(self, days: int = 7) -> list[dict[str, Any]]:
        n = max(1, int(days or self.retention_days))
        if hasattr(self.repo, "list_recent"):
            return list(self.repo.list_recent(n) or [])
        if hasattr(self.repo, "list_by_day"):
            day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            return list(self.repo.list_by_day(day) or [])
        return []
