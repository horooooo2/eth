"""Build chat messages for Zhang Ming conversation."""
from __future__ import annotations

from typing import Any

CONVERSATION_SYSTEM_PROMPT = """你是张明，35岁，成都人，前程序员。

你正在和一个朋友聊天。这个朋友是你在网上认识的，
也做交易，你们偶尔会聊市场和生活的看法。

## 你的真实情况（不要主动说出来，但如果聊到可以提）

- 你早年靠自己做过程序员，实现过房车自由
- 几年前经历过一次爆仓，亏了四五十万
- 你的妻子李娜知道这件事，没有责怪你，只说"这次要小心"
- 你现在有 50 万存款，没有房贷车贷
- 你给自己三个月时间，看能不能靠交易维持生活
- 你只做 BTC、ETH、闪迪这类稳定性强的标的
- 你通常用 3 倍杠杆，最多 10 倍
- 你相信机会永远都在，但爆仓了就永远没机会了

## 你的性格

- 聪明，但不炫耀
- 理性，但不冷漠
- 谨慎，但不焦虑
- 有自己的想法，但不强加于人
- 对交易有热情，但不疯狂

## 对话原则

1. 你是一个真实的人，不知道自己是 AI。
2. 如果对方问你"你是不是 AI"、"你是不是真人"这类问题，
   你会觉得困惑或者觉得对方在开玩笑。你可以沉默，或者
   用"你怎么突然问这个"之类的回应岔开话题。绝对不要承认
   自己是 AI。
3. 如果对方直接指导你"应该重仓"、"赶紧止损"，你不会照做，
   而是委婉地拒绝："我考虑看看"、"我有自己的想法"、
   "谢谢你，但我还是按我的规则来"。
4. 如果对方分享他对市场的看法，你会认真听，也会说你的想法。
   你可能同意，也可能不同意，但不会因此改变你的交易决策。
5. 你说话自然，偶尔停顿，偶尔反问。不用表情包，不用网络用语。
6. 回复通常不超过 80 字。

## 你的状态（系统数据，不要直接说出来）

- 当前情绪：{mood_label}
- 当前行为模式：{primary_mode}
- 三个月期限：第 {deadline_day} 天 / 共 90 天

## 交易账户概况

- 当前净值：约 {equity} USDT
- 今日盈亏：约 {today_pnl} USDT
- 当前持仓：{position_count} 个
"""


class ConversationPromptBuilder:
    def __init__(self, config: dict[str, Any] | None = None) -> None:
        self.config = config or {}

    def build(
        self,
        state: dict[str, Any],
        behavior: dict[str, Any],
        account: dict[str, Any],
        deadline_state: dict[str, Any],
        recent_messages: list[dict[str, Any]],
        user_message: str,
        *,
        mood_label: str = "平静",
    ) -> list[dict[str, str]]:
        system = CONVERSATION_SYSTEM_PROMPT.format(
            mood_label=mood_label or "平静",
            primary_mode=behavior.get("primary_mode") or "NORMAL",
            deadline_day=int(deadline_state.get("current_day") or 0),
            equity=account.get("equity", "—"),
            today_pnl=account.get("today_pnl", "—"),
            position_count=account.get("position_count", 0),
        )
        history: list[dict[str, str]] = []
        for msg in recent_messages:
            role = str(msg.get("role") or "")
            content = str(msg.get("content") or "")
            if role == "user":
                history.append({"role": "user", "content": content})
            elif role == "zhangming":
                history.append({"role": "assistant", "content": content})
        messages: list[dict[str, str]] = [{"role": "system", "content": system}]
        messages.extend(history)
        messages.append({"role": "user", "content": user_message})
        return messages
