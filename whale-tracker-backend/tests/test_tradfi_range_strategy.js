const assert = require('node:assert/strict');
const test = require('node:test');

function candles(start, count, step, spread = 2) {
  return Array.from({ length: count }, (_, i) => {
    const close = start + i * step;
    return [i, close, close + spread, close - spread, close, 1];
  });
}

const { marketState, ladderStep, sparseLadderStep, sparseModeDecision, sparseGroupCount, sparseGroupMargin, sparseGroupTrigger,
  ladderMargin, defaultConfig, requestedConfig, resumedConfig, isPostOnlyReject, isRequestTimeout, recoveryExitState,
  closeClientId, closeOrderRemaining, additionDecision, countedAdditions, scalpProfitTarget, commissionRate,
  isCommodityWeekendMode, orderFillState, profitGuardPrice, allocateFundingCharge, positionAdoptionSummary, adoptedLegState,
  MAX_ADDITIONS, MAX_LONG_ADDITIONS, MAX_SHORT_ADDITIONS, MANUAL_ADD_THRESHOLD, MARGIN, LEVERAGE } = require('../lib/tradfiRangeStrategy');

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

test('黄金与白银使用各自默认本金和杠杆，多空补仓上限分别为100档和50档', () => {
  assert.equal(MARGIN, 20);
  assert.equal(LEVERAGE, 20);
  assert.equal(MAX_ADDITIONS, 100);
  assert.equal(MAX_LONG_ADDITIONS, 100);
  assert.equal(MAX_SHORT_ADDITIONS, 50);
  assert.equal(MANUAL_ADD_THRESHOLD, 20);
  assert.deepEqual(defaultConfig('XAUUSDT'), { marginUsdt: 20, leverage: 20, ladder: [10, 15, 25, 30] });
  assert.deepEqual(defaultConfig('XAGUSDT'), { marginUsdt: 10, leverage: 10, ladder: [5, 7.5, 12.5, 15] });
});

test('阶梯补仓每10档调整保证金并延续到多头100档、空头50档', () => {
  assert.deepEqual([1, 10, 11, 20, 21, 30, 31, 40, 100].map((level) => ladderMargin('XAUUSDT', level)), [10, 10, 15, 15, 25, 25, 30, 30, 30]);
  assert.deepEqual([1, 11, 21, 31].map((level) => ladderMargin('XAGUSDT', level)), [5, 7.5, 12.5, 15]);
  assert.equal(Array.from({ length: 100 }, (_, i) => ladderMargin('XAUUSDT', i + 1)).reduce((a, b) => a + b, 0), 2600);
  assert.equal(Array.from({ length: 50 }, (_, i) => ladderMargin('XAUUSDT', i + 1)).reduce((a, b) => a + b, 0), 1100);
  assert.equal(Array.from({ length: 100 }, (_, i) => ladderMargin('XAGUSDT', i + 1)).reduce((a, b) => a + b, 0), 1300);
  assert.equal(Array.from({ length: 50 }, (_, i) => ladderMargin('XAGUSDT', i + 1)).reduce((a, b) => a + b, 0), 550);
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
});

test('启动前允许设置单边保证金和杠杆，并限制最大值', () => {
  assert.deepEqual(requestedConfig({ marginUsdt: 20, leverage: 50 }), { marginUsdt: 20, leverage: 50 });
  assert.throws(() => requestedConfig({ marginUsdt: 20.1, leverage: 10 }), /20 USDT/);
  assert.throws(() => requestedConfig({ marginUsdt: 10, leverage: 51 }), /50 倍/);
});

test('恢复接管时允许修改后续单笔本金，并强制保留原杠杆', () => {
  assert.deepEqual(resumedConfig({ marginUsdt: 20, leverage: 25 }, { marginUsdt: 8, leverage: 50 }), { marginUsdt: 8, leverage: 25 });
  assert.deepEqual(resumedConfig({ marginUsdt: 20, leverage: 25 }, {}), { marginUsdt: 20, leverage: 25 });
  assert.throws(() => resumedConfig({ marginUsdt: 20, leverage: 25 }, { marginUsdt: 21 }), /20 USDT/);
});

test('震荡高频止盈以 0.4U 或单边名义价值的 0.02% 为净利润缓冲', () => {
  assert.equal(scalpProfitTarget(200), 0.4);
  assert.equal(scalpProfitTarget(3000), 0.6);
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
});

test('订单状态识别完整成交、部分成交与未成交', () => {
  assert.equal(orderFillState({ status: 'FILLED', executedQty: '0.1', origQty: '0.1' }), 'filled');
  assert.equal(orderFillState({ status: 'PARTIALLY_FILLED', executedQty: '0.04', origQty: '0.1' }), 'partial');
  assert.equal(orderFillState({ status: 'CANCELED', executedQty: '0', origQty: '0.1' }), 'unfilled');
  assert.equal(orderFillState({ status: 'NEW', executedQty: '0', origQty: '0.1' }), 'open');
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

test('补仓按多空分别计数，多头100档、空头50档到顶后各自停止', () => {
  assert.equal(additionDecision({ longAdditions: 99, shortAdditions: 20 }, true).next, 100);
  assert.equal(additionDecision({ longAdditions: 100, shortAdditions: 20 }, true).action, 'wait');
  assert.equal(additionDecision({ longAdditions: 100, shortAdditions: 49 }, false).next, 50);
  assert.equal(additionDecision({ longAdditions: 100, shortAdditions: 50 }, false).action, 'manual');
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

test('恢复模式达到目标后用 ATR 回撤锁定利润，震荡则直接兑现目标', () => {
  assert.deepEqual(recoveryExitState({ recovery: true, armed: true, netPnl: 8, peakNetPnl: 10, trail: 1.5, trend: true, target: 6 }), { shouldClose: true, reason: '恢复模式利润回撤触发' });
  assert.deepEqual(recoveryExitState({ recovery: true, armed: true, netPnl: 6, peakNetPnl: 6, trail: 1.5, trend: false, target: 6 }), { shouldClose: true, reason: '恢复模式目标达成' });
  assert.equal(recoveryExitState({ recovery: true, armed: false, netPnl: 8, peakNetPnl: 10, trail: 1.5, trend: true, target: 6 }).shouldClose, false);
});
