"""Deadline / ambient day-start helpers shared by replay and live scheduler."""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Optional

from .ambient.sampler import AmbientSampler
from .deadline.evaluator import DeadlineEvaluator
from .deadline.state import DeadlineState, DeadlineStateManager

logger = logging.getLogger(__name__)


def load_deadline_config(config_dir: Path) -> dict[str, Any]:
    path = Path(config_dir) / "deadline_config.json"
    if not path.exists():
        return {"enabled": False, "ambient": {}, "evaluation": {}, "pressure_curve": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def build_deadline_stack(
    config_dir: Path,
    card: dict[str, Any],
    start_date: str,
    *,
    random_state: int | None = None,
) -> tuple[dict[str, Any], DeadlineStateManager | None, AmbientSampler | None]:
    """Return (config, deadline_manager, ambient_sampler)."""
    cfg = load_deadline_config(config_dir)
    if not cfg.get("enabled", True):
        return cfg, None, None
    card_dl = dict(card.get("deadline") or {})
    if card_dl and card_dl.get("enabled") is False:
        return cfg, None, None
    manager = DeadlineStateManager(cfg, card, start_date=start_date[:10])
    sampler = AmbientSampler(cfg, card)
    if random_state is not None:
        import random as _random

        sampler._rng = _random.Random(random_state)
    return cfg, manager, sampler


def process_new_day(
    *,
    today: str,
    person: Any,
    deadline_repo: Any | None = None,
    ambient_repo: Any | None = None,
    narrator_bridge: Any | None = None,
    behavior: dict[str, Any] | None = None,
    recent_events: list[str] | None = None,
) -> tuple[Optional[DeadlineState], list[dict[str, Any]]]:
    """
    Daily order: update_deadline → apply_daily_ambient_events.
    Caller still runs daily_decay / evolution afterwards.
    """
    deadline_state = person.update_deadline(today)
    if deadline_state is not None and deadline_repo is not None:
        deadline_repo.insert_snapshot(deadline_state, date=today[:10])

    events = person.apply_daily_ambient_events(today)
    if events and ambient_repo is not None:
        ambient_repo.insert_events(events)
    if events and narrator_bridge is not None:
        beh = behavior or {}
        recent = list(recent_events or [])
        for evt in events:
            narrator_bridge.on_event(evt, person.snapshot(), beh, recent + [str(evt.get("name"))])
    return deadline_state, events


def maybe_run_deadline_evaluation(
    *,
    today: str,
    person: Any,
    deadline_manager: DeadlineStateManager | None,
    deadline_config: dict[str, Any],
    narrator: Any,
    deadline_repo: Any | None,
    db_repos: dict[str, Any],
    starting_baseline: dict[str, Any],
    pause_trading: Any | None = None,
    stats: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Run evaluation if today is an evaluation day. Never raises."""
    if not deadline_manager or not person.deadline_manager:
        return None
    try:
        if not deadline_manager.is_evaluation_day(today):
            return None
        evaluator = DeadlineEvaluator(
            deadline_config,
            narrator,
            db_repos,
            deadline_manager=deadline_manager,
        )
        collected = stats or evaluator._collect_stats(db_repos)
        result = evaluator.evaluate(
            deadline_state=deadline_manager.get_state(),
            stats=collected,
            state_snapshot=person.snapshot(),
            starting_baseline=starting_baseline,
            current_baseline=person.baseline_snapshot(),
            today=today[:10],
        )
        person.deadline_pressure = float(deadline_manager.get_state().pressure)
        state = deadline_manager.get_state()
        if deadline_repo is not None:
            deadline_repo.insert_snapshot(
                state,
                date=today[:10],
                evaluation_action=result.get("action"),
                evaluation_reason=result.get("reason"),
                new_deadline_days=result.get("new_deadline_days"),
            )
        action = str(result.get("action") or "CONTINUE").upper()
        if action == "STOP":
            logger.info("deadline evaluation STOP — pausing trading")
            if pause_trading:
                pause_trading()
        elif action == "EXTEND":
            logger.info(
                "deadline evaluation EXTEND %s days",
                result.get("new_deadline_days"),
            )
        return result
    except Exception as exc:  # noqa: BLE001
        logger.warning("deadline evaluation hook failed: %s", exc)
        return {
            "action": "CONTINUE",
            "reason": "评估钩子失败，默认继续",
            "new_deadline_days": None,
            "narrative": {},
        }
