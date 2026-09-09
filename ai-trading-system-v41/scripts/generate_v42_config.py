"""Generate V4.2 personal single-strategy config from current/V4.1 config."""

from __future__ import annotations

import json
import shutil
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "config"
SRC = ROOT / "system_config.json"
V41 = ROOT / "ai_trading_system_v4_1_executable_config.json"
V42 = ROOT / "ai_trading_system_v4_2_personal_single_strategy.json"


def main() -> None:
    if not V41.exists():
        shutil.copy2(SRC, V41)
        print("wrote", V41)
    else:
        print("keep existing", V41)

    cfg = json.loads(SRC.read_text(encoding="utf-8"))
    if str(cfg.get("meta", {}).get("version")) == "4.2":
        cfg = json.loads(V41.read_text(encoding="utf-8"))

    out = deepcopy(cfg)
    out["meta"] = {
        **cfg["meta"],
        "name": "AI Personal Single-Active Strategy Trading System",
        "version": "4.2",
        "runtime_model": "single_active_alpha_strategy",
        "config_type": "deterministic_event_driven_execution_schema",
        "derived_from": "4.1",
    }
    principles = list(out["meta"].get("design_principles") or [])
    for p in (
        "single_active_alpha_strategy",
        "risk_budget_contracts_only_never_renormalize_up",
        "execution_engine_is_not_allocation_target",
    ):
        if p not in principles:
            principles.append(p)
    out["meta"]["design_principles"] = principles

    out["strategy_runtime"] = {
        "selection_mode": "single_active",
        "allowed_alpha_strategies": ["S1", "S2"],
        "default_active_strategy_id": "S1",
        "system_modules_always_enabled": ["S3", "S4", "S5", "S6", "S7"],
        "max_active_alpha_strategies": 1,
        "switch_policy": {
            "atomic": True,
            "require_s6_level_below": 2,
            "block_target_health_states": ["PAUSED", "OFF"],
            "invalidate_pending_trade_intents": True,
            "cancel_unsubmitted_opening_order_intents": True,
            "cancel_submitted_opening_orders": True,
            "preserve_reduce_only_orders": True,
            "preserve_open_positions": True,
            "preserve_origin_strategy_exit_policy": True,
            "audit_required": True,
        },
    }

    out["unit_contract"] = {
        "pct_equity": "decimal_fraction",
        "returns": "decimal_fraction",
        "funding_rate": "decimal_fraction",
        "bps": "basis_points",
        "price": "quote_currency",
        "quantity": "exchange_native_or_normalized_contract_quantity",
        "R": "initial_risk_multiple",
        "timestamps": "UTC_ISO8601",
    }

    out["position_contract"] = {
        "origin_strategy_id_required": True,
        "origin_trade_intent_id_required": True,
        "entry_risk_snapshot_required": True,
        "exit_policy_snapshot_required": True,
        "strategy_switch_does_not_transfer_position_ownership": True,
    }

    out["strategy_switch_audit"] = {
        "required": True,
        "fields": [
            "timestamp",
            "operator_id",
            "previous_strategy_id",
            "new_strategy_id",
            "engine_mode",
            "s6_level",
            "target_s7_state",
            "invalidated_trade_intent_ids",
            "cancelled_order_intent_ids",
            "preserved_position_ids",
            "result",
            "reason",
        ],
    }

    out["S5_risk_budget"] = {
        "enabled": True,
        "reserve_fraction": 0.15,
        "allocation_mode": "single_active_alpha",
        "active_strategy_max_share": 0.85,
        "execution_engine_is_allocation_target": False,
        "regime_multipliers": {
            "strong_trend": {"S1": 1.2, "S2": 0.6},
            "weak_trend": {"S1": 0.9, "S2": 0.9},
            "range": {"S1": 0.3, "S2": 1.2},
            "panic": {"S1": 0.2, "S2": 0.2},
            "recovery": {"S1": 0.7, "S2": 0.8},
        },
        "health_multipliers": {
            "80_100": 1.0,
            "60_79": 0.75,
            "40_59": 0.5,
            "0_39": 0.0,
        },
        "S4_execution_multiplier": {"FULL": 1.0, "DEGRADED": 0.5, "OFF": 0.0},
        "allocation_formula": {
            "base_active_share": "1 - reserve_fraction",
            "capped_base": "min(base_active_share, active_strategy_max_share)",
            "raw_active_share": "capped_base * active_strategy_regime_multiplier * active_strategy_health_multiplier",
            "final_active_share": "min(capped_base, raw_active_share)",
            "unused_share": "1 - final_active_share",
            "invariant": "final_active_share <= capped_base; never renormalize unused risk back to active",
        },
        "risk_budget_formula": {
            "portfolio_risk_budget_pct_equity": "global_risk.max_initial_risk_all_open_positions_pct_equity * global_drawdown_multiplier * daily_loss_multiplier * S3.risk_multiplier",
            "note_S6": "S6 risk reduction is applied via new_entries_enabled / level gates, not double-multiplied here",
            "active_strategy_risk_budget_pct_equity": "min(strategy_initial_risk_cap_if_any, portfolio_risk_budget_pct_equity * final_active_share)",
        },
    }

    states = list(out.get("signal_lifecycle", {}).get("states") or [])
    for s in ("ACTIVE_STRATEGY_MISMATCH", "STRATEGY_SWITCH_INVALIDATED"):
        if s not in states:
            states.append(s)
    out.setdefault("signal_lifecycle", {})["states"] = states
    trm = out["signal_lifecycle"].setdefault("terminal_reason_mapping", {})
    trm["active_strategy_changed"] = "STRATEGY_SWITCH_INVALIDATED"
    trm["active_strategy_mismatch"] = "ACTIVE_STRATEGY_MISMATCH"

    out["internal_control_endpoints"] = {
        "base": "/internal/v1",
        "resume": "/internal/v1/control/resume",
        "strategy_switch": "/internal/v1/strategy/switch",
        "note": "Browser-facing APIs are Node /api/whale-ai/engine/*; Python is internal only",
    }

    out["changelog_v4_2"] = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "changes": [
            "runtime_model=single_active_alpha_strategy",
            "S4 removed from portfolio allocation targets",
            "S5 allocation contracts only (no renormalize-up)",
            "STRATEGY_SWITCH_INVALIDATED lifecycle state",
            "strategy_runtime.switch_policy and position_contract added",
        ],
    }

    text = json.dumps(out, ensure_ascii=False, indent=2) + "\n"
    V42.write_text(text, encoding="utf-8")
    SRC.write_text(text, encoding="utf-8")
    print("wrote", V42)
    print("updated", SRC, "version", out["meta"]["version"])
    print("v41 version", json.loads(V41.read_text(encoding="utf-8"))["meta"]["version"])


if __name__ == "__main__":
    main()
