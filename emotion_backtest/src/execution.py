from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR
from .models import Config, Meta, Event


def grid(value, step, upward=False):
    return float((Decimal(str(value)) / Decimal(str(step))).to_integral_value(
        rounding=ROUND_CEILING if upward else ROUND_FLOOR) * Decimal(str(step)))


def market_fill(price, buy, bps, meta):
    return grid(price * (1 + (1 if buy else -1) * bps / 10_000), meta.tick_size, buy)


def plan(event: Event, price: float, maker: bool, c: Config, m: Meta):
    long = event.sign == 1
    entry = price if maker else market_fill(price, long, c.actual_entry_slippage_bps, m)
    stop = grid(entry - event.sign * event.atr, m.tick_size, not long)
    target = grid(entry + event.sign * event.atr, m.tick_size, not long)
    if min(entry, stop, target) <= 0 or event.sign * (target-entry) <= 0 or event.sign * (entry-stop) <= 0:
        return None
    planned_stop = market_fill(stop, not long, c.sizing_stop_slippage_bps, m)
    entry_rate = (c.maker_fee_bps if maker else c.taker_fee_bps) / 10_000
    loss = event.sign * (entry - planned_stop) + entry * entry_rate + planned_stop * c.taker_fee_bps / 10_000
    if loss <= 0:
        return None
    qty = grid(c.risk_budget_usdt / loss, m.qty_step)
    if qty <= 0 or qty < m.min_qty or qty * entry < m.min_notional:
        return None
    return dict(entry=entry, stop=stop, target=target, qty=qty, entry_fee=qty*entry*entry_rate,
                planned_loss_usdt=qty*loss)


def exit_touch(b, p, sign, allow_target=True, allow_open=True):
    """Gap precedes intrabar; return reference, reason, ambiguity."""
    stop, target = p["stop"], p["target"]
    if allow_open:
        if (b.open <= stop if sign == 1 else b.open >= stop):
            return b.open, "STOP", False
        if allow_target and (b.open >= target if sign == 1 else b.open <= target):
            return b.open, "TARGET", False
    stop_hit = b.low <= stop if sign == 1 else b.high >= stop
    target_hit = b.high >= target if sign == 1 else b.low <= target
    if stop_hit:
        return stop, "STOP", bool(target_hit and allow_target)
    if target_hit and allow_target:
        return target, "TARGET", False
    return None
