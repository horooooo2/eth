"""Async decision-order orchestrator for V4.1 engine contract."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

from src.adapters.data_reconciler import DataReconciler
from src.adapters.okx_adapter import OkxAdapter
from src.core.data_pool import FeatureDataPool
from src.core.edge_estimator import EdgeEstimator
from src.core.rule_evaluator import RuleEvaluator
from src.core.signal_lifecycle import SignalLifecycleManager, TradeIntent
from src.strategies.s1_trend import S1TrendStrategy
from src.strategies.s2_reversal import S2ReversalStrategy
from src.strategies.s3_regime import S3RegimeStrategy
from src.strategies.s4_execution import S4ExecutionStrategy
from src.strategies.s5_risk_budget import S5RiskBudgetAllocator
from src.strategies.s6_anomaly import S6AnomalyDetector
from src.strategies.s7_health import S7HealthMonitor
from src.utils.logger import log_decision, setup_logger


class Orchestrator:
    def __init__(
        self,
        config: Dict[str, Any],
        *,
        adapter: Optional[OkxAdapter] = None,
        mode: str = "paper",
        symbol: str = "BTC/USDT:USDT",
    ) -> None:
        self.config = config
        self.mode = mode
        self.symbol = symbol
        self.logger = setup_logger()
        self.data_pool = FeatureDataPool(config)
        self.evaluator = RuleEvaluator(config, self.data_pool)
        self.lifecycle = SignalLifecycleManager(config)
        self.edge = EdgeEstimator(config)
        # Provide a mild validated prior so paper path can compute edge
        if not self.edge.validated_oos_prior:
            self.edge.set_validated_prior(
                {
                    "prob_win": 0.55,
                    "avg_win_R": 1.2,
                    "avg_loss_R": 1.0,
                    "prior_alpha": 10.0,
                    "prior_beta": 10.0,
                    "sample_count": 100,
                }
            )
        # paper = no live Alpha orders; market data is independent (real OKX unless tests/mock env)
        self.adapter = adapter or OkxAdapter(config, mode=mode, mock=False)
        self.reconciler = DataReconciler(self.adapter, config)

        self.s1 = S1TrendStrategy(config, self.evaluator, self.lifecycle)
        self.s2 = S2ReversalStrategy(config, self.evaluator, self.lifecycle)
        self.s3 = S3RegimeStrategy(config, self.evaluator)
        self.s4 = S4ExecutionStrategy(config, self.evaluator, self.lifecycle)
        self.s5 = S5RiskBudgetAllocator(config)
        self.s6 = S6AnomalyDetector(config, self.evaluator)
        self.s7 = S7HealthMonitor(config)

        self.context: Dict[str, Any] = {}
        self.last_orders: List[Dict[str, Any]] = []
        # Invariant: exactly one active alpha strategy (S1 or S2)
        self.active_strategy_id: str = "S1"
        self.alpha_opening_enabled: bool = True
        self.s1_timeframe: str = str((config.get("S1_trend") or {}).get("timeframe") or "1h")
        self.market_warmup_bars: int = 100
        self.market_fetch_limit: int = 200
        self.market_state: str = "WARMING_UP"
        self.market_meta: Dict[str, Any] = {}
        from src.runtime.strategy_diagnostics import StrategyDiagnostics

        self.diagnostics: Dict[str, StrategyDiagnostics] = {
            "S1": StrategyDiagnostics("S1"),
            "S2": StrategyDiagnostics("S2"),
        }

    @classmethod
    def from_config_path(
        cls,
        path: str | Path,
        **kwargs: Any,
    ) -> "Orchestrator":
        """Explicit file path — legacy compatibility / tests. Production uses from_runtime()."""
        from src.runtime.config_loader import load_legacy_config
        from src.runtime.config_validator import validate_or_raise

        cfg = load_legacy_config(path)
        validate_or_raise(cfg)
        return cls(cfg, **kwargs)

    @classmethod
    def from_runtime(cls, **kwargs: Any) -> "Orchestrator":
        from src.runtime.config_loader import load_effective_config
        from src.runtime.config_validator import validate_or_raise

        cfg = load_effective_config()
        validate_or_raise(cfg)
        return cls(cfg, **kwargs)

    def decision_order(self) -> List[str]:
        return list(self.config.get("engine_contract", {}).get("decision_order", []))

    async def run_cycle(self, bars=None, microstructure=None) -> Dict[str, Any]:
        active = self.active_strategy_id if self.active_strategy_id in ("S1", "S2") else "S1"
        self.active_strategy_id = active
        alpha_open = bool(getattr(self, "alpha_opening_enabled", True))
        self.context = {
            "mode": self.mode,
            "symbol": self.symbol,
            "live_trading_allowed": bool(self.config.get("meta", {}).get("live_trading_allowed", False)),
            "global_drawdown_multiplier": 1.0,
            "daily_loss_multiplier": 1.0,
            "execution_mode": getattr(self, "execution_mode", "node_gateway_shadow"),
            "alpha_execution": getattr(self, "alpha_execution", "SHADOW"),
            "user_id": getattr(self, "user_id", None),
            "account_scope": getattr(self, "account_scope", "default"),
            "pending_order_intents": [],
            "active_strategy_id": active,
            "strategy_runtime": {"active_strategy_id": active},
            "alpha_opening_enabled": alpha_open,
            "_diagnostics": self.diagnostics,
            "owned_open_positions": list(getattr(self, "owned_open_positions", None) or []),
            "reserved_opening_risk_pct_equity": 0.0,
        }
        if bars is None:
            try:
                bars = self.adapter.get_klines(
                    self.symbol,
                    timeframe=self.s1_timeframe or "1h",
                    limit=self.market_fetch_limit,
                )
            except Exception as exc:  # noqa: BLE001
                from src.adapters.okx_market_data import to_okx_inst_id, use_real_okx_market

                self.market_state = "STALE"
                self.market_meta = {
                    "source": "OKX" if use_real_okx_market() else "MOCK",
                    "instrument": to_okx_inst_id(self.symbol),
                    "timeframe": self.s1_timeframe or "1h",
                    "state": "STALE",
                    "error": str(exc),
                    "bars_loaded": 0,
                }
                self.context["market_data"] = dict(self.market_meta)
                raise
        self._apply_market_bars(bars, microstructure=microstructure)
        account = self.adapter.get_account_info()
        self.context["equity"] = account.get("equity")
        from src.runtime.risk_usage import compute_risk_usage

        self.context["risk_usage"] = compute_risk_usage(
            self.context.get("owned_open_positions") or [],
            current_equity=self.context.get("equity"),
        )

        for step in self.decision_order():
            method = getattr(self, step, None)
            if method is None:
                self.context[f"{step}_skipped"] = True
                continue
            result = method()
            self.context[f"step::{step}"] = result

        required = self.config.get("logging", {}).get("required_fields", [])
        log_decision(
            self.logger,
            {
                "symbol": self.symbol,
                "mode": self.mode,
                "S6.level": self.context.get("S6.level"),
                "S3.regime": self.context.get("S3.regime"),
                "orders": self.last_orders,
                "decision_order": self.decision_order(),
            },
            required=required,
        )
        return dict(self.context)

    def _apply_market_bars(self, bars, microstructure=None) -> None:
        from src.adapters.okx_market_data import (
            split_closed_bars,
            to_okx_inst_id,
            use_real_okx_market,
        )

        tf = self.s1_timeframe or "1h"
        closed, forming, candle_closed = split_closed_bars(bars, timeframe=tf)
        compute = closed if (closed is not None and not getattr(closed, "empty", True)) else bars
        self.data_pool.update_from_bars(compute, microstructure=microstructure)
        self.data_pool.set_closed_bars(closed if closed is not None else None)
        bars_loaded = int(len(bars)) if bars is not None else 0
        closed_n = int(len(compute)) if compute is not None else 0
        latest_closed = None
        latest_any = None
        if compute is not None and len(compute) and isinstance(compute.index, type(bars.index)):
            latest_closed = str(compute.index[-1])
        if bars is not None and len(bars):
            latest_any = str(bars.index[-1])
        age = None
        try:
            import pandas as pd

            ref = compute.index[-1] if compute is not None and len(compute) else None
            if ref is not None:
                ts = pd.Timestamp(ref)
                if ts.tzinfo is None:
                    ts = ts.tz_localize("UTC")
                age = max(0, int((pd.Timestamp.now(tz="UTC") - ts).total_seconds()))
        except Exception:
            age = None
        ready = closed_n >= self.market_warmup_bars
        self.market_state = "READY" if ready else "WARMING_UP"
        if age is not None and age > 4 * 3600:
            self.market_state = "STALE"
        self.market_meta = {
            "source": "OKX" if use_real_okx_market() else "MOCK",
            "instrument": to_okx_inst_id(self.symbol),
            "timeframe": tf,
            "latest_candle_at": latest_any,
            "latest_closed_candle_at": latest_closed,
            "candle_age_seconds": age,
            "bars_loaded": bars_loaded,
            "closed_bars": closed_n,
            "candle_closed": candle_closed,
            "state": self.market_state,
            "forming": forming is not None,
        }
        self.context["market_data"] = dict(self.market_meta)
        self.data_pool.set_context({"market_data_state": self.market_state})

    # --- decision_order steps ---

    def S6_safety_gate(self) -> Dict[str, Any]:
        result = self.s6.evaluate_signals(self.data_pool, self.context)
        self.context["safety_gate_pass"] = int(result.get("level", 0)) < 3
        return result

    def data_quality_gate(self) -> Dict[str, Any]:
        ok = True
        close = self.data_pool.get("close")
        atr = self.data_pool.get("atr14")
        stale = float(self.data_pool.get("market_data_stale_ms") or 0)
        if close is None or atr is None:
            ok = False
        if stale >= 1000:
            ok = False
        if not bool(self.data_pool.get("sequence_valid", True)):
            ok = False
        if not bool(self.data_pool.get("exchange_connected", True)):
            ok = False
        self.context["data_quality_ok"] = ok
        self.data_pool.set_context({"data_quality_ok": ok})
        return {"data_quality_ok": ok}

    def position_order_reconciliation(self) -> Dict[str, Any]:
        result = self.reconciler.reconcile(self.symbol)
        self.context["positions_reconciled"] = bool(result["positions_reconciled"])
        self.context["orders_reconciled"] = bool(result["orders_reconciled"])
        self.data_pool.set_context(
            {
                "positions_reconciled": self.context["positions_reconciled"],
                "orders_reconciled": self.context["orders_reconciled"],
            }
        )
        if not result["positions_reconciled"]:
            self.s6.raise_hard_event("position_mismatch")
            self.s6.evaluate_signals(self.data_pool, self.context)
        return result

    def global_portfolio_risk_gate(self) -> Dict[str, Any]:
        gr = self.config.get("global_risk", {})
        cap = float(gr.get("max_initial_risk_all_open_positions_pct_equity", 0.02))
        from src.runtime.risk_usage import compute_risk_usage, empty_risk_usage

        usage = self.context.get("risk_usage") or empty_risk_usage()
        if not self.context.get("risk_usage"):
            usage = compute_risk_usage(
                self.context.get("owned_open_positions") or [],
                current_equity=self.context.get("equity"),
            )
            self.context["risk_usage"] = usage
        used = float(usage.get("portfolio_risk_used_pct_equity") or 0.0)
        self.context["global_portfolio_risk_cap"] = cap
        self.context["portfolio_risk_used_pct_equity"] = used
        self.context["portfolio_risk_ok"] = used <= cap
        self.data_pool.set_context(
            {
                "global_portfolio_risk_cap": cap,
                "portfolio_risk_after_order": used,
            }
        )
        return {"cap": cap, "used": used, "ok": self.context["portfolio_risk_ok"]}

    def S7_strategy_health_gate(self) -> Dict[str, Any]:
        return self.s7.evaluate(self.context)

    def S3_market_regime(self) -> Dict[str, Any]:
        return self.s3.evaluate(self.data_pool, self.context, force=True)

    def S5_risk_budget_allocation(self) -> Dict[str, Any]:
        health = {
            sid: float(self.context.get("S7", {}).get(sid, {}).get("health_score", 80.0))
            for sid in ("S1", "S2")
        }
        # S4 is execution-only — never an allocation health input for V4.2
        if str((self.config.get("S5_risk_budget") or {}).get("allocation_mode")) != "single_active_alpha":
            health["S4"] = float(self.context.get("S7", {}).get("S4", {}).get("health_score", 80.0))
        regime = str(self.context.get("S3.regime", "range"))
        return self.s5.allocate(regime=regime, health_scores=health, context=self.context)

    def S1_S2_signal_generation(self) -> Dict[str, Any]:
        # Update edge estimate into pool/context before entries
        active = self.active_strategy_id if self.active_strategy_id in ("S1", "S2") else "S1"
        self.active_strategy_id = active
        self.context["active_strategy_id"] = active
        regime = str(self.context.get("S3.regime", "range"))
        atr = float(self.data_pool.get("atr14") or 1.0)
        mid = float(self.data_pool.get("close") or 1.0)
        stop_dist = max(atr, 1e-12)
        # rough fee+slip in R terms from config minimum path
        round_trip_cost_R = 0.05
        est = self.edge.estimate(
            strategy_id=active,
            symbol=self.symbol,
            regime=regime,
            round_trip_cost_R=round_trip_cost_R,
        )
        self.context["edge_estimate"] = est.__dict__
        self.context["expected_edge_after_cost_R"] = est.expected_edge_after_cost_R
        self.context["edge_estimate_available"] = est.available
        self.context["edge_estimate_age_minutes"] = est.age_minutes
        self.context["paper_only_edge"] = est.paper_only
        self.data_pool.set_context(
            {
                "expected_edge_after_cost_R": est.expected_edge_after_cost_R,
                "edge_estimate_available": est.available,
                "edge_estimate_age_minutes": est.age_minutes,
            }
        )

        market_ready = str(self.market_state) == "READY"
        emit_intents = bool(self.context.get("alpha_opening_enabled", True)) and market_ready
        extra_block: List[str] = []
        if not market_ready:
            extra_block.append("MARKET_DATA_WARMING_UP" if self.market_state == "WARMING_UP" else "MARKET_DATA_STALE")
        if self.context.get("alpha_opening_enabled") is False:
            extra_block.append("ALPHA_OPENINGS_PAUSED")
        if int(self.context.get("S6.level") or 0) >= 2:
            extra_block.append("S6_ENTRIES_BLOCKED")

        # Always evaluate active Alpha for diagnostics; emit intents only when allowed
        intents: List[TradeIntent] = []
        if active == "S1":
            intents.extend(
                self.s1.generate(
                    symbol=self.symbol,
                    data_pool=self.data_pool,
                    context=self.context,
                    emit_intents=emit_intents,
                    extra_reason_codes=extra_block,
                )
            )
        elif active == "S2":
            intents.extend(self.s2.generate(symbol=self.symbol, data_pool=self.data_pool, context=self.context))
            if not emit_intents:
                intents = []
        # Defense in depth: drop any mismatched emits
        filtered: List[TradeIntent] = []
        for intent in intents:
            if intent.strategy_id != active:
                self.lifecycle.transition(intent, "ACTIVE_STRATEGY_MISMATCH")
                intent.metadata["terminal"] = True
                intent.metadata["terminal_reason"] = "ACTIVE_STRATEGY_MISMATCH"
                continue
            filtered.append(intent)
        self.context["trade_intents"] = filtered
        return {"count": len(filtered), "active_strategy_id": active, "intents": [i.to_dict() for i in filtered]}

    def S4_execution_timing(self) -> Dict[str, Any]:
        intents: List[TradeIntent] = list(self.context.get("trade_intents") or [])
        confirmed = self.s4.process_intents(intents, self.data_pool, self.context)
        return {"confirmed": [i.to_dict() for i in confirmed]}

    def cost_slippage_gate(self) -> Dict[str, Any]:
        min_r = float(self.config.get("cost_model", {}).get("minimum_required_R", 0.15))
        edge = float(self.context.get("expected_edge_after_cost_R", -1.0))
        ok = edge >= min_r and bool(self.context.get("edge_estimate_available", False))
        # Stress multipliers informational
        stresses = self.config.get("cost_model", {}).get("slippage_stress_multipliers", [1.0])
        self.context["cost_gate_pass"] = ok
        if not ok:
            for intent in self.context.get("confirmed_intents") or []:
                if intent.status == "CONFIRMED":
                    self.lifecycle.transition(intent, "COST_REJECTED")
                    diag = self.diagnostics.get(str(intent.strategy_id))
                    if diag:
                        diag.note_cost_reject()
        return {"ok": ok, "edge": edge, "min_r": min_r, "stress_multipliers": stresses}

    def final_order_creation(self) -> Dict[str, Any]:
        self.last_orders = []
        gate = self.config.get("router", {}).get("final_order_gate", {})
        confirmed: List[TradeIntent] = list(self.context.get("confirmed_intents") or [])
        created = []

        from src.runtime.alpha_execution import (
            ALPHA_EXECUTE,
            ALPHA_SHADOW,
            normalize_alpha_execution,
            strategy_live_allowed,
        )

        raw_mode = str(
            self.context.get("alpha_execution")
            or self.context.get("execution_mode")
            or getattr(self, "alpha_execution", None)
            or getattr(self, "execution_mode", None)
            or ""
        )
        if raw_mode.upper() in ("SHADOW", "EXECUTE"):
            norm = normalize_alpha_execution(raw_alpha=raw_mode, warn=False)
        else:
            norm = normalize_alpha_execution(raw_legacy=raw_mode or None, warn=False)
        alpha_execution = norm["alpha_execution"]

        for intent in confirmed:
            if intent.status != "CONFIRMED":
                continue
            active = str(self.context.get("active_strategy_id") or self.active_strategy_id)
            if intent.strategy_id != active:
                self.lifecycle.transition(intent, "ACTIVE_STRATEGY_MISMATCH")
                intent.metadata["terminal"] = True
                intent.metadata["terminal_reason"] = "ACTIVE_STRATEGY_MISMATCH"
                continue
            mid = float(self.data_pool.get("close") or intent.reference_price)
            validity = self.lifecycle.validate_intent(intent, mid, self.data_pool.get("atr14"))
            self.context["signal_lifecycle_valid"] = validity["valid"]
            self.context["source_strategy_revalidation_passed"] = validity["valid"]
            self.context["trade_intent"] = intent.to_dict()
            budgets = self.context.get("S5", {}).get("strategy_risk_budget_pct_equity", {})
            usage = self.context.get("risk_usage") or {}
            used = float(usage.get("portfolio_risk_used_pct_equity") or 0.0)
            self.context["portfolio_risk_after_order"] = used
            self.data_pool.set_context(
                {
                    "signal_lifecycle_valid": validity["valid"],
                    "source_strategy_revalidation_passed": validity["valid"],
                    "portfolio_risk_after_order": used,
                    "S6.level": self.context.get("S6.level", 0),
                    "data_quality_ok": self.context.get("data_quality_ok", False),
                    "positions_reconciled": self.context.get("positions_reconciled", False),
                    "orders_reconciled": self.context.get("orders_reconciled", False),
                    "expected_edge_after_cost_R": self.context.get("expected_edge_after_cost_R"),
                    "edge_estimate_available": self.context.get("edge_estimate_available"),
                    "edge_estimate_age_minutes": self.context.get("edge_estimate_age_minutes", 0),
                    "global_portfolio_risk_cap": self.context.get("global_portfolio_risk_cap"),
                }
            )

            gate_ok = bool(self.evaluator.evaluate(gate, self.context)) if gate else validity["valid"]
            if not gate_ok:
                self.lifecycle.transition(intent, "RISK_REJECTED")
                diag = self.diagnostics.get(str(intent.strategy_id))
                if diag:
                    diag.note_s4_reject()
                continue
            if int(self.context.get("S6.level", 0)) >= 2:
                self.lifecycle.transition(intent, "SAFETY_REJECTED")
                diag = self.diagnostics.get(str(intent.strategy_id))
                if diag:
                    diag.S6_rejected_count += 1
                continue

            from src.runtime.demo_execute_v1 import (
                clord_id_from_signal,
                compute_base_quantity,
                demo_execute_v1_allowed,
                normalize_swap_symbol,
                opening_signal_already_used,
                resolve_s1_stop_price,
                signal_key,
            )

            from src.runtime.risk_usage import (
                authorize_opening,
                enrich_entry_risk_snapshot,
                planned_trade_risk_pct,
                strategy_initial_risk_cap,
            )

            side = "buy" if str(intent.direction).lower() == "long" else "sell"
            equity = float(self.context.get("equity") or 100000.0)
            s1_cfg = self.config.get("S1_trend") or {}
            planned_risk_pct = planned_trade_risk_pct(self.config, intent.strategy_id)
            if planned_risk_pct <= 0:
                if str(intent.strategy_id).upper() == "S1":
                    planned_risk_pct = float(s1_cfg.get("risk_per_trade_pct_equity") or 0.004)
                else:
                    planned_risk_pct = float(budgets.get(intent.strategy_id, 0.003))
            risk_pct = planned_risk_pct
            atr = max(float(intent.reference_atr), 1e-12)
            entry_price = float(intent.reference_price or 0.0)
            closed_candles = None
            if hasattr(self.data_pool, "get_closed_bars"):
                closed_candles = self.data_pool.get_closed_bars()
            stop_info = resolve_s1_stop_price(
                direction=str(intent.direction),
                entry_price=entry_price,
                atr14=atr,
                s1_cfg=s1_cfg,
                closed_candles=closed_candles,
            )
            stop_price = (
                float(stop_info["stop_price"])
                if stop_info and stop_info.get("stop_price") is not None
                else None
            )
            sizing = None
            if stop_price:
                try:
                    sizing = compute_base_quantity(
                        equity=equity,
                        risk_pct=risk_pct,
                        entry_price=entry_price,
                        stop_price=stop_price,
                    )
                except ValueError:
                    sizing = None

            import uuid
            from datetime import datetime, timezone

            policy = self.lifecycle.get_policy(intent.strategy_id)
            symbol = normalize_swap_symbol(intent.symbol)
            md = self.context.get("market_data") or self.market_meta or {}
            candle_at = str(md.get("latest_closed_candle_at") or "")
            skey = signal_key(
                strategy_id=str(intent.strategy_id),
                symbol=symbol,
                direction=str(intent.direction),
                closed_candle_at=candle_at,
            )
            existing = list(self.context.get("pending_order_intents") or []) + list(self.last_orders or [])
            if candle_at and opening_signal_already_used(existing, skey):
                self.lifecycle.transition(intent, "RISK_REJECTED")
                continue
            if alpha_execution == ALPHA_EXECUTE and not demo_execute_v1_allowed(intent.strategy_id):
                self.lifecycle.transition(intent, "RISK_REJECTED")
                continue

            s5_ctx = self.context.get("S5") or {}
            portfolio_limit = float(s5_ctx.get("portfolio_risk_budget_pct_equity") or 0.0)
            if portfolio_limit <= 0:
                # Same S5 formula; do not treat a missing allocate() result as a 0% budget.
                portfolio_limit = float(self.s5._portfolio_budget(self.context))
            strategy_limit = float(
                (s5_ctx.get("strategy_risk_cap_pct_equity") or {}).get(intent.strategy_id)
                or strategy_initial_risk_cap(self.config, intent.strategy_id)
            )
            auth = authorize_opening(
                strategy_id=str(intent.strategy_id),
                planned_trade_risk_pct_equity=planned_risk_pct,
                usage=self.context.get("risk_usage") or {},
                portfolio_risk_limit_pct_equity=portfolio_limit,
                strategy_risk_limit_pct_equity=strategy_limit,
                reserved_opening_risk_pct_equity=float(
                    self.context.get("reserved_opening_risk_pct_equity") or 0.0
                ),
            )
            self.context["s5_opening_authorization"] = auth.to_dict()
            if auth.action == "BLOCK":
                self.lifecycle.transition(intent, "RISK_REJECTED")
                intent.metadata["s5_risk_reason"] = auth.reason_code
                intent.metadata["terminal"] = True
                intent.metadata["terminal_reason"] = auth.reason_code
                self.context["s5_opening_block"] = auth.reason_code
                diag = self.diagnostics.get(str(intent.strategy_id))
                if diag:
                    diag.note_s4_reject()
                continue
            if auth.action == "SHRINK" and auth.allowed_risk_pct_equity > 0:
                risk_pct = float(auth.allowed_risk_pct_equity)
                if stop_price:
                    try:
                        sizing = compute_base_quantity(
                            equity=equity,
                            risk_pct=risk_pct,
                            entry_price=entry_price,
                            stop_price=stop_price,
                        )
                    except ValueError:
                        sizing = None
            self.context["reserved_opening_risk_pct_equity"] = float(
                self.context.get("reserved_opening_risk_pct_equity") or 0.0
            ) + float(auth.allowed_risk_pct_equity)
            self.context["portfolio_risk_after_order"] = float(auth.projected_portfolio_risk_pct_equity)
            self.data_pool.set_context({"portfolio_risk_after_order": auth.projected_portfolio_risk_pct_equity})

            planned_qty = sizing["base_quantity"] if sizing else None
            entry_snap = enrich_entry_risk_snapshot(
                {
                    "strategy_id": intent.strategy_id,
                    "risk_pct": planned_risk_pct,
                    "equity": equity,
                    "atr": atr,
                    "base_quantity": planned_qty,
                    "entry_price": entry_price or None,
                    "stop_price": stop_price,
                    "risk_amount_quote": sizing["risk_amount_quote"] if sizing else None,
                },
                filled_base_quantity=float(planned_qty or 0.0),
                origin_strategy_id=str(intent.strategy_id),
                entry_price=entry_price or None,
                stop_price=stop_price,
                equity=equity,
                planned_base_quantity=planned_qty,
                planned_risk_pct=risk_pct,
            )

            order_intent = {
                "order_intent_id": str(uuid.uuid4()),
                "trade_intent_id": intent.intent_id,
                "origin_trade_intent_id": intent.intent_id,
                "strategy_id": intent.strategy_id,
                "active_strategy_id_at_creation": active,
                "origin_strategy_id": intent.strategy_id,
                "alpha_execution": alpha_execution,
                "shadow": alpha_execution == ALPHA_SHADOW,
                "demo_execute_v1_allowed": demo_execute_v1_allowed(intent.strategy_id),
                "live_allowed": strategy_live_allowed(intent.strategy_id),
                "user_id": getattr(self, "user_id", None) or self.context.get("user_id"),
                "account_scope": self.context.get("account_scope") or "default",
                "symbol": symbol,
                "side": side,
                "position_side": "long" if side == "buy" else "short",
                "order_type": "market",
                "quantity_unit": "BASE",
                "base_quantity": sizing["base_quantity"] if sizing else None,
                "entry_price": entry_price or None,
                "stop_price": stop_price,
                "risk_amount_quote": sizing["risk_amount_quote"] if sizing else None,
                "risk_pct": risk_pct,
                "planned_trade_risk_pct_equity": planned_risk_pct,
                "s5_opening_action": auth.action,
                "s5_opening_reason": auth.reason_code,
                "signal_key": skey if candle_at else None,
                "reduce_only": False,
                "client_order_id": clord_id_from_signal(skey) if candle_at else f"v41_{intent.intent_id[:8]}{uuid.uuid4().hex[:8]}"[:32],
                "risk_snapshot": {
                    "strategy_id": intent.strategy_id,
                    "risk_pct": risk_pct,
                    "risk_amount_quote": sizing["risk_amount_quote"] if sizing else None,
                    "entry_price": entry_price or None,
                    "stop_price": stop_price,
                    "base_quantity": sizing["base_quantity"] if sizing else None,
                    "S6.level": self.context.get("S6.level"),
                    "stop_source": (stop_info or {}).get("source"),
                    "structure_method": (stop_info or {}).get("structure_method"),
                    "structure_invalidation_price": (stop_info or {}).get("structure_invalidation_price"),
                    "structure_candle_timestamp": (stop_info or {}).get("structure_candle_timestamp"),
                    "atr14": atr,
                },
                "entry_risk_snapshot": entry_snap,
                "exit_policy_snapshot": {
                    "origin_strategy_id": intent.strategy_id,
                    "lifecycle_policy": policy,
                },
                "stop_policy_snapshot": {
                    "origin_strategy_id": intent.strategy_id,
                    "reference_atr": float(intent.reference_atr),
                    "stop_price": stop_price,
                    "formula": "min(1.5*atr14, structure_invalidation_distance)",
                    "structure_method": (stop_info or {}).get("structure_method"),
                    "complete": bool(stop_price),
                },
                "created_at": datetime.now(timezone.utc).isoformat(),
                "status": "CREATED",
                "demo_execute_v1_ready": bool(
                    sizing
                    and stop_price
                    and demo_execute_v1_allowed(intent.strategy_id)
                    and candle_at
                ),
                "demo_execute_v1_missing": [
                    name
                    for name, ok in (
                        (
                            (stop_info or {}).get("reason")
                            if (stop_info or {}).get("reason")
                            in {"S1_STRUCTURE_STOP_NOT_FOUND", "INVALID_STOP_PRICE"}
                            else "stop_price",
                            bool(stop_price),
                        ),
                        ("base_quantity", bool(sizing)),
                        ("signal_key", bool(candle_at)),
                        ("strategy_allowed", demo_execute_v1_allowed(intent.strategy_id)),
                    )
                    if not ok
                ],
                "atr14": atr,
                "structure_method": (stop_info or {}).get("structure_method"),
                "structure_lookback_bars": (stop_info or {}).get("structure_lookback_bars"),
                "structure_invalidation_price": (stop_info or {}).get("structure_invalidation_price"),
                "structure_invalidation_distance": (stop_info or {}).get("structure_invalidation_distance"),
                "structure_candle_timestamp": (stop_info or {}).get("structure_candle_timestamp"),
                "atr_stop_distance": (stop_info or {}).get("atr_stop_distance"),
                "minimum_stop_distance": (stop_info or {}).get("minimum_stop_distance"),
                "final_stop_distance": (stop_info or {}).get("final_stop_distance")
                or (stop_info or {}).get("stop_distance"),
            }
            # OKX SWAP instId form BTC-USDT-SWAP
            sym = str(intent.symbol)
            if "USDT" in sym and "-SWAP" not in sym:
                base = sym.split("/")[0] if "/" in sym else sym.replace("USDT", "").replace(":USDT", "")
                order_intent["symbol"] = f"{base}-USDT-SWAP"
            pending = self.context.setdefault("pending_order_intents", [])
            pending.append(order_intent)
            created.append({"intent_id": intent.intent_id, "order_intent": order_intent})
            self.last_orders.append(order_intent)
            diag = self.diagnostics.get(str(intent.strategy_id))
            if diag:
                diag.note_order_intent()
                if str(intent.strategy_id).upper() == "S1":
                    diag.note_structure(stop_info)

        self.context["orders_created"] = created
        return {"orders": created}
