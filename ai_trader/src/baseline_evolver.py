"""Daily baseline evolution (slow personality drift)."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class EvolutionConfig:
    window_days: int = 14
    min_gap_threshold: float = 0.03
    max_daily_step: float = 0.01
    step_ratio: float = 0.15
    run_time: str = "23:59"
    enabled: bool = True


@dataclass
class BaselineEvolver:
    """Move baseline slowly toward recent state averages."""

    config_path: Path | str | dict[str, Any]
    baseline_bounds: dict[str, tuple[float, float] | list[float]]
    config: EvolutionConfig = field(init=False)
    _raw: dict[str, Any] = field(init=False, repr=False)

    def __post_init__(self) -> None:
        if isinstance(self.config_path, dict):
            self._raw = self.config_path
        else:
            self._raw = json.loads(Path(self.config_path).read_text(encoding="utf-8"))
        evo = dict(self._raw.get("evolution") or {})
        self.config = EvolutionConfig(
            window_days=int(evo.get("window_days", 14)),
            min_gap_threshold=float(evo.get("min_gap_threshold", 0.03)),
            max_daily_step=float(evo.get("max_daily_step", 0.01)),
            step_ratio=float(evo.get("step_ratio", 0.15)),
            run_time=str(evo.get("run_time", "23:59")),
            enabled=bool(self._raw.get("enabled", True)),
        )
        self.baseline_bounds = {
            k: (float(v[0]), float(v[1])) for k, v in self.baseline_bounds.items()
        }

    def evolve(
        self,
        current_baseline: dict[str, float],
        recent_states: list[dict[str, float]],
    ) -> tuple[dict[str, float], list[dict[str, Any]]]:
        """Evolve once; returns (new_baseline, changes)."""
        if not self.config.enabled or not recent_states:
            return dict(current_baseline), []

        changes: list[dict[str, Any]] = []
        new_baseline = {k: float(v) for k, v in current_baseline.items()}

        for trait in list(current_baseline.keys()):
            recent_values = [
                float(s[trait]) for s in recent_states if trait in s and s[trait] is not None
            ]
            if not recent_values:
                continue
            recent_avg = sum(recent_values) / len(recent_values)
            gap = self._compute_gap(float(current_baseline[trait]), recent_avg)
            if abs(gap) < self.config.min_gap_threshold:
                continue
            step = self._compute_step(gap)
            direction = 1.0 if gap > 0 else -1.0
            new_value = float(current_baseline[trait]) + direction * step
            new_value = self._clamp_to_baseline_bounds(trait, new_value)
            old = float(current_baseline[trait])
            if abs(new_value - old) > 1e-6:
                changes.append(
                    {
                        "trait": trait,
                        "old": old,
                        "new": new_value,
                        "reason": "daily_evolution",
                        "gap": gap,
                        "recent_avg": recent_avg,
                    }
                )
                new_baseline[trait] = new_value

        return new_baseline, changes

    def _compute_gap(self, current: float, recent_avg: float) -> float:
        return recent_avg - current

    def _compute_step(self, gap: float) -> float:
        return min(self.config.max_daily_step, abs(gap) * self.config.step_ratio)

    def _clamp_to_baseline_bounds(self, trait: str, value: float) -> float:
        bounds = self.baseline_bounds.get(trait)
        if not bounds:
            return value
        lo, hi = float(bounds[0]), float(bounds[1])
        return max(lo, min(hi, value))
