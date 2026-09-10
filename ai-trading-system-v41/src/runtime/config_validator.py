"""Fail-closed validation for V4.2 (and compatible) system configs."""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Sequence


class ConfigValidationError(ValueError):
    def __init__(self, errors: Sequence[str]) -> None:
        self.errors = list(errors)
        super().__init__("; ".join(self.errors))


def validate_system_config(config: Mapping[str, Any]) -> List[str]:
    errors: List[str] = []
    meta = config.get("meta") or {}
    version = str(meta.get("version") or "")
    runtime = config.get("strategy_runtime") or {}
    s5 = config.get("S5_risk_budget") or {}
    lifecycle = config.get("signal_lifecycle") or {}
    features = config.get("feature_definitions") or {}

    if version.startswith("4.2") or str(meta.get("runtime_model")) == "single_active_alpha_strategy":
        allowed = list(runtime.get("allowed_alpha_strategies") or [])
        default = runtime.get("default_active_strategy_id")
        if runtime.get("max_active_alpha_strategies") != 1:
            errors.append("max_active_alpha_strategies must be 1")
        if default not in ("S1", "S2", "S9"):
            errors.append("default_active_strategy_id must be S1, S2 or S9")
        if set(allowed) not in ({"S1", "S2"}, {"S1", "S2", "S9"}):
            errors.append("allowed_alpha_strategies must be S1+S2 or S1+S2+S9")
        if s5.get("allocation_mode") != "single_active_alpha":
            errors.append("S5 allocation_mode must be single_active_alpha for V4.2")
        if s5.get("execution_engine_is_allocation_target") is not False:
            errors.append("S4/execution must not be an allocation target")
        if "S4" in (s5.get("base_strategy_shares") or {}):
            errors.append("S4 must not appear in base_strategy_shares")
        for regime, row in (s5.get("regime_multipliers") or {}).items():
            if isinstance(row, dict) and "S4" in row:
                errors.append(f"regime_multipliers.{regime} must not include S4")

        reserve = float(s5.get("reserve_fraction", -1))
        if not (0.0 <= reserve < 1.0):
            errors.append("reserve_fraction must be in [0, 1)")
        max_share = float(s5.get("active_strategy_max_share", 1.0 - reserve))
        if max_share > (1.0 - reserve) + 1e-12:
            errors.append("active_strategy_max_share must be <= 1-reserve")
        if max_share <= 0:
            errors.append("active_strategy_max_share must be > 0")

        states = set(lifecycle.get("states") or [])
        for required in ("STRATEGY_SWITCH_INVALIDATED", "ACTIVE_STRATEGY_MISMATCH"):
            if required not in states:
                errors.append(f"signal_lifecycle.states missing {required}")

    # Common checks
    global_risk = config.get("global_risk") or {}
    cap = float(global_risk.get("max_initial_risk_all_open_positions_pct_equity", 0) or 0)
    if cap <= 0:
        errors.append("global portfolio risk cap must be > 0")

    unit = config.get("unit_contract") or {}
    if version.startswith("4.2") and unit.get("pct_equity") != "decimal_fraction":
        errors.append("unit_contract.pct_equity must be decimal_fraction")

    # Soft: referenced features existence is audited elsewhere; ensure mapping is a dict
    if features is not None and not isinstance(features, dict):
        errors.append("feature_definitions must be an object")

    return errors


def validate_or_raise(config: Mapping[str, Any]) -> Dict[str, Any]:
    errors = validate_system_config(config)
    if errors:
        raise ConfigValidationError(errors)
    return {"ok": True, "version": (config.get("meta") or {}).get("version"), "errors": []}
