const assert = require('node:assert/strict');
const test = require('node:test');

function stub(path, exports) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

let closedThenManual = false;
let hideManualTrade = false;
let pagingHistory = false;

stub('../lib/binanceAiLedger', {
  listBinanceAiOrders: (_userId, scope) => [{ order_id: '101', client_order_id: scope === 'tradfi' ? 'wtf_rg_cycle_base_l_0' : 'wtai_group_e', symbol: 'BTCUSDT', leverage: 5 }],
  isAiClientId: (id, scope) => scope === 'tradfi' ? String(id).startsWith('wtf_') : String(id).startsWith('wtai_'),
});
stub('../lib/binanceTradfiTrade', {
  signedRequest: async (_creds, _method, path, params = {}) => {
    if (pagingHistory && path.endsWith('/allOrders')) {
      if (!params.orderId) return Array.from({ length: 1000 }, (_, index) => ({ orderId: index + 1 }));
      return [{ orderId: 1001 }, { orderId: 1002 }];
    }
    if (pagingHistory && path.endsWith('/userTrades')) {
      if (!params.fromId) return Array.from({ length: 1000 }, (_, index) => ({ id: index + 1 }));
      return [{ id: 1001 }, { id: 1002 }];
    }
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
      ...(hideManualTrade ? [] : [{ id: 2, orderId: 102, symbol: 'BTCUSDT', side: 'SELL', positionSide: 'BOTH', price: '110', qty: '0.05', quoteQty: '5.5', realizedPnl: '0.5', commission: '0.002', commissionAsset: 'USDT', time: 20 }]),
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

const { accountBook, isStrategyClose, allOrdersSince, userTradesSince, attributeFundingIncome } = require('../lib/binanceAiAccountBook');

test('TradFi 的 wtf_c_ 委托识别为策略平仓', () => {
  assert.equal(isStrategyClose({ clientOrderId: 'wtf_c_cycle_L1234' }), true);
  assert.equal(isStrategyClose({ clientOrderId: 'wtf_rg_cycle_base_l_0' }), false);
});

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
  assert.equal(book.trades.length, 2);
  assert.equal(book.trades.find((row) => row.source === 'ai').amountUsd, 10);
  assert.equal(book.trades.find((row) => row.source === 'manual').action, 'close');
  assert.equal(book.trades.find((row) => row.source === 'manual').realizedPnl, 0.5);
  assert.equal(book.costs.tradingFees, 0.006);
  assert.equal(book.costs.netCost, -0.006);
  assert.equal(book.realizedPnl, 0.5);
});

test('已归因的手动平仓在交易所历史暂不可见时仍保留在策略记录中', async () => {
  hideManualTrade = true;
  try {
    const book = await accountBook({ simulated: false }, 'u1', 'tradfi');
    assert.ok(book.trades.some((row) => row.tradeId === '2' && row.source === 'manual' && row.realizedPnl === 0.5));
  } finally {
    hideManualTrade = false;
  }
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

test('订单和成交历史超过1000条时继续分页并去重', async () => {
  pagingHistory = true;
  try {
    const orders = await allOrdersSince({}, 'XAUUSDT');
    const trades = await userTradesSince({}, 'XAUUSDT');
    assert.equal(orders.length, 1002);
    assert.equal(trades.length, 1002);
    assert.equal(orders.at(-1).orderId, 1002);
    assert.equal(trades.at(-1).id, 1002);
  } finally {
    pagingHistory = false;
  }
});

test('资金费只按结算时的 AI 仓位占比归因，并排除策略空仓时段', () => {
  const rows = attributeFundingIncome([
    { symbol: 'XAUUSDT', time: 30, income: '-1' },
    { symbol: 'XAUUSDT', time: 50, income: '-1' },
  ], [
    { symbol: 'XAUUSDT', direction: 'LONG', time: 10, totalDelta: 9, aiDelta: 0 },
    { symbol: 'XAUUSDT', direction: 'LONG', time: 20, totalDelta: 1, aiDelta: 1 },
    { symbol: 'XAUUSDT', direction: 'LONG', time: 40, totalDelta: -1, aiDelta: -1 },
  ]);
  assert.equal(rows.length, 1);
  assert.ok(Math.abs(Number(rows[0].income) + 0.1) < 1e-12);
  assert.equal(rows[0].aiShare, 0.1);
});
