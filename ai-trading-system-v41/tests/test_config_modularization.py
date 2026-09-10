"""Config Modularization V1 — loader, fail-closed, legacy equality."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from src.runtime.config_loader import (
    ConfigError,
    SOURCE_MODULAR,
    config_hash,
    load_effective_config,
    load_legacy_config,
    load_module_config,
    load_registry,
    load_runtime_config,
    load_strategy_config,
    load_system_config,
    strip_wrapper,
    trading_view,
)
from src.runtime.engine_runtime import EngineRuntime
from src.runtime.risk_usage import strategy_initial_risk_cap
from src.strategies.s1_trend import S1TrendStrategy
from src.strategies.s2_reversal import S2ReversalStrategy
from src.strategies.s5_risk_budget import S5RiskBudgetAllocator

ROOT = Path(__file__).resolve().parents[1]
CFG_ROOT = ROOT / "config"
LEGACY = CFG_ROOT / "ai_trading_system_v4_2_personal_single_strategy.json"
SYSTEM_CFG = CFG_ROOT / "system_config.json"


def _copy_modular(tmp_path: Path) -> Path:
    dest = tmp_path / "config"
    shutil.copytree(CFG_ROOT, dest)
    return dest


def test_system_json_load():
    doc = load_system_config()
    assert doc["schema_version"] == "1.0"
    assert doc["config_type"] == "SYSTEM"
    assert "S1_trend" not in doc
    assert "S5_risk_budget" not in doc
    assert "global_risk" in doc
    assert "per_strategy_initial_risk_cap_pct_equity" not in (doc.get("global_risk") or {})


def test_s1_independent_json_load():
    doc = load_strategy_config("S1")
    assert doc["strategy_id"] == "S1"
    assert doc["risk_per_trade_pct_equity"] == 0.004
    assert doc["strategy_initial_risk_cap_pct_equity"] == 0.0125
    assert doc["leverage_cap"] == 6.0
    assert "ema_fast" not in doc
    assert "ema_slow" not in doc


def test_s2_independent_json_load():
    doc = load_strategy_config("S2")
    assert doc["strategy_id"] == "S2"
    assert doc["strategy_initial_risk_cap_pct_equity"] == 0.0075
    assert doc["risk_per_trade_pct_equity"] == 0.003
    assert doc["leverage_cap"] == 4.0


def test_s9_independent_json_load():
    doc = load_strategy_config("S9")
    assert doc["strategy_id"] == "S9"
    assert doc["name"] == "高频动量突破"
    assert doc["release_stage"] == "DEMO_VALIDATION"
    assert doc["live_allowed"] is False
    assert doc["risk_per_trade_pct_equity"] == 0.001
    assert "display" in doc


def test_s8_research_load():
    doc = load_strategy_config("S8")
    assert doc["strategy_id"] == "S8"
    assert doc["name"] == "巨鲸行为共振"
    assert doc["release_stage"] == "RESEARCH"
    assert doc["implemented"] is False
    assert doc["demo_allowed"] is False
    assert doc["live_allowed"] is False
    assert "risk_per_trade_pct_equity" not in doc
    assert "long_entry" not in doc


def test_s3_s7_independent_module_load():
    for mid, key in (
        ("S3", "regime_rules"),
        ("S4", "decision_window_seconds"),
        ("S5", "reserve_fraction"),
        ("S6", "evaluation_interval_seconds"),
        ("S7", "health_score"),
    ):
        doc = load_module_config(mid)
        assert doc["module_id"] == mid
        assert key in doc
    s5 = load_module_config("S5")
    assert "per_strategy_initial_risk_cap_pct_equity" not in s5
    assert "global_risk" not in s5


def test_registry_resolution():
    reg = load_registry()
    alphas = [x["id"] for x in reg["alpha_strategies"]]
    modules = [x["id"] for x in reg["system_modules"]]
    assert alphas == ["S1", "S2", "S9", "S8"]
    assert modules == ["S3", "S4", "S5", "S6", "S7"]
    assert reg["alpha_strategies"][0]["config"] == "strategies/s1_trend.json"
    assert reg["alpha_strategies"][0]["implementation"] == "src.strategies.s1_trend"
    assert reg["alpha_strategies"][3]["implemented"] is False


def test_unknown_strategy_fail_closed():
    with pytest.raises(ConfigError) as exc:
        load_strategy_config("S99")
    assert exc.value.code == "CONFIG_INVALID"


def test_missing_strategy_json_fail_closed(tmp_path):
    dest = _copy_modular(tmp_path)
    (dest / "strategies" / "s1_trend.json").unlink()
    with pytest.raises(ConfigError) as exc:
        load_effective_config(dest)
    assert exc.value.code == "CONFIG_INVALID"


def test_invalid_json_fail_closed(tmp_path):
    dest = _copy_modular(tmp_path)
    (dest / "strategies" / "s1_trend.json").write_text("{nope", encoding="utf-8")
    with pytest.raises(ConfigError) as exc:
        load_effective_config(dest)
    assert exc.value.code == "CONFIG_INVALID"


def test_invalid_schema_fail_closed(tmp_path):
    dest = _copy_modular(tmp_path)
    doc = json.loads((dest / "strategies" / "s1_trend.json").read_text(encoding="utf-8"))
    doc["schema_version"] = "9.9"
    (dest / "strategies" / "s1_trend.json").write_text(json.dumps(doc), encoding="utf-8")
    with pytest.raises(ConfigError) as exc:
        load_strategy_config("S1", dest)
    assert exc.value.code == "CONFIG_INVALID"


def test_wrong_strategy_id_fail_closed(tmp_path):
    dest = _copy_modular(tmp_path)
    doc = json.loads((dest / "strategies" / "s1_trend.json").read_text(encoding="utf-8"))
    doc["strategy_id"] = "S2"
    (dest / "strategies" / "s1_trend.json").write_text(json.dumps(doc), encoding="utf-8")
    with pytest.raises(ConfigError) as exc:
        load_strategy_config("S1", dest)
    assert exc.value.code == "CONFIG_INVALID"


def test_no_silent_legacy_fallback(tmp_path):
    dest = _copy_modular(tmp_path)
    (dest / "strategies" / "s1_trend.json").unlink()
    # legacy files still present in the copied tree
    assert (dest / "ai_trading_system_v4_2_personal_single_strategy.json").exists()
    with pytest.raises(ConfigError):
        load_effective_config(dest)


def test_legacy_vs_modular_effective_equality():
    legacy = load_legacy_config(LEGACY)
    modular = load_effective_config()
    left = trading_view(legacy)
    right = trading_view(modular)
    diffs = []
    for key in ("S1", "S2", "S3", "S4", "S5", "S6", "S7"):
        if left[key] != right[key]:
            diffs.append(key)
    if diffs:
        pytest.fail(f"effective config drifted: {diffs}")
    assert right["S9"]["risk_per_trade_pct_equity"] == 0.001
    assert set(modular["strategy_runtime"]["allowed_alpha_strategies"]) == {"S1", "S2", "S9"}


def test_s1_risk_cap_leverage_constants():
    cfg = load_effective_config()
    s1 = cfg["S1_trend"]
    assert s1["risk_per_trade_pct_equity"] == 0.004
    assert s1["strategy_initial_risk_cap_pct_equity"] == 0.0125
    assert s1["leverage_cap"] == 6.0
    s2 = cfg["S2_reversal"]
    assert s2["strategy_initial_risk_cap_pct_equity"] == 0.0075


def test_s5_reads_strategy_cap():
    cfg = load_effective_config()
    assert strategy_initial_risk_cap(cfg, "S1") == 0.0125
    assert strategy_initial_risk_cap(cfg, "S2") == 0.0075
    assert strategy_initial_risk_cap(cfg, "S9") == 0.003
    assert "per_strategy_initial_risk_cap_pct_equity" not in (cfg.get("global_risk") or {})
    alloc = S5RiskBudgetAllocator(cfg)
    ctx = {
        "active_strategy_id": "S1",
        "S3.risk_multiplier": 1.0,
        "global_drawdown_multiplier": 1.0,
        "daily_loss_multiplier": 1.0,
    }
    out = alloc.allocate(regime="strong_trend", health_scores={"S1": 90, "S2": 80}, context=ctx)
    assert out["final_shares"]["S1"] == pytest.approx(0.85)
    assert out["final_shares"]["S2"] == 0.0


def test_runtime_hash_match_and_diff():
    loaded = load_runtime_config()
    s1_disk = strip_wrapper(json.loads((CFG_ROOT / "strategies" / "s1_trend.json").read_text(encoding="utf-8")))
    assert config_hash(s1_disk) == config_hash(loaded.effective["S1_trend"])
    assert loaded.section_hashes["S1"] == config_hash(loaded.effective["S1_trend"])
    changed = dict(loaded.effective["S1_trend"])
    changed["risk_per_trade_pct_equity"] = 0.003
    assert config_hash(s1_disk) != config_hash(changed)
    s5_disk = strip_wrapper(json.loads((CFG_ROOT / "modules" / "s5_risk_budget.json").read_text(encoding="utf-8")))
    s5_changed = dict(s5_disk)
    s5_changed["reserve_fraction"] = 0.2
    assert loaded.file_hashes["S1"] == config_hash(
        json.loads((CFG_ROOT / "strategies" / "s1_trend.json").read_text(encoding="utf-8"))
    )
    assert config_hash(s5_changed) != loaded.file_hashes["S1"]


def test_production_runtime_uses_modular(tmp_path):
    rt = EngineRuntime(mode="paper", store_path=tmp_path / "mod.db")
    assert rt.config_source_kind == SOURCE_MODULAR
    assert rt.orchestrator.config["S1_trend"]["risk_per_trade_pct_equity"] == 0.004
    assert Path(rt.config_path).name == "system.json"


def test_s1_s2_regression_constructors():
    cfg = load_effective_config()
    s1 = S1TrendStrategy(cfg, evaluator=None, lifecycle=None)
    s2 = S2ReversalStrategy(cfg, evaluator=None, lifecycle=None)
    assert s1.cfg["timeframe"] == "1h"
    assert s2.cfg["timeframe"] == "15m"
    assert s1.cfg is cfg["S1_trend"]
    assert s2.cfg is cfg["S2_reversal"]


def test_legacy_files_still_present_but_not_default():
    assert LEGACY.exists()
    assert SYSTEM_CFG.exists()
    legacy = json.loads(LEGACY.read_text(encoding="utf-8"))
    assert legacy.get("deprecated", {}).get("status") == "MIGRATION_ONLY"
    loaded = load_runtime_config()
    assert loaded.source_kind == SOURCE_MODULAR
    assert loaded.system_path and loaded.system_path.name == "system.json"
