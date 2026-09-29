// Pure strategy decisions shared by live TradFi strategy and local replay.
// Keep this module free of database, exchange, clock, and network dependencies.
(function attach(root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  root.TradfiRangeCore = core;
})(globalThis, function createCore() {
  const MAX_LONG_ADDITIONS = 100;
  const MAX_SHORT_ADDITIONS = 20;
  const SYMBOL_DEFAULTS = Object.freeze({
    XAUUSDT: Object.freeze({ marginUsdt: 20, leverage: 20, ladder: Object.freeze([10, 15, 25, 30]) }),
    XAGUSDT: Object.freeze({ marginUsdt: 10, leverage: 10, ladder: Object.freeze([5, 7.5, 12.5, 15]) }),
  });
  const MIN_STEP_PCT = 0.0008;
  const MAX_STEP_PCT = 0.0035;
  const SPARSE_MAX_STEP_PCT = 0.007;
  const ATR_MULTIPLIER = 0.6;
  const SPARSE_ATR_MULTIPLIER = 0.3;
  const SPARSE_NORMAL_STEP_MULTIPLIER = 1.5;
  const SPARSE_GROUP_SIZE = 5;
  const DEEP_LONG_LEVELS = Object.freeze([0.12, 0.22, 0.25]);
  const DEEP_LONG_SHARES = Object.freeze([0.22, 0.35, 0.43]);
  const SPARSE_ENTER_ATR_DISTANCE = 2;
  const SPARSE_EXIT_ATR_DISTANCE = 1.5;
  const TREND_CONFIRM_BARS = 3;
  const SHORT_PROTECTION_RELEASE_BARS = 6;
  const SCALP_MIN_PROFIT = 0.4;
  const SCALP_NOTIONAL_RATE = 0.0002;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  function ema(values, period) {
    const k = 2 / (period + 1); let out = values[0];
    for (let i = 1; i < values.length; i += 1) out = values[i] * k + out * (1 - k);
    return out;
  }
  function atr(rows, period = 20) {
    const window = rows.slice(-(period + 1));
    if (window.length < period + 1) throw new Error('K线数据不足');
    let total = 0;
    for (let i = 1; i < window.length; i += 1) {
      const high = Number(window[i][2]); const low = Number(window[i][3]); const previousClose = Number(window[i - 1][4]);
      total += Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
    }
    return total / period;
  }
  function defaultConfig(symbol) { return SYMBOL_DEFAULTS[symbol] || SYMBOL_DEFAULTS.XAUUSDT; }
  function ladderMargin(symbol, additionNumber, initialMargin = defaultConfig(symbol).marginUsdt) {
    const level = Math.max(1, Number(additionNumber) || 1);
    const defaults = defaultConfig(symbol);
    const tier = defaults.ladder[Math.min(3, Math.floor((level - 1) / 10))];
    const base = Number(initialMargin);
    return tier * (Number.isFinite(base) && base > 0 ? base / defaults.marginUsdt : 1);
  }
  function sideAdditions(state) {
    const long = Number(state?.longAdditions); const short = Number(state?.shortAdditions);
    return { longAdditions: Number.isFinite(long) && long > 0 ? long : 0, shortAdditions: Number.isFinite(short) && short > 0 ? short : 0 };
  }
  function additionDecision(state, longLosing) {
    const counts = sideAdditions(state);
    const sideCount = longLosing ? counts.longAdditions : counts.shortAdditions;
    const sideMax = longLosing ? MAX_LONG_ADDITIONS : MAX_SHORT_ADDITIONS;
    if (sideCount >= sideMax) return { action: 'wait', ...counts };
    return { action: 'add', side: longLosing ? 'long' : 'short', next: sideCount + 1, ...counts };
  }
  function countedAdditions(state, isLong, increment) {
    const counts = sideAdditions(state); const amount = Math.max(0, Number(increment) || 0);
    const longAdditions = counts.longAdditions + (isLong ? amount : 0);
    const shortAdditions = counts.shortAdditions + (!isLong ? amount : 0);
    return { longAdditions, shortAdditions, total: longAdditions + shortAdditions, next: isLong ? longAdditions : shortAdditions };
  }
  function ladderStep(last, atrValue) { return clamp(atrValue * ATR_MULTIPLIER, last * MIN_STEP_PCT, last * MAX_STEP_PCT); }
  function sparseLadderStep(last, normalStep, atr1h) {
    const candidate = Math.max(Number(normalStep) || 0, (Number(normalStep) || 0) * SPARSE_NORMAL_STEP_MULTIPLIER, (Number(atr1h) || 0) * SPARSE_ATR_MULTIPLIER);
    return Math.min(Number(last) * SPARSE_MAX_STEP_PCT, candidate);
  }
  function sparseModeDecision({ active = false, side, entryPrice, price, atr1h, trendDirection, trendBars, trendWeakBars }) {
    const atrValue = Number(atr1h) || 0;
    const distance = side === 'long' ? Number(entryPrice) - Number(price) : Number(price) - Number(entryPrice);
    const adverseDirection = side === 'long' ? 'down' : 'up';
    const adverseTrend = trendDirection === adverseDirection && Number(trendBars) >= TREND_CONFIRM_BARS;
    const enter = atrValue > 0 && distance >= atrValue * SPARSE_ENTER_ATR_DISTANCE && adverseTrend;
    const exit = atrValue > 0 && distance <= atrValue * SPARSE_EXIT_ATR_DISTANCE && Number(trendWeakBars) >= TREND_CONFIRM_BARS;
    return { active: active ? !exit : enter, enter, exit, distance: Math.max(0, distance), distanceAtr: atrValue > 0 ? Math.max(0, distance) / atrValue : 0 };
  }
  function shortTrendProtectionDecision(active, market) {
    if (!market?.dataFresh) return { active: Boolean(active), entered: false, exited: false };
    const rising = market.trendDirection === 'up' && Number(market.trendBars) >= TREND_CONFIRM_BARS;
    const released = Boolean(market.rangeReady) && Number(market.upWeakBars) >= SHORT_PROTECTION_RELEASE_BARS;
    const next = Boolean(active) ? !released : rising;
    return { active: next, entered: !active && next, exited: Boolean(active) && !next };
  }
  const HEAT_LOOKBACK_HOURS = 120;
  const HEAT_PULLBACK = 0.05;
  const HEAT_SHORT_MAX_ADDITIONS = 3;
  const PEAK_LARGE_MARGIN_CAP = 400;
  function historicalSupportZone(dailyRows, atr1h, price) {
    const rows = Array.isArray(dailyRows) ? dailyRows.slice(-30) : [];
    if (rows.length < 20) return null;
    const lows = rows.map((row) => Number(row[3])).filter((value) => Number.isFinite(value) && value > 0);
    if (lows.length < 20) return null;
    const low = Math.min(...lows);
    const width = Math.max((Number(atr1h) || 0) * 2, low * 0.005);
    const high = low + width;
    return { low, high, nearby: Number(price) >= low && Number(price) <= high + width };
  }
  const DEFERRED_FIRST_SHARE = 0.4;
  const DEFERRED_CONFIRM_MS = 6 * 60 * 60 * 1000;
  function deferredLongBudgetStep(state, { price, step, additions, initialMargin, hasPosition }) {
    if (!hasPosition || !['overheat', 'bottom_watch', 'bottom_confirmed'].includes(state?.phase)) return state;
    const value = Number(price); const spacing = Number(step);
    if (!(value > 0) || !(spacing > 0)) return state;
    // Start at the observed price when the rule first becomes active. This also
    // avoids fabricating skipped rungs for an already running strategy on upgrade.
    if (!state.deferredLong) return { ...state, deferredLong: {
      anchor: value, virtualCount: Math.max(0, Number(additions) || 0), budget: 0, spent: 0, stage: 0 } };
    const prior = state.deferredLong;
    let virtualAnchor = Number(prior.anchor);
    let virtualCount = Math.max(Number(additions) || 0, Number(prior.virtualCount) || 0);
    let budget = Math.max(0, Number(prior.budget) || 0);
    if (!(virtualAnchor > 0)) return state;
    // The virtual ladder only records prices already observed. It never submits an order.
    for (let i = 0; i < MAX_LONG_ADDITIONS && virtualCount < MAX_LONG_ADDITIONS
      && value <= virtualAnchor - spacing; i += 1) {
      virtualAnchor -= spacing;
      virtualCount += 1;
      budget = Math.min(PEAK_LARGE_MARGIN_CAP, budget + ladderMargin('XAUUSDT', virtualCount, initialMargin));
    }
    return { ...state, deferredLong: { ...prior, anchor: virtualAnchor, virtualCount, budget,
      spent: Math.max(0, Number(prior.spent) || 0), stage: Math.max(0, Number(prior.stage) || 0) } };
  }
  function deferredLongReleasePlan(state, { price, additions, now, hourlyRows }) {
    const deferred = state?.deferredLong || {};
    const stage = Math.max(0, Number(deferred.stage) || 0);
    const budget = Math.max(0, Number(deferred.budget) || 0);
    const spent = Math.max(0, Number(deferred.spent) || 0);
    const remaining = Math.max(0, budget - spent);
    const firstAmount = Math.min(remaining, budget * DEFERRED_FIRST_SHARE);
    const last = Array.isArray(hourlyRows) ? hourlyRows.at(-1) : null;
    const retest = stage === 1 && last && Number(last[6]) > Number(deferred.firstFilledAt || 0)
      && Number(last[3]) > Number(state.low) && Number(last[3]) <= Number(state.confirmPrice)
      && Number(last[4]) >= Number(state.confirmPrice);
    const withinWindow = stage === 0 || Number(now) - Number(deferred.firstFilledAt || 0) <= DEFERRED_CONFIRM_MS;
    const allowed = state?.phase === 'bottom_confirmed' && stage < 2 && remaining > 0.000001
      && Number(additions) < MAX_LONG_ADDITIONS && Number(price) > Number(state.low)
      && withinWindow && (stage === 0 || Boolean(retest));
    return { allowed, stage: stage + 1, marginUsdt: stage === 0 ? firstAmount : remaining,
      remaining, expired: stage === 1 && !withinWindow };
  }
  function deferredLongFill(state, pending, filledMargin, filledAt) {
    const deferred = state?.deferredLong;
    if (!deferred || !(Number(filledMargin) > 0) || !pending?.deferredStage) return state;
    const budget = Number(deferred.budget) || 0;
    const spent = Math.min(budget, (Number(deferred.spent) || 0) + Number(filledMargin));
    const stage = Number(pending.deferredStage) === 2 && budget - spent > Math.max(5, budget * 0.02)
      ? 1 : Number(pending.deferredStage);
    return { ...state, deferredLong: { ...deferred, spent,
      stage: Math.max(Number(deferred.stage) || 0, stage),
      firstFilledAt: Number(deferred.firstFilledAt) || (Number(pending.deferredStage) === 1 ? Number(filledAt) : 0) } };
  }
  function peakLargeMarginPlan(positionMargin, initialMargin) {
    const held = Number(positionMargin); const initial = Number(initialMargin);
    if (!(held > 0) || !(initial > 0)) return { allowed: false, marginUsdt: 0 };
    return { allowed: true, marginUsdt: Math.min(PEAK_LARGE_MARGIN_CAP,
      Math.max(initial * 2, held * 0.25)) };
  }
  function overheatStateStep(previous, hourlyRows, market, turn, shortAdditions = 0, longAdditions = 0, longOpen = true) {
    const rows = Array.isArray(hourlyRows) ? hourlyRows : [];
    const last = rows.at(-1); const time = Number(last?.[6]);
    const prior = previous || { phase: 'normal', lastHour: 0 };
    if (!market?.dataFresh || !Number.isFinite(time) || time <= Number(prior.lastHour || 0)) return prior;
    const price = Number(last[4]);
    if (!(price > 0)) return prior;
    if (prior.phase === 'overheat') {
      const oldPeak = Number(prior.peak) || price;
      const newHigh = Number(last[2]) > oldPeak;
      const peak = Math.max(oldPeak, Number(last[2]));
      const drawdown = Math.max(0, 1 - price / peak);
      if (drawdown >= HEAT_PULLBACK && !longOpen) return { phase: 'normal', lastHour: time,
        lastPeak: peak, exitedAt: time };
      if (drawdown >= HEAT_PULLBACK) return { ...prior, phase: 'bottom_watch', lastHour: time,
        peak, drawdown, low: Number(last[3]), lowAt: time, shortReady: false,
        bottomBaseAdds: Number.isFinite(Number(prior.bottomBaseAdds)) ? Number(prior.bottomBaseAdds) : Number(longAdditions) || 0 };
      const confirmed = turn?.phase === 'confirmed' && turn.side === 'short' && !newHigh;
      return { ...prior, lastHour: time, peak, drawdown,
        shortReady: confirmed || (Boolean(prior.shortReady) && !newHigh) };
    }
    if (prior.phase === 'bottom_watch' || prior.phase === 'bottom_confirmed') {
      const peak = Number(prior.peak);
      if (!longOpen) return { phase: 'normal', lastHour: time, lastPeak: peak, exitedAt: time };
      const deferred = prior.deferredLong;
      if (prior.phase === 'bottom_confirmed' && deferred
        && (Number(deferred.stage) >= 2
          || time - Number(deferred.firstFilledAt || prior.confirmedAt || time) > DEFERRED_CONFIRM_MS))
        return { phase: 'normal', lastHour: time, lastPeak: peak, exitedAt: time };
      if (prior.phase === 'bottom_confirmed' && prior.bottomLargePlaced && !prior.deferredLong
        && (Number(longAdditions) > (Number(prior.bottomBaseAdds) || 0)
          || time - Number(prior.bottomLargePlacedAt || 0) >= 2 * 60 * 60 * 1000))
        return { phase: 'normal', lastHour: time, lastPeak: peak, exitedAt: time };
      if (peak > 0 && price >= peak) return { ...prior, phase: 'overheat', lastHour: time,
        peak: Math.max(peak, Number(last[2])), drawdown: 0, shortReady: false };
      const newLow = Number(last[3]) < Number(prior.low);
      if (newLow) return { ...prior, phase: 'bottom_watch', lastHour: time,
        low: Number(last[3]), lowAt: time, confirmPrice: 0 };
      if (prior.phase === 'bottom_confirmed') {
        if (prior.deferredLong) return { ...prior, lastHour: time };
        const used = Math.max(0, Number(longAdditions) - (Number(prior.bottomBaseAdds) || 0));
        return used >= 1 || time - Number(prior.confirmedAt || time) >= 6 * 60 * 60 * 1000
          ? { phase: 'normal', lastHour: time, lastPeak: peak, exitedAt: time }
          : { ...prior, lastHour: time };
      }
      const previousBar = rows.at(-2); const earlierBar = rows.at(-3);
      const confirmed = time - Number(prior.lowAt) >= 2 * 60 * 60 * 1000
        && Number(market.downWeakBars) >= TREND_CONFIRM_BARS
        && Number(previousBar?.[3]) > Number(prior.low) && Number(last[3]) > Number(prior.low)
        && price > Math.max(Number(previousBar?.[2]), Number(earlierBar?.[2])) && price > Number(last[1]);
      if (confirmed && prior.bottomLargePlaced && !prior.deferredLong) return { phase: 'normal', lastHour: time,
        lastPeak: peak, exitedAt: time };
      return confirmed ? { ...prior, phase: 'bottom_confirmed', lastHour: time, confirmPrice: price,
        confirmedAt: time, confirmAtr: Number(market.atr1h) || 0 } : { ...prior, lastHour: time };
    }
    if (rows.length < HEAT_LOOKBACK_HOURS + 1) return { ...prior, lastHour: time };
    const oldDay = Number(rows.at(-25)?.[4]); const oldFiveDay = Number(rows.at(-(HEAT_LOOKBACK_HOURS + 1))?.[4]);
    if (!(oldDay > 0) || !(oldFiveDay > 0)) return { ...prior, lastHour: time };
    const oneDayReturn = price / oldDay - 1; const fiveDayReturn = price / oldFiveDay - 1;
    const recentHigh = Math.max(...rows.slice(-HEAT_LOOKBACK_HOURS).map((row) => Number(row[2])));
    const overheated = ((fiveDayReturn >= 0.06 && oneDayReturn >= 0.025)
      || (oneDayReturn >= 0.05 && fiveDayReturn >= 0.03)) && price >= recentHigh * 0.985;
    if (!overheated) return { ...prior, lastHour: time };
    return { phase: 'overheat', lastHour: time, enteredAt: time, peak: recentHigh, drawdown: 0,
      shortReady: turn?.phase === 'confirmed' && turn.side === 'short', shortBaseAdds: Number(shortAdditions) || 0,
      oneDayReturn, fiveDayReturn };
  }
  function overheatShortPlan(state, price, anchor, normalStep, atr1h, shortAdditions) {
    const peak = Number(state?.peak); const current = Number(price);
    const used = Math.max(0, Number(shortAdditions) - (Number(state?.shortBaseAdds) || 0));
    const allowed = state?.phase === 'overheat' && Boolean(state.shortReady) && peak > 0
      && current > 0 && current >= peak * 0.985 && current <= peak
      && used < HEAT_SHORT_MAX_ADDITIONS && Number(shortAdditions) < MAX_SHORT_ADDITIONS;
    const step = Math.max(Number(normalStep) || 0, current * 0.005, (Number(atr1h) || 0) * 0.5);
    return { allowed, used, remaining: Math.max(0, HEAT_SHORT_MAX_ADDITIONS - used),
      step, triggerPrice: Number(anchor) + step, marginScale: 0.5 };
  }
  function bottomLongBatchPlan(state, price, initialMargin, positionMargin, longAdditions) {
    const size = peakLargeMarginPlan(positionMargin, initialMargin);
    return { allowed: state?.phase === 'bottom_confirmed' && !state.bottomLargePlaced
      && Number(price) > Number(state.low) && Number(longAdditions) < MAX_LONG_ADDITIONS && size.allowed,
    marginUsdt: size.marginUsdt };
  }
  const TURN_WINDOW_MS = 24 * 60 * 60 * 1000;
  const TURN_SIGNAL_MS = 6 * 60 * 60 * 1000;
  const TURN_DISTANT_ATR = 2;
  const TURN_DISTANT_ORDER_TTL_MS = 2 * 60 * 60 * 1000;
  function turningPointStep(previous, hourlyRows) {
    const rows = Array.isArray(hourlyRows) ? hourlyRows : [];
    const last = rows.at(-1);
    const time = Number(last?.[6]);
    const prior = previous || { phase: 'idle', lastHour: 0 };
    if (rows.length < 25 || !Number.isFinite(time) || time <= Number(prior.lastHour || 0)) return prior;
    const price = Number(last[4]); const oldPrice = Number(rows.at(-25)?.[4]);
    const rangeAtr = atr(rows, 14);
    const move = price - oldPrice;
    const rapid = Math.abs(move) >= Math.max(oldPrice * 0.03, rangeAtr * 3);
    const recentMove = price - Number(rows.at(-5)?.[4] || price);
    const accelerated = Math.sign(recentMove) === Math.sign(move)
      && Math.abs(recentMove) >= Math.max(price * 0.008, rangeAtr * 1.5);
    let state = { ...prior, lastHour: time };
    const resetRange = !rapid && Math.abs(price - Number(rows.at(-7)?.[4] || price)) / price < 0.008
      && (Math.max(...rows.slice(-6).map((row) => Number(row[2]))) - Math.min(...rows.slice(-6).map((row) => Number(row[3]))) <= rangeAtr * 4);
    if (state.phase === 'cooldown') {
      const resetBars = resetRange ? Number(state.resetBars || 0) + 1 : 0;
      return resetBars >= 3 ? { phase: 'idle', lastHour: time } : { ...state, lastHour: time, resetBars };
    }
    if ((state.phase === 'watch' || state.phase === 'candidate') && time - Number(state.startedAt || 0) > TURN_WINDOW_MS)
      return { phase: 'cooldown', lastHour: time, side: state.side, resetBars: 0 };
    if (state.phase === 'confirmed' && (time - Number(state.confirmedAt || 0) > TURN_SIGNAL_MS
      || (state.side === 'short' ? Number(last[2]) > Number(state.extreme) : Number(last[3]) < Number(state.extreme))))
      return { phase: 'cooldown', lastHour: time, side: state.side, resetBars: 0 };
    if (state.phase === 'watch' || state.phase === 'candidate') {
      const short = state.side === 'short';
      const extreme = short ? Math.max(Number(state.extreme), Number(last[2])) : Math.min(Number(state.extreme), Number(last[3]));
      if (extreme !== Number(state.extreme)) state = { ...state, phase: 'watch', extreme, extremeAt: time, candidateAt: 0 };
      const previousBar = rows.at(-2);
      const correction = time > Number(state.extremeAt) && (short
        ? price <= extreme - rangeAtr * 0.8 && price < Number(previousBar[3]) && price < Number(last[1])
        : price >= extreme + rangeAtr * 0.8 && price > Number(previousBar[2]) && price > Number(last[1]));
      if (state.phase === 'candidate') {
        const structure = time > Number(state.candidateAt) && (short
          ? Number(last[2]) < extreme && price < Number(state.candidatePivot) && price < Number(last[1])
          : Number(last[3]) > extreme && price > Number(state.candidatePivot) && price > Number(last[1]));
        if (structure) return { ...state, phase: 'confirmed', confirmedAt: time, confirmPrice: price, atr: rangeAtr, consumed: false };
        if (time - Number(state.candidateAt) > 4 * 60 * 60 * 1000) state = { ...state, phase: 'watch', candidateAt: 0 };
      }
      if (state.phase === 'watch' && correction) return { ...state, phase: 'candidate', candidateAt: time,
        candidatePivot: short ? Number(last[3]) : Number(last[2]), atr: rangeAtr };
      return state;
    }
    if (state.phase !== 'idle' || !rapid || !accelerated) return state;
    const side = move > 0 ? 'short' : 'long';
    return { phase: 'watch', side, id: `${side}-${time}`, lastHour: time, startedAt: time,
      extreme: side === 'short' ? Number(last[2]) : Number(last[3]), extremeAt: time, atr: rangeAtr, consumed: false };
  }
  function turningPointOpportunity(state, now) {
    return state?.phase === 'confirmed' && !state.consumed && Number(now) >= Number(state.confirmedAt)
      && Number(now) - Number(state.confirmedAt) <= TURN_SIGNAL_MS ? state.side : null;
  }
  function turningPointEntryPlan(state, marketPrice, bid, ask, tickSize = 0) {
    const side = state?.side;
    const price = Number(marketPrice); const extreme = Number(state?.extreme); const atrValue = Number(state?.atr);
    const tick = Math.max(0, Number(tickSize) || 0);
    if (!['long', 'short'].includes(side) || ![price, extreme, atrValue].every(Number.isFinite) || price <= 0 || atrValue <= 0)
      return { valid: false, distant: false, price: NaN, ttlMs: 0 };
    const gap = Math.abs(extreme - Number(state.confirmPrice || price));
    const distant = gap >= atrValue * TURN_DISTANT_ATR;
    const quote = side === 'short' ? Number(ask) : Number(bid);
    const nearPrice = Number.isFinite(quote) && quote > 0 ? quote : price + (side === 'short' ? tick : -tick);
    const improvement = gap * 0.5;
    const makerPrice = distant ? (side === 'short' ? Math.max(nearPrice, Number(state.confirmPrice) + improvement)
      : Math.min(nearPrice, Number(state.confirmPrice) - improvement)) : nearPrice;
    return { valid: makerPrice > 0, distant, price: makerPrice,
      ttlMs: distant ? TURN_DISTANT_ORDER_TTL_MS : 90_000, gapAtr: gap / atrValue };
  }
  function turningPointRiskDecision({ available, marginBalance, maintenance, sideQty, marginUsdt, leverage, price, atr1h }) {
    const values = [available, marginBalance, maintenance, sideQty, marginUsdt, leverage, price, atr1h].map(Number);
    if (!values.every(Number.isFinite) || values[4] <= 0 || values[5] <= 0 || values[6] <= 0 || values[7] <= 0) return { allowed: false, stressLoss: NaN };
    const stressLoss = (values[3] + values[4] * values[5] / values[6]) * 2 * values[7];
    return { allowed: values[0] >= values[4] * 3 && values[1] - stressLoss > Math.max(values[2] * 1.5, values[4] * 3), stressLoss };
  }
  function sparseGroupCount(sideCount, sideMax) { return Math.min(SPARSE_GROUP_SIZE, Math.max(0, Number(sideMax) - Number(sideCount))); }
  function sparseGroupMargin(symbol, firstTier, count, initialMargin) {
    return Array.from({ length: Math.max(0, Number(count) || 0) }, (_, index) => ladderMargin(symbol, Number(firstTier) + index, initialMargin)).reduce((sum, margin) => sum + margin, 0);
  }
  function sparseGroupTrigger(anchor, step, count, isLong) { return Number(anchor) + (isLong ? -1 : 1) * Number(step) * Number(count); }
  // Sparse mode widens the price gap without consuming five margin tiers at once.
  function sparseSinglePlan(symbol, tier, initialMargin, anchor, step, isLong) {
    return { count: 1, marginUsdt: ladderMargin(symbol, tier, initialMargin),
      triggerPrice: sparseGroupTrigger(anchor, step, SPARSE_GROUP_SIZE, isLong) };
  }
  const WEEKEND_CLOCK = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', hourCycle: 'h23' });
  function isCommodityWeekendMode(date = new Date()) {
    const parts = Object.fromEntries(WEEKEND_CLOCK.formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    const hour = Number(parts.hour);
    return parts.weekday === 'Sat' || (parts.weekday === 'Fri' && hour >= 17) || (parts.weekday === 'Sun' && hour < 18);
  }
  // Only completed hourly bars are supplied by callers. Daily data is used as
  // a second, completed-candle reference; never inspect a future day's close.
  function extremeLongRegime(hourlyRows, dailyRows, observedLow = 0) {
    const hours = Array.isArray(hourlyRows) ? hourlyRows : [];
    const days = Array.isArray(dailyRows) ? dailyRows : [];
    if (hours.length < 49 || days.length < 2) return { active: false, drop24: 0, drop48: 0, dayRange: 0 };
    const price = Number(hours.at(-1)?.[4]);
    const close24 = Number(hours.at(-25)?.[4]); const close48 = Number(hours.at(-49)?.[4]);
    const previousDay = days.at(-1);
    const dayClose = Number(previousDay?.[4]); const dayHigh = Number(previousDay?.[2]); const dayLow = Number(previousDay?.[3]);
    if (![price, close24, close48, dayClose, dayHigh, dayLow].every((value) => Number.isFinite(value) && value > 0))
      return { active: false, drop24: 0, drop48: 0, dayRange: 0 };
    // A confirmed rebound may erase the close-to-close drop. The signal low
    // was already observed, so using it does not inspect future candles.
    const low = Number(observedLow);
    const stressPrice = low > 0 && low <= price ? low : price;
    const drop24 = Math.max(0, 1 - stressPrice / close24);
    const drop48 = Math.max(0, 1 - stressPrice / close48);
    const dayRange = (dayHigh - dayLow) / dayClose;
    // A modest prior-day range alone is not permission for a large add.
    return { active: drop24 >= 0.035 || drop48 >= 0.055, drop24, drop48, dayRange };
  }
  function deepLongZone(dailyRows, hourlyRows, lockedPeak = 0) {
    const days = Array.isArray(dailyRows) ? dailyRows.slice(-30) : [];
    const hours = Array.isArray(hourlyRows) ? hourlyRows : [];
    if (days.length < 20 || hours.length < 7) return { level: 0, peak: 0, low: 0, drawdown: 0 };
    const peak = Math.max(Number(lockedPeak) || 0,
      ...days.map((row) => Number(row[2])).filter((value) => Number.isFinite(value) && value > 0));
    const low = Math.min(...hours.slice(-7).map((row) => Number(row[3])).filter((value) => Number.isFinite(value) && value > 0));
    if (!(peak > 0) || !(low > 0)) return { level: 0, peak: 0, low: 0, drawdown: 0 };
    const drawdown = Math.max(0, 1 - low / peak);
    return { level: DEEP_LONG_LEVELS.filter((threshold) => drawdown >= threshold).length, peak, low, drawdown };
  }
  function deepLongBudget(initialMargin, remainingSlots, stage) {
    const total = Math.max(0, Number(initialMargin) || 0) * Math.max(0, Math.floor(Number(remainingSlots) || 0));
    const share = DEEP_LONG_SHARES[Number(stage) - 1] || 0;
    return { allowed: total > 0 && share > 0, total, marginUsdt: total * share };
  }
  function deepLongConfirmation(hourlyRows, priorLow = Infinity, afterHour = 0) {
    const rows = Array.isArray(hourlyRows) ? hourlyRows : [];
    if (rows.length < 7) return { confirmed: false, low: 0, hour: 0 };
    const last = rows.at(-1); const previous = rows.at(-2);
    const low = Math.min(...rows.slice(-7, -2).map((row) => Number(row[3])));
    const hour = Number(last[6]);
    return { confirmed: Number.isFinite(low) && low > 0 && low < Number(priorLow)
      && hour > Number(afterHour) && Number(previous[3]) > low && Number(last[3]) > low
      && Number(last[4]) > Number(previous[2]) && Number(last[4]) > Number(last[1]), low, hour };
  }
  function deepLongStageSignal(hourlyRows, stage, peak, priorLow = Infinity, afterHour = 0) {
    if (Number(stage) === 1) return deepLongConfirmation(hourlyRows, Infinity, afterHour);
    const rows = Array.isArray(hourlyRows) ? hourlyRows : [];
    const last = rows.at(-1);
    const threshold = DEEP_LONG_LEVELS[Number(stage) - 1];
    const low = Number(last?.[3]); const close = Number(last?.[4]); const hour = Number(last?.[6]);
    return { confirmed: Number.isFinite(threshold) && Number(peak) > 0
      && Number.isFinite(low) && low > 0 && low < Number(priorLow)
      && Number.isFinite(close) && close <= Number(peak) * (1 - threshold)
      && Number.isFinite(hour) && hour > Number(afterHour), low, hour };
  }
  function shouldPlaceAddition({ sparseMode = false, side, price, triggerPrice }) {
    if (sparseMode) return true;
    return side === 'long' ? Number(price) <= Number(triggerPrice) : Number(price) >= Number(triggerPrice);
  }
  function ordinaryAdditionDue({ side, price, pricePnl, additions, maxAdditions, sparseMode = false,
    trend = false, trendDirection = 'neutral', shortTrendProtected = false, anchor, normalStep, atr1h }) {
    if (!['long', 'short'].includes(side) || !Number.isFinite(Number(price)) || !(Number(price) > 0)
      || !(Number(pricePnl) < 0) || Number(additions) >= Number(maxAdditions)
      || (side === 'short' && shortTrendProtected) || ((trend || trendDirection !== 'neutral') && !sparseMode)) return false;
    const step = sparseMode ? sparseLadderStep(price, normalStep, atr1h) : Number(normalStep);
    if (!(step > 0)) return false;
    const count = 1;
    if (!(count > 0)) return false;
    const triggerPrice = sparseMode ? sparseGroupTrigger(anchor, step, SPARSE_GROUP_SIZE, side === 'long')
      : Number(anchor) + (side === 'long' ? -step : step);
    return shouldPlaceAddition({ sparseMode, side, price, triggerPrice });
  }
  function canManualAddPosition({ enabled, status, pending, phase, quantity, pnl }) {
    return Boolean(enabled) && ['active', 'add_pending'].includes(status) && !pending && phase === 'active'
      && Number(quantity) > 0 && Number(pnl) < 0;
  }
  function marketState(rows15, rows60) {
    const c15 = rows15.map((r) => Number(r[4])).filter(Number.isFinite);
    const h15 = rows15.map((r) => Number(r[2])); const l15 = rows15.map((r) => Number(r[3]));
    const c60 = rows60.map((r) => Number(r[4])).filter(Number.isFinite);
    if (c15.length < 30 || c60.length < 20) throw new Error('K线数据不足');
    const last = c15.at(-1); const atrValue = atr(rows15, 20); const atr1h = atr(rows60, 14);
    const fastNow = ema(c15.slice(-20), 10); const fastOld = ema(c15.slice(-24, -4), 10);
    const hourMove = Math.abs(c60.at(-1) / c60.at(-8) - 1); const slope = Math.abs(fastNow / fastOld - 1);
    const directionSignal = (i, direction) => {
      const currentEma = ema(c60.slice(Math.max(0, i - 19), i + 1), 20);
      const previousEma = ema(c60.slice(Math.max(0, i - 20), i), 20);
      return direction === 'up' ? c60[i] > currentEma && currentEma > previousEma : c60[i] < currentEma && currentEma < previousEma;
    };
    const consecutive = (predicate) => { let count = 0; for (let i = c60.length - 1; i >= Math.max(20, c60.length - 6); i -= 1) { if (!predicate(i)) break; count += 1; } return count; };
    const upTrendBars = consecutive((i) => directionSignal(i, 'up')); const downTrendBars = consecutive((i) => directionSignal(i, 'down'));
    const downWeakBars = consecutive((i) => !directionSignal(i, 'down')); const upWeakBars = consecutive((i) => !directionSignal(i, 'up'));
    const trendBars = Math.max(upTrendBars, downTrendBars);
    const trendDirection = trendBars >= TREND_CONFIRM_BARS ? (upTrendBars > downTrendBars ? 'up' : 'down') : 'neutral';
    const range = { low: Math.min(...l15.slice(-24)), high: Math.max(...h15.slice(-24)) };
    const rangeReady = hourMove <= 0.018 && slope <= 0.008 && atrValue / last >= 0.00045 && atrValue / last <= 0.012;
    return { last, atr: atrValue, atr1h, addStep: ladderStep(last, atrValue), range, rangeReady,
      trend: !rangeReady && (hourMove > 0.025 || slope > 0.012), trendDirection, trendBars, upWeakBars, downWeakBars };
  }
  function scalpProfitTarget(notional) { return Math.max(SCALP_MIN_PROFIT, Number(notional || 0) * SCALP_NOTIONAL_RATE); }
  // Match live exit checks: include funding expenses in the required profit,
  // but don't let funding income alone trigger a take-profit. Settlement PnL
  // remains separate and may still include positive funding.
  function takeProfitNetPnl({ pricePnl, funding, entryFee, exitFee }) {
    return (Number(pricePnl) || 0) + Math.min(0, Number(funding) || 0)
      - (Number(entryFee) || 0) - (Number(exitFee) || 0);
  }
  function recoveryExitState({ recovery, armed, netPnl, peakNetPnl, trail, trend, target }) {
    if (!recovery || !armed) return { shouldClose: false, reason: '' };
    if (netPnl <= peakNetPnl - trail) return { shouldClose: true, reason: '恢复模式利润回撤触发' };
    if (!trend && netPnl >= target) return { shouldClose: true, reason: '恢复模式目标达成' };
    return { shouldClose: false, reason: '' };
  }
  function longRecoveryExitState({ recovery, armed, netPnl, peakNetPnl, target, pullbackRate = 0.25 }) {
    const peak = Number(peakNetPnl);
    const floor = Number(target);
    const rate = Number(pullbackRate);
    if (!recovery || !armed || !Number.isFinite(peak) || !Number.isFinite(floor)
      || !Number.isFinite(Number(netPnl)) || !Number.isFinite(rate) || rate < 0 || rate >= 1)
      return { shouldClose: false, reason: '', trigger: 0 };
    const trigger = Math.max(floor, peak * (1 - rate));
    return { shouldClose: Number(netPnl) < peak && Number(netPnl) <= trigger,
      reason: '多头恢复模式追踪止盈', trigger };
  }
  function shouldCancelTakeProfit(netPnl) {
    const value = Number(netPnl);
    return Number.isFinite(value) && value <= 0;
  }
  return { MAX_LONG_ADDITIONS, MAX_SHORT_ADDITIONS, SYMBOL_DEFAULTS, MIN_STEP_PCT, MAX_STEP_PCT, SPARSE_MAX_STEP_PCT,
    ATR_MULTIPLIER, SPARSE_ATR_MULTIPLIER, SPARSE_NORMAL_STEP_MULTIPLIER, SPARSE_GROUP_SIZE, SPARSE_ENTER_ATR_DISTANCE,
    SPARSE_EXIT_ATR_DISTANCE, TREND_CONFIRM_BARS, SHORT_PROTECTION_RELEASE_BARS, SCALP_MIN_PROFIT, SCALP_NOTIONAL_RATE, clamp, ema, atr, defaultConfig,
    ladderMargin, sideAdditions, additionDecision, countedAdditions, ladderStep, sparseLadderStep, sparseModeDecision,
    historicalSupportZone, deferredLongBudgetStep, deferredLongReleasePlan, deferredLongFill,
    sparseGroupCount, sparseGroupMargin, sparseGroupTrigger, sparseSinglePlan, isCommodityWeekendMode,
    extremeLongRegime, deepLongZone, deepLongBudget, deepLongConfirmation, deepLongStageSignal,
    shortTrendProtectionDecision, overheatStateStep, overheatShortPlan, bottomLongBatchPlan, peakLargeMarginPlan,
    turningPointStep, turningPointOpportunity, turningPointEntryPlan, turningPointRiskDecision,
    shouldPlaceAddition, ordinaryAdditionDue, canManualAddPosition, marketState, scalpProfitTarget, takeProfitNetPnl, recoveryExitState, longRecoveryExitState, shouldCancelTakeProfit };
});
