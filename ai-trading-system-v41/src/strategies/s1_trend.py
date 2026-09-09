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
        self._last_intent_key: Optional[str] = None

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
        emit_intents: bool = True,
        extra_reason_codes: Optional[List[str]] = None,
    ) -> List[TradeIntent]:
        from src.runtime.strategy_diagnostics import reason_for_lhs

        extra = list(extra_reason_codes or [])
        if not self.cfg.get("enabled", True):
            self._record(context, "NO_TRADE", extra + ["S1_DISABLED"], "NONE", symbol=symbol)
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
            self._record(context, "NO_TRADE", extra + ["MISSING_PRICE_OR_ATR"], "NONE", symbol=symbol)
            return []

        long_ok = bool(self.evaluator.evaluate(self.cfg.get("long_entry", {}), ctx))
        short_ok = bool(self.evaluator.evaluate(self.cfg.get("short_entry", {}), ctx))

        if long_ok:
            direction = "LONG"
            reasons = list(extra)
            decision = "ALLOW" if emit_intents else "BLOCK"
            if extra:
                decision = "BLOCK"
            self._record(
                context,
                decision,
                reasons or ["S1_LONG_OK"],
                direction,
                symbol=symbol,
                raw_signal=True,
                trade_intent=emit_intents and decision == "ALLOW",
            )
            if emit_intents and decision == "ALLOW":
                candle_key = str((context.get("market_data") or {}).get("latest_closed_candle_at") or "")
                intent_key = f"LONG|{candle_key}"
                if candle_key and self._last_intent_key == intent_key:
                    self._record(
                        context,
                        "NO_TRADE",
                        extra + ["DUPLICATE_CLOSED_CANDLE"],
                        direction,
                        symbol=symbol,
                        raw_signal=True,
                    )
                    return []
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
                self._last_intent_key = intent_key
            return intents
        if short_ok:
            direction = "SHORT"
            reasons = list(extra)
            decision = "ALLOW" if emit_intents else "BLOCK"
            if extra:
                decision = "BLOCK"
            self._record(
                context,
                decision,
                reasons or ["S1_SHORT_OK"],
                direction,
                symbol=symbol,
                raw_signal=True,
                trade_intent=emit_intents and decision == "ALLOW",
            )
            if emit_intents and decision == "ALLOW":
                candle_key = str((context.get("market_data") or {}).get("latest_closed_candle_at") or "")
                intent_key = f"SHORT|{candle_key}"
                if candle_key and self._last_intent_key == intent_key:
                    self._record(
                        context,
                        "NO_TRADE",
                        extra + ["DUPLICATE_CLOSED_CANDLE"],
                        direction,
                        symbol=symbol,
                        raw_signal=True,
                    )
                    return []
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
                self._last_intent_key = intent_key
            return intents

        failed_long = self.evaluator.explain_failures(self.cfg.get("long_entry", {}), ctx)
        failed_short = self.evaluator.explain_failures(self.cfg.get("short_entry", {}), ctx)
        reasons: List[str] = []
        seen = set()
        for code in extra + [reason_for_lhs(str(item.get("lhs"))) for item in failed_long + failed_short]:
            if code and code not in seen:
                seen.add(code)
                reasons.append(code)
        if not reasons:
            reasons = ["S1_NO_DIRECTION"]
        self._record(context, "NO_TRADE", reasons, "NONE", symbol=symbol)
        return intents

    def _record(
        self,
        context: Dict[str, Any],
        decision: str,
        reason_codes: List[str],
        direction: str,
        *,
        symbol: str = "",
        raw_signal: bool = False,
        trade_intent: bool = False,
    ) -> None:
        diag = None
        owner = context.get("_diagnostics")
        if owner is not None:
            diag = owner.get("S1") if isinstance(owner, dict) else owner
        if diag is None:
            return
        diag.record_evaluation(
            decision=decision,
            reason_codes=reason_codes,
            direction=direction,
            symbol=symbol,
            raw_signal=raw_signal,
            trade_intent=trade_intent,
        )
