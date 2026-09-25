const assert = require('node:assert/strict');
const test = require('node:test');

function stub(path, exports) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

let closedThenManual = false;

stub('../lib/binanceAiLedger', {
  listBinanceAiOrders: (_userId, scope) => [{ order_id: '101', client_order_id: scope === 'tradfi' ? 'wtf_rg_cycle_base_l_0' : 'wtai_group_e', symbol: 'BTCUSDT', leverage: 5 }],
  isAiClientId: (id, scope) => scope === 'tradfi' ? String(id).startsWith('wtf_') : String(id).startsWith('wtai_'),
});
stub('../lib/binanceTradfiTrade', {
  signedRequest: async (_creds, _method, path, params = {}) => {
    if (path.endsWith('/balance')) return [{ asset: 'USDT', balance: '500', availableBalance: '420' }];
    if (closedThenManual) {
      if (path.endsWith('/positionRisk')) return [{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '0.2', entryPrice: '110', notional: '22', leverage: '5', unRealizedProfit: '1', updateTime: 40 }];
      if (path.endsWith('/openOrders')) return [];
      if (path.endsWith('/allOrders')) return [
        { orderId: 101, clientOrderId: 'wtai_group_e', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'BOTH', executedQty: '0.1', time: 10 },
        { orderId: 102, clientOrderId: 'manual-close', symbol: 'BTCUSDT', side: 'SELL', positionSide: 'BOTH', executedQty: '0.1', time: 20 },
        { orderId: 103, clientOrderId: 'manual-reopen', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'BOTH', executedQty: '0.2', time: 30 },
      ];
    }
    if (path.endsWith('/positionRisk')) return [
      { symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '0.2', entryPrice: '100', notional: '20', leverage: '5', unRealizedProfit: '4', updateTime: 10 },
      { symbol: 'ETHUSDT', positionSide: 'BOTH', positionAmt: '2', entryPrice: '10', notional: '20', leverage: '3', unRealizedProfit: '9', updateTime: 11 },
    ];
    if (path.endsWith('/openOrders')) return [
      { orderId: 101, clientOrderId: 'wtai_group_e', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'BOTH', price: '95', origQty: '0.1', executedQty: '0', time: 12 },
      { orderId: 202, clientOrderId: 'manual', symbol: 'ETHUSDT', side: 'BUY', positionSide: 'BOTH', price: '9', origQty: '1', executedQty: '0', time: 13 },
    ];
    if (path.endsWith('/userTrades') && params.symbol === 'BTCUSDT') return [
      { id: 1, orderId: 101, symbol: 'BTCUSDT', side: 'BUY', positionSide: 'BOTH', price: '100', qty: '0.1', quoteQty: '10', realizedPnl: '0', commission: '0.004', commissionAsset: 'USDT', time: 10 },
    ];
    if (path.endsWith('/userTrades')) return [];
    if (path.endsWith('/allOrders') && params.symbol === 'BTCUSDT') return [
      { orderId: 101, clientOrderId: 'wtai_group_e', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'BOTH', executedQty: '0.1' },
    ];
    if (path.endsWith('/allOrders')) return [{ orderId: 202, clientOrderId: 'manual', symbol: 'ETHUSDT', side: 'BUY', positionSide: 'BOTH', executedQty: '2' }];
    throw new Error(path);
  },
  symbolRules: async () => null,
  publicGet: async () => null,
  stepped: (value) => String(value),
});

const { accountBook } = require('../lib/binanceCryptoTrade');

test('币安交易账户只展示 AI 挂单和 AI 对应的仓位份额', async () => {
  const book = await accountBook({ simulated: false }, 'u1', 'crypto');
  assert.equal(book.scope, 'ai-only');
  assert.ok(book.records.length > 0);
  assert.ok(book.records.every((row) => row.instId === 'BTCUSDT' && row.source === 'ai'));
  assert.equal(book.records.some((row) => row.instId === 'ETHUSDT'), false);
  assert.equal(book.openPnl, 2);
});

test('TradFi 交易记录来自本站策略订单的币安成交明细', async () => {
  const book = await accountBook({ simulated: false }, 'u1', 'tradfi');
  assert.equal(book.trades.length, 1);
  assert.equal(book.trades[0].amountUsd, 10);
  assert.equal(book.trades[0].action, 'open');
});

test('AI 仓位平仓后手动重开不会再次显示为 AI 仓位', async () => {
  closedThenManual = true;
  try {
    const book = await accountBook({ simulated: false }, 'u1', 'crypto');
    assert.equal(book.records.length, 0);
    assert.equal(book.openPnl, 0);
  } finally {
    closedThenManual = false;
  }
});
