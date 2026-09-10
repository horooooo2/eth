"""S5 initial-risk usage accounting.

Truth source is Position Ownership + entry_risk_snapshot, never the
hand-written context field ``open_portfolio_risk_pct_equity``.

Three concepts (must stay split):

* ``planned_trade_risk_pct_equity`` — single-trade plan (S1 = 0.4%)
* ``strategy_risk_used_pct_equity`` — sum of ACTIVE owned initial risk for one strategy
* ``portfolio_risk_used_pct_equity`` — sum across all Alpha owned positions

Denominator
-----------
Position *quote* risk is **initial**, frozen at fill:

    position_risk_quote = abs(entry_price - stop_price) * owned_base_quantity

This does not move with mark-to-market PnL or later protective-stop trails.
This round does not release budget when a stop moves toward profit.

Used-risk **percent** for S5 / dashboard comparison uses **current
authoritative equity** when available:

    used_pct = sum(position_risk_quote) / current_equity

That matches existing sizing (``risk_amount = equity * risk_pct`` at the
decision) and the recommended budget comparison. If current equity is
missing, fall back to the frozen ``initial_risk_used_pct_equity`` stored
on each snapshot (``risk_quote / equity_at_entry``).

With unchanged equity the two are identical, so the RANGE examples
(0.4% / 0.8% / remaining 0.2%) stay exact.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Mapping, Optional, Union

from src.runtime.alpha_execution import is_legacy_paper_position

PORTFOLIO_RISK_BUDGET_EXCEEDED = "PORTFOLIO_RISK_BUDGET_EXCEEDED"
STRATEGY_RISK_CAP_EXCEEDED = "STRATEGY_RISK_CAP_EXCEEDED"

_ACTION_ALLOW = "ALLOW"
_ACTION_SHRINK = "SHRINK"
_ACTION_BLOCK = "BLOCK"

_COUNTABLE_STRATEGIES = {"S1", "S2", "S9"}
_NON_COUNTABLE_STATUS = {
    "SHADOW",
    "WOULD_SUBMIT",
    "SUBMITTED",
    "CREATED",
    "PENDING_GATEWAY",
    "CLOSED",
}
_MANUAL_MARKERS = {
    "exchange_observed",
    "user_manual",
    "manual",
    "EXTERNAL_POSITION",
    "external_position",
}
_EPS = 1e-12

PositionLike = Union[Mapping[str, Any], Any]


def _as_mapping(pos: PositionLike) -> Dict[str, Any]:
    if pos is None:
        return {}
    if isinstance(pos, Mapping):
        return dict(pos)
    to_dict = getattr(pos, "to_dict", None)
    if callable(to_dict):
        return dict(to_dict())
    return {
        "position_id": getattr(pos, "position_id", None),
        "symbol": getattr(pos, "symbol", None),
        "side": getattr(pos, "side", None),
        "quantity": getattr(pos, "quantity", 0.0),
        "origin_strategy_id": getattr(pos, "origin_strategy_id", None),
        "origin_trade_intent_id": getattr(pos, "origin_trade_intent_id", None),
        "entry_risk_snapshot": dict(getattr(pos, "entry_risk_snapshot", None) or {}),
        "stop_policy_snapshot": dict(getattr(pos, "stop_policy_snapshot", None) or {}),
        "status": getattr(pos, "status", None),
        "metadata": dict(getattr(pos, "metadata", None) or {}),
    }


def _f(value: Any, default: float = 0.0) -> float:
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _meta(data: Mapping[str, Any]) -> Dict[str, Any]:
    raw = data.get("metadata")
    return dict(raw) if isinstance(raw, Mapping) else {}


def strategy_config_key(strategy_id: str) -> str:
    sid = str(strategy_id or "").strip().upper()
    if sid == "S1":
        return "S1_trend"
    if sid == "S2":
        return "S2_reversal"
    if sid == "S9":
        return "S9_high_frequency_momentum"
    return ""


def strategy_initial_risk_cap(config: Mapping[str, Any], strategy_id: str) -> float:
    """Read the real per-strategy cap from S1/S2/S9 JSON.

    Does **not** read the missing ``global_risk.per_strategy_initial_risk_cap_pct_equity``.
    """
    key = strategy_config_key(strategy_id)
    if not key:
        return 0.0
    block = config.get(key) or {}
    return max(0.0, _f(block.get("strategy_initial_risk_cap_pct_equity"), 0.0))


def planned_trade_risk_pct(config: Mapping[str, Any], strategy_id: str) -> float:
    key = strategy_config_key(strategy_id)
    block = config.get(key) or {}
    sid = str(strategy_id).upper()
    defaults = {"S1": 0.004, "S2": 0.003, "S9": 0.001}
    default = defaults.get(sid, 0.0)
    return max(0.0, _f(block.get("risk_per_trade_pct_equity"), default))


def is_countable_owned_position(pos: PositionLike) -> bool:
    """ACTIVE Alpha ownership with a real PARTIAL/FILLED qty.

    Excludes SHADOW, WOULD_SUBMIT, SUBMITTED-with-0-fill, legacy paper,
    user-manual / exchange-observed positions, and closed rows.
    """
    data = _as_mapping(pos)
    if not data:
        return False
    status = str(data.get("status") or "OPEN").upper()
    if status != "OPEN":
        return False
    qty = _f(data.get("quantity"))
    if qty <= _EPS:
        return False
    origin = str(data.get("origin_strategy_id") or "").strip().upper()
    if origin not in _COUNTABLE_STRATEGIES:
        return False
    if is_legacy_paper_position(data):
        return False
    meta = _meta(data)
    exec_status = str(meta.get("execution_status") or data.get("execution_status") or "").upper()
    if exec_status in {"SHADOW", "WOULD_SUBMIT"}:
        return False
    if bool(meta.get("shadow") or data.get("shadow")):
        return False
    if str(meta.get("alpha_execution") or data.get("alpha_execution") or "").upper() == "SHADOW":
        return False
    origin_kind = str(
        meta.get("origin_kind") or data.get("origin_kind") or meta.get("source") or ""
    ).strip()
    if origin_kind in _MANUAL_MARKERS:
        return False
    if str(meta.get("legacy_mark") or data.get("legacy_mark") or "") == "LEGACY_PAPER_POSITION":
        return False
    if exec_status in _NON_COUNTABLE_STATUS and exec_status not in {"PARTIAL", "PARTIALLY_FILLED", "FILLED", "OPEN"}:
        # SUBMITTED / CREATED never become ownership; keep the belt anyway.
        if exec_status in {"SUBMITTED", "CREATED", "PENDING_GATEWAY", "WOULD_SUBMIT", "SHADOW"}:
            return False
    return True


def enrich_entry_risk_snapshot(
    snapshot: Optional[Mapping[str, Any]],
    *,
    filled_base_quantity: float,
    origin_strategy_id: str,
    entry_price: Optional[float] = None,
    stop_price: Optional[float] = None,
    equity: Optional[float] = None,
    planned_base_quantity: Optional[float] = None,
    planned_risk_pct: Optional[float] = None,
) -> Dict[str, Any]:
    """Freeze initial risk on a real fill. PARTIAL uses filled/planned ratio."""
    snap = dict(snapshot or {})
    equity_at_entry = _f(equity, _f(snap.get("equity_at_entry"), _f(snap.get("equity"))))
    entry = _f(entry_price, _f(snap.get("entry_price")))
    stop = _f(stop_price, _f(snap.get("stop_price")))
    planned_qty = _f(
        planned_base_quantity,
        _f(snap.get("base_quantity"), _f(filled_base_quantity)),
    )
    filled = max(0.0, _f(filled_base_quantity))
    planned_pct = _f(planned_risk_pct, _f(snap.get("risk_pct"), _f(snap.get("risk_pct_equity"))))

    fill_ratio = 1.0
    if planned_qty > _EPS:
        fill_ratio = min(1.0, max(0.0, filled / planned_qty))
    elif filled <= _EPS:
        fill_ratio = 0.0

    risk_quote = 0.0
    if entry > 0 and stop > 0 and filled > _EPS:
        risk_quote = abs(entry - stop) * filled
    elif equity_at_entry > 0 and planned_pct > 0:
        risk_quote = equity_at_entry * planned_pct * fill_ratio

    if equity_at_entry > _EPS and risk_quote > 0:
        initial_pct = risk_quote / equity_at_entry
    else:
        initial_pct = planned_pct * fill_ratio

    # Preserve first-fill anchors so later partial exits scale from the open, not from a trail.
    at_open_qty = _f(snap.get("initial_filled_base_quantity"))
    at_open_pct = _f(snap.get("initial_risk_used_pct_equity_at_open"))
    at_open_quote = _f(snap.get("initial_risk_amount_quote_at_open"))
    if at_open_qty <= _EPS:
        at_open_qty = filled
        at_open_pct = initial_pct
        at_open_quote = risk_quote

    snap.update(
        {
            "equity_at_entry": equity_at_entry,
            "equity": equity_at_entry,
            "risk_pct": planned_pct,
            "risk_pct_equity": initial_pct,
            "risk_amount_quote": risk_quote,
            "entry_price": entry,
            "stop_price": stop,
            "base_quantity": planned_qty if planned_qty > _EPS else filled,
            "filled_base_quantity": filled,
            "origin_strategy_id": str(origin_strategy_id or snap.get("origin_strategy_id") or ""),
            "initial_risk_used_pct_equity": initial_pct,
            "initial_filled_base_quantity": at_open_qty,
            "initial_risk_used_pct_equity_at_open": at_open_pct,
            "initial_risk_amount_quote_at_open": at_open_quote,
        }
    )
    return snap


def scale_snapshot_for_remaining_qty(snapshot: Mapping[str, Any], remaining_qty: float) -> Dict[str, Any]:
    """Conservative partial-exit: remaining_risk = open_risk * remaining / filled_at_open."""
    snap = dict(snapshot or {})
    remaining = max(0.0, _f(remaining_qty))
    orig_filled = _f(snap.get("initial_filled_base_quantity"), _f(snap.get("filled_base_quantity")))
    orig_pct = _f(snap.get("initial_risk_used_pct_equity_at_open"), _f(snap.get("initial_risk_used_pct_equity")))
    orig_quote = _f(snap.get("initial_risk_amount_quote_at_open"), _f(snap.get("risk_amount_quote")))
    ratio = (remaining / orig_filled) if orig_filled > _EPS else 0.0
    snap["filled_base_quantity"] = remaining
    snap["initial_risk_used_pct_equity"] = orig_pct * ratio
    snap["risk_pct_equity"] = snap["initial_risk_used_pct_equity"]
    snap["risk_amount_quote"] = orig_quote * ratio
    return snap


def position_initial_risk(pos: PositionLike) -> Dict[str, float]:
    data = _as_mapping(pos)
    snap = dict(data.get("entry_risk_snapshot") or {})
    stop_pol = dict(data.get("stop_policy_snapshot") or {})
    owned_qty = _f(data.get("quantity"), _f(snap.get("filled_base_quantity")))
    entry = _f(snap.get("entry_price"), _f(data.get("entry_price")))
    stop = _f(snap.get("stop_price"), _f(stop_pol.get("stop_price"), _f(data.get("stop_price"))))
    equity_at_entry = _f(snap.get("equity_at_entry"), _f(snap.get("equity")))

    risk_quote = 0.0
    if entry > 0 and stop > 0 and owned_qty > _EPS:
        risk_quote = abs(entry - stop) * owned_qty
    else:
        risk_quote = _f(snap.get("risk_amount_quote"))

    if equity_at_entry > _EPS and risk_quote > 0:
        initial_pct = risk_quote / equity_at_entry
    else:
        initial_pct = _f(
            snap.get("initial_risk_used_pct_equity"),
            _f(snap.get("risk_pct_equity"), _f(snap.get("risk_pct"))),
        )
        if risk_quote <= 0 and equity_at_entry > _EPS and initial_pct > 0:
            risk_quote = initial_pct * equity_at_entry

    return {
        "risk_amount_quote": risk_quote,
        "initial_risk_used_pct_equity": initial_pct,
        "owned_base_quantity": owned_qty,
        "equity_at_entry": equity_at_entry,
    }


def compute_risk_usage(
    positions: Optional[Iterable[PositionLike]],
    *,
    current_equity: Optional[float] = None,
) -> Dict[str, Any]:
    """Sum initial risk of countable ACTIVE owned positions."""
    strategy_quote = {"S1": 0.0, "S2": 0.0, "S9": 0.0}
    strategy_frozen_pct = {"S1": 0.0, "S2": 0.0, "S9": 0.0}
    counted = 0
    for pos in positions or []:
        if not is_countable_owned_position(pos):
            continue
        data = _as_mapping(pos)
        sid = str(data.get("origin_strategy_id") or "").strip().upper()
        if sid not in strategy_quote:
            continue
        risk = position_initial_risk(data)
        strategy_quote[sid] += risk["risk_amount_quote"]
        strategy_frozen_pct[sid] += risk["initial_risk_used_pct_equity"]
        counted += 1

    eq = _f(current_equity)
    if eq > _EPS:
        strategy_used = {sid: (strategy_quote[sid] / eq) for sid in ("S1", "S2", "S9")}
        denominator = "current_authoritative_equity"
    else:
        strategy_used = dict(strategy_frozen_pct)
        denominator = "equity_at_entry_frozen"

    portfolio_used = strategy_used["S1"] + strategy_used["S2"] + strategy_used["S9"]
    return {
        "portfolio_risk_used_pct_equity": portfolio_used,
        "strategy_risk_used_pct_equity": strategy_used,
        "portfolio_risk_used_quote": strategy_quote["S1"] + strategy_quote["S2"],
        "strategy_risk_used_quote": dict(strategy_quote),
        "counted_positions": counted,
        "equity_denominator": denominator,
        "current_equity": eq if eq > _EPS else None,
    }


def empty_risk_usage() -> Dict[str, Any]:
    return compute_risk_usage([], current_equity=None)


@dataclass
class OpeningAuthorization:
    action: str
    reason_code: Optional[str] = None
    planned_trade_risk_pct_equity: float = 0.0
    allowed_risk_pct_equity: float = 0.0
    portfolio_risk_used_pct_equity: float = 0.0
    strategy_risk_used_pct_equity: float = 0.0
    projected_portfolio_risk_pct_equity: float = 0.0
    projected_strategy_risk_pct_equity: float = 0.0
    portfolio_risk_limit_pct_equity: float = 0.0
    strategy_risk_limit_pct_equity: float = 0.0
    remaining_portfolio_pct_equity: float = 0.0
    remaining_strategy_pct_equity: float = 0.0
    scale: float = 1.0
    details: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "action": self.action,
            "reason_code": self.reason_code,
            "planned_trade_risk_pct_equity": self.planned_trade_risk_pct_equity,
            "allowed_risk_pct_equity": self.allowed_risk_pct_equity,
            "portfolio_risk_used_pct_equity": self.portfolio_risk_used_pct_equity,
            "strategy_risk_used_pct_equity": self.strategy_risk_used_pct_equity,
            "projected_portfolio_risk_pct_equity": self.projected_portfolio_risk_pct_equity,
            "projected_strategy_risk_pct_equity": self.projected_strategy_risk_pct_equity,
            "portfolio_risk_limit_pct_equity": self.portfolio_risk_limit_pct_equity,
            "strategy_risk_limit_pct_equity": self.strategy_risk_limit_pct_equity,
            "remaining_portfolio_pct_equity": self.remaining_portfolio_pct_equity,
            "remaining_strategy_pct_equity": self.remaining_strategy_pct_equity,
            "scale": self.scale,
            "details": dict(self.details),
        }


def authorize_opening(
    *,
    strategy_id: str,
    planned_trade_risk_pct_equity: float,
    usage: Mapping[str, Any],
    portfolio_risk_limit_pct_equity: float,
    strategy_risk_limit_pct_equity: float,
    reserved_opening_risk_pct_equity: float = 0.0,
) -> OpeningAuthorization:
    """Approve / shrink / block a new opening against initial-risk budgets."""
    sid = str(strategy_id or "").strip().upper()
    planned = max(0.0, _f(planned_trade_risk_pct_equity))
    used_map = dict(usage.get("strategy_risk_used_pct_equity") or {})
    strategy_used = max(0.0, _f(used_map.get(sid), 0.0))
    portfolio_used = max(0.0, _f(usage.get("portfolio_risk_used_pct_equity")))
    reserved = max(0.0, _f(reserved_opening_risk_pct_equity))
    strategy_used += reserved
    portfolio_used += reserved

    portfolio_limit = max(0.0, _f(portfolio_risk_limit_pct_equity))
    strategy_limit = max(0.0, _f(strategy_risk_limit_pct_equity))
    remaining_portfolio = portfolio_limit - portfolio_used
    remaining_strategy = strategy_limit - strategy_used
    remaining = min(remaining_portfolio, remaining_strategy)

    projected_portfolio = portfolio_used + planned
    projected_strategy = strategy_used + planned

    base = OpeningAuthorization(
        action=_ACTION_ALLOW,
        planned_trade_risk_pct_equity=planned,
        allowed_risk_pct_equity=planned,
        portfolio_risk_used_pct_equity=portfolio_used,
        strategy_risk_used_pct_equity=strategy_used,
        projected_portfolio_risk_pct_equity=projected_portfolio,
        projected_strategy_risk_pct_equity=projected_strategy,
        portfolio_risk_limit_pct_equity=portfolio_limit,
        strategy_risk_limit_pct_equity=strategy_limit,
        remaining_portfolio_pct_equity=remaining_portfolio,
        remaining_strategy_pct_equity=remaining_strategy,
        scale=1.0,
    )

    if planned <= _EPS:
        base.action = _ACTION_BLOCK
        base.reason_code = PORTFOLIO_RISK_BUDGET_EXCEEDED
        base.allowed_risk_pct_equity = 0.0
        base.scale = 0.0
        return base

    if remaining <= _EPS:
        base.action = _ACTION_BLOCK
        base.allowed_risk_pct_equity = 0.0
        base.scale = 0.0
        if remaining_portfolio <= remaining_strategy + _EPS:
            base.reason_code = PORTFOLIO_RISK_BUDGET_EXCEEDED
        else:
            base.reason_code = STRATEGY_RISK_CAP_EXCEEDED
        return base

    if remaining + _EPS < planned:
        base.action = _ACTION_SHRINK
        base.allowed_risk_pct_equity = remaining
        base.scale = remaining / planned if planned > _EPS else 0.0
        base.projected_portfolio_risk_pct_equity = portfolio_used + remaining
        base.projected_strategy_risk_pct_equity = strategy_used + remaining
        if remaining_portfolio <= remaining_strategy + _EPS:
            base.reason_code = PORTFOLIO_RISK_BUDGET_EXCEEDED
        else:
            base.reason_code = STRATEGY_RISK_CAP_EXCEEDED
        return base

    return base


def attach_usage_to_s5(s5: Mapping[str, Any], usage: Mapping[str, Any], config: Mapping[str, Any]) -> Dict[str, Any]:
    out = dict(s5 or {})
    caps = {
        "S1": strategy_initial_risk_cap(config, "S1"),
        "S2": strategy_initial_risk_cap(config, "S2"),
        "S9": strategy_initial_risk_cap(config, "S9"),
    }
    used = dict(usage.get("strategy_risk_used_pct_equity") or {"S1": 0.0, "S2": 0.0, "S9": 0.0})
    out["strategy_risk_cap_pct_equity"] = caps
    out["strategy_risk_limit_pct_equity"] = caps
    out["strategy_risk_used_pct_equity"] = {
        "S1": _f(used.get("S1")),
        "S2": _f(used.get("S2")),
        "S9": _f(used.get("S9")),
    }
    out["portfolio_risk_used_pct_equity"] = _f(usage.get("portfolio_risk_used_pct_equity"))
    out["portfolio_risk_limit_pct_equity"] = _f(out.get("portfolio_risk_budget_pct_equity"))
    return out
