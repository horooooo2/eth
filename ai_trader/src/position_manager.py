"""Paper position tracking with stop/take-profit and MFE/MAE."""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional
from uuid import uuid4

from .paper_execution import ExecutionResult
from .risk_engine import MarketSnapshot, PortfolioState
from .trade_intent import TradeIntent


def _iso(dt: Optional[datetime] = None) -> str:
    return (dt or datetime.now(timezone.utc)).isoformat()


@dataclass
class Position:
    """Simulated open or closed position."""

    position_id: str
    decision_id: str
    intent_id: str
    symbol: str
    side: str
    leverage: float
    margin: float
    notional: float
    entry_price: float
    stop_loss: float
    take_profit: Optional[float]
    status: str
    entry_time: str
    exit_time: Optional[str] = None
    exit_price: Optional[float] = None
    exit_reason: Optional[str] = None
    realized_pnl: float = 0.0
    fees: float = 0.0
    mfe: float = 0.0
    mae: float = 0.0
    psychology_at_entry: dict[str, float] = field(default_factory=dict)
    psychology_at_exit: dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class PositionManager:
    """Track paper positions and emit closes on stop/TP hits."""

    config_path: Path
    starting_equity: float = 20000.0
    config: dict[str, Any] = field(init=False)
    positions: list[Position] = field(default_factory=list)
    cash: float = field(init=False)
    daily_pnl: float = 0.0
    daily_start_equity: float = field(init=False)
    consecutive_stop_losses: int = 0
    loss_streak_paused_until: Optional[str] = None

    def __post_init__(self) -> None:
        self.config_path = Path(self.config_path)
        self.config = json.loads(self.config_path.read_text(encoding="utf-8"))
        start = float(
            self.config.get("account", {}).get("starting_equity", self.starting_equity)
        )
        self.starting_equity = start
        self.cash = start
        self.daily_start_equity = start

    def open_positions(self) -> list[Position]:
        return [p for p in self.positions if p.status == "OPEN"]

    def closed_positions(self) -> list[Position]:
        return [p for p in self.positions if p.status == "CLOSED"]

    def get_portfolio_state(self, mark_price: Optional[float] = None) -> PortfolioState:
        equity = self.cash
        for pos in self.open_positions():
            equity += pos.margin
            if mark_price is not None:
                equity += self._unrealized_pnl(pos, mark_price)
        return PortfolioState(
            equity=equity,
            cash=self.cash,
            open_position_count=len(self.open_positions()),
            daily_pnl=self.daily_pnl,
            daily_start_equity=self.daily_start_equity,
            consecutive_stop_losses=self.consecutive_stop_losses,
            loss_streak_paused_until=self.loss_streak_paused_until,
        )

    def open_position(
        self,
        intent: TradeIntent,
        execution: ExecutionResult,
        psychology: Optional[dict[str, float]] = None,
    ) -> Position:
        """Open a filled paper position and lock margin."""
        risk = intent.risk_result
        decision_id = getattr(getattr(intent, "decision", None), "timestamp", intent.intent_id)
        pos = Position(
            position_id=str(uuid4()),
            decision_id=str(decision_id),
            intent_id=intent.intent_id,
            symbol=intent.symbol,
            side=intent.direction,
            leverage=float(getattr(risk, "leverage", intent.leverage)),
            margin=float(execution.margin),
            notional=float(execution.notional),
            entry_price=float(execution.entry_price),
            stop_loss=float(getattr(risk, "stop_price", 0.0)),
            take_profit=getattr(risk, "take_profit", None),
            status="OPEN",
            entry_time=execution.timestamp,
            fees=float(execution.fees),
            psychology_at_entry=dict(psychology or {}),
        )
        self.cash -= pos.margin
        self.cash -= pos.fees
        self.positions.append(pos)
        return pos

    def update(self, market: MarketSnapshot) -> list[Position]:
        """Mark positions and close on stop / take-profit."""
        closed: list[Position] = []
        when = datetime.fromisoformat(market.timestamp) if market.timestamp else None
        for pos in list(self.open_positions()):
            pnl_pct = self._compute_pnl_pct(pos, market.price)
            pos.mfe = max(pos.mfe, pnl_pct)
            pos.mae = min(pos.mae, pnl_pct)
            if self._hit_stop_loss(pos, market.price):
                closed.append(
                    self.close_position(pos, market.price, "STOP_LOSS", when=when)
                )
            elif pos.take_profit is not None and self._hit_take_profit(pos, market.price):
                closed.append(
                    self.close_position(pos, market.price, "TAKE_PROFIT", when=when)
                )
        return closed

    def close_position(
        self,
        pos: Position,
        exit_price: float,
        reason: str,
        psychology: Optional[dict[str, float]] = None,
        when: Optional[datetime] = None,
    ) -> Position:
        """Realize PnL and free margin."""
        if pos.side == "LONG":
            pnl = (exit_price - pos.entry_price) / pos.entry_price * pos.notional
        else:
            pnl = (pos.entry_price - exit_price) / pos.entry_price * pos.notional
        pos.realized_pnl = pnl - pos.fees
        pos.exit_price = exit_price
        pos.exit_time = _iso(when)
        pos.exit_reason = reason
        pos.status = "CLOSED"
        if psychology:
            pos.psychology_at_exit = dict(psychology)
        self.cash += pos.margin + pos.realized_pnl
        self.daily_pnl += pos.realized_pnl
        if reason == "STOP_LOSS" or pos.realized_pnl < 0:
            self.consecutive_stop_losses += 1
            streak_cfg = self.config.get("loss_streak") or {}
            if self.consecutive_stop_losses >= int(streak_cfg.get("threshold", 3)):
                minutes = int(streak_cfg.get("pause_minutes", 30))
                until = (when or datetime.now(timezone.utc)) + timedelta(minutes=minutes)
                self.loss_streak_paused_until = until.isoformat()
        else:
            if reason not in {"REPLAY_END"}:
                self.consecutive_stop_losses = 0
                self.loss_streak_paused_until = None
        return pos

    def _unrealized_pnl(self, pos: Position, price: float) -> float:
        if pos.side == "LONG":
            return (price - pos.entry_price) / pos.entry_price * pos.notional
        return (pos.entry_price - price) / pos.entry_price * pos.notional

    @staticmethod
    def _compute_pnl_pct(pos: Position, price: float) -> float:
        if pos.side == "LONG":
            return (price - pos.entry_price) / pos.entry_price
        return (pos.entry_price - price) / pos.entry_price

    @staticmethod
    def _hit_stop_loss(pos: Position, price: float) -> bool:
        if pos.side == "LONG":
            return price <= pos.stop_loss
        return price >= pos.stop_loss

    @staticmethod
    def _hit_take_profit(pos: Position, price: float) -> bool:
        if pos.take_profit is None:
            return False
        if pos.side == "LONG":
            return price >= pos.take_profit
        return price <= pos.take_profit
