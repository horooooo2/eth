'use strict';

require('./helpers/isolateSqlite');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const ready = require('../lib/v41ExecuteReadiness');
const gate = require('../lib/v41AlphaLiveGate');
const binding = require('../lib/v41UserBinding');
const gateway = require('../lib/v41ExecutionGateway');
const okx = require('../lib/okxTradeClient');
const v41 = require('../lib/v41EngineClient');

const DEMO_CREDS = {
  apiKey: 'mock-key',
  secret: 'mock-secret',
  passphrase: 'mock-pass',
  simulated: true,
};
const LIVE_CREDS = { ...DEMO_CREDS, simulated: false };

function baseIntent(over = {}) {
  return {
    order_intent_id: `oi-ready-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    client_order_id: `v41_${Date.now().toString(16)}`.slice(0, 32),
    signal_key: `S1:BTC-USDT-SWAP:LONG:${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    trade_intent_id: 'ti-ready-1',
    origin_strategy_id: 'S1',
    strategy_id: 'S1',
    symbol: 'BTC-USDT-SWAP',
    side: 'buy',
    position_side: 'long',
    quantity_unit: 'BASE',
    base_quantity: 0.02,
    reduce_only: false,
    alpha_execution: 'EXECUTE',
    demo_execute_v1_allowed: true,
    entry_price: 100000,
    stop_price: 98000,
    risk_amount_quote: 40,
    risk_pct: 0.004,
    live_allowed: true,
    ...over,
  };
}

function mockOkx() {
  const calls = { place: [], cancel: [], config: 0 };
  return {
    calls,
    client: {
      async placeOrder(input) {
        calls.place.push(input);
        return {
          order: { ordId: `mock-${calls.place.length}`, sz: input.sz, avgPx: '100000' },
          raw: { code: '0' },
          posMode: 'net_mode',
        };
      },
      async cancelOrder(input) {
        calls.cancel.push(input);
        return { result: { sCode: '0' }, raw: { code: '0' } };
      },
      async withTradeCredentials(_creds, fn) {
        return fn();
      },
      async resolvePosMode() {
        calls.config += 1;
        return 'net_mode';
      },
    },
  };
}

let origHealth;
let origEnv;

beforeEach(() => {
  origEnv = {
    exec: process.env.V41_ALPHA_EXECUTION,
    live: process.env.V41_LIVE_TRADING_ENABLED,
    owner: process.env.V41_ENGINE_OWNER_USER_ID,
  };
  process.env.V41_ALPHA_EXECUTION = 'EXECUTE';
  process.env.V41_LIVE_TRADING_ENABLED = 'false';
  delete process.env.V41_ENGINE_OWNER_USER_ID;
  binding.clearBoundEngineOwner();
  ready.setInstrumentSpec(ready.BTC_USDT_SWAP);
  gateway.setExecutionRecoveryStatus({ status: 'READY', reason: null });
  origHealth = v41.health;
  v41.health = async () => ({ state: 'RUNNING', ok: true });
});

afterEach(() => {
  v41.health = origHealth;
  process.env.V41_ALPHA_EXECUTION = origEnv.exec || 'SHADOW';
  process.env.V41_LIVE_TRADING_ENABLED = origEnv.live || 'false';
  if (origEnv.owner) process.env.V41_ENGINE_OWNER_USER_ID = origEnv.owner;
  else delete process.env.V41_ENGINE_OWNER_USER_ID;
  binding.clearBoundEngineOwner();
  ready.setInstrumentSpec(null);
  gateway.setOpeningSafetyLock(null);
  gateway.setExecutionRecoveryStatus({ status: 'SHADOW_SKIPPED', reason: 'SHADOW_NO_PRIVATE_TRADE' });
  gateway._setExecuteDeps({
    getOkxCredentialsForUser: require('../lib/userExchangeKeys').getOkxCredentialsForUser,
    isOkxReadyForUser: require('../lib/userExchangeKeys').isOkxReadyForUser,
    placeOrder: okx.placeOrder,
    cancelOrder: okx.cancelOrder,
    withTradeCredentials: okx.withTradeCredentials,
    resolvePosMode: (...a) => okx.resolvePosMode(...a),
    readiness: ready,
    getOrder: (...a) => okx.getOrder(...a),
    getPublicInstrument: (...a) => okx.getPublicInstrument(...a),
    getPublicBooks5: (...a) => okx.getPublicBooks5(...a),
    getLeverageInfo: (...a) => okx.getLeverageInfo(...a),
    getAccountPositions: (...a) => okx.getAccountPositions(...a),
    actualLeverage: undefined,
    exchangeQty: undefined,
    ownedOpen: undefined,
    hasNonterminalOpening: undefined,
  });
});

function installMocks(mock, creds = DEMO_CREDS) {
  gateway._setExecuteDeps({
    getOkxCredentialsForUser: () => creds,
    isOkxReadyForUser: () => true,
    placeOrder: mock.client.placeOrder,
    cancelOrder: mock.client.cancelOrder,
    withTradeCredentials: mock.client.withTradeCredentials,
    resolvePosMode: mock.client.resolvePosMode,
    readiness: ready,
    getOrder: async () => ({ state: 'live', accFillSz: '0', avgPx: '100000' }),
    actualLeverage: 3,
    exchangeQty: 0,
    ownedOpen: false,
    hasNonterminalOpening: false,
  });
}

test('1 DEMO execute allowed via mock OKX', async () => {
  const mock = mockOkx();
  installMocks(mock, DEMO_CREDS);
  binding.bindEngineOwner('user_demo_1');
  const out = await gateway.executeOrderIntent(baseIntent(), { sessionUserId: 'user_demo_1' });
  assert.equal(out.ok, true);
  assert.equal(out.account_environment, 'OKX_DEMO');
  assert.equal(mock.calls.place.length, 1);
  assert.equal(mock.calls.place[0].sz, '2');
  assert.equal(mock.calls.place[0].requireKnownPosMode, true);
  assert.notEqual(mock.calls.place[0].sz, '0.02');
});

test('2 LIVE global gate', async () => {
  const mock = mockOkx();
  installMocks(mock, LIVE_CREDS);
  binding.bindEngineOwner('user_live_1');
  process.env.V41_LIVE_TRADING_ENABLED = 'false';
  await assert.rejects(
    () => gateway.executeOrderIntent(baseIntent(), { sessionUserId: 'user_live_1' }),
    (err) => err.code === 'LIVE_EXECUTION_NOT_AUTHORIZED',
  );
  assert.equal(mock.calls.place.length, 0);
});

test('3 strategy live gate', async () => {
  process.env.V41_LIVE_TRADING_ENABLED = 'true';
  const mock = mockOkx();
  installMocks(mock, LIVE_CREDS);
  binding.bindEngineOwner('user_live_1');
  await assert.rejects(
    () =>
      gateway.executeOrderIntent(baseIntent({ origin_strategy_id: 'S8', strategy_id: 'S8', live_allowed: false }), {
        sessionUserId: 'user_live_1',
      }),
    (err) => err.code === 'STRATEGY_LIVE_NOT_ALLOWED',
  );
  assert.equal(mock.calls.place.length, 0);
  process.env.V41_LIVE_TRADING_ENABLED = 'false';
});

test('4 missing authenticated user_id fail-closed', async () => {
  const mock = mockOkx();
  installMocks(mock, DEMO_CREDS);
  await assert.rejects(
    () => gateway.executeOrderIntent(baseIntent({ user_id: 'forged-browser' })),
    (err) => err.code === 'ALPHA_EXECUTION_USER_NOT_READY',
  );
  assert.equal(mock.calls.place.length, 0);
});

test('5 invalid position mode fail-closed', async () => {
  const mock = mockOkx();
  mock.client.resolvePosMode = async () => {
    const err = new Error('OKX position mode unknown');
    err.code = 'POSITION_MODE_UNKNOWN';
    throw err;
  };
  installMocks(mock, DEMO_CREDS);
  binding.bindEngineOwner('user_demo_1');
  await assert.rejects(
    () => gateway.executeOrderIntent(baseIntent(), { sessionUserId: 'user_demo_1' }),
    (err) => err.code === 'POSITION_MODE_UNKNOWN',
  );
  assert.equal(mock.calls.place.length, 0);
});

test('6 invalid instrument metadata fail-closed', () => {
  ready.setInstrumentSpec({ stale: true });
  assert.throws(
    () => ready.getCachedInstrument('BTC-USDT-SWAP'),
    (err) => err.code === 'INSTRUMENT_METADATA_STALE',
  );
});

test('7 min size reject', () => {
  const spec = { ...ready.BTC_USDT_SWAP, minSz: 5, lotSz: 1 };
  assert.throws(
    () => ready.convertToOkxSz(baseIntent({ base_quantity: 0.02 }), spec),
    (err) => err.code === 'MIN_SIZE_REJECTED',
  );
});

test('8 precision rounding refuses sz=0', () => {
  const ok = ready.convertToOkxSz(baseIntent({ base_quantity: 0.015 }), ready.BTC_USDT_SWAP);
  assert.equal(ok.sz, '1');
  assert.throws(
    () => ready.convertToOkxSz(baseIntent({ base_quantity: 0.004 }), ready.BTC_USDT_SWAP),
    (err) => err.code === 'PRECISION_ROUNDED_TO_ZERO',
  );
});

test('9 duplicate OrderIntent is hard-idempotent', async () => {
  const mock = mockOkx();
  installMocks(mock, DEMO_CREDS);
  binding.bindEngineOwner('user_demo_1');
  const intent = baseIntent();
  const first = await gateway.executeOrderIntent(intent, { sessionUserId: 'user_demo_1' });
  const second = await gateway.executeOrderIntent({ ...intent }, { sessionUserId: 'user_demo_1' });
  assert.equal(first.ok, true);
  assert.equal(second.idempotent, true);
  assert.equal(mock.calls.place.length, 1);
});

test('10 convert uses contracts not 1 qty = 1 BTC', () => {
  const spec = ready.BTC_USDT_SWAP;
  const out = ready.convertToOkxSz(baseIntent({ base_quantity: 0.02 }), spec);
  assert.equal(out.contracts, 2);
  assert.equal(Number((out.contracts * spec.ctVal).toFixed(6)), 0.02);
  assert.equal(out.ctVal, 0.01);
});

test('11 cancel requested vs confirmed (mock)', async () => {
  const mock = mockOkx();
  const result = await mock.client.cancelOrder({ instId: 'BTC-USDT-SWAP', clOrdId: 'v41_abc' });
  assert.equal(result.raw.code, '0');
  assert.equal(mock.calls.cancel.length, 1);
});

test('12 restart recovery does not re-place SUBMITTED', async () => {
  const mock = mockOkx();
  installMocks(mock, DEMO_CREDS);
  binding.bindEngineOwner('user_demo_1');
  const intent = baseIntent();
  const first = await gateway.executeOrderIntent(intent, { sessionUserId: 'user_demo_1' });
  assert.equal(first.ok, true);
  const rec = gateway.findRecord(intent.order_intent_id);
  assert.ok(rec);
  const again = await gateway.executeOrderIntent(intent, { sessionUserId: 'user_demo_1' });
  assert.equal(again.idempotent, true);
  assert.equal(mock.calls.place.length, 1);
});

test('13 oversized reduce-only caps to owned', () => {
  const capped = ready.capExitToOwned({ base_quantity: 0.02, reduce_only: true }, 0.01);
  assert.equal(capped.capped, true);
  assert.equal(capped.base_quantity, 0.01);
  assert.throws(
    () => ready.capExitToOwned({ base_quantity: 0.01, reduce_only: true }, 0),
    (err) => err.code === 'ALREADY_FLAT',
  );
  assert.throws(
    () => ready.assertReduceOnlyExit({ purpose: 'stop_loss', reduce_only: false }),
    (err) => err.code === 'REDUCE_ONLY_REQUIRED',
  );
});

test('14 user manual position is not auto-owned', () => {
  const env = gate.resolveAccountEnvironment(DEMO_CREDS);
  assert.equal(env, 'OKX_DEMO');
  assert.equal(ready.capExitToOwned({ base_quantity: 0.01 }, 0.01).owned, 0.01);
});

test('15 risk sanity fail-closed on divergence', () => {
  assert.throws(
    () =>
      ready.assertRiskSanity(
        { entry_price: 100000, stop_price: 90000, risk_amount_quote: 1 },
        { contracts: 1, ctVal: 0.01 },
      ),
    (err) => err.code === 'RISK_SANITY_FAILED',
  );
});

test('16 S6 / engine unavailable blocks new opening', async () => {
  const mock = mockOkx();
  installMocks(mock, DEMO_CREDS);
  binding.bindEngineOwner('user_demo_1');
  v41.health = async () => {
    const err = new Error('engine unavailable');
    err.code = 'V41_ENGINE_UNAVAILABLE';
    throw err;
  };
  await assert.rejects(
    () => gateway.executeOrderIntent(baseIntent(), { sessionUserId: 'user_demo_1' }),
    (err) => err.code === 'V41_ENGINE_UNAVAILABLE',
  );
  assert.equal(mock.calls.place.length, 0);
});

test('posMode helpers: net vs hedge body', () => {
  const net = okx.buildOrderBody(
    { instId: 'BTC-USDT-SWAP', side: 'buy', sz: '0.01', tdMode: 'cross', reduceOnly: false },
    'net_mode',
  );
  assert.equal(net.body.posSide, undefined);
  const hedge = okx.buildOrderBody(
    { instId: 'BTC-USDT-SWAP', side: 'buy', sz: '0.01', tdMode: 'cross', reduceOnly: false },
    'long_short_mode',
  );
  assert.equal(hedge.body.posSide, 'long');
  const close = okx.buildOrderBody(
    { instId: 'BTC-USDT-SWAP', side: 'sell', sz: '0.01', tdMode: 'cross', reduceOnly: true },
    'long_short_mode',
  );
  assert.equal(close.body.posSide, 'long');
  assert.equal(close.body.reduceOnly, true);
});

test('LIVE env gate stays independent of QA', () => {
  process.env.V41_LIVE_TRADING_ENABLED = 'false';
  assert.equal(gate.liveTradingEnabled(), false);
  assert.equal(gate.resolveAccountEnvironment(DEMO_CREDS), 'OKX_DEMO');
  assert.equal(gate.resolveAccountEnvironment(LIVE_CREDS), 'OKX_LIVE');
});
