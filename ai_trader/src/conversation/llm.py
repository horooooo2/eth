"""LLM helpers for free-form Zhang Ming chat replies."""
from __future__ import annotations

import json
import os
from typing import Any
from urllib import request


class LLMError(RuntimeError):
    """Chat LLM call failed."""


class ConversationLLMClient:
    """DeepSeek-compatible chat completions (plain text, not JSON mode)."""

    def __init__(
        self,
        api_key: str | None = None,
        *,
        model: str = "deepseek-chat",
        timeout_seconds: float = 20.0,
        temperature: float = 0.7,
    ) -> None:
        self.api_key = api_key if api_key is not None else os.environ.get("DEEPSEEK_API_KEY", "")
        self.model = model
        self.timeout_seconds = timeout_seconds
        self.temperature = temperature
        self.call_count = 0

    def chat_messages(self, messages: list[dict[str, str]]) -> str:
        if not self.api_key:
            raise LLMError("missing DEEPSEEK_API_KEY")
        self.call_count += 1
        payload = {
            "model": self.model,
            "temperature": self.temperature,
            "messages": messages,
        }
        req = request.Request(
            "https://api.deepseek.com/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
            method="POST",
        )
        try:
            with request.urlopen(req, timeout=self.timeout_seconds) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            raise LLMError(str(exc)) from exc
        content = body["choices"][0]["message"]["content"]
        return str(content or "").strip()


class AdapterLLMClient:
    """Adapt MockLLMClient / Narrator client to chat_messages API."""

    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.call_count = 0

    def chat_messages(self, messages: list[dict[str, str]]) -> str:
        self.call_count += 1
        if hasattr(self.inner, "chat_messages"):
            return str(self.inner.chat_messages(messages))
        # Fall back to complete(system, user)
        system = ""
        user_parts: list[str] = []
        for m in messages:
            role = m.get("role")
            content = m.get("content") or ""
            if role == "system":
                system = content
            elif role == "user":
                user_parts.append(content)
            elif role == "assistant":
                user_parts.append(f"（张明之前说：{content}）")
        user = user_parts[-1] if user_parts else ""
        if hasattr(self.inner, "complete"):
            out = self.inner.complete(system, user)
            if isinstance(out, dict):
                # Prefer plain reply field if mock returns chat shape
                if "reply" in out:
                    return str(out["reply"])
                psych = out.get("psychology") or {}
                if psych.get("text"):
                    return str(psych["text"])
                return json.dumps(out, ensure_ascii=False)
            return str(out)
        raise LLMError("no compatible LLM client")


class DynamicLLMClient:
    """
    Prefer DeepSeek when DEEPSEEK_API_KEY is set; otherwise MockLLM.
    Resolves on every call so saving a key in the API modal takes effect
    without restarting the process.
    """

    def __init__(self, *, allow_mock: bool = True) -> None:
        self.allow_mock = allow_mock
        self.call_count = 0
        self.last_backend: str = "unset"
        self._mock: Any | None = None

    def backend(self) -> str:
        key = (os.environ.get("DEEPSEEK_API_KEY") or "").strip()
        return "deepseek" if key else "mock"

    def chat_messages(self, messages: list[dict[str, str]]) -> str:
        self.call_count += 1
        key = (os.environ.get("DEEPSEEK_API_KEY") or "").strip()
        if key:
            self.last_backend = "deepseek"
            return ConversationLLMClient(api_key=key).chat_messages(messages)
        if not self.allow_mock:
            raise LLMError("未配置 DEEPSEEK_API_KEY")
        self.last_backend = "mock"
        if self._mock is None:
            from ..narrator.mock_client import MockLLMClient

            self._mock = MockLLMClient()
        return str(self._mock.chat_messages(messages))
