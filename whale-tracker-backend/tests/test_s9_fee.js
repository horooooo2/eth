'use strict';

require('./helpers/isolateSqlite');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const binding = require('../lib/v41UserBinding');
const { fetchTrustedOwnerTradeFee } = require('../lib/v41S9Fee');

test('trusted owner resolved and query user_id ignored', async () => {
  binding.bindEngineOwner('owner-1');
  const out = await fetchTrustedOwnerTradeFee({
    queryUserId: 'forged-frontend',
    getCreds: (id) => {
      assert.equal(id, 'owner-1');
      return { apiKey: 'k', secret: 's', passphrase: 'p', simulated: true };
    },
    withTradeCredentials: async (_c, fn) => fn(),
    getTradeFee: async () => ({ taker: 0.0002, maker: 0.0001, taker_bps: 2, maker_bps: 1, instId: 'BTC-USDT-SWAP' }),
    resolveEnv: () => 'OKX_DEMO',
  });
  assert.equal(out.taker_bps, 2);
  assert.equal(out.source, 'okx_account_trade_fee');
  assert.equal(out.account_environment, 'OKX_DEMO');
  assert.equal(out.ignored_query_user_id, 'forged-frontend');
  binding.clearBoundEngineOwner();
});

test('owner missing / credential missing / invalid fee fail closed', async () => {
  binding.clearBoundEngineOwner();
  delete process.env.V41_ENGINE_OWNER_USER_ID;
  await assert.rejects(
    () => fetchTrustedOwnerTradeFee({ queryUserId: 'x', getCreds: () => ({ apiKey: 'k' }) }),
    (e) => e.code === 'S9_COST_DATA_UNAVAILABLE',
  );
  binding.bindEngineOwner('owner-2');
  await assert.rejects(
    () => fetchTrustedOwnerTradeFee({ getCreds: () => null }),
    (e) => e.code === 'S9_COST_DATA_UNAVAILABLE',
  );
  await assert.rejects(
    () =>
      fetchTrustedOwnerTradeFee({
        getCreds: () => ({ apiKey: 'k', secret: 's', passphrase: 'p', simulated: true }),
        withTradeCredentials: async (_c, fn) => fn(),
        getTradeFee: async () => ({ taker: 'bad', maker: 1, taker_bps: 'x', maker_bps: 1 }),
      }),
    (e) => e.code === 'S9_COST_DATA_UNAVAILABLE',
  );
  binding.clearBoundEngineOwner();
});
