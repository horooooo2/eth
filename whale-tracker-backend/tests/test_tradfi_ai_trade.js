const assert = require('node:assert/strict');
const test = require('node:test');

function stub(path, exports) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

const calls = [];
const algoQty = new Map();
let marketPrice = 100;
let lastPrompt = '';
let staleMinuteBars = false;
const requestedIntervals = [];
let modelOutput = {
  marketState: '趋势', decision: '可挂单', fundamentalBias: '偏多', thesis: '基本面与日线支持做多', invalidation: '跌破结构支撑',
  direction: '做多', reason: '小时线支撑与日线方向一致', shortView: '偏多', longView: '偏多',
  evidence: ['小时线支撑'], leverage: 3, stop: 88, takeProfit: 110,
  orders: [{ price: 99, marginUsdt: 100, reason: '初始支撑' }, { price: 95, marginUsdt: 100, reason: '回踩支撑' }, { price: 90, marginUsdt: 100, reason: '深度支撑' }],
};
stub('../lib/tradfiMarkets', { getCatalog: async () => ({ symbols: [{ symbol: 'XAUUSDT', baseAsset: 'XAU', name: '黄金', category: 'COMMODITY' }] }) });
stub('../lib/tradfiIntel', { getIntel: async () => ({ news: { items: [{ title: '测试新闻', publishedAt: new Date().toISOString() }] }, fundamentals: { rows: [], status: 'unavailable' }, events: { items: [] } }) });
stub('../lib/tradfiWhales', { getWhaleActivity: async () => ({ rows: [], coverageNote: '样本为空' }) });
stub('../lib/tradfiAiMonitor', { isRunning: () => true, register: () => {} });
stub('../lib/deepseekClient', {
  DEFAULT_MODEL: 'test-model',
  deepseekFetch: async (_key, _path, request) => {
    lastPrompt = request.body.messages[1].content;
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(modelOutput) } }] };
  },
});
stub('../lib/binanceTradfiTrade', {
  publicGet: async (path, params = {}) => {
    if (path.endsWith('/bookTicker')) return { bidPrice: '99.9', askPrice: '100.1' };
    if (path.endsWith('/price')) return { price: String(marketPrice) };
    if (path.endsWith('/premiumIndex')) return { markPrice: '100', indexPrice: '100', lastFundingRate: '0' };
    if (path.endsWith('/klines')) {
      requestedIntervals.push(params.interval);
      return Array.from({ length: 72 }, (_, i) => {
        const close = params.interval === '1d' ? 108 - i * 0.1 : params.interval === '1m' ? 95 + i * 0.07 : 100;
        return [i, String(close), String(close + 1), String(close - 1), String(close), '50', staleMinuteBars && params.interval === '1m' ? Date.now() - 10 * 60_000 : undefined];
      });
    }
    throw new Error(path);
  },
  symbolRules: async () => ({ status: 'TRADING', filters: [
    { filterType: 'PRICE_FILTER', tickSize: '0.1' },
    { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
    { filterType: 'MIN_NOTIONAL', notional: '5' },
  ] }),
  stepped: (value, step, mode = 'floor') => {
    const units = Number(value) / Number(step);
    return String((mode === 'ceil' ? Math.ceil(units - 1e-9) : Math.floor(units + 1e-9)) * Number(step));
  },
  signedRequest: async (_creds, method, path, params = {}) => {
    calls.push({ method, path, params });
    if (path.endsWith('/positionSide/dual')) return { dualSidePosition: false };
    if (path.endsWith('/positionRisk')) return [];
    if (path.endsWith('/leverage')) return { leverage: 3 };
    if (path.endsWith('/algoOrder') && method === 'POST') {
      const algoId = algoQty.size + 1;
      algoQty.set(algoId, params.quantity);
      return { algoId };
    }
    if (path.endsWith('/algoOrder') && method === 'GET') return { algoStatus: 'NEW', side: 'SELL', quantity: algoQty.get(Number(params.algoId)) };
    if (path.endsWith('/order') && method === 'POST') return { orderId: calls.length, status: 'NEW' };
    throw new Error(`${method} ${path}`);
  },
});

const { analyzeTradfiAi, previewTradfiAi, placeTradfiAi, previewFingerprint, normalizeModelPlan } = require('../lib/tradfiAiTrade');

test('AI 加仓计划必须恰好三档、同方向递进并附有有效止损', () => {
  assert.throws(() => normalizeModelPlan({ ...modelOutput,
    orders: [{ price: 99, marginUsdt: 100, reason: '支撑' }] }, 'ladder', 100), /档位/);
  assert.throws(() => normalizeModelPlan({ ...modelOutput,
    orders: [{ price: 99, marginUsdt: 100, reason: '支撑' }, { price: 100, marginUsdt: 100, reason: '错误加仓' }, { price: 90, marginUsdt: 100, reason: '支撑' }] }, 'ladder', 100), /排序/);
  assert.equal(normalizeModelPlan({ ...modelOutput, fundamentalBias: '偏空' }, 'ladder', 100).decision, '可挂单');
});

test('盘中小时与分钟走势可独立于日线和基本面形成挂单计划', async () => {
  modelOutput = { ...modelOutput, fundamentalBias: '偏空', dayView: '日线仍在回落，盘中交易需收紧风险', orders: [modelOutput.orders[0]] };
  const analysis = await analyzeTradfiAi('user1', 'fake-key', 'XAUUSDT', 'single');
  assert.equal(analysis.plan.decision, '可挂单');
  assert.equal(analysis.plan.fundamentalBias, '偏空');
  assert.equal(analysis.plan.dayView, '日线仍在回落，盘中交易需收紧风险');
  assert.deepEqual([...new Set(requestedIntervals)].sort(), ['15m', '1d', '1h', '1m', '5m']);
  assert.match(lastPrompt, /"minute":\{/);
  assert.match(lastPrompt, /"fiveMinute":\{/);
  assert.match(lastPrompt, /"quarterHour":\{/);
  assert.match(lastPrompt, /连续上涨不能仅因/);
  modelOutput = { ...modelOutput, fundamentalBias: '偏多', dayView: '', orders: [
    { price: 99, marginUsdt: 100, reason: '初始支撑' }, { price: 95, marginUsdt: 100, reason: '回踩支撑' }, { price: 90, marginUsdt: 100, reason: '深度支撑' },
  ] };
});

test('过期的一分钟 K 线不能生成新计划', async () => {
  staleMinuteBars = true;
  await assert.rejects(analyzeTradfiAi('user1', 'fake-key', 'XAUUSDT', 'ladder'), /数据已过期/);
  staleMinuteBars = false;
});

test('一键计划按三笔 Maker 挂单和六笔止盈止损提交，禁止重复提交', async () => {
  const analysis = await analyzeTradfiAi('user1', 'fake-key', 'XAUUSDT', 'ladder');
  const preview = await previewTradfiAi('user1', analysis.analysisId);
  assert.equal(preview.orders.length, 3);
  assert.ok(preview.estimatedLossUsdt <= preview.totalMarginUsdt * 0.3);
  await assert.rejects(previewTradfiAi('other-user', analysis.analysisId), /不属于当前用户/);
  await assert.rejects(placeTradfiAi({ apiKey: 'fake', secret: 'fake', simulated: true }, 'user1', analysis.analysisId, 'stale-preview'), /重新预览/);
  const result = await placeTradfiAi({ apiKey: 'fake', secret: 'fake', simulated: true }, 'user1', analysis.analysisId, previewFingerprint(preview));
  assert.equal(result.orders.length, 3);
  assert.equal(result.protections.length, 6);
  assert.equal(calls.filter((call) => call.path.endsWith('/order') && call.method === 'POST').length, 3);
  assert.ok(calls.filter((call) => call.path.endsWith('/order') && call.method === 'POST').every((call) => call.params.timeInForce === 'GTX'));
  await assert.rejects(placeTradfiAi({ simulated: true }, 'user1', analysis.analysisId, previewFingerprint(preview)), /已提交/);
});

test('震荡试探在加仓模式下只生成一笔，并限制区间边缘和小仓位', async () => {
  modelOutput = {
    marketState: '震荡', decision: '可试探', fundamentalBias: '中性', thesis: '区间上下沿反复有效', invalidation: '跌破 95 区间下沿',
    direction: '做多', reason: '现价接近区间下沿', shortView: '区间下沿', longView: '横盘', evidence: ['区间支撑'],
    rangeLow: 95, rangeHigh: 115, leverage: 2, stop: 94.2, takeProfit: 110,
    orders: [{ price: 99, marginUsdt: 80, reason: '区间下沿试探' }],
  };
  const analysis = await analyzeTradfiAi('user1', 'fake-key', 'XAUUSDT', 'ladder');
  assert.equal(analysis.plan.mode, 'probe');
  assert.equal(analysis.plan.orders.length, 1);
  const preview = await previewTradfiAi('user1', analysis.analysisId);
  assert.equal(preview.orders.length, 1);
  assert.ok(preview.estimatedLossUsdt <= preview.totalMarginUsdt * 0.1);
  marketPrice = 105;
  await assert.rejects(previewTradfiAi('user1', analysis.analysisId), /区间边缘/);
  marketPrice = 100;
  assert.equal(normalizeModelPlan({ ...modelOutput, rangeLow: 90, rangeHigh: 120 }, 'ladder', 100).decision, '暂缓');
  assert.throws(() => normalizeModelPlan({ ...modelOutput, orders: [{ price: 99, marginUsdt: 101, reason: '过大' }] }, 'ladder', 100), /100 USDT/);
  assert.throws(() => normalizeModelPlan({ ...modelOutput, leverage: 3 }, 'ladder', 100), /杠杆/);
});
