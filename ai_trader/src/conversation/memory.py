"""Short-term conversation memory backed by ConversationRepo."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional


class ConversationMemory:
    def __init__(self, repo: Any, max_turns: int = 20) -> None:
        self.repo = repo
        self.max_turns = max(1, int(max_turns))

    def get_recent(self, limit: Optional[int] = None) -> list[dict[str, Any]]:
        """Return recent messages (user + zhangming), chronological."""
        # Each turn ≈ 2 messages
        n = int(limit) if limit is not None else self.max_turns * 2
        return self.repo.list_recent(max(1, n))

    def add_message(
        self,
        role: str,
        content: str,
        state_snapshot: Optional[dict[str, Any]] = None,
        trigger_type: str = "passive",
        impact_applied: Optional[dict[str, Any]] = None,
        timestamp: Optional[str] = None,
    ) -> int:
        ts = timestamp or datetime.now(timezone.utc).isoformat()
        return int(
            self.repo.insert_message(
                {
                    "timestamp": ts,
                    "role": role,
                    "content": content,
                    "state_snapshot": state_snapshot,
                    "trigger_type": trigger_type,
                    "impact_applied": impact_applied,
                }
            )
        )

    def to_prompt_format(self, messages: list[dict[str, Any]]) -> list[dict[str, str]]:
        out: list[dict[str, str]] = []
        for msg in messages:
            role = str(msg.get("role") or "")
            content = str(msg.get("content") or "")
            if role == "user":
                out.append({"role": "user", "content": content})
            elif role == "zhangming":
                out.append({"role": "assistant", "content": content})
        return out
