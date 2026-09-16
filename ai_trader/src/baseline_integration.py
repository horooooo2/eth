"""Helpers to collect daily stats and persist baseline evolution."""
from __future__ import annotations

from typing import Any

from .db.repositories.baseline_repo import BaselineRepo
from .db.repositories.trauma_repo import TraumaRepo
from .person_state import PersonStateEngine, TRAIT_KEYS


def collect_daily_stats(
    *,
    daily_pnl: float,
    start_equity: float,
    equity: float,
    peak_equity: float,
    consecutive_losses: int,
    days_profitable_streak: int,
    days_losing_streak: int,
) -> dict[str, float]:
    """Build TraumaHandler recent_stats payload."""
    base = start_equity if start_equity else max(equity, 1.0)
    daily_pnl_pct = daily_pnl / base if base else 0.0
    peak = peak_equity if peak_equity > 0 else equity
    drawdown = 0.0 if peak <= 0 else max(0.0, (peak - equity) / peak)
    return {
        "daily_pnl_pct": float(daily_pnl_pct),
        "consecutive_losses": float(consecutive_losses),
        "drawdown_from_peak": float(drawdown),
        "days_profitable_streak": float(days_profitable_streak),
        "days_losing_streak": float(days_losing_streak),
    }


def apply_and_persist_evolution(
    person: PersonStateEngine,
    stats: dict[str, Any],
    *,
    date: str,
    timestamp: str,
    baseline_repo: BaselineRepo | None = None,
    trauma_repo: TraumaRepo | None = None,
) -> list[dict[str, Any]]:
    """Run evolve_baseline and optionally write DB rows."""
    changes = person.evolve_baseline(stats)
    if not changes:
        # Still snapshot baseline daily when evolution is enabled (for history)
        if person.evolver and baseline_repo is not None:
            baseline_repo.insert_snapshot(
                date,
                person.baseline_snapshot(),
                reason="daily_snapshot",
                detail=None,
            )
        return changes

    trauma_detail: list[dict[str, Any]] = []
    daily_detail: dict[str, Any] = {}
    for change in changes:
        if change.get("type") == "trauma":
            evt = change.get("event") or {}
            trauma_detail.append(evt)
            if trauma_repo is not None:
                trauma_repo.insert_event(
                    timestamp=timestamp,
                    event_type=str(evt.get("event_type") or "trauma"),
                    description=str(evt.get("description") or ""),
                    impact={
                        "impacts": evt.get("impacts"),
                        "applied": evt.get("applied"),
                        "baseline_after": {
                            k: evt.get("baseline_after", {}).get(k) for k in TRAIT_KEYS
                        },
                    },
                )
        elif change.get("type") == "daily_evolution":
            ch = change.get("change") or {}
            trait = ch.get("trait")
            if trait:
                daily_detail[trait] = {"old": ch.get("old"), "new": ch.get("new")}

    if baseline_repo is not None:
        reason = "trauma" if trauma_detail and not daily_detail else "daily_evolution"
        if trauma_detail and daily_detail:
            reason = "trauma+daily_evolution"
        detail: dict[str, Any] = {}
        if trauma_detail:
            detail["trauma"] = [
                {"event_type": e.get("event_type"), "impacts": e.get("impacts")} for e in trauma_detail
            ]
        if daily_detail:
            detail.update(daily_detail)
        baseline_repo.insert_snapshot(
            date,
            person.baseline_snapshot(),
            reason=reason,
            detail=detail or None,
        )
    return changes
