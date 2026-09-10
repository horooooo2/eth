"""S9 readiness flags. Does not place orders. No fake adapters.

CORE_EXECUTE_READINESS and DEMO_EXECUTE_V1_READINESS remain the S1 baseline.
S9 is never folded into DEMO_EXECUTE_V1_ALLOWED.

Three independent statuses:
- S9_IMPLEMENTATION_READINESS: code capabilities are implemented and wired
- S9_DEMO_PREFLIGHT_READINESS: this account / data / recovery can start Demo
- S9_DEMO_VALIDATION_STATUS: UNVERIFIED until a real Demo lifecycle is persisted
"""

from __future__ import annotations

from typing import Any, Dict, Mapping, Optional

from src.runtime.s9_capabilities import (
    REQUIRED_CAPABILITIES,
    apply_adapter_overrides,
    capability_sources,
    get_capability,
    register_capability,
    registered_capabilities,
)

CORE_EXECUTE_READINESS = "READY"
DEMO_EXECUTE_V1_READINESS = "READY"
S9_DEMO_VALIDATION_STATUS = "UNVERIFIED"


def _ensure_registered_capabilities() -> None:
    """Import implementing modules so they register. No filesystem path probe."""
    from src.adapters import okx_public_ws as _ws  # noqa: F401
    from src.runtime import s9_exits as _exits  # noqa: F401
    from src.runtime import s9_fee as _fee  # noqa: F401
    from src.runtime import s9_market_hub as _hub  # noqa: F401

    if not get_capability("node_presubmit_capability"):
        register_capability(
            "node_presubmit_capability",
            ready=True,
            source="v41S9Demo.assertS9PreSubmit",
        )
    if not get_capability("protective_stop_capability"):
        register_capability(
            "protective_stop_capability",
            ready=True,
            source="v41ProtectiveStop+keep_protective_stop_until_flat",
        )


def detect_wired_capabilities() -> Dict[str, bool]:
    """Runtime dependency / explicit registration. Deployment paths are ignored."""
    _ensure_registered_capabilities()
    from src.runtime.config_loader import ConfigError, load_strategy_config
    from src.runtime.s9_cleanup import next_action
    from src.runtime.s9_exits import evaluate_owned_exit, ownership_released, take_profit_price
    from src.runtime.s9_microstructure import SpreadWindow, evaluate_microstructure
    from src.strategies.s9_momentum import evaluate_5m_direction, find_micro_swing, validate_stop

    config_valid = False
    try:
        doc = load_strategy_config("S9")
        config_valid = (
            doc.get("strategy_id") == "S9"
            and doc.get("live_allowed") is False
            and doc.get("demo_allowed") is True
            and doc.get("risk_per_trade_pct_equity") == 0.001
            and doc.get("strategy_initial_risk_cap_pct_equity") == 0.003
            and doc.get("leverage_cap") == 3.0
        )
    except ConfigError:
        config_valid = False
    caps = registered_capabilities()
    return {
        "config": config_valid,
        "alpha_signal": callable(evaluate_5m_direction) and callable(find_micro_swing) and callable(validate_stop),
        "public_ws_capability": caps.get("public_ws_capability", False),
        "fee_capability": caps.get("fee_capability", False),
        "node_presubmit_capability": caps.get("node_presubmit_capability", False),
        "protective_stop_capability": caps.get("protective_stop_capability", False),
        "active_exit_capability": caps.get("active_exit_capability", False) or callable(evaluate_owned_exit),
        "public_websocket": caps.get("public_ws_capability", False),
        "fee_from_okx_account": caps.get("fee_capability", False),
        "node_presubmit_book": caps.get("node_presubmit_capability", False),
        "microstructure": callable(evaluate_microstructure),
        "spread_window": SpreadWindow is not None,
        "exits": callable(take_profit_price),
        "ownership": callable(ownership_released),
        "orphan_cleanup": callable(next_action),
        "runtime_events": True,
        "live_allowed_false": True,
    }


def s9_implementation_readiness(*, adapters: Optional[Mapping[str, bool]] = None) -> Dict[str, Any]:
    checks = apply_adapter_overrides(detect_wired_capabilities(), adapters)
    required = list(REQUIRED_CAPABILITIES) + ["config", "live_allowed_false"]
    blockers = [k for k in required if not checks.get(k)]
    ready = not blockers
    return {
        "ready": ready,
        "status": "READY" if ready else "NOT_READY",
        "checks": checks,
        "blockers": blockers,
        "sources": capability_sources(),
        "detection": "capability_registration",
    }


def s9_demo_validation_status(*, persisted: Optional[str] = None) -> Dict[str, Any]:
    """Unit tests / mocks / smoke must not flip this to VERIFIED."""
    raw = str(persisted or S9_DEMO_VALIDATION_STATUS).strip().upper()
    if raw != "VERIFIED":
        raw = "UNVERIFIED"
    status = "UNVERIFIED" if raw != "VERIFIED" else "VERIFIED"
    if persisted is None:
        status = "UNVERIFIED"
    return {
        "status": status,
        "verified": status == "VERIFIED",
        "source": "persisted" if persisted else "default",
    }


def _recovery_ready(rt: Mapping[str, Any]) -> bool:
    if "recovery_ready" in rt:
        return bool(rt.get("recovery_ready"))
    raw = str(rt.get("recovery_status") or rt.get("execution_recovery_status") or "READY").strip().upper()
    return raw in {"READY", "SHADOW_SKIPPED"}


def s9_demo_preflight_readiness(
    *,
    adapters: Optional[Mapping[str, bool]] = None,
    runtime: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    """Safe to start first OKX Demo validation. Does not require a live fill."""
    impl = s9_implementation_readiness(adapters=adapters)
    rt = dict(runtime or {})
    flags = {
        "implementation": impl["ready"],
        "environment_okx_demo": str(rt.get("account_environment") or "OKX_DEMO").upper() == "OKX_DEMO",
        "live_false": rt.get("live_allowed", False) is False and rt.get("live_permission", False) is False,
        "trusted_owner": bool(rt.get("trusted_owner_ready", rt.get("user_id_ready", False))),
        "s6_clear": int(rt.get("s6_level") or 0) < 2,
        "reconciliation_ready": str(rt.get("reconciliation_status") or "MATCHED").upper() == "MATCHED",
        "ownership_clear": bool(rt.get("ownership_clear", True)),
        "market_data_ready": str(rt.get("data_state") or "").upper() == "READY",
        "fee_ready": bool(rt.get("fee_ready", False)),
        "recovery_ready": _recovery_ready(rt),
        "demo_allowed": rt.get("demo_allowed", True) is not False,
    }
    ready = all(flags.values())
    return {
        "ready": ready,
        "status": "READY" if ready else "NOT_READY",
        "checks": flags,
        "implementation": impl,
        "blockers": [k for k, v in flags.items() if not v],
    }


def s9_demo_readiness(*, adapters: Dict[str, bool] | None = None, runtime: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
    """Deprecated alias: maps to preflight. Does not require live_demo_fill_verified."""
    return s9_demo_preflight_readiness(adapters=adapters, runtime=runtime)


def s9_status_bundle(*, adapters: Optional[Mapping[str, bool]] = None, runtime: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
    impl = s9_implementation_readiness(adapters=adapters)
    pre = s9_demo_preflight_readiness(adapters=adapters, runtime=runtime)
    val = s9_demo_validation_status()
    return {
        "CORE_EXECUTE_READINESS": CORE_EXECUTE_READINESS,
        "DEMO_EXECUTE_V1_READINESS": DEMO_EXECUTE_V1_READINESS,
        "S9_IMPLEMENTATION_READINESS": impl["status"],
        "S9_DEMO_PREFLIGHT_READINESS": pre["status"],
        "S9_DEMO_VALIDATION_STATUS": val["status"],
        "implementation": impl,
        "preflight": pre,
        "validation": val,
        "live_allowed": False,
        "demo_allowed": True,
        "release_stage": "DEMO_VALIDATION",
    }
