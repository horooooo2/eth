"""Minimal position ownership registry (Phase D1).

Invariant: strategy switch does NOT transfer position ownership.
Exit management must use origin_strategy_id policies.
"""

from __future__ import annotations

import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class OwnedPosition:
    position_id: str
    symbol: str
    side: str
    quantity: float
    origin_strategy_id: str
    origin_trade_intent_id: str
    entry_risk_snapshot: Dict[str, Any] = field(default_factory=dict)
    stop_policy_snapshot: Dict[str, Any] = field(default_factory=dict)
    exit_policy_snapshot: Dict[str, Any] = field(default_factory=dict)
    status: str = "OPEN"
    opened_at: str = field(default_factory=_now_iso)
    closed_at: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "OwnedPosition":
        return cls(
            position_id=str(data.get("position_id") or ""),
            symbol=str(data.get("symbol") or ""),
            side=str(data.get("side") or ""),
            quantity=float(data.get("quantity") or 0.0),
            origin_strategy_id=str(data.get("origin_strategy_id") or ""),
            origin_trade_intent_id=str(data.get("origin_trade_intent_id") or ""),
            entry_risk_snapshot=dict(data.get("entry_risk_snapshot") or {}),
            stop_policy_snapshot=dict(data.get("stop_policy_snapshot") or {}),
            exit_policy_snapshot=dict(data.get("exit_policy_snapshot") or {}),
            status=str(data.get("status") or "OPEN"),
            opened_at=str(data.get("opened_at") or _now_iso()),
            closed_at=data.get("closed_at"),
            metadata=dict(data.get("metadata") or {}),
        )


class PositionOwnershipRegistry:
    def __init__(self) -> None:
        self.positions: Dict[str, OwnedPosition] = {}

    def clear(self) -> None:
        self.positions.clear()

    def load(self, rows: List[Dict[str, Any]]) -> None:
        self.clear()
        for row in rows:
            pos = OwnedPosition.from_dict(row)
            if pos.position_id and pos.status == "OPEN":
                self.positions[pos.position_id] = pos

    def open_from_fill(
        self,
        *,
        symbol: str,
        side: str,
        quantity: float,
        origin_strategy_id: str,
        origin_trade_intent_id: str,
        entry_risk_snapshot: Optional[Dict[str, Any]] = None,
        stop_policy_snapshot: Optional[Dict[str, Any]] = None,
        exit_policy_snapshot: Optional[Dict[str, Any]] = None,
        position_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> OwnedPosition:
        pos = OwnedPosition(
            position_id=position_id or str(uuid.uuid4()),
            symbol=symbol,
            side=side,
            quantity=float(quantity),
            origin_strategy_id=origin_strategy_id,
            origin_trade_intent_id=origin_trade_intent_id,
            entry_risk_snapshot=dict(entry_risk_snapshot or {}),
            stop_policy_snapshot=dict(stop_policy_snapshot or {}),
            exit_policy_snapshot=dict(exit_policy_snapshot or {}),
            status="OPEN",
            opened_at=_now_iso(),
            metadata=dict(metadata or {}),
        )
        self.positions[pos.position_id] = pos
        return pos

    def get(self, position_id: str) -> Optional[OwnedPosition]:
        return self.positions.get(position_id)

    def list_open(self, *, origin_strategy_id: Optional[str] = None) -> List[OwnedPosition]:
        out = []
        for p in self.positions.values():
            if p.status != "OPEN":
                continue
            if origin_strategy_id and p.origin_strategy_id != origin_strategy_id:
                continue
            out.append(p)
        return out

    def close(self, position_id: str) -> Optional[OwnedPosition]:
        pos = self.positions.get(position_id)
        if not pos:
            return None
        pos.status = "CLOSED"
        pos.closed_at = _now_iso()
        return pos

    def exit_owner_for(self, position_id: str) -> Optional[str]:
        """Who manages exits — always origin strategy, never current active."""
        pos = self.positions.get(position_id)
        return pos.origin_strategy_id if pos else None
