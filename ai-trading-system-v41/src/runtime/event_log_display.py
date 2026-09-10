"""Derive POSITION/SYSTEM log category and Chinese user text.

Does not change trading decisions or persisted event_type / reason_code.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Mapping, Optional

from src.runtime.strategy_display_zh import (
    event_zh,
    reason_zh,
    status_zh,
    strategy_name_zh,
)

CATEGORY_POSITION = "POSITION"
CATEGORY_SYSTEM = "SYSTEM"

SYSTEM_EVENT_TYPES = {
    "STRATEGY_NO_TRADE",
    "STRATEGY_CANDIDATE",
    "STRATEGY_SELECTED",
    "S9_NO_TRADE",
    "S9_CANDIDATE",
    "S9_DIRECTION",
    "TRADE_INTENT_CREATED",
    "ORDER_INTENT_CREATED",
    "S9_TRADE_INTENT_CREATED",
    "S9_ORDER_INTENT_CREATED",
    "ENGINE_START",
    "ENGINE_STARTED",
    "ENGINE_PAUSE",
    "ENGINE_PAUSED",
    "ENGINE_LOCK",
    "S5_RISK_CHANGED",
    "S6_BLOCK",
    "S6_LOCK",
    "STARTUP_RECOVERY_STARTED",
    "STARTUP_RECOVERY_READY",
    "STARTUP_RECOVERY_FAILED",
    "RECONCILIATION_MATCHED",
    "S9_MARKET_DATA_CONNECTED",
    "S9_MARKET_DATA_DISCONNECTED",
    "S9_MARKET_DATA_CONNECTING",
    "S9_MARKET_DATA_DEGRADED",
    "S9_MARKET_DATA_READY",
    "S9_FEE_READY",
    "S9_FEE_UNAVAILABLE",
    "S9_PRESUBMIT_REJECTED",
    "S9_PRESUBMIT_PASSED",
    "S9_ORDERBOOK_STALE",
    "S9_TRADES_STALE",
    "S9_IMPLEMENTATION_NOT_READY",
    "S9_DEMO_PREFLIGHT_NOT_READY",
    "SYMBOL_OWNERSHIP_CONFLICT",
    "CONFIG_INVALID",
    "CONFIG_LOADED",
    "MARKET_DATA_CONNECTED",
    "MARKET_DATA_DISCONNECTED",
    "TRADE_INTENT_EXPIRED",
    "S9_TRADE_INTENT_EXPIRED",
    "RECONCILIATION_NOT_MATCHED",
}

POSITION_EVENT_TYPES = {
    "POSITION_OPENED",
    "POSITION_UPDATED",
    "POSITION_REDUCED",
    "POSITION_CLOSED",
    "OWNERSHIP_CREATED",
    "OWNERSHIP_UPDATED",
    "OWNERSHIP_RELEASED",
    "PROTECTIVE_STOP_CREATED",
    "PROTECTIVE_STOP_SUBMITTED",
    "PROTECTIVE_STOP_PLACED",
    "PROTECTIVE_STOP_ACTIVE",
    "PROTECTIVE_STOP_AMENDED",
    "PROTECTIVE_STOP_TRIGGERED",
    "PROTECTIVE_STOP_CANCEL_REQUESTED",
    "PROTECTIVE_STOP_CANCELLED",
    "PROTECTIVE_STOP_FAILED",
    "PROTECTIVE_STOP_CLEANUP_FAILED",
    "ORPHAN_PROTECTIVE_STOP",
    "ORPHAN_PROTECTIVE_STOP_CLEANUP_FAILED",
    "TAKE_PROFIT_TRIGGERED",
    "TIME_EXIT_TRIGGERED",
    "DIRECTION_FLIP_EXIT_TRIGGERED",
    "EXIT_SUBMITTED",
    "EXIT_PARTIALLY_FILLED",
    "EXIT_FILLED",
    "DUST_RESIDUAL_POSITION",
    "UNRESOLVED_DUST_POSITION",
    "POSITION_QTY_MISMATCH",
    "POSITION_SIDE_MISMATCH",
}

FILL_EVENT_TYPES = {
    "ORDER_PARTIALLY_FILLED",
    "ORDER_FILLED",
    "PARTIAL_FILLED",
    "PARTIALLY_FILLED",
    "FILLED",
    "EXIT_PARTIALLY_FILLED",
    "EXIT_FILLED",
}

OPENING_NO_FILL_TYPES = {
    "ORDER_SUBMITTED",
    "ORDER_REJECTED",
    "ORDER_CANCELLED",
    "ORDER_CANCEL_FAILED",
    "ORDER_CANCEL_REQUESTED",
    "ORDER_EXPIRED",
}

_QTY_KEYS = (
    "filled_quantity",
    "accFillSz",
    "cumFillSz",
    "fill_sz",
    "lastFillSz",
    "filled_contracts",
    "cumulative_filled_qty",
    "owned_contracts",
    "owned_remaining_contracts",
    "owned_qty",
    "covered_contracts",
)
_TARGET_KEYS = (
    "target_sz",
    "requested_contracts",
    "final_okx_sz",
    "okx_sz",
    "origSz",
    "sz",
    "intended_contracts",
    "target_contracts",
)


def _norm(value: Any) -> str:
    return str(value or "").strip()


def _details(event: Mapping[str, Any]) -> Dict[str, Any]:
    raw = event.get("details")
    return dict(raw) if isinstance(raw, dict) else {}


def _num(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if n != n:
        return None
    return n


def _fmt_qty(value: Optional[float]) -> str:
    if value is None:
        return ""
    if abs(value - int(value)) < 1e-9:
        return str(int(value))
    text = f"{value:.8f}".rstrip("0").rstrip(".")
    return text or "0"


def pick_qty(event: Mapping[str, Any], keys: Iterable[str] = _QTY_KEYS) -> Optional[float]:
    details = _details(event)
    for key in keys:
        n = _num(event.get(key))
        if n is not None:
            return n
        n = _num(details.get(key))
        if n is not None:
            return n
    return None


def canonical_instrument_id(symbol: Any) -> str:
    """Runtime-event identity only. Does not change market-adapter symbol contracts."""
    raw = _norm(symbol)
    if not raw:
        return ""
    compact = raw.upper().replace(" ", "")
    if compact in {"BTC-USDT-SWAP", "BTC/USDT:USDT", "BTCUSDT", "BTC-USDT", "BTC/USDT"}:
        return "BTC-USDT-SWAP"
    if compact.endswith("-SWAP"):
        return compact
    if "/" in compact:
        base = compact.split("/")[0]
        return f"{base}-USDT-SWAP"
    return raw


def display_symbol(symbol: Any) -> str:
    return canonical_instrument_id(symbol) or "—"


def has_real_position_id(event: Mapping[str, Any]) -> bool:
    pid = _norm(event.get("position_id") or _details(event).get("position_id"))
    if not pid:
        return False
    return pid.upper() not in {"NONE", "NULL", "N/A", "0", "-"}


def is_reduce_only(event: Mapping[str, Any]) -> bool:
    details = _details(event)
    flag = event.get("reduce_only")
    if flag is None:
        flag = details.get("reduce_only")
    if flag in {True, "true", "TRUE", 1, "1"}:
        return True
    purpose = _norm(event.get("purpose") or details.get("purpose")).lower()
    return purpose in {"exit", "take_profit", "time_exit", "stop_loss", "direction_flip"}


def filled_qty(event: Mapping[str, Any]) -> Optional[float]:
    return pick_qty(event, _QTY_KEYS)


def target_qty(event: Mapping[str, Any]) -> Optional[float]:
    return pick_qty(event, _TARGET_KEYS)


def classify_display_category(event: Mapping[str, Any]) -> str:
    et = _norm(event.get("event_type")).upper()
    fill = filled_qty(event)
    fill_pos = fill is not None and fill > 0
    if et in SYSTEM_EVENT_TYPES:
        return CATEGORY_SYSTEM
    if et in OPENING_NO_FILL_TYPES:
        if is_reduce_only(event):
            return CATEGORY_POSITION
        return CATEGORY_POSITION if fill_pos else CATEGORY_SYSTEM
    if et in FILL_EVENT_TYPES:
        if et in {"ORDER_FILLED", "FILLED", "EXIT_FILLED"}:
            return CATEGORY_POSITION
        if fill is None or fill > 0:
            return CATEGORY_POSITION
        return CATEGORY_SYSTEM
    if et in POSITION_EVENT_TYPES:
        return CATEGORY_POSITION
    if et == "RECONCILIATION_MISMATCH":
        return CATEGORY_POSITION if has_real_position_id(event) else CATEGORY_SYSTEM
    if has_real_position_id(event) and fill_pos:
        return CATEGORY_POSITION
    return CATEGORY_SYSTEM


def _reason_codes(event: Mapping[str, Any]) -> List[str]:
    codes = event.get("reason_codes")
    if isinstance(codes, str):
        codes = [p.strip() for p in codes.replace("|", ";").split(";") if p.strip()]
    if not isinstance(codes, (list, tuple)):
        code = _norm(event.get("reason_code"))
        return [code] if code else []
    out = []
    for item in codes:
        text = _norm(item)
        if text:
            out.append(text)
    if not out:
        code = _norm(event.get("reason_code"))
        if code:
            out.append(code)
    return out


def _strategy_label(event: Mapping[str, Any]) -> str:
    return strategy_name_zh(event.get("strategy_id"))


def _qty_line(filled: Optional[float], target: Optional[float]) -> str:
    ftxt = _fmt_qty(filled)
    ttxt = _fmt_qty(target)
    if ftxt and ttxt and ftxt != ttxt:
        return f"已成交 {ftxt} 张，目标 {ttxt} 张"
    if ftxt:
        return f"已成交 {ftxt} 张"
    if ttxt:
        return f"目标 {ttxt} 张"
    return ""


SYSTEM_HARD_BLOCKERS = {
    "ACCOUNT_CONTEXT_NOT_READY",
    "OWNER_NOT_READY",
    "CREDENTIAL_NOT_FOUND",
    "ACCOUNT_ENV_NOT_READY",
    "FEE_API_TIMEOUT",
    "FEE_API_ERROR",
    "FEE_RESPONSE_INVALID",
    "S9_COST_DATA_UNAVAILABLE",
    "S9_FEE_UNAVAILABLE",
    "S9_DATA_1M_STALE",
    "S9_DATA_5M_STALE",
    "S9_MARKET_DATA_DISCONNECTED",
    "S9_MARKET_DATA_CONNECTING",
    "S9_MARKET_DATA_DEGRADED",
    "MARKET_DATA_STALE",
    "MARKET_DATA_WARMING_UP",
    "S9_ORDERBOOK_STALE",
    "S9_TRADES_STALE",
    "S9_DATA_DEGRADED",
    "STARTUP_RECOVERY_FAILED",
    "EXECUTION_RECOVERY_FAILED",
    "EXECUTION_RECOVERY_PENDING",
    "RECONCILIATION_NOT_MATCHED",
    "RECONCILIATION_MISMATCH",
    "S9_IMPLEMENTATION_NOT_READY",
    "S9_DEMO_PREFLIGHT_NOT_READY",
    "ENGINE_OWNER_NOT_BOUND",
    "ALPHA_EXECUTION_USER_NOT_READY",
}


def format_no_trade_message(name: str, sym: str, codes: List[str]) -> str:
    reasons = [reason_zh(c) for c in codes]
    reason_block = "原因：\n" + "；\n".join(reasons) if reasons else ""
    if any(code in SYSTEM_HARD_BLOCKERS for code in codes):
        head = "系统尚未具备交易条件"
        return f"{head}\n{reason_block}".strip() if reason_block else head
    head = " · ".join([p for p in (name or "策略", sym, "本轮不交易") if p])
    return f"{head}\n{reason_block}".strip() if reason_block else head


def format_user_message(event: Mapping[str, Any]) -> str:
    et = _norm(event.get("event_type")).upper()
    name = _strategy_label(event)
    sym = display_symbol(event.get("symbol"))
    codes = _reason_codes(event)
    reasons = [reason_zh(c) for c in codes]
    reason_block = ""
    if reasons:
        reason_block = "原因：\n" + "；\n".join(reasons)
    fill = filled_qty(event)
    target = target_qty(event)
    qty_bit = _qty_line(fill, target)
    reduce = is_reduce_only(event)
    covered = pick_qty(event, ("covered_contracts", "sz", "owned_contracts"))

    if et in {"STRATEGY_NO_TRADE", "S9_NO_TRADE"}:
        return format_no_trade_message(name, sym, codes)

    if et == "ORDER_SUBMITTED":
        return "平仓订单已提交，等待成交" if reduce else "开仓订单已提交，等待成交"
    if et in {"ORDER_REJECTED", "ORDER_CANCELLED", "ORDER_EXPIRED"}:
        if reduce:
            if et == "ORDER_REJECTED":
                return "平仓订单已拒绝"
            if et == "ORDER_EXPIRED":
                return "平仓订单已过期"
            return "平仓订单已取消"
        if et == "ORDER_REJECTED":
            return "开仓订单已拒绝，未形成仓位"
        if et == "ORDER_EXPIRED":
            return "开仓订单已过期，未形成仓位"
        return "开仓订单已取消，未形成仓位"

    if et in {"ORDER_PARTIALLY_FILLED", "PARTIAL_FILLED", "PARTIALLY_FILLED", "EXIT_PARTIALLY_FILLED"}:
        prefix = "平仓部分成交" if reduce or et.startswith("EXIT") else "开仓部分成交"
        return f"{prefix}：{qty_bit}" if qty_bit else prefix

    if et in {"ORDER_FILLED", "FILLED", "EXIT_FILLED"}:
        if reduce or et.startswith("EXIT"):
            return f"平仓完成：共成交 {_fmt_qty(fill) or '—'} 张" if fill is not None else "平仓已成交"
        return f"仓位建立完成：共成交 {_fmt_qty(fill) or '—'} 张" if fill is not None else "仓位建立完成"

    if et == "POSITION_OPENED":
        return f"仓位已建立" + (f"：{_fmt_qty(fill)} 张" if fill is not None else "")
    if et == "POSITION_CLOSED":
        return "仓位已全部平仓"
    if et == "POSITION_REDUCED":
        return "仓位已减少" + (f"：剩余 {_fmt_qty(fill)} 张" if fill is not None else "")
    if et == "OWNERSHIP_RELEASED":
        return "仓位及关联订单已清理完成，交易对已释放"

    if et in {"PROTECTIVE_STOP_ACTIVE", "PROTECTIVE_STOP_CREATED", "PROTECTIVE_STOP_PLACED", "PROTECTIVE_STOP_SUBMITTED"}:
        if covered is not None:
            return f"保护止损已生效：覆盖 {_fmt_qty(covered)} 张仓位"
        return "保护止损已建立"
    if et == "PROTECTIVE_STOP_AMENDED":
        return f"保护止损覆盖数量已调整：{_fmt_qty(covered)} 张" if covered is not None else "保护止损覆盖数量已调整"
    if et == "PROTECTIVE_STOP_TRIGGERED":
        return "保护止损已触发"
    if et in {"PROTECTIVE_STOP_CANCEL_REQUESTED", "PROTECTIVE_STOP_CANCELLED"}:
        return "仓位已平，正在清理遗留保护止损" if et.endswith("REQUESTED") else "保护止损已取消"

    if et == "TAKE_PROFIT_TRIGGERED":
        return "达到 1.5R 止盈条件，正在执行平仓"
    if et == "TIME_EXIT_TRIGGERED":
        return "持仓已达到最长持有时间，正在执行平仓"
    if et == "DIRECTION_FLIP_EXIT_TRIGGERED":
        return "5分钟方向发生反转，正在执行平仓"

    if et == "RECONCILIATION_MISMATCH":
        local = pick_qty(event, ("owned_contracts", "local_qty", "local_contracts"))
        exch = pick_qty(event, ("exchange_qty", "exchange_contracts", "exchange_net_position_contracts"))
        if local is not None and exch is not None:
            return f"仓位数量与交易所不一致：本地 {_fmt_qty(local)} 张，交易所 {_fmt_qty(exch)} 张"
        return "仓位数量与交易所不一致" if has_real_position_id(event) else "当前交易状态对账未一致"
    if et == "RECONCILIATION_MATCHED":
        return "交易状态对账一致"
    if et == "SYMBOL_OWNERSHIP_CONFLICT":
        return "当前交易对仍由其他策略持有，已阻止新的开仓"
    if et == "S9_ORDERBOOK_STALE":
        return "盘口数据已过期"

    title = event_zh(et)
    parts = [title]
    if name:
        parts.append(name)
    if sym and sym != "—":
        parts.append(sym)
    head = " · ".join(parts)
    if reason_block:
        return f"{head}\n{reason_block}"
    decision = _norm(event.get("decision"))
    if decision and decision.upper() not in {"", "NONE"}:
        zh = status_zh(decision)
        if zh and zh != head:
            return f"{head} · {zh}"
    return head


def annotate_event(event: Mapping[str, Any]) -> Dict[str, Any]:
    row = dict(event)
    row["symbol_display"] = display_symbol(row.get("symbol"))
    row["display_category"] = classify_display_category(row)
    row["display_message"] = format_user_message(row)
    return row


def annotate_events(events: Iterable[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    return [annotate_event(ev) for ev in events]
