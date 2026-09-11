"""S9 pending candidate lifecycle. No Alpha param changes. No orders."""

from __future__ import annotations

import asyncio
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

from src.core.orchestrator import Orchestrator
from src.runtime.config_loader import load_runtime_config
from src.runtime.engine_runtime import EngineRuntime
from src.runtime.s9_candle_identity import closed_candle_id
from src.runtime.s9_pending_candidate import (
    S9_PENDING_TTL_SECONDS,
    S9_TRANSIENT_MARKET_BLOCKERS,
    is_transient_market_block_only,
)
from src.strategies import s9_momentum as s9mod
from tests.test_s9_momentum import _bars, _candidate_payload

ROOT = Path(__file__).resolve().parents[1]
CFG = ROOT / "config" / "system_config.json"


def _orch(monkeypatch, *, one=None, five=None, cand=None):
    one = one if one is not None else _bars(40, start=100, step=0.2, freq="1min")
    five = five if five is not None else _bars(80, start=100, step=0.8, freq="5min")
    cand = cand if cand is not None else _candidate_payload(one)
    loaded = load_runtime_config()
    orch = Orchestrator(loaded.effective, mode="paper")
    orch.active_strategy_id = "S9"
    orch.s9_closed_1m = one
    orch.s9_closed_5m = five
    orch.context.setdefault("S3.regime", "range")
    calls = {"n": 0}

    def fake_eval(**_kw):
        calls["n"] += 1
        return dict(cand)

    monkeypatch.setattr(s9mod, "evaluate_entry", fake_eval)
    return orch, cand, calls


def test_transient_blocker_list_is_market_readiness_only():
    assert S9_TRANSIENT_MARKET_BLOCKERS == {"MARKET_DATA_STALE", "MARKET_DATA_NOT_READY"}
    assert is_transient_market_block_only(["MARKET_DATA_STALE"])
    assert is_transient_market_block_only(["MARKET_DATA_NOT_READY"])
    assert not is_transient_market_block_only(["MARKET_DATA_WARMING_UP"])
    assert not is_transient_market_block_only(["MARKET_DATA_STALE", "ALPHA_OPENINGS_PAUSED"])
    assert not is_transient_market_block_only(["S9_DIRECTION_NEUTRAL"])
    assert not is_transient_market_block_only([])


def test_a_ready_candidate_does_not_create_pending(monkeypatch):
    orch, cand, calls = _orch(monkeypatch)
    orch._s9_generate(emit_intents=True, extra_block=[])
    assert calls["n"] == 1
    assert orch._pending_s9_candidate is None
    assert orch.context.get("s9_candidate", {}).get("signal_key") == cand["signal_key"]
    diag = orch.diagnostics["S9"]
    assert diag.evaluation_count == 1
    assert diag.candidate_count == 1
    assert diag.pending_candidate_created_count == 0
    assert diag.pending_candidate_active is False
    assert orch.s9._last_signal_key == cand["signal_key"]


def test_b_stale_creates_pending_without_consuming(monkeypatch):
    orch, cand, calls = _orch(monkeypatch)
    orch._s9_generate(emit_intents=True, extra_block=["MARKET_DATA_STALE"])
    assert calls["n"] == 1
    diag = orch.diagnostics["S9"]
    assert diag.evaluation_count == 1
    assert diag.candidate_count == 0
    assert diag.pending_candidate_created_count == 1
    assert diag.pending_candidate_active is True
    pending = orch._pending_s9_candidate
    assert pending is not None
    assert pending.signal_key == cand["signal_key"]
    assert pending.closed_1m_id == closed_candle_id(orch.s9_closed_1m.index[-1])
    assert pending.direction == "LONG"
    assert pending.entry_mode
    assert (pending.expires_at - pending.created_at).total_seconds() == S9_PENDING_TTL_SECONDS
    assert orch.s9._last_signal_key is None
    assert orch.context.get("s9_candidate") is None
    snap = diag.to_dict(active=True, runtime_state="RUNNING", alpha_opening_enabled=True, last_tick_at=None)
    assert snap["pending_candidate_count"] == 1
    assert snap["pending_candidate_signal_key"] == cand["signal_key"]
    assert snap["pending_candidate_closed_1m_id"] == pending.closed_1m_id
    assert snap["pending_candidate_age_ms"] is not None
    assert snap["pending_candidate_expires_in_ms"] is not None
    assert "payload" not in snap
    assert "stop_price" not in snap


def test_b_not_ready_also_creates_pending(monkeypatch):
    orch, cand, _calls = _orch(monkeypatch)
    orch._s9_generate(emit_intents=True, extra_block=["MARKET_DATA_NOT_READY"])
    assert orch._pending_s9_candidate is not None
    assert orch._pending_s9_candidate.signal_key == cand["signal_key"]
    assert orch.diagnostics["S9"].candidate_count == 0
    assert orch.s9._last_signal_key is None


def test_warming_up_does_not_create_pending(monkeypatch):
    orch, _cand, _calls = _orch(monkeypatch)
    orch._s9_generate(emit_intents=True, extra_block=["MARKET_DATA_WARMING_UP"])
    assert orch._pending_s9_candidate is None
    assert orch.diagnostics["S9"].pending_candidate_created_count == 0
    assert orch.diagnostics["S9"].candidate_count == 0


def test_c_ready_resumes_without_reeval(monkeypatch):
    orch, cand, calls = _orch(monkeypatch)
    orch._s9_generate(emit_intents=True, extra_block=["MARKET_DATA_STALE"])
    evals = orch.diagnostics["S9"].evaluation_count
    assert evals == 1
    assert calls["n"] == 1
    orch._s9_generate(emit_intents=True, extra_block=[])
    assert calls["n"] == 1
    assert orch.diagnostics["S9"].evaluation_count == evals
    resumed = orch.context.get("s9_candidate") or {}
    assert resumed.get("signal_key") == cand["signal_key"]
    assert orch.s9._last_signal_key == cand["signal_key"]
    diag = orch.diagnostics["S9"]
    assert diag.candidate_count == 1
    assert diag.pending_candidate_resumed_count == 1
    assert diag.pending_candidate_active is False
    assert orch._pending_s9_candidate is None


def test_d_ready_ticks_only_one_candidate(monkeypatch):
    orch, cand, calls = _orch(monkeypatch)
    orch._s9_generate(emit_intents=True, extra_block=["MARKET_DATA_STALE"])
    orch._s9_generate(emit_intents=True, extra_block=[])
    orch.context["s9_candidate"] = None
    orch._s9_generate(emit_intents=True, extra_block=[])
    orch.context["s9_candidate"] = None
    orch._s9_generate(emit_intents=True, extra_block=[])
    assert calls["n"] == 1
    assert orch.diagnostics["S9"].evaluation_count == 1
    assert orch.diagnostics["S9"].candidate_count == 1
    assert orch.context.get("s9_candidate") is None
    assert orch._pending_s9_candidate is None
    assert orch.s9._last_signal_key == cand["signal_key"]


def test_e_pending_expires_after_20s_and_does_not_submit(monkeypatch):
    orch, _cand, calls = _orch(monkeypatch)
    orch._s9_generate(emit_intents=True, extra_block=["MARKET_DATA_STALE"])
    pending = orch._pending_s9_candidate
    assert pending is not None
    orch._pending_s9_candidate = replace(
        pending,
        expires_at=datetime.now(timezone.utc) - timedelta(seconds=1),
    )
    orch._s9_generate(emit_intents=True, extra_block=[])
    assert calls["n"] == 1
    assert orch._pending_s9_candidate is None
    assert orch.context.get("s9_candidate") is None
    assert orch.s9._last_signal_key is None
    diag = orch.diagnostics["S9"]
    assert diag.candidate_count == 0
    assert diag.pending_candidate_expired_count == 1
    assert diag.pending_candidate_resumed_count == 0


def test_f_next_closed_1m_invalidates_old_pending(monkeypatch):
    one = _bars(40, start=100, step=0.2, freq="1min", end=pd.Timestamp("2026-09-10 10:00", tz="UTC"))
    five = _bars(80, start=100, step=0.8, freq="5min")
    cand = _candidate_payload(one)
    orch, _cand, calls = _orch(monkeypatch, one=one, five=five, cand=cand)
    orch._s9_generate(emit_intents=True, extra_block=["MARKET_DATA_STALE"])
    old_key = cand["signal_key"]
    assert orch._pending_s9_candidate is not None
    nxt = _bars(40, start=100, step=0.2, freq="1min", end=pd.Timestamp("2026-09-10 10:01", tz="UTC"))
    nxt_cand = _candidate_payload(nxt)
    calls["n"] = 0

    def fake_eval(**_kw):
        calls["n"] += 1
        return dict(nxt_cand)

    monkeypatch.setattr(s9mod, "evaluate_entry", fake_eval)
    orch.s9_closed_1m = nxt
    orch._s9_generate(emit_intents=True, extra_block=[])
    assert calls["n"] == 1
    assert orch.diagnostics["S9"].pending_candidate_invalidated_count == 1
    assert orch._pending_s9_candidate is None
    submitted = orch.context.get("s9_candidate") or {}
    assert submitted.get("signal_key") == nxt_cand["signal_key"]
    assert submitted.get("signal_key") != old_key
    assert orch.diagnostics["S9"].candidate_count == 1


def test_g_engine_pause_and_stop_clear_pending(monkeypatch, tmp_path):
    orch, _cand, _calls = _orch(monkeypatch)
    orch._s9_generate(emit_intents=True, extra_block=["MARKET_DATA_STALE"])
    assert orch._pending_s9_candidate is not None
    orch.drop_pending_s9_candidate("ENGINE_PAUSE")
    assert orch._pending_s9_candidate is None
    assert orch.diagnostics["S9"].pending_candidate_invalidated_count == 1

    orch2, _c2, _n2 = _orch(monkeypatch)
    orch2._s9_generate(emit_intents=True, extra_block=["MARKET_DATA_STALE"])
    monkeypatch.setenv("V41_ENGINE_AUTOSTART", "0")
    rt = EngineRuntime(config_path=CFG, mode="paper", tick_interval_sec=0.05, store_path=tmp_path / "s9pend.db")
    rt.state = "RUNNING"
    rt.orchestrator._pending_s9_candidate = orch2._pending_s9_candidate
    rt.orchestrator.diagnostics = orch2.diagnostics

    async def _run():
        paused = await rt.pause()
        assert paused["state"] == "PAUSED"
        assert rt.orchestrator._pending_s9_candidate is None
        await rt.shutdown()
        assert rt.orchestrator._pending_s9_candidate is None

    asyncio.run(_run())


def test_g_alpha_openings_paused_extra_block_drops_pending(monkeypatch):
    orch, _cand, _calls = _orch(monkeypatch)
    orch._s9_generate(emit_intents=True, extra_block=["MARKET_DATA_STALE"])
    assert orch._pending_s9_candidate is not None
    orch._s9_generate(emit_intents=False, extra_block=["ALPHA_OPENINGS_PAUSED"])
    assert orch._pending_s9_candidate is None
    assert orch.context.get("s9_candidate") is None
    assert orch.diagnostics["S9"].pending_candidate_invalidated_count == 1


def test_h_owned_position_and_pending_opening_drop_pending(monkeypatch):
    orch, _cand, calls = _orch(monkeypatch)
    orch._s9_generate(emit_intents=True, extra_block=["MARKET_DATA_STALE"])
    orch.context["owned_open_positions"] = [{"quantity": 1, "origin_strategy_id": "S9", "symbol": "BTC-USDT-SWAP"}]
    orch._s9_generate(emit_intents=True, extra_block=[])
    assert orch._pending_s9_candidate is None
    assert orch.context.get("s9_candidate") is None
    assert orch.diagnostics["S9"].pending_candidate_invalidated_count == 1
    assert calls["n"] == 1

    orch2, _c2, _n2 = _orch(monkeypatch)
    orch2._s9_generate(emit_intents=True, extra_block=["MARKET_DATA_STALE"])
    orch2.context["pending_opening_orders"] = 1
    orch2._s9_generate(emit_intents=True, extra_block=[])
    assert orch2._pending_s9_candidate is None
    assert orch2.context.get("s9_candidate") is None


def test_i_s4_fail_does_not_restore_pending_or_retry_signal(monkeypatch):
    orch, cand, calls = _orch(monkeypatch)
    orch._s9_generate(emit_intents=True, extra_block=["MARKET_DATA_STALE"])
    orch._s9_generate(emit_intents=True, extra_block=[])
    assert orch.context.get("s9_candidate", {}).get("signal_key") == cand["signal_key"]
    assert orch._pending_s9_candidate is None
    out = orch._s9_s4_validate()
    assert out.get("confirmed") == []
    orch.context["s9_candidate"] = None
    orch._s9_generate(emit_intents=True, extra_block=[])
    assert calls["n"] == 1
    assert orch._pending_s9_candidate is None
    assert orch.context.get("s9_candidate") is None
    assert orch.s9._last_signal_key == cand["signal_key"]
    assert orch.diagnostics["S9"].candidate_count == 1
    assert orch.diagnostics["S9"].pending_candidate_resumed_count == 1


def test_j_same_candle_rest_ws_timezone_evaluates_alpha_once(monkeypatch):
    utc = pd.Timestamp("2026-09-10 12:57:00", tz="UTC")
    one = _bars(40, start=100, step=0.2, freq="1min", end=utc)
    five = _bars(80, start=100, step=0.8, freq="5min")
    cand = _candidate_payload(one)
    orch, _cand, calls = _orch(monkeypatch, one=one, five=five, cand=cand)
    orch._s9_generate(emit_intents=True, extra_block=["MARKET_DATA_STALE"])
    assert calls["n"] == 1
    shifted = one.copy()
    shifted.index = shifted.index.tz_convert("Asia/Shanghai")
    orch.s9_closed_1m = shifted
    orch._s9_generate(emit_intents=True, extra_block=[])
    assert calls["n"] == 1
    assert closed_candle_id(shifted.index[-1]) == closed_candle_id(one.index[-1])
    assert (orch.context.get("s9_candidate") or {}).get("signal_key") == cand["signal_key"]
    orch.context["s9_candidate"] = None
    epoch_index = pd.DatetimeIndex([pd.Timestamp(closed_candle_id(one.index[-1]), unit="ms", tz="UTC")])
    rest = one.copy()
    rest.index = one.index[:-1].append(epoch_index)
    orch.s9_closed_1m = rest
    orch._s9_generate(emit_intents=True, extra_block=[])
    assert calls["n"] == 1
    assert orch.diagnostics["S9"].evaluation_count == 1
    assert orch.diagnostics["S9"].candidate_count == 1


def test_alpha_no_trade_is_terminal_not_pending(monkeypatch):
    one = _bars(40, start=100, step=0.2, freq="1min")
    five = _bars(80, start=100, step=0.8, freq="5min")
    loaded = load_runtime_config()
    orch = Orchestrator(loaded.effective, mode="paper")
    orch.active_strategy_id = "S9"
    orch.s9_closed_1m = one
    orch.s9_closed_5m = five

    def fake_eval(**_kw):
        return {
            "decision": "NO_TRADE",
            "direction": None,
            "reason_codes": ["S9_DIRECTION_NEUTRAL"],
            "signal_key": None,
            "diagnostics": {},
            "s9_entry_mode": "TREND_CONTINUATION",
        }

    monkeypatch.setattr(s9mod, "evaluate_entry", fake_eval)
    orch._s9_generate(emit_intents=True, extra_block=["MARKET_DATA_STALE"])
    assert orch._pending_s9_candidate is None
    assert orch.diagnostics["S9"].pending_candidate_created_count == 0
    assert orch.diagnostics["S9"].evaluation_count == 1
