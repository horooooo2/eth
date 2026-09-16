"""Mock LLM client for offline narrator tests and mock replay."""
from __future__ import annotations

import json
import re
from typing import Any


class MockLLMClient:
    """
    Deterministic chat client.
    - Default: scene-aware JSON from prompt text
    - Optional fixed response queue
    - Optional fail_on_call to simulate errors
    """

    def __init__(
        self,
        responses: list[str | dict[str, Any]] | None = None,
        fail_on_call: int | None = None,
    ) -> None:
        self.responses = list(responses or [])
        self.fail_on_call = fail_on_call
        self.call_count = 0
        self.calls: list[dict[str, str]] = []

    def complete(self, system: str, user: str) -> dict[str, Any]:
        """Return a JSON-compatible narrative payload."""
        self.call_count += 1
        self.calls.append({"system": system, "user": user})
        if self.fail_on_call is not None and self.call_count == self.fail_on_call:
            raise RuntimeError("mock LLM forced failure")
        if self.responses:
            item = self.responses.pop(0)
            if isinstance(item, str):
                try:
                    return json.loads(item)
                except json.JSONDecodeError:
                    return {"reply": item, "psychology": {"text": item, "mood": "calm", "mood_label": "平静"}}
            return dict(item)
        return self._default_response(user)

    def chat_messages(self, messages: list[dict[str, str]]) -> str:
        """Plain-text chat reply for ConversationLLMClient compatibility."""
        user = ""
        system = ""
        for m in messages:
            if m.get("role") == "system":
                system = m.get("content") or ""
            if m.get("role") == "user":
                user = m.get("content") or user
        self.calls.append({"system": system, "user": user})
        self.call_count += 1
        if self.fail_on_call is not None and self.call_count == self.fail_on_call:
            raise RuntimeError("mock LLM forced failure")
        if self.responses:
            item = self.responses.pop(0)
            if isinstance(item, str):
                try:
                    data = json.loads(item)
                    return str(data.get("reply") or data.get("psychology", {}).get("text") or item)
                except json.JSONDecodeError:
                    return item
            return str(item.get("reply") or (item.get("psychology") or {}).get("text") or "")
        return self._default_chat_reply(user, system)

    def _default_chat_reply(self, user: str, system: str) -> str:
        if any(k in user for k in ("重仓", "你应该", "赶紧", "一定要")):
            return "谢谢你，但我还是按我的规则来。我有自己的想法。"
        if any(k in user for k in ("看多", "上涨", "做多")):
            return "我也留意了一下，方向或许对，但我不会因此改仓。"
        if any(k in user for k in ("看空", "要跌", "做空")):
            return "有可能吧。我会盯着规则走，不会因为一句话就空翻多。"
        if "你好" in user or "在吗" in user:
            return "在。今天盘面还算平稳，你那边怎么样？"
        if "天气" in user or "吃饭" in user:
            return "还行。李娜在弄晚饭，我先歇一会儿。"
        return "嗯，我听着。你再说细一点。"

    def _default_response(self, user: str) -> dict[str, Any]:
        # Scene detection must use template anchors, not 睡眠债 etc.
        if "已经做出了决策" in user:
            decision = self._extract_decision(user)
            if decision == "SKIP":
                text = "这次先放过。不是没机会，是我今天状态不对。"
                mood, label = "tired", "疲惫"
                body = "把椅子往后靠，揉了揉眼睛。"
                activity = "看盘"
            else:
                text = "这笔单我想试一下，心里有点紧，但还是点下去了。"
                mood, label = "anxious", "焦虑"
                body = "打开交易终端，盯着下单按钮。"
                activity = "打开交易终端"
        elif "新的一天开始了" in user:
            text = "又是新的一天。账户还在，人还得撑住。"
            mood, label = "calm", "平静"
            body = "洗了把脸，坐回书桌前。"
            activity = "休息"
        elif "今天结束了" in user or "睡前的内心独白" in user:
            text = "今天就到这里。亏也好赚也好，先睡一觉。"
            mood, label = "tired", "疲惫"
            body = "关掉屏幕，躺到床上。"
            activity = "休息"
        elif "刚刚发生的事" in user:
            name = self._extract_event_name(user)
            text = f"又是{name}。心里一阵烦，但我还得撑着。"
            mood, label = "angry", "愤怒"
            body = "摔门进了书房，打开电脑。"
            activity = "打开交易终端"
        elif (
            "CONTINUE" in user
            and "STOP" in user
            and "EXTEND" in user
        ) or "三个月到了" in user or "三个月评估" in user:
            return {
                "action": "EXTEND",
                "reason": "这三个月证明了方法可行，也暴露了压力下的弱点。我想再给自己一次机会。",
                "new_deadline_days": 90,
                "narrative": {
                    "psychology": {
                        "text": "再给我一次机会。这三个月还不够。",
                        "mood": "confident",
                        "mood_label": "自信",
                    }
                },
            }
        else:
            text = "先冷静一下，别当场乱动。"
            mood, label = "calm", "平静"
            body = "倒了杯水，坐回书房。"
            activity = "休息"
        return {
            "psychology": {"text": text, "mood": mood, "mood_label": label},
            "body_action": {
                "text": body,
                "location": "书房",
                "activity": activity,
            },
        }

    @staticmethod
    def _extract_decision(user: str) -> str:
        m = re.search(r"已经做出了决策\s*\n\s*([A-Z_]+)", user)
        return m.group(1) if m else ""

    @staticmethod
    def _extract_event_name(user: str) -> str:
        m = re.search(r"刚刚发生的事\s*\n\s*([^：\n]+)", user)
        return (m.group(1).strip() if m else "这件事") or "这件事"
