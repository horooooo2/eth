const test = require('node:test');
const assert = require('node:assert/strict');

const clientPath = require.resolve('../lib/binanceTradfiTrade');
const tradePath = require.resolve('../lib/binanceCryptoTrade');
const original = require.cache[clientPath];
const calls = [];
let failAt = '';
let failId = '';
require.cache[clientPath] = {
  id: clientPath, filename: clientPath, loaded: true,
  exports: {
    symbolRules: async () => ({ status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT', filters: [
      { filterType: 'PRICE_FILTER', tickSize: '0.1' },
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
      { filterType: 'MIN_NOTIONAL', notional: '5' },
    ] }),
    publicGet: async (path) => path.endsWith('/bookTicker') ? { askPrice: '100.1', bidPrice: '99.9' } : { price: '100' },
    stepped: (value, step, mode = 'floor') => (mode === 'ceil' ? Math.ceil(value / Number(step) - 1e-9) : Math.floor(value / Number(step) + 1e-9)) * Number(step) + '',
    signedRequest: async (_creds, method, path, params) => {
      calls.push({ method, path, params });
      if (path === failAt && (!failId || String(params?.clientAlgoId || '').endsWith(failId))) throw Error('rejected');
      if (path.endsWith('/positionSide/dual')) return { dualSidePosition: false };
      if (path.endsWith('/positionRisk')) return [{ positionSide: 'BOTH', positionAmt: '0' }];
      if (path.endsWith('/algoOrder') && method === 'GET') return { algoStatus: 'NEW', side: 'SELL', quantity: '0.505' };
      if (path.endsWith('/algoOrder')) return { algoId: calls.length };
      if (path.endsWith('/order')) return { orderId: 123, status: 'NEW' };
      return {};
    },
  },
};
const { planStance, placeStance } = require('../lib/binanceCryptoTrade');
if (original) require.cache[clientPath] = original;
else delete require.cache[clientPath];
delete require.cache[tradePath];

const input = { execution: '现在可开', coin: 'BTC', action: '做多', entry: 99, expectedPrice: 99, stop: 90, takeProfit: 110, leverage: 5, amountUsd: 10 };
test('plans a USDT perpetual post-only order with valid notional', async () => {
  const plan = await planStance(input);
  assert.equal(plan.symbol, 'BTCUSDT');
  assert.equal(plan.side, 'BUY');
  assert.ok(Number(plan.price) < 100);
  assert.ok(plan.notionalUsdt <= 50);
  await assert.rejects(() => planStance({ ...input, stop: 99.95 }), /止损止盈方向/);
});

test('places protections and a real GTX entry, and cleans up on rejection', async () => {
  calls.length = 0;
  const result = await placeStance({ simulated: true }, input);
  assert.equal(result.order.orderId, 123);
  assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => c.path), [
    '/fapi/v1/leverage', '/fapi/v1/order', '/fapi/v1/algoOrder', '/fapi/v1/algoOrder',
  ]);
  assert.equal(calls.find((c) => c.path === '/fapi/v1/order' && c.method === 'POST').params.timeInForce, 'GTX');
  const stop = calls.find((c) => c.params?.type === 'STOP_MARKET');
  assert.equal(stop.params.quantity, result.plan.quantity);
  assert.equal(stop.params.reduceOnly, 'true');
  assert.equal(stop.params.closePosition, undefined);
  calls.length = 0;
  failAt = '/fapi/v1/algoOrder';
  failId = '_t';
  await assert.rejects(() => placeStance({ simulated: true }, input), /rejected/);
  assert.equal(calls.filter((c) => c.method === 'DELETE' && c.path === '/fapi/v1/order').length, 1);
  assert.equal(calls.filter((c) => c.method === 'DELETE' && c.path === '/fapi/v1/algoOrder').length, 1);
  failAt = '';
  failId = '';
});
