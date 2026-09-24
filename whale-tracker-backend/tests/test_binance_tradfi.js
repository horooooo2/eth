const test = require('node:test');
const assert = require('node:assert/strict');
const {
  listExchangeKeys, upsertExchangeKeys, getBinanceCredentialsForUser,
  patchBinanceFlags, deleteExchangeKeys,
} = require('../lib/userExchangeKeys');
const { stepped } = require('../lib/binanceTradfiTrade');

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
