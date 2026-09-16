"""Three-month deadline state management."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import date, datetime
from typing import Any, Optional

from .pressure import compute_deadline_pressure


def _parse_date(value: str) -> date:
    text = str(value).strip()
    if "T" in text:
        text = text.split("T", 1)[0]
    return date.fromisoformat(text[:10])


@dataclass
class DeadlineState:
    enabled: bool
    start_date: str
    total_days: int
    current_day: int
    days_left: int
    pressure: float
    last_evaluation_day: Optional[int] = None
    evaluation_result: Optional[dict[str, Any]] = None
    extend_count: int = 0
    paused: bool = False
    next_evaluation_day: Optional[int] = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class DeadlineStateManager:
    """Track the three-month deadline clock and pressure."""

    config: dict[str, Any]
    card: dict[str, Any]
    start_date: str
    state: DeadlineState = field(init=False)

    def __post_init__(self) -> None:
        card_deadline = dict(self.card.get("deadline") or {})
        enabled = bool(self.config.get("enabled", True)) and bool(
            card_deadline.get("enabled", True)
        )
        total = int(
            card_deadline.get("total_days")
            or self.config.get("default_total_days")
            or 90
        )
        start = str(card_deadline.get("start_date") or self.start_date)
        self.state = DeadlineState(
            enabled=enabled,
            start_date=start[:10],
            total_days=total,
            current_day=0,
            days_left=total,
            pressure=0.0,
            next_evaluation_day=int(
                (self.config.get("evaluation") or {}).get("trigger_day") or total
            ),
        )
        self._curve = dict(self.config.get("pressure_curve") or {})
        self._cycle_start = _parse_date(self.state.start_date)

    def get_state(self) -> DeadlineState:
        return self.state

    def update(self, today: str) -> DeadlineState:
        """Refresh day counters and pressure for `today`."""
        if not self.state.enabled:
            return self.state
        today_d = _parse_date(today)
        elapsed = (today_d - self._cycle_start).days + 1
        self.state.current_day = max(1, elapsed)
        self.state.days_left = max(0, self.state.total_days - self.state.current_day)
        self.state.pressure = self.get_pressure()
        return self.state

    def get_pressure(self) -> float:
        if not self.state.enabled:
            return 0.0
        return compute_deadline_pressure(
            self.state.current_day,
            self.state.total_days,
            self._curve,
        )

    def is_evaluation_day(self, today: str) -> bool:
        if not self.state.enabled or self.state.paused:
            return False
        self.update(today)
        target = self.state.next_evaluation_day or self.state.total_days
        if self.state.last_evaluation_day == self.state.current_day:
            return False
        return self.state.current_day >= int(target)

    def apply_evaluation_result(self, result: dict[str, Any]) -> None:
        action = str(result.get("action") or "CONTINUE").upper()
        self.state.evaluation_result = dict(result)
        self.state.last_evaluation_day = self.state.current_day
        if action == "STOP":
            self.state.paused = True
        elif action == "EXTEND":
            days = result.get("new_deadline_days")
            if days is None:
                opts = list((self.config.get("evaluation") or {}).get("extend_options_days") or [30])
                days = opts[0]
            as_of = result.get("as_of") or result.get("today")
            self.extend_deadline(int(days), as_of=as_of)
        elif action == "CONTINUE":
            # Re-check in 7 days by default
            self.state.next_evaluation_day = self.state.current_day + 7
            self.state.total_days = max(self.state.total_days, self.state.next_evaluation_day)

    def extend_deadline(self, additional_days: int, as_of: str | None = None) -> None:
        """Extend and reset the pressure curve cycle."""
        extra = max(1, int(additional_days))
        self.state.extend_count += 1
        self.state.total_days = extra
        self.state.current_day = 1
        self.state.days_left = extra - 1
        self.state.pressure = 0.0
        self.state.paused = False
        self.state.next_evaluation_day = extra
        # Reset cycle start so pressure curve restarts
        if as_of:
            self._cycle_start = _parse_date(str(as_of))
        else:
            self._cycle_start = datetime.utcnow().date()
        self.state.start_date = self._cycle_start.isoformat()
