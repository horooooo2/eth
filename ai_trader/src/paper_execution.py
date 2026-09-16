"""Paper execution engine with simulated slippage and fees."""
from __future__ import annotations

import json
import random
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .risk_engine import MarketSnapshot
from .trade_intent import STATUS_RISK_APPROVED, TradeIntent


@dataclass
class ExecutionResult:
    """Simulated fill or reject outcome."""

    intent_id: str
    status: str
    entry_price: float
    position_size: float
    notional: float
    margin: float
    fees: float
    slippage_bps: float
    timestamp: str
    reject_reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class PaperExecutionEngine:
    """Fill risk-approved intents at mid ± slippage (no exchange)."""

    config_path: Path
    seed: int = 42
    config: dict[str, Any] = field(init=False)
    rng: random.Random = field(init=False)

    def __post_init__(self) -> None:
        self.config_path = Path(self.config_path)
        self.config = json.loads(self.config_path.read_text(encoding="utf-8"))
        self.rng = random.Random(self.seed)

    def execute(
        self,
        intent: TradeIntent,
        market: MarketSnapshot,
        now: datetime | None = None,
    ) -> ExecutionResult:
        """Simulate a market fill for an approved intent."""
        if now is None:
            if market.timestamp:
                now = datetime.fromisoformat(market.timestamp)
            else:
                now = datetime.now(timezone.utc)
        if intent.is_expired(now):
            intent.status = "EXPIRED"
            return ExecutionResult(
                intent_id=intent.intent_id,
                status="REJECTED",
                entry_price=0.0,
                position_size=0.0,
                notional=0.0,
                margin=0.0,
                fees=0.0,
                slippage_bps=0.0,
                timestamp=now.isoformat(),
                reject_reason="INTENT_EXPIRED",
            )
        if intent.status != STATUS_RISK_APPROVED:
            return ExecutionResult(
                intent_id=intent.intent_id,
                status="REJECTED",
                entry_price=0.0,
                position_size=0.0,
                notional=0.0,
                margin=0.0,
                fees=0.0,
                slippage_bps=0.0,
                timestamp=now.isoformat(),
                reject_reason="INVALID_STATUS",
            )

        exe = self.config.get("execution") or {}
        lo = float(exe.get("slippage_bps_min", 1.0))
        hi = float(exe.get("slippage_bps_max", 3.0))
        slippage_bps = self.rng.uniform(lo, hi)
        mid = float(market.price)
        if intent.direction == "LONG":
            entry = mid * (1.0 + slippage_bps / 10000.0)
        else:
            entry = mid * (1.0 - slippage_bps / 10000.0)

        risk = intent.risk_result
        notional = float(getattr(risk, "notional", 0.0))
        margin = float(getattr(risk, "margin", 0.0))
        size = notional / entry if entry > 0 else 0.0
        fee_rate = float(exe.get("taker_fee_rate", 0.0005))
        fees = notional * fee_rate
        result = ExecutionResult(
            intent_id=intent.intent_id,
            status="FILLED",
            entry_price=entry,
            position_size=size,
            notional=notional,
            margin=margin,
            fees=fees,
            slippage_bps=slippage_bps,
            timestamp=now.isoformat(),
        )
        intent.execution_result = result.to_dict()
        intent.status = "EXECUTED"
        return result
