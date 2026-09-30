from .models import Bar, Event, STEP


class Exhaustion:
    """Consume closed bars only. Mirroring is explicit at the input boundary."""

    def __init__(self, event: Event):
        self.event = event
        self.state = "EVENT_ACTIVE"
        self.extreme = event.trigger_close
        self.window = []
        self.level = None
        self.rebound = None
        self.previous_close = event.trigger_close
        self.signal_time = None
        self.trace = []

    def _log(self, b, old, reason=None):
        self.trace.append(dict(event_id=self.event.event_id, bar_open_time=b.timestamp,
                               known_at=b.timestamp + STEP, old_state=old, state=self.state,
                               reset_reason=reason, extreme=self.extreme, level=self.level))

    def advance(self, b: Bar):
        e = self.event
        if b.timestamp < e.detected_at or b.timestamp >= e.deadline or self.signal_time is not None:
            return
        old = self.state
        up = e.direction == "UP"
        high, low, close, previous = ((b.high, b.low, b.close, self.previous_close) if up
                                      else (-b.low, -b.high, -b.close, -self.previous_close))
        extreme = self.extreme if up else -self.extreme
        new_high = high > extreme
        invalid = new_high or (high == extreme and self.state in ("WAIT_REBOUND", "REBOUND_ACTIVE"))
        reason = None
        if invalid:
            reason = "NEW_EVENT_EXTREME" if new_high else "EQUAL_EVENT_EXTREME"
            extreme = max(extreme, high)
            self.state, self.window, self.level, self.rebound = "EVENT_ACTIVE", [], None, None
        extreme = max(extreme, high)
        self.extreme = extreme if up else -extreme
        if self.state == "EVENT_ACTIVE":
            if extreme - close >= 0.5 * e.atr:
                self.state, self.window = "PULLBACK_WINDOW", [low]
        elif self.state == "PULLBACK_WINDOW":
            self.window.append(low)
            if len(self.window) == 3:
                self.level, self.state = min(self.window), "WAIT_REBOUND"
        elif self.state == "WAIT_REBOUND":
            if close > previous and close > self.level:
                self.state, self.rebound = "REBOUND_ACTIVE", high
        elif self.state == "REBOUND_ACTIVE":
            self.rebound = max(self.rebound, high)
            if close < self.level and self.rebound < extreme:
                self.state, self.signal_time = "SIGNAL_CONFIRMED", b.timestamp + STEP
        self.previous_close = b.close
        self._log(b, old, reason)
