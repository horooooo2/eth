"""Long-running V4.1 engine runtime (paper / control plane)."""

from __future__ import annotations

import asyncio
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

from src.core.orchestrator import Orchestrator
from src.runtime.engine_store import EngineStore
from src.runtime.position_ownership import PositionOwnershipRegistry
from src.telemetry.dashboard_snapshot import build_dashboard_snapshot
from src.telemetry.event_bus import get_event_bus

ROOT = Path(__file__).resolve().parents[2]

STRATEGY_META = {
    "S1": {
        "name": "趋势跟踪策略",
        "description": "适合趋势行情，结合趋势强度和波动率过滤寻找顺势机会。",
    },
    "S2": {
        "name": "极端情绪反转策略",
        "description": "在极端超买超卖、资金费率和持仓变化同时满足时寻找反转机会。",
    },
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class EngineRuntime:
    """Owns orchestrator + control state for the internal API."""

    def __init__(
        self,
        *,
        config_path: Optional[Path] = None,
        mode: str = "paper",
        symbol: str = "BTC/USDT:USDT",
        tick_interval_sec: float = 5.0,
        execution_mode: str = "paper",
        active_strategy: str = "S1",
    ) -> None:
        self.config_path = Path(config_path or (ROOT / "config" / "ai_trading_system_v4_2_personal_single_strategy.json"))
        if not self.config_path.exists():
            self.config_path = ROOT / "config" / "system_config.json"
        self.mode = mode
        self.symbol = symbol
        self.tick_interval_sec = float(tick_interval_sec)
        self.execution_mode = execution_mode
        default_active = "S1"
        try:
            import json as _json

            preview = _json.loads(self.config_path.read_text(encoding="utf-8"))
            default_active = (
                preview.get("strategy_runtime", {}) or {}
            ).get("default_active_strategy_id") or active_strategy
        except Exception:
            default_active = active_strategy
        self.active_strategy = default_active if default_active in ("S1", "S2") else "S1"
        self.user_id = os.getenv("V41_ENGINE_USER_ID") or None
        self.account_scope = os.getenv("V41_ENGINE_ACCOUNT_SCOPE", "default")
        self.node_gateway_url = os.getenv("V41_NODE_GATEWAY_URL", "http://127.0.0.1:80").rstrip("/")
        self.node_token = os.getenv("V41_ENGINE_INTERNAL_TOKEN", "dev-internal-token")

        self.orchestrator = Orchestrator.from_config_path(
            self.config_path, mode=mode, symbol=symbol
        )
        self.orchestrator.execution_mode = execution_mode
        self.orchestrator.user_id = self.user_id
        self.orchestrator.account_scope = self.account_scope
        self.config_version = str((self.orchestrator.config.get("meta") or {}).get("version") or "4.1")
        self.runtime_model = str(
            (self.orchestrator.config.get("meta") or {}).get("runtime_model")
            or (self.orchestrator.config.get("strategy_runtime") or {}).get("selection_mode")
            or "unknown"
        )
        print(
            f"CONFIG_LOADED version={self.config_version} "
            f"runtime_model={self.runtime_model} path={self.config_path}"
        )

        self.store = EngineStore()
        self.bus = get_event_bus()
        self.positions = PositionOwnershipRegistry()
        self.positions.load(self.store.list_open_positions(200))
        self.state = "OFFLINE"
        self.started_at: Optional[str] = None
        self.last_tick_at: Optional[str] = None
        self.last_error: Optional[str] = None
        self.event_loop_lag_ms: float = 0.0
        # Restore recent intents after restart (memory is source of truth at runtime)
        self.order_intents: List[Dict[str, Any]] = list(self.store.list_order_intents(100))
        self.incidents: List[Dict[str, Any]] = list(self.store.list_incidents(50))
        self._last_seq_emitted = 0
        self._prev_regime: Optional[str] = None
        self._prev_s6: Optional[int] = None
        self._task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()
        self._pause = asyncio.Event()
        self._pause.set()
        self._strategy_switch_lock = threading.Lock()
        self._active_strategy_changed_at = _now_iso()

        saved = self.store.get_kv("active_strategy")
        if saved in ("S1", "S2"):
            self.active_strategy = saved
        self.orchestrator.active_strategy_id = self.active_strategy

        # Console execution selection (alpha vs QA). QA is NOT an alpha strategy.
        self.console_mode = "ALPHA"  # ALPHA | QA_HFT_SIM
        self.alpha_opening_enabled = True
        self.previous_active_strategy_id = self.active_strategy
        self.orchestrator.context["alpha_opening_enabled"] = True
        self.orchestrator.context["console_mode"] = self.console_mode

        self._default_micro = {
            "spread_bps": 2.0,
            "depth_imbalance": 0.15,
            "aggressive_buy_ratio": 2.2,
            "aggressive_sell_ratio": 1.1,
            "price_impact_buy": 0.0005,
            "price_impact_sell": 0.0005,
            "market_data_stale_ms": 42,
            "sequence_valid": True,
            "exchange_connected": True,
        }

    @property
    def ok(self) -> bool:
        return self.state != "OFFLINE"

    def health(self) -> Dict[str, Any]:
        if self.state == "OFFLINE":
            return {
                "ok": False,
                "engine": "v4.1",
                "mode": self.mode,
                "state": "OFFLINE",
                "started_at": self.started_at,
                "last_tick_at": self.last_tick_at,
                "event_loop_lag_ms": self.event_loop_lag_ms,
                "version": getattr(self, "config_version", "4.1"),
            }
        return {
            "ok": True,
            "engine": "v4.2" if str(getattr(self, "config_version", "")).startswith("4.2") else "v4.1",
            "mode": self.mode,
            "state": self.state,
            "started_at": self.started_at,
            "last_tick_at": self.last_tick_at,
            "event_loop_lag_ms": self.event_loop_lag_ms,
            "version": getattr(self, "config_version", "4.1"),
            "runtime_model": getattr(self, "runtime_model", None),
            "active_strategy": self.active_strategy,
            "execution_mode": self.execution_mode,
            "console_mode": getattr(self, "console_mode", "ALPHA"),
            "alpha_opening_enabled": getattr(self, "alpha_opening_enabled", True),
            "hft_sim_enabled": self.hft_sim_enabled(),
            "last_error": self.last_error,
            "event_sequence": self.bus.sequence,
        }

    def snapshot(self) -> Dict[str, Any]:
        if self.state == "OFFLINE" and not self.orchestrator.context:
            return {
                "engine": {
                    "version": getattr(self, "config_version", "4.1"),
                    "mode": self.mode,
                    "state": "OFFLINE",
                    "updated_at": _now_iso(),
                    "started_at": self.started_at,
                    "last_tick_at": self.last_tick_at,
                    "active_strategy": self.active_strategy,
                    "engine_available": False,
                },
                "s3": None,
                "s5": None,
                "s6": None,
                "s7": [],
                "trade_intents": [],
                "order_intents": list(self.order_intents),
                "open_positions": [p.to_dict() for p in self.positions.list_open()],
                "execution": {"mode": self.execution_mode, "last_orders": []},
                "incidents": list(self.incidents),
                "edge": None,
                "view": {
                    "engine": {
                        "available": False,
                        "state": "OFFLINE",
                        "mode": self.mode,
                        "version": "4.1",
                        "updated_at": _now_iso(),
                    },
                    "active_strategy": self.get_active_strategy(),
                    "market_risk": None,
                    "signals": [],
                    "recent_order_intents": [],
                    "last_update": _now_iso(),
                },
            }
        snap = build_dashboard_snapshot(self)
        intents = snap.get("trade_intents") or []
        snap["trade_intents"] = [
            i for i in intents if str(i.get("strategy_id") or "") == self.active_strategy
        ]
        snap["order_intents"] = list(self.order_intents)
        snap["open_positions"] = [p.to_dict() for p in self.positions.list_open()]
        snap["active_strategy"] = self.get_active_strategy()
        return snap

    async def start(self) -> Dict[str, Any]:
        if self.state == "LOCKED":
            return {"ok": False, "error": {"code": "S6_BLOCKED", "message": "engine locked; resume first"}}
        if self._task and not self._task.done():
            self._pause.set()
            if self.state != "LOCKED":
                self.state = "RUNNING"
            self.bus.emit("engine.status", {"state": self.state})
            return {"ok": True, "state": self.state}
        self._stop.clear()
        self._pause.set()
        self.started_at = self.started_at or _now_iso()
        self.state = "RUNNING"
        self._task = asyncio.create_task(self._loop(), name="v41-engine-loop")
        self.bus.emit("engine.status", {"state": self.state})
        return {"ok": True, "state": self.state}

    def _interrupt_qa(self) -> None:
        """Allow control endpoints to stop QA without waiting for cycle completion."""
        try:
            from src.qa.hft_sim_runner import get_hft_runner

            get_hft_runner().running = False
        except Exception:
            pass

    async def pause(self) -> Dict[str, Any]:
        self._interrupt_qa()
        if self.state == "LOCKED":
            # Already stopped harder than pause — treat as success for UI「停止」
            return {"ok": True, "state": self.state, "note": "already_locked"}
        self._pause.clear()
        self.state = "PAUSED"
        self.bus.emit("engine.status", {"state": self.state})
        return {"ok": True, "state": self.state}

    async def kill(self, *, reason: str = "MANUAL_EMERGENCY_STOP", operator_id: str = "system") -> Dict[str, Any]:
        self._interrupt_qa()
        self.orchestrator.s6.raise_hard_event(reason.lower())
        self.orchestrator.s6.evaluate_signals(self.orchestrator.data_pool, self.orchestrator.context)
        self._pause.clear()
        self.state = "LOCKED"
        incident = {
            "incident_id": f"INC-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}",
            "type": reason,
            "severity": "L3",
            "triggered_at": _now_iso(),
            "resolved_at": None,
            "reason": reason,
            "recovery_state": "AWAITING_MANUAL_RESUME",
            "manual_ack_required": True,
            "operator_id": operator_id,
        }
        self.incidents.insert(0, incident)
        self.incidents = self.incidents[:50]
        self.store.upsert_incident(incident["incident_id"], incident, _now_iso())
        self.bus.emit("system.safety.updated", {"level": 3, "status": "LOCKED", "reason": reason})
        self.bus.emit("incident.created", incident)
        self.bus.emit("engine.status", {"state": self.state})
        return {"ok": True, "state": self.state, "s6_level": self.orchestrator.s6.level, "incident": incident}

    async def resume(
        self,
        *,
        operator_id: str,
        reason: str,
        incident_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        s6 = self.orchestrator.s6
        if int(s6.level) != 3 and not getattr(s6, "_manual_resume_required", False):
            return {"ok": False, "error": {"code": "RESUME_NOT_REQUIRED", "message": "not in L3"}}
        result = s6.manual_resume(
            operator_id=operator_id,
            reason=reason,
            preconditions_ok=True,
            new_level=2,
        )
        if not result.get("ok"):
            return {"ok": False, "error": {"code": "RESUME_FAILED", "message": result.get("error"), "details": result}}
        self.state = "RUNNING"
        if incident_id:
            for inc in self.incidents:
                if inc.get("incident_id") == incident_id:
                    inc["recovery_state"] = "L2_OBSERVATION"
                    self.store.upsert_incident(incident_id, inc, _now_iso())
        self._pause.set()
        self.bus.emit("system.safety.updated", {"level": 2, "status": "BLOCKED", "reason": "MANUAL_ACK"})
        self.bus.emit("incident.updated", {"incident_id": incident_id, "recovery_state": "L2_OBSERVATION"})
        self.bus.emit("engine.status", {"state": self.state})
        return {"ok": True, "state": self.state, "s6_level": s6.level, "result": result}

    def get_active_strategy(self) -> Dict[str, Any]:
        sid = self.active_strategy if self.active_strategy in ("S1", "S2") else "S1"
        s7 = self.orchestrator.s7.score_strategy(sid)
        s5 = (self.orchestrator.context or {}).get("S5") or {}
        budgets = s5.get("strategy_risk_budget_pct_equity") or {}
        meta = STRATEGY_META.get(sid, {})
        return {
            "strategy_id": sid,
            "name": meta.get("name") or sid,
            "description": meta.get("description") or "",
            "runtime_state": self.state,
            "health_state": s7.get("state") or "ON",
            "health_score": float(s7.get("health_score") or 0.0),
            "risk_budget_pct_equity": float(budgets.get(sid) or 0.0),
            "expectancy_R": None,
            "changed_at": self._active_strategy_changed_at,
        }

    def list_strategies(self) -> Dict[str, Any]:
        items = []
        for sid in ("S1", "S2"):
            s7 = self.orchestrator.s7.score_strategy(sid)
            meta = STRATEGY_META.get(sid, {})
            state = str(s7.get("state") or "ON")
            items.append(
                {
                    "id": sid,
                    "kind": "alpha",
                    "name": meta.get("name") or sid,
                    "description": meta.get("description") or "",
                    "available": state not in ("PAUSED", "OFF"),
                    "health_score": float(s7.get("health_score") or 0.0),
                    "health_state": state,
                }
            )
        return {"active_strategy_id": self.active_strategy, "strategies": items}

    @staticmethod
    def hft_sim_enabled() -> bool:
        return str(os.getenv("V41_HFT_SIM_ENABLED", "false")).strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }

    def list_execution_selections(self) -> Dict[str, Any]:
        """Unified selector: alpha strategies + QA test modes (QA is not alpha)."""
        items: List[Dict[str, Any]] = []
        for sid in ("S1", "S2"):
            s7 = self.orchestrator.s7.score_strategy(sid)
            meta = STRATEGY_META.get(sid, {})
            state = str(s7.get("state") or "ON")
            items.append(
                {
                    "id": sid,
                    "kind": "alpha",
                    "name": meta.get("name") or sid,
                    "description": meta.get("description") or "",
                    "available": state not in ("PAUSED", "OFF"),
                    "health_state": state,
                    "health_score": float(s7.get("health_score") or 0.0),
                }
            )
        # S8 placeholder — not implemented; do not fake available
        items.append(
            {
                "id": "S8",
                "kind": "alpha",
                "name": "巨鲸行为跟随",
                "description": "多巨鲸共识跟随（尚未开放）",
                "available": False,
                "paper_only": True,
                "disabled_reason": "WARMING_UP_OR_NOT_IMPLEMENTED",
            }
        )
        hft_on = self.hft_sim_enabled()
        items.append(
            {
                "id": "QA-HFT-SIM",
                "kind": "qa_test",
                "name": "模拟仓高频测试",
                "description": "仅 Simulator，名义仓位≤50U，不进 S7/Edge，禁止真实 OKX",
                "available": hft_on,
                "execution_target": "simulator",
                "max_position_notional_usdt": 50,
                "disabled_reason": None if hft_on else "HFT_SIM_DISABLED",
            }
        )
        return {
            "active_strategy_id": self.active_strategy,
            "console_mode": self.console_mode,
            "selected_execution_id": "QA-HFT-SIM" if self.console_mode == "QA_HFT_SIM" else self.active_strategy,
            "alpha_opening_enabled": self.alpha_opening_enabled,
            "items": items,
        }

    def enter_qa_hft_sim(self) -> Dict[str, Any]:
        if not self.hft_sim_enabled():
            return {
                "ok": False,
                "error": {
                    "code": "HFT_SIM_DISABLED",
                    "message": "QA-HFT-SIM is disabled",
                    "details": {
                        "env_key": "V41_HFT_SIM_ENABLED",
                        "resolved": os.getenv("V41_HFT_SIM_ENABLED"),
                        "engine_available": True,
                    },
                },
            }
        if self.console_mode != "QA_HFT_SIM":
            self.previous_active_strategy_id = self.active_strategy
        self.console_mode = "QA_HFT_SIM"
        self.alpha_opening_enabled = False
        self.orchestrator.context["alpha_opening_enabled"] = False
        self.orchestrator.context["console_mode"] = self.console_mode
        self.bus.emit(
            "console.mode.changed",
            {
                "console_mode": self.console_mode,
                "active_strategy_id": self.active_strategy,
                "previous_active_strategy_id": self.previous_active_strategy_id,
                "alpha_opening_enabled": False,
            },
        )
        return {
            "ok": True,
            "console_mode": self.console_mode,
            "active_strategy_id": self.active_strategy,
            "previous_active_strategy_id": self.previous_active_strategy_id,
            "alpha_opening_enabled": False,
            "note": "active_strategy_id unchanged; Alpha openings paused",
        }

    def exit_qa_hft_sim(self, *, resume_alpha_openings: bool = False) -> Dict[str, Any]:
        """Stop QA console mode. Alpha openings resume only when explicitly allowed after flat."""
        from src.qa.hft_sim_runner import get_hft_runner

        runner = get_hft_runner()
        # Stop new cycles; flatten QA-owned exposure (sim or exchange)
        runner.running = False
        flat_ok = True
        try:
            if getattr(runner, "execution_mode", "simulator") == "exchange":
                flat_ok = bool(runner._flatten_to_confirmed())
            elif abs(float(runner.sim.position_notional_usdt)) > 0.01:
                flat_ok = bool(runner._flatten_to_confirmed())
            else:
                runner.state = "FLAT_CONFIRMED"
        except Exception:
            flat_ok = False

        pending = [
            o
            for o in runner.sim.orders.values()
            if o.status in ("NEW", "PARTIAL", "ACK_PENDING")
        ]
        for o in pending:
            runner.sim.cancel_order(o.order_intent_id)

        qa_state = "QA_STOPPED" if flat_ok and abs(runner.sim.position_notional_usdt) < 0.01 else "QA_STOPPING"
        self.console_mode = "ALPHA"
        # Do not auto-resume openings unless requested AND flat
        self.alpha_opening_enabled = bool(resume_alpha_openings and flat_ok)
        self.orchestrator.context["alpha_opening_enabled"] = self.alpha_opening_enabled
        self.orchestrator.context["console_mode"] = self.console_mode
        self.bus.emit(
            "console.mode.changed",
            {
                "console_mode": self.console_mode,
                "qa_state": qa_state,
                "alpha_opening_enabled": self.alpha_opening_enabled,
                "active_strategy_id": self.active_strategy,
            },
        )
        return {
            "ok": flat_ok,
            "qa_state": qa_state,
            "console_mode": self.console_mode,
            "simulator_position_notional_usdt": runner.sim.position_notional_usdt,
            "pending_simulator_orders": len(
                [o for o in runner.sim.orders.values() if o.status in ("NEW", "PARTIAL", "ACK_PENDING")]
            ),
            "alpha_opening_enabled": self.alpha_opening_enabled,
            "active_strategy_id": self.active_strategy,
        }

    def resume_alpha_openings(self) -> Dict[str, Any]:
        if self.console_mode == "QA_HFT_SIM":
            return {
                "ok": False,
                "error": {"code": "QA_STILL_ACTIVE", "message": "exit QA mode before resuming alpha openings"},
            }
        from src.qa.hft_sim_runner import get_hft_runner

        runner = get_hft_runner()
        if abs(float(runner.sim.position_notional_usdt)) > 0.01:
            return {
                "ok": False,
                "error": {"code": "HFT_SIM_NOT_FLAT", "message": "simulator not flat"},
            }
        self.alpha_opening_enabled = True
        self.orchestrator.context["alpha_opening_enabled"] = True
        return {"ok": True, "alpha_opening_enabled": True, "active_strategy_id": self.active_strategy}

    def set_active_strategy(self, strategy_id: str) -> Dict[str, Any]:
        """Backward-compatible alias → atomic switch."""
        return self.switch_strategy(
            strategy_id=strategy_id,
            reason="manual_user_switch",
            operator_id="system",
        )

    def switch_strategy(
        self,
        *,
        strategy_id: str,
        reason: str = "manual_user_switch",
        operator_id: str = "system",
    ) -> Dict[str, Any]:
        """
        Atomic single-active alpha switch (Phase A+B TradeIntent + opening OrderIntent):
        - S6/S7 prechecks
        - invalidate previous strategy pending TradeIntents
        - cancel unsubmitted / opening OrderIntents (preserve reduce-only)
        - flip active_strategy_id (orchestrator hard gate)
        Position ownership is Phase D1.
        """
        if strategy_id not in ("S1", "S2"):
            return {"ok": False, "error": {"code": "INVALID_STRATEGY", "message": "only S1/S2"}}

        with self._strategy_switch_lock:
            prev = self.active_strategy if self.active_strategy in ("S1", "S2") else "S1"
            if strategy_id == prev:
                return {
                    "ok": True,
                    "noop": True,
                    "previous": prev,
                    "active_strategy": prev,
                    "invalidated_trade_intent_ids": [],
                }

            s6_level = int(getattr(self.orchestrator.s6, "level", 0) or 0)
            if s6_level >= 2:
                return {
                    "ok": False,
                    "error": {
                        "code": "STRATEGY_SWITCH_SAFETY_BLOCKED",
                        "message": f"S6.level={s6_level} blocks strategy switch",
                        "s6_level": s6_level,
                    },
                }

            target_health = self.orchestrator.s7.score_strategy(strategy_id)
            target_state = str(target_health.get("state") or "ON").upper()
            if target_state in ("PAUSED", "OFF"):
                return {
                    "ok": False,
                    "error": {
                        "code": "TARGET_STRATEGY_UNHEALTHY",
                        "message": f"target {strategy_id} health_state={target_state}",
                        "health_state": target_state,
                        "health_score": target_health.get("health_score"),
                    },
                }

            if target_state == "WARMING_UP" and self.mode != "paper":
                prior = getattr(self.orchestrator.edge, "validated_oos_prior", None)
                if not prior:
                    return {
                        "ok": False,
                        "error": {
                            "code": "TARGET_STRATEGY_WARMING_UP",
                            "message": "WARMING_UP requires validated OOS prior in live mode",
                            "health_state": target_state,
                        },
                    }

            # Stop previous alpha from emitting + invalidate its pending intents
            invalidated = self.orchestrator.lifecycle.invalidate_strategy_intents(
                prev,
                reason="ACTIVE_STRATEGY_CHANGED",
            )
            # Also clear cycle-local pending intents belonging to previous strategy
            ctx_intents = list(self.orchestrator.context.get("trade_intents") or [])
            kept = []
            for intent in ctx_intents:
                sid = getattr(intent, "strategy_id", None) or (
                    intent.get("strategy_id") if isinstance(intent, dict) else None
                )
                status = getattr(intent, "status", None) or (
                    intent.get("status") if isinstance(intent, dict) else None
                )
                if sid == prev and status in (
                    "CREATED",
                    "WAITING_EXECUTION_CONFIRMATION",
                    "CONFIRMED",
                    "STRATEGY_SWITCH_INVALIDATED",
                ):
                    continue
                kept.append(intent)
            if self.orchestrator.context:
                self.orchestrator.context["trade_intents"] = kept

            cancelled = self._cancel_opening_order_intents_for_strategy(prev)

            changed_at = _now_iso()
            self.active_strategy = strategy_id
            self.orchestrator.active_strategy_id = strategy_id
            self._active_strategy_changed_at = changed_at
            self.store.set_kv("active_strategy", strategy_id, changed_at)

            audit = {
                "timestamp": changed_at,
                "operator_id": operator_id,
                "previous_strategy_id": prev,
                "new_strategy_id": strategy_id,
                "engine_mode": self.mode,
                "s6_level": s6_level,
                "target_s7_state": target_state,
                "invalidated_trade_intent_ids": invalidated,
                "cancelled_order_intent_ids": cancelled,
                "preserved_position_ids": [
                    p.position_id for p in self.positions.list_open(origin_strategy_id=prev)
                ],
                "result": "OK",
                "reason": reason,
            }
            self.store.set_kv("last_strategy_switch_audit", audit, changed_at)
            self.bus.emit(
                "strategy.active.changed",
                {
                    "previous_strategy_id": prev,
                    "active_strategy_id": strategy_id,
                    "timestamp": changed_at,
                    "invalidated_trade_intent_ids": invalidated,
                    "cancelled_order_intent_ids": cancelled,
                    "operator_id": operator_id,
                    "reason": reason,
                },
            )
            self.bus.emit("engine.status", {"active_strategy": strategy_id, "previous": prev})
            return {
                "ok": True,
                "previous": prev,
                "active_strategy": strategy_id,
                "invalidated_trade_intent_ids": invalidated,
                "cancelled_order_intent_ids": cancelled,
                "audit": audit,
            }

    def _order_intent_strategy_id(self, oi: Dict[str, Any]) -> str:
        sid = str(oi.get("strategy_id") or "").strip()
        if sid:
            return sid
        risk = oi.get("risk_snapshot") or {}
        if isinstance(risk, dict) and risk.get("strategy_id"):
            return str(risk.get("strategy_id"))
        ti = str(oi.get("trade_intent_id") or "")
        if ti:
            intent = self.orchestrator.lifecycle.get(ti)
            if intent:
                return str(intent.strategy_id)
        return ""

    def _is_opening_order_intent(self, oi: Dict[str, Any]) -> bool:
        if bool(oi.get("reduce_only")):
            return False
        # stop/tp style flags if present
        purpose = str(oi.get("purpose") or oi.get("order_purpose") or "").lower()
        if purpose in ("stop_loss", "take_profit", "reduce_only", "exit"):
            return False
        return True

    def _cancel_opening_order_intents_for_strategy(self, strategy_id: str) -> List[str]:
        """Phase B: cancel unsubmitted / opening orders for previous strategy; preserve reduce-only."""
        cancelled: List[str] = []
        pending_ctx = list((self.orchestrator.context or {}).get("pending_order_intents") or [])
        kept_pending = []
        for oi in pending_ctx:
            if not isinstance(oi, dict):
                kept_pending.append(oi)
                continue
            if self._order_intent_strategy_id(oi) != strategy_id:
                kept_pending.append(oi)
                continue
            if not self._is_opening_order_intent(oi):
                kept_pending.append(oi)
                continue
            oid = str(oi.get("order_intent_id") or "")
            oi["status"] = "STRATEGY_SWITCH_CANCELLED"
            oi["cancel_reason"] = "ACTIVE_STRATEGY_CHANGED"
            if oid:
                cancelled.append(oid)
                self.store.upsert_order_intent(
                    oid,
                    str(oi.get("trade_intent_id") or ""),
                    "STRATEGY_SWITCH_CANCELLED",
                    oi,
                    _now_iso(),
                )
                self.bus.emit("order_intent.updated", oi)
        if self.orchestrator.context is not None:
            self.orchestrator.context["pending_order_intents"] = kept_pending

        for oi in list(self.order_intents):
            if not isinstance(oi, dict):
                continue
            if self._order_intent_strategy_id(oi) != strategy_id:
                continue
            if not self._is_opening_order_intent(oi):
                continue
            status = str(oi.get("status") or "").upper()
            if status in (
                "FILLED",
                "STRATEGY_SWITCH_CANCELLED",
                "CANCELLED",
                "CANCELED",
                "REJECTED",
                "SAFETY_BLOCKED",
            ):
                continue
            oid = str(oi.get("order_intent_id") or "")
            exchange_id = str(oi.get("exchange_order_id") or "").strip()
            # Unsubmitted / gateway-pending → local cancel only
            if status in ("PENDING_GATEWAY", "RECEIVED", "") and not exchange_id:
                oi["status"] = "STRATEGY_SWITCH_CANCELLED"
                oi["cancel_reason"] = "ACTIVE_STRATEGY_CHANGED"
                if oid:
                    cancelled.append(oid)
                    self.store.upsert_order_intent(
                        oid,
                        str(oi.get("trade_intent_id") or ""),
                        "STRATEGY_SWITCH_CANCELLED",
                        oi,
                        _now_iso(),
                    )
                    self.bus.emit("order_intent.updated", oi)
                continue
            # Submitted opening → request Node/OKX cancel (paper modes may no-op)
            if exchange_id or status in ("SUBMITTED", "PARTIAL", "LIVE", "NEW"):
                ok = self._request_node_cancel_order(oi)
                oi["status"] = "STRATEGY_SWITCH_CANCELLED" if ok else "CANCEL_REQUESTED"
                oi["cancel_reason"] = "ACTIVE_STRATEGY_CHANGED"
                if oid:
                    cancelled.append(oid)
                    self.store.upsert_order_intent(
                        oid,
                        str(oi.get("trade_intent_id") or ""),
                        str(oi.get("status")),
                        oi,
                        _now_iso(),
                    )
                    self.bus.emit("order_intent.updated", oi)
        return cancelled

    def _request_node_cancel_order(self, oi: Dict[str, Any]) -> bool:
        """Ask Node execution gateway to cancel an opening order on OKX."""
        if self.execution_mode == "paper":
            # Paper: treat as cancelled locally; no exchange call
            return True
        payload = {
            "order_intent_id": oi.get("order_intent_id"),
            "client_order_id": oi.get("client_order_id"),
            "exchange_order_id": oi.get("exchange_order_id"),
            "symbol": oi.get("symbol"),
            "user_id": oi.get("user_id"),
            "reduce_only": bool(oi.get("reduce_only")),
            "reason": "ACTIVE_STRATEGY_CHANGED",
        }
        try:
            with httpx.Client(timeout=15.0) as client:
                res = client.post(
                    f"{self.node_gateway_url}/api/whale-ai/engine/internal/cancel-order",
                    headers={"X-Engine-Token": self.node_token, "Content-Type": "application/json"},
                    json=payload,
                )
                if res.status_code >= 400:
                    oi["cancel_error"] = res.text[:300]
                    return False
                return True
        except Exception as err:  # noqa: BLE001
            oi["cancel_error"] = str(err)
            return False

    def register_owned_position(self, candidate: Dict[str, Any]) -> Dict[str, Any]:
        """Stamp ownership; origin_strategy_id never flips on later active changes."""
        origin = str(candidate.get("origin_strategy_id") or "").strip()
        if origin not in ("S1", "S2"):
            raise ValueError("origin_strategy_id required")
        ti = str(candidate.get("origin_trade_intent_id") or "").strip()
        if not ti:
            raise ValueError("origin_trade_intent_id required")
        # Idempotent: one open position per trade_intent
        for existing in self.positions.list_open():
            if existing.origin_trade_intent_id == ti:
                return existing.to_dict()
        pos = self.positions.open_from_fill(
            symbol=str(candidate.get("symbol") or ""),
            side=str(candidate.get("side") or ""),
            quantity=float(candidate.get("quantity") or 0.0),
            origin_strategy_id=origin,
            origin_trade_intent_id=ti,
            entry_risk_snapshot=dict(candidate.get("entry_risk_snapshot") or {}),
            stop_policy_snapshot=dict(candidate.get("stop_policy_snapshot") or {}),
            exit_policy_snapshot=dict(candidate.get("exit_policy_snapshot") or {}),
            metadata=dict(candidate.get("metadata") or {}),
        )
        payload = pos.to_dict()
        self.store.upsert_open_position(payload, _now_iso())
        self.bus.emit("position.opened", payload)
        return payload

    def exit_policy_for_position(self, position_id: str) -> Dict[str, Any]:
        pos = self.positions.get(position_id)
        if not pos:
            return {"ok": False, "error": {"code": "POSITION_NOT_FOUND"}}
        return {
            "ok": True,
            "position_id": pos.position_id,
            "origin_strategy_id": pos.origin_strategy_id,
            "active_strategy_id": self.active_strategy,
            "ownership_transferred": False,
            "exit_managed_by": pos.origin_strategy_id,
            "exit_policy_snapshot": pos.exit_policy_snapshot,
            "stop_policy_snapshot": pos.stop_policy_snapshot,
        }

    def apply_execution_report(self, report: Dict[str, Any]) -> Dict[str, Any]:
        # QA-HFT-SIM / test traffic must never pollute S7 / ownership / edge stats
        if (
            bool(report.get("test_mode"))
            or bool(report.get("exclude_from_strategy_health"))
            or str(report.get("execution_target") or "").lower() == "simulator"
        ):
            self.store.snapshot_row("execution_metrics", {**report, "qa_excluded": True}, _now_iso())
            self.bus.emit("qa.execution_report", report)
            return {"ok": True, "excluded_from_strategy_stats": True}

        oid = str(report.get("order_intent_id") or "")
        for item in self.order_intents:
            if str(item.get("order_intent_id")) == oid:
                item["status"] = str(report.get("status") or item.get("status"))
                item["execution_report"] = report
                self.store.upsert_order_intent(
                    oid,
                    str(item.get("trade_intent_id") or ""),
                    str(item.get("status") or ""),
                    item,
                    _now_iso(),
                )
                ti = str(item.get("trade_intent_id") or "")
                intent = self.orchestrator.lifecycle.get(ti) if ti else None
                status_u = str(report.get("status", "")).upper()
                if intent and status_u in ("FILLED", "WOULD_SUBMIT"):
                    if status_u == "FILLED" or (
                        status_u == "WOULD_SUBMIT" and self.execution_mode == "node_gateway_shadow"
                    ):
                        # Shadow: record ownership without exchange fill; live FILLED: same
                        if not bool(item.get("reduce_only")):
                            self.register_owned_position(
                                {
                                    "symbol": item.get("symbol") or (intent.symbol if intent else ""),
                                    "side": item.get("position_side")
                                    or ("long" if str(intent.direction).lower() == "long" else "short"),
                                    "quantity": float(
                                        report.get("filled_quantity")
                                        or item.get("quantity")
                                        or 0.0
                                    ),
                                    "origin_strategy_id": item.get("origin_strategy_id")
                                    or intent.strategy_id,
                                    "origin_trade_intent_id": intent.intent_id,
                                    "entry_risk_snapshot": item.get("entry_risk_snapshot")
                                    or item.get("risk_snapshot")
                                    or {},
                                    "exit_policy_snapshot": item.get("exit_policy_snapshot") or {},
                                    "stop_policy_snapshot": item.get("stop_policy_snapshot") or {},
                                    "metadata": {
                                        "order_intent_id": oid,
                                        "execution_status": status_u,
                                    },
                                }
                            )
                    if status_u == "FILLED":
                        self.orchestrator.lifecycle.transition(intent, "EXECUTED")
                        self.orchestrator.s7.add_trade(
                            intent.strategy_id,
                            {
                                "r_multiple": float(report.get("realized_R") or 0.1),
                                "slippage_vs_model_ratio": 1.0,
                                "regime": self.orchestrator.context.get("S3.regime", "range"),
                                "win": True,
                            },
                        )
                self.bus.emit("order_intent.updated", item)
                break
        self.store.snapshot_row("execution_metrics", report, _now_iso())
        return {"ok": True}

    async def _dispatch_order_intents(self, intents: List[Dict[str, Any]]) -> None:
        if self.execution_mode not in ("node_gateway", "node_gateway_shadow") or not intents:
            return
        if int(self.orchestrator.s6.level) >= 2:
            # L2+ block new opening intents
            for oi in intents:
                if not bool(oi.get("reduce_only")):
                    oi["status"] = "SAFETY_BLOCKED"
                    self.bus.emit("order_intent.updated", oi)
            return
        async with httpx.AsyncClient(timeout=30.0) as client:
            for oi in intents:
                if self.execution_mode == "node_gateway_shadow":
                    oi["shadow"] = True
                self.order_intents.insert(0, oi)
                self.order_intents = self.order_intents[:100]
                self.store.upsert_order_intent(
                    str(oi["order_intent_id"]),
                    str(oi.get("trade_intent_id") or ""),
                    str(oi.get("status") or "PENDING_GATEWAY"),
                    oi,
                    _now_iso(),
                )
                self.bus.emit("order_intent.created", oi)
                try:
                    res = await client.post(
                        f"{self.node_gateway_url}/api/whale-ai/engine/internal/order-intent",
                        headers={"X-Engine-Token": self.node_token, "Content-Type": "application/json"},
                        json=oi,
                    )
                    if res.status_code >= 400:
                        oi["status"] = "GATEWAY_ERROR"
                        oi["gateway_error"] = res.text[:300]
                        self.bus.emit("order_intent.updated", oi)
                    else:
                        body = {}
                        try:
                            body = res.json()
                        except Exception:
                            body = {}
                        if body.get("shadow") or body.get("report", {}).get("status") == "WOULD_SUBMIT":
                            report = body.get("report") or {
                                "order_intent_id": oi.get("order_intent_id"),
                                "status": "WOULD_SUBMIT",
                            }
                            self.apply_execution_report(report)
                except Exception as err:  # noqa: BLE001
                    oi["status"] = "GATEWAY_ERROR"
                    oi["gateway_error"] = str(err)
                    self.bus.emit("order_intent.updated", oi)

    def _persist_and_emit(self, snap: Dict[str, Any]) -> None:
        now = _now_iso()
        s3 = snap.get("s3") or {}
        s5 = snap.get("s5") or {}
        s6 = snap.get("s6") or {}
        s7 = snap.get("s7") or []
        if s3:
            self.store.snapshot_row("market_regime_snapshots", s3, now)
            regime = s3.get("regime")
            if regime and regime != self._prev_regime:
                self.bus.emit("market.regime.updated", s3)
                self._prev_regime = regime
        if s5:
            self.store.snapshot_row("risk_budget_snapshots", s5, now)
            self.bus.emit("risk.budget.updated", s5)
        if s7:
            self.store.snapshot_row("strategy_health_snapshots", {"items": s7}, now)
            self.bus.emit("strategy.health.updated", {"items": s7})
        if s6:
            lvl = int(s6.get("level") or 0)
            if self._prev_s6 is None or lvl != self._prev_s6:
                self.bus.emit("system.safety.updated", s6)
                self._prev_s6 = lvl
        for intent in snap.get("trade_intents") or []:
            iid = str(intent.get("intent_id") or "")
            if not iid:
                continue
            self.store.upsert_intent(
                iid,
                str(intent.get("strategy_id") or ""),
                str(intent.get("status") or ""),
                intent,
                now,
            )
            status = str(intent.get("status") or "")
            if status in ("CREATED", "WAITING_EXECUTION_CONFIRMATION"):
                self.bus.emit("trade_intent.created", intent)
            else:
                self.bus.emit("trade_intent.updated", intent)
        self.bus.emit("engine.status", {"state": self.state, "last_tick_at": self.last_tick_at})

    async def _loop(self) -> None:
        while not self._stop.is_set():
            await self._pause.wait()
            if self._stop.is_set():
                break
            if self.state == "LOCKED":
                await asyncio.sleep(self.tick_interval_sec)
                continue
            t0 = asyncio.get_event_loop().time()
            try:
                self.orchestrator.active_strategy_id = self.active_strategy
                ctx = await self.orchestrator.run_cycle(microstructure=dict(self._default_micro))
                for cand in list(ctx.get("opened_position_candidates") or []):
                    try:
                        self.register_owned_position(cand)
                    except Exception as err:  # noqa: BLE001
                        self.last_error = f"position_register: {err}"
                pending = list(ctx.get("pending_order_intents") or [])
                await self._dispatch_order_intents(pending)
                self.last_tick_at = _now_iso()
                self.last_error = None
                if self.state not in ("PAUSED", "LOCKED", "RECOVERY"):
                    self.state = "RUNNING"
                snap = self.snapshot()
                self._persist_and_emit(snap)
            except Exception as err:  # noqa: BLE001
                self.last_error = str(err)
                self.bus.emit("engine.status", {"state": self.state, "error": self.last_error})
            lag = (asyncio.get_event_loop().time() - t0) * 1000.0
            self.event_loop_lag_ms = round(lag, 2)
            await asyncio.sleep(self.tick_interval_sec)

    async def shutdown(self) -> None:
        self._stop.set()
        self._pause.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        try:
            self.store.close()
        except Exception:
            pass
        self.state = "OFFLINE"
        self.bus.emit("engine.status", {"state": "OFFLINE"})


_runtime: Optional[EngineRuntime] = None


def get_runtime() -> EngineRuntime:
    global _runtime
    if _runtime is None:
        mode = os.getenv("V41_ENGINE_MODE", "paper")
        symbol = os.getenv("V41_ENGINE_SYMBOL", "BTC/USDT:USDT")
        tick = float(os.getenv("V41_ENGINE_TICK_SEC", "5"))
        execution_mode = os.getenv("V41_ENGINE_EXECUTION_MODE", "paper")
        _runtime = EngineRuntime(
            mode=mode,
            symbol=symbol,
            tick_interval_sec=tick,
            execution_mode=execution_mode,
        )
    return _runtime
