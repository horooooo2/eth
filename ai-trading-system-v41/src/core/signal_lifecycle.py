"""TradeIntent lifecycle state machine."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Mapping, MutableMapping, Optional, Set

_EPS = 1e-12

ACTIVE_PATH = ("CREATED", "WAITING_EXECUTION_CONFIRMATION", "CONFIRMED", "EXECUTED")
TERMINAL: Set[str] = {
    "EXPIRED",
    "PRICE_DRIFT_INVALID",
    "CONDITION_INVALID",
    "S4_REJECTED",
    "RISK_REJECTED",
    "COST_REJECTED",
    "SAFETY_REJECTED",
    "ACTIVE_STRATEGY_MISMATCH",
    "STRATEGY_SWITCH_INVALIDATED",
    "EXECUTED",
}

# Non-terminal states that must be invalidated when active alpha strategy changes
SWITCH_INVALIDATABLE: Set[str] = {
    "CREATED",
    "WAITING_EXECUTION_CONFIRMATION",
    "CONFIRMED",
}

ALLOWED_TRANSITIONS: Dict[str, Set[str]] = {
    "CREATED": {"WAITING_EXECUTION_CONFIRMATION", *TERMINAL},
    "WAITING_EXECUTION_CONFIRMATION": {"CONFIRMED", *TERMINAL - {"EXECUTED"}},
    "CONFIRMED": {"EXECUTED", *TERMINAL - {"EXECUTED"}},
    "EXECUTED": set(),
}
for t in TERMINAL - {"EXECUTED"}:
    ALLOWED_TRANSITIONS.setdefault(t, set())


@dataclass
class TradeIntent:
    intent_id: str
    strategy_id: str
    symbol: str
    direction: str
    created_at: datetime
    expires_at: datetime
    reference_price: float
    reference_atr: float
    signal_snapshot: Dict[str, Any] = field(default_factory=dict)
    status: str = "CREATED"
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["created_at"] = self.created_at.isoformat()
        d["expires_at"] = self.expires_at.isoformat()
        return d


class SignalLifecycleManager:
    def __init__(self, config: Mapping[str, Any]) -> None:
        self.config = config
        self.lifecycle = config.get("signal_lifecycle", {})
        self.policy = self.lifecycle.get("strategy_policy", {})
        self.intents: Dict[str, TradeIntent] = {}

    def get_policy(self, strategy_id: str) -> Dict[str, Any]:
        return dict(self.policy.get(strategy_id, {}))

    def create_intent(
        self,
        *,
        strategy_id: str,
        symbol: str,
        direction: str,
        reference_price: float,
        reference_atr: float,
        signal_snapshot: Optional[Dict[str, Any]] = None,
        created_at: Optional[datetime] = None,
        intent_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> TradeIntent:
        policy = self.get_policy(strategy_id)
        expiry_seconds = float(policy.get("expiry_seconds", 120))
        now = created_at or datetime.now(timezone.utc)
        intent = TradeIntent(
            intent_id=intent_id or str(uuid.uuid4()),
            strategy_id=strategy_id,
            symbol=symbol,
            direction=direction,
            created_at=now,
            expires_at=now + timedelta(seconds=expiry_seconds),
            reference_price=float(reference_price),
            reference_atr=float(reference_atr),
            signal_snapshot=dict(signal_snapshot or {}),
            status="CREATED",
            metadata=dict(metadata or {}),
        )
        self.intents[intent.intent_id] = intent
        return intent

    def derived_fields(
        self,
        intent: TradeIntent,
        current_mid: float,
        now: Optional[datetime] = None,
    ) -> Dict[str, float]:
        now = now or datetime.now(timezone.utc)
        age = (now - intent.created_at).total_seconds()
        drift_bps = abs(current_mid - intent.reference_price) / max(intent.reference_price, _EPS) * 10000.0
        drift_atr = abs(current_mid - intent.reference_price) / max(intent.reference_atr, _EPS)
        return {
            "signal_age_seconds": age,
            "price_drift_bps": drift_bps,
            "price_drift_atr_fraction": drift_atr,
        }

    def validate_intent(
        self,
        intent: TradeIntent,
        current_mid: float,
        current_atr: Optional[float] = None,
        *,
        original_signal_conditions_still_valid: bool = True,
        now: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        """Return validity result; may transition intent to a terminal invalid state."""
        if intent.status in TERMINAL and intent.status != "EXECUTED":
            return {"valid": False, "reason": intent.status, "fields": {}}

        policy = self.get_policy(intent.strategy_id)
        fields = self.derived_fields(intent, current_mid, now=now)
        mapping = self.lifecycle.get("terminal_reason_mapping", {})

        if fields["signal_age_seconds"] > float(policy.get("expiry_seconds", 120)):
            reason = mapping.get("signal_age_seconds_exceeded", "EXPIRED")
            self.transition(intent, reason)
            return {"valid": False, "reason": reason, "fields": fields}

        if fields["price_drift_bps"] > float(policy.get("max_price_drift_bps", 30)):
            reason = mapping.get("price_drift_bps_exceeded", "PRICE_DRIFT_INVALID")
            self.transition(intent, reason)
            return {"valid": False, "reason": reason, "fields": fields}

        if fields["price_drift_atr_fraction"] > float(policy.get("max_price_drift_atr_fraction", 0.25)):
            reason = mapping.get("price_drift_atr_fraction_exceeded", "PRICE_DRIFT_INVALID")
            self.transition(intent, reason)
            return {"valid": False, "reason": reason, "fields": fields}

        if not original_signal_conditions_still_valid:
            reason = mapping.get("signal_revalidation_failed", "CONDITION_INVALID")
            self.transition(intent, reason)
            return {"valid": False, "reason": reason, "fields": fields}

        _ = current_atr  # reserved for future absolute ATR checks
        return {"valid": True, "reason": None, "fields": fields}

    def transition(self, intent: TradeIntent, new_status: str) -> TradeIntent:
        if intent.status == new_status:
            return intent
        allowed = ALLOWED_TRANSITIONS.get(intent.status, set())
        # Allow force-to-terminal from any non-terminal for reject paths
        if new_status not in allowed and new_status not in TERMINAL:
            raise ValueError(f"Illegal transition {intent.status} -> {new_status}")
        if intent.status in TERMINAL and intent.status != "EXECUTED":
            return intent
        intent.status = new_status
        self.intents[intent.intent_id] = intent
        return intent

    def get(self, intent_id: str) -> Optional[TradeIntent]:
        return self.intents.get(intent_id)

    def invalidate_strategy_intents(
        self,
        strategy_id: str,
        *,
        reason: str = "ACTIVE_STRATEGY_CHANGED",
    ) -> List[str]:
        """Mark non-terminal intents of strategy_id as STRATEGY_SWITCH_INVALIDATED."""
        invalidated: List[str] = []
        for intent in list(self.intents.values()):
            if intent.strategy_id != strategy_id:
                continue
            if intent.status not in SWITCH_INVALIDATABLE:
                continue
            self.transition(intent, "STRATEGY_SWITCH_INVALIDATED")
            intent.metadata["terminal"] = True
            intent.metadata["terminal_reason"] = reason
            intent.metadata["invalidation_code"] = "STRATEGY_SWITCH_INVALIDATED"
            invalidated.append(intent.intent_id)
        return invalidated

    def list_non_terminal(self, strategy_id: Optional[str] = None) -> List[TradeIntent]:
        out: List[TradeIntent] = []
        for intent in self.intents.values():
            if intent.status in TERMINAL:
                continue
            if strategy_id and intent.strategy_id != strategy_id:
                continue
            out.append(intent)
        return out
