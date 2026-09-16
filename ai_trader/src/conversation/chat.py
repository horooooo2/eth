"""Chat controller: classify → prompt → LLM → impact → persist."""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from .impact import ImpactClassifier
from .llm import AdapterLLMClient, ConversationLLMClient, LLMError
from .memory import ConversationMemory
from .prompt_builder import ConversationPromptBuilder

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _mood_from_state(state: dict[str, Any]) -> tuple[str, str]:
    stress = float(state.get("stress") or 0.3)
    self_doubt = float(state.get("self_doubt") or 0.4)
    if stress >= 0.7:
        return "anxious", "焦虑"
    if self_doubt >= 0.65:
        return "tired", "疲惫"
    if float(state.get("risk_appetite") or 0.5) >= 0.65 and self_doubt < 0.35:
        return "confident", "自信"
    return "calm", "平静"


class ChatController:
    def __init__(
        self,
        config: dict[str, Any] | Path | str,
        llm_client: Any,
        memory: ConversationMemory,
        prompt_builder: ConversationPromptBuilder,
        impact_classifier: ImpactClassifier,
        state_engine: Any,
        *,
        account_provider: Any | None = None,
        position_repo: Any | None = None,
        deadline_manager: Any | None = None,
        behavior_classifier: Any | None = None,
    ) -> None:
        if isinstance(config, (str, Path)):
            path = Path(config)
            self.config = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        else:
            self.config = dict(config or {})
        self.enabled = bool(self.config.get("enabled", True))
        if hasattr(llm_client, "chat_messages"):
            self.llm_client = llm_client
        else:
            self.llm_client = AdapterLLMClient(llm_client)
        self.memory = memory
        self.prompt_builder = prompt_builder
        self.impact_classifier = impact_classifier
        self.state_engine = state_engine
        self.account_provider = account_provider
        self.position_repo = position_repo
        self.deadline_manager = deadline_manager
        self.behavior_classifier = behavior_classifier

    def send(self, user_message: str) -> dict[str, Any]:
        text = (user_message or "").strip()
        if not text:
            raise ValueError("empty message")

        state = self.state_engine.snapshot()
        impact = self.impact_classifier.classify(text, state)

        if impact.silence:
            return self._handle_ai_question(text, state)

        context = self._get_context()
        mood, mood_label = _mood_from_state(context["state"])
        messages = self.prompt_builder.build(
            state=context["state"],
            behavior=context["behavior"],
            account=context["account"],
            deadline_state=context["deadline"],
            recent_messages=self.memory.get_recent(),
            user_message=text,
            mood_label=mood_label,
        )

        try:
            reply = str(self.llm_client.chat_messages(messages)).strip()
            if not reply:
                reply = "让我想想。"
        except Exception as exc:  # noqa: BLE001
            logger.warning("chat LLM failed: %s", exc)
            if impact.rejection:
                reply = impact.rejection
            else:
                err = str(exc)
                if "DEEPSEEK" in err.upper() or "api_key" in err.lower() or "401" in err:
                    reply = "（DeepSeek 未就绪或密钥无效，请先在 API 配置里填好并保存）"
                else:
                    reply = "让我想想。刚才卡住了一下。"

        llm_backend = "unknown"
        if hasattr(self.llm_client, "last_backend"):
            llm_backend = str(getattr(self.llm_client, "last_backend") or "unknown")
        elif hasattr(self.llm_client, "backend"):
            try:
                llm_backend = str(self.llm_client.backend())
            except Exception:  # noqa: BLE001
                pass
        elif self.llm_client.__class__.__name__ == "ConversationLLMClient":
            llm_backend = "deepseek"
        elif self.llm_client.__class__.__name__ == "MockLLMClient":
            llm_backend = "mock"

        # Soft-enforce polite refusal wording when guidance
        if impact.category == "guidance" and impact.rejection:
            if not any(k in reply for k in ("自己的", "考虑", "规则", "谢谢")):
                reply = impact.rejection

        applied: dict[str, float] = {}
        if impact.impacts and self.impact_classifier._check_cooldown():
            self.state_engine.apply_conversation_impact(impact.impacts)
            self.impact_classifier.mark_impact_applied()
            applied = dict(impact.impacts)

        ts = _now_iso()
        self.memory.add_message(
            "user",
            text,
            state_snapshot=context["state"],
            trigger_type="passive",
            timestamp=ts,
        )
        self.memory.add_message(
            "zhangming",
            reply,
            state_snapshot=self.state_engine.snapshot(),
            trigger_type="passive",
            impact_applied=applied or None,
            timestamp=ts,
        )

        return {
            "reply": reply,
            "silence": False,
            "impact_applied": applied,
            "mood": mood,
            "mood_label": mood_label,
            "timestamp": ts,
            "category": impact.category,
            "llm_backend": llm_backend,
        }

    def _get_context(self) -> dict[str, Any]:
        state = self.state_engine.snapshot()
        behavior = {"primary_mode": "NORMAL", "modifiers": []}
        if self.behavior_classifier is not None:
            try:
                result = self.behavior_classifier.classify(self.state_engine.state)
                behavior = {
                    "primary_mode": result.primary_mode,
                    "modifiers": list(result.modifiers),
                }
            except Exception:  # noqa: BLE001
                pass

        account = {"equity": 20000, "today_pnl": 0, "position_count": 0}
        if callable(self.account_provider):
            try:
                account = {**account, **(self.account_provider() or {})}
            except Exception:  # noqa: BLE001
                pass
        elif self.position_repo is not None:
            try:
                opens = self.position_repo.list_open() if hasattr(self.position_repo, "list_open") else []
                account["position_count"] = len(opens or [])
            except Exception:  # noqa: BLE001
                pass

        deadline: dict[str, Any] = {"current_day": 0, "total_days": 90, "days_left": 90}
        mgr = self.deadline_manager or getattr(self.state_engine, "deadline_manager", None)
        if mgr is not None:
            try:
                st = mgr.get_state() if hasattr(mgr, "get_state") else None
                if st is not None:
                    deadline = {
                        "current_day": getattr(st, "current_day", 0),
                        "total_days": getattr(st, "total_days", 90),
                        "days_left": getattr(st, "days_left", 90),
                    }
            except Exception:  # noqa: BLE001
                pass

        return {
            "state": state,
            "behavior": behavior,
            "account": account,
            "deadline": deadline,
        }

    def _handle_ai_question(self, user_message: str, state: dict[str, Any]) -> dict[str, Any]:
        sens = dict(self.config.get("sensitivity") or {})
        silent = str(sens.get("silent_response") or "...")
        ts = _now_iso()
        mood, mood_label = _mood_from_state(state)
        self.memory.add_message(
            "user",
            user_message,
            state_snapshot=state,
            trigger_type="passive",
            timestamp=ts,
        )
        # Do not store a zhangming reply for pure silence; UI shows "没有回复"
        return {
            "reply": "",
            "silence": True,
            "impact_applied": {},
            "mood": mood,
            "mood_label": mood_label,
            "timestamp": ts,
            "category": "ai_question",
            "silent_placeholder": silent,
        }
