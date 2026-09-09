"""FastAPI internal control plane for V4.1 engine."""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any, Dict, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from src.runtime.engine_runtime import get_runtime
from src.telemetry.event_bus import get_event_bus


def _expected_token() -> str:
    return os.getenv("V41_ENGINE_INTERNAL_TOKEN", "dev-internal-token")


async def require_engine_token(x_engine_token: Optional[str] = Header(default=None)) -> None:
    expected = _expected_token()
    if not x_engine_token or x_engine_token != expected:
        raise HTTPException(status_code=401, detail={"error": {"code": "UNAUTHORIZED", "message": "invalid token"}})


class ResumeBody(BaseModel):
    operator_id: str = Field(min_length=1)
    reason: str = Field(min_length=3)
    incident_id: Optional[str] = None


class StrategyBody(BaseModel):
    strategy_id: str


class SwitchBody(BaseModel):
    strategy_id: str
    reason: str = "manual_user_switch"
    operator_id: str = "system"


class KillBody(BaseModel):
    reason: str = "MANUAL_EMERGENCY_STOP"
    operator_id: str = "system"


class HftSimStartBody(BaseModel):
    symbol: str = "BTC-USDT-SWAP"
    max_position_notional_usdt: float = 50
    leverage_sequence: Optional[list] = None
    action_interval_seconds: float = 0
    cycles: int = 200
    seed: int = 20260909
    inject_failures: bool = False
    execution_mode: str = "simulator"  # simulator | exchange
    exchange_environment: Optional[str] = None  # demo | live (from Node, not browser trust)
    user_id: Optional[str] = None  # logged-in user; required for exchange QA OKX keys


def _hft_sim_enabled() -> bool:
    return str(os.getenv("V41_HFT_SIM_ENABLED", "false")).strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _hft_disabled_error() -> Dict[str, Any]:
    return {
        "code": "HFT_SIM_DISABLED",
        "message": "QA-HFT-SIM is disabled",
        "details": {
            "env_key": "V41_HFT_SIM_ENABLED",
            "resolved": os.getenv("V41_HFT_SIM_ENABLED"),
            "engine_available": True,
        },
    }


def create_app() -> FastAPI:
    app = FastAPI(title="AI Trading System V4.1 Internal API", version="4.1")
    runtime = get_runtime()
    bus = get_event_bus()

    @app.on_event("startup")
    async def _startup() -> None:
        enabled = _hft_sim_enabled()
        print(
            f"HFT_SIM_CONFIG enabled={str(enabled).lower()} "
            f"execution_target=simulator max_position_notional_usdt=50 "
            f"V41_HFT_SIM_ENABLED={os.getenv('V41_HFT_SIM_ENABLED')!r}",
            flush=True,
        )
        if os.getenv("V41_ENGINE_AUTOSTART", "1") not in ("0", "false", "False"):
            await runtime.start()

    @app.on_event("shutdown")
    async def _shutdown() -> None:
        await runtime.shutdown()

    @app.get("/internal/v1/health")
    async def health(_: None = Depends(require_engine_token)) -> Dict[str, Any]:
        return runtime.health()

    @app.get("/internal/v1/snapshot")
    async def snapshot(_: None = Depends(require_engine_token)) -> Dict[str, Any]:
        return runtime.snapshot()

    @app.get("/internal/v1/regime")
    async def regime(_: None = Depends(require_engine_token)) -> Dict[str, Any]:
        return runtime.snapshot().get("s3") or {}

    @app.get("/internal/v1/risk-budget")
    async def risk_budget(_: None = Depends(require_engine_token)) -> Dict[str, Any]:
        return runtime.snapshot().get("s5") or {}

    @app.get("/internal/v1/strategy-health")
    async def strategy_health(_: None = Depends(require_engine_token)) -> Any:
        return runtime.snapshot().get("s7") or []

    @app.get("/internal/v1/trade-intents")
    async def trade_intents(_: None = Depends(require_engine_token)) -> Any:
        return runtime.snapshot().get("trade_intents") or []

    @app.get("/internal/v1/order-intents")
    async def order_intents(_: None = Depends(require_engine_token)) -> Any:
        return runtime.snapshot().get("order_intents") or []

    @app.get("/internal/v1/incidents")
    async def incidents(_: None = Depends(require_engine_token)) -> Any:
        return runtime.snapshot().get("incidents") or []

    @app.get("/internal/v1/execution-metrics")
    async def execution_metrics(_: None = Depends(require_engine_token)) -> Any:
        return runtime.snapshot().get("execution") or {}

    @app.post("/internal/v1/control/start")
    async def control_start(_: None = Depends(require_engine_token)) -> Dict[str, Any]:
        return await runtime.start()

    @app.post("/internal/v1/control/pause")
    async def control_pause(_: None = Depends(require_engine_token)) -> Dict[str, Any]:
        return await runtime.pause()

    @app.post("/internal/v1/control/kill")
    async def control_kill(body: KillBody, _: None = Depends(require_engine_token)) -> Dict[str, Any]:
        return await runtime.kill(reason=body.reason, operator_id=body.operator_id)

    @app.post("/internal/v1/control/resume")
    async def control_resume(body: ResumeBody, _: None = Depends(require_engine_token)) -> Dict[str, Any]:
        return await runtime.resume(
            operator_id=body.operator_id,
            reason=body.reason,
            incident_id=body.incident_id,
        )

    @app.post("/internal/v1/control/active-strategy")
    async def control_strategy(body: StrategyBody, _: None = Depends(require_engine_token)) -> Dict[str, Any]:
        result = runtime.switch_strategy(
            strategy_id=body.strategy_id,
            reason="manual_user_switch",
            operator_id="system",
        )
        if not result.get("ok"):
            err = result.get("error") or {}
            raise HTTPException(status_code=409, detail=err)
        return result

    @app.get("/internal/v1/strategy/active")
    async def strategy_active(_: None = Depends(require_engine_token)) -> Dict[str, Any]:
        return runtime.get_active_strategy()

    @app.get("/internal/v1/strategy/list")
    async def strategy_list(_: None = Depends(require_engine_token)) -> Dict[str, Any]:
        return runtime.list_strategies()

    @app.get("/internal/v1/execution/selections")
    async def execution_selections(_: None = Depends(require_engine_token)) -> Dict[str, Any]:
        return runtime.list_execution_selections()

    @app.post("/internal/v1/execution/select")
    async def execution_select(request: Request, _: None = Depends(require_engine_token)) -> Dict[str, Any]:
        body = await request.json()
        sel_id = str((body or {}).get("id") or (body or {}).get("selection_id") or "").strip()
        if sel_id == "QA-HFT-SIM":
            result = runtime.enter_qa_hft_sim()
            if not result.get("ok"):
                raise HTTPException(status_code=403, detail=result.get("error") or _hft_disabled_error())
            return result
        if sel_id in ("S1", "S2"):
            # Leaving QA if needed, then switch alpha
            if runtime.console_mode == "QA_HFT_SIM":
                runtime.exit_qa_hft_sim(resume_alpha_openings=False)
            result = runtime.switch_strategy(
                strategy_id=sel_id,
                reason=str((body or {}).get("reason") or "manual_user_switch"),
                operator_id=str((body or {}).get("operator_id") or "system"),
            )
            if not result.get("ok"):
                raise HTTPException(status_code=409, detail=result.get("error") or {})
            runtime.alpha_opening_enabled = True
            runtime.orchestrator.context["alpha_opening_enabled"] = True
            runtime.console_mode = "ALPHA"
            result["console_mode"] = "ALPHA"
            result["alpha_opening_enabled"] = True
            return result
        if sel_id == "S8":
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "WARMING_UP_OR_NOT_IMPLEMENTED",
                    "message": "S8 whale alpha is not available yet",
                },
            )
        raise HTTPException(status_code=400, detail={"code": "INVALID_SELECTION", "message": f"unknown id {sel_id}"})

    @app.post("/internal/v1/strategy/switch")
    async def strategy_switch(body: SwitchBody, _: None = Depends(require_engine_token)) -> Dict[str, Any]:
        result = runtime.switch_strategy(
            strategy_id=body.strategy_id,
            reason=body.reason or "manual_user_switch",
            operator_id=body.operator_id or "system",
        )
        if not result.get("ok"):
            err = result.get("error") or {}
            raise HTTPException(status_code=409, detail=err)
        return result

    @app.get("/internal/v1/positions")
    async def positions(_: None = Depends(require_engine_token)) -> Any:
        return [p.to_dict() for p in runtime.positions.list_open()]

    @app.get("/internal/v1/positions/{position_id}/exit-policy")
    async def position_exit_policy(position_id: str, _: None = Depends(require_engine_token)) -> Dict[str, Any]:
        return runtime.exit_policy_for_position(position_id)

    @app.post("/internal/v1/execution-reports")
    async def execution_reports(request: Request, _: None = Depends(require_engine_token)) -> Dict[str, Any]:
        payload = await request.json()
        return runtime.apply_execution_report(payload if isinstance(payload, dict) else {})

    # ----- QA-HFT-SIM (not Alpha) -----
    @app.post("/internal/v1/test/hft-sim/start")
    async def hft_sim_start(body: HftSimStartBody, _: None = Depends(require_engine_token)) -> Dict[str, Any]:
        if not _hft_sim_enabled():
            raise HTTPException(status_code=403, detail=_hft_disabled_error())
        mode = str(body.execution_mode or "simulator").lower()
        if mode == "exchange":
            if str(os.getenv("V41_QA_EXCHANGE_ENABLED", "false")).strip().lower() not in {
                "1",
                "true",
                "yes",
                "on",
            }:
                raise HTTPException(
                    status_code=403,
                    detail={
                        "code": "QA_EXCHANGE_DISABLED",
                        "message": "V41_QA_EXCHANGE_ENABLED is false",
                        "details": {"env_key": "V41_QA_EXCHANGE_ENABLED"},
                    },
                )
            if not str(body.user_id or "").strip():
                raise HTTPException(
                    status_code=400,
                    detail={
                        "code": "USER_ID_REQUIRED",
                        "message": "exchange QA requires user_id (per-user OKX keys)",
                    },
                )
        from src.qa.hft_sim_runner import get_hft_runner

        entered = runtime.enter_qa_hft_sim()
        if not entered.get("ok"):
            raise HTTPException(status_code=403, detail=entered.get("error") or _hft_disabled_error())

        runner = get_hft_runner()
        # Run QA in a worker thread so pause/kill/status stay responsive on the event loop
        result = await asyncio.to_thread(
            runner.start,
            cycles=body.cycles,
            seed=body.seed,
            inject_failures=body.inject_failures if mode == "simulator" else False,
            symbol=body.symbol,
            max_position_notional_usdt=min(float(body.max_position_notional_usdt or 50), 50),
            leverage_sequence=body.leverage_sequence,
            action_interval_seconds=body.action_interval_seconds,
            execution_mode=mode,
            exchange_environment=body.exchange_environment,
            user_id=body.user_id,
        )
        if not result.get("ok"):
            raise HTTPException(status_code=409, detail=result.get("error") or {"code": "QA_START_FAILED"})
        return result

    @app.post("/internal/v1/test/hft-sim/stop")
    async def hft_sim_stop(_: None = Depends(require_engine_token)) -> Dict[str, Any]:
        # Stop always allowed to flatten; enabled check only for start
        result = runtime.exit_qa_hft_sim(resume_alpha_openings=False)
        return {"ok": True, **result}

    @app.get("/internal/v1/test/hft-sim/status")
    async def hft_sim_status(_: None = Depends(require_engine_token)) -> Dict[str, Any]:
        from src.qa.hft_sim_runner import get_hft_runner

        enabled = _hft_sim_enabled()
        st = get_hft_runner().status()
        mode = str(st.get("execution_mode") or "simulator")
        qa_ex = str(os.getenv("V41_QA_EXCHANGE_ENABLED", "false")).strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }
        st.update(
            {
                "enabled": enabled,
                "execution_target": "node_gateway" if mode == "exchange" else "simulator",
                "max_position_notional_usdt": 50,
                "real_exchange_allowed": qa_ex,
                "qa_exchange_enabled": qa_ex,
                "engine_available": True,
                "console_mode": runtime.console_mode,
                "alpha_opening_enabled": runtime.alpha_opening_enabled,
                "active_strategy_id": runtime.active_strategy,
                "env_resolved": os.getenv("V41_HFT_SIM_ENABLED"),
            }
        )
        return st

    @app.get("/internal/v1/test/hft-sim/report")
    async def hft_sim_report(_: None = Depends(require_engine_token)) -> Dict[str, Any]:
        from src.qa.hft_sim_runner import get_hft_runner

        report = get_hft_runner().report()
        report["enabled"] = _hft_sim_enabled()
        mode = str(report.get("execution_mode") or "simulator")
        qa_ex = str(os.getenv("V41_QA_EXCHANGE_ENABLED", "false")).strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }
        report["real_exchange_allowed"] = qa_ex
        report["qa_exchange_enabled"] = qa_ex
        report["execution_target"] = "node_gateway" if mode == "exchange" else "simulator"
        return report

    @app.post("/internal/v1/test/hft-sim/resume-alpha")
    async def hft_sim_resume_alpha(_: None = Depends(require_engine_token)) -> Dict[str, Any]:
        result = runtime.resume_alpha_openings()
        if not result.get("ok"):
            raise HTTPException(status_code=409, detail=result.get("error") or {})
        return result

    @app.post("/internal/v1/test/simulator/submit")
    async def simulator_submit(request: Request, _: None = Depends(require_engine_token)) -> Dict[str, Any]:
        """Node Gateway forwards test_mode simulator orders here — never OKX."""
        if not _hft_sim_enabled():
            raise HTTPException(status_code=403, detail=_hft_disabled_error())
        from src.qa.hft_sim_runner import get_hft_runner

        payload = await request.json()
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail={"code": "INVALID_BODY"})
        if not payload.get("test_mode"):
            raise HTTPException(status_code=400, detail={"code": "TEST_MODE_REQUIRED"})
        if str(payload.get("execution_target") or "").lower() != "simulator":
            raise HTTPException(
                status_code=403,
                detail={
                    "code": "TEST_ORDER_REAL_EXCHANGE_BLOCKED",
                    "message": "QA orders must use execution_target=simulator",
                },
            )
        fault = payload.get("fault")
        return get_hft_runner().sim.submit_order(payload, fault=fault if isinstance(fault, str) else None)

    @app.get("/internal/v1/test/simulator/snapshot")
    async def simulator_snapshot(_: None = Depends(require_engine_token)) -> Dict[str, Any]:
        from src.qa.hft_sim_runner import get_hft_runner

        return {
            "enabled": _hft_sim_enabled(),
            "execution_target": "simulator",
            "real_exchange_allowed": False,
            **get_hft_runner().sim.snapshot(),
        }

    # ----- E1 Whale data ingest (no S8 Alpha) -----
    @app.post("/internal/v1/data/whale-snapshot")
    async def whale_snapshot(request: Request, _: None = Depends(require_engine_token)) -> Dict[str, Any]:
        from src.qa.whale_feed import get_whale_feed

        payload = await request.json()
        return get_whale_feed().apply_snapshot(payload if isinstance(payload, dict) else {})

    @app.post("/internal/v1/data/whale-events")
    async def whale_events(request: Request, _: None = Depends(require_engine_token)) -> Dict[str, Any]:
        from src.qa.whale_feed import get_whale_feed

        payload = await request.json()
        return get_whale_feed().apply_events(payload if isinstance(payload, dict) else {})

    @app.get("/internal/v1/data/whale-telemetry")
    async def whale_telemetry(_: None = Depends(require_engine_token)) -> Dict[str, Any]:
        from src.qa.whale_feed import get_whale_feed

        return get_whale_feed().telemetry()

    @app.websocket("/internal/v1/events")
    async def events_ws(websocket: WebSocket) -> None:
        token = websocket.query_params.get("token") or websocket.headers.get("x-engine-token")
        if token != _expected_token():
            await websocket.accept()
            await websocket.close(code=4401)
            return
        await websocket.accept()
        q = bus.subscribe()
        try:
            await websocket.send_text(
                json.dumps(
                    {
                        "event_id": "hello",
                        "sequence": bus.sequence,
                        "type": "engine.status",
                        "timestamp": runtime.last_tick_at,
                        "payload": runtime.health(),
                    },
                    ensure_ascii=False,
                    default=str,
                )
            )
            while True:
                try:
                    event = await asyncio.wait_for(q.get(), timeout=20.0)
                    await websocket.send_text(json.dumps(event, ensure_ascii=False, default=str))
                except asyncio.TimeoutError:
                    await websocket.send_text(
                        json.dumps(
                            {
                                "event_id": "heartbeat",
                                "sequence": bus.sequence,
                                "type": "heartbeat",
                                "timestamp": None,
                                "payload": {},
                            }
                        )
                    )
        except WebSocketDisconnect:
            pass
        finally:
            bus.unsubscribe(q)

    return app


app = create_app()
