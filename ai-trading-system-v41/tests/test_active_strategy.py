"""Phase A: single-active alpha strategy invariants + switch invalidation."""

from __future__ import annotations

import json
from pathlib import Path

from src.core.orchestrator import Orchestrator
from src.core.signal_lifecycle import SignalLifecycleManager
from src.runtime.engine_runtime import EngineRuntime

ROOT = Path(__file__).resolve().parents[1]
CFG = json.loads((ROOT / "config" / "system_config.json").read_text(encoding="utf-8"))


def test_single_active_strategy_invariant_default():
    orch = Orchestrator(CFG, mode="paper")
    assert orch.active_strategy_id in ("S1", "S2")


def test_inactive_strategy_cannot_emit_intent(monkeypatch):
    orch = Orchestrator(CFG, mode="paper")
    orch.active_strategy_id = "S1"

    def fake_s1(**_kwargs):
        return [
            orch.lifecycle.create_intent(
                strategy_id="S1",
                symbol="BTC/USDT:USDT",
                direction="long",
                reference_price=100.0,
                reference_atr=1.0,
            )
        ]

    called = {"s2": 0}

    def fake_s2(**_kwargs):
        called["s2"] += 1
        return [
            orch.lifecycle.create_intent(
                strategy_id="S2",
                symbol="BTC/USDT:USDT",
                direction="short",
                reference_price=100.0,
                reference_atr=1.0,
            )
        ]

    monkeypatch.setattr(orch.s1, "generate", fake_s1)
    monkeypatch.setattr(orch.s2, "generate", fake_s2)
    monkeypatch.setattr(
        orch.data_pool,
        "get",
        lambda k, default=None: {"atr14": 1.0, "close": 100.0}.get(k, default),
    )
    orch.context = {"S3.regime": "range", "active_strategy_id": "S1"}

    out = orch.S1_S2_signal_generation()
    assert out["active_strategy_id"] == "S1"
    assert out["count"] == 1
    assert all(i["strategy_id"] == "S1" for i in out["intents"])
    assert called["s2"] == 0

    orch.active_strategy_id = "S2"
    orch.context["active_strategy_id"] = "S2"
    out2 = orch.S1_S2_signal_generation()
    assert out2["active_strategy_id"] == "S2"
    assert called["s2"] == 1
    assert all(i["strategy_id"] == "S2" for i in out2["intents"])


def test_strategy_switch_invalidates_pending_intents(monkeypatch):
    monkeypatch.setenv("V41_ENGINE_AUTOSTART", "0")
    rt = EngineRuntime(config_path=ROOT / "config" / "system_config.json", mode="paper")
    rt.active_strategy = "S1"
    rt.orchestrator.active_strategy_id = "S1"

    intent = rt.orchestrator.lifecycle.create_intent(
        strategy_id="S1",
        symbol="BTC/USDT:USDT",
        direction="long",
        reference_price=100.0,
        reference_atr=1.0,
    )
    rt.orchestrator.lifecycle.transition(intent, "WAITING_EXECUTION_CONFIRMATION")

    result = rt.switch_strategy(strategy_id="S2", reason="manual_user_switch", operator_id="tester")
    assert result["ok"] is True
    assert result["active_strategy"] == "S2"
    assert intent.intent_id in result["invalidated_trade_intent_ids"]
    assert intent.status == "STRATEGY_SWITCH_INVALIDATED"
    assert intent.metadata.get("terminal") is True
    assert rt.orchestrator.active_strategy_id == "S2"


def test_s6_blocks_switch(monkeypatch):
    monkeypatch.setenv("V41_ENGINE_AUTOSTART", "0")
    rt = EngineRuntime(config_path=ROOT / "config" / "system_config.json", mode="paper")
    rt.active_strategy = "S1"
    rt.orchestrator.active_strategy_id = "S1"
    rt.orchestrator.s6.level = 2
    result = rt.switch_strategy(strategy_id="S2", operator_id="tester")
    assert result["ok"] is False
    assert result["error"]["code"] == "STRATEGY_SWITCH_SAFETY_BLOCKED"
    assert rt.active_strategy == "S1"


def test_s7_paused_blocks_switch(monkeypatch):
    monkeypatch.setenv("V41_ENGINE_AUTOSTART", "0")
    rt = EngineRuntime(config_path=ROOT / "config" / "system_config.json", mode="paper")
    rt.active_strategy = "S1"
    rt.orchestrator.active_strategy_id = "S1"

    def paused_score(strategy_id: str):
        return {
            "strategy_id": strategy_id,
            "health_score": 10.0,
            "state": "PAUSED",
            "risk_multiplier": 0.0,
        }

    monkeypatch.setattr(rt.orchestrator.s7, "score_strategy", paused_score)
    result = rt.switch_strategy(strategy_id="S2", operator_id="tester")
    assert result["ok"] is False
    assert result["error"]["code"] == "TARGET_STRATEGY_UNHEALTHY"
    assert rt.active_strategy == "S1"


def test_lifecycle_switch_invalidated_is_terminal():
    mgr = SignalLifecycleManager(CFG)
    intent = mgr.create_intent(
        strategy_id="S1",
        symbol="BTC/USDT:USDT",
        direction="long",
        reference_price=1.0,
        reference_atr=1.0,
    )
    ids = mgr.invalidate_strategy_intents("S1")
    assert intent.intent_id in ids
    assert intent.status == "STRATEGY_SWITCH_INVALIDATED"
