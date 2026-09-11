"""Per-strategy runtime diagnostics. Incremented only during real evaluations."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


REASON_BY_LHS = {
    "close": "CLOSE_VS_EMA20",
    "ema20": "EMA20_VS_EMA50",
    "trend_slope_6": "TREND_SLOPE",
    "trend_quality_score": "TREND_QUALITY_BELOW_THRESHOLD",
    "S3.direction_bias": "S3_DIRECTION_BLOCK",
    "S3.regime": "S3_REGIME_BLOCK",
    "atr_ratio_20": "VOLATILITY_CONDITION",
    "expected_edge_after_cost_R": "EXPECTED_EDGE_TOO_LOW",
}


def reason_for_lhs(lhs: str) -> str:
    return REASON_BY_LHS.get(str(lhs), f"COND_{str(lhs).upper().replace('.', '_')}")


_S9_S3_FAIL = {
    "S9_S3_DIRECTION_BLOCK",
    "S9_EARLY_S3_OPPOSITION_BLOCK",
    "S3_REGIME_BLOCK",
    "S3_DIRECTION_BLOCK",
}
_S9_BREAKOUT_FAIL = {"S9_NO_BREAKOUT", "S9_EARLY_BREAKOUT_NOT_TRIGGERED"}
_S9_VOLUME_FAIL = {"S9_VOLUME_NOT_EXPANDED", "S9_EARLY_VOLUME_NOT_EXPANDED"}
_S9_CANDLE_FAIL = {"S9_CANDLE_QUALITY_BLOCK", "S9_EARLY_CANDLE_QUALITY_BLOCK"}
_S9_ATR_FAIL = {"S9_VOLATILITY_TOO_LOW", "S9_VOLATILITY_TOO_HIGH"}
_S9_STRUCTURE_FAIL = {
    "S9_STRUCTURE_STOP_NOT_FOUND",
    "S9_STRUCTURE_STOP_TOO_TIGHT",
    "S9_STRUCTURE_STOP_TOO_WIDE",
}


class StrategyDiagnostics:
    def __init__(self, strategy_id: str) -> None:
        self.strategy_id = strategy_id
        self.evaluation_count = 0
        self.direction_pass_count = 0
        self.s3_pass_count = 0
        self.breakout_pass_count = 0
        self.volume_pass_count = 0
        self.candle_pass_count = 0
        self.atr_pass_count = 0
        self.structure_pass_count = 0
        self.candidate_count = 0
        self.pending_candidate_created_count = 0
        self.pending_candidate_resumed_count = 0
        self.pending_candidate_expired_count = 0
        self.pending_candidate_invalidated_count = 0
        self.pending_candidate_active = False
        self.pending_candidate_signal_key = ""
        self.pending_candidate_closed_1m_id = None
        self.pending_candidate_created_at_epoch_ms: Optional[float] = None
        self.pending_candidate_expires_at_epoch_ms: Optional[float] = None
        self.trade_intent_count = 0
        self.order_intent_count = 0
        self.raw_signal_count = 0
        self.trade_intent_created_count = 0
        self.trade_intent_expired_count = 0
        self.S3_rejected_count = 0
        self.S5_rejected_count = 0
        self.S6_rejected_count = 0
        self.S7_rejected_count = 0
        self.edge_rejected_count = 0
        self.S4_rejected_count = 0
        self.cost_rejected_count = 0
        self.order_intent_created_count = 0
        self.executed_count = 0
        self.last_evaluated_at: Optional[str] = None
        self.last_raw_signal_at: Optional[str] = None
        self.last_trade_intent_at: Optional[str] = None
        self.last_order_intent_at: Optional[str] = None
        self.last_decision: str = "NO_TRADE"
        self.last_reason_codes: List[str] = []
        self.last_direction: str = "NONE"
        self.last_symbol: str = ""
        self.last_closed_candle: str = ""
        self.last_emit_key: Optional[str] = None
        self.last_emit_at: Optional[str] = None
        self.pending_log_event: Optional[Dict[str, Any]] = None
        self.last_structure: Optional[Dict[str, Any]] = None

    def record_evaluation(
        self,
        *,
        decision: str,
        reason_codes: List[str],
        direction: str = "NONE",
        symbol: str = "",
        raw_signal: bool = False,
        trade_intent: bool = False,
        source_closed_candle_timestamp: str = "",
    ) -> None:
        self.evaluation_count += 1
        self.last_evaluated_at = _now_iso()
        self.last_decision = decision
        self.last_reason_codes = list(reason_codes)
        self.last_direction = direction
        self.last_symbol = str(symbol or "")
        if source_closed_candle_timestamp:
            self.last_closed_candle = str(source_closed_candle_timestamp)
        codes = set(reason_codes)
        if "S3_REGIME_BLOCK" in codes or "S3_DIRECTION_BLOCK" in codes:
            self.S3_rejected_count += 1
        if "S5_BUDGET_BLOCK" in codes:
            self.S5_rejected_count += 1
        if any(c.startswith("S6_") for c in codes):
            self.S6_rejected_count += 1
        if any(c.startswith("S7_") for c in codes):
            self.S7_rejected_count += 1
        if "EXPECTED_EDGE_TOO_LOW" in codes or "EDGE_UNAVAILABLE" in codes:
            self.edge_rejected_count += 1
        if raw_signal:
            self.raw_signal_count += 1
            self.last_raw_signal_at = self.last_evaluated_at
        if trade_intent:
            self.trade_intent_created_count += 1
            self.trade_intent_count += 1
            self.last_trade_intent_at = self.last_evaluated_at
        self._maybe_queue_log_event()

    def record_s9_gates(self, *, decision: str, reason_codes: List[str]) -> None:
        """Increment S9 entry-gate pass counters from the raw evaluate result.

        Independent of runtime-event emit / 10-minute NO_TRADE dedupe.
        extra_block reasons must not be passed in.
        """
        codes = {str(c).strip() for c in (reason_codes or []) if str(c).strip()}
        if "S9_DATA_5M_STALE" in codes or "S9_DIRECTION_NEUTRAL" in codes:
            return
        self.direction_pass_count += 1
        if codes & _S9_S3_FAIL:
            return
        self.s3_pass_count += 1
        if "S9_DATA_1M_STALE" in codes:
            return
        if codes & _S9_BREAKOUT_FAIL:
            return
        self.breakout_pass_count += 1
        if codes & _S9_VOLUME_FAIL:
            return
        self.volume_pass_count += 1
        if codes & _S9_CANDLE_FAIL:
            return
        self.candle_pass_count += 1
        if codes & _S9_ATR_FAIL:
            return
        self.atr_pass_count += 1
        if codes & _S9_STRUCTURE_FAIL:
            return
        self.structure_pass_count += 1

    def note_s9_candidate(self) -> None:
        self.candidate_count += 1

    def note_pending_created(self) -> None:
        self.pending_candidate_created_count += 1

    def note_pending_resumed(self) -> None:
        self.pending_candidate_resumed_count += 1

    def note_pending_expired(self) -> None:
        self.pending_candidate_expired_count += 1

    def note_pending_invalidated(self) -> None:
        self.pending_candidate_invalidated_count += 1

    def set_pending_live(
        self,
        *,
        active: bool,
        signal_key: str = "",
        closed_1m_id: Any = None,
        created_at_epoch_ms: Optional[float] = None,
        expires_at_epoch_ms: Optional[float] = None,
    ) -> None:
        self.pending_candidate_active = bool(active)
        self.pending_candidate_signal_key = str(signal_key or "") if active else ""
        self.pending_candidate_closed_1m_id = closed_1m_id if active else None
        self.pending_candidate_created_at_epoch_ms = created_at_epoch_ms if active else None
        self.pending_candidate_expires_at_epoch_ms = expires_at_epoch_ms if active else None

    def _pending_live_fields(self) -> Dict[str, Any]:
        from datetime import datetime, timezone

        active = bool(self.pending_candidate_active)
        age_ms = None
        expires_in_ms = None
        if active and self.pending_candidate_created_at_epoch_ms is not None:
            now_ms = datetime.now(timezone.utc).timestamp() * 1000.0
            age_ms = int(max(0.0, now_ms - float(self.pending_candidate_created_at_epoch_ms)))
            if self.pending_candidate_expires_at_epoch_ms is not None:
                expires_in_ms = int(float(self.pending_candidate_expires_at_epoch_ms) - now_ms)
        return {
            "pending_candidate_count": 1 if active else 0,
            "pending_candidate_active": active,
            "pending_candidate_signal_key": self.pending_candidate_signal_key if active else "",
            "pending_candidate_closed_1m_id": self.pending_candidate_closed_1m_id if active else None,
            "pending_candidate_age_ms": age_ms,
            "pending_candidate_expires_in_ms": expires_in_ms,
            "pending_candidate_created_count": self.pending_candidate_created_count,
            "pending_candidate_resumed_count": self.pending_candidate_resumed_count,
            "pending_candidate_expired_count": self.pending_candidate_expired_count,
            "pending_candidate_invalidated_count": self.pending_candidate_invalidated_count,
        }

    def note_s4_reject(self) -> None:
        self.S4_rejected_count += 1

    def note_cost_reject(self) -> None:
        self.cost_rejected_count += 1

    def note_intent_expired(self) -> None:
        self.trade_intent_expired_count += 1

    def note_order_intent(self) -> None:
        self.order_intent_created_count += 1
        self.order_intent_count += 1
        self.last_order_intent_at = _now_iso()

    def note_structure(self, payload: Optional[Dict[str, Any]]) -> None:
        self.last_structure = dict(payload or {})

    def note_executed(self) -> None:
        self.executed_count += 1

    def consume_log_event(self) -> Optional[Dict[str, Any]]:
        ev = self.pending_log_event
        self.pending_log_event = None
        return ev

    def _maybe_queue_log_event(self) -> None:
        from src.runtime.event_log_display import canonical_instrument_id

        reason = ",".join(sorted({str(c).strip() for c in self.last_reason_codes if str(c).strip()}))
        symbol = canonical_instrument_id(self.last_symbol) or str(self.last_symbol or "")
        key = (
            f"{self.strategy_id}|{symbol}|{self.last_closed_candle}|"
            f"{self.last_decision}|{reason}"
        )
        now = datetime.now(timezone.utc)
        if self.last_emit_key == key and self.last_closed_candle:
            return
        if self.last_emit_key == key and self.last_emit_at:
            try:
                prev = datetime.fromisoformat(self.last_emit_at.replace("Z", "+00:00"))
                if (now - prev).total_seconds() < 600:
                    return
            except Exception:
                pass
        self.last_emit_key = key
        self.last_emit_at = now.isoformat()
        event_type = "拒绝"
        if self.last_decision == "ALLOW":
            event_type = "信号" if self.last_direction != "NONE" else "候选"
        elif "CANDIDATE" in self.last_reason_codes or self.last_direction != "NONE":
            if self.last_decision != "ALLOW":
                event_type = "拒绝"
            else:
                event_type = "候选"
        self.pending_log_event = {
            "channel": "POSITION",
            "event_type": event_type,
            "strategy_id": self.strategy_id,
            "symbol": self.last_symbol,
            "direction": self.last_direction,
            "decision": self.last_decision,
            "reason_codes": list(self.last_reason_codes),
            "reason_code": self.last_reason_codes[0] if self.last_reason_codes else "",
            "source_closed_candle_timestamp": self.last_closed_candle,
            "ts": self.last_evaluated_at,
        }

    def to_dict(
        self,
        *,
        active: bool,
        runtime_state: str,
        alpha_opening_enabled: bool,
        last_tick_at: Optional[str],
        market_data: Optional[Dict[str, Any]] = None,
        indicators: Optional[Dict[str, Any]] = None,
        gates: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return {
            "strategy_id": self.strategy_id,
            "active": active,
            "runtime_state": runtime_state,
            "alpha_opening_enabled": alpha_opening_enabled,
            "last_tick_at": last_tick_at,
            "last_evaluated_at": self.last_evaluated_at,
            "evaluation_count": self.evaluation_count,
            "direction_pass_count": self.direction_pass_count,
            "s3_pass_count": self.s3_pass_count,
            "breakout_pass_count": self.breakout_pass_count,
            "volume_pass_count": self.volume_pass_count,
            "candle_pass_count": self.candle_pass_count,
            "atr_pass_count": self.atr_pass_count,
            "structure_pass_count": self.structure_pass_count,
            "candidate_count": self.candidate_count,
            **self._pending_live_fields(),
            "trade_intent_count": self.trade_intent_count,
            "order_intent_count": self.order_intent_count,
            "last_raw_signal_at": self.last_raw_signal_at,
            "last_trade_intent_at": self.last_trade_intent_at,
            "last_order_intent_at": self.last_order_intent_at,
            "raw_signal_count": self.raw_signal_count,
            "trade_intent_created_count": self.trade_intent_created_count,
            "trade_intent_expired_count": self.trade_intent_expired_count,
            "S3_rejected_count": self.S3_rejected_count,
            "S5_rejected_count": self.S5_rejected_count,
            "S6_rejected_count": self.S6_rejected_count,
            "S7_rejected_count": self.S7_rejected_count,
            "edge_rejected_count": self.edge_rejected_count,
            "S4_rejected_count": self.S4_rejected_count,
            "cost_rejected_count": self.cost_rejected_count,
            "order_intent_created_count": self.order_intent_created_count,
            "executed_count": self.executed_count,
            "last_decision": self.last_decision,
            "last_reason_codes": list(self.last_reason_codes),
            "market_data": market_data or {},
            "indicators": indicators or {},
            "gates": gates or {},
            "decision": {
                "direction_candidate": self.last_direction,
                "result": self.last_decision,
                "reason_codes": list(self.last_reason_codes),
            },
            "pending_log_event": self.pending_log_event,
            **self._structure_fields(),
        }

    def _structure_fields(self) -> Dict[str, Any]:
        if self.strategy_id != "S1" and not self.last_structure:
            return {}
        src = dict(self.last_structure or {})
        return {
            "structure_method": src.get("structure_method") or "CONFIRMED_SWING_2X2",
            "structure_lookback_bars": src.get("structure_lookback_bars", 20),
            "structure_invalidation_price": src.get("structure_invalidation_price"),
            "structure_invalidation_distance": src.get("structure_invalidation_distance"),
            "atr14": src.get("atr14"),
            "atr_stop_distance": src.get("atr_stop_distance"),
            "minimum_stop_distance": src.get("minimum_stop_distance"),
            "final_stop_distance": src.get("final_stop_distance"),
            "stop_price": src.get("stop_price"),
            "structure_candle_timestamp": src.get("structure_candle_timestamp"),
        }
