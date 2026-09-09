"""S6 anomaly detection with leveled circuit breakers."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Mapping, Optional

from src.core.rule_evaluator import RuleEvaluator


class S6AnomalyDetector:
    def __init__(self, config: Mapping[str, Any], evaluator: RuleEvaluator) -> None:
        self.config = config
        self.cfg = config.get("S6_anomaly", {})
        self.evaluator = evaluator
        self.level = int(self.cfg.get("level", 0) or 0)
        self._stable_since: Optional[datetime] = None
        self._hard_events: List[str] = []
        self._manual_resume_required = False
        self.interval = float(self.cfg.get("evaluation_interval_seconds", 5))

    def evaluate_signals(self, data_pool: Any, context: Dict[str, Any]) -> Dict[str, Any]:
        if not self.cfg.get("enabled", True):
            context["S6.level"] = 0
            return {"level": 0, "signals": {}}

        signals_cfg = self.cfg.get("signals", {})
        signal_levels: Dict[str, int] = {}
        ctx = dict(context)

        for name, spec in signals_cfg.items():
            lvl = 0
            if isinstance(spec, dict):
                # Prefer explicit conditions; else heuristic thresholds from nested levels
                if "conditions" in spec or "logic" in spec or "op" in spec:
                    if bool(self.evaluator.evaluate(spec, ctx)):
                        lvl = int(spec.get("level", 2))
                else:
                    # level ladders keyed by threshold names
                    for key, val in spec.items():
                        if not isinstance(val, dict):
                            continue
                        cond = val.get("condition") or val
                        try:
                            triggered = bool(self.evaluator.evaluate(cond, ctx)) if isinstance(cond, dict) else False
                        except Exception:
                            triggered = False
                        if triggered:
                            lvl = max(lvl, int(val.get("level", key if str(key).isdigit() else 1)))
                    # Heuristic fallbacks by signal name
                    if lvl == 0:
                        lvl = self._heuristic_level(name, data_pool)
            signal_levels[name] = int(lvl)

        hard_level = 3 if self._hard_events else 0
        agg_levels = list(signal_levels.values()) + ([hard_level] if hard_level else [])
        level = max(agg_levels) if agg_levels else 0
        if self._manual_resume_required:
            level = max(level, 3)

        # Auto resume step-down for market anomalies only
        if not self._manual_resume_required and not self._hard_events:
            level = self._maybe_step_down(level, data_pool, ctx)
        else:
            self._stable_since = None

        self.level = int(level)
        actions = self.cfg.get("actions_by_level", {}).get(str(self.level)) or self.cfg.get(
            "actions_by_level", {}
        ).get(self.level, {})
        payload = {
            "S6.level": self.level,
            "S6": {
                "level": self.level,
                "signals": signal_levels,
                "actions": actions,
                "manual_resume_required": self._manual_resume_required,
                "hard_events": list(self._hard_events),
            },
        }
        context.update(payload)
        data_pool.set_context(payload)
        return payload["S6"]

    def _heuristic_level(self, name: str, data_pool: Any) -> int:
        if name == "flash_move":
            r = abs(float(data_pool.get("return_1m") or 0.0))
            if r >= 0.03:
                return 3
            if r >= 0.015:
                return 2
            if r >= 0.01:
                return 1
        if name == "volatility_shock":
            rv = float(data_pool.get("rv5m_ratio_30d") or 1.0)
            if rv >= 3.0:
                return 3
            if rv >= 2.0:
                return 2
            if rv >= 1.5:
                return 1
        if name == "spread_shock":
            spread = float(data_pool.get("spread_bps") or 0.0)
            p99 = float(data_pool.get("rolling_30d_spread_bps_p99") or 25.0)
            if spread >= p99:
                return 2
            if spread >= float(data_pool.get("rolling_30d_spread_bps_p80") or 8.0):
                return 1
        if name == "liquidity_vacuum":
            depth = float(data_pool.get("top_book_depth") or 1e9)
            p20 = float(data_pool.get("rolling_30d_depth_p20") or 0.0)
            if depth < p20 * 0.5:
                return 3
            if depth < p20:
                return 2
        if name == "market_data_stale":
            stale = float(data_pool.get("market_data_stale_ms") or 0.0)
            if stale >= 1000:
                return 3
            if stale >= 500:
                return 2
            if stale >= 250:
                return 1
        return 0

    def _maybe_step_down(self, current_level: int, data_pool: Any, ctx: Dict[str, Any]) -> int:
        recovery = self.cfg.get("recovery", {}).get("market_anomaly_auto_resume", {})
        conditions = recovery.get("conditions")
        ok = True
        if conditions:
            ok = bool(self.evaluator.evaluate({"logic": "and", "conditions": conditions}, ctx))
        else:
            ok = (
                float(data_pool.get("rv5m_ratio_30d") or 99) <= 1.5
                and float(data_pool.get("spread_bps") or 99)
                <= float(data_pool.get("rolling_30d_spread_bps_p80") or 8)
                and bool(data_pool.get("sequence_valid", True))
                and bool(data_pool.get("exchange_connected", True))
            )
        now = datetime.now(timezone.utc)
        if not ok:
            self._stable_since = None
            return current_level
        if self._stable_since is None:
            self._stable_since = now
        elapsed_min = (now - self._stable_since).total_seconds() / 60.0
        steps = recovery.get("step_down_state_machine", [])
        level = current_level
        for step in steps:
            if int(step.get("from", -1)) == level:
                need = float(step.get("after_conditions_pass_minutes", 0))
                if elapsed_min >= need:
                    level = int(step.get("to", level))
                    self._stable_since = now
                break
        return level

    def raise_hard_event(self, event_name: str) -> None:
        hard = set(self.cfg.get("hard_level_3_system_events", []))
        if event_name in hard or True:
            if event_name not in self._hard_events:
                self._hard_events.append(event_name)
            self._manual_resume_required = True
            self.level = 3

    def manual_resume(
        self,
        *,
        operator_id: str,
        reason: str,
        preconditions_ok: bool,
        audit_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
        new_level: int = 0,
    ) -> Dict[str, Any]:
        previous = self.level
        if not preconditions_ok:
            return {"ok": False, "error": "preconditions_failed", "level": self.level}
        if not self._manual_resume_required and not self._hard_events:
            return {"ok": False, "error": "manual_resume_not_required", "level": self.level}
        self._hard_events.clear()
        self._manual_resume_required = False
        self.level = int(new_level)
        self._stable_since = datetime.now(timezone.utc)
        record = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "operator_id": operator_id,
            "reason": reason,
            "previous_level": previous,
            "new_level": self.level,
        }
        if audit_callback:
            audit_callback(record)
        return {"ok": True, **record}

    def poll_loop_once(self, data_pool: Any, context: Dict[str, Any]) -> Dict[str, Any]:
        """Single 5s-interval evaluation entrypoint."""
        return self.evaluate_signals(data_pool, context)
