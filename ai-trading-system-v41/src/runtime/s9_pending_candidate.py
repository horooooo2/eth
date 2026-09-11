"""S9 pending candidate lifecycle.

Holds one immutable Alpha CANDIDATE that was blocked only by a recoverable
market-readiness code, so the next READY tick can enter PRE_S4 without
re-running evaluate_entry. Not stored in context["s9"] (SAME_CLOSED_CANDLE
ticks overwrite that payload).
"""

from __future__ import annotations

import copy
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, Mapping, Optional

S9_PENDING_TTL_SECONDS = 20.0

S9_TRANSIENT_MARKET_BLOCKERS = frozenset(
    {
        "MARKET_DATA_STALE",
        "MARKET_DATA_NOT_READY",
    }
)

_OPENING_SKIP_PURPOSE = frozenset(
    {"stop_loss", "take_profit", "reduce_only", "exit"}
)
_TERMINAL_ORDER_STATUS = frozenset(
    {"CANCELLED", "REJECTED", "EXPIRED", "FILLED", "STRATEGY_SWITCH_CANCELLED"}
)


@dataclass(frozen=True)
class PendingS9Candidate:
    signal_key: str
    closed_1m_id: int
    symbol: str
    direction: str
    direction_state: str
    entry_mode: str
    payload: Dict[str, Any]
    entry_reference: float
    stop_price: float
    structure_snapshot: Dict[str, Any]
    created_at: datetime
    expires_at: datetime


def pending_ttl_seconds(config: Mapping[str, Any]) -> float:
    cfg = (config or {}).get("S9_high_frequency_momentum") or {}
    try:
        ttl = float(cfg.get("ttl_seconds") or S9_PENDING_TTL_SECONDS)
    except (TypeError, ValueError):
        return S9_PENDING_TTL_SECONDS
    if ttl <= 0:
        return S9_PENDING_TTL_SECONDS
    return ttl


def is_transient_market_block_only(extra_block: Optional[Iterable[str]]) -> bool:
    codes = [str(c).strip() for c in (extra_block or []) if str(c).strip()]
    if not codes:
        return False
    return all(c in S9_TRANSIENT_MARKET_BLOCKERS for c in codes)


def extra_block_drops_pending(extra_block: Optional[Iterable[str]]) -> bool:
    """Non-transient extra blocks (pause / S6 / …) invalidate the slot."""
    codes = [str(c).strip() for c in (extra_block or []) if str(c).strip()]
    if not codes:
        return False
    return any(c not in S9_TRANSIENT_MARKET_BLOCKERS for c in codes)


def snapshot_valid(pending: Optional[PendingS9Candidate]) -> bool:
    if pending is None:
        return False
    key = str(pending.signal_key or "").strip()
    if not key:
        return False
    try:
        closed_id = int(pending.closed_1m_id)
    except (TypeError, ValueError):
        return False
    if closed_id <= 0:
        return False
    direction = str(pending.direction or "").upper()
    if direction not in {"LONG", "SHORT"}:
        return False
    if not str(pending.entry_mode or "").strip():
        return False
    payload = pending.payload if isinstance(pending.payload, dict) else {}
    if str(payload.get("decision") or "") != "CANDIDATE":
        return False
    if str(payload.get("signal_key") or "").strip() != key:
        return False
    try:
        entry = float(pending.entry_reference or 0)
        stop = float(pending.stop_price or 0)
    except (TypeError, ValueError):
        return False
    if entry <= 0 or stop <= 0:
        return False
    return True


def expired(pending: Optional[PendingS9Candidate], *, now: Optional[datetime] = None) -> bool:
    if pending is None:
        return False
    current = now or datetime.now(timezone.utc)
    return current >= pending.expires_at


def build_pending(
    *,
    payload: Mapping[str, Any],
    closed_1m_id: int,
    symbol: str,
    ttl_seconds: float,
    now: Optional[datetime] = None,
) -> Optional[PendingS9Candidate]:
    snap = copy.deepcopy(dict(payload or {}))
    diag = dict(snap.get("diagnostics") or {})
    key = str(snap.get("signal_key") or "").strip()
    direction = str(snap.get("direction") or "").upper()
    entry_mode = str(snap.get("s9_entry_mode") or diag.get("s9_entry_mode") or "").strip()
    try:
        entry = float(snap.get("trigger_reference_price") or 0)
        stop = float(snap.get("stop_price") or 0)
        cid = int(closed_1m_id)
    except (TypeError, ValueError):
        return None
    created = now or datetime.now(timezone.utc)
    ttl = float(ttl_seconds if ttl_seconds and ttl_seconds > 0 else S9_PENDING_TTL_SECONDS)
    structure = {
        "stop_price": stop,
        "structure_method": diag.get("structure_method") or diag.get("s9_structure_method"),
        "s9_atr14": diag.get("s9_atr14"),
        "structure_invalidation_price": diag.get("structure_invalidation_price"),
    }
    pending = PendingS9Candidate(
        signal_key=key,
        closed_1m_id=cid,
        symbol=str(symbol or ""),
        direction=direction,
        direction_state=str(diag.get("s9_direction_state") or ""),
        entry_mode=entry_mode,
        payload=snap,
        entry_reference=entry,
        stop_price=stop,
        structure_snapshot=structure,
        created_at=created,
        expires_at=created + timedelta(seconds=ttl),
    )
    if not snapshot_valid(pending):
        return None
    return pending


def payload_for_resume(pending: PendingS9Candidate) -> Dict[str, Any]:
    return copy.deepcopy(pending.payload)


def is_opening_order_intent(item: Any) -> bool:
    if not isinstance(item, dict):
        return False
    if bool(item.get("reduce_only")):
        return False
    purpose = str(item.get("purpose") or item.get("order_purpose") or "").lower()
    if purpose in _OPENING_SKIP_PURPOSE:
        return False
    status = str(item.get("status") or "").upper()
    if status in _TERMINAL_ORDER_STATUS:
        return False
    return True


def has_owned_position(positions: Optional[Iterable[Any]]) -> bool:
    for pos in positions or []:
        data = pos if isinstance(pos, dict) else {}
        try:
            qty = float(data.get("quantity") or 0)
        except (TypeError, ValueError):
            qty = 0.0
        if qty > 0:
            return True
    return False


def has_pending_opening(
    *,
    pending_opening_orders: Any = 0,
    pending_order_intents: Optional[Iterable[Any]] = None,
    last_orders: Optional[Iterable[Any]] = None,
) -> bool:
    try:
        if int(pending_opening_orders or 0) > 0:
            return True
    except (TypeError, ValueError):
        pass
    for item in list(pending_order_intents or []) + list(last_orders or []):
        if is_opening_order_intent(item):
            return True
    return False
