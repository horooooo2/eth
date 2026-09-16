"""Shared helpers for API route handlers."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

OWNER_HEADER = "X-AI-Trader-Owner"

MODE_LABELS = {
    "REVENGE_TRADING": "报复性交易",
    "FROZEN": "冻结观望",
    "EXHAUSTED": "身心疲惫",
    "OVERCONFIDENT": "过度自信",
    "IMPULSIVE": "冲动下单",
    "CAUTIOUS": "谨慎防守",
    "NORMAL": "常态",
}

EVENT_ICONS = {
    "ARGUMENT_WITH_WIFE": "💔",
    "RENT_DUE": "💸",
    "EX_COLLEAGUE_NEW_CAR": "🚗",
    "INTERVIEW_REJECTED": "📋",
    "CHILD_SICK": "🤒",
    "SLEPT_7_HOURS": "😴",
    "STOP_LOSS_TRIGGERED": "📉",
    "LOSS_STREAK_3": "📉",
    "LOSS_STREAK_5": "📉",
    "BIG_WIN": "📈",
}

START_EQUITY = 20000.0
RISK_CAP_PCT = 1.0


def parse_json(value: Any, default: Any = None) -> Any:
    if value is None:
        return default if default is not None else {}
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return default if default is not None else {}
    return default if default is not None else {}


def mode_label(mode: str | None) -> str:
    if not mode:
        return "未知"
    return MODE_LABELS.get(mode, mode)


def relative_time(ts: str | None, now: datetime | None = None) -> str:
    if not ts:
        return "未知"
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return ts
    now = now or datetime.now(timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    delta = now - dt
    minutes = int(delta.total_seconds() // 60)
    if minutes < 60:
        return f"{max(minutes, 0)}分钟前"
    hours = minutes // 60
    if hours < 24:
        return f"{hours}小时前"
    days = hours // 24
    if days == 1:
        return "昨天"
    return f"{days}天前"


def holding_minutes(entry_time: str | None, end_time: str | None = None) -> int:
    if not entry_time:
        return 0
    try:
        start = datetime.fromisoformat(entry_time.replace("Z", "+00:00"))
        end = (
            datetime.fromisoformat(end_time.replace("Z", "+00:00"))
            if end_time
            else datetime.now(timezone.utc)
        )
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        if end.tzinfo is None:
            end = end.replace(tzinfo=timezone.utc)
        return max(0, int((end - start).total_seconds() // 60))
    except ValueError:
        return 0


def symbol_display(symbol: str | None) -> str:
    if not symbol:
        return "BTC-USDT-SWAP"
    if "USDT" in symbol.upper():
        return symbol
    return f"{symbol}-USDT-SWAP"


def request_owner(request: Any) -> str:
    """Login-account scope for character cards (header or ?owner=)."""
    try:
        header = request.headers.get(OWNER_HEADER) or request.headers.get(OWNER_HEADER.lower())
    except Exception:
        header = None
    if header and str(header).strip():
        return str(header).strip()
    try:
        q = request.query_params.get("owner")
    except Exception:
        q = None
    return str(q or "").strip()
