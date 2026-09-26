const assert = require('node:assert/strict');
const test = require('node:test');

function candles(start, count, step, spread = 2) {
  return Array.from({ length: count }, (_, i) => {
    const close = start + i * step;
    return [i, close, close + spread, close - spread, close, 1];
  });
}

const { marketState, ladderStep, requestedConfig, isPostOnlyReject, isRequestTimeout, recoveryExitState, closeClientId, closeOrderRemaining, additionDecision, scalpProfitTarget, commissionRate, isCommodityWeekendMode, orderFillState, profitGuardPrice, allocateFundingCharge, positionAdoptionSummary, adoptedLegState, MAX_ADDITIONS, MARGIN, LEVERAGE } = require('../lib/tradfiRangeStrategy');

test('黄金窄幅结构允许震荡监控，明显单边结构识别为趋势', () => {
  const range15 = candles(1800, 48, 0.02, 2);
  const range60 = candles(1800, 30, 0.05, 3);
  assert.equal(marketState(range15, range60).rangeReady, true);
  const trend15 = candles(1800, 48, 2, 2);
  const trend60 = candles(1800, 30, 8, 4);
  assert.equal(marketState(trend15, trend60).trend, true);
});

test('策略固定为10U、10倍、单边最多20次补仓', () => {
  assert.equal(MARGIN, 10);
  assert.equal(LEVERAGE, 10);
  assert.equal(MAX_ADDITIONS, 20);
});

test('补仓间距使用15分钟 ATR 的 0.6 倍，并限制在现价的 0.08% 到 0.35%', () => {
  assert.equal(ladderStep(4800, 8), 4.8);
  assert.equal(ladderStep(4800, 15), 9);
  assert.equal(ladderStep(4800, 35), 16.8);
});

test('启动前允许设置单边保证金和杠杆，并限制最大值', () => {
  assert.deepEqual(requestedConfig({ marginUsdt: 20, leverage: 50 }), { marginUsdt: 20, leverage: 50 });
  assert.throws(() => requestedConfig({ marginUsdt: 20.1, leverage: 10 }), /20 USDT/);
  assert.throws(() => requestedConfig({ marginUsdt: 10, leverage: 51 }), /50 倍/);
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

test('周末切换能区分完整成交、部分成交与未成交', () => {
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

test('平仓重挂只使用策略委托尚未成交的数量', () => {
  assert.ok(Math.abs(closeOrderRemaining({ quantity: '0.1' }, { executedQty: '0.04' }) - 0.06) < 1e-12);
  assert.equal(closeOrderRemaining({ quantity: '0.1' }, { executedQty: '0.1' }), 0);
});

test('补仓按多空分别计数，单侧满 20 次后只停止该侧', () => {
  assert.equal(additionDecision({ longAdditions: 19, shortAdditions: 20 }, true).action, 'add');
  assert.equal(additionDecision({ longAdditions: 20, shortAdditions: 3 }, true).action, 'wait');
  assert.equal(additionDecision({ longAdditions: 20, shortAdditions: 3 }, false).action, 'add');
  assert.equal(additionDecision({ longAdditions: 20, shortAdditions: 20 }, true).action, 'manual');
  assert.equal(additionDecision({ longAdditions: 20, shortAdditions: 20 }, false).action, 'manual');
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
