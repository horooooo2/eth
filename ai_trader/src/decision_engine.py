"""Decision engine: personality-adjusted threshold and position sizing."""
from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .behavior_classifier import BehaviorClassification
from .person_state import PersonState
from .signal_engine import Signal, clamp


@dataclass
class Decision:
    """Auditable open/skip decision for one signal."""

    action: str
    signal_score: float
    threshold: float
    position_multiplier: float
    decision_reason: dict[str, Any]
    rule_version: str
    timestamp: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


_CONT_KEY_RE = re.compile(
    r"^(?P<param>[a-z_]+)_(?P<op>below|above)_(?P<value>[0-9.]+)$"
)


@dataclass
class DecisionEngine:
    """Map signal + person state + behavior mode into an actionable decision."""

    config_path: Path
    config: dict[str, Any] = field(init=False)

    def __post_init__(self) -> None:
        self.config_path = Path(self.config_path)
        self.config = json.loads(self.config_path.read_text(encoding="utf-8"))

    def decide(
        self,
        signal: Signal,
        state: PersonState,
        behavior: BehaviorClassification,
    ) -> Decision:
        """Compute threshold, action, multiplier, and full decision_reason."""
        threshold, adjustments = self._compute_threshold(state, behavior)
        if signal.score >= threshold:
            action = f"OPEN_{signal.direction}"
        else:
            action = "SKIP"
        multiplier = self._compute_position_multiplier(state, behavior)
        reason = {
            "base_threshold": float(self.config["base_threshold"]),
            "behavior_mode": behavior.primary_mode,
            "modifiers": list(behavior.modifiers),
            "adjustments": adjustments,
            "final_threshold": threshold,
            "signal_score": signal.score,
            "signal_rule": signal.rule_name,
            "decision": action,
            "position_multiplier": multiplier,
        }
        return Decision(
            action=action,
            signal_score=float(signal.score),
            threshold=threshold,
            position_multiplier=multiplier,
            decision_reason=reason,
            rule_version=str(self.config.get("version", "0.0.0")),
            timestamp=datetime.now(timezone.utc).isoformat(),
        )

    def _compute_threshold(
        self,
        state: PersonState,
        behavior: BehaviorClassification,
    ) -> tuple[float, dict[str, float]]:
        """Return clamped threshold and per-source adjustments."""
        base = float(self.config["base_threshold"])
        clamp_lo, clamp_hi = self.config.get("threshold_clamp", [0.50, 0.90])
        adjustments: dict[str, float] = {}

        # Primary mode adjustment comes from BehaviorClassification (config-driven).
        adjustments["behavior"] = float(behavior.threshold_adjustment)

        mod_map = dict(self.config.get("modifier_adjustments") or {})
        adjustments["modifiers"] = float(
            sum(float(mod_map.get(m, 0.0)) for m in behavior.modifiers)
        )

        continuous = dict(self.config.get("continuous_adjustments") or {})
        for key, delta in continuous.items():
            if self._continuous_triggered(state, key):
                adjustments[key] = float(delta)

        total = sum(adjustments.values())
        threshold = clamp(base + total, float(clamp_lo), float(clamp_hi))
        return threshold, adjustments

    def _compute_position_multiplier(
        self,
        state: PersonState,
        behavior: BehaviorClassification,
    ) -> float:
        """Behavior mode sets direction; continuous traits fine-tune size."""
        factors = dict(self.config.get("position_factors") or {})
        base = float(factors.get(behavior.primary_mode, factors.get("NORMAL", 1.0)))
        tuning = dict(self.config.get("position_tuning") or {})
        risk_base = float(tuning.get("risk_component_base", 0.85))
        risk_scale = float(tuning.get("risk_component_scale", 0.30))
        fatigue_pen = float(tuning.get("fatigue_max_penalty", 0.20))
        fatigue_max = float(tuning.get("fatigue_max_sleep_debt", 8.0))

        risk_component = risk_base + float(state.risk_appetite) * risk_scale
        fatigue_modifier = 1.0 - min(float(state.sleep_debt) / fatigue_max, 1.0) * fatigue_pen
        multiplier = base * risk_component * fatigue_modifier
        lo, hi = self.config.get("position_clamp", [0.30, 1.50])
        return clamp(multiplier, float(lo), float(hi))

    @staticmethod
    def _continuous_triggered(state: PersonState, key: str) -> bool:
        match = _CONT_KEY_RE.match(key)
        if not match:
            return False
        param = match.group("param")
        op = match.group("op")
        value = float(match.group("value"))
        if not hasattr(state, param):
            # allow aliases like risk -> risk_appetite
            aliases = {"risk": "risk_appetite"}
            param = aliases.get(param, param)
        if not hasattr(state, param):
            return False
        current = float(getattr(state, param))
        if op == "below":
            return current < value
        if op == "above":
            return current > value
        return False
