const assert = require('node:assert/strict');
const test = require('node:test');

const tradeDependency = require.resolve('../lib/binanceTradfiTrade');
require.cache[tradeDependency] = {
  id: tradeDependency,
  filename: tradeDependency,
  loaded: true,
  exports: {
    symbolRules: async () => ({
      status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT',
      filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.1' },
        { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
        { filterType: 'MIN_NOTIONAL', notional: '5' },
      ],
    }),
    publicGet: async (path) => path.endsWith('/bookTicker') ? { askPrice: '100.1', bidPrice: '99.9' } : { price: '100' },
    stepped: (value, step, mode = 'floor') => {
      const units = Number(value) / Number(step);
      return String((mode === 'ceil' ? Math.ceil(units - 1e-9) : Math.floor(units + 1e-9)) * Number(step));
    },
    signedRequest: async () => { throw new Error('real trade must not run in this test'); },
  },
};

const { planStance } = require('../lib/binanceCryptoTrade');
const { normalizeAnalysisResult } = require('../lib/analysisResult');
const { placeStanceOrder } = require('../lib/okxTradeClient');
const { computeEventReaction } = require('../lib/marketBrief');
const { validatedAiOrder } = require('../lib/cryptoAiOrderGate');

const valid = {
  execution: '现在可开', coin: 'ETH', action: '做多', entry: 99,
  stop: 90, takeProfit: 110, amountUsd: 100, leverage: 5,
};

test('币安预览限制本金和杠杆，并要求止盈止损', async () => {
  await assert.rejects(planStance({ ...valid, amountUsd: 100.01 }), /100 USDT/);
  await assert.rejects(planStance({ ...valid, leverage: 10 }), /固定使用 5/);
  await assert.rejects(planStance({ ...valid, stop: undefined }), /止损/);
  await assert.rejects(planStance({ ...valid, takeProfit: undefined }), /止盈/);
  await assert.rejects(planStance({ ...valid, execution: '等待触发' }), /不适用于所选下单模式/);
});

test('币安实际委托价和预览价一致，并核算到止损的损失', async () => {
  const plan = await planStance(valid);
  assert.equal(Number(plan.price), 99);
  assert.equal(plan.leverage, 5);
  assert.equal(plan.last, 100);
  assert.ok(plan.estimatedLossUsdt > 0);
  await assert.rejects(planStance({ ...valid, expectedPrice: 98.9 }), /重新预览/);
  await assert.rejects(planStance({ ...valid, entry: 100.1 }), /无法作为 Maker/);
  assert.equal(Number((await planStance({ ...valid, entry: 99.97 })).price), 99.9);
});

test('手动挂单模式按 AI 的低位入场价提交预览，不强迫贴近现价', async () => {
  const plan = await planStance({ ...valid, execution: '等待触发', orderMode: 'pending', entry: 95 });
  assert.equal(Number(plan.price), 95);
  assert.equal(plan.last, 100);
  assert.equal(plan.orderMode, 'pending');
  await assert.rejects(planStance({ ...valid, execution: '等待触发', orderMode: 'pending', entry: 105 }), /有利于当前方向/);
});

test('OKX 在网络请求前拒绝超限和缺保护条件', async () => {
  await assert.rejects(placeStanceOrder({ ...valid, leverage: 10 }, { dryRun: true }), /固定使用 5/);
  await assert.rejects(placeStanceOrder({ ...valid, takeProfit: 0 }, { dryRun: true }), /stop\/tp/);
  await assert.rejects(placeStanceOrder({ ...valid, execution: '等待触发' }, { dryRun: true }), /不适用于所选下单模式/);
});

test('缺乏方向时不再默认做多', () => {
  const output = normalizeAnalysisResult({
    short_term: { direction: '观望', summary: '证据不足' },
    personal_stance: { short: { action: '观望', execution: '现在可开', entry: 100, leverage: 20, stop: 90, take_profit: 110 } },
  }).result;
  assert.equal(output.personal_stance.short.action, '观望');
  assert.equal(output.personal_stance.short.execution, '禁止下单');
  assert.equal(output.personal_stance.short.leverage, 5);
});

test('AI 入场价的多维验证随结构化结果保存', () => {
  const output = normalizeAnalysisResult({
    short_term: { direction: '偏多', summary: '回踩待确认' },
    mid_long_term: { direction: '偏多' },
    personal_stance: { short: { action: '做多', execution: '等待触发', entry: 95, leverage: 5, stop: 90, take_profit: 110,
      entry_validation: { technical: '95 支撑', sentiment: '费率温和', news_macro: '暂无事件', positioning: '大户偏多', decision: '支持' } } },
  }).result;
  assert.equal(output.personal_stance.short.entry_validation.decision, '支持');
  assert.equal(output.personal_stance.short.entry_validation.technical, '95 支撑');
});

test('只在有可对齐公布时间和 K 线时给出事件后价格反应', () => {
  const eventAt = Date.now() - 20 * 60 * 1000;
  const shanghai = new Date(eventAt + 8 * 60 * 60 * 1000).toISOString();
  const date = shanghai.slice(0, 10);
  const time = shanghai.slice(11, 16);
  const bars = [
    { t: eventAt - 5 * 60 * 1000, c: 100, h: 101, l: 99 },
    { t: eventAt, c: 99, h: 100, l: 98 },
    { t: eventAt + 5 * 60 * 1000, c: 102, h: 103, l: 99 },
  ];
  const tech = { m5: { source: 'binance-fapi', chart: { candles: bars } } };
  const reaction = computeEventReaction([{ title: '非农就业', date, time, forecast: '100K', actual: '80K' }], tech);
  assert.equal(reaction.first5mLowPct, -2);
  assert.equal(reaction.latestClosePct, 2);
  assert.equal(computeEventReaction([{ title: '非农就业', date, time, actual: '' }], tech), null);
});

test('下单仅接受同一用户的近期分析及对应周期计划', () => {
  const row = {
    status: 'done', userId: 'u1', coin: 'ETH', createdAt: Date.now(),
    contextSummary: { asOf: Date.now(), charts: { hour: { candles: [1] }, day: null } },
    capability: { shortTerm: { status: 'ok' } },
    result: { personal_stance: { short: { action: '做多', execution: '现在可开', entry: 100, stop: 90, take_profit: 110, leverage: 5 } } },
  };
  const read = () => row;
  const body = { analysisId: 'a1', horizon: 'short', amountUsd: 10, action: '做空', stop: 1 };
  const safe = validatedAiOrder(body, 'u1', read);
  assert.equal(safe.action, '做多');
  assert.equal(safe.stop, 90);
  assert.throws(() => validatedAiOrder(body, 'u2', read), /找不到/);
  assert.throws(() => validatedAiOrder({ ...body, horizon: 'mid_long' }, 'u1', read), /周期行情数据不足/);
  row.createdAt -= 21 * 60_000;
  assert.throws(() => validatedAiOrder(body, 'u1', read), /已过期/);
});

test('挂单模式要求大方向一致、AI 已验证价位，并只采纳保存的计划', () => {
  const row = {
    status: 'done', userId: 'u1', coin: 'BTC', createdAt: Date.now(),
    contextSummary: { asOf: Date.now(), charts: { hour: {} } },
    capability: { shortTerm: { status: 'ok' } },
    result: {
      mid_long_term: { direction: '偏多' },
      personal_stance: { short: { action: '做多', execution: '等待触发', entry: 95, stop: 90, take_profit: 110, leverage: 5,
        entry_validation: { decision: '支持', technical: '95 支撑', sentiment: '费率偏低', news_macro: '暂无事件', positioning: '大户多头增加' } } },
    },
  };
  const body = { analysisId: 'a1', horizon: 'short', amountUsd: 50, orderMode: 'pending', entry: 1, action: '做空' };
  const safe = validatedAiOrder(body, 'u1', () => row);
  assert.equal(safe.entry, 95);
  assert.equal(safe.action, '做多');
  assert.equal(safe.orderMode, 'pending');
  row.result.mid_long_term.direction = '偏空';
  assert.throws(() => validatedAiOrder(body, 'u1', () => row), /方向必须/);
  row.result.mid_long_term.direction = '偏多';
  row.result.personal_stance.short.entry_validation.decision = '数据不足';
  assert.throws(() => validatedAiOrder(body, 'u1', () => row), /尚未完成/);
});
