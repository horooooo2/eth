"""S1 trend-following strategy."""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional

from src.core.rule_evaluator import RuleEvaluator
from src.core.signal_lifecycle import SignalLifecycleManager, TradeIntent


class S1TrendStrategy:
    def __init__(
        self,
        config: Mapping[str, Any],
        evaluator: RuleEvaluator,
        lifecycle: SignalLifecycleManager,
    ) -> None:
        self.config = config
        self.cfg = config.get("S1_trend", {})
        self.evaluator = evaluator
        self.lifecycle = lifecycle

    def _trend_quality_score(self, pool: Any) -> float:
        # From config formula intent: combine ADX / separation / slope quality into 0-100
        adx = float(pool.get("adx14") or 0.0)
        sep = float(pool.get("trend_separation") or 0.0)
        slope = abs(float(pool.get("trend_slope_6") or 0.0))
        score = min(100.0, max(0.0, 0.5 * adx + 20.0 * min(sep, 2.0) + 1000.0 * min(slope, 0.05)))
        return score

    def generate(
        self,
        *,
        symbol: str,
        data_pool: Any,
        context: Dict[str, Any],
    ) -> List[TradeIntent]:
        if not self.cfg.get("enabled", True):
            return []
        intents: List[TradeIntent] = []
        ctx = dict(context)
        tq = self._trend_quality_score(data_pool)
        data_pool.set_context({"trend_quality_score": tq})
        ctx["trend_quality_score"] = tq

        edge = float(ctx.get("expected_edge_after_cost_R", data_pool.get("expected_edge_after_cost_R") or 0.0))
        data_pool.set_context({"expected_edge_after_cost_R": edge})
        ctx["expected_edge_after_cost_R"] = edge

        mid = float(data_pool.get("close") or data_pool.get("mid") or 0.0)
        atr = float(data_pool.get("atr14") or 0.0)
        if mid <= 0 or atr <= 0:
            return []

        long_ok = bool(self.evaluator.evaluate(self.cfg.get("long_entry", {}), ctx))
        short_ok = bool(self.evaluator.evaluate(self.cfg.get("short_entry", {}), ctx))

        if long_ok:
            intent = self.lifecycle.create_intent(
                strategy_id="S1",
                symbol=symbol,
                direction="long",
                reference_price=mid,
                reference_atr=atr,
                signal_snapshot={"trend_quality_score": tq, "side": "long"},
            )
            self.lifecycle.transition(intent, "WAITING_EXECUTION_CONFIRMATION")
            intents.append(intent)
        elif short_ok:
            intent = self.lifecycle.create_intent(
                strategy_id="S1",
                symbol=symbol,
                direction="short",
                reference_price=mid,
                reference_atr=atr,
                signal_snapshot={"trend_quality_score": tq, "side": "short"},
            )
            self.lifecycle.transition(intent, "WAITING_EXECUTION_CONFIRMATION")
            intents.append(intent)
        return intents
