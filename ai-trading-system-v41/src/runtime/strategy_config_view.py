"""Read-only effective strategy config view for the admin center.

Does not write files or change trading behavior.
"""

from __future__ import annotations

from typing import Any, Dict, Mapping, Optional

from src.runtime.alpha_execution import live_trading_enabled, strategy_live_allowed
from src.runtime.config_loader import (
    SOURCE_LEGACY,
    SOURCE_MODULAR,
    SECTION_KEYS,
    canonicalize,
    config_hash,
    strip_wrapper,
)
from src.runtime.demo_execute_v1 import DEMO_EXECUTE_V1_ALLOWED


def _release_flag(runtime: Any, sid: str, key: str, default: bool = False) -> bool:
    docs = getattr(getattr(runtime, "config_bundle", None), "documents", None) or {}
    doc = docs.get(str(sid).upper()) or {}
    if isinstance(doc, Mapping) and key in doc:
        return bool(doc.get(key))
    if key == "demo_allowed" and str(sid).upper() == "S1":
        return bool(DEMO_EXECUTE_V1_ALLOWED.get("S1"))
    if key == "live_allowed":
        return bool(strategy_live_allowed(sid))
    return default

SECRET_KEYS = {
    "api_key",
    "secret",
    "passphrase",
    "password",
    "token",
    "jwt",
    "session",
    "authorization",
    "private_key",
    "access_key",
}

KNOWN_IDS = ("S1", "S2", "S9", "S8", "S3", "S4", "S5", "S6", "S7")


def _is_secret_key(key: str) -> bool:
    kn = str(key or "").strip().lower().replace("-", "_")
    if kn in SECRET_KEYS:
        return True
    return kn.endswith("_secret") or kn.endswith("_passphrase") or kn.endswith("_password") or kn.endswith("_token")


def redact_secrets(value: Any) -> Any:
    if isinstance(value, list):
        return [redact_secrets(v) for v in value]
    if not isinstance(value, Mapping):
        return value
    out: Dict[str, Any] = {}
    for key, item in value.items():
        out[str(key)] = "[REDACTED]" if _is_secret_key(str(key)) else redact_secrets(item)
    return out


def logical_config_path(runtime: Any, config_id: Optional[str] = None) -> str:
    bundle = getattr(runtime, "config_bundle", None)
    if bundle is not None and config_id:
        mapped = (getattr(bundle, "logical_paths", None) or {}).get(str(config_id).upper())
        if mapped:
            return str(mapped).replace("\\", "/")
    kind = str(getattr(runtime, "config_source_kind", "") or "")
    if kind == SOURCE_MODULAR:
        return "config/system.json"
    path = getattr(runtime, "config_path", None)
    if path is None:
        return "config/system.json"
    name = str(path).replace("\\", "/").split("/")[-1]
    if name in {
        "ai_trading_system_v4_2_personal_single_strategy.json",
        "system_config.json",
        "ai_trading_system_v4_1_executable_config.json",
        "system.json",
    }:
        return f"config/{name}"
    return "config/system.json"


def source_kind_of(runtime: Any) -> str:
    kind = str(getattr(runtime, "config_source_kind", "") or "")
    if kind in (SOURCE_MODULAR, SOURCE_LEGACY):
        return kind
    return SOURCE_MODULAR


def extract_section(config: Mapping[str, Any], config_id: str) -> Any:
    sid = str(config_id or "").strip().upper()
    key = SECTION_KEYS.get(sid)
    if not key:
        return None
    return config.get(key)


def _effective_for(runtime: Any, sid: str) -> Any:
    cfg = getattr(getattr(runtime, "orchestrator", None), "config", None) or {}
    bundle = getattr(runtime, "config_bundle", None)
    if sid == "S8":
        docs = getattr(bundle, "documents", None) or {}
        return docs.get("S8")
    if sid == "S5" and source_kind_of(runtime) == SOURCE_LEGACY:
        s5 = cfg.get("S5_risk_budget")
        global_risk = cfg.get("global_risk")
        if s5 is None and global_risk is None:
            return None
        out = {}
        if s5 is not None:
            out["S5_risk_budget"] = s5
        if global_risk is not None:
            out["global_risk"] = global_risk
        return out or None
    section = extract_section(cfg, sid)
    if section is not None:
        return section
    docs = getattr(bundle, "documents", None) or {}
    return docs.get(sid)


def list_strategy_configs(runtime: Any) -> Dict[str, Any]:
    state = str(getattr(runtime, "state", "OFFLINE") or "OFFLINE").upper()
    active = str(getattr(runtime, "active_strategy", "") or "") or None
    kind = source_kind_of(runtime)
    return {
        "online": state not in ("", "OFFLINE"),
        "state": state,
        "active_strategy": active,
        "config_path": logical_config_path(runtime),
        "source_kind": kind,
        "live_permission": live_trading_enabled(),
        "config_status": getattr(runtime, "config_status", "OK"),
        "items": [
            {
                "id": sid,
                "config_path": logical_config_path(runtime, sid),
                "effective_config_hash": config_hash(redact_secrets(_effective_for(runtime, sid)))
                if _effective_for(runtime, sid) is not None
                else None,
                "demo_allowed": _release_flag(runtime, sid, "demo_allowed"),
                "live_allowed": bool(strategy_live_allowed(sid)),
                "live_permission": live_trading_enabled(),
            }
            for sid in KNOWN_IDS
        ],
    }


def get_strategy_config(runtime: Any, config_id: str) -> Optional[Dict[str, Any]]:
    sid = str(config_id or "").strip().upper()
    if sid not in KNOWN_IDS:
        return None
    state = str(getattr(runtime, "state", "OFFLINE") or "OFFLINE").upper()
    raw = _effective_for(runtime, sid)
    redacted = None if raw is None else redact_secrets(raw)
    hashed = None
    if redacted is not None:
        hashed = config_hash(redact_secrets(strip_wrapper(redacted) if isinstance(redacted, Mapping) else redacted))
        if sid == "S8":
            hashed = config_hash(redacted)
    return {
        "id": sid,
        "online": state not in ("", "OFFLINE"),
        "state": state,
        "active_strategy": str(getattr(runtime, "active_strategy", "") or "") or None,
        "config_path": logical_config_path(runtime, sid),
        "source_kind": source_kind_of(runtime),
        "effective_config": redacted,
        "effective_config_hash": hashed,
        "demo_allowed": _release_flag(runtime, sid, "demo_allowed"),
        "live_allowed": bool(strategy_live_allowed(sid)),
        "live_permission": live_trading_enabled(),
    }


# Re-export for tests that imported canonicalize from this module historically.
__all__ = [
    "KNOWN_IDS",
    "canonicalize",
    "config_hash",
    "extract_section",
    "get_strategy_config",
    "list_strategy_configs",
    "redact_secrets",
    "strip_wrapper",
]
