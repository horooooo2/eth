"""Behavior mode classifier driven by JSON rules."""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .person_state import PersonState


@dataclass
class BehaviorClassification:
    """Result of mapping continuous state onto a primary mode + modifiers."""

    primary_mode: str
    modifiers: list[str]
    confidence: float
    triggered_rules: list[str]
    rule_version: str
    threshold_adjustment: float

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _check_condition(state: PersonState | dict[str, float], cond: dict[str, Any]) -> bool:
    """Evaluate a single comparison condition against state."""
    param = str(cond["param"])
    op = str(cond["op"])
    threshold = float(cond["value"])
    value = float(state[param] if isinstance(state, dict) else getattr(state, param))
    if op == ">":
        return value > threshold
    if op == ">=":
        return value >= threshold
    if op == "<":
        return value < threshold
    if op == "<=":
        return value <= threshold
    if op == "==":
        return value == threshold
    raise ValueError(f"Unsupported operator: {op}")


def _all_conditions_met(
    state: PersonState | dict[str, float],
    conditions: list[dict[str, Any]],
) -> bool:
    return all(_check_condition(state, cond) for cond in conditions)


@dataclass
class BehaviorClassifier:
    """Load mode/modifier rules and classify a PersonState."""

    config_path: Path
    modes: dict[str, Any] = field(init=False)
    modifiers: dict[str, Any] = field(init=False)
    fallback: str = field(init=False)
    version: str = field(init=False)

    def __post_init__(self) -> None:
        self.config_path = Path(self.config_path)
        data = json.loads(self.config_path.read_text(encoding="utf-8"))
        self.modes = dict(data.get("modes") or {})
        self.modifiers = dict(data.get("modifiers") or {})
        self.fallback = str(data.get("fallback") or "NORMAL")
        self.version = str(data.get("version") or "0.0.0")

    def classify(self, state: PersonState | dict[str, float]) -> BehaviorClassification:
        matched: list[tuple[int, str]] = []
        for name, mode_def in self.modes.items():
            conditions = list(mode_def.get("conditions") or [])
            if _all_conditions_met(state, conditions):
                matched.append((int(mode_def.get("priority", 999)), name))

        matched.sort(key=lambda item: item[0])
        triggered = [name for _, name in matched]
        primary = matched[0][1] if matched else self.fallback

        mods: list[str] = []
        for mod_name, mod_def in self.modifiers.items():
            cond = mod_def.get("condition")
            if not cond:
                continue
            if _check_condition(state, cond) and mod_name != primary:
                mods.append(mod_name)

        if primary in self.modes:
            adjustment = float(self.modes[primary].get("threshold_adjustment", 0.0))
        else:
            adjustment = 0.0

        return BehaviorClassification(
            primary_mode=primary,
            modifiers=mods,
            confidence=1.0,
            triggered_rules=triggered,
            rule_version=self.version,
            threshold_adjustment=adjustment,
        )
