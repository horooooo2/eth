"""Serialize orchestrator context into dashboard / API payloads."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional, Sequence

from src.core.signal_lifecycle import TradeIntent
from src.runtime.alpha_execution import (
    is_runtime_test_fixture,
    live_trading_enabled,
    strategy_live_allowed,
    user_id_ready,
)


def _iso(dt: Any) -> Optional[str]:
    if dt is None:
        return None
    if isinstance(dt, datetime):
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.isoformat()
    return str(dt)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


REGIME_MAP = {
    "STRONG_TREND": "strong_trend",
    "strong_trend": "strong_trend",
    "WEAK_TREND": "weak_trend",
    "weak_trend": "weak_trend",
    "RANGE": "range",
    "range": "range",
    "PANIC": "panic",
    "panic": "panic",
    "RECOVERY": "recovery",
    "recovery": "recovery",
}


def normalize_regime(raw: Any) -> str:
    key = str(raw or "range")
    return REGIME_MAP.get(key, REGIME_MAP.get(key.lower(), "range"))


STATUS_LABEL = {
    0: "NORMAL",
    1: "REDUCED",
    2: "BLOCKED",
    3: "LOCKED",
}


def serialize_s3(context: Mapping[str, Any], data_pool: Any) -> Dict[str, Any]:
    s3 = context.get("S3") or {}
    if not isinstance(s3, dict):
        s3 = {}
    regime = normalize_regime(context.get("S3.regime") or s3.get("regime"))
    return {
        "regime": regime,
        "direction_bias": float(context.get("S3.direction_bias", s3.get("direction_bias", 0.0)) or 0.0),
        "confidence": float(context.get("S3.confidence", s3.get("confidence", 0.0)) or 0.0),
        "risk_multiplier": float(
            context.get("S3.risk_multiplier", s3.get("risk_multiplier", 1.0)) or 1.0
        ),
        "trend_strength": float(data_pool.get("trend_strength") or data_pool.get("adx14") or 0.0)
        if data_pool
        else 0.0,
        "breadth_24h": float(data_pool.get("breadth_24h") or 0.0) if data_pool else 0.0,
        "rv5m_ratio_30d": float(data_pool.get("rv5m_ratio_30d") or 1.0) if data_pool else 1.0,
        "updated_at": _now_iso(),
    }


def serialize_s5(context: Mapping[str, Any]) -> Dict[str, Any]:
    s5 = context.get("S5") or {}
    if not isinstance(s5, dict):
        s5 = {}
    final = s5.get("final_shares") or {}
    raw = s5.get("raw_shares") or {}
    budgets = s5.get("strategy_risk_budget_pct_equity") or {}
    usage = context.get("risk_usage") if isinstance(context.get("risk_usage"), dict) else {}
    used_map = (usage.get("strategy_risk_used_pct_equity") if usage else None) or s5.get(
        "strategy_risk_used_pct_equity"
    ) or {}
    caps = s5.get("strategy_risk_cap_pct_equity") or s5.get("strategy_risk_limit_pct_equity") or {}
    used_portfolio = float(
        (usage or {}).get("portfolio_risk_used_pct_equity")
        or s5.get("portfolio_risk_used_pct_equity")
        or 0.0
    )
    portfolio_budget = float(s5.get("portfolio_risk_budget_pct_equity") or 0.0)
    reserve = float(s5.get("reserve_fraction") or 0.15)
    strategies: Dict[str, Any] = {}
    for sid in ("S1", "S2", "S4"):
        strategies[sid] = {
            "base_share": None,
            "regime_multiplier": None,
            "health_multiplier": None,
            "raw_share": float(raw.get(sid, 0.0) or 0.0),
            "final_share": float(final.get(sid, 0.0) or 0.0),
            "risk_budget": float(budgets.get(sid, 0.0) or 0.0),
            "risk_used": float(used_map.get(sid, 0.0) or 0.0),
            "risk_cap": float(caps.get(sid, 0.0) or 0.0),
        }
    return {
        "portfolio": {
            "global_risk_limit": float(context.get("global_portfolio_risk_cap") or portfolio_budget or 0.0),
            "effective_risk_budget": portfolio_budget,
            "risk_used": used_portfolio,
            "reserve_fraction": reserve,
            "raw_sum": float(sum(float(v or 0) for v in raw.values())),
            "scale": float(s5.get("scale") or 0.0),
        },
        "strategies": strategies,
        "updated_at": _now_iso(),
    }


def serialize_s6(context: Mapping[str, Any], data_pool: Any, s6: Any) -> Dict[str, Any]:
    level = int(getattr(s6, "level", context.get("S6.level", 0)) or 0)
    s6_ctx = context.get("S6") or {}
    if not isinstance(s6_ctx, dict):
        s6_ctx = {}
    reason = None
    hard = list(getattr(s6, "_hard_events", None) or s6_ctx.get("hard_events") or [])
    if hard:
        reason = str(hard[-1]).upper()
    latency = float(data_pool.get("market_data_stale_ms") or 0) if data_pool else None
    return {
        "level": level,
        "status": STATUS_LABEL.get(level, "NORMAL"),
        "reason": reason,
        "exchange_connected": bool(data_pool.get("exchange_connected", True)) if data_pool else True,
        "market_data_latency_ms": latency,
        "sequence_valid": bool(data_pool.get("sequence_valid", True)) if data_pool else True,
        "positions_reconciled": bool(context.get("positions_reconciled", True)),
        "orders_reconciled": bool(context.get("orders_reconciled", True)),
        "risk_engine_healthy": level < 3,
        "new_entries_enabled": level < 2,
        "active_incident_id": f"INC-{hard[-1]}" if hard else None,
        "recovery": {
            "manual_resume_required": bool(getattr(s6, "_manual_resume_required", False)),
            "stable_since": _iso(getattr(s6, "_stable_since", None)),
        },
        "updated_at": _now_iso(),
    }


def serialize_s7(context: Mapping[str, Any], s7: Any) -> List[Dict[str, Any]]:
    names = {"S1": "Trend", "S2": "Reversal", "S4": "Execution"}
    out: List[Dict[str, Any]] = []
    s7_ctx = context.get("S7") or {}
    history = getattr(s7, "trade_history", {}) or {}
    for sid in ("S1", "S2", "S4"):
        row = s7_ctx.get(sid) if isinstance(s7_ctx, dict) else None
        if not isinstance(row, dict):
            row = {}
        trades = history.get(sid) or []
        sample_count = len(trades)
        warming = sample_count < 30
        health = None if warming else row.get("health_score")
        state = "WARMING_UP" if warming else str(row.get("state") or "ON")
        # expectancy from recent trades if any
        expectancy = None
        if trades:
            rs = [float(t.get("r_multiple", 0.0)) for t in trades[-100:]]
            expectancy = sum(rs) / max(len(rs), 1)
        out.append(
            {
                "strategy_id": sid,
                "name": names[sid],
                "health_score": None if health is None else float(health),
                "state": state,
                "sample_count": sample_count,
                "expectancy_R": expectancy,
                "profit_factor": None,
                "win_rate": None,
                "avg_win_R": None,
                "avg_loss_R": None,
                "max_drawdown_R": None,
                "components": None,
                "updated_at": _now_iso(),
            }
        )
    return out


def serialize_trade_intent(
    intent: TradeIntent,
    *,
    context: Mapping[str, Any],
    data_pool: Any,
    lifecycle: Any,
) -> Dict[str, Any]:
    mid = float(data_pool.get("close") or intent.reference_price or 0.0) if data_pool else float(intent.reference_price)
    fields = lifecycle.derived_fields(intent, mid)
    policy = lifecycle.get_policy(intent.strategy_id)
    edge = context.get("edge_estimate") or {}
    edge_r = None
    if isinstance(edge, dict):
        edge_r = edge.get("expected_edge_after_cost_R")
    if edge_r is None:
        edge_r = context.get("expected_edge_after_cost_R")
    meta = intent.metadata or {}
    return {
        "intent_id": intent.intent_id,
        "strategy_id": intent.strategy_id,
        "symbol": intent.symbol.replace("/", "").replace(":USDT", "USDT")
        if "/" in intent.symbol
        else intent.symbol,
        "direction": str(intent.direction).lower(),
        "status": intent.status,
        "created_at": _iso(intent.created_at),
        "expires_at": _iso(intent.expires_at),
        "signal_age_seconds": float(fields.get("signal_age_seconds") or 0.0),
        "ttl_seconds": float(policy.get("expiry_seconds", 120)),
        "reference_price": float(intent.reference_price),
        "current_price": mid,
        "price_drift_bps": float(fields.get("price_drift_bps") or 0.0),
        "max_price_drift_bps": float(policy.get("max_price_drift_bps", 30)),
        "expected_edge_R": float(edge_r) if edge_r is not None else None,
        "s3_regime": normalize_regime(context.get("S3.regime")),
        "s3_direction_bias": float(context.get("S3.direction_bias") or 0.0),
        "s4_status": str(meta.get("s4_status") or intent.status),
    }


def serialize_trade_intents(
    intents: Sequence[Any],
    *,
    context: Mapping[str, Any],
    data_pool: Any,
    lifecycle: Any,
) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for intent in intents:
        if isinstance(intent, TradeIntent):
            out.append(
                serialize_trade_intent(
                    intent, context=context, data_pool=data_pool, lifecycle=lifecycle
                )
            )
        elif isinstance(intent, dict):
            # already dict from step log
            out.append(intent)
    return out


def refresh_context_risk_usage(runtime: Any, context: Dict[str, Any]) -> Dict[str, Any]:
    """Recompute used risk from live ownership so the dashboard is not a handwritten field."""
    from src.runtime.risk_usage import compute_risk_usage

    positions: List[Any] = []
    registry = getattr(runtime, "positions", None)
    if registry is not None and hasattr(registry, "list_open"):
        positions = [p.to_dict() if hasattr(p, "to_dict") else p for p in registry.list_open()]
    elif context.get("owned_open_positions"):
        positions = list(context.get("owned_open_positions") or [])
    usage = compute_risk_usage(positions, current_equity=context.get("equity"))
    context["risk_usage"] = usage
    context["portfolio_risk_used_pct_equity"] = usage.get("portfolio_risk_used_pct_equity")
    return usage


def build_dashboard_snapshot(runtime: Any) -> Dict[str, Any]:
    orch = runtime.orchestrator
    context = orch.context or {}
    if not isinstance(context, dict):
        context = {}
        orch.context = context
    refresh_context_risk_usage(runtime, context)
    data_pool = orch.data_pool
    intents = list(orch.lifecycle.intents.values())
    # Prefer live lifecycle intents; fall back to last cycle list
    if not intents and context.get("trade_intents"):
        intents = list(context.get("trade_intents") or [])

    raw = {
        "engine": {
            "version": str(getattr(runtime, "config_version", None) or (orch.config.get("meta") or {}).get("version") or "4.1"),
            "mode": runtime.mode,
            "state": runtime.state,
            "updated_at": _now_iso(),
            "started_at": runtime.started_at,
            "last_tick_at": runtime.last_tick_at,
            "active_strategy": runtime.active_strategy,
            "engine_available": runtime.state != "OFFLINE",
            "alpha_opening_enabled": getattr(runtime, "alpha_opening_enabled", True),
            "console_mode": getattr(runtime, "console_mode", "ALPHA"),
            "alpha_execution": getattr(runtime, "alpha_execution", "SHADOW"),
            "live_permission": live_trading_enabled(),
            "user_id_ready": user_id_ready(getattr(runtime, "user_id", None)),
            "last_evaluated_at": (
                runtime._active_diag().last_evaluated_at
                if hasattr(runtime, "_active_diag") and runtime._active_diag()
                else None
            ),
            "evaluation_count": (
                runtime._active_diag().evaluation_count
                if hasattr(runtime, "_active_diag") and runtime._active_diag()
                else 0
            ),
        },
        "s3": serialize_s3(context, data_pool),
        "s5": serialize_s5(context),
        "s6": serialize_s6(context, data_pool, orch.s6),
        "s7": serialize_s7(context, orch.s7),
        "trade_intents": serialize_trade_intents(
            intents, context=context, data_pool=data_pool, lifecycle=orch.lifecycle
        ),
        "order_intents": [
            oi for oi in list(getattr(runtime, "order_intents", []) or []) if not is_runtime_test_fixture(oi)
        ],
        "execution": {
            "mode": runtime.execution_mode,
            "alpha_execution": getattr(runtime, "alpha_execution", "SHADOW"),
            "last_orders": list(orch.last_orders or []),
        },
        "alpha_execution": getattr(runtime, "alpha_execution", "SHADOW"),
        "account_environment": None,
        "live_permission": live_trading_enabled(),
        "user_id_ready": user_id_ready(getattr(runtime, "user_id", None)),
        "strategy": {
            "id": getattr(runtime, "active_strategy", "S1"),
            "live_allowed": strategy_live_allowed(getattr(runtime, "active_strategy", "S1")),
        },
        "incidents": list(runtime.incidents),
        "edge": context.get("edge_estimate"),
    }
    if hasattr(runtime, "strategy_diagnostics"):
        try:
            raw["strategy_diagnostics"] = runtime.strategy_diagnostics(
                getattr(runtime, "active_strategy", "S1")
            )
        except Exception:
            raw["strategy_diagnostics"] = None
    raw["view"] = build_personal_view(runtime, raw)
    return raw


def build_personal_view(runtime: Any, snap: Mapping[str, Any]) -> Dict[str, Any]:
    """Compact ViewModel for personal trading console (Phase B)."""
    active_id = str(getattr(runtime, "active_strategy", None) or "S1")
    s3 = snap.get("s3") or {}
    s5 = snap.get("s5") or {}
    s6 = snap.get("s6") or {}
    s7_list = snap.get("s7") or []
    portfolio = (s5.get("portfolio") or {}) if isinstance(s5, dict) else {}
    strategies = (s5.get("strategies") or {}) if isinstance(s5, dict) else {}
    active_budget = strategies.get(active_id) or {}

    s7_active = next((x for x in s7_list if str(x.get("strategy_id")) == active_id), None) or {}
    meta = {
        "S1": {"name": "趋势跟踪策略", "description": "适合趋势行情，结合趋势强度和波动率过滤寻找顺势机会。"},
        "S2": {"name": "极端情绪反转策略", "description": "在极端超买超卖、资金费率和持仓变化同时满足时寻找反转机会。"},
    }.get(active_id, {"name": active_id, "description": ""})

    health_score = s7_active.get("health_score")
    if health_score is None:
        # warming / missing → use runtime score_strategy fallback
        try:
            scored = runtime.orchestrator.s7.score_strategy(active_id)
            health_score = scored.get("health_score")
            health_state = scored.get("state") or s7_active.get("state") or "ON"
        except Exception:
            health_state = str(s7_active.get("state") or "ON")
    else:
        health_state = str(s7_active.get("state") or "ON")

    signals = [
        i
        for i in (snap.get("trade_intents") or [])
        if str(i.get("strategy_id") or "") == active_id
        and not is_runtime_test_fixture(i)
        and str(i.get("status") or "")
        not in (
            "STRATEGY_SWITCH_INVALIDATED",
            "ACTIVE_STRATEGY_MISMATCH",
            "EXPIRED",
            "EXECUTED",
        )
    ][:10]

    recent_orders = [oi for oi in (snap.get("order_intents") or []) if not is_runtime_test_fixture(oi)][:20]
    eng = snap.get("engine") or {}

    return {
        "engine": {
            "available": bool(eng.get("engine_available", runtime.state != "OFFLINE")),
            "state": str(eng.get("state") or runtime.state),
            "alpha_execution": str(
                snap.get("alpha_execution")
                or getattr(runtime, "alpha_execution", "SHADOW")
            ),
            "version": str(eng.get("version") or "4.1"),
            "updated_at": eng.get("updated_at") or _now_iso(),
        },
        "active_strategy": {
            "id": active_id,
            "name": meta["name"],
            "description": meta["description"],
            "runtime_state": str(eng.get("state") or runtime.state),
            "health_score": float(health_score) if health_score is not None else None,
            "health_state": health_state,
            "risk_budget_pct_equity": float(
                active_budget.get("risk_budget")
                or (strategies.get(active_id) or {}).get("risk_budget")
                or 0.0
            ),
            "strategy_risk_used_pct_equity": float(active_budget.get("risk_used") or 0.0),
            "strategy_risk_limit_pct_equity": float(active_budget.get("risk_cap") or 0.0),
            "expectancy_R": s7_active.get("expectancy_R"),
        },
        "market_risk": {
            "regime": s3.get("regime") if isinstance(s3, dict) else "range",
            "direction_bias": float((s3 or {}).get("direction_bias") or 0.0) if isinstance(s3, dict) else 0.0,
            "market_data_latency_ms": (s6 or {}).get("market_data_latency_ms") if isinstance(s6, dict) else None,
            "exchange_connected": bool((s6 or {}).get("exchange_connected", True)) if isinstance(s6, dict) else True,
            "positions_reconciled": bool((s6 or {}).get("positions_reconciled", True)) if isinstance(s6, dict) else True,
            "orders_reconciled": bool((s6 or {}).get("orders_reconciled", True)) if isinstance(s6, dict) else True,
            "risk_engine_healthy": bool((s6 or {}).get("risk_engine_healthy", True)) if isinstance(s6, dict) else True,
            "safety_level": int((s6 or {}).get("level") or 0) if isinstance(s6, dict) else 0,
            "safety_status": str((s6 or {}).get("status") or "NORMAL") if isinstance(s6, dict) else "NORMAL",
            "new_entries_enabled": bool((s6 or {}).get("new_entries_enabled", True)) if isinstance(s6, dict) else True,
            "portfolio_risk_used_pct_equity": float(portfolio.get("risk_used") or 0.0),
            "portfolio_risk_limit_pct_equity": float(
                portfolio.get("effective_risk_budget") or portfolio.get("global_risk_limit") or 0.0
            ),
        },
        "signals": signals,
        "recent_order_intents": recent_orders,
        "last_update": _now_iso(),
    }
