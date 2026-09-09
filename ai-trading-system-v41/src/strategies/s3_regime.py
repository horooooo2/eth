"""S3 market regime classifier."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Mapping, Optional

from src.core.rule_evaluator import RuleEvaluator

UTC_PLUS_8 = timezone(timedelta(hours=8))


class S3RegimeStrategy:
    def __init__(self, config: Mapping[str, Any], evaluator: RuleEvaluator) -> None:
        self.config = config
        self.cfg = config.get("S3_regime", {})
        self.evaluator = evaluator
        self._last_primary_date: Optional[str] = None
        self._last_panic_at: Optional[datetime] = None
        self.state: Dict[str, Any] = {
            "regime": self.cfg.get("fallback", {}).get("regime", "range"),
            "direction_bias": 0.0,
            "confidence": 0.5,
            "risk_multiplier": 1.0,
        }

    def _local_tz(self) -> timezone:
        tz_name = str(self.config.get("meta", {}).get("timezone", "UTC+8"))
        return UTC_PLUS_8 if "8" in tz_name else timezone.utc

    def should_run_primary(self, now: Optional[datetime] = None) -> bool:
        tz = self._local_tz()
        now = now or datetime.now(tz)
        if now.tzinfo is None:
            now = now.replace(tzinfo=tz)
        else:
            now = now.astimezone(tz)
        key = now.strftime("%Y-%m-%d")
        # Daily 00:05 window (minute >= 5 on first run of day or explicit)
        if self._last_primary_date != key and now.hour == 0 and now.minute >= 5:
            return True
        if self._last_primary_date is None:
            return True
        return False

    def emergency_override_needed(self, data_pool: Any) -> bool:
        ret = abs(float(data_pool.get("return_1m") or 0.0))
        rv_ratio = float(data_pool.get("rv5m_ratio_30d") or 1.0)
        # From requirements: >3% move or vol shock >2x
        return ret > 0.03 or rv_ratio > 2.0

    def evaluate(
        self,
        data_pool: Any,
        context: Dict[str, Any],
        *,
        force: bool = False,
        now: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        if not self.cfg.get("enabled", True):
            return self.state

        run = force or self.should_run_primary(now) or self.emergency_override_needed(data_pool)
        if not run:
            context.update(
                {
                    "S3.regime": self.state["regime"],
                    "S3.direction_bias": self.state["direction_bias"],
                    "S3.confidence": self.state["confidence"],
                    "S3.risk_multiplier": self.state["risk_multiplier"],
                }
            )
            data_pool.set_context(
                {
                    "S3.regime": self.state["regime"],
                    "S3.direction_bias": self.state["direction_bias"],
                    "S3.confidence": self.state["confidence"],
                    "S3.risk_multiplier": self.state["risk_multiplier"],
                    "S3": {
                        "regime": self.state["regime"],
                        "direction_bias": self.state["direction_bias"],
                        "confidence": self.state["confidence"],
                        "risk_multiplier": self.state["risk_multiplier"],
                    },
                }
            )
            return self.state

        ctx = dict(context)
        was_panic = False
        if self._last_panic_at is not None:
            was_panic = (datetime.now(timezone.utc) - self._last_panic_at) <= timedelta(hours=24)
        data_pool.set_context({"was_panic_within_last_24h": was_panic})
        ctx["was_panic_within_last_24h"] = was_panic

        priority = self.cfg.get("regime_rules_priority") or list(self.cfg.get("regime_rules", {}).keys())
        rules = self.cfg.get("regime_rules", {})
        regime = self.cfg.get("fallback", {}).get("regime", "range")
        for name in priority:
            rule = rules.get(name)
            if rule and bool(self.evaluator.evaluate(rule, ctx)):
                regime = name
                break

        if regime == "panic":
            self._last_panic_at = datetime.now(timezone.utc)

        # Direction bias from trend_direction / close vs emas
        td = float(data_pool.get("trend_direction") or 0.0)
        bias_map = self.cfg.get("direction_bias", {})
        if isinstance(bias_map, dict) and regime in bias_map:
            # may be formula strings; use numeric fallback
            direction_bias = float(td)
        else:
            direction_bias = max(-1.0, min(1.0, td))

        conf = float(data_pool.get("trend_strength") or 0.5)
        conf = max(0.0, min(1.0, conf))
        risk_mult_map = self.cfg.get("risk_multiplier_by_regime", {})
        risk_multiplier = float(risk_mult_map.get(regime, 1.0))

        self.state = {
            "regime": regime,
            "direction_bias": direction_bias,
            "confidence": conf,
            "risk_multiplier": risk_multiplier,
        }
        tz = self._local_tz()
        now = now or datetime.now(tz)
        self._last_primary_date = now.astimezone(tz).strftime("%Y-%m-%d")

        payload = {
            "S3.regime": regime,
            "S3.direction_bias": direction_bias,
            "S3.confidence": conf,
            "S3.risk_multiplier": risk_multiplier,
            "S3": dict(self.state),
        }
        context.update(payload)
        data_pool.set_context(payload)
        return self.state
