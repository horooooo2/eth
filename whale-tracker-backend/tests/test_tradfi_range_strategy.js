const assert = require('node:assert/strict');
const test = require('node:test');
const { takeProfitNetPnl, shouldPlaceAddition, canManualAddPosition, shouldCancelTakeProfit } = require('../lib/tradfiRangeCore.cjs');
const { canCancelPendingForPositionSync, pendingForSide, pendingStatePatch, autoPendingOrders, availableAdditionDirection } = require('../lib/tradfiRangeStrategy');

function candles(start, count, step, spread = 2) {
  return Array.from({ length: count }, (_, i) => {
    const close = start + i * step;
    return [i, close, close + spread, close - spread, close, 1];
  });
}

const { marketState, ladderStep, sparseLadderStep, sparseModeDecision, sparseGroupCount, sparseGroupMargin, sparseGroupTrigger,
  ladderMargin, defaultConfig, requestedConfig, resumedConfig, isPostOnlyReject, isRequestTimeout, recoveryExitState,
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

test('黄金与白银使用各自默认本金和杠杆，多空补仓上限分别为100档和50档', () => {
  assert.equal(MARGIN, 20);
  assert.equal(LEVERAGE, 20);
  assert.equal(MAX_ADDITIONS, 100);
  assert.equal(MAX_LONG_ADDITIONS, 100);
  assert.equal(MAX_SHORT_ADDITIONS, 50);
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

test('手动同步更新交易所数量与均价，保留恢复状态和自动档位，手动增量单独核算', () => {
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
  assert.equal(patch.longRecoveryPeakNetPnl, 15);
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
