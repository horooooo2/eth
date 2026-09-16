"""Hard risk gate for paper trading intents."""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from .signal_engine import clamp
from .trade_intent import TradeIntent


@dataclass
class MarketSnapshot:
    """Minimal market view used by risk and execution."""

    price: float
    atr: float
    timestamp: str = ""


@dataclass
class PortfolioState:
    """Account / exposure snapshot for risk checks."""

    equity: float
    cash: float
    open_position_count: int
    daily_pnl: float = 0.0
    daily_start_equity: float = 20000.0
    consecutive_stop_losses: int = 0
    loss_streak_paused_until: Optional[str] = None

    @property
    def daily_pnl_pct(self) -> float:
        if self.daily_start_equity <= 0:
            return 0.0
        return self.daily_pnl / self.daily_start_equity


@dataclass
class RiskCheckResult:
    """Auditable hard-risk outcome for one intent."""

    approved: bool
    position_size: float
    margin: float
    stop_price: float
    take_profit: Optional[float]
    risk_amount: float
    risk_pct: float
    leverage: float
    notional: float
    reject_reason: Optional[str]
    checks: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class RiskEngine:
    """Enforce hard portfolio constraints independent of personality."""

    config_path: Path
    config: dict[str, Any] = field(init=False)

    def __post_init__(self) -> None:
        self.config_path = Path(self.config_path)
        self.config = json.loads(self.config_path.read_text(encoding="utf-8"))

    def check(
        self,
        intent: TradeIntent,
        portfolio: PortfolioState,
        market: MarketSnapshot,
    ) -> RiskCheckResult:
        """Validate intent and compute allowable size / stop."""
        c = self.config["constraints"]
        checks: dict[str, Any] = {}
        decision = intent.decision
        requested_leverage = float(intent.leverage)

        # Daily loss / pause first
        pause_hit = self._check_loss_streak_pause(portfolio, checks, market.timestamp)
        if pause_hit:
            return self._reject(pause_hit, checks, requested_leverage)

        daily_hit = self._check_daily_loss(portfolio, c, checks)
        if daily_hit:
            return self._reject(daily_hit, checks, requested_leverage)

        pos_hit = self._check_position_count(portfolio, c, checks)
        if pos_hit:
            return self._reject(pos_hit, checks, requested_leverage)

        lev_hit = self._check_leverage(requested_leverage, c, checks)
        if lev_hit:
            return self._reject(lev_hit, checks, requested_leverage)
        leverage = requested_leverage

        entry = float(market.price)
        stop_price = self._compute_stop_price(intent.direction, entry, market.atr)
        stop_distance_pct = abs(entry - stop_price) / entry if entry > 0 else 1.0
        checks["stop_distance_pct"] = stop_distance_pct

        if stop_distance_pct > float(c["max_stop_loss_pct"]) + 1e-12:
            checks["stop_loss"] = {"ok": False, "pct": stop_distance_pct}
            return self._reject("STOP_LOSS_TOO_WIDE", checks, leverage)
        checks["stop_loss"] = {"ok": True, "pct": stop_distance_pct}

        multiplier = float(getattr(decision, "position_multiplier", 1.0))
        notional, margin = self._compute_position_size(
            portfolio.equity, multiplier, leverage, stop_distance_pct
        )
        checks["sizing"] = {"notional": notional, "margin": margin, "multiplier": multiplier}

        if margin > portfolio.equity * float(c["max_margin_pct"]) + 1e-9:
            return self._reject("MARGIN_TOO_LARGE", checks, leverage)
        if notional > portfolio.equity * float(c["max_notional_pct"]) + 1e-9:
            return self._reject("NOTIONAL_TOO_LARGE", checks, leverage)

        risk_amount = notional * stop_distance_pct
        risk_pct = risk_amount / portfolio.equity if portfolio.equity > 0 else 1.0
        checks["risk"] = {"amount": risk_amount, "pct": risk_pct}
        if risk_pct > float(c["max_risk_pct"]) + 1e-12:
            return self._reject("RISK_TOO_LARGE", checks, leverage)

        # Minimum notional sanity
        min_notional = portfolio.equity * float(
            self.config["position_sizing"].get("min_notional_pct", 0.01)
        )
        if notional < min_notional:
            return self._reject("NOTIONAL_TOO_SMALL", checks, leverage)

        tp_rr = float(self.config.get("execution", {}).get("take_profit_rr", 2.0))
        stop_dist = abs(entry - stop_price)
        if intent.direction == "LONG":
            take_profit = entry + stop_dist * tp_rr
        else:
            take_profit = entry - stop_dist * tp_rr

        checks["approved"] = True
        return RiskCheckResult(
            approved=True,
            position_size=notional / entry if entry else 0.0,
            margin=margin,
            stop_price=stop_price,
            take_profit=take_profit,
            risk_amount=risk_amount,
            risk_pct=risk_pct,
            leverage=leverage,
            notional=notional,
            reject_reason=None,
            checks=checks,
        )

    def _compute_stop_price(self, direction: str, entry: float, atr: float) -> float:
        """ATR stop; width is validated later against max_stop_loss_pct."""
        sl = self.config["stop_loss"]
        dist = max(
            float(sl["atr_multiplier"]) * float(atr),
            entry * float(sl["min_distance_pct"]),
        )
        if direction == "LONG":
            return entry - dist
        return entry + dist

    def _compute_position_size(
        self,
        equity: float,
        multiplier: float,
        leverage: float,
        stop_distance_pct: float,
    ) -> tuple[float, float]:
        sizing = self.config["position_sizing"]
        c = self.config["constraints"]
        base_margin_pct = float(sizing["base_margin_pct"])
        target_margin_pct = base_margin_pct * float(multiplier)
        target_margin_pct = min(target_margin_pct, float(c["max_margin_pct"]))

        if stop_distance_pct <= 0:
            stop_distance_pct = float(c["max_stop_loss_pct"])

        max_notional_by_risk = (equity * float(c["max_risk_pct"])) / stop_distance_pct
        max_notional_by_margin = equity * target_margin_pct * leverage
        max_notional_cap = equity * float(c["max_notional_pct"])
        notional = min(max_notional_by_risk, max_notional_by_margin, max_notional_cap)
        margin = notional / leverage if leverage > 0 else notional
        # Final clip
        if margin > equity * float(c["max_margin_pct"]):
            margin = equity * float(c["max_margin_pct"])
            notional = margin * leverage
        return notional, margin

    def _check_position_count(
        self, portfolio: PortfolioState, c: dict[str, Any], checks: dict[str, Any]
    ) -> Optional[str]:
        ok = portfolio.open_position_count < int(c["max_positions"])
        checks["max_positions"] = {
            "ok": ok,
            "open": portfolio.open_position_count,
            "limit": c["max_positions"],
        }
        return None if ok else "MAX_POSITIONS_REACHED"

    def _check_leverage(
        self, leverage: float, c: dict[str, Any], checks: dict[str, Any]
    ) -> Optional[str]:
        ok = leverage <= float(c["max_leverage"]) + 1e-12
        checks["leverage"] = {"ok": ok, "value": leverage, "limit": c["max_leverage"]}
        return None if ok else "LEVERAGE_EXCEEDED"

    def _check_daily_loss(
        self, portfolio: PortfolioState, c: dict[str, Any], checks: dict[str, Any]
    ) -> Optional[str]:
        limit = float(c["daily_loss_limit"])
        pct = portfolio.daily_pnl_pct
        ok = pct > limit  # e.g. -0.02 > -0.03
        checks["daily_loss"] = {"ok": ok, "pct": pct, "limit": limit}
        return None if ok else "DAILY_LOSS_LIMIT"

    def _check_loss_streak_pause(
        self,
        portfolio: PortfolioState,
        checks: dict[str, Any],
        market_ts: str = "",
    ) -> Optional[str]:
        until = portfolio.loss_streak_paused_until
        if not until:
            checks["loss_streak_pause"] = {"ok": True}
            return None
        now = datetime.fromisoformat(market_ts) if market_ts else datetime.now(timezone.utc)
        paused = now < datetime.fromisoformat(until)
        checks["loss_streak_pause"] = {"ok": not paused, "until": until}
        return "LOSS_STREAK_PAUSED" if paused else None

    @staticmethod
    def _reject(code: str, checks: dict[str, Any], leverage: float) -> RiskCheckResult:
        checks["approved"] = False
        checks["reject_reason"] = code
        return RiskCheckResult(
            approved=False,
            position_size=0.0,
            margin=0.0,
            stop_price=0.0,
            take_profit=None,
            risk_amount=0.0,
            risk_pct=0.0,
            leverage=leverage,
            notional=0.0,
            reject_reason=code,
            checks=checks,
        )
