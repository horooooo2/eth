"""LLM Narrator: describe decisions/events without changing numbers."""
from __future__ import annotations

import json
import logging
import os
import re
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
from urllib import request

from .llm_log import log_llm_call
from .prompt_builder import PromptBuilder, PromptConfigError

ROOT = Path(__file__).resolve().parents[2]
logger = logging.getLogger(__name__)


@dataclass
class NarrativeResult:
    """Structured narrative output for psychology + body action."""

    psychology_text: str
    mood: str
    mood_label: str
    body_text: str
    location: str
    activity: str
    prompt_version: str
    source: str  # llm | mock | fallback
    raw: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @property
    def body_action_text(self) -> str:
        """Alias used by event bridge / repos."""
        return self.body_text


def _fallback_enabled(config: dict[str, Any]) -> bool:
    raw = config.get("fallback_on_error", True)
    if isinstance(raw, str):
        return raw.strip().lower() in {"1", "true", "yes", "mock", "fallback"}
    return bool(raw)


class Narrator:
    """
    Event-driven narrator.
    Uses external prompts; never mutates trading decisions or trait numbers.
    """

    def __init__(
        self,
        config_path: Path | None = None,
        *,
        project_root: Path | None = None,
        api_key: str | None = None,
        llm_client: Any | None = None,
    ) -> None:
        self.project_root = project_root or ROOT
        self.config_path = Path(config_path or (self.project_root / "config" / "narrator_config.json"))
        self.config = json.loads(self.config_path.read_text(encoding="utf-8"))
        self.prompt_builder = PromptBuilder.from_narrator_config(
            self.config_path, self.project_root
        )
        env_key = (os.environ.get("DEEPSEEK_API_KEY") or "").strip()
        if api_key is None:
            self.api_key = env_key
        else:
            self.api_key = str(api_key).strip()
        self.llm_client = llm_client
        cfg_enabled = bool(self.config.get("enabled"))
        self.enabled = cfg_enabled and bool(self.api_key) and self.llm_client is None
        self.call_count = 0
        self.mode = self._resolve_mode()

    def _resolve_mode(self) -> str:
        if self.llm_client is not None:
            name = self.llm_client.__class__.__name__
            if name.startswith("Mock"):
                return "mock"
            return "real"
        if not self.config.get("enabled"):
            return "disabled"
        if not self.api_key:
            return "mock"
        return "real"

    @property
    def prompt_version(self) -> str:
        return self.prompt_builder.version

    def _api_settings(self) -> dict[str, Any]:
        api = self.config.get("api") if isinstance(self.config.get("api"), dict) else {}
        return {
            "base_url": str(api.get("base_url") or "https://api.deepseek.com").rstrip("/"),
            "timeout": float(
                api.get("timeout_seconds")
                or self.config.get("timeout_seconds")
                or 8
            ),
            "temperature": float(
                api.get("temperature") or self.config.get("temperature") or 0.7
            ),
            "max_tokens": int(api.get("max_tokens") or 300),
            "model": str(self.config.get("model") or "deepseek-chat"),
        }

    def narrate_decision(self, variables: dict[str, Any]) -> NarrativeResult:
        """Build decision prompt and produce narrative (LLM or fallback)."""
        system, user = self.prompt_builder.build_decision_prompt(**variables)
        return self._generate(system, user, variables, scene="decision")

    def narrate_event(self, variables: dict[str, Any]) -> NarrativeResult:
        system, user = self.prompt_builder.build_event_prompt(**variables)
        return self._generate(system, user, variables, scene="event")

    def narrate_daily_open(self, variables: dict[str, Any]) -> NarrativeResult:
        system, user = self.prompt_builder.build_daily_open_prompt(**variables)
        return self._generate(system, user, variables, scene="daily_open")

    def narrate_daily_close(self, variables: dict[str, Any]) -> NarrativeResult:
        system, user = self.prompt_builder.build_daily_close_prompt(**variables)
        return self._generate(system, user, variables, scene="daily_close")

    def narrate_news_check(self, variables: dict[str, Any]) -> NarrativeResult:
        system, user = self.prompt_builder.build_news_check_prompt(**variables)
        return self._generate(system, user, variables, scene="news_check")

    def _generate(
        self,
        system: str,
        user: str,
        variables: dict[str, Any],
        *,
        scene: str,
    ) -> NarrativeResult:
        self.call_count += 1
        # Injected client (Mock or custom) takes priority.
        if self.llm_client is not None:
            t0 = time.perf_counter()
            try:
                raw = self.llm_client.complete(system, user)
                source = "mock" if self.llm_client.__class__.__name__.startswith("Mock") else "llm"
                latency = (time.perf_counter() - t0) * 1000
                log_llm_call(
                    component="narrator",
                    scene=scene,
                    latency_ms=latency,
                    status="ok",
                    fallback="mock" if source == "mock" else None,
                )
                return self._parse_result(raw, source=source)
            except Exception as exc:  # noqa: BLE001
                latency = (time.perf_counter() - t0) * 1000
                log_llm_call(
                    component="narrator",
                    scene=scene,
                    latency_ms=latency,
                    status=type(exc).__name__,
                    fallback="mock" if _fallback_enabled(self.config) else None,
                )
                if not _fallback_enabled(self.config):
                    raise
                return self._fallback(variables, scene=scene)
        if self.enabled:
            t0 = time.perf_counter()
            try:
                raw = self._call_llm(system, user)
                latency = (time.perf_counter() - t0) * 1000
                log_llm_call(
                    component="narrator",
                    scene=scene,
                    latency_ms=latency,
                    status="ok",
                    prompt_tokens=None,
                    completion_tokens=None,
                )
                return self._parse_result(raw, source="llm")
            except Exception as exc:  # noqa: BLE001
                latency = (time.perf_counter() - t0) * 1000
                logger.warning("narrator LLM failed scene=%s: %s", scene, exc)
                log_llm_call(
                    component="narrator",
                    scene=scene,
                    latency_ms=latency,
                    status=type(exc).__name__,
                    fallback="mock" if _fallback_enabled(self.config) else None,
                )
                if not _fallback_enabled(self.config):
                    raise
        return self._fallback(variables, scene=scene)

    def _call_llm(self, system: str, user: str) -> dict[str, Any]:
        """Call DeepSeek-compatible chat completions API."""
        settings = self._api_settings()
        payload = {
            "model": settings["model"],
            "temperature": settings["temperature"],
            "max_tokens": settings["max_tokens"],
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "response_format": {"type": "json_object"},
        }
        url = f"{settings['base_url']}/chat/completions"
        req = request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
            method="POST",
        )
        with request.urlopen(req, timeout=settings["timeout"]) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        content = body["choices"][0]["message"]["content"]
        return self._extract_json(content)

    @staticmethod
    def _extract_json(text: str) -> dict[str, Any]:
        text = text.strip()
        try:
            data = json.loads(text)
            if isinstance(data, dict):
                return data
        except json.JSONDecodeError:
            pass
        match = re.search(r"\{[\s\S]*\}", text)
        if not match:
            raise ValueError("LLM response missing JSON object")
        data = json.loads(match.group(0))
        if not isinstance(data, dict):
            raise ValueError("LLM JSON is not an object")
        return data

    def _parse_result(self, raw: dict[str, Any], *, source: str) -> NarrativeResult:
        psych = raw.get("psychology") or {}
        body = raw.get("body_action") or {}
        text = str(psych.get("text") or "").strip()
        if not text:
            raise ValueError("missing psychology.text")
        return NarrativeResult(
            psychology_text=text[:80],
            mood=str(psych.get("mood") or "calm"),
            mood_label=str(psych.get("mood_label") or "平静"),
            body_text=str(body.get("text") or "")[:60],
            location=str(body.get("location") or "书房"),
            activity=str(body.get("activity") or "看盘"),
            prompt_version=self.prompt_version,
            source=source,
            raw=raw,
        )

    def _fallback(self, variables: dict[str, Any], *, scene: str) -> NarrativeResult:
        """Deterministic offline narrative from mode + decision/event."""
        mode = str(variables.get("primary_mode") or "NORMAL")
        decision = str(variables.get("decision") or "")
        event_name = str(variables.get("event_name") or "")
        if scene in {"daily_open", "daily_close"}:
            text = "新的一天还得过。账户还在，人就得撑住。" if scene == "daily_open" else "今天先这样，睡一觉再说。"
            mood, label = ("calm", "平静") if scene == "daily_open" else ("tired", "疲惫")
            body = "洗了把脸，坐回书桌。" if scene == "daily_open" else "关掉屏幕，躺到床上。"
            activity = "休息"
        elif scene == "event" and event_name:
            text = f"又是{event_name}。心里一阵烦，但我还得撑着。"
            mood, label = "anxious", "焦虑"
            body = "站起来走了两步，又坐回椅子。"
            activity = "休息"
        elif decision.startswith("OPEN"):
            text = f"管不了那么多了，{mode} 下我还是想动手。"
            mood, label = "anxious", "焦虑"
            body = "打开交易终端，手指停在下单键上。"
            activity = "打开交易终端"
        elif decision == "SKIP":
            text = "这次先忍住。不是机会不对，是我自己不对。"
            mood, label = "tired", "疲惫"
            body = "把屏幕亮度调低，靠在椅背上。"
            activity = "看盘"
        else:
            text = "今天就这样吧，先把情绪压下去。"
            mood, label = "calm", "平静"
            body = "倒了杯水，坐回书房。"
            activity = "休息"
        raw = {
            "psychology": {"text": text, "mood": mood, "mood_label": label},
            "body_action": {
                "text": body,
                "location": "书房",
                "activity": activity,
            },
        }
        return NarrativeResult(
            psychology_text=text,
            mood=mood,
            mood_label=label,
            body_text=body,
            location="书房",
            activity=activity,
            prompt_version=self.prompt_version,
            source="fallback",
            raw=raw,
        )


__all__ = ["Narrator", "NarrativeResult", "PromptBuilder", "PromptConfigError"]
