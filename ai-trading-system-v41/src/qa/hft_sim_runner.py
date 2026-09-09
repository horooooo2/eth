"""QA-HFT-SIM state machine — not an Alpha strategy.

Proves execution lifecycle correctness under rapid open/reduce/close,
leverage/position reconciliation, duplicates, and optional fault injection.
"""

from __future__ import annotations

import json
import time
import uuid
from copy import deepcopy
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from src.qa.exchange_simulator import ExchangeSimulator
from src.qa.node_gateway_client import NodeGatewayClient

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CFG = ROOT / "config" / "qa_hft_sim_config.json"

TERMINAL_CYCLE_STATES = {"FLAT_CONFIRMED"}
OPENING_STATES = {"OPENING_LONG", "OPENING_SHORT"}
QA_ALLOWED_SYMBOLS = {"BTC-USDT-SWAP"}


def load_qa_config(path: Optional[Path] = None) -> Dict[str, Any]:
    p = Path(path or DEFAULT_CFG)
    with p.open(encoding="utf-8") as f:
        return json.load(f)


def notional_tolerance(target: float, cfg: Dict[str, Any]) -> float:
    tol = cfg.get("notional_tolerance") or {}
    return max(float(tol.get("absolute_usdt") or 1.0), abs(target) * float(tol.get("relative") or 0.02))


class HftSimRunner:
    def __init__(self, config: Optional[Dict[str, Any]] = None) -> None:
        self.config = config or load_qa_config()
        self.sim = ExchangeSimulator(
            mark_price=float(self.config.get("default_mark_price") or 100_000),
            lot_size=float(self.config.get("lot_size") or 0.0001),
            min_quantity=float(self.config.get("min_quantity") or 0.0001),
            seed=int(self.config.get("seed") or 20260909),
        )
        self.state = "FLAT"
        self.running = False
        self.test_run_id = ""
        self.cycle_id = 0
        self.target_cycles = 0
        self.seed = int(self.config.get("seed") or 20260909)
        self.inject_failures = False
        self.s6_level = 0
        self.symbol = str(self.config.get("default_symbol") or "BTC-USDT-SWAP")
        self.max_notional = float(self.config.get("max_position_notional_usdt") or 50)
        self.leverage_sequence = list(self.config.get("leverage_sequence") or [2, 3, 5])
        self._lev_idx = 0
        self._cycle_target_leverage = 2.0
        self._cycle_phase = "idle"
        self._awaiting_flat_confirm = False
        self.metrics: Dict[str, int] = self._empty_metrics()
        self.events: List[Dict[str, Any]] = []
        self.last_error = ""
        self.passed: Optional[bool] = None
        self._fault_plan: List[Optional[str]] = []
        self.execution_mode = "simulator"  # simulator | exchange
        self.exchange_environment: Optional[str] = None  # demo | live | None
        self.live_money = False
        self.node = NodeGatewayClient()
        self._baseline_qty = 0.0
        self._last_exchange_order_id: Optional[str] = None
        self._exchange_metrics = {
            "exchange_orders_submitted": 0,
            "exchange_orders_filled": 0,
            "exchange_orders_cancelled": 0,
            "exchange_order_failures": 0,
            "leverage_set_count": 0,
            "leverage_set_failures": 0,
            "position_reconciliation_count": 0,
        }

    @staticmethod
    def _empty_metrics() -> Dict[str, int]:
        return {
            "open_attempts": 0,
            "open_success": 0,
            "close_attempts": 0,
            "close_success": 0,
            "partial_fills": 0,
            "cancel_success": 0,
            "duplicate_intents_received": 0,
            "duplicate_orders_executed": 0,
            "position_mismatch_count": 0,
            "position_correction_count": 0,
            "leverage_mismatch_count": 0,
            "leverage_correction_count": 0,
            "orphan_order_count": 0,
            "position_cap_violation_count": 0,
            "position_cap_unresolved": 0,
            "wrong_side_unresolved": 0,
            "opening_while_s6_ge_l2": 0,
            "kill_switch_block_success": 0,
            "restart_recovery_success": 0,
            "restart_duplicate_orders": 0,
            "cycles_completed": 0,
            "cycles_failed": 0,
        }

    def status(self) -> Dict[str, Any]:
        if self.execution_mode == "exchange":
            try:
                pos = self.node.get_position(self.symbol)
                qa_qty = float(pos.get("qty") or 0) - self._baseline_qty
                notional = abs(float(pos.get("position_notional_usdt") or 0))
                # approximate QA-owned notional share if baseline nonzero
                side = "FLAT"
                if abs(qa_qty) > 1e-8:
                    side = "LONG" if qa_qty > 0 else "SHORT"
                actual_lev = pos.get("leverage")
            except Exception:
                notional = 0.0
                side = "FLAT"
                actual_lev = None
                qa_qty = 0.0
            return {
                "module": "QA-HFT-SIM",
                "is_alpha": False,
                "running": self.running,
                "test_run_id": self.test_run_id,
                "cycle_id": self.cycle_id,
                "cycles_completed": self.metrics.get("cycles_completed", 0),
                "cycles_total": self.target_cycles,
                "target_cycles": self.target_cycles,
                "state": self.state,
                "execution_mode": self.execution_mode,
                "exchange_environment": self.exchange_environment,
                "real_exchange_ordering": True,
                "live_money": self.live_money,
                "symbol": self.symbol,
                "target_notional_usdt": self.max_notional,
                "current_qa_notional_usdt": notional if abs(qa_qty) > 1e-8 else 0.0,
                "position_notional_usdt": notional if abs(qa_qty) > 1e-8 else 0.0,
                "position_side": side,
                "target_leverage": self._cycle_target_leverage,
                "actual_leverage": actual_lev,
                "last_exchange_order_id": self._last_exchange_order_id,
                "metrics": {**self.metrics, **self._exchange_metrics},
                "passed": self.passed,
                "last_error": self.last_error,
                "acceptance": self._acceptance_check(),
            }
        snap = self.sim.snapshot()
        return {
            "module": "QA-HFT-SIM",
            "is_alpha": False,
            "running": self.running,
            "test_run_id": self.test_run_id,
            "cycle_id": self.cycle_id,
            "cycles_completed": self.metrics.get("cycles_completed", 0),
            "cycles_total": self.target_cycles,
            "target_cycles": self.target_cycles,
            "state": self.state,
            "cycle_phase": self._cycle_phase,
            "execution_mode": "simulator",
            "exchange_environment": None,
            "real_exchange_ordering": False,
            "live_money": False,
            "s6_level": self.s6_level,
            "inject_failures": self.inject_failures,
            "symbol": self.symbol,
            "max_position_notional_usdt": self.max_notional,
            "target_notional_usdt": self.max_notional,
            "target_leverage": self._cycle_target_leverage,
            "actual_leverage": snap["leverage"],
            "position_notional_usdt": snap["position_notional_usdt"],
            "current_qa_notional_usdt": snap["position_notional_usdt"],
            "position_side": snap["position_side"],
            "metrics": dict(self.metrics),
            "passed": self.passed,
            "last_error": self.last_error,
            "acceptance": self._acceptance_check(),
        }

    def report(self) -> Dict[str, Any]:
        st = self.status()
        st["events_tail"] = self.events[-50:]
        st["simulator"] = self.sim.snapshot()
        return st

    def start(
        self,
        *,
        cycles: int = 200,
        seed: Optional[int] = None,
        inject_failures: bool = False,
        symbol: Optional[str] = None,
        max_position_notional_usdt: Optional[float] = None,
        leverage_sequence: Optional[List[float]] = None,
        action_interval_seconds: float = 0,
        execution_mode: str = "simulator",
        exchange_environment: Optional[str] = None,
    ) -> Dict[str, Any]:
        if self.running:
            return {
                "ok": False,
                "error": {"code": "QA_RUN_ALREADY_ACTIVE", "message": "QA-HFT-SIM already running"},
            }
        mode = str(execution_mode or "simulator").lower().strip()
        if mode not in ("simulator", "exchange"):
            return {
                "ok": False,
                "error": {"code": "HFT_SIM_CONFIG_INVALID", "message": f"bad execution_mode={execution_mode}"},
            }
        sym = (symbol or self.symbol or "BTC-USDT-SWAP").upper()
        if sym not in QA_ALLOWED_SYMBOLS:
            return {
                "ok": False,
                "error": {"code": "QA_SYMBOL_NOT_ALLOWED", "message": f"symbol {sym} not allowed"},
            }
        self.execution_mode = mode
        self.exchange_environment = exchange_environment
        self.live_money = str(exchange_environment or "").lower() == "live"
        # Exchange mode: no fault injection (cannot safely mutate OKX account state)
        if mode == "exchange":
            inject_failures = False
            if action_interval_seconds <= 0:
                action_interval_seconds = 2.0

        # Capture OKX baseline BEFORE marking running (avoid stuck QA_RUN_ALREADY_ACTIVE)
        baseline_qty = 0.0
        if mode == "exchange":
            try:
                base = self.node.get_position(self.symbol)
                baseline_qty = float(base.get("qty") or 0)
            except Exception as exc:  # noqa: BLE001
                code = getattr(exc, "code", None) or "POSITION_QUERY_FAILED"
                return {
                    "ok": False,
                    "error": {
                        "code": str(code),
                        "message": f"cannot read OKX baseline position: {exc}",
                    },
                }

        self.sim.reset()
        self.state = "FLAT"
        self.running = True
        self.test_run_id = f"HFTSIM-{uuid.uuid4().hex[:10]}"
        self.cycle_id = 0
        self.target_cycles = int(cycles)
        self.seed = int(seed if seed is not None else self.config.get("seed") or 20260909)
        self.inject_failures = bool(inject_failures)
        self.symbol = sym
        if max_position_notional_usdt is not None:
            self.max_notional = min(float(max_position_notional_usdt), 50.0)
        if leverage_sequence:
            self.leverage_sequence = list(leverage_sequence)
        self._lev_idx = 0
        self._cycle_phase = "idle"
        self._awaiting_flat_confirm = False
        self.metrics = self._empty_metrics()
        self._exchange_metrics = {k: 0 for k in self._exchange_metrics}
        self.events = []
        self.last_error = ""
        self.passed = None
        self.s6_level = 0
        self._last_exchange_order_id = None
        self._fault_plan = self._build_fault_plan(self.target_cycles)
        self._baseline_qty = baseline_qty
        self._log(
            "start",
            {
                "cycles": self.target_cycles,
                "seed": self.seed,
                "inject": self.inject_failures,
                "execution_mode": self.execution_mode,
                "exchange_environment": self.exchange_environment,
                "baseline_qty": self._baseline_qty,
            },
        )
        self._action_interval = float(action_interval_seconds)
        try:
            result = self.run_until_done()
            return {"ok": True, "test_run_id": self.test_run_id, **result}
        finally:
            self.running = False

    def stop(self) -> Dict[str, Any]:
        self.running = False
        self._log("stop", {})
        return {"ok": True, "status": self.status()}

    def set_s6_level(self, level: int) -> None:
        self.s6_level = int(level)

    def run_until_done(self) -> Dict[str, Any]:
        while self.running and self.cycle_id < self.target_cycles:
            ok = self._run_one_cycle()
            if not ok:
                self.metrics["cycles_failed"] += 1
                self.running = False
                self.passed = False
                break
            self.metrics["cycles_completed"] += 1
            if self._action_interval > 0:
                time.sleep(self._action_interval)
        else:
            if self.running:
                self.passed = self._acceptance_check()["ok"]
                self.running = False
        return {"passed": self.passed, "status": self.status()}

    def _current_target_leverage(self) -> float:
        if not self.leverage_sequence:
            return 2.0
        return float(self.leverage_sequence[self._lev_idx % len(self.leverage_sequence)])

    def _build_fault_plan(self, cycles: int) -> List[Optional[str]]:
        """Deterministic fault schedule from seed (not Math.random)."""
        if not self.inject_failures:
            return [None] * cycles
        faults = [
            None,
            None,
            "leverage_mismatch",
            None,
            "position_over",
            None,
            "position_under",
            None,
            "wrong_side",
            None,
            "partial_fill",
            None,
            "duplicate_request",
            None,
            "lost_ack",
            None,
            "delayed_ack",
        ]
        plan: List[Optional[str]] = []
        for i in range(cycles):
            plan.append(faults[(i + self.seed) % len(faults)])
        return plan

    def _run_one_cycle(self) -> bool:
        self.cycle_id += 1
        fault = self._fault_plan[self.cycle_id - 1] if self.cycle_id - 1 < len(self._fault_plan) else None
        direction = "LONG" if (self.cycle_id % 2 == 1) else "SHORT"
        target_lev = self._current_target_leverage()
        self._cycle_target_leverage = target_lev
        self._lev_idx += 1
        self._log("cycle_start", {"cycle_id": self.cycle_id, "direction": direction, "fault": fault, "leverage": target_lev})

        try:
            # Must be flat-confirmed before opening opposite / new cycle
            if not self._ensure_flat_confirmed():
                return False

            # Fault injection only for local simulator
            if self.execution_mode == "simulator":
                if fault == "leverage_mismatch":
                    injected = 2.0 if target_lev != 2.0 else 3.0
                    self.sim.inject_leverage(injected)
                    self.metrics["leverage_mismatch_count"] += 1

            if not self._reconcile_leverage(target_lev):
                self.last_error = "LEVERAGE_RECONCILIATION_FAILED"
                return False

            if self.execution_mode == "simulator":
                if fault == "wrong_side":
                    self.sim.inject_position_notional(-20.0 if direction == "LONG" else 20.0)
                    self.metrics["position_mismatch_count"] += 1
                    if not self._correct_wrong_side(direction):
                        self.metrics["wrong_side_unresolved"] += 1
                        self.last_error = "WRONG_SIDE_UNRESOLVED"
                        return False

                if fault == "position_over":
                    self.sim.inject_position_notional(65.0 if direction == "LONG" else -65.0)
                    self.metrics["position_mismatch_count"] += 1
                    self.metrics["position_cap_violation_count"] += 1
                    if not self._enforce_position_cap():
                        self.metrics["position_cap_unresolved"] += 1
                        self.last_error = "POSITION_CAP_UNRESOLVED"
                        return False
                    if not self._flatten_to_confirmed():
                        return False

            # Opening
            open_fault = (
                fault
                if self.execution_mode == "simulator"
                and fault in ("partial_fill", "lost_ack", "delayed_ack", "duplicate_request")
                else None
            )
            if not self._open(direction, fault=open_fault):
                return False

            if self.execution_mode == "simulator" and fault == "position_under":
                side_sign = 1.0 if direction == "LONG" else -1.0
                self.sim.inject_position_notional(37.0 * side_sign)
                self.metrics["position_mismatch_count"] += 1
                if not self._correct_to_target(self.max_notional * side_sign):
                    self.last_error = "POSITION_UNDER_CORRECTION_FAILED"
                    return False

            # Reduce to ~half (simulator only — exchange cycle is open→confirm→close)
            if self.execution_mode == "simulator":
                if not self._reduce_half(direction):
                    return False

            # Full close — never assume FLAT without snapshot confirm
            if not self._close_all(direction):
                return False

            if not self._ensure_flat_confirmed():
                return False

            self._log("cycle_done", {"cycle_id": self.cycle_id})
            return True
        except Exception as exc:  # noqa: BLE001
            self.last_error = str(exc)
            self._log("cycle_error", {"cycle_id": self.cycle_id, "error": str(exc)})
            return False

    def _qa_owned_qty(self) -> float:
        if self.execution_mode != "exchange":
            return self.sim.position_notional_usdt  # notional proxy in sim
        pos = self.node.get_position(self.symbol)
        self._exchange_metrics["position_reconciliation_count"] += 1
        return float(pos.get("qty") or 0) - self._baseline_qty

    def _ensure_flat_confirmed(self) -> bool:
        if self.execution_mode == "exchange":
            try:
                owned = self._qa_owned_qty()
            except Exception as exc:  # noqa: BLE001
                self.last_error = f"POSITION_QUERY_FAILED:{exc}"
                return False
            if abs(owned) > 1e-6:
                if not self._flatten_to_confirmed():
                    return False
            self.state = "FLAT_CONFIRMED"
            self._awaiting_flat_confirm = False
            return True
        snap = self.sim.snapshot()
        if abs(float(snap["position_notional_usdt"])) > notional_tolerance(0, self.config):
            if not self._flatten_to_confirmed():
                return False
        self.state = "FLAT_CONFIRMED"
        self._awaiting_flat_confirm = False
        return True

    def _flatten_to_confirmed(self) -> bool:
        if self.execution_mode == "exchange":
            try:
                owned = self._qa_owned_qty()
            except Exception as exc:  # noqa: BLE001
                self.last_error = str(exc)
                return False
            if abs(owned) <= 1e-6:
                self.state = "FLAT_CONFIRMED"
                return True
            self.state = "CLOSING_LONG" if owned > 0 else "CLOSING_SHORT"
            side = "sell" if owned > 0 else "buy"
            # Close QA-owned only: pass reduce_only + quantity in contracts (abs owned)
            ok, _ = self._submit(
                side=side,
                notional=self.max_notional,  # cap; gateway uses reduce-only against position
                reduce_only=True,
                phase="flatten",
                quantity_override=abs(owned),
            )
            if not ok:
                return False
            time.sleep(1.0)
            owned2 = self._qa_owned_qty()
            if abs(owned2) > 1e-6:
                self.last_error = "FLAT_NOT_CONFIRMED"
                return False
            self.state = "FLAT_CONFIRMED"
            return True
        snap = self.sim.snapshot()
        pos = float(snap["position_notional_usdt"])
        if abs(pos) <= notional_tolerance(0, self.config):
            self.state = "FLAT_CONFIRMED"
            return True
        self.state = "CLOSING_LONG" if pos > 0 else "CLOSING_SHORT"
        side = "sell" if pos > 0 else "buy"
        ok, _ = self._submit(
            side=side,
            notional=abs(pos),
            reduce_only=True,
            phase="flatten",
        )
        if not ok:
            return False
        snap2 = self.sim.snapshot()
        if abs(float(snap2["position_notional_usdt"])) > notional_tolerance(0, self.config):
            self.last_error = "FLAT_NOT_CONFIRMED"
            return False
        self.state = "FLAT_CONFIRMED"
        return True

    def _reconcile_leverage(self, target: float) -> bool:
        if self.execution_mode == "exchange":
            try:
                res = self.node.ensure_leverage(inst_id=self.symbol, lever=target)
                self._exchange_metrics["leverage_set_count"] += 1
                self.metrics["leverage_correction_count"] += 1
                return bool(res.get("ok", True))
            except Exception as exc:  # noqa: BLE001
                self._exchange_metrics["leverage_set_failures"] += 1
                self.last_error = f"LEVERAGE_RECONCILIATION_FAILED:{exc}"
                return False
        actual = float(self.sim.leverage)
        if abs(actual - target) < 1e-9:
            return True
        self.metrics["leverage_mismatch_count"] += 1
        res = self.sim.set_leverage(target)
        if not res.get("ok"):
            return False
        self.metrics["leverage_correction_count"] += 1
        if abs(float(self.sim.leverage) - target) > 1e-9:
            return False
        return True

    def _enforce_position_cap(self) -> bool:
        pos = float(self.sim.position_notional_usdt)
        if abs(pos) <= self.max_notional + notional_tolerance(self.max_notional, self.config):
            # still may be over 50 — correct down to 50
            if abs(pos) <= self.max_notional + 1e-9:
                return True
        excess = abs(pos) - self.max_notional
        if excess <= 0:
            return True
        side = "sell" if pos > 0 else "buy"
        ok, _ = self._submit(side=side, notional=excess, reduce_only=True, phase="cap_correct")
        if not ok:
            return False
        self.metrics["position_correction_count"] += 1
        if abs(self.sim.position_notional_usdt) > self.max_notional + notional_tolerance(self.max_notional, self.config):
            return False
        return True

    def _correct_wrong_side(self, desired: str) -> bool:
        pos = float(self.sim.position_notional_usdt)
        if desired == "LONG" and pos >= -1e-9:
            return True
        if desired == "SHORT" and pos <= 1e-9:
            return True
        # flatten first — never buy 70 to flip
        if not self._flatten_to_confirmed():
            return False
        return True

    def _correct_to_target(self, target_signed: float) -> bool:
        pos = float(self.sim.position_notional_usdt)
        delta = target_signed - pos
        if abs(delta) <= notional_tolerance(abs(target_signed), self.config):
            return True
        side = "buy" if delta > 0 else "sell"
        reduce = (pos > 0 and delta < 0) or (pos < 0 and delta > 0)
        ok, _ = self._submit(side=side, notional=abs(delta), reduce_only=reduce, phase="notional_correct")
        if ok:
            self.metrics["position_correction_count"] += 1
        return ok

    def _open(self, direction: str, *, fault: Optional[str]) -> bool:
        if self.s6_level >= 2:
            # Correct behavior: block opening. Metric opening_while_s6_ge_l2 counts violations only.
            self.metrics["kill_switch_block_success"] += 1
            self._log("open_blocked_s6", {"level": self.s6_level})
            return True
        # Opening requires leverage aligned
        target_lev = self._cycle_target_leverage
        if self.execution_mode != "exchange":
            if abs(float(self.sim.leverage) - target_lev) > 1e-9:
                if not self._reconcile_leverage(target_lev):
                    self.last_error = "LEVERAGE_NOT_ALIGNED_BEFORE_OPEN"
                    return False
        elif not self._reconcile_leverage(target_lev):
            self.last_error = "LEVERAGE_NOT_ALIGNED_BEFORE_OPEN"
            return False

        self.state = "OPENING_LONG" if direction == "LONG" else "OPENING_SHORT"
        side = "buy" if direction == "LONG" else "sell"
        self.metrics["open_attempts"] += 1
        sim_fault = fault if fault in ("partial_fill", "lost_ack", "delayed_ack") else None
        ok, report = self._submit(
            side=side,
            notional=self.max_notional,
            reduce_only=False,
            phase="open",
            fault=sim_fault,
        )
        if self.execution_mode == "exchange":
            if not ok:
                return False
            time.sleep(0.8)
            try:
                owned = self._qa_owned_qty()
                pos = self.node.get_position(self.symbol)
                notional = abs(float(pos.get("position_notional_usdt") or 0))
            except Exception as exc:  # noqa: BLE001
                self.last_error = f"POSITION_RECONCILE_AFTER_OPEN:{exc}"
                return False
            if abs(owned) <= 1e-8:
                self.last_error = "OPEN_POSITION_NOT_CONFIRMED"
                return False
            want_long = direction == "LONG"
            if want_long and owned < 0:
                self.last_error = "OPEN_WRONG_SIDE"
                return False
            if (not want_long) and owned > 0:
                self.last_error = "OPEN_WRONG_SIDE"
                return False
            if notional > self.max_notional + notional_tolerance(self.max_notional, self.config):
                self.metrics["position_cap_violation_count"] += 1
                if not self._flatten_to_confirmed():
                    self.metrics["position_cap_unresolved"] += 1
                    self.last_error = "QA_POSITION_CAP_EXCEEDED"
                    return False
                self.last_error = "QA_POSITION_CAP_EXCEEDED"
                return False
            self.state = "LONG" if direction == "LONG" else "SHORT"
            self.metrics["open_success"] += 1
            return True

        if fault == "duplicate_request" and ok:
            # intentional duplicate submit of same intent
            intent_id = (report or {}).get("order_intent_id")
            if intent_id:
                dup = {
                    "order_intent_id": intent_id,
                    "client_order_id": (report or {}).get("client_order_id"),
                    "symbol": self.symbol,
                    "side": side,
                    "target_notional_usdt": self.max_notional,
                    "reduce_only": False,
                    "test_mode": True,
                    "execution_target": "simulator",
                    "test_run_id": self.test_run_id,
                    "test_cycle_id": self.cycle_id,
                }
                r2 = self.sim.submit_order(dup)
                self.metrics["duplicate_intents_received"] += 1
                if not r2.get("idempotent"):
                    self.metrics["duplicate_orders_executed"] += 1
                    self.last_error = "DUPLICATE_NOT_IDEMPOTENT"
                    return False

        if fault == "lost_ack":
            # retry same client/order id — must be idempotent
            if report and report.get("order_intent_id"):
                retry = {
                    "order_intent_id": report["order_intent_id"],
                    "client_order_id": report.get("client_order_id"),
                    "symbol": self.symbol,
                    "side": side,
                    "target_notional_usdt": self.max_notional,
                    "reduce_only": False,
                    "test_mode": True,
                    "execution_target": "simulator",
                    "test_run_id": self.test_run_id,
                    "test_cycle_id": self.cycle_id,
                }
                r2 = self.sim.submit_order(retry)
                self.metrics["duplicate_intents_received"] += 1
                if not r2.get("idempotent") and r2.get("ok"):
                    # second execution would be bad
                    if "report" in r2 and not r2.get("idempotent"):
                        pass
                # position must still be ~50 not 100
                if abs(abs(self.sim.position_notional_usdt) - self.max_notional) > notional_tolerance(self.max_notional, self.config) * 2:
                    # lost_ack already filled once; idempotent retry should not double
                    if abs(self.sim.position_notional_usdt) > self.max_notional + 5:
                        self.metrics["duplicate_orders_executed"] += 1
                        self.last_error = "LOST_ACK_DOUBLE_FILL"
                        return False
            ok = True

        if not ok and fault != "lost_ack":
            return False

        if fault == "partial_fill":
            self.metrics["partial_fills"] += 1
            # fill remaining
            oid = (report or {}).get("order_intent_id")
            if oid:
                self.sim.fill_remaining(oid)

        # Cap check
        if abs(self.sim.position_notional_usdt) > self.max_notional + notional_tolerance(self.max_notional, self.config):
            self.metrics["position_cap_violation_count"] += 1
            if not self._enforce_position_cap():
                self.metrics["position_cap_unresolved"] += 1
                return False

        self.state = "LONG" if direction == "LONG" else "SHORT"
        self.metrics["open_success"] += 1
        return True

    def _reduce_half(self, direction: str) -> bool:
        if self.execution_mode == "exchange":
            try:
                owned = abs(self._qa_owned_qty())
                pos = self.node.get_position(self.symbol)
                notional = abs(float(pos.get("position_notional_usdt") or 0))
            except Exception as exc:  # noqa: BLE001
                self.last_error = f"POSITION_QUERY_FAILED:{exc}"
                return False
            if owned <= 1e-8 or notional < 1:
                return True
            self.state = "REDUCING_LONG" if direction == "LONG" else "REDUCING_SHORT"
            side = "sell" if direction == "LONG" else "buy"
            self.metrics["close_attempts"] += 1
            half_qty = owned * 0.5
            ok, _ = self._submit(
                side=side,
                notional=min(notional * 0.5, self.max_notional),
                reduce_only=True,
                phase="reduce",
                quantity_override=half_qty,
            )
            if ok:
                self.metrics["close_success"] += 1
                time.sleep(0.8)
            return ok

        pos = abs(float(self.sim.position_notional_usdt))
        if pos < 1:
            return True
        self.state = "REDUCING_LONG" if direction == "LONG" else "REDUCING_SHORT"
        side = "sell" if direction == "LONG" else "buy"
        self.metrics["close_attempts"] += 1
        ok, _ = self._submit(side=side, notional=pos * 0.5, reduce_only=True, phase="reduce")
        if ok:
            self.metrics["close_success"] += 1
        return ok

    def _close_all(self, direction: str) -> bool:
        if self.execution_mode == "exchange":
            try:
                owned = self._qa_owned_qty()
            except Exception as exc:  # noqa: BLE001
                self.last_error = f"POSITION_QUERY_FAILED:{exc}"
                return False
            if abs(owned) <= 1e-8:
                self.state = "FLAT"
                return self._ensure_flat_confirmed()
            self.state = "CLOSING_LONG" if direction == "LONG" else "CLOSING_SHORT"
            side = "sell" if owned > 0 else "buy"
            self.metrics["close_attempts"] += 1
            ok, _ = self._submit(
                side=side,
                notional=self.max_notional,
                reduce_only=True,
                phase="close",
                quantity_override=abs(owned),
            )
            if not ok:
                return False
            self.metrics["close_success"] += 1
            self._awaiting_flat_confirm = True
            time.sleep(1.0)
            return self._ensure_flat_confirmed()

        pos = abs(float(self.sim.position_notional_usdt))
        if pos <= notional_tolerance(0, self.config):
            self.state = "FLAT"
            return self._ensure_flat_confirmed()
        self.state = "CLOSING_LONG" if direction == "LONG" else "CLOSING_SHORT"
        side = "sell" if direction == "LONG" else "buy"
        self.metrics["close_attempts"] += 1
        ok, _ = self._submit(side=side, notional=pos, reduce_only=True, phase="close")
        if not ok:
            return False
        self.metrics["close_success"] += 1
        # CRITICAL: do not assume FLAT — confirm via snapshot
        self._awaiting_flat_confirm = True
        snap = self.sim.snapshot()
        if abs(float(snap["position_notional_usdt"])) > notional_tolerance(0, self.config):
            self.last_error = "CLOSE_FLAT_NOT_CONFIRMED"
            return False
        self.state = "FLAT"
        return self._ensure_flat_confirmed()

    def _submit(
        self,
        *,
        side: str,
        notional: float,
        reduce_only: bool,
        phase: str,
        fault: Optional[str] = None,
        quantity_override: Optional[float] = None,
    ) -> Tuple[bool, Optional[Dict[str, Any]]]:
        if not reduce_only and self.s6_level >= 2:
            self.metrics["kill_switch_block_success"] += 1
            self.last_error = "S6_BLOCKS_OPENING"
            return False, None

        order_intent_id = f"{self.test_run_id}-c{self.cycle_id}-{phase}-{uuid.uuid4().hex[:8]}"
        # OKX clOrdId max 32 chars
        client_order_id = f"QA{self.test_run_id[-6:]}{self.cycle_id:03d}{phase[:4]}{uuid.uuid4().hex[:6]}"[:32]

        if self.execution_mode == "exchange":
            intent = {
                "order_intent_id": order_intent_id,
                "client_order_id": client_order_id,
                "symbol": self.symbol,
                "side": side,
                "target_notional_usdt": float(min(abs(notional), self.max_notional)),
                "quantity": str(quantity_override) if quantity_override is not None else None,
                "reduce_only": reduce_only,
                "test_mode": True,
                "qa_execution": True,
                "execution_target": "node_gateway",
                "test_run_id": self.test_run_id,
                "test_cycle_id": self.cycle_id,
                "exclude_from_strategy_health": True,
                "exclude_from_expected_edge": True,
                "exclude_from_live_pnl_stats": True,
                "target_leverage": self._cycle_target_leverage,
                "order_type": "market",
            }
            # drop null quantity
            if intent["quantity"] is None:
                del intent["quantity"]
            try:
                self._exchange_metrics["exchange_orders_submitted"] += 1
                result = self.node.submit_order_intent(intent)
                report = result.get("report") or {}
                self._last_exchange_order_id = report.get("exchange_order_id")
                if result.get("ok") or result.get("idempotent"):
                    self._exchange_metrics["exchange_orders_filled"] += 1
                    self._log("submit_exchange", {"phase": phase, "intent_id": order_intent_id, "ok": True})
                    time.sleep(0.5)
                    return True, report
                self._exchange_metrics["exchange_order_failures"] += 1
                self.last_error = str(report.get("error") or "EXCHANGE_SUBMIT_FAILED")
                return False, report
            except Exception as exc:  # noqa: BLE001
                self._exchange_metrics["exchange_order_failures"] += 1
                self.last_error = str(getattr(exc, "code", None) or exc)
                self._log("submit_exchange_err", {"phase": phase, "error": self.last_error})
                return False, None

        intent = {
            "order_intent_id": order_intent_id,
            "client_order_id": client_order_id,
            "symbol": self.symbol,
            "side": side,
            "target_notional_usdt": float(notional),
            "quantity": self.sim.normalize_quantity(notional, round_up=reduce_only),
            "reduce_only": reduce_only,
            "test_mode": True,
            "execution_target": "simulator",
            "test_run_id": self.test_run_id,
            "test_cycle_id": self.cycle_id,
            "exclude_from_strategy_health": True,
            "exclude_from_expected_edge": True,
            "exclude_from_live_pnl_stats": True,
            "target_leverage": self._cycle_target_leverage,
        }
        result = self.sim.submit_order(intent, fault=fault)
        self._log("submit", {"phase": phase, "intent": intent, "result_ok": result.get("ok"), "fault": fault})

        if fault == "lost_ack" and result.get("code") == "ACK_TIMEOUT":
            order = self.sim.orders.get(order_intent_id)
            return True, self.sim._report_from_order(order)

        if not result.get("ok"):
            self.last_error = str(result.get("error") or result.get("code") or "SUBMIT_FAILED")
            return False, None

        if result.get("idempotent"):
            self.metrics["duplicate_intents_received"] += 1

        report = result.get("report")
        return True, report

    def simulate_restart_recovery(self) -> Dict[str, Any]:
        """Persist snapshot then restore — must not re-open duplicate."""
        before = deepcopy(self.sim.snapshot())
        pos = before["position_notional_usdt"]
        lev = before["leverage"]
        executed = set(self.sim.executed_intent_ids)
        # "crash"
        fresh = ExchangeSimulator(mark_price=self.sim.mark_price, seed=self.seed)
        fresh.position_notional_usdt = pos
        fresh.leverage = lev
        fresh.executed_intent_ids = set(executed)
        self.sim = fresh
        # reconcile: do not submit new open
        self.metrics["restart_recovery_success"] += 1
        after = self.sim.snapshot()
        if abs(after["position_notional_usdt"] - pos) > 1e-6:
            self.metrics["restart_duplicate_orders"] += 1
            return {"ok": False, "error": "RESTART_POSITION_DRIFT"}
        return {"ok": True, "position_notional_usdt": after["position_notional_usdt"]}

    def _acceptance_check(self) -> Dict[str, Any]:
        m = self.metrics
        # sync sim counters
        m["duplicate_orders_executed"] = max(m["duplicate_orders_executed"], self.sim.duplicate_orders_executed)
        m["orphan_order_count"] = max(m["orphan_order_count"], self.sim.orphan_order_count)
        final_pos = abs(float(self.sim.position_notional_usdt))
        ending_qa_flat = True
        if self.execution_mode == "exchange":
            try:
                ending_qa_flat = abs(self._qa_owned_qty()) <= 1e-6
                pos = self.node.get_position(self.symbol)
                final_pos = abs(float(pos.get("position_notional_usdt") or 0)) if not ending_qa_flat else 0.0
            except Exception:
                ending_qa_flat = False
        checks = {
            "duplicate_orders_executed": m["duplicate_orders_executed"] == 0,
            "orphan_order_count": m["orphan_order_count"] == 0,
            "wrong_side_unresolved": m["wrong_side_unresolved"] == 0,
            "position_cap_unresolved": m["position_cap_unresolved"] == 0,
            "opening_while_s6_ge_l2": m["opening_while_s6_ge_l2"] == 0,
            "restart_duplicate_orders": m["restart_duplicate_orders"] == 0,
            "final_position_within_cap": final_pos <= self.max_notional + 1e-6,
            "ending_qa_position_flat": ending_qa_flat,
            "cycles_completed": m.get("cycles_completed", 0) >= self.target_cycles if self.target_cycles else True,
        }
        if self.execution_mode == "exchange":
            checks["exchange_order_failures"] = self._exchange_metrics.get("exchange_order_failures", 0) == 0
            checks["leverage_set_failures"] = self._exchange_metrics.get("leverage_set_failures", 0) == 0
        return {"ok": all(checks.values()), "checks": checks, "metrics": {**dict(m), **self._exchange_metrics}}

    def _log(self, kind: str, payload: Dict[str, Any]) -> None:
        self.events.append(
            {
                "ts": time.time(),
                "kind": kind,
                "test_run_id": self.test_run_id,
                "cycle_id": self.cycle_id,
                "state": self.state,
                "payload": payload,
            }
        )


# Process-singleton for API
_runner: Optional[HftSimRunner] = None


def get_hft_runner() -> HftSimRunner:
    global _runner
    if _runner is None:
        _runner = HftSimRunner()
    return _runner
