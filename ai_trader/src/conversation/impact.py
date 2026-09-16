"""Classify user messages and compute weak state impacts."""
from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any, Optional


GUIDANCE_PATTERNS = (
    "你应该",
    "你必须",
    "赶紧",
    "一定要",
    "马上",
    "立刻",
    "重仓",
    "全部仓位",
    "all in",
    "ALL IN",
)

BULLISH_WORDS = ("看多", "上涨", "要涨", "会涨", "做多", "冲高", "bullish", "long")
BEARISH_WORDS = ("看空", "下跌", "要跌", "会跌", "做空", "跌了", "bearish", "short")
ASSET_WORDS = ("BTC", "ETH", "比特币", "以太", "闪迪", "btc", "eth")


@dataclass
class ConversationImpact:
    category: str  # opinion / guidance / question / chitchat / ai_question
    impacts: dict[str, float] = field(default_factory=dict)
    rejection: Optional[str] = None
    silence: bool = False
    opinion: Optional[dict[str, str]] = None


class ImpactClassifier:
    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        impact_cfg = dict(config.get("impact") or {})
        self.enabled = bool(impact_cfg.get("enabled", True))
        self.max_magnitude = float(impact_cfg.get("max_impact_magnitude", 0.02))
        self.cooldown_seconds = float(impact_cfg.get("cooldown_seconds", 300))
        sens = dict(config.get("sensitivity") or {})
        self.ai_keywords = [str(k) for k in (sens.get("ai_question_keywords") or [])]
        self.last_impact_time: float = 0.0

    def classify(self, user_message: str, current_state: dict[str, Any]) -> ConversationImpact:
        text = (user_message or "").strip()
        if not text:
            return ConversationImpact(category="chitchat")

        if self._is_ai_question(text):
            return ConversationImpact(category="ai_question", silence=True)

        if self._is_guidance(text):
            return ConversationImpact(
                category="guidance",
                impacts={"self_doubt": 0.01} if self.enabled else {},
                rejection="我有自己的想法，还是按我的规则来吧。",
            )

        opinion = self._extract_opinion(text)
        if opinion is not None:
            impacts: dict[str, float] = {}
            if self.enabled and self._check_cooldown():
                impacts = self._compute_opinion_impact(opinion, current_state)
            return ConversationImpact(category="opinion", impacts=impacts, opinion=opinion)

        if self._is_question(text):
            return ConversationImpact(category="question")

        return ConversationImpact(category="chitchat")

    def mark_impact_applied(self) -> None:
        self.last_impact_time = time.time()

    def _is_ai_question(self, message: str) -> bool:
        lowered = message.lower()
        for kw in self.ai_keywords:
            if not kw:
                continue
            if kw.isascii():
                if kw.lower() in lowered:
                    return True
            elif kw in message:
                return True
        return False

    def _is_guidance(self, message: str) -> bool:
        return any(p in message for p in GUIDANCE_PATTERNS)

    def _is_question(self, message: str) -> bool:
        if message.endswith("？") or message.endswith("?"):
            return True
        return bool(re.search(r"[吗呢吧]$", message)) or ("吗" in message and len(message) < 40)

    def _extract_opinion(self, message: str) -> Optional[dict[str, str]]:
        direction: str | None = None
        if any(w in message or w.lower() in message.lower() for w in BULLISH_WORDS):
            direction = "bullish"
        elif any(w in message or w.lower() in message.lower() for w in BEARISH_WORDS):
            direction = "bearish"
        if direction is None:
            return None
        target = "BTC"
        for asset in ASSET_WORDS:
            if asset in message or asset.lower() in message.lower():
                target = "ETH" if asset.lower() in {"eth", "以太"} else (
                    "SNDK" if "闪迪" in asset or asset == "闪迪" else "BTC"
                )
                if asset in ("ETH", "eth", "以太"):
                    target = "ETH"
                elif "闪迪" in message:
                    target = "SNDK"
                else:
                    target = "BTC"
                break
        return {"direction": direction, "target": target}

    def _compute_opinion_impact(
        self, opinion: dict[str, str], current_state: dict[str, Any]
    ) -> dict[str, float]:
        direction = opinion.get("direction")
        risk = float(current_state.get("risk_appetite") or 0.5)
        if direction == "bullish":
            impacts = {"risk_appetite": 0.01, "focus": 0.005}
            # Conflict: already very risk-off
            if risk < 0.35:
                impacts = {k: v * 0.5 for k, v in impacts.items()}
        else:
            impacts = {"risk_appetite": -0.01}
            if risk > 0.65:
                impacts = {k: v * 0.5 for k, v in impacts.items()}

        # Cap total absolute magnitude
        total = sum(abs(v) for v in impacts.values())
        if total > self.max_magnitude and total > 0:
            scale = self.max_magnitude / total
            impacts = {k: round(v * scale, 6) for k, v in impacts.items()}
        return impacts

    def _check_cooldown(self) -> bool:
        if self.last_impact_time <= 0:
            return True
        return (time.time() - self.last_impact_time) >= self.cooldown_seconds
