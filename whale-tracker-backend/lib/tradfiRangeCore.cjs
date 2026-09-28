// Pure strategy decisions shared by live TradFi strategy and local replay.
// Keep this module free of database, exchange, clock, and network dependencies.
(function attach(root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  root.TradfiRangeCore = core;
})(globalThis, function createCore() {
  const MAX_LONG_ADDITIONS = 100;
  const MAX_SHORT_ADDITIONS = 50;
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
  const SPARSE_ENTER_ATR_DISTANCE = 2;
  const SPARSE_EXIT_ATR_DISTANCE = 1.5;
  const TREND_CONFIRM_BARS = 3;
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
    const otherCount = longLosing ? counts.shortAdditions : counts.longAdditions;
    const sideMax = longLosing ? MAX_LONG_ADDITIONS : MAX_SHORT_ADDITIONS;
    const otherMax = longLosing ? MAX_SHORT_ADDITIONS : MAX_LONG_ADDITIONS;
    if (sideCount >= sideMax && otherCount >= otherMax) return { action: 'manual', ...counts };
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
  function sparseGroupCount(sideCount, sideMax) { return Math.min(SPARSE_GROUP_SIZE, Math.max(0, Number(sideMax) - Number(sideCount))); }
  function sparseGroupMargin(symbol, firstTier, count, initialMargin) {
    return Array.from({ length: Math.max(0, Number(count) || 0) }, (_, index) => ladderMargin(symbol, Number(firstTier) + index, initialMargin)).reduce((sum, margin) => sum + margin, 0);
  }
  function sparseGroupTrigger(anchor, step, count, isLong) { return Number(anchor) + (isLong ? -1 : 1) * Number(step) * Number(count); }
  function shouldPlaceAddition({ sparseMode = false, side, price, triggerPrice }) {
    if (sparseMode) return true;
    return side === 'long' ? Number(price) <= Number(triggerPrice) : Number(price) >= Number(triggerPrice);
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
  function shouldCancelTakeProfit(netPnl) {
    const value = Number(netPnl);
    return Number.isFinite(value) && value <= 0;
  }
  return { MAX_LONG_ADDITIONS, MAX_SHORT_ADDITIONS, SYMBOL_DEFAULTS, MIN_STEP_PCT, MAX_STEP_PCT, SPARSE_MAX_STEP_PCT,
    ATR_MULTIPLIER, SPARSE_ATR_MULTIPLIER, SPARSE_NORMAL_STEP_MULTIPLIER, SPARSE_GROUP_SIZE, SPARSE_ENTER_ATR_DISTANCE,
    SPARSE_EXIT_ATR_DISTANCE, TREND_CONFIRM_BARS, SCALP_MIN_PROFIT, SCALP_NOTIONAL_RATE, clamp, ema, atr, defaultConfig,
    ladderMargin, sideAdditions, additionDecision, countedAdditions, ladderStep, sparseLadderStep, sparseModeDecision,
    sparseGroupCount, sparseGroupMargin, sparseGroupTrigger, shouldPlaceAddition, canManualAddPosition, marketState, scalpProfitTarget, takeProfitNetPnl, recoveryExitState, shouldCancelTakeProfit };
});
