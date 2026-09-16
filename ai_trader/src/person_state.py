"""Person psychological state engine: events, decay, clipping, baseline evolution, deadline."""
from __future__ import annotations

import json
import warnings
from copy import deepcopy
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any

TRAIT_BOUNDS: dict[str, tuple[float, float]] = {
    "risk_appetite": (0.15, 0.75),
    "patience": (0.20, 0.85),
    "focus": (0.20, 0.95),
    "self_doubt": (0.10, 0.80),
    "stubbornness": (0.20, 0.80),
    "stress": (0.00, 1.00),
    "sleep_debt": (0.0, 8.0),
    "news_awareness": (0.0, 1.0),
}

TRAIT_BASELINE: dict[str, float] = {
    "risk_appetite": 0.55,
    "patience": 0.50,
    "focus": 0.60,
    "self_doubt": 0.40,
    "stubbornness": 0.65,
    "stress": 0.30,
    "sleep_debt": 1.0,
    "news_awareness": 0.0,
}

# Traits that decay toward baseline each day (news_awareness resets separately)
DECAY_TRAIT_KEYS: tuple[str, ...] = (
    "risk_appetite",
    "patience",
    "focus",
    "self_doubt",
    "stubbornness",
    "stress",
    "sleep_debt",
)

TRAIT_KEYS: tuple[str, ...] = tuple(TRAIT_BASELINE.keys())

DEFAULT_BASELINE_BOUNDS: dict[str, tuple[float, float]] = {
    "risk_appetite": (0.30, 0.65),
    "patience": (0.40, 0.80),
    "focus": (0.35, 0.85),
    "self_doubt": (0.25, 0.65),
    "stubbornness": (0.20, 0.55),
    "stress": (0.15, 0.55),
    "sleep_debt": (0.5, 3.5),
}


@dataclass
class PersonState:
    """Continuous psychological parameters for the trader persona."""

    risk_appetite: float = TRAIT_BASELINE["risk_appetite"]
    patience: float = TRAIT_BASELINE["patience"]
    focus: float = TRAIT_BASELINE["focus"]
    self_doubt: float = TRAIT_BASELINE["self_doubt"]
    stubbornness: float = TRAIT_BASELINE["stubbornness"]
    stress: float = TRAIT_BASELINE["stress"]
    sleep_debt: float = TRAIT_BASELINE["sleep_debt"]
    news_awareness: float = TRAIT_BASELINE["news_awareness"]

    def to_dict(self) -> dict[str, float]:
        return {f.name: float(getattr(self, f.name)) for f in fields(self)}

    def copy(self) -> PersonState:
        return PersonState(**self.to_dict())


@dataclass
class EventImpacts:
    """Atomic and compound event deltas loaded from JSON."""

    version: str
    atomic_events: dict[str, dict[str, float]]
    compound_events: dict[str, dict[str, float]]

    @classmethod
    def from_json(cls, path: Path | str) -> EventImpacts:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls(
            version=str(data.get("version", "0.0.0")),
            atomic_events=dict(data.get("atomic_events") or {}),
            compound_events=dict(data.get("compound_events") or {}),
        )

    def get_impact(self, name: str, event_type: str) -> dict[str, float]:
        table = self.atomic_events if event_type == "atomic" else self.compound_events
        if name not in table:
            raise KeyError(f"Unknown {event_type} event: {name}")
        return {k: float(v) for k, v in table[name].items() if k in TRAIT_KEYS}


@dataclass
class PersonStateEngine:
    """Apply events, daily decay, and clip traits into bounded ranges."""

    config_path: Path
    state: PersonState | None = None
    decay_rate: float = 0.05
    baseline_evolution_config: Path | str | dict[str, Any] | None = None
    baseline_bounds: dict[str, Any] | None = None
    deadline_manager: Any = None
    ambient_sampler: Any = None
    impacts: EventImpacts = field(init=False)
    event_history: list[dict[str, Any]] = field(default_factory=list)
    baseline: dict[str, float] = field(init=False)
    state_history: list[dict[str, float]] = field(default_factory=list)
    deadline_pressure: float = 0.0
    evolver: Any = field(default=None, init=False, repr=False)
    trauma_handler: Any = field(default=None, init=False, repr=False)
    _initial: PersonState = field(init=False, repr=False)
    _trait_bounds: dict[str, tuple[float, float]] = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self.config_path = Path(self.config_path)
        self.impacts = EventImpacts.from_json(self.config_path)
        if self.state is None:
            self.state = PersonState()
        elif isinstance(self.state, dict):
            self.state = PersonState(**{k: float(self.state[k]) for k in TRAIT_KEYS if k in self.state})
        elif not isinstance(self.state, PersonState):
            raise TypeError(f"state must be PersonState or dict, got {type(self.state)}")
        self.baseline = {k: float(TRAIT_BASELINE[k]) for k in TRAIT_KEYS}
        self._initial = self.state.copy()
        self._trait_bounds = dict(TRAIT_BOUNDS)
        bounds_src = self.baseline_bounds or DEFAULT_BASELINE_BOUNDS
        normalized_bounds = {
            k: (float(v[0]), float(v[1])) for k, v in bounds_src.items() if k in TRAIT_KEYS
        }
        for k, v in DEFAULT_BASELINE_BOUNDS.items():
            normalized_bounds.setdefault(k, v)

        if self.baseline_evolution_config is not None:
            from .baseline_evolver import BaselineEvolver
            from .trauma_handler import TraumaHandler

            self.evolver = BaselineEvolver(self.baseline_evolution_config, normalized_bounds)
            self.trauma_handler = TraumaHandler(self.baseline_evolution_config, normalized_bounds)
        else:
            self.evolver = None
            self.trauma_handler = None
        self.deadline_pressure = 0.0
        self._clip(warn=False)

    def apply_events(self, events: list[dict[str, str]]) -> PersonState:
        """Apply a batch of atomic/compound events; compounds dedupe within batch."""
        applied_compounds: set[str] = set()
        for evt in events:
            name = str(evt["name"])
            event_type = str(evt.get("type", "atomic"))
            if event_type == "compound":
                if name in applied_compounds:
                    self.event_history.append(
                        {"name": name, "type": event_type, "skipped": "duplicate_compound"}
                    )
                    continue
                applied_compounds.add(name)
            delta = self.impacts.get_impact(name, event_type)
            self._apply_delta(delta)
            self.event_history.append({"name": name, "type": event_type, "delta": delta})
        self._clip(warn=True)
        return self.state

    def apply_conversation_impact(self, impacts: dict[str, float]) -> None:
        """Apply weak chat impacts directly to state (no event_history)."""
        self.apply_delta(impacts)

    def apply_delta(self, impacts: dict[str, float]) -> None:
        """
        Generic delta apply for news / chat.
        Unlike apply_events: does not append event_history.
        Caller is responsible for psychology_log writes.
        """
        self._apply_delta(impacts or {})
        self._clip(warn=True)

    def bump_news_awareness(self, amount: float = 0.3) -> float:
        """Increase day's news awareness, capped at 1.0."""
        if self.state is None:
            return 0.0
        cur = float(getattr(self.state, "news_awareness", 0.0) or 0.0)
        self.state.news_awareness = min(1.0, cur + float(amount))
        self._clip(warn=False)
        return float(self.state.news_awareness)

    def reset_news_awareness(self) -> None:
        """Reset daily news awareness to 0."""
        if self.state is None:
            return
        self.state.news_awareness = 0.0

    def reset_news_awareness_daily(self) -> None:
        self.reset_news_awareness()

    def apply_daily_ambient_events(self, today: str) -> list[dict[str, Any]]:
        """Sample and apply ambient friction events for the day."""
        if not self.ambient_sampler:
            return []
        events = self.ambient_sampler.sample_today(day=today)
        for evt in events:
            impacts = dict(evt.get("impacts") or {})
            self._apply_delta(impacts)
            self.event_history.append(
                {
                    "type": "ambient",
                    "name": evt.get("name"),
                    "timestamp": evt.get("timestamp"),
                    "delta": impacts,
                }
            )
        if events:
            self._clip(warn=True)
        return events

    def update_deadline(self, today: str) -> Any:
        """Update deadline clock and refresh deadline_pressure."""
        if not self.deadline_manager:
            return None
        state = self.deadline_manager.update(today)
        self.deadline_pressure = float(getattr(state, "pressure", 0.0) or 0.0)
        return state

    def daily_decay(self) -> PersonState:
        """Move each trait toward baseline; stress target includes deadline_pressure."""
        for key in DECAY_TRAIT_KEYS:
            current = float(getattr(self.state, key))
            baseline = float(self.baseline.get(key, TRAIT_BASELINE[key]))
            target = baseline
            if key == "stress" and self.deadline_pressure > 0:
                target = baseline + float(self.deadline_pressure)
            updated = current + (target - current) * self.decay_rate
            setattr(self.state, key, updated)
        # news_awareness is same-day memory of having checked news — reset daily
        self.reset_news_awareness_daily()
        self._clip(warn=True)
        self.event_history.append({"name": "DAILY_DECAY", "type": "system", "rate": self.decay_rate})
        return self.state

    def evolve_baseline(self, recent_stats: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        if not self.evolver or not self.trauma_handler:
            return []

        recent_stats = recent_stats or {}
        self.state_history.append(self.snapshot())
        window = int(self.evolver.config.window_days)
        if len(self.state_history) > window:
            self.state_history = self.state_history[-window:]

        all_changes: list[dict[str, Any]] = []
        new_baseline, trauma_events = self.trauma_handler.check_trauma(self.baseline, recent_stats)
        for evt in trauma_events:
            all_changes.append({"type": "trauma", "event": evt})
        self.baseline = new_baseline

        if len(self.state_history) >= window:
            new_baseline, daily_changes = self.evolver.evolve(self.baseline, self.state_history)
            for ch in daily_changes:
                all_changes.append({"type": "daily_evolution", "change": ch})
            self.baseline = new_baseline

        return all_changes

    def set_baseline(self, baseline: dict[str, float]) -> None:
        self.baseline = {k: float(baseline.get(k, TRAIT_BASELINE[k])) for k in TRAIT_KEYS}

    def set_trait_bounds(self, bounds: dict[str, Any]) -> None:
        for k, v in bounds.items():
            if k in TRAIT_KEYS:
                self._trait_bounds[k] = (float(v[0]), float(v[1]))

    def snapshot(self) -> dict[str, float]:
        return self.state.to_dict()

    def baseline_snapshot(self) -> dict[str, float]:
        return dict(self.baseline)

    def reset(self) -> PersonState:
        self.state = self._initial.copy()
        self.event_history.clear()
        self.state_history.clear()
        self.baseline = {k: float(getattr(self._initial, k)) for k in TRAIT_KEYS}
        self.deadline_pressure = 0.0
        self._clip(warn=False)
        return self.state

    def _apply_delta(self, delta: dict[str, float]) -> None:
        for key, value in delta.items():
            if key not in TRAIT_KEYS:
                continue
            setattr(self.state, key, float(getattr(self.state, key)) + float(value))

    def _clip(self, warn: bool = True) -> None:
        for key, (lo, hi) in self._trait_bounds.items():
            value = float(getattr(self.state, key))
            clipped = min(max(value, lo), hi)
            if warn and clipped != value:
                warnings.warn(
                    f"trait boundary hit: {key} {value:.3f} -> {clipped:.3f} [{lo}, {hi}]",
                    stacklevel=2,
                )
            setattr(self.state, key, clipped)
