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
from src.runtime.alpha_ids import SELECTABLE_ALPHAS, coerce_selectable
from src.runtime.alpha_execution import (
    ALPHA_EXECUTE,
    ALPHA_SHADOW,
    LEGACY_PAPER_SOURCE,
    annotate_legacy_paper_metadata,
    annotate_position_dict,
    is_legacy_paper_position,
    is_runtime_test_fixture,
    live_trading_enabled,
    resolve_runtime_execution,
    strategy_live_allowed,
    user_id_ready,
)
from src.runtime.engine_store import EngineStore
from src.runtime.position_ownership import PositionOwnershipRegistry
from src.runtime.runtime_events import RuntimeEventRecorder
from src.telemetry.dashboard_snapshot import build_dashboard_snapshot
from src.telemetry.event_bus import get_event_bus

ROOT = Path(__file__).resolve().parents[2]

STRATEGY_META = {
    "S1": {
        "name": "趋势跟踪",
        "description": "适合趋势行情，结合趋势强度和波动率过滤寻找顺势机会。",
        "live_allowed": True,
    },
    "S2": {
        "name": "极端情绪反转",
        "description": "在极端超买超卖与反转确认条件同时满足时寻找反转机会。当前未接入真实 funding / OI。",
        "live_allowed": True,
    },
    "S9": {
        "name": "高频动量突破",
        "description": "分钟级短周期动量突破，仅用于 OKX 模拟盘验证，不允许实盘。",
        "live_allowed": False,
        "release_stage": "DEMO_VALIDATION",
    },
    "S8": {
        "name": "巨鲸行为共振",
        "description": "多巨鲸共识共振（尚未开放）。",
        "live_allowed": False,
        "release_stage": "RESEARCH",
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
        store_path: Optional[Path] = None,
    ) -> None:
        from src.runtime.config_loader import (
            ConfigError,
            SOURCE_MODULAR,
            load_legacy_runtime_config,
            load_runtime_config,
        )

        self.mode = mode
        self.symbol = symbol
        self.tick_interval_sec = float(tick_interval_sec)
        exec_norm = resolve_runtime_execution(execution_mode)
        self.alpha_execution = exec_norm["alpha_execution"]
        self.execution_mode = exec_norm["gateway_mode"]
        self.alpha_execution_meta = exec_norm
        self.config_status = "OK"
        self.config_error = None
        try:
            if config_path is not None:
                loaded = load_legacy_runtime_config(config_path)
            else:
                loaded = load_runtime_config()
        except ConfigError as exc:
            self.config_status = "CONFIG_INVALID"
            self.config_error = exc.to_dict()
            self.config_source_kind = SOURCE_MODULAR if config_path is None else "LEGACY_CONFIG"
            # Fail closed: never silently load the deprecated monolith.
            raise
        self.config_bundle = loaded
        self.config_source_kind = loaded.source_kind
        self.config_path = Path(loaded.system_path or (ROOT / "config" / "system.json"))
        default_active = (
            (loaded.effective.get("strategy_runtime") or {}).get("default_active_strategy_id") or active_strategy
        )
        self.active_strategy = coerce_selectable(default_active)
        self.user_id = os.getenv("V41_ENGINE_USER_ID") or None
        self.account_scope = os.getenv("V41_ENGINE_ACCOUNT_SCOPE", "default")
        self.node_gateway_url = os.getenv("V41_NODE_GATEWAY_URL", "http://127.0.0.1:80").rstrip("/")
        self.node_token = os.getenv("V41_ENGINE_INTERNAL_TOKEN", "dev-internal-token")

        self.orchestrator = Orchestrator(loaded.effective, mode=mode, symbol=symbol)
        self.orchestrator.execution_mode = self.execution_mode
        self.orchestrator.alpha_execution = self.alpha_execution
        self.orchestrator.user_id = self.user_id
        self.orchestrator.account_scope = self.account_scope
        self.orchestrator.context["user_id"] = self.user_id
        self.config_version = str((self.orchestrator.config.get("meta") or {}).get("version") or "4.1")
        self.runtime_model = str(
            (self.orchestrator.config.get("meta") or {}).get("runtime_model")
            or (self.orchestrator.config.get("strategy_runtime") or {}).get("selection_mode")
            or "unknown"
        )
        print(
            f"CONFIG_LOADED version={self.config_version} "
            f"runtime_model={self.runtime_model} source={self.config_source_kind} "
            f"path={self.config_path}"
        )
        print(
            f"AlphaExecution = {self.alpha_execution} "
            f"AccountEnvironment = OKX_DEMO / OKX_LIVE "
            f"LivePermission = {str(live_trading_enabled()).lower()} "
            f"MarketData = REAL_OKX"
        )
        if exec_norm.get("deprecation_code"):
            print(exec_norm["deprecation_code"])

        self.store = EngineStore(store_path)
        self.orchestrator.engine_store = self.store
        self.bus = get_event_bus()
        self.event_recorder = RuntimeEventRecorder(self.store)
        self.bus.set_persist_hook(self.event_recorder.persist_bus_event)
        self.positions = PositionOwnershipRegistry()
        self.positions.load(self.store.list_open_positions(200))
        self._annotate_loaded_positions()
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
        if saved in SELECTABLE_ALPHAS:
            self.active_strategy = saved
        self.orchestrator.active_strategy_id = self.active_strategy

        # Console execution selection (alpha vs QA). QA is NOT an alpha strategy.
        self.console_mode = "ALPHA"  # ALPHA | QA_HFT_SIM
        self.alpha_opening_enabled = True
        self.previous_active_strategy_id = self.active_strategy
        self.orchestrator.context["alpha_opening_enabled"] = True
        self.orchestrator.context["console_mode"] = self.console_mode
        self._s9_ws_started = False
        self._wire_s9_market()

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

    def bind_user(self, user_id: Any) -> Dict[str, Any]:
        uid = str(user_id or "").strip()
        self.user_id = uid or None
        self.orchestrator.user_id = self.user_id
        self.orchestrator.context["user_id"] = self.user_id
        return {"ok": True, "user_id": self.user_id, "user_id_ready": user_id_ready(self.user_id)}

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
                "tick_interval_sec": self.tick_interval_sec,
                "alpha_execution": getattr(self, "alpha_execution", ALPHA_SHADOW),
                "version": getattr(self, "config_version", "4.1"),
                **self.s9_status(),
            }
        return {
            "ok": True,
            "engine": "v4.2" if str(getattr(self, "config_version", "")).startswith("4.2") else "v4.1",
            "mode": self.mode,
            "state": self.state,
            "started_at": self.started_at,
            "last_tick_at": self.last_tick_at,
            "event_loop_lag_ms": self.event_loop_lag_ms,
            "tick_interval_sec": self.tick_interval_sec,
            "version": getattr(self, "config_version", "4.1"),
            "runtime_model": getattr(self, "runtime_model", None),
            "active_strategy": self.active_strategy,
            "execution_mode": self.execution_mode,
            "alpha_execution": getattr(self, "alpha_execution", ALPHA_SHADOW),
            "live_permission": live_trading_enabled(),
            "user_id_ready": user_id_ready(self.user_id),
            "console_mode": getattr(self, "console_mode", "ALPHA"),
            "alpha_opening_enabled": getattr(self, "alpha_opening_enabled", True),
            "hft_sim_enabled": self.hft_sim_enabled(),
            "last_error": self.last_error,
            "event_sequence": self.bus.sequence,
            "last_evaluated_at": self._active_diag().last_evaluated_at if self._active_diag() else None,
            "evaluation_count": self._active_diag().evaluation_count if self._active_diag() else 0,
            **self.s9_status(),
        }

    def _wire_s9_market(self) -> None:
        hub = getattr(self.orchestrator, "s9_hub", None)
        fee = getattr(self.orchestrator, "s9_fee", None)
        if fee is not None:
            fee.node_url = self.node_gateway_url
            fee.token = self.node_token

        def on_event(event_type: str, details: Dict[str, Any]) -> None:
            bus_type = "s9.market"
            if str(event_type).startswith("S9_FEE"):
                bus_type = "s9.fee"
            elif str(event_type).startswith("S9_PRESUBMIT"):
                bus_type = "s9.presubmit"
            self.bus.emit(bus_type, {"event_type": event_type, **(details or {})})

        if hub is not None:
            hub.on_event = on_event

    def s9_status(self) -> Dict[str, Any]:
        from src.runtime.s9_readiness import s9_status_bundle

        orch = self.orchestrator
        hub = getattr(orch, "s9_hub", None)
        fee = getattr(orch, "s9_fee", None)
        fee_ready = bool(fee and fee.snapshot().get("ready"))
        snap = hub.snapshot(fee_ready=fee_ready) if hub is not None else {}
        owned = list(getattr(orch, "owned_open_positions", None) or [])
        ownership_clear = True
        for pos in owned:
            if isinstance(pos, dict):
                qty = float(pos.get("quantity") or pos.get("owned_remaining_base_qty") or 0)
            else:
                qty = float(getattr(pos, "quantity", 0) or 0)
            if abs(qty) > 0:
                ownership_clear = False
                break
        return s9_status_bundle(
            runtime={
                "account_environment": "OKX_DEMO",
                "live_allowed": False,
                "live_permission": live_trading_enabled(),
                "trusted_owner_ready": user_id_ready(self.user_id),
                "user_id_ready": user_id_ready(self.user_id),
                "s6_level": int((orch.context or {}).get("S6.level") or 0),
                "reconciliation_status": (orch.context or {}).get("reconciliation_status") or "MATCHED",
                "ownership_clear": ownership_clear,
                "data_state": snap.get("data_state"),
                "fee_ready": fee_ready,
                "demo_allowed": True,
            }
        )

    def _start_s9_public_ws(self) -> None:
        if self._s9_ws_started:
            return
        if os.getenv("PYTEST_CURRENT_TEST"):
            return
        if str(os.getenv("V41_S9_PUBLIC_WS", "1")).strip().lower() in {"0", "false", "off"}:
            return
        from src.adapters.okx_public_ws import (
            BUSINESS_WS_URL,
            PUBLIC_WS_URL,
            S9_CANDLE_CHANNELS,
            S9_PUBLIC_CHANNELS,
            OkxPublicWsClient,
        )

        hub = getattr(self.orchestrator, "s9_hub", None)
        if hub is None:
            return
        public = OkxPublicWsClient(url=PUBLIC_WS_URL, channels=S9_PUBLIC_CHANNELS)
        candle = OkxPublicWsClient(url=BUSINESS_WS_URL, channels=S9_CANDLE_CHANNELS)
        hub.attach_client(public, role="public")
        hub.attach_client(candle, role="candle")
        public.start()
        candle.start()
        self._s9_ws_started = True

    def _s1_diag(self):
        return (getattr(self.orchestrator, "diagnostics", {}) or {}).get("S1")

    def _active_diag(self):
        sid = coerce_selectable(self.active_strategy)
        return (getattr(self.orchestrator, "diagnostics", {}) or {}).get(sid)

    def strategy_diagnostics(self, strategy_id: str = "S1") -> Dict[str, Any]:
        sid = coerce_selectable(strategy_id)
        diag = (getattr(self.orchestrator, "diagnostics", {}) or {}).get(sid)
        pool = self.orchestrator.data_pool
        indicators = {
            "close": pool.get("close"),
            "ema20": pool.get("ema20"),
            "ema50": pool.get("ema50"),
            "adx14": pool.get("adx14"),
            "atr14": pool.get("atr14"),
            "trend_slope_6": pool.get("trend_slope_6"),
            "trend_quality_score": pool.get("trend_quality_score"),
        }
        gates = {
            "S1": {"result": (diag.last_decision if diag else "NO_TRADE")},
            "S3": {"regime": (self.orchestrator.context or {}).get("S3.regime"), "result": "BLOCK" if (diag and any(c.startswith("S3_") for c in (diag.last_reason_codes or []))) else "ALLOW"},
            "S5": {"result": "NOT_REACHED" if not diag or diag.last_decision != "ALLOW" else "ALLOW"},
            "S6": {"level": (self.orchestrator.context or {}).get("S6.level", 0), "result": "ALLOW" if int((self.orchestrator.context or {}).get("S6.level") or 0) < 2 else "BLOCK"},
            "S7": {"result": "NOT_REACHED"},
            "edge": {"expected_edge_after_cost_R": (self.orchestrator.context or {}).get("expected_edge_after_cost_R")},
            "S4": {"result": "NOT_REACHED" if not diag or not diag.trade_intent_created_count else "ALLOW"},
        }
        payload = (
            diag.to_dict(
                active=self.active_strategy == sid,
                runtime_state=self.state,
                alpha_opening_enabled=self.alpha_opening_enabled,
                last_tick_at=self.last_tick_at,
                market_data=dict(getattr(self.orchestrator, "market_meta", {}) or {}),
                indicators=indicators,
                gates=gates,
            )
            if diag
            else {"strategy_id": sid, "active": self.active_strategy == sid, "runtime_state": self.state}
        )
        if diag and diag.pending_log_event:
            payload["pending_log_event"] = dict(diag.pending_log_event)
        return payload

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
                    "alpha_execution": getattr(self, "alpha_execution", ALPHA_SHADOW),
                },
                "s3": None,
                "s5": None,
                "s6": None,
                "s7": [],
                "trade_intents": [],
                "order_intents": self._current_order_intents(),
                "open_positions": self._serialize_open_positions(),
                "execution": self._execution_snapshot([]),
                "incidents": list(self.incidents),
                "edge": None,
                "view": {
                    "engine": {
                        "available": False,
                        "state": "OFFLINE",
                        "alpha_execution": getattr(self, "alpha_execution", ALPHA_SHADOW),
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
        snap["order_intents"] = self._current_order_intents()
        snap["open_positions"] = self._serialize_open_positions()
        snap["active_strategy"] = self.get_active_strategy()
        self._attach_execution_architecture(snap)
        return snap

    async def start(self) -> Dict[str, Any]:
        if getattr(self, "config_status", "OK") != "OK":
            self.alpha_opening_enabled = False
            return {
                "ok": False,
                "error": self.config_error or {"code": "CONFIG_INVALID", "message": "engine config invalid"},
            }
        if self.state == "LOCKED":
            return {"ok": False, "error": {"code": "S6_BLOCKED", "message": "engine locked; resume first"}}
        if self._task and not self._task.done():
            self._pause.set()
            if self.state != "LOCKED":
                self.state = "RUNNING"
            if self.console_mode != "QA_HFT_SIM":
                self._set_alpha_opening(True)
            try:
                self._start_s9_public_ws()
            except Exception as exc:  # noqa: BLE001
                self.last_error = f"s9 public ws: {exc}"
            self.bus.emit("engine.status", {"state": self.state, "alpha_opening_enabled": self.alpha_opening_enabled})
            return {"ok": True, "state": self.state, "alpha_opening_enabled": self.alpha_opening_enabled}
        self._stop.clear()
        self._pause.set()
        self.started_at = self.started_at or _now_iso()
        self.state = "RUNNING"
        if self.console_mode != "QA_HFT_SIM":
            self._set_alpha_opening(True)
        self._task = asyncio.create_task(self._loop(), name="v41-engine-loop")
        self.bus.emit("engine.status", {"state": self.state})
        try:
            self._start_s9_public_ws()
        except Exception as exc:  # noqa: BLE001
            self.last_error = f"s9 public ws: {exc}"
        return {"ok": True, "state": self.state, "alpha_opening_enabled": self.alpha_opening_enabled}

    def _interrupt_qa(self) -> None:
        """Allow control endpoints to stop QA without waiting for cycle completion."""
        try:
            from src.qa.hft_sim_runner import get_hft_runner

            get_hft_runner().running = False
        except Exception:
            pass

    def _set_alpha_opening(self, enabled: bool) -> None:
        self.alpha_opening_enabled = bool(enabled)
        self.orchestrator.alpha_opening_enabled = self.alpha_opening_enabled
        self.orchestrator.context["alpha_opening_enabled"] = self.alpha_opening_enabled

    async def pause(self) -> Dict[str, Any]:
        self._interrupt_qa()
        if self.state == "LOCKED":
            # Already stopped harder than pause — treat as success for UI「停止」
            self._set_alpha_opening(False)
            return {
                "ok": True,
                "state": self.state,
                "alpha_opening_enabled": False,
                "note": "already_locked",
            }
        self._pause.clear()
        self.state = "PAUSED"
        self._set_alpha_opening(False)
        self.bus.emit("engine.status", {"state": self.state, "alpha_opening_enabled": False})
        return {"ok": True, "state": self.state, "alpha_opening_enabled": False}

    async def kill(self, *, reason: str = "MANUAL_EMERGENCY_STOP", operator_id: str = "system") -> Dict[str, Any]:
        self._interrupt_qa()
        self.orchestrator.s6.raise_hard_event(reason.lower())
        self.orchestrator.s6.evaluate_signals(self.orchestrator.data_pool, self.orchestrator.context)
        self._pause.clear()
        self.state = "LOCKED"
        self._set_alpha_opening(False)
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
        cancelled = self._cancel_owned_pending_openings(reason=reason)
        exit_intent = None
        owned = [
            p
            for p in self.positions.list_open(origin_strategy_id="S1")
            if "BTC" in str(getattr(p, "symbol", "") or "").upper() and float(getattr(p, "quantity", 0) or 0) > 0
        ]
        if len(owned) == 1:
            pos = owned[0]
            exit_intent = {
                "order_intent_id": f"exit-{pos.position_id}",
                "position_id": pos.position_id,
                "origin_strategy_id": "S1",
                "origin_trade_intent_id": pos.origin_trade_intent_id,
                "symbol": pos.symbol,
                "side": "sell" if str(pos.side).lower() in ("long", "buy") else "buy",
                "reduce_only": True,
                "purpose": "exit",
                "quantity_unit": "BASE",
                "base_quantity": float(pos.quantity),
                "owned_remaining_base_qty": float(pos.quantity),
                "status": "CREATED",
            }
            pending = self.orchestrator.context.setdefault("pending_order_intents", [])
            pending.append(exit_intent)
        self.bus.emit("engine.status", {"state": self.state})
        return {
            "ok": True,
            "state": self.state,
            "s6_level": self.orchestrator.s6.level,
            "incident": incident,
            "kill_v1": {
                "locked": True,
                "alpha_opening": False,
                "cancelled_opening_ids": cancelled,
                "reduce_only_exit": exit_intent,
                "flatten_account": False,
                "touch_external": False,
            },
        }

    def _cancel_owned_pending_openings(self, *, reason: str) -> List[str]:
        """Kill V1: cancel owned pending openings only. Never flatten the account."""
        cancelled: List[str] = []
        for oi in list(self.order_intents):
            if not isinstance(oi, dict) or bool(oi.get("reduce_only")):
                continue
            status = str(oi.get("status") or "").upper()
            if status not in ("CREATED", "PENDING_GATEWAY", "SUBMITTED", "PARTIALLY_FILLED", "PARTIAL", "RECEIVED"):
                continue
            oid = str(oi.get("order_intent_id") or "")
            if str(oi.get("status") or "").upper() in ("SUBMITTED", "PARTIAL", "PARTIALLY_FILLED") or oi.get(
                "exchange_order_id"
            ):
                self._request_node_cancel_order(oi)
                oi["status"] = "CANCEL_REQUESTED"
            else:
                oi["status"] = "CANCEL_REQUESTED"
            oi["cancel_reason"] = reason
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
        sid = coerce_selectable(self.active_strategy)
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
            "live_allowed": strategy_live_allowed(sid),
        }

    def list_strategies(self) -> Dict[str, Any]:
        items = []
        for sid in SELECTABLE_ALPHAS:
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
                    "live_allowed": strategy_live_allowed(sid),
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

    def _annotate_loaded_positions(self) -> None:
        for pos in list(self.positions.positions.values()):
            pos.metadata = annotate_legacy_paper_metadata(pos.metadata)

    def _current_order_intents(self) -> List[Dict[str, Any]]:
        return [oi for oi in list(self.order_intents) if not is_runtime_test_fixture(oi)]

    def _serialize_open_positions(self) -> List[Dict[str, Any]]:
        return [annotate_position_dict(p.to_dict()) for p in self.positions.list_open()]

    def list_exchange_open_positions(self) -> List[Dict[str, Any]]:
        return [p for p in self._serialize_open_positions() if not is_legacy_paper_position(p)]

    def _execution_snapshot(self, last_orders: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
        meta = getattr(self, "alpha_execution_meta", {}) or {}
        return {
            "mode": self.execution_mode,
            "alpha_execution": getattr(self, "alpha_execution", ALPHA_SHADOW),
            "legacy_execution_mode": meta.get("legacy_execution_mode"),
            "deprecated": bool(meta.get("deprecated")),
            "replacement": meta.get("replacement"),
            "last_orders": list(last_orders or []),
        }

    def _attach_execution_architecture(self, snap: Dict[str, Any]) -> Dict[str, Any]:
        sid = coerce_selectable(self.active_strategy)
        snap["alpha_execution"] = getattr(self, "alpha_execution", ALPHA_SHADOW)
        snap["account_environment"] = snap.get("account_environment")
        snap["live_permission"] = live_trading_enabled()
        snap["qa_backend"] = "EXCHANGE" if self.console_mode == "QA_HFT_SIM" else None
        snap["user_id_ready"] = user_id_ready(self.user_id)
        snap["strategy"] = {
            "id": sid,
            "live_allowed": strategy_live_allowed(sid),
        }
        engine = dict(snap.get("engine") or {})
        engine["alpha_execution"] = snap["alpha_execution"]
        engine["live_permission"] = snap["live_permission"]
        engine["user_id_ready"] = snap["user_id_ready"]
        snap["engine"] = engine
        exec_block = dict(snap.get("execution") or {})
        exec_block.update(self._execution_snapshot(exec_block.get("last_orders")))
        snap["execution"] = exec_block
        try:
            snap["s9_readiness"] = self.s9_status()
        except Exception:
            snap["s9_readiness"] = None
        return snap

    def list_execution_selections(self) -> Dict[str, Any]:
        """Unified selector: alpha strategies + QA test modes (QA is not alpha)."""
        items: List[Dict[str, Any]] = []
        for sid in SELECTABLE_ALPHAS:
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
                    "live_allowed": strategy_live_allowed(sid),
                }
            )
        # S8 placeholder — not implemented; do not fake available
        items.append(
            {
                "id": "S8",
                "kind": "alpha",
                "name": "巨鲸行为共振",
                "description": "多巨鲸共识共振（尚未开放）",
                "available": False,
                "release_stage": "RESEARCH",
                "live_allowed": False,
                "disabled_reason": "WARMING_UP_OR_NOT_IMPLEMENTED",
            }
        )
        hft_on = self.hft_sim_enabled()
        items.append(
            {
                "id": "QA-HFT-SIM",
                "kind": "qa_test",
                "name": "QA 开平仓测试",
                "description": "开平仓链路测试（≤50U），不计 S7/Edge；账户环境由当前用户 OKX 密钥识别",
                "available": hft_on,
                "execution_target": "exchange",
                "qa_backend": "EXCHANGE",
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
        self.orchestrator.alpha_opening_enabled = False
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
        self.orchestrator.alpha_opening_enabled = self.alpha_opening_enabled
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
        if strategy_id not in SELECTABLE_ALPHAS:
            return {"ok": False, "error": {"code": "INVALID_STRATEGY", "message": "only S1/S2/S9"}}

        with self._strategy_switch_lock:
            prev = coerce_selectable(self.active_strategy)
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
            if strategy_id == "S9":
                try:
                    self._start_s9_public_ws()
                except Exception as exc:  # noqa: BLE001
                    self.last_error = f"s9 public ws: {exc}"
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
        if self.execution_mode in ("paper", "node_gateway_shadow") or getattr(self, "alpha_execution", None) == ALPHA_SHADOW:
            # SHADOW / legacy paper: no exchange order exists
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

    def _entry_risk_snapshot_for_fill(self, candidate: Dict[str, Any], fill_qty: float) -> Dict[str, Any]:
        from src.runtime.risk_usage import enrich_entry_risk_snapshot

        raw = dict(candidate.get("entry_risk_snapshot") or candidate.get("risk_snapshot") or {})
        stop_pol = dict(candidate.get("stop_policy_snapshot") or {})
        # First real fill is the open anchor (not the planned order-intent qty).
        raw.pop("initial_filled_base_quantity", None)
        raw.pop("initial_risk_used_pct_equity_at_open", None)
        raw.pop("initial_risk_amount_quote_at_open", None)
        return enrich_entry_risk_snapshot(
            raw,
            filled_base_quantity=fill_qty,
            origin_strategy_id=str(candidate.get("origin_strategy_id") or raw.get("origin_strategy_id") or ""),
            entry_price=candidate.get("entry_price") or raw.get("entry_price"),
            stop_price=candidate.get("stop_price") or raw.get("stop_price") or stop_pol.get("stop_price"),
            equity=raw.get("equity_at_entry") or raw.get("equity") or (self.orchestrator.context or {}).get("equity"),
            planned_base_quantity=raw.get("base_quantity") or candidate.get("base_quantity"),
            planned_risk_pct=raw.get("risk_pct") or raw.get("risk_pct_equity") or candidate.get("risk_pct"),
        )

    def reduce_owned_position(
        self,
        *,
        position_id: Optional[str] = None,
        symbol: Optional[str] = None,
        origin_strategy_id: Optional[str] = None,
        close_qty: float,
    ) -> Optional[Dict[str, Any]]:
        pos = self.positions.get(str(position_id or "")) if position_id else None
        if pos is None:
            for item in self.positions.list_open():
                if symbol and str(item.symbol) != str(symbol):
                    continue
                if origin_strategy_id and str(item.origin_strategy_id) != str(origin_strategy_id):
                    continue
                pos = item
                break
        if pos is None:
            return None
        updated = self.positions.reduce_quantity(pos.position_id, close_qty)
        if updated is None:
            return None
        payload = updated.to_dict()
        self.store.upsert_open_position(payload, _now_iso())
        if updated.status == "CLOSED":
            self.bus.emit("position.closed", payload)
        else:
            self.bus.emit("position.reduced", payload)
        return payload

    def register_owned_position(self, candidate: Dict[str, Any]) -> Dict[str, Any]:
        """Stamp ownership; origin_strategy_id never flips on later active changes."""
        meta = dict(candidate.get("metadata") or {})
        if str(meta.get("source") or "") == LEGACY_PAPER_SOURCE:
            raise ValueError("LEGACY_PAPER_POSITION: paper_adapter cannot create new owned positions")
        if str(meta.get("execution_status") or "").upper() == "WOULD_SUBMIT":
            raise ValueError("WOULD_SUBMIT cannot create position ownership")
        origin = str(candidate.get("origin_strategy_id") or "").strip()
        if origin not in SELECTABLE_ALPHAS:
            raise ValueError("origin_strategy_id required")
        ti = str(candidate.get("origin_trade_intent_id") or "").strip()
        if not ti:
            raise ValueError("origin_trade_intent_id required")
        # Idempotent: one open position per trade_intent; qty follows real fill, not request.
        fill_qty = float(candidate.get("quantity") or 0.0)
        snap = self._entry_risk_snapshot_for_fill(candidate, fill_qty)
        for existing in self.positions.list_open():
            if existing.origin_trade_intent_id == ti:
                if fill_qty > 0:
                    existing.quantity = fill_qty
                    existing.entry_risk_snapshot = snap
                    if candidate.get("stop_policy_snapshot"):
                        existing.stop_policy_snapshot = dict(candidate.get("stop_policy_snapshot") or {})
                    payload = existing.to_dict()
                    self.store.upsert_open_position(payload, _now_iso())
                    return payload
                return existing.to_dict()
        pos = self.positions.open_from_fill(
            symbol=str(candidate.get("symbol") or ""),
            side=str(candidate.get("side") or ""),
            quantity=fill_qty,
            origin_strategy_id=origin,
            origin_trade_intent_id=ti,
            entry_risk_snapshot=snap,
            stop_policy_snapshot=dict(candidate.get("stop_policy_snapshot") or {}),
            exit_policy_snapshot=dict(candidate.get("exit_policy_snapshot") or {}),
            metadata=dict(candidate.get("metadata") or {}),
        )
        payload = pos.to_dict()
        self.store.upsert_open_position(payload, _now_iso())
        self.bus.emit("position.opened", payload)
        if str(origin).upper() == "S9":
            orch = getattr(self, "orchestrator", None)
            if orch is not None and hasattr(orch, "s9_runtime"):
                import time as _time
                orch.s9_runtime.setdefault("opening_times", []).append(_time.time())
                orch.s9_runtime["day_count"] = int(orch.s9_runtime.get("day_count") or 0) + 1
                orch.s9_runtime["consecutive_stops"] = 0
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
                shadow_report = bool(report.get("shadow")) or status_u == "WOULD_SUBMIT"
                fill_statuses = {"FILLED", "PARTIAL", "PARTIALLY_FILLED"}
                if status_u in fill_statuses and not shadow_report:
                    filled_qty = float(
                        report.get("filled_base_qty")
                        if report.get("filled_base_qty") is not None
                        else report.get("filled_quantity")
                        or 0.0
                    )
                    if bool(item.get("reduce_only")):
                        if filled_qty > 0:
                            self.reduce_owned_position(
                                position_id=item.get("position_id"),
                                symbol=item.get("symbol") or (intent.symbol if intent else None),
                                origin_strategy_id=item.get("origin_strategy_id")
                                or (intent.strategy_id if intent else None),
                                close_qty=filled_qty,
                            )
                    elif intent and filled_qty > 0:
                        self.register_owned_position(
                            {
                                "symbol": item.get("symbol") or (intent.symbol if intent else ""),
                                "side": item.get("position_side")
                                or ("long" if str(intent.direction).lower() == "long" else "short"),
                                "quantity": filled_qty,
                                "origin_strategy_id": item.get("origin_strategy_id")
                                or intent.strategy_id,
                                "origin_trade_intent_id": intent.intent_id,
                                "entry_price": item.get("entry_price") or report.get("avg_fill_price"),
                                "stop_price": item.get("stop_price"),
                                "base_quantity": item.get("base_quantity"),
                                "risk_pct": item.get("risk_pct"),
                                "entry_risk_snapshot": item.get("entry_risk_snapshot")
                                or item.get("risk_snapshot")
                                or {},
                                "exit_policy_snapshot": item.get("exit_policy_snapshot") or {},
                                "stop_policy_snapshot": item.get("stop_policy_snapshot") or {},
                                "metadata": {
                                    "order_intent_id": oid,
                                    "execution_status": status_u,
                                    "source": "node_gateway_filled",
                                },
                            }
                        )
                    if status_u == "FILLED" and intent and not bool(item.get("reduce_only")):
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
        gateway_ok = getattr(self, "alpha_execution", None) in (ALPHA_SHADOW, ALPHA_EXECUTE) or self.execution_mode in (
            "node_gateway",
            "node_gateway_shadow",
        )
        if not gateway_ok or not intents:
            return
        if int(self.orchestrator.s6.level) >= 2:
            # L2+ block new opening intents
            for oi in intents:
                if not bool(oi.get("reduce_only")):
                    oi["status"] = "SAFETY_BLOCKED"
                    self.bus.emit("order_intent.updated", oi)
            return
        from src.runtime.demo_execute_v1 import opening_signal_already_used

        async with httpx.AsyncClient(timeout=30.0) as client:
            for oi in intents:
                skey = str(oi.get("signal_key") or "")
                if skey and opening_signal_already_used(self.order_intents, skey):
                    oi["status"] = "SIGNAL_KEY_DUPLICATE"
                    self.bus.emit("order_intent.updated", oi)
                    continue
                if getattr(self, "alpha_execution", None) == ALPHA_SHADOW or self.execution_mode == "node_gateway_shadow":
                    oi["shadow"] = True
                    oi["alpha_execution"] = ALPHA_SHADOW
                else:
                    oi["alpha_execution"] = getattr(self, "alpha_execution", ALPHA_EXECUTE)
                oi["live_allowed"] = strategy_live_allowed(
                    oi.get("origin_strategy_id") or oi.get("strategy_id")
                )
                oi["user_id"] = self.user_id or self.orchestrator.context.get("user_id")
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
                        report = body.get("report")
                        if report:
                            if body.get("shadow") or str(report.get("status") or "") == "WOULD_SUBMIT":
                                report = {**report, "shadow": True, "status": "WOULD_SUBMIT"}
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
                # Loop heartbeat — independent of whether S1 finishes an evaluation
                self.last_tick_at = _now_iso()
                self.orchestrator.active_strategy_id = self.active_strategy
                self.orchestrator.alpha_opening_enabled = self.alpha_opening_enabled
                self.orchestrator.owned_open_positions = [p.to_dict() for p in self.positions.list_open()]
                ctx = await self.orchestrator.run_cycle(microstructure=dict(self._default_micro))
                for cand in list(ctx.get("opened_position_candidates") or []):
                    src = str((cand.get("metadata") or {}).get("source") or "")
                    if src == LEGACY_PAPER_SOURCE:
                        continue
                    try:
                        self.register_owned_position(cand)
                    except Exception as err:  # noqa: BLE001
                        self.last_error = f"position_register: {err}"
                pending = list(ctx.get("pending_order_intents") or [])
                await self._dispatch_order_intents(pending)
                self.last_error = None
                if self.state not in ("PAUSED", "LOCKED", "RECOVERY"):
                    self.state = "RUNNING"
                symbol = getattr(self.orchestrator, "market_meta", {}).get("instrument") or self.symbol
                candle = str(
                    (getattr(self.orchestrator, "market_meta", {}) or {}).get("latest_closed_candle_at") or ""
                )
                for sid, diag in (getattr(self.orchestrator, "diagnostics", {}) or {}).items():
                    ev = diag.consume_log_event()
                    if not ev:
                        continue
                    ev["symbol"] = ev.get("symbol") or symbol
                    ev["source_closed_candle_timestamp"] = (
                        ev.get("source_closed_candle_timestamp") or candle
                    )
                    self.bus.emit("strategy.decision", ev)
                runtime = getattr(self.orchestrator, "s9_runtime", None) or {}
                dir_ev = runtime.pop("pending_direction_event", None) if isinstance(runtime, dict) else None
                if dir_ev:
                    dir_ev["symbol"] = dir_ev.get("symbol") or symbol
                    dir_ev["strategy_id"] = "S9"
                    self.bus.emit("strategy.decision", dir_ev)
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
        hub = getattr(self.orchestrator, "s9_hub", None)
        if hub is not None and getattr(hub, "client", None) is not None:
            try:
                await hub.client.stop()
            except Exception:
                pass
        self._s9_ws_started = False
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
        exec_norm = resolve_runtime_execution()
        store_env = os.getenv("V41_ENGINE_DB_PATH")
        _runtime = EngineRuntime(
            mode=mode,
            symbol=symbol,
            tick_interval_sec=tick,
            execution_mode=exec_norm["alpha_execution"],
            store_path=Path(store_env) if store_env else None,
        )
    return _runtime
