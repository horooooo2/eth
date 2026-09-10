'use strict';

require('./helpers/isolateSqlite');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const binding = require('../lib/v41UserBinding');
const { fetchTrustedOwnerTradeFee } = require('../lib/v41S9Fee');
const { parseTradeFeeRow, tradeFeeQuery } = require('../lib/okxTradeClient');

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
    (e) => e.code === 'OWNER_NOT_READY' && e.reason === 'S9_COST_DATA_UNAVAILABLE',
  );
  binding.bindEngineOwner('owner-2');
  await assert.rejects(
    () => fetchTrustedOwnerTradeFee({ getCreds: () => null }),
    (e) => e.code === 'CREDENTIAL_NOT_FOUND' && e.reason === 'S9_COST_DATA_UNAVAILABLE',
  );
  await assert.rejects(
    () =>
      fetchTrustedOwnerTradeFee({
        getCreds: () => ({ apiKey: 'k', secret: 's', passphrase: 'p', simulated: true }),
        withTradeCredentials: async (_c, fn) => fn(),
        getTradeFee: async () => ({ taker: 'bad', maker: 1, taker_bps: 'x', maker_bps: 1 }),
      }),
    (e) => e.code === 'FEE_RESPONSE_INVALID' && e.reason === 'S9_COST_DATA_UNAVAILABLE',
  );
  binding.clearBoundEngineOwner();
});

test('live account env is not used for S9 fee', async () => {
  binding.bindEngineOwner('owner-live');
  await assert.rejects(
    () =>
      fetchTrustedOwnerTradeFee({
        getCreds: () => ({ apiKey: 'k', secret: 's', passphrase: 'p', simulated: false }),
        resolveEnv: () => 'OKX_LIVE',
      }),
    (e) => e.code === 'ACCOUNT_ENV_NOT_READY' && e.reason === 'S9_COST_DATA_UNAVAILABLE',
  );
  binding.clearBoundEngineOwner();
});

test('fee timeout and api error keep fail-closed codes', async () => {
  binding.bindEngineOwner('owner-fee');
  await assert.rejects(
    () =>
      fetchTrustedOwnerTradeFee({
        getCreds: () => ({ apiKey: 'k', secret: 's', passphrase: 'p', simulated: true }),
        withTradeCredentials: async (_c, fn) => fn(),
        getTradeFee: async () => {
          const err = new Error('timeout');
          err.code = 'ETIMEDOUT';
          throw err;
        },
      }),
    (e) => e.code === 'FEE_API_TIMEOUT' && e.reason === 'S9_COST_DATA_UNAVAILABLE',
  );
  await assert.rejects(
    () =>
      fetchTrustedOwnerTradeFee({
        getCreds: () => ({ apiKey: 'k', secret: 's', passphrase: 'p', simulated: true }),
        withTradeCredentials: async (_c, fn) => fn(),
        getTradeFee: async () => {
          const err = new Error('okx 500');
          err.status = 500;
          err.code = '50001';
          throw err;
        },
      }),
    (e) => e.code === 'FEE_API_ERROR' && e.reason === 'S9_COST_DATA_UNAVAILABLE',
  );
  binding.clearBoundEngineOwner();
});

test('SWAP fee query uses instFamily not spot instId', () => {
  assert.deepEqual(tradeFeeQuery({ instId: 'BTC-USDT-SWAP', instType: 'SWAP' }), {
    instType: 'SWAP',
    instFamily: 'BTC-USDT',
  });
  assert.deepEqual(tradeFeeQuery({ instId: 'BTC-USDT', instType: 'SPOT' }), {
    instType: 'SPOT',
    instId: 'BTC-USDT',
  });
});

test('SWAP fee parser reads takerU and feeGroup without logging body', () => {
  const fromU = parseTradeFeeRow(
    { instType: 'SWAP', taker: '', maker: '', takerU: '-0.0005', makerU: '-0.0002' },
    { instId: 'BTC-USDT-SWAP', instType: 'SWAP' },
  );
  assert.equal(fromU.taker_bps, 5);
  assert.equal(fromU.maker_bps, 2);
  const fromGroup = parseTradeFeeRow(
    {
      instType: 'SWAP',
      taker: '',
      maker: '',
      feeGroup: [{ taker: '-0.00032', maker: '-0.00008', groupId: '1' }],
    },
    { instId: 'BTC-USDT-SWAP', instType: 'SWAP' },
  );
  assert.equal(fromGroup.taker_bps, 3.2);
  assert.equal(fromGroup.okx_code, '0');
  assert.equal(parseTradeFeeRow({ taker: 'x', maker: 'y' }), null);
});
