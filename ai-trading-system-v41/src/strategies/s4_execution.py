"""S4 microstructure execution confirmation."""

from __future__ import annotations

from typing import Any, Dict, List, Mapping

from src.core.rule_evaluator import RuleEvaluator
from src.core.signal_lifecycle import SignalLifecycleManager, TradeIntent


class S4ExecutionStrategy:
    def __init__(
        self,
        config: Mapping[str, Any],
        evaluator: RuleEvaluator,
        lifecycle: SignalLifecycleManager,
    ) -> None:
        self.config = config
        self.cfg = config.get("S4_execution", {})
        self.evaluator = evaluator
        self.lifecycle = lifecycle

    def process_intents(
        self,
        intents: List[TradeIntent],
        data_pool: Any,
        context: Dict[str, Any],
    ) -> List[TradeIntent]:
        if not self.cfg.get("enabled", True):
            return intents

        confirmed: List[TradeIntent] = []
        for intent in intents:
            if intent.status != "WAITING_EXECUTION_CONFIRMATION":
                continue

            mid = float(data_pool.get("close") or data_pool.get("mid") or intent.reference_price)
            validity = self.lifecycle.validate_intent(intent, mid, data_pool.get("atr14"))
            if not validity["valid"]:
                continue

            ctx = dict(context)
            ctx["authorized_direction"] = intent.direction
            ctx["trade_intent"] = intent.to_dict()
            data_pool.set_context({"authorized_direction": intent.direction})

            rule = self.cfg.get("long_confirm") if intent.direction == "long" else self.cfg.get("short_confirm")
            ok = bool(self.evaluator.evaluate(rule or {}, ctx))
            if ok:
                self.lifecycle.transition(intent, "CONFIRMED")
                confirmed.append(intent)
            else:
                self.lifecycle.transition(intent, "S4_REJECTED")
        context["confirmed_intents"] = confirmed
        return confirmed
