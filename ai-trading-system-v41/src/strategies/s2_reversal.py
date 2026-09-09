"""S2 mean-reversion / reversal strategy."""

from __future__ import annotations

from typing import Any, Dict, List, Mapping

from src.core.rule_evaluator import RuleEvaluator
from src.core.signal_lifecycle import SignalLifecycleManager, TradeIntent


class S2ReversalStrategy:
    def __init__(
        self,
        config: Mapping[str, Any],
        evaluator: RuleEvaluator,
        lifecycle: SignalLifecycleManager,
    ) -> None:
        self.config = config
        self.cfg = config.get("S2_reversal", {})
        self.evaluator = evaluator
        self.lifecycle = lifecycle

    def _compute_flags(self, data_pool: Any, ctx: Dict[str, Any]) -> None:
        params = self.cfg.get("parameters", {})
        rsi = float(data_pool.get("rsi14") or 50.0)
        slope = float(data_pool.get("trend_slope_6") or 0.0)
        # Confirmation heuristics driven by configured thresholds when present
        rsi_long = float(params.get("rsi_long_threshold", 25))
        rsi_short = float(params.get("rsi_short_threshold", 75))
        conf_long = rsi <= rsi_long and slope > 0
        conf_short = rsi >= rsi_short and slope < 0
        # Acceleration block if strong trend continues against mean reversion
        block_long = slope < float(params.get("accel_block_slope", -0.0)) and float(data_pool.get("adx14") or 0) > 40
        block_short = slope > float(params.get("accel_block_slope_short", 0.0)) and float(data_pool.get("adx14") or 0) > 40

        # Prefer explicit config confirmation trees if present as feature flags
        if "reversal_confirmation_long" in self.cfg and isinstance(self.cfg["reversal_confirmation_long"], dict):
            conf_long = bool(self.evaluator.evaluate(self.cfg["reversal_confirmation_long"], ctx))
        if "reversal_confirmation_short" in self.cfg and isinstance(self.cfg["reversal_confirmation_short"], dict):
            conf_short = bool(self.evaluator.evaluate(self.cfg["reversal_confirmation_short"], ctx))
        if "trend_acceleration_block_long" in self.cfg and isinstance(self.cfg["trend_acceleration_block_long"], dict):
            block_long = bool(self.evaluator.evaluate(self.cfg["trend_acceleration_block_long"], ctx))
        if "trend_acceleration_block_short" in self.cfg and isinstance(self.cfg["trend_acceleration_block_short"], dict):
            block_short = bool(self.evaluator.evaluate(self.cfg["trend_acceleration_block_short"], ctx))

        data_pool.set_context(
            {
                "reversal_confirmation_long": conf_long,
                "reversal_confirmation_short": conf_short,
                "trend_acceleration_block_long": block_long,
                "trend_acceleration_block_short": block_short,
            }
        )
        ctx.update(
            {
                "reversal_confirmation_long": conf_long,
                "reversal_confirmation_short": conf_short,
                "trend_acceleration_block_long": block_long,
                "trend_acceleration_block_short": block_short,
            }
        )

    def generate(
        self,
        *,
        symbol: str,
        data_pool: Any,
        context: Dict[str, Any],
    ) -> List[TradeIntent]:
        if not self.cfg.get("enabled", True):
            return []
        ctx = dict(context)
        self._compute_flags(data_pool, ctx)
        edge = float(ctx.get("expected_edge_after_cost_R", data_pool.get("expected_edge_after_cost_R") or 0.0))
        data_pool.set_context({"expected_edge_after_cost_R": edge})
        ctx["expected_edge_after_cost_R"] = edge

        mid = float(data_pool.get("close") or 0.0)
        atr = float(data_pool.get("atr14") or 0.0)
        if mid <= 0 or atr <= 0:
            return []

        intents: List[TradeIntent] = []
        if bool(self.evaluator.evaluate(self.cfg.get("long_entry", {}), ctx)):
            intent = self.lifecycle.create_intent(
                strategy_id="S2",
                symbol=symbol,
                direction="long",
                reference_price=mid,
                reference_atr=atr,
                signal_snapshot={"side": "long"},
            )
            self.lifecycle.transition(intent, "WAITING_EXECUTION_CONFIRMATION")
            intents.append(intent)
        elif bool(self.evaluator.evaluate(self.cfg.get("short_entry", {}), ctx)):
            intent = self.lifecycle.create_intent(
                strategy_id="S2",
                symbol=symbol,
                direction="short",
                reference_price=mid,
                reference_atr=atr,
                signal_snapshot={"side": "short"},
            )
            self.lifecycle.transition(intent, "WAITING_EXECUTION_CONFIRMATION")
            intents.append(intent)
        return intents
