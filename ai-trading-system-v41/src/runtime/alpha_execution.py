"""Alpha execution normalize (SHADOW | EXECUTE).

AccountEnvironment (OKX_DEMO | OKX_LIVE) is NOT decided here.
Node resolves it from user_exchange_keys.simulated.
"""

from __future__ import annotations

import os
from typing import Any, Dict, Mapping, Optional

ALPHA_SHADOW = "SHADOW"
ALPHA_EXECUTE = "EXECUTE"

DEPRECATED_PAPER = "DEPRECATED_ALPHA_EXECUTION_MODE_PAPER"
LEGACY_PAPER_SOURCE = "paper_adapter"
LEGACY_PAPER_MARK = "LEGACY_PAPER_POSITION"

STRATEGY_LIVE_ALLOWED: Dict[str, bool] = {
    "S1": True,
    "S2": True,
    "S8": False,
}

_ALPHA_TO_GATEWAY = {
    ALPHA_SHADOW: "node_gateway_shadow",
    ALPHA_EXECUTE: "node_gateway",
}

_warned_paper = False


def truthy(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def live_trading_enabled() -> bool:
    return truthy(os.getenv("V41_LIVE_TRADING_ENABLED"))


def strategy_live_allowed(strategy_id: Optional[str], explicit: Any = None) -> bool:
    if explicit is False:
        return False
    sid = str(strategy_id or "").strip().upper()
    if sid == "S8":
        return False
    if sid in STRATEGY_LIVE_ALLOWED:
        return bool(STRATEGY_LIVE_ALLOWED[sid])
    return explicit is True


def _result(
    alpha_execution: str,
    *,
    legacy_execution_mode: Optional[str] = None,
    deprecated: bool = False,
    deprecation_code: Optional[str] = None,
) -> Dict[str, Any]:
    return {
        "alpha_execution": alpha_execution,
        "legacy_execution_mode": legacy_execution_mode or None,
        "gateway_mode": _ALPHA_TO_GATEWAY[alpha_execution],
        "deprecated": deprecated,
        "deprecation_code": deprecation_code,
        "replacement": ALPHA_SHADOW if deprecated else None,
    }


def normalize_alpha_execution(
    raw_alpha: Optional[str] = None,
    raw_legacy: Optional[str] = None,
    *,
    warn: bool = True,
) -> Dict[str, Any]:
    """Priority: V41_ALPHA_EXECUTION > legacy V41_ENGINE_EXECUTION_MODE.

    paper / unset → SHADOW (no fake fill).
    """
    alpha = str(raw_alpha if raw_alpha is not None else os.getenv("V41_ALPHA_EXECUTION") or "").strip().upper()
    if alpha in (ALPHA_SHADOW, ALPHA_EXECUTE):
        legacy = str(raw_legacy if raw_legacy is not None else os.getenv("V41_ENGINE_EXECUTION_MODE") or "").strip().lower()
        return _result(alpha, legacy_execution_mode=legacy or None)

    legacy = str(raw_legacy if raw_legacy is not None else os.getenv("V41_ENGINE_EXECUTION_MODE") or "").strip().lower()
    if legacy == "node_gateway":
        return _result(ALPHA_EXECUTE, legacy_execution_mode=legacy)
    if legacy == "node_gateway_shadow":
        return _result(ALPHA_SHADOW, legacy_execution_mode=legacy)

    deprecated = legacy == "paper"
    if deprecated and warn:
        global _warned_paper
        if not _warned_paper:
            print(DEPRECATED_PAPER)
            _warned_paper = True
    return _result(
        ALPHA_SHADOW,
        legacy_execution_mode=legacy or None,
        deprecated=deprecated,
        deprecation_code=DEPRECATED_PAPER if deprecated else None,
    )


def resolve_runtime_execution(execution_mode_arg: Optional[str] = None) -> Dict[str, Any]:
    arg = str(execution_mode_arg or "").strip()
    if arg.upper() in (ALPHA_SHADOW, ALPHA_EXECUTE):
        return normalize_alpha_execution(raw_alpha=arg.upper())
    if arg.lower() in ("node_gateway", "node_gateway_shadow"):
        return normalize_alpha_execution(raw_legacy=arg.lower())
    return normalize_alpha_execution()


def is_legacy_paper_position(pos: Any) -> bool:
    if pos is None:
        return False
    if isinstance(pos, Mapping):
        meta = pos.get("metadata") or {}
        src = meta.get("source") or pos.get("source") or pos.get("legacy_execution_source")
        mark = meta.get("legacy_mark") or pos.get("legacy_mark")
    else:
        meta = getattr(pos, "metadata", None) or {}
        src = meta.get("source")
        mark = meta.get("legacy_mark")
    if str(mark or "") == LEGACY_PAPER_MARK:
        return True
    return str(src or "") in {LEGACY_PAPER_SOURCE, "PAPER_ADAPTER"}


def annotate_legacy_paper_metadata(metadata: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    meta = dict(metadata or {})
    if str(meta.get("source") or "") != LEGACY_PAPER_SOURCE and str(meta.get("legacy_execution_source") or "") != "PAPER_ADAPTER":
        return meta
    meta["legacy_mark"] = LEGACY_PAPER_MARK
    meta["legacy_execution_source"] = "PAPER_ADAPTER"
    meta["exclude_from_okx_reconciliation"] = True
    meta["exclude_from_live_pnl"] = True
    meta["exclude_from_strategy_health"] = True
    meta["exclude_from_expected_edge"] = True
    return meta


def annotate_position_dict(payload: Mapping[str, Any]) -> Dict[str, Any]:
    out = dict(payload)
    meta = annotate_legacy_paper_metadata(out.get("metadata"))
    out["metadata"] = meta
    if is_legacy_paper_position(out):
        out["legacy_mark"] = LEGACY_PAPER_MARK
    return out


def user_id_ready(user_id: Any) -> bool:
    return bool(str(user_id or "").strip())


FIXTURE_ORDER_INTENT_IDS = {"oi-open-1", "oi-ro-1"}
FIXTURE_CLIENT_ORDER_IDS = {"cl-1", "cl-ro"}
FIXTURE_TRADE_INTENT_IDS = {"ti-1", "ti-2"}


def is_runtime_test_fixture(item: Any) -> bool:
    """Unit-test IDs that leaked into the shared engine DB must not look current."""
    if not isinstance(item, Mapping):
        return False
    oid = str(item.get("order_intent_id") or "")
    cid = str(item.get("client_order_id") or "")
    tid = str(item.get("trade_intent_id") or item.get("intent_id") or "")
    if oid in FIXTURE_ORDER_INTENT_IDS:
        return True
    if cid in FIXTURE_CLIENT_ORDER_IDS:
        return True
    if tid in FIXTURE_TRADE_INTENT_IDS:
        return True
    return bool(item.get("test_fixture"))
