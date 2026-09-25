const assert = require('node:assert/strict');
const test = require('node:test');

function stub(path, exports) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

const calls = [];
let silverPosition = 1;
stub('../lib/cache', { readCache: () => null, writeCache: () => {} });
stub('../lib/userExchangeKeys', { getBinanceCredentialsForUser: () => ({ apiKey: 'fake', secret: 'fake', simulated: true }) });
stub('../lib/binanceTradfiTrade', { signedRequest: async (_creds, method, path, params = {}) => {
  calls.push({ method, path, params });
  if (path.endsWith('/positionRisk')) return [{ symbol: params.symbol, positionSide: 'BOTH', positionAmt: params.symbol === 'XAGUSDT' ? String(silverPosition) : '0' }];
  if (path.endsWith('/algoOrder') && method === 'GET') return { algoStatus: Number(params.algoId) === 3 ? 'TRIGGERED' : 'NEW' };
  if (path.endsWith('/order') && method === 'GET') return { orderId: 10, status: 'NEW', executedQty: params.symbol === 'XAGUSDT' ? '1' : '0' };
  if (path.endsWith('/order') && method === 'POST') { silverPosition = 0; return { status: 'FILLED' }; }
  if (method === 'DELETE') return { status: 'CANCELED' };
  throw new Error(`${method} ${path}`);
} });

const monitor = require('../lib/tradfiAiMonitor');
monitor.start();

test('到期撤销未成交挂单及其条件单', async () => {
  monitor.register({ userId: 'u1', symbol: 'XAUUSDT', simulated: true, positionSide: 'BOTH', direction: 'BUY',
    orders: [{ orderId: 10 }], protections: [{ algoId: 1 }, { algoId: 2 }], expiresAt: Date.now() - 1 });
  await monitor.reconcile();
  assert.ok(calls.some((call) => call.method === 'DELETE' && call.path.endsWith('/order')));
  assert.equal(calls.filter((call) => call.method === 'DELETE' && call.path.endsWith('/algoOrder')).length, 2);
});

test('保护单失效时撤销后续入场并紧急平仓', async () => {
  calls.length = 0;
  monitor.register({ userId: 'u1', symbol: 'XAGUSDT', simulated: true, positionSide: 'BOTH', direction: 'BUY',
    orders: [{ orderId: 10 }], protections: [{ algoId: 3 }, { algoId: 4 }], expiresAt: Date.now() + 60_000 });
  await monitor.reconcile();
  assert.ok(calls.some((call) => call.method === 'DELETE' && call.path.endsWith('/order')));
  assert.ok(calls.some((call) => call.method === 'POST' && call.path.endsWith('/order') && call.params.type === 'MARKET' && call.params.reduceOnly === 'true'));
});
