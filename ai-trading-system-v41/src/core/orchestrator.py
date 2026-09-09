"""Async decision-order orchestrator for V4.1 engine contract."""

from __future__ import annotations

import json
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
        self.adapter = adapter or OkxAdapter(config, mode="mock" if mode == "paper" else mode, mock=(mode == "paper"))
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

    @classmethod
    def from_config_path(
        cls,
        path: str | Path,
        **kwargs: Any,
    ) -> "Orchestrator":
        with open(path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        from src.runtime.config_validator import validate_or_raise

        validate_or_raise(cfg)
        return cls(cfg, **kwargs)

    def decision_order(self) -> List[str]:
        return list(self.config.get("engine_contract", {}).get("decision_order", []))

    async def run_cycle(self, bars=None, microstructure=None) -> Dict[str, Any]:
        active = self.active_strategy_id if self.active_strategy_id in ("S1", "S2") else "S1"
        self.active_strategy_id = active
        self.context = {
            "mode": self.mode,
            "symbol": self.symbol,
            "live_trading_allowed": bool(self.config.get("meta", {}).get("live_trading_allowed", False)),
            "global_drawdown_multiplier": 1.0,
            "daily_loss_multiplier": 1.0,
            "execution_mode": getattr(self, "execution_mode", "paper"),
            "user_id": getattr(self, "user_id", None),
            "account_scope": getattr(self, "account_scope", "default"),
            "pending_order_intents": [],
            "active_strategy_id": active,
            "strategy_runtime": {"active_strategy_id": active},
        }
        if bars is None:
            bars = self.adapter.get_klines(self.symbol, timeframe="5m", limit=300)
        self.data_pool.update_from_bars(bars, microstructure=microstructure)
        account = self.adapter.get_account_info()
        self.context["equity"] = account.get("equity")

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
        used = float(self.context.get("open_portfolio_risk_pct_equity", 0.0))
        self.context["global_portfolio_risk_cap"] = cap
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

        # QA console / explicit pause: keep exit risk mgmt, block new Alpha openings
        if self.context.get("alpha_opening_enabled") is False:
            self.context["trade_intents"] = []
            return {
                "count": 0,
                "active_strategy_id": active,
                "alpha_opening_enabled": False,
                "intents": [],
                "blocked_reason": "ALPHA_OPENINGS_PAUSED",
            }

        # Invariant: only the active alpha strategy may emit new TradeIntents
        intents: List[TradeIntent] = []
        if active == "S1":
            intents.extend(self.s1.generate(symbol=self.symbol, data_pool=self.data_pool, context=self.context))
        elif active == "S2":
            intents.extend(self.s2.generate(symbol=self.symbol, data_pool=self.data_pool, context=self.context))
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
        return {"ok": ok, "edge": edge, "min_r": min_r, "stress_multipliers": stresses}

    def final_order_creation(self) -> Dict[str, Any]:
        self.last_orders = []
        gate = self.config.get("router", {}).get("final_order_gate", {})
        confirmed: List[TradeIntent] = list(self.context.get("confirmed_intents") or [])
        created = []

        cold = self.config.get("cost_model", {}).get("edge_estimator", {}).get("cold_start", {})
        paper_only = bool(self.context.get("paper_only_edge")) or bool(
            cold.get("if_validated_prior_missing", {}).get("paper_trading_only", False)
        )
        live_allowed = bool(self.config.get("meta", {}).get("live_trading_allowed", False))
        allow_place = True
        if self.mode == "live" and (not live_allowed or paper_only):
            allow_place = False
            self.context["order_blocked_reason"] = "live_trading_disallowed_or_paper_only"

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
            # portfolio risk after order placeholder
            budgets = self.context.get("S5", {}).get("strategy_risk_budget_pct_equity", {})
            add_risk = float(budgets.get(intent.strategy_id, 0.0))
            used = float(self.context.get("open_portfolio_risk_pct_equity", 0.0)) + add_risk
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
                continue
            if int(self.context.get("S6.level", 0)) >= 2:
                self.lifecycle.transition(intent, "SAFETY_REJECTED")
                continue
            if not allow_place:
                created.append({"intent_id": intent.intent_id, "blocked": True, "reason": self.context.get("order_blocked_reason")})
                continue

            side = "buy" if str(intent.direction).lower() == "long" else "sell"
            equity = float(self.context.get("equity") or 100000.0)
            risk_pct = float(budgets.get(intent.strategy_id, 0.002))
            atr = max(float(intent.reference_atr), 1e-12)
            qty = max((equity * risk_pct) / atr, 0.0)
            if qty <= 0:
                qty = 0.001

            execution_mode = str(
                self.context.get("execution_mode")
                or getattr(self, "execution_mode", None)
                or "paper"
            )
            if execution_mode in ("node_gateway", "node_gateway_shadow"):
                import uuid
                from datetime import datetime, timezone

                policy = self.lifecycle.get_policy(intent.strategy_id)
                order_intent = {
                    "order_intent_id": str(uuid.uuid4()),
                    "trade_intent_id": intent.intent_id,
                    "strategy_id": intent.strategy_id,
                    "active_strategy_id_at_creation": active,
                    "origin_strategy_id": intent.strategy_id,
                    "shadow": execution_mode == "node_gateway_shadow",
                    "user_id": self.context.get("user_id"),
                    "account_scope": self.context.get("account_scope") or "default",
                    "symbol": intent.symbol.replace("/", "-").replace(":USDT", "-SWAP")
                    if "/" in intent.symbol
                    else intent.symbol,
                    "side": side,
                    "position_side": "long" if side == "buy" else "short",
                    "order_type": "market",
                    "quantity": str(round(qty, 6)),
                    "reduce_only": False,
                    "client_order_id": f"v41_{intent.intent_id[:8]}_{uuid.uuid4().hex[:8]}",
                    "risk_snapshot": {
                        "strategy_id": intent.strategy_id,
                        "risk_pct": risk_pct,
                        "S6.level": self.context.get("S6.level"),
                    },
                    "entry_risk_snapshot": {
                        "strategy_id": intent.strategy_id,
                        "risk_pct": risk_pct,
                        "equity": equity,
                        "atr": atr,
                        "quantity": qty,
                    },
                    "exit_policy_snapshot": {
                        "origin_strategy_id": intent.strategy_id,
                        "lifecycle_policy": policy,
                    },
                    "stop_policy_snapshot": {
                        "origin_strategy_id": intent.strategy_id,
                        "reference_atr": float(intent.reference_atr),
                    },
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    "status": "PENDING_GATEWAY",
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
                continue

            order_res = self.adapter.place_order(
                symbol=intent.symbol,
                side=side,
                order_type="market",
                quantity=float(qty),
            )
            if order_res.get("ok"):
                self.lifecycle.transition(intent, "EXECUTED")
                policy = self.lifecycle.get_policy(intent.strategy_id)
                candidates = self.context.setdefault("opened_position_candidates", [])
                candidates.append(
                    {
                        "symbol": intent.symbol,
                        "side": "long" if side == "buy" else "short",
                        "quantity": float(qty),
                        "origin_strategy_id": intent.strategy_id,
                        "origin_trade_intent_id": intent.intent_id,
                        "entry_risk_snapshot": {
                            "strategy_id": intent.strategy_id,
                            "risk_pct": risk_pct,
                            "equity": equity,
                            "atr": atr,
                            "quantity": qty,
                        },
                        "exit_policy_snapshot": {
                            "origin_strategy_id": intent.strategy_id,
                            "lifecycle_policy": policy,
                        },
                        "stop_policy_snapshot": {
                            "origin_strategy_id": intent.strategy_id,
                            "reference_atr": float(intent.reference_atr),
                        },
                        "metadata": {"source": "paper_adapter", "order": order_res},
                    }
                )
            created.append({"intent_id": intent.intent_id, "order": order_res})
            self.last_orders.append(order_res)

        self.context["orders_created"] = created
        return {"orders": created}
