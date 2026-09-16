"""Bridge replay events to Narrator calls with cooldown + DB writes."""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from .narrator import NarrativeResult, Narrator

logger = logging.getLogger(__name__)


@dataclass
class NarratorCall:
    """Audit record of a narrator invocation attempt."""

    trigger_type: str
    template: str
    variables: dict[str, Any]
    cooldown_key: str
    skipped: bool = False
    result: Optional[NarrativeResult] = None


class NarratorEventBridge:
    """
    Convert replay triggers into narrator calls.
    Fail-closed: exceptions become None and never break trading.
    """

    def __init__(
        self,
        narrator: Narrator,
        decision_repo: Any,
        psychology_repo: Any,
        *,
        cooldown_minutes: float = 30.0,
    ) -> None:
        self.narrator = narrator
        self.decision_repo = decision_repo
        self.psychology_repo = psychology_repo
        self.cooldown_minutes = cooldown_minutes
        self.call_log: list[NarratorCall] = []
        self._last_call_at: dict[str, datetime] = {}
        self.stats = {
            "decision_calls": 0,
            "event_calls": 0,
            "daily_open_calls": 0,
            "daily_close_calls": 0,
            "news_calls": 0,
            "skipped_cooldown": 0,
            "failed": 0,
        }

    def on_decision(
        self,
        decision_id: str,
        state: dict[str, Any],
        behavior: dict[str, Any],
        signal: dict[str, Any],
        decision: dict[str, Any],
        recent_events: list[str],
        *,
        now: datetime | None = None,
    ) -> Optional[NarrativeResult]:
        """Always narrate decisions (highest priority, no cooldown)."""
        variables = {
            "stress": state.get("stress"),
            "risk_appetite": state.get("risk_appetite"),
            "patience": state.get("patience"),
            "focus": state.get("focus"),
            "self_doubt": state.get("self_doubt"),
            "sleep_debt": state.get("sleep_debt"),
            "primary_mode": behavior.get("primary_mode"),
            "modifiers": ", ".join(behavior.get("modifiers") or []) or "无",
            "recent_events": "\n".join(recent_events) if recent_events else "无",
            "symbol": signal.get("symbol"),
            "direction": signal.get("direction"),
            "signal_score": f"{float(signal.get('score') or 0):.2f}",
            "threshold": f"{float(decision.get('threshold') or 0):.2f}",
            "signal_rule": signal.get("rule_name") or signal.get("signal_rule"),
            "signal_reason": signal.get("reason") or signal.get("signal_reason") or "",
            "decision": decision.get("action") or decision.get("decision"),
        }
        stamp = now or datetime.now(timezone.utc)
        call = NarratorCall(
            trigger_type="decision",
            template="user_decision",
            variables=variables,
            cooldown_key=f"decision:{decision_id}",
        )
        try:
            result = self.narrator.narrate_decision(variables)
            self.decision_repo.update_narrative(
                decision_id=decision_id,
                narrative_thought=result.psychology_text,
                narrative_body_action=result.body_action_text,
                prompt_version=result.prompt_version,
            )
            self.psychology_repo.insert(
                {
                    "timestamp": decision.get("timestamp") or stamp.isoformat(),
                    "mood": result.mood,
                    "mood_label": result.mood_label,
                    "state_snapshot": {**state, "primary_mode": behavior.get("primary_mode")},
                    "narrative_text": result.psychology_text,
                    "prompt_version": result.prompt_version,
                }
            )
            call.result = result
            self.stats["decision_calls"] += 1
            self.call_log.append(call)
            return result
        except Exception:
            self.stats["failed"] += 1
            call.skipped = True
            self.call_log.append(call)
            return None

    def on_event(
        self,
        event: dict[str, Any],
        state: dict[str, Any],
        behavior: dict[str, Any],
        recent_events: list[str],
        *,
        now: datetime | None = None,
    ) -> Optional[NarrativeResult]:
        """Narrate life/trade events with cooldown by event name."""
        stamp = now or datetime.now(timezone.utc)
        name = str(event.get("name") or "EVENT")
        key = f"event:{name}"
        if self._in_cooldown(key, stamp):
            self.stats["skipped_cooldown"] += 1
            self.call_log.append(
                NarratorCall(
                    trigger_type="event",
                    template="user_event",
                    variables={},
                    cooldown_key=key,
                    skipped=True,
                )
            )
            return None
        variables = {
            "stress": state.get("stress"),
            "risk_appetite": state.get("risk_appetite"),
            "patience": state.get("patience"),
            "focus": state.get("focus"),
            "self_doubt": state.get("self_doubt"),
            "sleep_debt": state.get("sleep_debt"),
            "primary_mode": behavior.get("primary_mode"),
            "modifiers": ", ".join(behavior.get("modifiers") or []) or "无",
            "event_name": name,
            "event_description": event.get("description") or name,
            "recent_events": "\n".join(recent_events) if recent_events else "无",
        }
        call = NarratorCall(
            trigger_type="event",
            template="user_event",
            variables=variables,
            cooldown_key=key,
        )
        try:
            result = self.narrator.narrate_event(variables)
            self.psychology_repo.insert(
                {
                    "timestamp": event.get("timestamp") or stamp.isoformat(),
                    "mood": result.mood,
                    "mood_label": result.mood_label,
                    "state_snapshot": {**state, "primary_mode": behavior.get("primary_mode")},
                    "narrative_text": result.psychology_text,
                    "prompt_version": result.prompt_version,
                }
            )
            self._mark_cooldown(key, stamp)
            call.result = result
            self.stats["event_calls"] += 1
            self.call_log.append(call)
            return result
        except Exception:
            self.stats["failed"] += 1
            call.skipped = True
            self.call_log.append(call)
            return None

    def on_daily_open(
        self,
        state: dict[str, Any],
        behavior: dict[str, Any],
        *,
        date: str,
        yesterday_summary: str = "无",
        timestamp: str | None = None,
        now: datetime | None = None,
    ) -> Optional[NarrativeResult]:
        stamp = now or datetime.now(timezone.utc)
        key = f"daily_open:{date}"
        if self._in_cooldown(key, stamp, minutes=20 * 60):
            self.stats["skipped_cooldown"] += 1
            return None
        variables = {
            **{k: state.get(k) for k in (
                "stress", "risk_appetite", "patience", "focus", "self_doubt", "sleep_debt"
            )},
            "primary_mode": behavior.get("primary_mode"),
            "modifiers": ", ".join(behavior.get("modifiers") or []) or "无",
            "date": date,
            "yesterday_summary": yesterday_summary,
        }
        try:
            result = self.narrator.narrate_daily_open(variables)
            self.psychology_repo.insert(
                {
                    "timestamp": timestamp or stamp.isoformat(),
                    "mood": result.mood,
                    "mood_label": result.mood_label,
                    "state_snapshot": {**state, "primary_mode": behavior.get("primary_mode")},
                    "narrative_text": result.psychology_text,
                    "prompt_version": result.prompt_version,
                }
            )
            self._mark_cooldown(key, stamp)
            self.stats["daily_open_calls"] += 1
            self.call_log.append(
                NarratorCall("daily_open", "user_daily_open", variables, key, result=result)
            )
            return result
        except Exception:
            self.stats["failed"] += 1
            return None

    def on_daily_close(
        self,
        state: dict[str, Any],
        behavior: dict[str, Any],
        day_summary: str,
        *,
        date: str,
        today_pnl: str = "0",
        timestamp: str | None = None,
        now: datetime | None = None,
    ) -> Optional[NarrativeResult]:
        stamp = now or datetime.now(timezone.utc)
        key = f"daily_close:{date}"
        if self._in_cooldown(key, stamp, minutes=20 * 60):
            self.stats["skipped_cooldown"] += 1
            return None
        variables = {
            **{k: state.get(k) for k in (
                "stress", "risk_appetite", "patience", "focus", "self_doubt", "sleep_debt"
            )},
            "primary_mode": behavior.get("primary_mode"),
            "modifiers": ", ".join(behavior.get("modifiers") or []) or "无",
            "date": date,
            "day_summary": day_summary,
            "today_pnl": today_pnl,
        }
        try:
            result = self.narrator.narrate_daily_close(variables)
            self.psychology_repo.insert(
                {
                    "timestamp": timestamp or stamp.isoformat(),
                    "mood": result.mood,
                    "mood_label": result.mood_label,
                    "state_snapshot": {**state, "primary_mode": behavior.get("primary_mode")},
                    "narrative_text": result.psychology_text,
                    "prompt_version": result.prompt_version,
                }
            )
            self._mark_cooldown(key, stamp)
            self.stats["daily_close_calls"] += 1
            self.call_log.append(
                NarratorCall("daily_close", "user_daily_close", variables, key, result=result)
            )
            return result
        except Exception:
            self.stats["failed"] += 1
            return None

    def on_news_check(
        self,
        payload: dict[str, Any],
        *,
        state: dict[str, Any] | None = None,
        behavior: dict[str, Any] | None = None,
        now: datetime | None = None,
    ) -> Optional[NarrativeResult]:
        """
        Persist a news timeline trail. Assessment/narrative already produced by NewsAssessor;
        this mainly records body action + audit stats (psych text already in psychology_log).
        """
        stamp = now or datetime.now(timezone.utc)
        assessment = payload.get("assessment")
        psych: dict[str, Any] = {}
        body: dict[str, Any] = {}
        na: dict[str, Any] = {}
        result: NarrativeResult | None = None
        if assessment is not None:
            if hasattr(assessment, "psychology"):
                psych = dict(getattr(assessment, "psychology") or {})
                body = dict(getattr(assessment, "body_action") or {})
                na = dict(getattr(assessment, "news_assessment") or {})
                result = NarrativeResult(
                    psychology_text=str(psych.get("text") or ""),
                    mood=str(psych.get("mood") or "calm"),
                    mood_label=str(psych.get("mood_label") or "平静"),
                    body_text=str(body.get("text") or ""),
                    location=str(body.get("location") or "书房"),
                    activity=str(body.get("activity") or "看新闻"),
                    prompt_version="news_check",
                    source="news",
                    raw=getattr(assessment, "raw", {}) or {},
                )
            elif isinstance(assessment, dict):
                psych = dict(assessment.get("psychology") or {})
                body = dict(assessment.get("body_action") or {})
                na = dict(assessment.get("news_assessment") or {})

        state = state or {}
        behavior = behavior or {}
        # Ensure psych row exists (checker may also write; duplicate is acceptable)
        try:
            self.psychology_repo.insert(
                {
                    "timestamp": payload.get("timestamp") or stamp.isoformat(),
                    "mood": psych.get("mood") or "calm",
                    "mood_label": psych.get("mood_label") or "新闻",
                    "state_snapshot": {
                        **state,
                        "primary_mode": behavior.get("primary_mode"),
                        "entry_type": "news",
                        "window": payload.get("window"),
                        "query": payload.get("query"),
                        "direction": na.get("direction"),
                        "impact_level": na.get("impact_level"),
                        "event_type": na.get("event_type")
                        or getattr(assessment, "event_type", None),
                        "key_point": na.get("key_point"),
                        "sources": getattr(payload.get("search_result"), "sources", None)
                        or [],
                    },
                    "narrative_text": psych.get("text") or "",
                    "prompt_version": "news_check",
                }
            )
        except Exception:  # noqa: BLE001
            self.stats["failed"] += 1
            return result

        self.stats["news_calls"] = int(self.stats.get("news_calls") or 0) + 1
        self.call_log.append(
            NarratorCall(
                trigger_type="news_check",
                template="user_news_check",
                variables={
                    "window": payload.get("window"),
                    "query": payload.get("query"),
                    "event_type": na.get("event_type"),
                },
                cooldown_key=f"news:{payload.get('check_id') or stamp.isoformat()}",
                result=result,
            )
        )
        return result

    def _in_cooldown(
        self,
        key: str,
        now: datetime,
        *,
        minutes: float | None = None,
    ) -> bool:
        last = self._last_call_at.get(key)
        if last is None:
            return False
        window = minutes if minutes is not None else self.cooldown_minutes
        return now < last + timedelta(minutes=window)

    def _mark_cooldown(self, key: str, now: datetime) -> None:
        self._last_call_at[key] = now

    def on_deadline_evaluation(
        self,
        stats: dict[str, Any],
        state: dict[str, Any],
        starting_baseline: dict[str, Any],
        current_baseline: dict[str, Any],
        *,
        today: str | None = None,
        now: datetime | None = None,
    ) -> Optional[dict[str, Any]]:
        """
        Day-90 evaluation via user_deadline_evaluation template.
        Returns parsed decision dict; never raises.
        """
        stamp = now or datetime.now(timezone.utc)
        variables = {
            "starting_equity": stats.get("starting_equity", 20000),
            "current_equity": stats.get("current_equity", 20000),
            "total_return_pct": stats.get("total_return_pct", 0),
            "trade_count": stats.get("trade_count", 0),
            "win_rate": stats.get("win_rate", 0),
            "max_drawdown_pct": stats.get("max_drawdown_pct", 0),
            "stress": state.get("stress"),
            "self_doubt": state.get("self_doubt"),
            "starting_baseline": json.dumps(starting_baseline, ensure_ascii=False)
            if not isinstance(starting_baseline, str)
            else starting_baseline,
            "current_baseline": json.dumps(current_baseline, ensure_ascii=False)
            if not isinstance(current_baseline, str)
            else current_baseline,
        }
        try:
            from ..deadline.evaluator import DeadlineEvaluator
            from ..deadline.state import DeadlineState

            evaluator = DeadlineEvaluator(
                {
                    "evaluation": {
                        "allowed_actions": ["CONTINUE", "STOP", "EXTEND"],
                        "extend_options_days": [30, 60, 90],
                    }
                },
                self.narrator,
                {},
            )
            ds = DeadlineState(
                enabled=True,
                start_date=(today or stamp.date().isoformat())[:10],
                total_days=90,
                current_day=90,
                days_left=0,
                pressure=0.05,
            )
            result = evaluator.evaluate(
                ds,
                stats,
                state,
                starting_baseline,
                current_baseline,
                today=today or stamp.date().isoformat(),
            )
            # Validate decision
            action = str(result.get("action") or "CONTINUE").upper()
            if action not in {"CONTINUE", "STOP", "EXTEND"}:
                logger.warning("invalid deadline action %s, default CONTINUE", action)
                result["action"] = "CONTINUE"
            psych = (result.get("narrative") or {}).get("psychology") or {}
            self.psychology_repo.insert(
                {
                    "timestamp": stamp.isoformat(),
                    "mood": psych.get("mood") or "anxious",
                    "mood_label": psych.get("mood_label") or "焦虑",
                    "state_snapshot": {**state, "deadline_action": result.get("action")},
                    "narrative_text": psych.get("text") or result.get("reason") or "",
                    "prompt_version": "deadline_evaluation",
                }
            )
            self.stats["deadline_eval_calls"] = self.stats.get("deadline_eval_calls", 0) + 1
            self.call_log.append(
                NarratorCall(
                    trigger_type="deadline_evaluation",
                    template="user_deadline_evaluation",
                    variables=variables,
                    cooldown_key=f"deadline:{today or stamp.date().isoformat()}",
                    result=None,
                )
            )
            return result
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "deadline evaluation narrative failed, default CONTINUE: %s", exc
            )
            self.stats["failed"] += 1
            return {
                "action": "CONTINUE",
                "reason": "评估失败，默认继续",
                "new_deadline_days": None,
                "narrative": {
                    "psychology": {
                        "text": "再观察几天。",
                        "mood": "anxious",
                        "mood_label": "焦虑",
                    }
                },
            }
