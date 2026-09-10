"""S9 engine-side exits: TP, time, direction flip. Protective stop stays ACTIVE."""

from __future__ import annotations

from typing import Any, Dict, Mapping, Optional

def _f(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default

PRIORITY = ("DIRECTION_FLIP", "TAKE_PROFIT", "TIME_EXIT")


def take_profit_price(*, side: str, avg_entry: float, initial_stop: float, r_mult: float = 1.5) -> float:
    if str(side).upper() == "LONG":
        r = avg_entry - initial_stop
        return avg_entry + r_mult * r
    r = initial_stop - avg_entry
    return avg_entry - r_mult * r


def tp_triggered(*, side: str, best_bid: float, best_ask: float, tp: float) -> bool:
    if str(side).upper() == "LONG":
        return best_bid >= tp
    return best_ask <= tp


def time_exit_due(*, first_fill_at_epoch: float, now_epoch: float, max_holding_minutes: float = 30) -> bool:
    return (now_epoch - first_fill_at_epoch) >= float(max_holding_minutes) * 60.0


def direction_flip_exit(*, side: str, prev_state: str, new_state: str) -> bool:
    if str(side).upper() == "LONG":
        return prev_state == "BULLISH" and new_state == "BEARISH"
    return prev_state == "BEARISH" and new_state == "BULLISH"


def pick_exit_reason(flags: Mapping[str, bool]) -> Optional[str]:
    for name in PRIORITY:
        if flags.get(name):
            return {
                "DIRECTION_FLIP": "S9_DIRECTION_FLIP_EXIT",
                "TAKE_PROFIT": "TAKE_PROFIT",
                "TIME_EXIT": "S9_TIME_EXIT",
            }[name]
    return None


def next_stop_coverage(*, owned: float, exit_fill: float) -> float:
    return max(0.0, float(owned) - float(exit_fill))


def ownership_released(
    *,
    owned_remaining: float,
    exchange_net: float,
    pending_opening: int,
    pending_exit: int,
    protective_nonterminal: int,
    reconciliation: str,
    qty_eps: float = 1e-12,
) -> bool:
    if abs(float(exchange_net)) > qty_eps:
        return False
    if abs(float(owned_remaining)) > qty_eps:
        return False
    if pending_opening or pending_exit or protective_nonterminal:
        return False
    return str(reconciliation).upper() == "MATCHED"


def dust_block(*, local_owned: float, exchange_net: float, qty_eps: float = 1e-12) -> Optional[str]:
    if abs(local_owned) <= qty_eps and abs(exchange_net) > qty_eps:
        return "DUST_RESIDUAL_POSITION"
    return None


def frequency_block(*, hour_count: int, day_count: int, max_hour: int = 6, max_day: int = 30) -> Optional[str]:
    if int(hour_count) >= int(max_hour):
        return "S9_TRADE_FREQUENCY_HOUR"
    if int(day_count) >= int(max_day):
        return "S9_TRADE_FREQUENCY_DAY"
    return None


def evaluate_owned_exit(
    *,
    side: str,
    best_bid: float,
    best_ask: float,
    avg_entry: float,
    initial_stop: float,
    first_fill_at_epoch: float,
    now_epoch: float,
    prev_direction: str,
    new_direction: str,
    max_holding_minutes: float = 30,
    r_mult: float = 1.5,
    pending_exit: bool = False,
) -> Optional[str]:
    """One nonterminal Engine exit. Protective stop stays ACTIVE."""
    if pending_exit:
        return None
    tp = take_profit_price(side=side, avg_entry=avg_entry, initial_stop=initial_stop, r_mult=r_mult)
    flags = {
        "DIRECTION_FLIP": direction_flip_exit(side=side, prev_state=prev_direction, new_state=new_direction),
        "TAKE_PROFIT": tp_triggered(side=side, best_bid=best_bid, best_ask=best_ask, tp=tp),
        "TIME_EXIT": time_exit_due(
            first_fill_at_epoch=first_fill_at_epoch,
            now_epoch=now_epoch,
            max_holding_minutes=max_holding_minutes,
        ),
    }
    return pick_exit_reason(flags)
