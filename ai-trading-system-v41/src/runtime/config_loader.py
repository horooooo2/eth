"""Unified modular config loader.

Production runtime reads MODULAR_JSON only:
  config/system.json
  + config/strategy_registry.json
  + config/strategies/*.json
  + config/modules/*.json

Legacy monolith files are MIGRATION_ONLY. They are never a silent fallback.
"""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Mapping, Optional

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG_ROOT = ROOT / "config"

SOURCE_MODULAR = "MODULAR_JSON"
SOURCE_LEGACY = "LEGACY_CONFIG"

SCHEMA_VERSION = "1.0"

WRAPPER_KEYS = {
    "schema_version",
    "config_type",
    "strategy_id",
    "module_id",
    "name",
    "release_stage",
    "implemented",
    "demo_allowed",
    "live_allowed",
    "deprecated",
    "deprecation_status",
    "canonical_source",
    "replacement",
    "display",
    "summary_zh",
    "entry_summary_zh",
    "risk_summary_zh",
    "exit_summary_zh",
}

SECTION_KEYS = {
    "S1": "S1_trend",
    "S2": "S2_reversal",
    "S9": "S9_high_frequency_momentum",
    "S3": "S3_regime",
    "S4": "S4_execution",
    "S5": "S5_risk_budget",
    "S6": "S6_anomaly",
    "S7": "S7_health",
}

REQUIRED_ALPHA_IDS = ("S1", "S2", "S9", "S8")
REQUIRED_MODULE_IDS = ("S3", "S4", "S5", "S6", "S7")
IMPLEMENTED_ALPHA_IDS = ("S1", "S2", "S9")

RISK_PCT_UPPER = 0.25
LEVERAGE_UPPER = 25.0
RISK_CAP_KEYS = {
    "risk_per_trade_pct_equity",
    "strategy_initial_risk_cap_pct_equity",
    "countertrend_risk_cap_pct_equity",
    "max_initial_risk_all_open_positions_pct_equity",
    "max_same_direction_risk_pct_equity",
    "max_correlated_bucket_risk_pct_equity",
    "single_symbol_initial_risk_cap_pct_equity",
}

LEGACY_FILENAMES = {
    "ai_trading_system_v4_2_personal_single_strategy.json",
    "system_config.json",
    "ai_trading_system_v4_1_executable_config.json",
}


class ConfigError(ValueError):
    def __init__(self, code: str, message: str, details: Optional[Dict[str, Any]] = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details or {}

    def to_dict(self) -> Dict[str, Any]:
        return {"code": self.code, "message": str(self), "details": self.details}


@dataclass
class LoadedConfig:
    source_kind: str
    effective: Dict[str, Any]
    registry: Dict[str, Any]
    documents: Dict[str, Any] = field(default_factory=dict)
    logical_paths: Dict[str, str] = field(default_factory=dict)
    file_hashes: Dict[str, str] = field(default_factory=dict)
    section_hashes: Dict[str, str] = field(default_factory=dict)
    system_path: Optional[Path] = None
    config_status: str = "OK"


def config_root(root: Optional[Path] = None) -> Path:
    if root is not None:
        return Path(root)
    return Path(DEFAULT_CONFIG_ROOT)


def canonicalize(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {k: canonicalize(value[k]) for k in sorted(value)}
    if isinstance(value, list):
        return [canonicalize(v) for v in value]
    return value


def config_hash(value: Any) -> str:
    payload = json.dumps(canonicalize(value), ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def strip_wrapper(doc: Mapping[str, Any]) -> Dict[str, Any]:
    return {k: deepcopy(v) for k, v in doc.items() if k not in WRAPPER_KEYS}


def _fail(code: str, message: str, **details: Any) -> None:
    raise ConfigError(code, message, details)


def _read_json(path: Path, *, logical: str) -> Any:
    if not path.exists() or not path.is_file():
        _fail("CONFIG_INVALID", f"missing config file: {logical}", path=logical, reason="missing")
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        _fail("CONFIG_INVALID", f"unreadable config file: {logical}", path=logical, reason=str(exc))
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        _fail("CONFIG_INVALID", f"invalid JSON: {logical}", path=logical, reason=str(exc))
    if not isinstance(data, dict):
        _fail("CONFIG_INVALID", f"config root must be an object: {logical}", path=logical)
    return data


def _logical(rel: str) -> str:
    rel_n = str(rel).replace("\\", "/").lstrip("/")
    if rel_n.startswith("config/"):
        return rel_n
    return f"config/{rel_n}"


def _safe_rel_path(rel: str) -> Path:
    text = str(rel or "").replace("\\", "/").strip()
    if not text or text.startswith("/") or ":" in text:
        _fail("CONFIG_INVALID", "registry path rejected", path=text, reason="unsafe")
    parts = Path(text).parts
    if ".." in parts:
        _fail("CONFIG_INVALID", "registry path rejected", path=text, reason="traversal")
    return Path(*parts)


def _require_schema(doc: Mapping[str, Any], *, logical: str, config_type: str, id_key: Optional[str], expected_id: Optional[str]) -> None:
    ver = str(doc.get("schema_version") or "")
    if ver != SCHEMA_VERSION:
        _fail("CONFIG_INVALID", f"schema_version must be {SCHEMA_VERSION}: {logical}", path=logical, schema_version=ver)
    ctype = str(doc.get("config_type") or "")
    if ctype != config_type:
        _fail("CONFIG_INVALID", f"config_type must be {config_type}: {logical}", path=logical, config_type=ctype)
    if id_key and expected_id is not None:
        got = str(doc.get(id_key) or "")
        if got != expected_id:
            _fail("CONFIG_INVALID", f"wrong id in {logical}", path=logical, expected=expected_id, actual=got)


def _validate_risk_fields(doc: Mapping[str, Any], *, logical: str) -> None:
    for key, value in doc.items():
        if key in WRAPPER_KEYS:
            continue
        if isinstance(value, Mapping):
            _validate_risk_fields(value, logical=logical)
            continue
        if isinstance(value, list):
            for item in value:
                if isinstance(item, Mapping):
                    _validate_risk_fields(item, logical=logical)
            continue
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            continue
        num = float(value)
        if key in RISK_CAP_KEYS and not (0.0 <= num < RISK_PCT_UPPER):
            _fail("CONFIG_INVALID", f"risk field out of range: {key}", path=logical, field=key, value=num)
        if key == "reserve_fraction" and not (0.0 <= num < 1.0):
            _fail("CONFIG_INVALID", "reserve_fraction out of range", path=logical, value=num)
        if key == "leverage_cap" and not (0.0 < num <= LEVERAGE_UPPER):
            _fail("CONFIG_INVALID", "leverage_cap out of range", path=logical, value=num)


def load_registry(root: Optional[Path] = None) -> Dict[str, Any]:
    cfg_root = config_root(root)
    logical = "config/strategy_registry.json"
    doc = _read_json(cfg_root / "strategy_registry.json", logical=logical)
    _require_schema(doc, logical=logical, config_type="STRATEGY_REGISTRY", id_key=None, expected_id=None)
    alphas = doc.get("alpha_strategies")
    modules = doc.get("system_modules")
    if not isinstance(alphas, list) or not isinstance(modules, list):
        _fail("CONFIG_INVALID", "registry must contain alpha_strategies and system_modules lists", path=logical)
    alpha_ids = [str(item.get("id") or "") for item in alphas if isinstance(item, Mapping)]
    module_ids = [str(item.get("id") or "") for item in modules if isinstance(item, Mapping)]
    if tuple(alpha_ids) != REQUIRED_ALPHA_IDS:
        _fail("CONFIG_INVALID", "strategy registry alpha mismatch", path=logical, expected=list(REQUIRED_ALPHA_IDS), actual=alpha_ids)
    if tuple(module_ids) != REQUIRED_MODULE_IDS:
        _fail("CONFIG_INVALID", "strategy registry module mismatch", path=logical, expected=list(REQUIRED_MODULE_IDS), actual=module_ids)
    for item in list(alphas) + list(modules):
        if not isinstance(item, Mapping):
            _fail("CONFIG_INVALID", "registry entry must be an object", path=logical)
        if not item.get("config"):
            _fail("CONFIG_INVALID", f"registry entry {item.get('id')} missing config", path=logical)
        etype = str(item.get("type") or "")
        eid = str(item.get("id") or "")
        if eid in REQUIRED_ALPHA_IDS and etype != "ALPHA_STRATEGY":
            _fail("CONFIG_INVALID", f"{eid} type must be ALPHA_STRATEGY", path=logical)
        if eid in REQUIRED_MODULE_IDS and etype != "SYSTEM_MODULE":
            _fail("CONFIG_INVALID", f"{eid} type must be SYSTEM_MODULE", path=logical)
    return doc


def _entry_map(registry: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    for item in list(registry.get("alpha_strategies") or []) + list(registry.get("system_modules") or []):
        out[str(item["id"])] = dict(item)
    return out


def load_system_config(root: Optional[Path] = None) -> Dict[str, Any]:
    cfg_root = config_root(root)
    logical = "config/system.json"
    doc = _read_json(cfg_root / "system.json", logical=logical)
    _require_schema(doc, logical=logical, config_type="SYSTEM", id_key=None, expected_id=None)
    for key in SECTION_KEYS.values():
        if key in doc:
            _fail("CONFIG_INVALID", f"system.json must not contain {key}", path=logical, field=key)
    _validate_risk_fields(doc, logical=logical)
    return doc


def _load_registered_doc(entry: Mapping[str, Any], *, root: Path, expect_type: str, id_key: str) -> Dict[str, Any]:
    eid = str(entry.get("id") or "")
    rel = _safe_rel_path(str(entry.get("config") or ""))
    logical = _logical(rel.as_posix())
    path = root / rel
    doc = _read_json(path, logical=logical)
    _require_schema(doc, logical=logical, config_type=expect_type, id_key=id_key, expected_id=eid)
    _validate_risk_fields(doc, logical=logical)
    return doc


def load_strategy_config(strategy_id: str, root: Optional[Path] = None) -> Dict[str, Any]:
    sid = str(strategy_id or "").strip().upper()
    registry = load_registry(root)
    entry = _entry_map(registry).get(sid)
    if entry is None or str(entry.get("type")) != "ALPHA_STRATEGY":
        _fail("CONFIG_INVALID", f"unknown strategy: {sid}", strategy_id=sid)
    return _load_registered_doc(entry, root=config_root(root), expect_type="ALPHA_STRATEGY", id_key="strategy_id")


def load_module_config(module_id: str, root: Optional[Path] = None) -> Dict[str, Any]:
    mid = str(module_id or "").strip().upper()
    registry = load_registry(root)
    entry = _entry_map(registry).get(mid)
    if entry is None or str(entry.get("type")) != "SYSTEM_MODULE":
        _fail("CONFIG_INVALID", f"unknown module: {mid}", module_id=mid)
    return _load_registered_doc(entry, root=config_root(root), expect_type="SYSTEM_MODULE", id_key="module_id")


def _assemble_effective(system_doc: Mapping[str, Any], documents: Mapping[str, Mapping[str, Any]]) -> Dict[str, Any]:
    effective = strip_wrapper(system_doc)
    for sid in IMPLEMENTED_ALPHA_IDS:
        effective[SECTION_KEYS[sid]] = strip_wrapper(documents[sid])
    for mid in REQUIRED_MODULE_IDS:
        effective[SECTION_KEYS[mid]] = strip_wrapper(documents[mid])
    return effective


def trading_view(config: Mapping[str, Any]) -> Dict[str, Any]:
    """Canonical trading-effective view for equality. Drops schema/source/registry metadata."""
    system = {
        k: deepcopy(v)
        for k, v in config.items()
        if k not in set(SECTION_KEYS.values()) and k not in WRAPPER_KEYS
    }
    return {
        "system": system,
        "S1": deepcopy(config.get("S1_trend") or {}),
        "S2": deepcopy(config.get("S2_reversal") or {}),
        "S9": deepcopy(config.get("S9_high_frequency_momentum") or {}),
        "S3": deepcopy(config.get("S3_regime") or {}),
        "S4": deepcopy(config.get("S4_execution") or {}),
        "S5": deepcopy(config.get("S5_risk_budget") or {}),
        "S6": deepcopy(config.get("S6_anomaly") or {}),
        "S7": deepcopy(config.get("S7_health") or {}),
    }


def load_legacy_config(path: str | Path) -> Dict[str, Any]:
    """Explicit legacy compatibility / migration-test loader. Never used as a silent fallback."""
    p = Path(path)
    logical = _logical(p.name)
    doc = _read_json(p, logical=logical)
    return doc


def load_effective_config(root: Optional[Path] = None) -> Dict[str, Any]:
    return load_runtime_config(root).effective


def load_runtime_config(root: Optional[Path] = None) -> LoadedConfig:
    """Production loader. Fail closed. No legacy fallback."""
    cfg_root = config_root(root)
    registry = load_registry(cfg_root)
    system_doc = load_system_config(cfg_root)
    entries = _entry_map(registry)
    documents: Dict[str, Any] = {"SYSTEM": system_doc}
    logical_paths = {"SYSTEM": "config/system.json", "REGISTRY": "config/strategy_registry.json"}
    file_hashes = {
        "SYSTEM": config_hash(system_doc),
        "REGISTRY": config_hash(registry),
    }

    for sid in REQUIRED_ALPHA_IDS:
        doc = load_strategy_config(sid, cfg_root)
        documents[sid] = doc
        logical_paths[sid] = _logical(str(entries[sid]["config"]))
        file_hashes[sid] = config_hash(doc)
    for mid in REQUIRED_MODULE_IDS:
        doc = load_module_config(mid, cfg_root)
        documents[mid] = doc
        logical_paths[mid] = _logical(str(entries[mid]["config"]))
        file_hashes[mid] = config_hash(doc)

    effective = _assemble_effective(system_doc, documents)
    from src.runtime.config_validator import validate_system_config

    errors = validate_system_config(effective)
    if errors:
        _fail("CONFIG_INVALID", "assembled effective config failed schema", errors=errors)

    section_hashes = {sid: config_hash(strip_wrapper(documents[sid])) for sid in (*REQUIRED_ALPHA_IDS, *REQUIRED_MODULE_IDS)}
    section_hashes["SYSTEM"] = config_hash(strip_wrapper(system_doc))
    section_hashes["EFFECTIVE"] = config_hash(trading_view(effective))

    return LoadedConfig(
        source_kind=SOURCE_MODULAR,
        effective=effective,
        registry=registry,
        documents=documents,
        logical_paths=logical_paths,
        file_hashes=file_hashes,
        section_hashes=section_hashes,
        system_path=cfg_root / "system.json",
        config_status="OK",
    )


def load_legacy_runtime_config(path: str | Path) -> LoadedConfig:
    """Explicit legacy mode for tests that pass a monolith path."""
    p = Path(path)
    doc = load_legacy_config(p)
    from src.runtime.config_validator import validate_system_config

    errors = validate_system_config(doc)
    if errors:
        _fail("CONFIG_INVALID", "legacy config failed schema", errors=errors, path=str(p))
    logical = _logical(p.name) if p.name in LEGACY_FILENAMES else f"config/{p.name}"
    documents = {"SYSTEM": doc}
    logical_paths = {"SYSTEM": logical}
    for sid, key in SECTION_KEYS.items():
        if key in doc:
            documents[sid] = doc[key]
            logical_paths[sid] = logical
    section_hashes = {
        sid: config_hash(documents[sid]) for sid in SECTION_KEYS if sid in documents
    }
    return LoadedConfig(
        source_kind=SOURCE_LEGACY,
        effective=doc,
        registry={},
        documents=documents,
        logical_paths=logical_paths,
        file_hashes={"SYSTEM": config_hash(doc)},
        section_hashes=section_hashes,
        system_path=p,
        config_status="OK",
    )
