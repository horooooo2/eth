from .models import Event, HOUR


def quantile(values, q):
    ordered = sorted(values)
    at = (len(ordered)-1)*q
    lo = int(at)
    return ordered[lo] + (ordered[min(lo+1, len(ordered)-1)]-ordered[lo])*(at-lo)


def detect(hourly):
    by_symbol = {}
    for b in hourly:
        by_symbol.setdefault(b.symbol, {})[b.timestamp] = b
    events, diagnostics = [], []
    for symbol, history in sorted(by_symbol.items()):
        previous_detection = -10**18
        for t, b in sorted(history.items()):
            prior = [history.get(t-i*HOUR) for i in range(2161, 0, -1)]
            if any(x is None for x in prior):
                diagnostics.append(dict(symbol=symbol, timestamp=t, reason="HISTORY_GAP"))
                continue
            returns = [prior[i].close/prior[i-1].close-1 for i in range(1, len(prior))]
            atr_bars = prior[-21:]
            atr = sum(max(x.high-x.low, abs(x.high-p.close), abs(x.low-p.close))
                      for p, x in zip(atr_bars, atr_bars[1:]))/20
            r = b.close/prior[-1].close-1
            if atr <= 0 or abs(b.close-prior[-1].close) < 3*atr:
                continue
            up, down = quantile(returns, .995), quantile(returns, .005)
            direction = "UP" if r > 0 and r >= up else "DOWN" if r < 0 and r <= down else None
            if direction is None:
                continue
            detected = t+HOUR
            if detected-previous_detection < 2*HOUR:
                diagnostics.append(dict(symbol=symbol, timestamp=t, reason="COOLDOWN"))
                continue
            events.append(Event(f"{symbol}_{detected}_{direction}", symbol, direction, detected,
                                b.close, prior[-1].close, atr, up if direction == "UP" else down, r))
            previous_detection = detected
    return sorted(events, key=lambda e: (e.detected_at, e.symbol)), diagnostics
