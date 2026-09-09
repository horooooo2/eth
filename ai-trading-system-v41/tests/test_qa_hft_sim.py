"""Unit / integration tests for QA-HFT-SIM (not Alpha)."""

from __future__ import annotations

import os

import pytest

from src.qa.exchange_simulator import ExchangeSimulator
from src.qa.hft_sim_runner import HftSimRunner, load_qa_config


def test_qa_config_loads():
    cfg = load_qa_config()
    assert cfg["module"] == "QA-HFT-SIM"
    assert cfg["max_position_notional_usdt"] == 50
    assert cfg["test_mode"] is True


def test_simulator_idempotent_same_intent():
    sim = ExchangeSimulator(mark_price=100_000)
    intent = {
        "order_intent_id": "oi-1",
        "client_order_id": "cl-1",
        "side": "buy",
        "target_notional_usdt": 50,
        "test_mode": True,
        "execution_target": "simulator",
    }
    r1 = sim.submit_order(intent)
    r2 = sim.submit_order(intent)
    assert r1["ok"] and r2["ok"]
    assert r2.get("idempotent") is True
    assert abs(abs(sim.position_notional_usdt) - 50) < 1.5


def test_reduce_only_does_not_flip():
    sim = ExchangeSimulator(mark_price=100_000)
    sim.submit_order(
        {
            "order_intent_id": "oi-open",
            "client_order_id": "cl-open",
            "side": "buy",
            "target_notional_usdt": 50,
        }
    )
    sim.submit_order(
        {
            "order_intent_id": "oi-reduce",
            "client_order_id": "cl-reduce",
            "side": "sell",
            "target_notional_usdt": 80,
            "reduce_only": True,
        }
    )
    assert sim.position_notional_usdt == 0.0


def test_hft_sim_smoke_20_cycles_no_fault():
    runner = HftSimRunner()
    result = runner.start(cycles=20, seed=20260909, inject_failures=False)
    assert result["ok"] is True
    assert result["passed"] is True
    acc = runner._acceptance_check()
    assert acc["ok"] is True
    assert runner.metrics["duplicate_orders_executed"] == 0
    assert abs(runner.sim.position_notional_usdt) <= 50


def test_hft_sim_200_cycles_base_acceptance():
    runner = HftSimRunner()
    result = runner.start(cycles=200, seed=20260909, inject_failures=False)
    assert result["ok"] is True
    assert result["passed"] is True
    m = runner.metrics
    assert m["duplicate_orders_executed"] == 0
    assert m["orphan_order_count"] == 0
    assert m["wrong_side_unresolved"] == 0
    assert m["position_cap_unresolved"] == 0
    assert m["opening_while_s6_ge_l2"] == 0
    assert m["cycles_completed"] == 200
    assert abs(runner.sim.position_notional_usdt) <= 50


def test_hft_sim_fault_injection_smoke():
    runner = HftSimRunner()
    result = runner.start(cycles=40, seed=20260909, inject_failures=True)
    assert result["ok"] is True
    assert result["passed"] is True
    assert runner.metrics["duplicate_orders_executed"] == 0
    assert runner.metrics["wrong_side_unresolved"] == 0
    assert runner.metrics["position_cap_unresolved"] == 0


def test_flat_confirmed_before_reverse():
    runner = HftSimRunner()
    runner.test_run_id = "HFTSIM-test"
    runner.cycle_id = 1
    runner._cycle_target_leverage = 3
    runner.sim.set_leverage(3)
    # open long
    assert runner._open("LONG", fault=None)
    assert runner.state == "LONG"
    # close must confirm flat
    assert runner._close_all("LONG")
    assert runner.state == "FLAT_CONFIRMED"
    assert abs(runner.sim.position_notional_usdt) < 1e-6


def test_wrong_side_flattens_before_open():
    runner = HftSimRunner()
    runner.test_run_id = "HFTSIM-ws"
    runner.cycle_id = 1
    runner._cycle_target_leverage = 2
    runner.sim.set_leverage(2)
    runner.sim.inject_position_notional(-20)
    assert runner._correct_wrong_side("LONG")
    assert abs(runner.sim.position_notional_usdt) < 1e-6


def test_s6_blocks_opening_without_violation_metric():
    runner = HftSimRunner()
    runner.test_run_id = "HFTSIM-s6"
    runner.cycle_id = 1
    runner._cycle_target_leverage = 2
    runner.sim.set_leverage(2)
    runner.set_s6_level(3)
    assert runner._open("LONG", fault=None) is True
    assert runner.metrics["opening_while_s6_ge_l2"] == 0
    assert runner.metrics["kill_switch_block_success"] >= 1
    assert abs(runner.sim.position_notional_usdt) < 1e-6


def test_restart_recovery_no_duplicate():
    runner = HftSimRunner()
    runner.test_run_id = "HFTSIM-rst"
    runner.cycle_id = 1
    runner._cycle_target_leverage = 3
    runner.sim.set_leverage(3)
    assert runner._open("LONG", fault=None)
    pos = runner.sim.position_notional_usdt
    r = runner.simulate_restart_recovery()
    assert r["ok"] is True
    assert abs(runner.sim.position_notional_usdt - pos) < 1e-6
    assert runner.metrics["restart_duplicate_orders"] == 0


def test_lost_ack_retry_idempotent():
    sim = ExchangeSimulator(mark_price=100_000)
    intent = {
        "order_intent_id": "oi-lost",
        "client_order_id": "cl-lost",
        "side": "buy",
        "target_notional_usdt": 50,
    }
    r1 = sim.submit_order(intent, fault="lost_ack")
    assert r1.get("code") == "ACK_TIMEOUT"
    r2 = sim.submit_order(intent)
    assert r2.get("idempotent") is True
    assert abs(abs(sim.position_notional_usdt) - 50) < 1.5


@pytest.mark.skipif(os.getenv("V41_HFT_SIM_STRESS") != "1", reason="set V41_HFT_SIM_STRESS=1 for 1000-cycle")
def test_hft_sim_1000_cycles_stress():
    runner = HftSimRunner()
    result = runner.start(cycles=1000, seed=20260909, inject_failures=True)
    assert result["passed"] is True
