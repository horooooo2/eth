const assert = require('node:assert/strict');
const test = require('node:test');
const { takeProfitNetPnl, shouldPlaceAddition, canManualAddPosition, shouldCancelTakeProfit,
  shortTrendProtectionDecision, overheatStateStep, overheatShortPlan, bottomLongBatchPlan, peakLargeMarginPlan,
  deferredLongBudgetStep, deferredLongReleasePlan, deferredLongFill,
  historicalSupportZone, sparseSinglePlan, deepLongZone, deepLongBudget, deepLongConfirmation, deepLongStageSignal,
  turningPointStep, turningPointOpportunity, turningPointEntryPlan, turningPointRiskDecision,
  ordinaryAdditionDue, longRecoveryExitState } = require('../lib/tradfiRangeCore.cjs');
const { canCancelPendingForPositionSync, pendingForSide, pendingStatePatch, autoPendingOrders, availableAdditionDirection } = require('../lib/tradfiRangeStrategy');

function candles(start, count, step, spread = 2) {
  return Array.from({ length: count }, (_, i) => {
    const close = start + i * step;
    return [i, close, close + spread, close - spread, close, 1];
  });
}

const { marketState, ladderStep, sparseLadderStep, sparseModeDecision, sparseGroupCount, sparseGroupMargin, sparseGroupTrigger,
  ladderMargin, defaultConfig, requestedConfig, resumedConfig, restartState, isPostOnlyReject, isRequestTimeout, recoveryExitState,
  ignoreStaleStrategySave,
  closeClientId, closeOrderRemaining, additionDecision, countedAdditions, scalpProfitTarget, commissionRate, syncLegState, quantitySyncSummary,
  isCanceledWithoutFill,
  isCommodityWeekendMode, orderFillState, marketDataFreshness, profitGuardPrice, allocateFundingCharge, positionAdoptionSummary, adoptedLegState,
  MAX_ADDITIONS, MAX_LONG_ADDITIONS, MAX_SHORT_ADDITIONS, MARGIN, LEVERAGE } = require('../lib/tradfiRangeStrategy');

test('黄金窄幅结构允许震荡监控，明显单边结构识别为趋势', () => {
  const range15 = candles(1800, 48, 0.02, 2);
  const range60 = candles(1800, 30, 0.05, 3);
  assert.equal(marketState(range15, range60).rangeReady, true);
  const trend15 = candles(1800, 48, 2, 2);
  const trend60 = candles(1800, 30, 8, 4);
  assert.equal(marketState(trend15, trend60).trend, true);
  assert.equal(marketState(trend15, trend60).trendDirection, 'up');
  assert.ok(marketState(trend15, trend60).trendBars >= 3);
  assert.ok(marketState(trend15, trend60).downWeakBars >= 3);
  const down60 = candles(2100, 30, -8, 4);
  assert.equal(marketState(trend15, down60).trendDirection, 'down');
  assert.ok(marketState(trend15, down60).upWeakBars >= 3);
});

test('上涨保护仅限制空头新增，需连续弱化且震荡恢复才解除', () => {
  const up = { dataFresh: true, trendDirection: 'up', trendBars: 3, upWeakBars: 0, rangeReady: false };
  assert.deepEqual(shortTrendProtectionDecision(false, up), { active: true, entered: true, exited: false });
  assert.equal(shortTrendProtectionDecision(true, { ...up, dataFresh: false }).active, true);
  assert.equal(shortTrendProtectionDecision(true, { ...up, trendDirection: 'neutral', upWeakBars: 5, rangeReady: true }).active, true);
  assert.equal(shortTrendProtectionDecision(true, { ...up, trendDirection: 'neutral', upWeakBars: 6, rangeReady: false }).active, true);
  assert.deepEqual(shortTrendProtectionDecision(true, { ...up, trendDirection: 'neutral', upWeakBars: 6, rangeReady: true }),
    { active: false, entered: false, exited: true });
});

test('连续上涨过热暂停补多，回落后等待右侧底部确认', () => {
  const hour = 3_600_000;
  const rows = Array.from({ length: 121 }, (_, index) => {
    const close = index < 97 ? 100 : 100 + (index - 96) * 0.45;
    return [index * hour, close, close + 0.1, close - 0.1, close, 1, (index + 1) * hour - 1];
  });
  const market = { dataFresh: true, downWeakBars: 0, rangeReady: false };
  assert.equal(overheatStateStep(null, rows.slice(0, 120), market, null, 4).phase, 'normal');
  const hot = overheatStateStep(null, rows, market, null, 4);
  assert.equal(hot.phase, 'overheat');
  assert.equal(hot.shortReady, false);
  assert.equal(overheatShortPlan(hot, 110, 100, 0.2, 0.4, 4).allowed, false);
  const confirmed = { phase: 'confirmed', side: 'short' };
  const nextTime = rows.at(-1)[6] + hour;
  const peak = hot.peak;
  rows.push([121 * hour, peak - 0.8, peak - 0.2, peak - 1, peak - 0.8, 1, nextTime]);
  const ready = overheatStateStep(hot, rows, market, confirmed, 4);
  assert.equal(ready.shortReady, true);
  const plan = overheatShortPlan(ready, peak - 0.8, 100, 0.2, 0.4, 4);
  assert.equal(plan.allowed, true);
  assert.equal(plan.marginScale, 0.5);
  assert.ok(plan.step >= (peak - 0.8) * 0.005);
  assert.equal(overheatShortPlan(ready, peak - 0.8, 100, 0.2, 0.4, 7).allowed, false);
  assert.equal(overheatShortPlan(ready, peak + 0.1, 100, 0.2, 0.4, 4).allowed, false);
  const breakout = overheatStateStep(ready,
    [...rows, [122 * hour, peak, peak + 0.5, peak - 0.3, peak + 0.2, 1, nextTime + hour]],
    market, confirmed, 4);
  assert.equal(breakout.shortReady, false);
  rows.push([122 * hour, peak * 0.94, peak * 0.95, peak * 0.93, peak * 0.94, 1, nextTime + hour]);
  assert.equal(overheatStateStep(ready, rows, market, null, 5).phase, 'bottom_watch');
  const cooled = overheatStateStep(ready, rows, { ...market, downWeakBars: 3 }, null, 5);
  assert.equal(cooled.phase, 'bottom_watch');
  assert.equal(overheatStateStep(ready, rows, { ...market, downWeakBars: 3 }, null, 5, 0, false).phase, 'normal');
  assert.equal(cooled.bottomBaseAdds, 0);
  assert.equal(bottomLongBatchPlan(cooled, peak * 0.95, 20, 200, 0).allowed, false);
  rows.push([123 * hour, peak * 0.94, peak * 0.95, peak * 0.94, peak * 0.945, 1, nextTime + 2 * hour]);
  const stillWatching = overheatStateStep(cooled, rows, { ...market, downWeakBars: 3, atr1h: 1 }, null, 5, 0);
  assert.equal(stillWatching.phase, 'bottom_watch');
  rows.push([124 * hour, peak * 0.945, peak * 0.97, peak * 0.942, peak * 0.965, 1, nextTime + 3 * hour]);
  const confirmedBottom = overheatStateStep(stillWatching, rows, { ...market, downWeakBars: 3, atr1h: 1 }, null, 5, 0);
  assert.equal(confirmedBottom.phase, 'bottom_confirmed');
  assert.deepEqual(peakLargeMarginPlan(200, 20), { allowed: true, marginUsdt: 50 });
  assert.deepEqual(peakLargeMarginPlan(20, 20), { allowed: true, marginUsdt: 40 });
  assert.deepEqual(peakLargeMarginPlan(5000, 20), { allowed: true, marginUsdt: 400 });
  assert.equal(bottomLongBatchPlan(confirmedBottom, confirmedBottom.confirmPrice, 20, 200, 0).marginUsdt, 50);
  assert.equal(bottomLongBatchPlan(confirmedBottom, confirmedBottom.confirmPrice, 20, 200, 0).allowed, true);
  assert.equal(bottomLongBatchPlan({ ...confirmedBottom, bottomLargePlaced: true },
    confirmedBottom.confirmPrice, 20, 200, 0).allowed, false);
  const renewedLowRows = [...rows, [125 * hour, peak * 0.93, peak * 0.94, peak * 0.92,
    peak * 0.925, 1, nextTime + 4 * hour]];
  const resetWatch = overheatStateStep(confirmedBottom, renewedLowRows,
    { ...market, downWeakBars: 3, atr1h: 1 }, null, 5, 1);
  assert.equal(resetWatch.phase, 'bottom_watch');
  assert.equal(overheatStateStep(confirmedBottom, renewedLowRows,
    { ...market, downWeakBars: 3 }, null, 5, 1, false).phase, 'normal');
  assert.equal(resetWatch.bottomBaseAdds, confirmedBottom.bottomBaseAdds);
  assert.equal(bottomLongBatchPlan(resetWatch, peak * 0.93, 20, 200, 1).allowed, false);
  rows.push([125 * hour, peak * 0.965, peak * 0.97, peak * 0.96, peak * 0.966, 1, nextTime + 4 * hour]);
  assert.equal(overheatStateStep({ ...confirmedBottom, bottomLargePlaced: true,
    bottomLargePlacedAt: confirmedBottom.lastHour }, rows, { ...market, downWeakBars: 3 }, null, 5, 1).phase, 'normal');
});

test('黄金延迟补仓只累计已越过的档位，成交才消耗预算，第二批必须回踩确认', () => {
  const start = { phase: 'overheat', peak: 5600, lastHour: 1 };
  const input = { price: 5540, step: 10, anchor: 5600, additions: 0, initialMargin: 20, hasPosition: true };
  const activated = deferredLongBudgetStep(start, { ...input, price: 5600 });
  assert.equal(activated.deferredLong.budget, 0);
  const held = deferredLongBudgetStep(activated, input);
  assert.equal(held.deferredLong.virtualCount, 6);
  assert.equal(held.deferredLong.budget, 60);
  assert.deepEqual(deferredLongBudgetStep(held, input).deferredLong, held.deferredLong);
  const bottom = { ...held, phase: 'bottom_confirmed', low: 4700, confirmPrice: 4750, confirmedAt: 1000 };
  const first = deferredLongReleasePlan(bottom, { price: 4750, additions: 0, now: 2000, hourlyRows: [] });
  assert.equal(first.allowed, true);
  assert.equal(first.marginUsdt, 24);
  const filled = deferredLongFill(bottom, { deferredStage: 1 }, 20, 3000);
  assert.equal(filled.deferredLong.spent, 20);
  assert.equal(filled.deferredLong.stage, 1);
  assert.equal(deferredLongReleasePlan(filled, { price: 4750, additions: 1, now: 4000, hourlyRows: [] }).allowed, false);
  const retest = [[0, 4750, 4760, 4720, 4755, 1, 5000]];
  const second = deferredLongReleasePlan(filled, { price: 4755, additions: 1, now: 6000, hourlyRows: retest });
  assert.equal(second.allowed, true);
  assert.equal(second.marginUsdt, 40);
  const partialSecond = deferredLongFill(filled, { deferredStage: 2 }, 20, 7000);
  assert.equal(partialSecond.deferredLong.stage, 1);
  assert.equal(deferredLongReleasePlan(partialSecond, { price: 4755, additions: 2, now: 8000, hourlyRows: retest }).marginUsdt, 20);
  const done = deferredLongFill(filled, { deferredStage: 2 }, 40, 7000);
  assert.equal(deferredLongReleasePlan(done, { price: 4755, additions: 2, now: 8000, hourlyRows: retest }).allowed, false);
  assert.equal(deferredLongBudgetStep(done, { ...input, hasPosition: false }), done);
});

test('历史低位参考只使用已提供的日线，不参与自动补仓触发', () => {
  const rows = Array.from({ length: 30 }, (_, i) => [i, 5000, 5050, i === 5 ? 4700 : 4800, 5000, 1]);
  assert.equal(historicalSupportZone(rows.slice(0, 10), 20, 4750), null);
  assert.deepEqual(historicalSupportZone(rows, 20, 4750), { low: 4700, high: 4740, nearby: true });
});

test('小时线急涨后确认回落才给补空机会；急跌后确认止跌才给补多机会', () => {
  const hour = 3_600_000;
  for (const side of ['short', 'long']) {
    const upward = side === 'short';
    const rows = Array.from({ length: 24 }, (_, i) => [i * hour, 100, 100.2, 99.8, 100, 1, (i + 1) * hour - 1]);
    const spike = upward ? [24 * hour, 100, 104.2, 99.9, 104, 1, 25 * hour - 1]
      : [24 * hour, 100, 100.1, 95.8, 96, 1, 25 * hour - 1];
    rows.push(spike);
    let signal = turningPointStep(null, rows);
    assert.equal(signal.phase, 'watch');
    assert.equal(signal.side, side);
    assert.equal(turningPointOpportunity(signal, signal.lastHour), null);
    rows.push(upward ? [25 * hour, 104, 104.1, 103, 103.4, 1, 26 * hour - 1]
      : [25 * hour, 96, 97, 95.9, 96.6, 1, 26 * hour - 1]);
    signal = turningPointStep(signal, rows);
    assert.equal(signal.phase, 'watch');
    rows.push(upward ? [26 * hour, 103.4, 103.6, 102.7, 102.8, 1, 27 * hour - 1]
      : [26 * hour, 96.6, 97.3, 96.3, 97.2, 1, 27 * hour - 1]);
    signal = turningPointStep(signal, rows);
    assert.equal(signal.phase, 'candidate');
    assert.equal(turningPointOpportunity(signal, signal.lastHour), null);
    rows.push(upward ? [27 * hour, 102.8, 103, 102, 102.1, 1, 28 * hour - 1]
      : [27 * hour, 97.2, 98, 97.4, 97.9, 1, 28 * hour - 1]);
    signal = turningPointStep(signal, rows);
    assert.equal(signal.phase, 'confirmed');
    assert.equal(turningPointOpportunity(signal, signal.lastHour), side);
    assert.equal(turningPointOpportunity({ ...signal, consumed: true }, signal.lastHour), null);
    assert.equal(turningPointOpportunity(signal, signal.lastHour + 7 * hour), null);
    rows.push(upward ? [28 * hour, 102.1, 105, 102, 104, 1, 29 * hour - 1]
      : [28 * hour, 97.9, 98, 95, 96, 1, 29 * hour - 1]);
    signal = turningPointStep(signal, rows);
    assert.equal(signal.phase, 'cooldown');
    for (let i = 29; i < 60; i += 1) {
      rows.push([i * hour, 100, 100.1, 99.9, 100, 1, (i + 1) * hour - 1]);
      signal = turningPointStep(signal, rows.slice(-60));
      if (i === 29) assert.equal(signal.phase, 'cooldown');
    }
    assert.equal(signal.phase, 'idle');
  }
});

test('特殊补仓远离极值时等待更优 Maker 价，并限制等待时间', () => {
  const farShort = turningPointEntryPlan({ side: 'short', extreme: 110, confirmPrice: 100, atr: 3 }, 100, 99.9, 100.1, 0.1);
  assert.equal(farShort.valid, true);
  assert.equal(farShort.distant, true);
  assert.equal(farShort.price, 105);
  assert.equal(farShort.ttlMs, 2 * 60 * 60 * 1000);
  const farLong = turningPointEntryPlan({ side: 'long', extreme: 90, confirmPrice: 100, atr: 3 }, 100, 99.9, 100.1, 0.1);
  assert.equal(farLong.price, 95);
  const near = turningPointEntryPlan({ side: 'short', extreme: 103, confirmPrice: 100, atr: 3 }, 100, 99.9, 100.1, 0.1);
  assert.equal(near.distant, false);
  assert.equal(near.ttlMs, 90_000);
});

test('仅有缓慢的 24 小时单边走势不触发急涨预警', () => {
  const hour = 3_600_000;
  const rows = Array.from({ length: 30 }, (_, i) => {
    const open = 100 + i * 0.18;
    const close = open + 0.18;
    return [i * hour, open, close + 0.03, open - 0.03, close, 1, (i + 1) * hour - 1];
  });
  assert.equal(turningPointStep(null, rows).phase, 'idle');
});

test('特殊挂单等待时，常规阶梯触发应优先恢复；未触发则保留特殊机会', () => {
  const common = { side: 'long', price: 99, pricePnl: -3, additions: 2, maxAdditions: 100,
    sparseMode: false, trend: false, trendDirection: 'neutral', anchor: 100, normalStep: 1, atr1h: 2 };
  assert.equal(ordinaryAdditionDue(common), true);
  assert.equal(ordinaryAdditionDue({ ...common, price: 99.2 }), false);
  assert.equal(ordinaryAdditionDue({ ...common, trend: true, trendDirection: 'down' }), false);
  assert.equal(ordinaryAdditionDue({ ...common, sparseMode: true, trend: true, trendDirection: 'down' }), true);
  assert.equal(ordinaryAdditionDue({ ...common, side: 'short', anchor: 98, shortTrendProtected: true }), false);
  assert.equal(ordinaryAdditionDue({ ...common, additions: 100 }), false);
});

test('特殊补仓风险检查拒绝低可用保证金或过大压力损失', () => {
  const base = { available: 100, marginBalance: 1000, maintenance: 50, sideQty: 1, marginUsdt: 10,
    leverage: 20, price: 100, atr1h: 1 };
  assert.equal(turningPointRiskDecision(base).allowed, true);
  assert.equal(turningPointRiskDecision({ ...base, available: 20 }).allowed, false);
  assert.equal(turningPointRiskDecision({ ...base, marginBalance: 60, atr1h: 20 }).allowed, false);
});

test('黄金与白银使用各自默认本金和杠杆，多空补仓上限分别为100档和20档', () => {
  assert.equal(MARGIN, 20);
  assert.equal(LEVERAGE, 20);
  assert.equal(MAX_ADDITIONS, 100);
  assert.equal(MAX_LONG_ADDITIONS, 100);
  assert.equal(MAX_SHORT_ADDITIONS, 20);
  assert.deepEqual(defaultConfig('XAUUSDT'), { marginUsdt: 20, leverage: 20, ladder: [10, 15, 25, 30] });
  assert.deepEqual(defaultConfig('XAGUSDT'), { marginUsdt: 10, leverage: 10, ladder: [5, 7.5, 12.5, 15] });
});

test('阶梯补仓每10档调整保证金并延续到多头100档、空头20档', () => {
  assert.deepEqual([1, 10, 11, 20, 21, 30, 31, 40, 100].map((level) => ladderMargin('XAUUSDT', level)), [10, 10, 15, 15, 25, 25, 30, 30, 30]);
  assert.deepEqual([1, 11, 21, 31].map((level) => ladderMargin('XAGUSDT', level)), [5, 7.5, 12.5, 15]);
  assert.equal(Array.from({ length: 100 }, (_, i) => ladderMargin('XAUUSDT', i + 1)).reduce((a, b) => a + b, 0), 2600);
  assert.equal(Array.from({ length: 20 }, (_, i) => ladderMargin('XAUUSDT', i + 1)).reduce((a, b) => a + b, 0), 250);
  assert.equal(Array.from({ length: 100 }, (_, i) => ladderMargin('XAGUSDT', i + 1)).reduce((a, b) => a + b, 0), 1300);
  assert.equal(Array.from({ length: 20 }, (_, i) => ladderMargin('XAGUSDT', i + 1)).reduce((a, b) => a + b, 0), 125);
  assert.deepEqual([1, 11, 21, 31].map((level) => ladderMargin('XAUUSDT', level, 50)), [25, 37.5, 62.5, 75]);
  assert.equal(Array.from({ length: 100 }, (_, i) => ladderMargin('XAUUSDT', i + 1, 50)).reduce((a, b) => a + b, 0), 6500);
});

test('补仓间距使用15分钟 ATR 的 0.6 倍，并限制在现价的 0.08% 到 0.35%', () => {
  assert.equal(ladderStep(4800, 8), 4.8);
  assert.equal(ladderStep(4800, 15), 9);
  assert.equal(ladderStep(4800, 35), 16.8);
});

test('稀疏模式不要求先补满20档，趋势和均价距离满足时可立即进入', () => {
  assert.deepEqual(sparseModeDecision({ side: 'long', entryPrice: 5000, price: 4930, atr1h: 30, trendDirection: 'down', trendBars: 3 }),
    { active: true, enter: true, exit: false, distance: 70, distanceAtr: 70 / 30 });
  assert.equal(sparseModeDecision({ side: 'short', entryPrice: 5000, price: 4930, atr1h: 30, trendDirection: 'down', trendBars: 3 }).active, false);
  assert.equal(sparseModeDecision({ side: 'long', entryPrice: 5000, price: 4930, atr1h: 30, trendDirection: 'down', trendBars: 2 }).active, false);
  assert.equal(sparseModeDecision({ active: true, side: 'long', entryPrice: 5000, price: 4940, atr1h: 30, trendDirection: 'neutral', trendBars: 0 }).active, true);
  assert.equal(sparseModeDecision({ active: true, side: 'long', entryPrice: 5000, price: 4940, atr1h: 30, trendDirection: 'neutral', trendBars: 0 }).exit, false);
  assert.equal(sparseModeDecision({ active: true, side: 'long', entryPrice: 5000, price: 4970, atr1h: 30, trendDirection: 'neutral', trendBars: 0, trendWeakBars: 2 }).active, true);
  assert.equal(sparseModeDecision({ active: true, side: 'long', entryPrice: 5000, price: 4970, atr1h: 30, trendDirection: 'neutral', trendBars: 0, trendWeakBars: 3 }).active, false);
});

test('稀疏模式采用1小时ATR和常规档距的较大值，上限为现价0.7%', () => {
  assert.equal(sparseLadderStep(5000, 10, 20), 15);
  assert.equal(sparseLadderStep(5000, 10, 200), 35);
  assert.equal(sparseGroupCount(20, 100), 5);
  assert.equal(sparseGroupCount(98, 100), 2);
  assert.equal(sparseGroupMargin('XAUUSDT', 21, 5), 125);
  assert.equal(sparseGroupMargin('XAUUSDT', 31, 5), 150);
  assert.equal(sparseGroupTrigger(5000, 15, 5, true), 4925);
  assert.deepEqual(sparseSinglePlan('XAUUSDT', 21, 20, 5000, 15, true),
    { count: 1, marginUsdt: 25, triggerPrice: 4925 });
});

test('深跌补多按剩余档位预算分三级，并要求新的小时线低点确认', () => {
  const hour = 3_600_000;
  const days = Array.from({ length: 30 }, (_, i) => [i * 24 * hour, 4950, 5000, 4900, 4950, 1, (i + 1) * 24 * hour - 1]);
  const hours = Array.from({ length: 7 }, (_, i) => [i * hour, 4450, 4460, 4440, 4450, 1, (i + 1) * hour - 1]);
  assert.equal(deepLongZone(days, hours).level, 0);
  hours[0][3] = 4380;
  assert.equal(deepLongZone(days, hours).level, 1);
  hours[0][3] = 3880;
  assert.equal(deepLongZone(days, hours).level, 2);
  hours[0][3] = 3730;
  assert.equal(deepLongZone(days, hours).level, 3);
  assert.deepEqual(deepLongBudget(20, 75, 1), { allowed: true, total: 1500, marginUsdt: 330 });
  assert.deepEqual(deepLongBudget(20, 75, 2), { allowed: true, total: 1500, marginUsdt: 525 });
  assert.deepEqual(deepLongBudget(20, 75, 3), { allowed: true, total: 1500, marginUsdt: 645 });
  hours[2][3] = 3720; hours[5][3] = 3730; hours[6][3] = 3740;
  hours[5][2] = 3750; hours[6][4] = 3760; hours[6][1] = 3745;
  assert.equal(deepLongConfirmation(hours).confirmed, true);
  assert.equal(deepLongConfirmation(hours, 3700).confirmed, false);
  const deeper = [...hours, [7 * hour, 3890, 3900, 3850, 3880, 1, 8 * hour - 1]];
  assert.equal(deepLongStageSignal(deeper, 2, 5000, 3900, 7 * hour - 1).confirmed, true);
  assert.equal(deepLongStageSignal(deeper, 2, 5000, 3900, 8 * hour - 1).confirmed, false);
  assert.equal(deepLongStageSignal(deeper, 3, 5000, 3900, 7 * hour - 1).confirmed, false);
});

test('常规补仓需触及触发价，稀疏补仓会提前挂到远端触发价', () => {
  assert.equal(shouldPlaceAddition({ side: 'long', price: 4950, triggerPrice: 4900 }), false);
  assert.equal(shouldPlaceAddition({ side: 'long', price: 4900, triggerPrice: 4900 }), true);
  assert.equal(shouldPlaceAddition({ side: 'short', price: 5050, triggerPrice: 5100 }), false);
  assert.equal(shouldPlaceAddition({ side: 'short', price: 5100, triggerPrice: 5100 }), true);
  assert.equal(shouldPlaceAddition({ sparseMode: true, side: 'long', price: 4950, triggerPrice: 4900 }), true);
});

test('手动补仓允许与策略挂单并行，但仍要求策略运行、该侧持仓亏损且没有手动补仓待单', () => {
  assert.equal(canManualAddPosition({ enabled: true, status: 'active', pending: false, phase: 'active', quantity: 0.2, pnl: -1 }), true);
  assert.equal(canManualAddPosition({ enabled: true, status: 'active', pending: false, phase: 'active', quantity: 0.2, pnl: 0 }), false);
  assert.equal(canManualAddPosition({ enabled: true, status: 'add_pending', pending: false, phase: 'active', quantity: 0.2, pnl: -1 }), true);
  assert.equal(canManualAddPosition({ enabled: true, status: 'add_pending', pending: true, phase: 'active', quantity: 0.2, pnl: -1 }), false);
  assert.equal(canManualAddPosition({ enabled: false, status: 'manual', pending: false, phase: 'active', quantity: 0.2, pnl: -1 }), false);
});

test('止盈 Maker 委托未成交且净盈亏转负时应撤单恢复仓位管理', () => {
  assert.equal(shouldCancelTakeProfit(-0.01), true);
  assert.equal(shouldCancelTakeProfit(0), true);
  assert.equal(shouldCancelTakeProfit(0.01), false);
});

test('手动同步只允许先撤销普通策略补仓单，不允许绕过开仓、平仓或手动补仓状态', () => {
  const row = { enabled: 1, status: 'add_pending' };
  const state = { pending: { kind: 'auto', side: 'BUY' }, longPhase: 'active', shortPhase: 'active' };
  assert.equal(canCancelPendingForPositionSync(row, state), true);
  assert.equal(canCancelPendingForPositionSync({ ...row, status: 'entry_pending' }, state), false);
  assert.equal(canCancelPendingForPositionSync(row, { ...state, manualPending: { orderId: 'x' } }), false);
  assert.equal(canCancelPendingForPositionSync(row, { ...state, longPhase: 'close_pending' }), false);
});

test('多空自动补仓委托分别读取，旧版单委托状态仍按方向兼容', () => {
  const longOrder = { orderId: 'long-1', side: 'BUY', direction: 'long', sparse: true };
  const shortOrder = { orderId: 'short-1', side: 'SELL', direction: 'short', sparse: false };
  const state = { pendingLong: longOrder, pendingShort: shortOrder };
  assert.equal(pendingForSide(state, 'long'), longOrder);
  assert.equal(pendingForSide(state, 'short'), shortOrder);
  assert.deepEqual(autoPendingOrders(state), [longOrder, shortOrder]);
  assert.equal(pendingForSide({ pending: shortOrder }, 'long'), null);
  assert.equal(pendingForSide({ pending: shortOrder }, 'short'), shortOrder);
  const migrated = { pending: shortOrder, ...pendingStatePatch({ pending: shortOrder }, 'long', longOrder) };
  assert.deepEqual(autoPendingOrders(migrated), [longOrder, shortOrder]);
});

test('一侧已有补仓委托时，亏损中的另一侧仍可独立触发下一笔自动补仓', () => {
  const state = { longAdditions: 5, shortAdditions: 0, pendingLong: { orderId: 'long-1', side: 'BUY', direction: 'long' } };
  assert.equal(availableAdditionDirection(state, 'long', true, true, -180, -0.2), 'short');
  assert.equal(availableAdditionDirection({ ...state, pendingShort: { orderId: 'short-1', side: 'SELL', direction: 'short' } },
    'long', true, true, -180, -0.2), null);
  assert.equal(availableAdditionDirection(state, 'short', true, true, -180, -0.2), 'short');
});

test('手动同步保留恢复状态和自动档位，仓位变化后重置旧盈利峰值', () => {
  const state = { longExpectedQty: 0.06, longLastAddPrice: 4800, longAdditions: 17, longMinPnl: -60,
    longRecovery: true, longRecoveryArmed: true, longRecoveryPeakNetPnl: 15, longSyncedManualQty: 0 };
  const position = { positionAmt: '0.1', entryPrice: '4820', leverage: '20', unRealizedProfit: '-55' };
  const summary = quantitySyncSummary(state, { long: position, short: null });
  assert.equal(summary.required, true);
  assert.ok(Math.abs(summary.sides.long.delta - 0.04) < 1e-12);
  const patch = syncLegState(state, 'long', position, 1_000, 20);
  assert.equal(patch.longExpectedQty, 0.1);
  assert.equal(patch.longLastAddPrice, 4820);
  assert.equal(patch.longAdditions, 17);
  assert.ok(Math.abs(patch.longSyncedManualQty - 0.04) < 1e-12);
  assert.ok(Math.abs(patch.longSyncedManualMarginUsdt - 9.64) < 1e-12);
  assert.equal(patch.longMinPnl, -60);
  assert.equal(patch.longRecovery, true);
  assert.equal(patch.longRecoveryArmed, false);
  assert.equal(patch.longRecoveryPeakNetPnl, 0);
});

test('启动前允许设置单边保证金和杠杆，并限制最大值', () => {
  assert.deepEqual(requestedConfig({ marginUsdt: 20, leverage: 50 }), { marginUsdt: 20, leverage: 50 });
  assert.throws(() => requestedConfig({ marginUsdt: 20.1, leverage: 10 }), /20 USDT/);
  assert.deepEqual(requestedConfig({ marginUsdt: 100, leverage: 20 }, 'XAUUSDT'), { marginUsdt: 100, leverage: 20 });
  assert.throws(() => requestedConfig({ marginUsdt: 100.1, leverage: 20 }, 'XAUUSDT'), /100 USDT/);
  assert.throws(() => requestedConfig({ marginUsdt: 20.1, leverage: 10 }, 'XAGUSDT'), /20 USDT/);
  assert.throws(() => requestedConfig({ marginUsdt: 10, leverage: 51 }), /50 倍/);
});

test('恢复接管时允许修改后续单笔本金，并强制保留原杠杆', () => {
  assert.deepEqual(resumedConfig({ marginUsdt: 20, leverage: 25 }, { marginUsdt: 8, leverage: 50 }), { marginUsdt: 8, leverage: 25 });
  assert.deepEqual(resumedConfig({ marginUsdt: 20, leverage: 25 }, {}), { marginUsdt: 20, leverage: 25 });
  assert.throws(() => resumedConfig({ marginUsdt: 20, leverage: 25 }, { marginUsdt: 21 }), /20 USDT/);
  assert.deepEqual(resumedConfig({ marginUsdt: 20, leverage: 25 }, { marginUsdt: 100 }, 'XAUUSDT'), { marginUsdt: 100, leverage: 25 });
  assert.throws(() => resumedConfig({ marginUsdt: 10, leverage: 10 }, { marginUsdt: 21 }, 'XAGUSDT'), /20 USDT/);
});

test('停止后忽略并发中的旧策略状态写入，避免刷新后自动恢复运行', () => {
  const stoppedRow = { enabled: 0 };
  assert.equal(ignoreStaleStrategySave(stoppedRow, { status: 'active' }), true);
  assert.equal(ignoreStaleStrategySave(stoppedRow, { enabled: 1, status: 'active' }), true);
  assert.equal(ignoreStaleStrategySave(stoppedRow, { enabled: 0, status: 'paused' }), false);
  assert.equal(ignoreStaleStrategySave({ enabled: 1 }, { status: 'active' }), false);
});

test('震荡高频止盈以 0.4U 或单边名义价值的 0.02% 为净利润缓冲', () => {
  assert.equal(scalpProfitTarget(200), 0.4);
  assert.equal(scalpProfitTarget(3000), 0.6);
});

test('回放止盈只把资金费支出计入触发门槛，资金费收入仍保留在结算盈亏', () => {
  const pricePnl = 100;
  assert.equal(takeProfitNetPnl({ pricePnl, funding: 700, entryFee: 10, exitFee: 10 }), 80);
  assert.equal(takeProfitNetPnl({ pricePnl, funding: -30, entryFee: 10, exitFee: 10 }), 50);
});

test('币安返回零 Maker 费率时，止盈计算保留零费率', () => {
  assert.equal(commissionRate('0', 0.0002), 0);
  assert.equal(commissionRate(undefined, 0.0002), 0.0002);
});

test('商品 TradFi 能识别周末流动性时段', () => {
  assert.equal(isCommodityWeekendMode(new Date('2026-09-25T20:59:00Z')), false);
  assert.equal(isCommodityWeekendMode(new Date('2026-09-25T21:00:00Z')), true);
  assert.equal(isCommodityWeekendMode(new Date('2026-09-27T21:59:00Z')), true);
  assert.equal(isCommodityWeekendMode(new Date('2026-09-27T22:00:00Z')), false);
  assert.equal(isCommodityWeekendMode(new Date('2026-03-15T16:04:00Z')), true); // 北京时间周一 00:04，纽约仍为周日
  assert.equal(isCommodityWeekendMode(new Date('2026-03-22T22:00:00Z')), false); // 北京时间周一 06:00
});

test('订单状态识别完整成交、部分成交与未成交', () => {
  assert.equal(orderFillState({ status: 'FILLED', executedQty: '0.1', origQty: '0.1' }), 'filled');
  assert.equal(orderFillState({ status: 'PARTIALLY_FILLED', executedQty: '0.04', origQty: '0.1' }), 'partial');
  assert.equal(orderFillState({ status: 'CANCELED', executedQty: '0', origQty: '0.1' }), 'unfilled');
  assert.equal(orderFillState({ status: 'NEW', executedQty: '0', origQty: '0.1' }), 'open');
  assert.equal(isCanceledWithoutFill({ status: 'CANCELED', executedQty: '0' }), true);
  assert.equal(isCanceledWithoutFill({ status: 'NEW', executedQty: '0' }), false);
  assert.equal(isCanceledWithoutFill({ status: 'CANCELED', executedQty: '0.01' }), false);
});

test('行情新鲜度要求15分钟K线不超过30分钟、1小时K线不超过2小时', () => {
  const now = 10_000_000;
  const recent15m = [[0, 1, 1, 1, 1, 1, now - 15 * 60_000]];
  const recent1h = [[0, 1, 1, 1, 1, 1, now - 60 * 60_000]];
  assert.equal(marketDataFreshness(recent15m, recent1h, now).fresh, true);
  const stale15m = [[0, 1, 1, 1, 1, 1, now - 31 * 60_000]];
  assert.equal(marketDataFreshness(stale15m, recent1h, now).fresh, false);
  const stale1h = [[0, 1, 1, 1, 1, 1, now - 121 * 60_000]];
  assert.equal(marketDataFreshness(recent15m, stale1h, now).fresh, false);
  assert.equal(marketDataFreshness([[0, 1, 1, 1, 1, 1]], recent1h, now).fresh, false);
});

test('止盈保护价覆盖目标净利润和预估成本', () => {
  const position = { positionAmt: '0.1', entryPrice: '4800' };
  const costs = { profitTarget: 0.4, estimatedCosts: 0.2 };
  assert.equal(profitGuardPrice(position, 'LONG', costs), 4806);
  assert.equal(profitGuardPrice(position, 'SHORT', costs), 4794);
});

test('合约级资金费只计入一次，并由当前盈利较高的一侧承担', () => {
  assert.deepEqual(allocateFundingCharge(-1.2, 3, -2), { long: -1.2, short: 0 });
  assert.deepEqual(allocateFundingCharge(-1.2, -2, 3), { long: 0, short: -1.2 });
  assert.deepEqual(allocateFundingCharge(0.8, 3, -2), { long: 0, short: 0 });
});

test('恢复接管以交易所实际数量为准并保留原补仓状态', () => {
  const positions = {
    long: { positionAmt: '0.35', entryPrice: '4800', leverage: '20', unRealizedProfit: '-3.2' },
    short: { positionAmt: '-0.2', entryPrice: '4820', leverage: '20', unRealizedProfit: '1.1' },
  };
  assert.deepEqual(positionAdoptionSummary(positions).long, { quantity: 0.35, entryPrice: 4800, leverage: 20, unrealizedPnl: -3.2 });
  const patch = adoptedLegState({ longAdditions: 6, longExpectedQty: 0.3, longLastAddPrice: 4790, longMinPnl: -8 }, 'long', positions.long);
  assert.equal(patch.longExpectedQty, 0.35);
  assert.equal(patch.longAdditions, 6);
  assert.equal(patch.longLastAddPrice, 4790);
  assert.equal(patch.longMinPnl, -8);
  assert.equal(patch.longPhase, 'active');
});

test('接管时空仓方向始终安排重建冷却，不因周末将其挂起', () => {
  const now = Date.now();
  const patch = adoptedLegState({}, 'short', { positionAmt: '0', entryPrice: '0' });
  assert.equal(patch.shortPhase, 'reentry_wait');
  assert.ok(patch.shortReentryAt >= now + 9_000);
});

test('平仓重挂只使用策略委托尚未成交的数量', () => {
  assert.ok(Math.abs(closeOrderRemaining({ quantity: '0.1' }, { executedQty: '0.04' }) - 0.06) < 1e-12);
  assert.equal(closeOrderRemaining({ quantity: '0.1' }, { executedQty: '0.1' }), 0);
});

test('补仓按多空分别计数，多头100档、空头20档到顶后等待而不转人工', () => {
  assert.equal(additionDecision({ longAdditions: 99, shortAdditions: 20 }, true).next, 100);
  assert.equal(additionDecision({ longAdditions: 100, shortAdditions: 19 }, true).action, 'wait');
  assert.equal(additionDecision({ longAdditions: 100, shortAdditions: 19 }, false).next, 20);
  assert.equal(additionDecision({ longAdditions: 100, shortAdditions: 20 }, false).action, 'wait');
  assert.equal(sparseGroupCount(18, MAX_SHORT_ADDITIONS), 2);
  assert.deepEqual(countedAdditions({ longAdditions: 20, shortAdditions: 3 }, true, 5), { longAdditions: 25, shortAdditions: 3, total: 28, next: 25 });
});

test('每次平仓使用新的客户订单号，避免币安报 ClientOrderId 重复', () => {
  const ids = new Set([closeClientId('cycle1234', 'LONG'), closeClientId('cycle1234', 'LONG'), closeClientId('cycle1234', 'SHORT')]);
  assert.equal(ids.size, 3);
  for (const id of ids) {
    assert.match(id, /^wtf_c_[A-Za-z0-9]+_[LS][a-f0-9]+$/);
    assert.ok(id.length <= 36);
  }
});

test('识别币安 Post Only Maker 拒单并允许安全换价重试', () => {
  assert.equal(isPostOnlyReject({ code: -5022, message: 'rejected' }), true);
  assert.equal(isPostOnlyReject({ message: 'Due to the order could not be executed as maker, the Post Only order will be rejected.' }), true);
  assert.equal(isPostOnlyReject({ code: -2013, message: 'Order does not exist.' }), false);
});

test('识别币安请求超时，以便平仓后的下一轮恢复', () => {
  assert.equal(isRequestTimeout({ message: 'timeout of 12000ms exceeded' }), true);
  assert.equal(isRequestTimeout({ message: 'Order does not exist.' }), false);
});

test('空头恢复模式继续按 ATR 回撤或震荡目标止盈', () => {
  assert.deepEqual(recoveryExitState({ recovery: true, armed: true, netPnl: 8, peakNetPnl: 10, trail: 1.5, trend: true, target: 6 }), { shouldClose: true, reason: '恢复模式利润回撤触发' });
  assert.deepEqual(recoveryExitState({ recovery: true, armed: true, netPnl: 6, peakNetPnl: 6, trail: 1.5, trend: false, target: 6 }), { shouldClose: true, reason: '恢复模式目标达成' });
  assert.equal(recoveryExitState({ recovery: true, armed: false, netPnl: 8, peakNetPnl: 10, trail: 1.5, trend: true, target: 6 }).shouldClose, false);
});

test('停止后恢复及接管确认重试均保留原仓位档位，空仓重启不沿用旧档位', () => {
  const config = { marginUsdt: 20, leverage: 20 };
  const previous = { cycleId: 'managed-cycle', expectedLong: 0.35, longAdditions: 40,
    shortAdditions: 7, longManualMarginUsdt: 200,
    pausedPositions: { long: { quantity: 0.35 }, short: { quantity: 0.2 } } };
  const paused = restartState({ status: 'paused' }, previous, config);
  assert.equal(paused.savedPosition, true);
  assert.equal(paused.initialState.longAdditions, 40);
  assert.equal(paused.initialState.shortAdditions, 7);
  assert.equal(paused.initialState.longManualMarginUsdt, 200);
  assert.equal(paused.initialState.resumeEligible, true);
  const retry = restartState({ status: 'adoption_required' }, previous, config, { adoptExisting: true });
  assert.equal(retry.initialState.longAdditions, 40);
  assert.equal(retry.initialState.shortAdditions, 7);
  assert.equal(retry.initialState.resumeEligible, true);
  assert.equal(retry.initialState.adoptExisting, true);
  const fresh = restartState({ status: 'paused' }, { pausedPositions: { long: { quantity: 0 }, short: { quantity: 0 } } }, config);
  assert.equal(fresh.savedPosition, false);
  assert.equal(fresh.initialState.longAdditions, undefined);
  const stale = restartState({ status: 'paused' }, { expectedLong: 0.35, longAdditions: 40,
    pausedPositions: { long: { quantity: 0 }, short: { quantity: 0 } } }, config);
  assert.equal(stale.savedPosition, false);
  assert.equal(stale.initialState.longAdditions, undefined);
  const foreign = restartState({ status: 'adoption_required' }, { longAdditions: 40 }, config, { adoptExisting: true });
  assert.equal(foreign.initialState.longAdditions, undefined);
  assert.equal(foreign.initialState.adoptExisting, true);
});

test('多头恢复模式达标后追踪峰值，并以目标利润作为最低触发线', () => {
  const decide = (netPnl, peakNetPnl, armed = true) => longRecoveryExitState({
    recovery: true, armed, netPnl, peakNetPnl, target: 1000,
  });
  assert.deepEqual(decide(1000, 1000), { shouldClose: false, reason: '多头恢复模式追踪止盈', trigger: 1000 });
  assert.equal(decide(1100, 1200).shouldClose, false);
  assert.equal(decide(1000, 1200).shouldClose, true);
  assert.equal(decide(1400, 1800).shouldClose, false);
  assert.equal(decide(1350, 1800).shouldClose, true);
  assert.equal(decide(900, 1200, false).shouldClose, false);
});
