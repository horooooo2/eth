'use strict';

require('./helpers/isolateSqlite');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const s9 = require('../lib/v41S9Demo');
const ready = require('../lib/v41ExecuteReadiness');
const gateway = require('../lib/v41ExecutionGateway');
const binding = require('../lib/v41UserBinding');
const okx = require('../lib/okxTradeClient');
const v41 = require('../lib/v41EngineClient');

const DEMO_CREDS = {
  apiKey: 'mock-key',
  secret: 'mock-secret',
  passphrase: 'mock-pass',
  simulated: true,
};

function s9Intent(over = {}) {
  const now = Date.now();
  return {
    order_intent_id: `oi-s9-${now}-${Math.random().toString(16).slice(2)}`,
    client_order_id: `v41_${now.toString(16)}`.slice(0, 32),
    signal_key: `S9:BTC-USDT-SWAP:LONG:${now}`,
    trade_intent_id: 'ti-s9-1',
    origin_strategy_id: 'S9',
    strategy_id: 'S9',
    symbol: 'BTC-USDT-SWAP',
    side: 'buy',
    position_side: 'long',
    quantity_unit: 'BASE',
    base_quantity: 0.02,
    reduce_only: false,
    alpha_execution: 'EXECUTE',
    live_allowed: false,
    demo_allowed: true,
    entry_price: 100000,
    trigger_reference_price: 100000,
    stop_price: 98000,
    risk_amount_quote: 40,
    risk_pct: 0.001,
    created_at: new Date(now).toISOString(),
    trade_intent_created_at: new Date(now).toISOString(),
    ttl_seconds: 20,
    cancel_stop_before_exit: false,
    ...over,
  };
}

function s1Intent(over = {}) {
  return {
    ...s9Intent({ origin_strategy_id: 'S1', strategy_id: 'S1', live_allowed: true, ttl_seconds: undefined }),
    demo_execute_v1_allowed: true,
    ...over,
  };
}

function freshBook(over = {}) {
  return {
    best_bid: 100000,
    best_ask: 100001,
    timestamp: Date.now(),
    bids: [
      [100000, 20],
      [99990, 20],
      [99980, 20],
      [99970, 20],
      [99960, 20],
    ],
    asks: [
      [100001, 20],
      [100002, 20],
      [100003, 20],
      [100004, 20],
      [100005, 20],
    ],
    source: 'okx_public_books5',
    ...over,
  };
}

function mockPlace() {
  const calls = { place: [] };
  return {
    calls,
    async placeOrder(input) {
      calls.place.push(input);
      return { order: { ordId: `mock-${calls.place.length}`, sz: input.sz }, raw: { code: '0' } };
    },
    async withTradeCredentials(_creds, fn) {
      return fn();
    },
    async resolvePosMode() {
      return 'net_mode';
    },
  };
}

let origHealth;
let origEnv;

beforeEach(() => {
  origEnv = {
    exec: process.env.V41_ALPHA_EXECUTION,
    live: process.env.V41_LIVE_TRADING_ENABLED,
  };
  process.env.V41_ALPHA_EXECUTION = 'EXECUTE';
  process.env.V41_LIVE_TRADING_ENABLED = 'false';
  binding.bindEngineOwner('user_demo_s9');
  ready.setInstrumentSpec(ready.BTC_USDT_SWAP);
  gateway.setExecutionRecoveryStatus({ status: 'READY', reason: null });
  origHealth = v41.health;
  v41.health = async () => ({
    state: 'RUNNING',
    ok: true,
    S9_IMPLEMENTATION_READINESS: 'READY',
    S9_DEMO_PREFLIGHT_READINESS: 'READY',
    S9_DEMO_VALIDATION_STATUS: 'UNVERIFIED',
  });
});

afterEach(() => {
  v41.health = origHealth;
  process.env.V41_ALPHA_EXECUTION = origEnv.exec || 'SHADOW';
  process.env.V41_LIVE_TRADING_ENABLED = origEnv.live || 'false';
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
    s9ImplementationReadiness: undefined,
    s9DemoPreflightReadiness: undefined,
  });
});

function install(mock, book = freshBook()) {
  gateway._setExecuteDeps({
    getOkxCredentialsForUser: () => DEMO_CREDS,
    isOkxReadyForUser: () => true,
    placeOrder: mock.placeOrder,
    withTradeCredentials: mock.withTradeCredentials,
    resolvePosMode: mock.resolvePosMode,
    readiness: ready,
    getOrder: async () => ({ state: 'live', accFillSz: '0', avgPx: '100000' }),
    getPublicBooks5: async () => book,
    actualLeverage: 3,
    exchangeQty: 0,
    ownedOpen: false,
    hasNonterminalOpening: false,
  });
}

test('final_okx_sz used not requested base qty', () => {
  const converted = ready.convertBaseToOkxSz(s9Intent(), ready.BTC_USDT_SWAP);
  assert.equal(converted.final_okx_sz, '2');
  assert.notEqual(converted.final_okx_sz, '0.02');
  const book = freshBook();
  const ok = s9.assertS9PreSubmit(s9Intent(), {
    ...book,
    bid: book.best_bid,
    ask: book.best_ask,
    final_okx_sz: Number(converted.final_okx_sz),
    book_age_sec: 0.2,
    ctVal: 0.01,
  });
  assert.equal(ok.final_okx_sz, 2);
  assert.throws(
    () =>
      s9.assertS9PreSubmit(s9Intent(), {
        ...book,
        bid: book.best_bid,
        ask: book.best_ask,
        book_age_sec: 0.2,
      }),
    (e) => e.code === 'S9_INSUFFICIENT_BOOK_DEPTH',
  );
});

const FAIL_CASES = [
  ['stale', (book) => ({ ...book, timestamp: Date.now() - 5000, book_age_sec: 5 }), 'S9_ORDERBOOK_STALE'],
  ['spread', (book) => ({ ...book, best_ask: 100100, ask: 100100 }), 'S9_SPREAD_TOO_WIDE'],
  [
    'depth',
    (book) => ({
      ...book,
      asks: [
        [100001, 0.1],
        [100002, 0.1],
        [100003, 0.1],
        [100004, 0.1],
        [100005, 0.1],
      ],
    }),
    'S9_INSUFFICIENT_BOOK_DEPTH',
  ],
  [
    'slippage',
    (book) => ({
      ...book,
      asks: [
        [100001, 0.5],
        [100200, 10],
        [100300, 10],
        [100400, 10],
        [100500, 10],
      ],
    }),
    'S9_EXPECTED_SLIPPAGE_TOO_HIGH',
  ],
  [
    'ttl',
    (book) => book,
    'S9_TRADE_INTENT_EXPIRED',
    {
      created_at: new Date(Date.now() - 21_000).toISOString(),
      trade_intent_created_at: new Date(Date.now() - 21_000).toISOString(),
    },
  ],
  [
    'drift',
    (book) => ({ ...book, best_ask: 100070, best_bid: 100069, ask: 100070, bid: 100069 }),
    'S9_ENTRY_PRICE_DRIFT_EXCEEDED',
  ],
  ['risk', (book) => book, 'RISK_SANITY_FAILED', { risk_amount_quote: 0.01 }],
];

for (const [name, mutate, code, intentOver] of FAIL_CASES) {
  test(`S9 gate ${name} rejects and placeOrder=0`, async () => {
    const mock = mockPlace();
    const book = mutate(freshBook());
    install(mock, book);
    await assert.rejects(
      () => gateway.executeOrderIntent(s9Intent(intentOver || {}), { sessionUserId: 'user_demo_s9' }),
      (e) => e.code === code,
    );
    assert.equal(mock.calls.place.length, 0);
  });
}

test('fresh book / spread / depth / LONG VWAP / SHORT VWAP / drift favorable pass unit gates', () => {
  const book = freshBook();
  const extras = {
    bid: book.best_bid,
    ask: book.best_ask,
    bids: book.bids,
    asks: book.asks,
    final_okx_sz: 2,
    book_age_sec: 0.3,
    ctVal: 0.01,
    planned_risk: 40,
    stop_price: 98000,
  };
  assert.ok(s9.assertS9PreSubmit(s9Intent(), extras));
  const shortBook = {
    ...extras,
    bids: [
      [100000, 20],
      [99990, 20],
      [99980, 20],
      [99970, 20],
      [99960, 20],
    ],
  };
  assert.ok(s9.assertS9PreSubmit(s9Intent({ side: 'sell', position_side: 'short', stop_price: 102000 }), shortBook));
  assert.ok(
    s9.assertS9PreSubmit(s9Intent({ trigger_reference_price: 100010 }), extras),
  );
  assert.ok(
    s9.assertS9PreSubmit(
      s9Intent({
        side: 'sell',
        position_side: 'short',
        trigger_reference_price: 99990,
        stop_price: 102000,
      }),
      { ...extras, bid: 100000, ask: 100001 },
    ),
  );
});

test('S1 pipeline does not require S9 book/fee/TTL', async () => {
  const mock = mockPlace();
  let books = 0;
  gateway._setExecuteDeps({
    getOkxCredentialsForUser: () => DEMO_CREDS,
    isOkxReadyForUser: () => true,
    placeOrder: mock.placeOrder,
    withTradeCredentials: mock.withTradeCredentials,
    resolvePosMode: mock.resolvePosMode,
    readiness: ready,
    getOrder: async () => ({ state: 'live', accFillSz: '0', avgPx: '100000' }),
    getPublicBooks5: async () => {
      books += 1;
      throw new Error('S9 book must not run for S1');
    },
    actualLeverage: 3,
    exchangeQty: 0,
    ownedOpen: false,
    hasNonterminalOpening: false,
  });
  const out = await gateway.executeOrderIntent(s1Intent(), { sessionUserId: 'user_demo_s9' });
  assert.equal(out.ok, true);
  assert.equal(books, 0);
  assert.equal(mock.calls.place.length, 1);
  assert.equal(mock.calls.place[0].sz, '2');
});

test('S9 preflight NOT_READY rejects and placeOrder=0', async () => {
  const mock = mockPlace();
  install(mock, freshBook());
  v41.health = async () => ({
    state: 'RUNNING',
    ok: true,
    S9_IMPLEMENTATION_READINESS: 'READY',
    S9_DEMO_PREFLIGHT_READINESS: 'NOT_READY',
    S9_DEMO_VALIDATION_STATUS: 'UNVERIFIED',
  });
  await assert.rejects(
    () => gateway.executeOrderIntent(s9Intent(), { sessionUserId: 'user_demo_s9' }),
    (e) => e.code === 'S9_DEMO_PREFLIGHT_NOT_READY',
  );
  assert.equal(mock.calls.place.length, 0);
});
