"""Trade intent lifecycle for paper trading."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from uuid import uuid4

STATUS_CREATED = "CREATED"
STATUS_PENDING_RISK = "PENDING_RISK"
STATUS_RISK_APPROVED = "RISK_APPROVED"
STATUS_RISK_REJECTED = "RISK_REJECTED"
STATUS_EXECUTED = "EXECUTED"
STATUS_EXPIRED = "EXPIRED"

_ALLOWED = {
    STATUS_CREATED: {STATUS_PENDING_RISK, STATUS_EXPIRED},
    STATUS_PENDING_RISK: {STATUS_RISK_APPROVED, STATUS_RISK_REJECTED, STATUS_EXPIRED},
    STATUS_RISK_APPROVED: {STATUS_EXECUTED, STATUS_EXPIRED},
    STATUS_RISK_REJECTED: set(),
    STATUS_EXECUTED: set(),
    STATUS_EXPIRED: set(),
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class TradeIntent:
    """Lifecycle object from decision creation through fill or reject."""

    intent_id: str
    decision: Any
    symbol: str
    direction: str
    created_at: str
    expires_at: str
    status: str = STATUS_CREATED
    risk_result: Any = None
    execution_result: Optional[dict[str, Any]] = None
    entry_price_hint: float = 0.0
    atr: float = 0.0
    leverage: float = 3.0

    @classmethod
    def create(
        cls,
        decision: Any,
        symbol: str,
        direction: str,
        *,
        ttl_seconds: int = 60,
        entry_price_hint: float = 0.0,
        atr: float = 0.0,
        leverage: float = 3.0,
        now: Optional[datetime] = None,
    ) -> TradeIntent:
        """Factory with UUID and expiry window."""
        stamp = now or datetime.now(timezone.utc)
        return cls(
            intent_id=str(uuid4()),
            decision=decision,
            symbol=symbol,
            direction=direction,
            created_at=stamp.isoformat(),
            expires_at=(stamp + timedelta(seconds=ttl_seconds)).isoformat(),
            status=STATUS_CREATED,
            entry_price_hint=entry_price_hint,
            atr=atr,
            leverage=leverage,
        )

    def is_expired(self, now: Optional[datetime] = None) -> bool:
        stamp = now or datetime.now(timezone.utc)
        return stamp >= datetime.fromisoformat(self.expires_at)

    def transition_to(self, new_status: str) -> None:
        allowed = _ALLOWED.get(self.status, set())
        if new_status not in allowed and new_status != self.status:
            raise ValueError(f"invalid transition {self.status} -> {new_status}")
        self.status = new_status

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        if hasattr(self.decision, "to_dict"):
            data["decision"] = self.decision.to_dict()
        if self.risk_result is not None and hasattr(self.risk_result, "to_dict"):
            data["risk_result"] = self.risk_result.to_dict()
        return data
