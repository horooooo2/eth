const test = require('node:test');
const assert = require('node:assert/strict');
const {
  listExchangeKeys, upsertExchangeKeys, getBinanceCredentialsForUser,
  patchBinanceFlags, deleteExchangeKeys,
} = require('../lib/userExchangeKeys');
const { stepped } = require('../lib/binanceTradfiTrade');
const { positionAmounts } = require('../lib/binanceAiAccountBook');

test('Binance credentials are separate from OKX and retain their environment', () => {
  const userId = 'binance-tradfi-test';
  const saved = upsertExchangeKeys(userId, 'binance', {
    apiKey: 'binance-test-key', apiSecret: 'binance-test-secret', simulated: true,
  });
  assert.equal(saved.binance.ready, true);
  assert.equal(saved.okx.ready, false);
  assert.equal(getBinanceCredentialsForUser(userId).simulated, true);
  assert.throws(() => patchBinanceFlags(userId, { simulated: false }), /同时填写/);
  assert.equal(listExchangeKeys(userId).binance.simulated, true);
  deleteExchangeKeys(userId, 'binance');
  assert.equal(getBinanceCredentialsForUser(userId), null);
});

test('order price and size use exchange steps', () => {
  assert.equal(stepped(0.07019, '0.001'), '0.070');
  assert.equal(stepped(4275.981, '0.01', 'ceil'), '4275.99');
  assert.equal(stepped(4275.981, '0.01', 'floor'), '4275.98');
});

test('Binance 统一仓位拆分 AI/手动数量，并按开仓均价和杠杆展示本金', () => {
  const amounts = positionAmounts({ positionAmt: '0.3', entryPrice: '5000', leverage: '20' }, 0.1);
  assert.equal(amounts.totalQty, 0.3);
  assert.equal(amounts.aiQty, 0.1);
  assert.ok(Math.abs(amounts.manualQty - 0.2) < 1e-10);
  assert.equal(amounts.marginUsd, 75);
  assert.equal(amounts.aiMarginUsd, 25);
  assert.ok(Math.abs(amounts.manualMarginUsd - 50) < 1e-10);
  assert.equal(positionAmounts({ positionAmt: '-0.2', entryPrice: '5000', leverage: '0' }, 0).marginUsd, null);
});
