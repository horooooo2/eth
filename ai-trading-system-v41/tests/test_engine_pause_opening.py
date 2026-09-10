"""STOP/PAUSE must disable Alpha openings; START re-enables explicitly."""

from __future__ import annotations

import asyncio
from pathlib import Path

from src.runtime.engine_runtime import EngineRuntime
from src.runtime.strategy_diagnostics import StrategyDiagnostics

ROOT = Path(__file__).resolve().parents[1]
CFG = ROOT / "config" / "system_config.json"


def _rt(monkeypatch, tmp_path) -> EngineRuntime:
    monkeypatch.setenv("V41_ENGINE_AUTOSTART", "0")
    rt = EngineRuntime(config_path=CFG, mode="paper", tick_interval_sec=0.05, store_path=tmp_path / "pause.db")
    return rt


def test_pause_disables_opening_and_start_restores(monkeypatch, tmp_path):
    rt = _rt(monkeypatch, tmp_path)
    rt.state = "RUNNING"
    rt.alpha_opening_enabled = True
    rt.orchestrator.alpha_opening_enabled = True

    async def _run():
        paused = await rt.pause()
        assert paused["state"] == "PAUSED"
        assert paused["alpha_opening_enabled"] is False
        assert rt.state == "PAUSED"
        assert rt.alpha_opening_enabled is False
        assert rt.orchestrator.alpha_opening_enabled is False
        assert rt.orchestrator.context["alpha_opening_enabled"] is False

        started = await rt.start()
        assert started["state"] == "RUNNING"
        assert started["alpha_opening_enabled"] is True
        assert rt.alpha_opening_enabled is True
        await rt.shutdown()

    asyncio.run(_run())


def test_pause_freezes_evaluation_count(monkeypatch, tmp_path):
    rt = _rt(monkeypatch, tmp_path)
    diag = StrategyDiagnostics("S1")
    rt.orchestrator.diagnostics = {"S1": diag}
    cycles = {"n": 0}

    async def fake_cycle(**_kwargs):
        cycles["n"] += 1
        diag.evaluation_count = cycles["n"]
        diag.last_evaluated_at = "2026-09-10T00:00:00Z"
        return {"pending_order_intents": [], "opened_position_candidates": []}

    rt.orchestrator.run_cycle = fake_cycle

    async def _run():
        await rt.start()
        await asyncio.sleep(0.18)
        assert diag.evaluation_count >= 1
        mid = int(diag.evaluation_count)
        await rt.pause()
        assert rt.state == "PAUSED"
        assert rt.alpha_opening_enabled is False
        frozen = int(diag.evaluation_count)
        await asyncio.sleep(0.18)
        assert int(diag.evaluation_count) == frozen
        assert frozen >= mid
        await rt.start()
        assert rt.state == "RUNNING"
        assert rt.alpha_opening_enabled is True
        await asyncio.sleep(0.18)
        assert int(diag.evaluation_count) > frozen
        await rt.shutdown()

    asyncio.run(_run())
