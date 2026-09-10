"""Explicit S9 capability registration.

Implementation readiness is computed from registered service flags,
not from deployment filesystem paths.
"""

from __future__ import annotations

from typing import Any, Dict, Mapping, Optional

REQUIRED_CAPABILITIES = (
    "public_ws_capability",
    "fee_capability",
    "node_presubmit_capability",
    "protective_stop_capability",
    "active_exit_capability",
)

ADAPTER_ALIASES = {
    "public_websocket": "public_ws_capability",
    "fee_from_okx_account": "fee_capability",
    "node_presubmit_book": "node_presubmit_capability",
}

_REGISTRY: Dict[str, Dict[str, Any]] = {}


def register_capability(name: str, *, ready: bool = True, source: str = "") -> None:
    key = str(name or "").strip()
    if not key:
        return
    _REGISTRY[key] = {"ready": bool(ready), "source": str(source or "")}


def get_capability(name: str) -> bool:
    row = _REGISTRY.get(str(name or "").strip()) or {}
    return bool(row.get("ready"))


def registered_capabilities() -> Dict[str, bool]:
    return {name: get_capability(name) for name in REQUIRED_CAPABILITIES}


def capability_sources() -> Dict[str, str]:
    return {key: str(row.get("source") or "") for key, row in _REGISTRY.items()}


def apply_adapter_overrides(
    checks: Mapping[str, bool],
    adapters: Optional[Mapping[str, bool]] = None,
) -> Dict[str, bool]:
    out = dict(checks)
    if not adapters:
        return out
    for key, value in adapters.items():
        canon = ADAPTER_ALIASES.get(key, key)
        out[canon] = bool(value)
        if key != canon:
            out[key] = bool(value)
    return out
