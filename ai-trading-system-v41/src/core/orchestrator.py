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
from src.runtime.alpha_ids import coerce_selectable
from src.runtime.s9_microstructure import SpreadWindow
from src.runtime.s9_market_hub import S9MarketHub
from src.runtime.s9_fee import S9FeeClient
from src.strategies.s1_trend import S1TrendStrategy
from src.strategies.s2_reversal import S2ReversalStrategy
from src.strategies.s3_regime import S3RegimeStrategy
from src.strategies.s4_execution import S4ExecutionStrategy
from src.strategies.s5_risk_budget import S5RiskBudgetAllocator
from src.strategies.s6_anomaly import S6AnomalyDetector
from src.strategies.s7_health import S7HealthMonitor
from src.strategies.s9_momentum import S9MomentumStrategy
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
        self.s9 = S9MomentumStrategy(config)
        self.s3 = S3RegimeStrategy(config, self.evaluator)
        self.s4 = S4ExecutionStrategy(config, self.evaluator, self.lifecycle)
        self.s5 = S5RiskBudgetAllocator(config)
        self.s6 = S6AnomalyDetector(config, self.evaluator)
        self.s7 = S7HealthMonitor(config)
        self.s9_spread = SpreadWindow()
        self.s9_hub = S9MarketHub()
        self.s9_fee = S9FeeClient()
        self.s9_runtime: Dict[str, Any] = {
            "last_direction": None,
            "cooldown_bars": 0,
            "consecutive_stops": 0,
            "pause_until_epoch": 0.0,
            "opening_times": [],
            "nonterminal_exit_position_ids": set(),
        }

        self.context: Dict[str, Any] = {}
        self.last_orders: List[Dict[str, Any]] = []
        # Invariant: exactly one active alpha strategy (S1, S2 or S9)
        self.active_strategy_id: str = "S1"
        self.alpha_opening_enabled: bool = True
        self.s1_timeframe: str = str((config.get("S1_trend") or {}).get("timeframe") or "1h")
        self.market_warmup_bars: int = 100
        self.market_fetch_limit: int = 200
        self.market_state: str = "WARMING_UP"
        self.market_meta: Dict[str, Any] = {}
        self.s9_closed_1m = None
        self.s9_closed_5m = None
        from src.runtime.strategy_diagnostics import StrategyDiagnostics

        self.diagnostics: Dict[str, StrategyDiagnostics] = {
            "S1": StrategyDiagnostics("S1"),
            "S2": StrategyDiagnostics("S2"),
            "S9": StrategyDiagnostics("S9"),
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
        active = coerce_selectable(self.active_strategy_id)
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
                if active == "S9":
                    rest_reason = self.s9_hub.rest_hydrate_reason()
                    if rest_reason:
                        bars_1m = self.adapter.get_klines(self.symbol, timeframe="1m", limit=250)
                        bars_5m = self.adapter.get_klines(self.symbol, timeframe="5m", limit=150)
                        self._apply_s9_market(bars_1m, bars_5m)
                        self.s9_hub.mark_rest_hydrate(rest_reason)
                    else:
                        self._apply_s9_market()
                    bars = self.s9_closed_1m
                else:
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
                    "timeframe": "1m" if active == "S9" else (self.s1_timeframe or "1h"),
                    "state": "STALE",
                    "error": str(exc),
                    "bars_loaded": 0,
                }
                self.context["market_data"] = dict(self.market_meta)
                raise
        elif active == "S9" and self.s9_closed_1m is None:
            self._apply_s9_market(bars, bars)
        if active != "S9":
            self._apply_market_bars(bars, microstructure=microstructure)
        else:
            if microstructure is not None:
                self.context["microstructure"] = microstructure
            self.data_pool.set_context({"market_data_state": self.market_state})
        account = self.adapter.get_account_info()
        self.context["equity"] = account.get("equity")
        if hasattr(self, "s9_fee") and coerce_selectable(self.active_strategy_id) == "S9":
            prev_fee_evt = getattr(self.s9_fee, "last_event", None)
            fee = self.s9_fee.get_taker_bps()
            self.context["okx_fee_bps"] = fee
            if self.s9_fee.last_event and self.s9_fee.last_event != prev_fee_evt:
                self.context["s9_fee_event"] = self.s9_fee.last_event
                on_evt = getattr(self.s9_hub, "on_event", None)
                if callable(on_evt):
                    on_evt(
                        self.s9_fee.last_event,
                        {
                            "source": "okx_account_trade_fee",
                            "reason_code": getattr(self.s9_fee, "last_reason_code", None),
                        },
                    )
        elif hasattr(self.adapter, "get_trade_fee_bps") and self.context.get("okx_fee_bps") is None:
            try:
                self.context["okx_fee_bps"] = self.adapter.get_trade_fee_bps(self.symbol)
            except Exception:
                self.context["okx_fee_bps"] = None
        if coerce_selectable(self.active_strategy_id) == "S9":
            self._apply_s9_market()
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

    def _apply_s9_market(self, bars_1m=None, bars_5m=None) -> None:
        from src.adapters.okx_market_data import split_closed_bars, to_okx_inst_id, use_real_okx_market
        from src.strategies.s9_momentum import closed_only

        hub = self.s9_hub
        if bars_1m is not None:
            c1, _, _ = split_closed_bars(bars_1m, timeframe="1m")
            c5, _, _ = split_closed_bars(bars_5m, timeframe="5m") if bars_5m is not None else (None, None, None)
            if c1 is None or getattr(c1, "empty", True):
                c1 = closed_only(bars_1m, timeframe="1m")
            if bars_5m is not None and (c5 is None or getattr(c5, "empty", True)):
                c5 = closed_only(bars_5m, timeframe="5m")
            if c1 is not None and not getattr(c1, "empty", True):
                hub.seed_closed_bars("1m", c1)
            if c5 is not None and not getattr(c5, "empty", True):
                hub.seed_closed_bars("5m", c5)
        fee_ready = self.context.get("okx_fee_bps") is not None
        if hasattr(self, "s9_fee"):
            fee_ready = self.s9_fee.snapshot().get("ready") is True
        snap = hub.refresh_state(fee_ready=bool(fee_ready))
        c1 = hub.closed_1m_df()
        c5 = hub.closed_5m_df()
        self.s9_closed_1m = c1
        self.s9_closed_5m = c5
        self.s9_spread = hub.spread
        n1 = int(len(c1)) if c1 is not None else 0
        n5 = int(len(c5)) if c5 is not None else 0
        if snap["warmup_state"] != "READY":
            self.market_state = "OFF" if snap["data_state"] == "OFF" else "WARMING_UP"
        else:
            self.market_state = snap["data_state"]
        latest_1m = str(c1.index[-1]) if n1 else None
        latest_5m = str(c5.index[-1]) if n5 else None
        prev_1m = (self.market_meta or {}).get("latest_closed_candle_at")
        if latest_1m and latest_1m != prev_1m and int(self.s9_runtime.get("cooldown_bars") or 0) > 0:
            self.s9_runtime["cooldown_bars"] = int(self.s9_runtime["cooldown_bars"]) - 1
        self.market_meta = {
            "source": "OKX" if use_real_okx_market() else "MOCK",
            "instrument": to_okx_inst_id(self.symbol),
            "timeframe": "1m",
            "latest_closed_candle_at": latest_1m,
            "latest_closed_5m_at": latest_5m,
            "closed_1m_bars": n1,
            "closed_5m_bars": n5,
            "state": self.market_state,
            "data_state": snap["data_state"],
            "connection_state": snap["connection_state"],
            "forming_1m": snap.get("forming_1m"),
            "forming_5m": snap.get("forming_5m"),
            "last_1m_open_at": snap.get("last_1m_open_at"),
            "last_1m_close_at": snap.get("last_1m_close_at"),
            "last_1m_received_at": snap.get("last_1m_received_at"),
            "last_1m_confirmed": snap.get("last_1m_confirmed"),
            "last_5m_open_at": snap.get("last_5m_open_at"),
            "last_5m_close_at": snap.get("last_5m_close_at"),
            "last_5m_received_at": snap.get("last_5m_received_at"),
            "last_5m_confirmed": snap.get("last_5m_confirmed"),
            "rest_hydrate_reason": getattr(hub, "last_rest_reason", None),
            "s9_market": snap,
        }
        self.context["market_data"] = dict(self.market_meta)
        self.context["s9_data_state"] = snap["data_state"]
        self.data_pool.set_context({"market_data_state": self.market_state})
        if n1 and c1 is not None:
            last = c1.iloc[-1]
            self.data_pool.set_context({"close": float(last["close"]), "atr14": float(last.get("atr14") or 1.0)})

    # --- decision_order steps ---

    def S6_safety_gate(self) -> Dict[str, Any]:
        result = self.s6.evaluate_signals(self.data_pool, self.context)
        self.context["safety_gate_pass"] = int(result.get("level", 0)) < 3
        return result

    def data_quality_gate(self) -> Dict[str, Any]:
        if coerce_selectable(self.active_strategy_id) == "S9":
            ok = str(self.market_state) in {"READY", "WARMING_UP", "DEGRADED"}
            self.context["data_quality_ok"] = ok
            self.data_pool.set_context({"data_quality_ok": ok})
            return {"data_quality_ok": ok}
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
            for sid in ("S1", "S2", "S9")
        }
        # S4 is execution-only — never an allocation health input for V4.2
        if str((self.config.get("S5_risk_budget") or {}).get("allocation_mode")) != "single_active_alpha":
            health["S4"] = float(self.context.get("S7", {}).get("S4", {}).get("health_score", 80.0))
        regime = str(self.context.get("S3.regime", "range"))
        return self.s5.allocate(regime=regime, health_scores=health, context=self.context)

    def S1_S2_signal_generation(self) -> Dict[str, Any]:
        # Update edge estimate into pool/context before entries
        self._s9_manage_exits()
        active = coerce_selectable(self.active_strategy_id)
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
        if active == "S9":
            market_ready = str(self.context.get("s9_data_state") or self.market_state) == "READY"
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
        elif active == "S9":
            intents.extend(self._s9_generate(emit_intents=emit_intents, extra_block=extra_block))
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

    def _s9_manage_exits(self) -> None:
        """Engine-side S9 exits. Never cancel protective stop before flatten."""
        from src.runtime.demo_execute_v1 import normalize_swap_symbol
        from src.runtime.s9_exits import evaluate_owned_exit, take_profit_price
        from src.strategies.s9_momentum import evaluate_5m_direction

        owned = [
            p if isinstance(p, dict) else {}
            for p in list(self.context.get("owned_open_positions") or [])
        ]
        s9_pos = [
            p
            for p in owned
            if str(p.get("origin_strategy_id") or "").upper() == "S9"
            and float(p.get("quantity") or 0) > 0
        ]
        if not s9_pos:
            self.context.pop("SYMBOL_EXIT_LOCK", None)
            return
        pending = self.context.setdefault("pending_order_intents", [])
        cfg = (self.config.get("S9_high_frequency_momentum") or {}).get("exits") or {}
        direction = {"state": str(self.s9_runtime.get("last_direction") or "NEUTRAL")}
        if self.s9_closed_5m is not None and len(self.s9_closed_5m):
            direction = evaluate_5m_direction(self.s9_closed_5m, self.config.get("S9_high_frequency_momentum") or {})
        new_state = str(direction.get("state") or "NEUTRAL")
        prev_state = str(self.s9_runtime.get("last_direction") or new_state)
        bid = ask = 0.0
        try:
            book = self.adapter.get_order_book(self.symbol, depth=5) or {}
            bids = list(book.get("bids") or [])
            asks = list(book.get("asks") or [])
            bid = float(bids[0][0]) if bids else 0.0
            ask = float(asks[0][0]) if asks else 0.0
        except Exception:
            bid = ask = 0.0
        now_epoch = __import__("time").time()
        import uuid
        from datetime import datetime, timezone

        for pos in s9_pos:
            pid = str(pos.get("position_id") or "")
            already = any(
                str(oi.get("position_id") or "") == pid
                and bool(oi.get("reduce_only"))
                and str(oi.get("status") or "").upper()
                in {"CREATED", "RECEIVED", "SUBMITTED", "PARTIALLY_FILLED", "PENDING_GATEWAY"}
                for oi in pending
            )
            if already or pid in self.s9_runtime["nonterminal_exit_position_ids"]:
                self.context["SYMBOL_EXIT_LOCK"] = True
                continue
            snap = pos.get("entry_risk_snapshot") or {}
            stop_snap = pos.get("stop_policy_snapshot") or {}
            avg = float(snap.get("entry_price") or snap.get("avg_entry_price") or 0)
            stop = float(stop_snap.get("stop_price") or snap.get("stop_price") or 0)
            meta = pos.get("metadata") or {}
            first_fill = meta.get("first_fill_at_epoch")
            if first_fill is None:
                opened = str(pos.get("opened_at") or "")
                try:
                    first_fill = datetime.fromisoformat(opened.replace("Z", "+00:00")).timestamp()
                except Exception:
                    first_fill = now_epoch
            side = str(pos.get("side") or "long")
            reason = evaluate_owned_exit(
                side=side,
                best_bid=bid,
                best_ask=ask,
                avg_entry=avg,
                initial_stop=stop,
                first_fill_at_epoch=float(first_fill),
                now_epoch=now_epoch,
                prev_direction=prev_state,
                new_direction=new_state,
                max_holding_minutes=float(cfg.get("max_holding_minutes") or 30),
                pending_exit=False,
            )
            if not reason:
                continue
            qty = float(pos.get("quantity") or 0)
            exit_side = "sell" if side.lower() in ("long", "buy") else "buy"
            intent = {
                "order_intent_id": f"s9-exit-{pid}-{uuid.uuid4().hex[:8]}",
                "position_id": pid,
                "origin_strategy_id": "S9",
                "strategy_id": "S9",
                "origin_trade_intent_id": pos.get("origin_trade_intent_id"),
                "symbol": normalize_swap_symbol(str(pos.get("symbol") or self.symbol)),
                "side": exit_side,
                "reduce_only": True,
                "purpose": "exit",
                "exit_reason": reason,
                "keep_protective_stop_until_flat": True,
                "cancel_stop_before_exit": False,
                "quantity_unit": "BASE",
                "base_quantity": qty,
                "owned_remaining_base_qty": qty,
                "status": "CREATED",
                "created_at": datetime.now(timezone.utc).isoformat(),
                "take_profit_price": take_profit_price(side=side, avg_entry=avg, initial_stop=stop)
                if avg and stop
                else None,
            }
            pending.append(intent)
            self.s9_runtime["nonterminal_exit_position_ids"].add(pid)
            self.context["SYMBOL_EXIT_LOCK"] = True
            self.context["s9_exit"] = {"reason": reason, "position_id": pid, "cancel_stop_before_exit": False}
        self.s9_runtime["last_direction"] = new_state

    def _s9_symbol_blocked(self) -> Optional[str]:
        from src.runtime.s9_cleanup import symbol_conflict
        from src.runtime.s9_exits import dust_block
        from src.runtime.demo_execute_v1 import normalize_swap_symbol

        target = normalize_swap_symbol(self.symbol)
        other = False
        exchange_net = 0.0
        local_owned = 0.0
        pending_exit = 0
        pending_open = 0
        protective = 0
        recon = str(self.context.get("reconciliation_status") or "MATCHED")
        for pos in list(self.context.get("owned_open_positions") or []):
            data = pos if isinstance(pos, dict) else {}
            sym = normalize_swap_symbol(str(data.get("symbol") or ""))
            if sym != target:
                continue
            origin = str(data.get("origin_strategy_id") or "").upper()
            qty = float(data.get("quantity") or 0)
            if origin and origin != "S9" and qty:
                other = True
            if origin == "S9":
                local_owned += qty
        exchange_net = float(self.context.get("exchange_net_position_contracts") or local_owned)
        pending_open = int(self.context.get("pending_opening_orders") or 0)
        pending_exit = int(self.context.get("pending_exit_orders") or 0)
        protective = int(self.context.get("protective_algo_nonterminal_count") or 0)
        dust = dust_block(local_owned=local_owned, exchange_net=exchange_net)
        if dust:
            return dust
        if pending_open or pending_exit or protective or str(recon).upper() != "MATCHED":
            if local_owned or exchange_net or pending_open or pending_exit or protective:
                return "SYMBOL_OWNERSHIP_CONFLICT"
        return symbol_conflict(other_owned_same_symbol=other)

    def _s9_generate(self, *, emit_intents: bool, extra_block: List[str]) -> List[TradeIntent]:
        diag = self.diagnostics.get("S9")
        closed_1m = self.s9_closed_1m
        closed_5m = self.s9_closed_5m
        result = self.s9.generate(
            closed_1m=closed_1m,
            closed_5m=closed_5m,
            context=self.context,
            emit_intents=False,
        )
        payload = dict(self.context.get("s9") or {})
        if payload.get("skipped"):
            return []
        reasons = list(payload.get("reason_codes") or extra_block)
        decision = str(payload.get("decision") or "NO_TRADE")
        direction = str(payload.get("direction") or "NONE")
        if extra_block:
            decision = "NO_TRADE"
            reasons = extra_block + reasons
        own_block = self._s9_symbol_blocked()
        if own_block:
            decision = "NO_TRADE"
            reasons = [own_block]
        freq_cfg = (self.config.get("S9_high_frequency_momentum") or {}).get("frequency") or {}
        from src.runtime.s9_exits import frequency_block
        import time as _time

        now_epoch = _time.time()
        if now_epoch < float(self.s9_runtime.get("pause_until_epoch") or 0):
            decision = "NO_TRADE"
            reasons = ["S9_COOLDOWN"]
        if int(self.s9_runtime.get("cooldown_bars") or 0) > 0:
            decision = "NO_TRADE"
            reasons = ["S9_COOLDOWN"]
        hour_opens = [t for t in self.s9_runtime.get("opening_times") or [] if now_epoch - t <= 3600]
        self.s9_runtime["opening_times"] = hour_opens
        from datetime import datetime, timezone

        day_key = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        day_opens = [t for t in hour_opens]  # hour list is subset; day tracked separately below
        day_count = int(self.s9_runtime.get("day_count") or 0)
        if self.s9_runtime.get("day_key") != day_key:
            self.s9_runtime["day_key"] = day_key
            self.s9_runtime["day_count"] = 0
            day_count = 0
        freq_reason = frequency_block(
            hour_count=len(hour_opens),
            day_count=day_count,
            max_hour=int(freq_cfg.get("max_completed_or_filled_openings_per_rolling_hour") or 6),
            max_day=int(freq_cfg.get("max_openings_per_utc_calendar_day") or 30),
        )
        if freq_reason:
            decision = "NO_TRADE"
            reasons = [freq_reason]
        if diag:
            diag.record_evaluation(
                decision=decision,
                reason_codes=reasons,
                direction=direction,
                symbol=self.symbol,
                raw_signal=decision == "CANDIDATE",
                trade_intent=False,
                source_closed_candle_timestamp=str((payload.get("diagnostics") or {}).get("source_1m_candle_timestamp") or ""),
            )
        self.context["s9_candidate"] = None
        if decision != "CANDIDATE" or not emit_intents or extra_block or own_block:
            return []

        from src.runtime.risk_usage import authorize_opening, planned_trade_risk_pct, strategy_initial_risk_cap
        from src.runtime.demo_execute_v1 import compute_base_quantity

        planned = planned_trade_risk_pct(self.config, "S9")
        s5_ctx = self.context.get("S5") or {}
        portfolio_limit = float(s5_ctx.get("portfolio_risk_budget_pct_equity") or 0.0) or float(
            self.s5._portfolio_budget(self.context)
        )
        strategy_limit = float(
            (s5_ctx.get("strategy_risk_cap_pct_equity") or {}).get("S9") or strategy_initial_risk_cap(self.config, "S9")
        )
        auth = authorize_opening(
            strategy_id="S9",
            planned_trade_risk_pct_equity=planned,
            usage=self.context.get("risk_usage") or {},
            portfolio_risk_limit_pct_equity=portfolio_limit,
            strategy_risk_limit_pct_equity=strategy_limit,
            reserved_opening_risk_pct_equity=float(self.context.get("reserved_opening_risk_pct_equity") or 0.0),
        )
        payload["s5_authorization"] = auth.to_dict()
        if auth.action == "BLOCK":
            if diag:
                diag.record_evaluation(
                    decision="NO_TRADE",
                    reason_codes=[auth.reason_code],
                    direction=direction,
                    symbol=self.symbol,
                )
            return []
        risk_pct = float(auth.allowed_risk_pct_equity if auth.action == "SHRINK" else planned)
        equity = float(self.context.get("equity") or 0.0)
        entry = float(payload.get("trigger_reference_price") or 0)
        stop = float(payload.get("stop_price") or 0)
        sizing = None
        if equity > 0 and entry > 0 and stop > 0:
            try:
                sizing = compute_base_quantity(equity=equity, risk_pct=risk_pct, entry_price=entry, stop_price=stop)
            except ValueError:
                sizing = None
        payload["authorized_base_quantity"] = None if not sizing else sizing["base_quantity"]
        payload["s9_risk_pct"] = risk_pct
        payload["s9_risk_amount_quote"] = None if not sizing else sizing.get("risk_amount_quote")
        self.context["s9_candidate"] = payload
        return []

    def S4_execution_timing(self) -> Dict[str, Any]:
        if coerce_selectable(self.active_strategy_id) == "S9":
            return self._s9_s4_validate()
        intents: List[TradeIntent] = list(self.context.get("trade_intents") or [])
        confirmed = self.s4.process_intents(intents, self.data_pool, self.context)
        return {"confirmed": [i.to_dict() for i in confirmed]}

    def _s9_s4_validate(self) -> Dict[str, Any]:
        from src.runtime.s9_microstructure import (
            cost_gate,
            entry_drift_exceeded,
            evaluate_microstructure,
            round_trip_cost_bps,
        )

        cand = dict(self.context.get("s9_candidate") or {})
        if not cand:
            self.context["confirmed_intents"] = []
            return {"confirmed": []}
        side = str(cand.get("direction") or "LONG")
        qty = float(cand.get("authorized_base_quantity") or 0)
        hub = getattr(self, "s9_hub", None)
        book = {}
        trades: List[Dict[str, Any]] = []
        now_ts = __import__("time").time()
        if hub and hub.book:
            book = dict(hub.book)
            trades = hub.recent_trades(now_ts)
            book_age = hub.book_age_sec(now_ts) or 99.0
            trades_age = hub.trades_age_sec(now_ts) or 99.0
        else:
            try:
                book = self.adapter.get_order_book(self.symbol, depth=5) or {}
            except Exception:
                book = {}
            try:
                trades = list(self.adapter.get_recent_trades(self.symbol, limit=40) or [])
            except Exception:
                trades = []
            book_age = 99.0
            trades_age = 99.0
            ts_book = book.get("timestamp")
            if ts_book:
                try:
                    book_age = max(0.0, now_ts - float(ts_book) / (1000.0 if float(ts_book) > 1e12 else 1.0))
                except (TypeError, ValueError):
                    book_age = 99.0
            if trades:
                t0 = trades[-1].get("timestamp") or 0
                try:
                    trades_age = max(0.0, now_ts - float(t0) / (1000.0 if float(t0) > 1e12 else 1.0))
                except (TypeError, ValueError):
                    trades_age = 99.0
        bids = list(book.get("bids") or [])
        asks = list(book.get("asks") or [])
        bid = float(book.get("best_bid") or (bids[0][0] if bids else 0.0) or 0.0)
        ask = float(book.get("best_ask") or (asks[0][0] if asks else 0.0) or 0.0)
        ct_val = 0.01
        qty_contracts = qty / ct_val if qty else 0.0
        micro_cfg = (self.config.get("S9_high_frequency_momentum") or {}).get("microstructure") or {}
        micro = evaluate_microstructure(
            side=side,
            bid=bid,
            ask=ask,
            bids=bids,
            asks=asks,
            trades=trades,
            spread_window=self.s9_spread,
            now_ts=now_ts,
            book_age_sec=book_age,
            trades_age_sec=trades_age,
            cfg={"microstructure": micro_cfg},
            authorized_base_qty=qty_contracts,
        )
        cand["pre_submit_orderbook_snapshot"] = {"bids": bids[:5], "asks": asks[:5]}
        cand["diagnostics"] = {**(cand.get("diagnostics") or {}), **{k: micro.get(k) for k in micro if k.startswith("s9_")}}
        reasons = list(micro.get("reasons") or [])
        fee = self.context.get("okx_fee_bps")
        if fee is None:
            reasons.append("S9_COST_DATA_UNAVAILABLE")
        slip = float(micro.get("s9_expected_slippage_bps") or 0)
        spr = float(micro.get("s9_spread_bps") or 0)
        if fee is not None:
            rtc = round_trip_cost_bps(entry_fee_bps=float(fee), exit_fee_bps=float(fee), spread=spr, slip=slip)
            cand["diagnostics"]["s9_estimated_round_trip_cost_bps"] = rtc
            entry = float(cand.get("trigger_reference_price") or 0)
            stop = float(cand.get("stop_price") or 0)
            target_bps = abs(entry - stop) / entry * 10_000.0 * 1.5 if entry else 0
            cost_reason = cost_gate(target_distance_bps=target_bps, round_trip_bps=rtc)
            if cost_reason:
                reasons.append(cost_reason)
        exec_px = ask if side == "LONG" else bid
        if entry_drift_exceeded(side=side, trigger=float(cand.get("trigger_reference_price") or 0), executable=exec_px):
            reasons.append("S9_ENTRY_PRICE_DRIFT_EXCEEDED")
        diag = self.diagnostics.get("S9")
        if reasons or qty <= 0:
            if diag:
                diag.record_evaluation(
                    decision="NO_TRADE",
                    reason_codes=reasons or ["S9_DATA_DEGRADED"],
                    direction=side,
                    symbol=self.symbol,
                )
            self.context["confirmed_intents"] = []
            return {"confirmed": [], "reasons": reasons}
        intent = self.lifecycle.create_intent(
            strategy_id="S9",
            symbol=self.symbol,
            direction=side.lower(),
            reference_price=exec_px,
            reference_atr=float((cand.get("diagnostics") or {}).get("s9_atr14") or 1.0),
            signal_snapshot=cand,
            metadata={
                "signal_key": cand.get("signal_key"),
                "stop_price": cand.get("stop_price"),
                "take_profit_price": cand.get("take_profit_price"),
                "trigger_reference_price": cand.get("trigger_reference_price"),
                "authorized_base_quantity": qty,
                "s9": cand,
            },
        )
        self.lifecycle.transition(intent, "WAITING_EXECUTION_CONFIRMATION")
        self.lifecycle.transition(intent, "CONFIRMED")
        self.context["confirmed_intents"] = [intent]
        self.context["trade_intents"] = [intent]
        if diag:
            diag.record_evaluation(
                decision="ALLOW",
                reason_codes=[],
                direction=side,
                symbol=self.symbol,
                raw_signal=True,
                trade_intent=True,
                source_closed_candle_timestamp=str((cand.get("diagnostics") or {}).get("source_1m_candle_timestamp") or ""),
            )
        return {"confirmed": [intent.to_dict()]}

    def cost_slippage_gate(self) -> Dict[str, Any]:
        if coerce_selectable(self.active_strategy_id) == "S9":
            self.context["cost_gate_pass"] = True
            return {"ok": True, "skipped": "S9_OWN_COST_GATE"}
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
            if str(intent.strategy_id).upper() == "S9":
                equity = float(self.context.get("equity") or 0.0)
            else:
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
            sizing = None
            if str(intent.strategy_id).upper() == "S9":
                stop_price = float((intent.metadata or {}).get("stop_price") or 0) or None
                stop_info = {"method": "MICRO_SWING_1X1", "stop_price": stop_price, "structure_method": "MICRO_SWING_1X1"}
                auth_qty = (intent.metadata or {}).get("authorized_base_quantity")
                if auth_qty:
                    sizing = {
                        "base_quantity": float(auth_qty),
                        "risk_amount_quote": (intent.metadata or {}).get("s9_risk_amount_quote")
                        or ((intent.metadata or {}).get("s9") or {}).get("s9_risk_amount_quote"),
                    }
            else:
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
            if sizing is None and stop_price:
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
            candle_at = str(
                (intent.metadata or {}).get("signal_key")
                and str((intent.signal_snapshot or {}).get("diagnostics") or {}).get("source_1m_candle_timestamp")
                or md.get("latest_closed_candle_at")
                or ""
            )
            if str(intent.strategy_id).upper() == "S9" and (intent.metadata or {}).get("signal_key"):
                skey = str(intent.metadata.get("signal_key"))
            else:
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
                if str(intent.strategy_id).upper() != "S9":
                    self.lifecycle.transition(intent, "RISK_REJECTED")
                    continue
                s9_cfg = self.config.get("S9_high_frequency_momentum") or {}
                if s9_cfg.get("live_allowed") is True or s9_cfg.get("demo_allowed") is False:
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
                    "formula": "MICRO_SWING_1X1"
                    if str(intent.strategy_id).upper() == "S9"
                    else "min(1.5*atr14, structure_invalidation_distance)",
                    "structure_method": (stop_info or {}).get("structure_method")
                    or (stop_info or {}).get("method"),
                    "complete": bool(stop_price),
                },
                "created_at": datetime.now(timezone.utc).isoformat(),
                "trade_intent_created_at": getattr(intent, "created_at", None),
                "ttl_seconds": 20 if str(intent.strategy_id).upper() == "S9" else None,
                "keep_protective_stop_until_flat": True,
                "cancel_stop_before_exit": False,
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
