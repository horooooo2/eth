"""Pure-math news check trigger (no LLM)."""
from __future__ import annotations

import random
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Optional


def _parse_hhmm(value: str) -> tuple[int, int]:
    parts = str(value).strip().split(":")
    return int(parts[0]), int(parts[1]) if len(parts) > 1 else 0


def _in_window(now: datetime, start: str, end: str) -> bool:
    sh, sm = _parse_hhmm(start)
    eh, em = _parse_hhmm(end)
    minutes = now.hour * 60 + now.minute
    start_m = sh * 60 + sm
    end_m = eh * 60 + em
    if start_m <= end_m:
        return start_m <= minutes < end_m
    # wraps midnight (e.g. 23:00–02:00)
    return minutes >= start_m or minutes < end_m


def _eval_condition(condition: str, state: dict[str, Any], portfolio: dict[str, Any], recent: dict[str, Any]) -> bool:
    ctx = {
        "position_count": int(portfolio.get("position_count") or 0),
        "unrealized_pnl_pct": float(portfolio.get("unrealized_pnl_pct") or 0.0),
        "consecutive_losses": int(recent.get("consecutive_losses") or 0),
        "stress": float(state.get("stress") or 0.0),
        "hours_since_last_trade": float(recent.get("hours_since_last_trade") or 999.0),
        "days_to_major_macro_event": float(recent.get("days_to_major_macro_event") or 99.0),
        "recent_big_win_within_6h": bool(recent.get("recent_big_win_within_6h")),
        "sleep_debt": float(state.get("sleep_debt") or 0.0),
    }
    expr = (condition or "").strip()
    if not expr:
        return False
    # Safe subset: identifiers + comparisons only via eval with empty builtins
    try:
        return bool(eval(expr, {"__builtins__": {}}, ctx))  # noqa: S307
    except Exception:  # noqa: BLE001
        return False


def _context_tags(
    state: dict[str, Any],
    portfolio: dict[str, Any],
    recent: dict[str, Any],
    triggered: list[str],
) -> list[str]:
    tags: list[str] = []
    positions = portfolio.get("positions") or []
    if isinstance(positions, list):
        for pos in positions:
            if not isinstance(pos, dict):
                continue
            sym = str(pos.get("symbol") or "").upper()
            side = str(pos.get("side") or pos.get("direction") or "").lower()
            asset = "btc" if "BTC" in sym else "eth" if "ETH" in sym else ""
            if asset and side in ("long", "buy"):
                tags.append(f"holding_long_{asset}")
            elif asset and side in ("short", "sell"):
                tags.append(f"holding_short_{asset}")
    if int(portfolio.get("position_count") or 0) <= 0 and not tags:
        tags.append("no_position_watching")
    if "near_major_event" in triggered or float(recent.get("days_to_major_macro_event") or 99) <= 1:
        tags.append("before_major_event")
    if "recent_loss_streak" in triggered or int(recent.get("consecutive_losses") or 0) >= 3:
        tags.append("recent_loss")
    if bool(recent.get("after_big_move")):
        tags.append("after_big_move")
    if "high_stress" in triggered:
        tags.append("high_stress")
    # dedupe preserve order
    out: list[str] = []
    for t in tags:
        if t not in out:
            out.append(t)
    return out or ["no_position_watching"]


@dataclass
class NewsTrigger:
    news_behavior_config: dict[str, Any]
    random_seed: int | None = None
    _rng: random.Random = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._rng = random.Random(self.random_seed)

    def should_check(
        self,
        current_time: datetime,
        state: dict[str, Any],
        portfolio: dict[str, Any],
        recent_activity: dict[str, Any],
        daily_check_count: int,
        last_check_time: Optional[datetime],
    ) -> tuple[bool, dict[str, Any]]:
        cfg = self.news_behavior_config or {}
        freq = cfg.get("daily_frequency_limit") or {}
        max_checks = int(freq.get("max_checks_per_day") or 6)
        min_interval = int(freq.get("min_interval_minutes") or 90)

        empty = {
            "window": None,
            "triggered_modifiers": [],
            "final_probability": 0.0,
            "context_tags": [],
            "reason": "not_triggered",
        }

        if daily_check_count >= max_checks:
            empty["reason"] = "frequency_limit"
            return False, empty

        if last_check_time is not None:
            delta = current_time - last_check_time
            if delta < timedelta(minutes=min_interval):
                empty["reason"] = "min_interval"
                return False, empty

        windows = cfg.get("daily_windows") or {}
        active_window: str | None = None
        window_cfg: dict[str, Any] = {}
        for name, wcfg in windows.items():
            if not isinstance(wcfg, dict):
                continue
            tr = wcfg.get("time_range") or []
            if len(tr) != 2:
                continue
            if _in_window(current_time, str(tr[0]), str(tr[1])):
                active_window = str(name)
                window_cfg = wcfg
                break

        if not active_window:
            empty["reason"] = "outside_window"
            return False, empty

        base_p = float(window_cfg.get("base_probability") or 0.0)
        modifiers_cfg = cfg.get("state_modifiers") or {}
        triggered: list[str] = []
        mult = 1.0
        for name, mcfg in modifiers_cfg.items():
            if not isinstance(mcfg, dict):
                continue
            if _eval_condition(str(mcfg.get("condition") or ""), state, portfolio, recent_activity):
                triggered.append(str(name))
                mult *= float(mcfg.get("multiplier") or 1.0)

        final_p = max(0.0, min(1.0, base_p * mult))
        tags = _context_tags(state, portfolio, recent_activity, triggered)
        reason = {
            "window": active_window,
            "triggered_modifiers": triggered,
            "final_probability": final_p,
            "context_tags": tags,
            "reason": "probability_roll",
        }
        roll = self._rng.random()
        if roll <= final_p:
            reason["reason"] = "triggered"
            reason["roll"] = roll
            return True, reason
        reason["roll"] = roll
        return False, reason
