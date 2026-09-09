"""V4.2 S5 single-active-alpha allocation tests."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.runtime.config_validator import ConfigValidationError, validate_or_raise, validate_system_config
from src.strategies.s5_risk_budget import S5RiskBudgetAllocator

ROOT = Path(__file__).resolve().parents[1]
V42 = ROOT / "config" / "ai_trading_system_v4_2_personal_single_strategy.json"
V41 = ROOT / "config" / "ai_trading_system_v4_1_executable_config.json"
CFG = json.loads((ROOT / "config" / "system_config.json").read_text(encoding="utf-8"))


def test_s4_is_not_allocation_target():
    s5 = CFG.get("S5_risk_budget") or {}
    assert s5.get("execution_engine_is_allocation_target") is False
    assert "S4" not in (s5.get("base_strategy_shares") or {})
    for regime, row in (s5.get("regime_multipliers") or {}).items():
        assert "S4" not in row, regime


def test_single_active_s1_strong_trend_no_renormalize():
    alloc = S5RiskBudgetAllocator(CFG)
    ctx = {"active_strategy_id": "S1", "S3.risk_multiplier": 1.0, "global_drawdown_multiplier": 1.0, "daily_loss_multiplier": 1.0}
    # base 0.85, regime 1.2, health 1.0 → raw 1.02 → final min(0.85, 1.02)=0.85
    out = alloc.allocate(regime="strong_trend", health_scores={"S1": 90, "S2": 80}, context=ctx)
    assert out["allocation_mode"] == "single_active_alpha"
    assert out["final_shares"]["S1"] == pytest.approx(0.85)
    assert out["final_shares"]["S2"] == 0.0
    assert "S4" not in out["final_shares"] or out["final_shares"].get("S4", 0) == 0


def test_single_active_s1_range_contracts():
    alloc = S5RiskBudgetAllocator(CFG)
    ctx = {"active_strategy_id": "S1", "S3.risk_multiplier": 1.0, "global_drawdown_multiplier": 1.0, "daily_loss_multiplier": 1.0}
    # 0.85 * 0.3 * 1.0 = 0.255 — unused remains, no fill-up
    out = alloc.allocate(regime="range", health_scores={"S1": 90, "S2": 80}, context=ctx)
    assert out["final_shares"]["S1"] == pytest.approx(0.255)
    assert out["unused_share"] == pytest.approx(1.0 - 0.255)
    assert out["scale"] == 1.0


def test_single_active_s2_range():
    alloc = S5RiskBudgetAllocator(CFG)
    ctx = {"active_strategy_id": "S2", "S3.risk_multiplier": 1.0, "global_drawdown_multiplier": 1.0, "daily_loss_multiplier": 1.0}
    # 0.85 * 1.2 * 1.0 = 1.02 → capped 0.85
    out = alloc.allocate(regime="range", health_scores={"S1": 90, "S2": 90}, context=ctx)
    assert out["final_shares"]["S2"] == pytest.approx(0.85)
    assert out["final_shares"]["S1"] == 0.0


def test_health_reduced_does_not_renormalize():
    alloc = S5RiskBudgetAllocator(CFG)
    ctx = {"active_strategy_id": "S1", "S3.risk_multiplier": 1.0, "global_drawdown_multiplier": 1.0, "daily_loss_multiplier": 1.0}
    # base=0.85, regime=0.3, health=0.75 → 0.85*0.3*0.75=0.19125
    out = alloc.allocate(regime="range", health_scores={"S1": 70, "S2": 80}, context=ctx)
    assert out["final_shares"]["S1"] == pytest.approx(0.19125)
    assert out["unused_share"] == pytest.approx(1.0 - 0.19125)
    # Must NOT be scaled back to 0.85
    assert out["final_shares"]["S1"] < 0.85


def test_v42_config_validates():
    if V42.exists():
        cfg = json.loads(V42.read_text(encoding="utf-8"))
    else:
        cfg = CFG
    result = validate_or_raise(cfg)
    assert result["ok"] is True


def test_v42_rejects_s4_share():
    cfg = json.loads(json.dumps(CFG))
    cfg["S5_risk_budget"]["base_strategy_shares"] = {"S1": 0.5, "S4": 0.1}
    errors = validate_system_config(cfg)
    assert any("S4" in e for e in errors)


def test_v41_preserved_if_present():
    if not V41.exists():
        pytest.skip("v4.1 archive not generated yet")
    v41 = json.loads(V41.read_text(encoding="utf-8"))
    assert str(v41["meta"]["version"]).startswith("4.1")
    assert "S4" in (v41.get("S5_risk_budget", {}).get("base_strategy_shares") or {})
