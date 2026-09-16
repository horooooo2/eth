"""Trauma events that jump-shift baseline outside daily evolution."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


def _check_condition(value: float, op: str, threshold: float) -> bool:
    if op == "<":
        return value < threshold
    if op == "<=":
        return value <= threshold
    if op == ">":
        return value > threshold
    if op == ">=":
        return value >= threshold
    if op == "==":
        return value == threshold
    if op == "!=":
        return value != threshold
    raise ValueError(f"unsupported condition op: {op}")


@dataclass
class TraumaHandler:
    """Detect trauma stats and apply discrete baseline impacts."""

    config_path: Path | str | dict[str, Any]
    baseline_bounds: dict[str, tuple[float, float] | list[float]]
    trauma_config: dict[str, Any] = field(init=False)
    _raw: dict[str, Any] = field(init=False, repr=False)

    def __post_init__(self) -> None:
        if isinstance(self.config_path, dict):
            self._raw = self.config_path
        else:
            self._raw = json.loads(Path(self.config_path).read_text(encoding="utf-8"))
        self.trauma_config = dict(self._raw.get("trauma_events") or {})
        self.baseline_bounds = {
            k: (float(v[0]), float(v[1])) for k, v in self.baseline_bounds.items()
        }

    def check_trauma(
        self,
        current_baseline: dict[str, float],
        recent_stats: dict[str, Any],
    ) -> tuple[dict[str, float], list[dict[str, Any]]]:
        """Return (new_baseline, trauma_events). Multiple events may stack."""
        new_baseline = {k: float(v) for k, v in current_baseline.items()}
        events: list[dict[str, Any]] = []

        for event_type, event_def in self.trauma_config.items():
            if not isinstance(event_def, dict):
                continue
            condition = dict(event_def.get("condition") or {})
            field_name = str(condition.get("field") or "")
            op = str(condition.get("op") or "")
            if field_name not in recent_stats:
                continue
            try:
                value = float(recent_stats[field_name])
                threshold = float(condition.get("value"))
            except (TypeError, ValueError):
                continue
            if not _check_condition(value, op, threshold):
                continue

            impacts = {str(k): float(v) for k, v in dict(event_def.get("impacts") or {}).items()}
            applied: dict[str, dict[str, float]] = {}
            for trait, delta in impacts.items():
                if trait not in new_baseline:
                    continue
                old = float(new_baseline[trait])
                new = old + delta
                lo, hi = self.baseline_bounds.get(trait, (new, new))
                new = max(float(lo), min(float(hi), new))
                new_baseline[trait] = new
                applied[trait] = {"old": old, "new": new, "delta": delta}

            events.append(
                {
                    "event_type": event_type,
                    "description": str(event_def.get("description") or event_type),
                    "impacts": impacts,
                    "applied": applied,
                    "trigger": {
                        "field": field_name,
                        "value": value,
                        "op": op,
                        "threshold": threshold,
                    },
                    "baseline_after": dict(new_baseline),
                }
            )

        return new_baseline, events
