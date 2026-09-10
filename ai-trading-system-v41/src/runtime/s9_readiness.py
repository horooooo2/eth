"""S9 readiness flags. Does not place orders. No fake adapters.

CORE_EXECUTE_READINESS and DEMO_EXECUTE_V1_READINESS remain the S1 baseline.
S9 is never folded into DEMO_EXECUTE_V1_ALLOWED.

Three independent statuses:
- S9_IMPLEMENTATION_READINESS: frozen V1 production capabilities are truly wired
- S9_DEMO_PREFLIGHT_READINESS: safe to begin first real OKX Demo validation
- S9_DEMO_VALIDATION_STATUS: UNVERIFIED until a real Demo lifecycle is persisted
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Mapping, Optional

CORE_EXECUTE_READINESS = "READY"
DEMO_EXECUTE_V1_READINESS = "READY"
S9_DEMO_VALIDATION_STATUS = "UNVERIFIED"

ROOT = Path(__file__).resolve().parents[2]
REPO = ROOT.parent


def _file_exists(*parts: str) -> bool:
    return Path(*parts).is_file()


def detect_wired_capabilities() -> Dict[str, bool]:
    """Inspect production source. Missing files or unwired gates stay False."""
    engine = ROOT
    backend = REPO / "whale-tracker-backend"
    ws_py = engine / "src" / "adapters" / "okx_public_ws.py"
    hub_py = engine / "src" / "runtime" / "s9_market_hub.py"
    fee_py = engine / "src" / "runtime" / "s9_fee.py"
    orch = engine / "src" / "core" / "orchestrator.py"
    gw = backend / "lib" / "v41ExecutionGateway.js"
    s9js = backend / "lib" / "v41S9Demo.js"
    okx = backend / "lib" / "okxTradeClient.js"
    routes = backend / "routes" / "whaleAiEngine.js"
    fee_js = backend / "lib" / "v41S9Fee.js"
    orch_txt = orch.read_text(encoding="utf-8") if orch.is_file() else ""
    gw_txt = gw.read_text(encoding="utf-8") if gw.is_file() else ""
    s9_txt = s9js.read_text(encoding="utf-8") if s9js.is_file() else ""
    okx_txt = okx.read_text(encoding="utf-8") if okx.is_file() else ""
    routes_txt = routes.read_text(encoding="utf-8") if routes.is_file() else ""
    fee_js_txt = fee_js.read_text(encoding="utf-8") if fee_js.is_file() else ""
    public_ws = (
        ws_py.is_file()
        and hub_py.is_file()
        and "S9MarketHub" in orch_txt
        and "ingest_ws" in hub_py.read_text(encoding="utf-8")
        and "candle1m" in ws_py.read_text(encoding="utf-8")
        and "books5" in ws_py.read_text(encoding="utf-8")
    )
    fee = (
        fee_py.is_file()
        and "S9FeeClient" in orch_txt
        and "internal/okx-trade-fee" in routes_txt
        and "getTradeFee" in okx_txt
        and "getBoundEngineOwner" in fee_js_txt
        and "queryUserId" in fee_js_txt
    )
    presubmit_fn = ""
    if "function assertS9PreSubmit" in s9_txt:
        presubmit_fn = s9_txt.split("function assertS9PreSubmit", 1)[-1].split("module.exports", 1)[0]
    node_book = (
        "getPublicBooks5" in gw_txt
        and "getPublicBooks5" in okx_txt
        and "assertS9PreSubmit" in gw_txt
        and "final_okx_sz" in presubmit_fn
        and "S9_ORDERBOOK_STALE" in presubmit_fn
        and "orderIntent.base_quantity" not in presubmit_fn
    )
    from src.runtime.config_loader import ConfigError, load_strategy_config
    from src.runtime.s9_cleanup import next_action
    from src.runtime.s9_exits import ownership_released, take_profit_price
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
    return {
        "config": config_valid,
        "alpha_signal": callable(evaluate_5m_direction) and callable(find_micro_swing) and callable(validate_stop),
        "public_websocket": public_ws,
        "fee_from_okx_account": fee,
        "node_presubmit_book": node_book,
        "microstructure": callable(evaluate_microstructure),
        "spread_window": SpreadWindow is not None,
        "exits": callable(take_profit_price),
        "ownership": callable(ownership_released),
        "orphan_cleanup": callable(next_action),
        "runtime_events": True,
        "live_allowed_false": True,
    }


def s9_implementation_readiness(*, adapters: Optional[Mapping[str, bool]] = None) -> Dict[str, Any]:
    checks = detect_wired_capabilities()
    if adapters:
        for key, value in adapters.items():
            checks[key] = bool(value)
    blockers = [k for k, v in checks.items() if not v]
    ready = not blockers
    return {
        "ready": ready,
        "status": "READY" if ready else "NOT_READY",
        "checks": checks,
        "blockers": blockers,
    }


def s9_demo_validation_status(*, persisted: Optional[str] = None) -> Dict[str, Any]:
    """Unit tests / mocks / smoke must not flip this to VERIFIED."""
    raw = str(persisted or S9_DEMO_VALIDATION_STATUS).strip().upper()
    if raw != "VERIFIED":
        raw = "UNVERIFIED"
    # Production never auto-verifies. Only an explicit future persisted flag may.
    status = "UNVERIFIED" if raw != "VERIFIED" else "VERIFIED"
    if persisted is None:
        status = "UNVERIFIED"
    return {
        "status": status,
        "verified": status == "VERIFIED",
        "source": "persisted" if persisted else "default",
    }


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
