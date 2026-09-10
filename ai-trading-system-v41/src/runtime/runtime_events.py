"""Structured runtime event log. Observability only — never changes trading decisions."""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

SECRET_KEYS = {
    "api_secret",
    "apisecret",
    "secret",
    "passphrase",
    "api_passphrase",
    "authorization",
    "cookie",
    "jwt",
    "access_token",
    "refresh_token",
    "id_token",
    "session",
    "session_cookie",
    "apikey",
    "api_key",
    "password",
    "credential",
    "credentials",
    "private_key",
}

SKIP_BUS_TYPES = {
    "heartbeat",
    "strategy.health.updated",
    "qa.execution_report",
    "console.mode.changed",
}

TRADE_EVENT_TYPES = {
    "TRADE_INTENT_CREATED",
    "ORDER_INTENT_CREATED",
    "ORDER_SUBMITTED",
    "ORDER_PARTIALLY_FILLED",
    "ORDER_FILLED",
    "ORDER_CANCEL_REQUESTED",
    "ORDER_CANCELLED",
    "ORDER_CANCEL_FAILED",
    "ORDER_REJECTED",
    "PROTECTIVE_STOP_SUBMITTED",
    "PROTECTIVE_STOP_ACTIVE",
    "PROTECTIVE_STOP_AMENDED",
    "PROTECTIVE_STOP_CANCELLED",
    "PROTECTIVE_STOP_FAILED",
    "S9_DIRECTION",
    "S9_NO_TRADE",
    "S9_CANDIDATE",
    "S9_TRADE_INTENT_CREATED",
    "S9_ORDER_INTENT_CREATED",
    "POSITION_OPENED",
    "POSITION_REDUCED",
    "POSITION_CLOSED",
    "S6_BLOCK",
    "S6_LOCK",
    "RECONCILIATION_MATCHED",
    "RECONCILIATION_MISMATCH",
    "STARTUP_RECOVERY_STARTED",
    "STARTUP_RECOVERY_READY",
    "STARTUP_RECOVERY_FAILED",
}

DEDUPE_EVENT_TYPES = {"STRATEGY_NO_TRADE", "S9_NO_TRADE"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


EVENT_ID_NAMESPACES = ("py_", "node_", "node:")


def new_event_id() -> str:
    return f"py_{uuid.uuid4()}"


def has_event_id_namespace(event_id: str) -> bool:
    raw = _norm(event_id)
    return raw.startswith(EVENT_ID_NAMESPACES)


def resolve_event_id(event_id: Any, *, allow_injected: bool = False) -> str:
    raw = _norm(event_id)
    if not raw:
        return new_event_id()
    if has_event_id_namespace(raw):
        return raw
    if allow_injected:
        return raw
    return new_event_id()


def _canon_qty(value: Any) -> str:
    if value is None or value == "":
        return ""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return _norm(value)
    if number != number:  # NaN
        return ""
    if number == int(number):
        return str(int(number))
    return str(number)


def _norm(value: Any) -> str:
    return str(value or "").strip()


def normalize_reason_codes(codes: Any) -> List[str]:
    if codes is None:
        return []
    if isinstance(codes, str):
        raw = [p.strip() for p in re.split(r"[|,;]", codes) if p.strip()]
        return sorted(set(raw))
    if isinstance(codes, (list, tuple, set)):
        return sorted({str(x).strip() for x in codes if str(x).strip()})
    return []


def reason_signature(codes: Any) -> str:
    return "|".join(normalize_reason_codes(codes))


def no_trade_key(
    *,
    strategy_id: str,
    symbol: str,
    source_closed_candle_timestamp: str,
    decision: str,
    reason_codes: Any,
) -> str:
    return "|".join(
        [
            _norm(strategy_id).upper(),
            _norm(symbol).upper(),
            _norm(source_closed_candle_timestamp),
            _norm(decision).upper(),
            reason_signature(reason_codes),
        ]
    )


def redact_secrets(value: Any) -> Any:
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            kn = str(key).strip().lower().replace("-", "_")
            if kn in SECRET_KEYS or kn.endswith("_secret") or kn.endswith("_passphrase"):
                out[key] = "[REDACTED]"
            else:
                out[key] = redact_secrets(item)
        return out
    if isinstance(value, list):
        return [redact_secrets(v) for v in value]
    return value


def _severity(event_type: str, decision: str = "") -> str:
    if event_type in {"S6_LOCK", "STARTUP_RECOVERY_FAILED", "ORDER_REJECTED", "PROTECTIVE_STOP_FAILED"}:
        return "error"
    if event_type in {
        "S6_BLOCK",
        "ORDER_CANCEL_FAILED",
        "RECONCILIATION_MISMATCH",
        "STRATEGY_NO_TRADE",
    }:
        return "warn"
    if event_type in TRADE_EVENT_TYPES or decision == "ALLOW":
        return "success" if event_type.endswith("FILLED") or event_type.endswith("OPENED") else "info"
    return "info"


def _message(event_type: str, row: Dict[str, Any]) -> str:
    from src.runtime.strategy_display_zh import event_zh, reason_zh, status_zh

    sid = row.get("strategy_id") or "—"
    sym = row.get("symbol") or "—"
    decision = status_zh(row.get("decision") or "") or (row.get("decision") or "")
    codes = normalize_reason_codes(row.get("reason_codes"))
    extra = "；".join(reason_zh(c) for c in codes) if codes else ""
    title = event_zh(event_type)
    if extra:
        return f"{title} · {sid} · {sym} · {extra}"
    if decision:
        return f"{title} · {sid} · {sym} · {decision}"
    return f"{title} · {sid} · {sym}"


def map_bus_event(event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Turn an EventBus payload into one structured runtime event, or None to skip."""
    bus_type = _norm(event.get("type"))
    if not bus_type or bus_type in SKIP_BUS_TYPES:
        return None
    payload = dict(event.get("payload") or {})
    if not isinstance(payload, dict):
        payload = {}
    payload = redact_secrets(payload)

    event_type = ""
    decision = _norm(payload.get("decision") or payload.get("result") or payload.get("last_decision"))
    status = _norm(payload.get("status")).upper()
    reason_codes = payload.get("reason_codes") or payload.get("reason_code") or []

    if bus_type == "engine.status":
        state = _norm(payload.get("state")).upper()
        event_type = {
            "RUNNING": "ENGINE_START",
            "PAUSED": "ENGINE_PAUSE",
            "LOCKED": "ENGINE_LOCK",
        }.get(state, "")
        if not event_type:
            return None
    elif bus_type in {"strategy.active.changed", "strategy.switch"}:
        event_type = "STRATEGY_SELECTED"
    elif bus_type == "strategy.decision":
        decision = decision or "NO_TRADE"
        sid = _norm(payload.get("strategy_id") or payload.get("origin_strategy_id")).upper()
        if sid == "S9":
            if decision == "ALLOW" or decision == "CANDIDATE":
                event_type = "S9_CANDIDATE"
            elif str(payload.get("event_subtype") or "") == "DIRECTION":
                event_type = "S9_DIRECTION"
            else:
                event_type = "S9_NO_TRADE"
        elif decision == "ALLOW":
            event_type = "STRATEGY_CANDIDATE"
        else:
            event_type = "STRATEGY_NO_TRADE"
    elif bus_type == "trade_intent.created":
        sid = _norm(payload.get("strategy_id") or payload.get("origin_strategy_id")).upper()
        event_type = "S9_TRADE_INTENT_CREATED" if sid == "S9" else "TRADE_INTENT_CREATED"
    elif bus_type == "order_intent.created":
        sid = _norm(payload.get("strategy_id") or payload.get("origin_strategy_id")).upper()
        event_type = "S9_ORDER_INTENT_CREATED" if sid == "S9" else "ORDER_INTENT_CREATED"
    elif bus_type == "order_intent.updated":
        event_type = {
            "SUBMITTED": "ORDER_SUBMITTED",
            "PARTIAL": "ORDER_PARTIALLY_FILLED",
            "PARTIALLY_FILLED": "ORDER_PARTIALLY_FILLED",
            "FILLED": "ORDER_FILLED",
            "CANCEL_REQUESTED": "ORDER_CANCEL_REQUESTED",
            "CANCELLED": "ORDER_CANCELLED",
            "CANCELED": "ORDER_CANCELLED",
            "STRATEGY_SWITCH_CANCELLED": "ORDER_CANCELLED",
            "CANCEL_FAILED": "ORDER_CANCEL_FAILED",
            "REJECTED": "ORDER_REJECTED",
            "RISK_REJECTED": "ORDER_REJECTED",
            "GATEWAY_ERROR": "ORDER_REJECTED",
        }.get(status, "")
        if not event_type:
            return None
    elif bus_type == "position.opened":
        event_type = "POSITION_OPENED"
    elif bus_type == "position.reduced":
        event_type = "POSITION_REDUCED"
    elif bus_type == "position.closed":
        event_type = "POSITION_CLOSED"
    elif bus_type == "risk.budget.updated":
        event_type = "S5_RISK_CHANGED"
    elif bus_type == "system.safety.updated":
        level = int(payload.get("level") or 0)
        if level >= 3:
            event_type = "S6_LOCK"
        elif level >= 2:
            event_type = "S6_BLOCK"
        else:
            return None
    elif bus_type == "reconciliation.matched":
        event_type = "RECONCILIATION_MATCHED"
    elif bus_type == "reconciliation.mismatch":
        event_type = "RECONCILIATION_MISMATCH"
    elif bus_type.startswith("protective_stop."):
        event_type = {
            "protective_stop.submitted": "PROTECTIVE_STOP_SUBMITTED",
            "protective_stop.active": "PROTECTIVE_STOP_ACTIVE",
            "protective_stop.amended": "PROTECTIVE_STOP_AMENDED",
            "protective_stop.cancelled": "PROTECTIVE_STOP_CANCELLED",
            "protective_stop.failed": "PROTECTIVE_STOP_FAILED",
        }.get(bus_type, "")
    elif bus_type.startswith("startup_recovery."):
        event_type = {
            "startup_recovery.started": "STARTUP_RECOVERY_STARTED",
            "startup_recovery.ready": "STARTUP_RECOVERY_READY",
            "startup_recovery.failed": "STARTUP_RECOVERY_FAILED",
        }.get(bus_type, "")
    else:
        return None

    if not event_type:
        return None

    codes = normalize_reason_codes(reason_codes)
    candle = ""
    market_data = payload.get("market_data")
    if isinstance(market_data, dict):
        candle = _norm(market_data.get("latest_closed_candle_at"))
    candle = candle or _norm(
        payload.get("source_closed_candle_timestamp")
        or payload.get("closed_candle_at")
        or payload.get("structure_candle_timestamp")
    )
    row = {
        "event_id": _norm(event.get("event_id")) or new_event_id(),
        "occurred_at": _norm(event.get("timestamp") or payload.get("ts")) or _now_iso(),
        "event_type": event_type,
        "severity": _severity(event_type, decision),
        "strategy_id": _norm(
            payload.get("strategy_id")
            or payload.get("origin_strategy_id")
            or payload.get("active_strategy")
            or payload.get("active_strategy_id")
            or payload.get("new_strategy_id")
        ),
        "symbol": _norm(payload.get("symbol") or payload.get("instId")),
        "direction": _norm(payload.get("direction") or payload.get("direction_candidate") or payload.get("side") or payload.get("position_side")),
        "decision": decision,
        "reason_code": codes[0] if codes else _norm(payload.get("reason_code")),
        "reason_codes": codes,
        "source_closed_candle_timestamp": candle,
        "trade_intent_id": _norm(payload.get("trade_intent_id") or payload.get("intent_id") or payload.get("origin_trade_intent_id")),
        "order_intent_id": _norm(payload.get("order_intent_id")),
        "position_id": _norm(payload.get("position_id")),
        "signal_key": _norm(payload.get("signal_key")),
        "details": payload,
    }
    row["message"] = _norm(payload.get("message")) or _message(event_type, row)
    row["reason_signature"] = reason_signature(codes)
    if event_type in DEDUPE_EVENT_TYPES:
        row["no_trade_key"] = no_trade_key(
            strategy_id=row["strategy_id"],
            symbol=row["symbol"],
            source_closed_candle_timestamp=row["source_closed_candle_timestamp"],
            decision=row["decision"] or "NO_TRADE",
            reason_codes=codes,
        )
    else:
        row["no_trade_key"] = ""
    return row


class RuntimeEventRecorder:
    """Persist mapped bus events. Dedupe is persistence-only."""

    def __init__(self, store: Any) -> None:
        self.store = store
        self._last_engine_state: Optional[str] = None
        self._last_s5_sig: Optional[str] = None
        self._intent_status: Dict[str, str] = {}
        self._order_status: Dict[str, str] = {}

    def persist_bus_event(self, event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        try:
            return self._persist(event)
        except Exception:
            return None

    def persist_direct(
        self,
        row: Dict[str, Any],
        *,
        allow_injected_event_id: bool = False,
    ) -> Optional[Dict[str, Any]]:
        """Insert an already-mapped structured event (Node ingest / tests)."""
        data = dict(row)
        data["event_id"] = resolve_event_id(data.get("event_id"), allow_injected=allow_injected_event_id)
        data["occurred_at"] = _norm(data.get("occurred_at")) or _now_iso()
        data["created_at"] = _now_iso()
        data["reason_codes"] = normalize_reason_codes(data.get("reason_codes") or data.get("reason_codes_json"))
        data["reason_signature"] = reason_signature(data["reason_codes"])
        data["details"] = redact_secrets(data.get("details") or {})
        et = _norm(data.get("event_type"))
        if et in DEDUPE_EVENT_TYPES and not data.get("no_trade_key"):
            data["no_trade_key"] = no_trade_key(
                strategy_id=_norm(data.get("strategy_id")),
                symbol=_norm(data.get("symbol")),
                source_closed_candle_timestamp=_norm(data.get("source_closed_candle_timestamp")),
                decision=_norm(data.get("decision")) or "NO_TRADE",
                reason_codes=data["reason_codes"],
            )
        return self.store.insert_runtime_event(data)

    def _persist(self, event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        bus_type = _norm(event.get("type"))
        payload = event.get("payload") or {}
        if bus_type == "engine.status":
            state = _norm(payload.get("state")).upper()
            if not state or state == self._last_engine_state:
                return None
            self._last_engine_state = state
        if bus_type == "risk.budget.updated":
            used = payload.get("portfolio_risk_used_pct_equity")
            if used is None:
                used = (payload.get("portfolio") or {}).get("risk_used")
            limit = payload.get("portfolio_risk_budget_pct_equity") or payload.get("portfolio_risk_limit_pct_equity")
            sig = f"{used}|{limit}"
            if sig == self._last_s5_sig:
                return None
            self._last_s5_sig = sig
        if bus_type == "trade_intent.created":
            iid = _norm(payload.get("intent_id") or payload.get("trade_intent_id"))
            status = _norm(payload.get("status")).upper() or "CREATED"
            if iid and self._intent_status.get(iid) == status:
                return None
            if iid:
                self._intent_status[iid] = status
        if bus_type == "order_intent.updated":
            oid = _norm(payload.get("order_intent_id"))
            status = _norm(payload.get("status")).upper()
            fill = _canon_qty(
                payload.get("accFillSz")
                or payload.get("filled_contracts")
                or payload.get("cumulative_filled_qty")
                or payload.get("filled_quantity")
            )
            fill_id = _norm(payload.get("fill_id") or payload.get("exchange_fill_id") or payload.get("tradeId"))
            sig = f"{status}|{fill_id or fill}"
            if oid and status and self._order_status.get(oid) == sig:
                return None
            if oid and status:
                self._order_status[oid] = sig

        mapped = map_bus_event(event)
        if not mapped:
            return None
        mapped["created_at"] = _now_iso()
        return self.store.insert_runtime_event(mapped)

    def list_events(self, **kwargs: Any) -> List[Dict[str, Any]]:
        return self.store.list_runtime_events(**kwargs)
