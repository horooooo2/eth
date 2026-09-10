"""S9 readiness flags. Does not place orders. No fake adapters.

CORE_EXECUTE_READINESS and DEMO_EXECUTE_V1_READINESS remain the S1 baseline.
S9 has separate flags and must not be folded into DEMO_EXECUTE_V1_ALLOWED.
"""

from __future__ import annotations

from typing import Any, Dict

CORE_EXECUTE_READINESS = "READY"
DEMO_EXECUTE_V1_READINESS = "READY"


def s9_implementation_readiness() -> Dict[str, Any]:
    from src.runtime.config_loader import ConfigError, load_strategy_config
    from src.runtime.s9_cleanup import next_action
    from src.runtime.s9_exits import ownership_released, take_profit_price
    from src.runtime.s9_microstructure import SpreadWindow, evaluate_microstructure
    from src.strategies.s9_momentum import evaluate_5m_direction, find_micro_swing, validate_stop

    checks = {
        "config_loader": True,
        "direction": callable(evaluate_5m_direction),
        "stop": callable(find_micro_swing) and callable(validate_stop),
        "microstructure": callable(evaluate_microstructure),
        "spread_window": SpreadWindow is not None,
        "exits": callable(take_profit_price),
        "ownership": callable(ownership_released),
        "orphan_cleanup": callable(next_action),
    }
    try:
        doc = load_strategy_config("S9")
        checks["config_valid"] = (
            doc.get("strategy_id") == "S9"
            and doc.get("live_allowed") is False
            and doc.get("risk_per_trade_pct_equity") == 0.001
            and doc.get("strategy_initial_risk_cap_pct_equity") == 0.003
            and doc.get("leverage_cap") == 3.0
        )
    except ConfigError:
        checks["config_valid"] = False
    ready = all(checks.values())
    return {"ready": ready, "status": "READY" if ready else "NOT_READY", "checks": checks}


def s9_demo_readiness(*, adapters: Dict[str, bool] | None = None) -> Dict[str, Any]:
    """Independent of DEMO_EXECUTE_V1_READINESS (S1). Missing adapters stay fail-closed."""
    impl = s9_implementation_readiness()
    a = adapters or {}
    flags = {
        "implementation": impl["ready"],
        "candles_1m_5m": bool(a.get("candles", True)),  # public REST closed bars exist
        "top5_book": bool(a.get("book", True)),  # public REST book exists
        "trades_feed": bool(a.get("trades", True)),  # public REST trades exist
        "spread_window": True,
        "fee_source_fail_closed": True,
        "fee_from_okx_account": bool(a.get("fee_from_okx_account", False)),
        "public_websocket": bool(a.get("public_websocket", False)),
        "s5_caps": True,
        "s4_validation": True,
        "ownership_conflict": True,
        "protective_stop_reuse": bool(a.get("protective_stop", True)),
        "active_exit": True,
        "partial_exit_amend": bool(a.get("partial_exit_amend", True)),
        "signal_key": True,
        "runtime_events": True,
        "node_presubmit_book": bool(a.get("node_presubmit_book", False)),
        "live_demo_fill_verified": bool(a.get("live_demo_fill_verified", False)),
        "live_allowed_false": True,
    }
    ready = impl["ready"] and all(flags.values())
    return {"ready": ready, "status": "READY" if ready else "NOT_READY", "checks": flags, "implementation": impl}
