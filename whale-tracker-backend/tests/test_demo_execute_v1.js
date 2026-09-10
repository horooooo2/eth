'use strict';

require('./helpers/isolateSqlite');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const ready = require('../lib/v41ExecuteReadiness');
const demo = require('../lib/v41DemoExecuteV1');
const binding = require('../lib/v41UserBinding');
const gateway = require('../lib/v41ExecutionGateway');
const okx = require('../lib/okxTradeClient');
const v41 = require('../lib/v41EngineClient');

const SPEC = {
  instId: 'BTC-USDT-SWAP',
  ctVal: 0.01,
  ctValCcy: 'BTC',
  lotSz: 1,
  minSz: 1,
  tickSz: 0.1,
  state: 'live',
  source: 'mock',
};

function intent(over = {}) {
  const candle =
    over.candle || `2026-09-10T02:00:00Z-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const key = over.signal_key || `S1:BTC-USDT-SWAP:LONG:${candle}`;
  return {
    order_intent_id: `oi-v1-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    client_order_id: over.client_order_id || demo.clOrdIdFromSignal(key),
    signal_key: key,
    trade_intent_id: 'ti-v1',
    origin_trade_intent_id: 'ti-v1',
    origin_strategy_id: 'S1',
    strategy_id: 'S1',
    symbol: 'BTC-USDT-SWAP',
    side: 'buy',
    position_side: 'long',
    quantity_unit: 'BASE',
    base_quantity: 0.02,
    entry_price: 100000,
    stop_price: 98000,
    risk_amount_quote: 40,
    risk_pct: 0.004,
    reduce_only: false,
    alpha_execution: 'EXECUTE',
    live_allowed: true,
    demo_execute_v1_allowed: true,
    ...over,
  };
}

let origHealth;
beforeEach(() => {
  process.env.V41_ALPHA_EXECUTION = 'EXECUTE';
  process.env.V41_LIVE_TRADING_ENABLED = 'false';
  delete process.env.V41_ENGINE_OWNER_USER_ID;
  binding.clearBoundEngineOwner();
  ready.setInstrumentSpec(SPEC);
  gateway.setExecutionRecoveryStatus({ status: 'READY', reason: null });
  origHealth = v41.health;
  v41.health = async () => ({ state: 'RUNNING', ok: true });
});

afterEach(() => {
  v41.health = origHealth;
  process.env.V41_ALPHA_EXECUTION = 'SHADOW';
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
    getOrder: undefined,
    actualLeverage: undefined,
    exchangeQty: undefined,
    ownedOpen: undefined,
    hasNonterminalOpening: undefined,
    submitProtectiveStop: undefined,
    onProtectiveStopMissing: undefined,
  });
});

function mocks(over = {}) {
  const calls = { place: [], query: [], cancel: [], stop: [] };
  const queryState = over.queryState || 'live';
  const fillSz = over.fillSz;
  const client = {
    calls,
    async placeOrder(input) {
      calls.place.push(input);
      return { order: { ordId: `ord-${calls.place.length}`, sz: input.sz } };
    },
    async getOrder() {
      calls.query.push(true);
      return {
        state: queryState,
        accFillSz: fillSz,
        avgPx: '100000',
        ordId: 'ord-1',
      };
    },
    async cancelOrder(input) {
      calls.cancel.push(input);
      return { raw: { code: '0' } };
    },
    async withTradeCredentials(_c, fn) {
      return fn();
    },
    async resolvePosMode() {
      return over.posMode || 'net_mode';
    },
    async submitProtectiveStop() {
      calls.stop.push(true);
      if (over.stopFail) {
        const err = new Error('stop failed');
        err.code = 'PROTECTIVE_STOP_MISSING';
        throw err;
      }
      return { ok: true, status: 'active', algoId: 'algo-1' };
    },
  };
  gateway._setExecuteDeps({
    getOkxCredentialsForUser: () => ({
      apiKey: 'k',
      secret: 's',
      passphrase: 'p',
      simulated: over.live ? false : true,
    }),
    isOkxReadyForUser: () => true,
    placeOrder: client.placeOrder,
    cancelOrder: client.cancelOrder,
    withTradeCredentials: client.withTradeCredentials,
    resolvePosMode: client.resolvePosMode,
    getOrder: client.getOrder,
    readiness: ready,
    actualLeverage: over.leverage === undefined ? 3 : over.leverage,
    leverageCap: 6,
    exchangeQty: over.exchangeQty || 0,
    ownedOpen: Boolean(over.ownedOpen),
    hasNonterminalOpening: Boolean(over.hasNonterminalOpening),
    submitProtectiveStop: client.submitProtectiveStop,
    onProtectiveStopMissing: over.onStopMissing || null,
  });
  return client;
}

test('1 risk 10k 0.4% → base 0.02 (via conversion inputs)', () => {
  const converted = ready.convertBaseToOkxSz(intent(), SPEC);
  assert.equal(converted.requested_base_qty, 0.02);
});

test('2 base qty + ctVal → 2 contracts', () => {
  const c = ready.convertBaseToOkxSz(intent(), SPEC);
  assert.equal(c.raw_contracts, 2);
  assert.equal(c.final_okx_sz, '2');
  assert.equal(c.ctVal, 0.01);
});

test('3 lotSz rounding down', () => {
  const c = ready.convertBaseToOkxSz(intent({ base_quantity: 0.025 }), SPEC);
  assert.equal(c.rounded_contracts, 2);
});

test('4 minSz rejection', () => {
  assert.throws(
    () => ready.convertBaseToOkxSz(intent({ base_quantity: 0.005 }), SPEC),
    (e) => e.code === 'PRECISION_ROUNDED_TO_ZERO' || e.code === 'MIN_SIZE_REJECTED',
  );
});

test('5 metadata stale rejection', () => {
  ready.setInstrumentSpec({ stale: true });
  assert.throws(() => ready.getCachedInstrument('BTC-USDT-SWAP'), (e) => e.code === 'INSTRUMENT_METADATA_STALE');
});

test('6 leverage unknown', async () => {
  const m = mocks({ leverage: null });
  binding.bindEngineOwner('u1');
  await assert.rejects(
    () => gateway.executeOrderIntent(intent(), { sessionUserId: 'u1' }),
    (e) => e.code === 'LEVERAGE_UNKNOWN',
  );
  assert.equal(m.calls.place.length, 0);
});

test('7 leverage above cap', async () => {
  const m = mocks({ leverage: 10 });
  binding.bindEngineOwner('u1');
  await assert.rejects(
    () => gateway.executeOrderIntent(intent(), { sessionUserId: 'u1' }),
    (e) => e.code === 'LEVERAGE_ABOVE_STRATEGY_CAP',
  );
  assert.equal(m.calls.place.length, 0);
});

test('8 posMode unknown', async () => {
  const m = mocks();
  m.resolvePosMode = async () => {
    const err = new Error('unknown');
    err.code = 'POSITION_MODE_UNKNOWN';
    throw err;
  };
  gateway._setExecuteDeps({ resolvePosMode: m.resolvePosMode });
  binding.bindEngineOwner('u1');
  await assert.rejects(
    () => gateway.executeOrderIntent(intent(), { sessionUserId: 'u1' }),
    (e) => e.code === 'POSITION_MODE_UNKNOWN',
  );
});

test('9 external BTC position blocks', async () => {
  const m = mocks({ exchangeQty: 0.03 });
  binding.bindEngineOwner('u1');
  await assert.rejects(
    () => gateway.executeOrderIntent(intent(), { sessionUserId: 'u1' }),
    (e) => e.code === 'EXTERNAL_POSITION_PRESENT',
  );
  assert.equal(m.calls.place.length, 0);
});

test('10 same signal_key only one placeOrder', async () => {
  const m = mocks({ queryState: 'live' });
  binding.bindEngineOwner('u1');
  const a = intent({ candle: `2026-09-10T02:00:00Z-${Date.now()}` });
  const first = await gateway.executeOrderIntent(a, { sessionUserId: 'u1' });
  const second = await gateway.executeOrderIntent(
    { ...a, order_intent_id: `${a.order_intent_id}-b` },
    { sessionUserId: 'u1' },
  );
  assert.equal(first.report.status, 'SUBMITTED');
  assert.equal(second.idempotent, true);
  assert.equal(m.calls.place.length, 1);
});

test('11 python restart same signal no new order', async () => {
  const m = mocks();
  binding.bindEngineOwner('u1');
  const a = intent({ candle: `2026-09-10T03:00:00Z-${Date.now()}` });
  await gateway.executeOrderIntent(a, { sessionUserId: 'u1' });
  const again = await gateway.executeOrderIntent(
    { ...intent({ candle: a.candle }), signal_key: a.signal_key, client_order_id: a.client_order_id },
    { sessionUserId: 'u1' },
  );
  assert.equal(again.idempotent, true);
  assert.equal(m.calls.place.length, 1);
});

test('12 node restart SUBMITTED queries no resubmit', async () => {
  const recs = [
    {
      order_intent_id: 'oi-rec-1',
      status: 'SUBMITTED',
      client_order_id: 'cl-rec',
      exchange_order_id: 'ord-x',
      request_json: '{}',
    },
  ];
  const queries = [];
  const out = await demo.recoverNonterminal({
    listNonterminal: () => recs,
    getOrder: async () => {
      queries.push(1);
      return { state: 'live', accFillSz: '0', ordId: 'ord-x' };
    },
    upsert: () => {},
  });
  assert.equal(out[0].resubmitted, false);
  assert.equal(out[0].status, 'SUBMITTED');
  assert.equal(queries.length, 1);
});

test('13 SUBMITTED is not FILLED', async () => {
  mocks({ queryState: 'live', fillSz: '0' });
  binding.bindEngineOwner('u1');
  const out = await gateway.executeOrderIntent(intent(), { sessionUserId: 'u1' });
  assert.equal(out.report.status, 'SUBMITTED');
  assert.equal(out.report.filled_contracts, 0);
});

test('14 PARTIAL ownership is actual fill only', async () => {
  const own = demo.applyFillOwnership({ filled_contracts: 4, average_fill_price: 100000 }, { ctVal: 0.01 });
  assert.equal(own.filled_contracts, 4);
  assert.equal(own.filled_base_qty, 0.04);
  mocks({ queryState: 'partially_filled', fillSz: '1' });
  binding.bindEngineOwner('u1');
  const out = await gateway.executeOrderIntent(intent(), { sessionUserId: 'u1' });
  assert.equal(out.report.status, 'PARTIALLY_FILLED');
  assert.equal(out.report.filled_contracts, 1);
  assert.equal(out.report.filled_base_qty, 0.01);
  assert.notEqual(out.report.conversion.final_okx_sz, String(out.report.filled_contracts));
});

test('15 FILLED ownership exact', async () => {
  mocks({ queryState: 'filled', fillSz: '2' });
  binding.bindEngineOwner('u1');
  const out = await gateway.executeOrderIntent(intent(), { sessionUserId: 'u1' });
  assert.equal(out.report.status, 'FILLED');
  assert.equal(out.report.filled_contracts, 2);
  assert.equal(out.report.filled_base_qty, 0.02);
});

test('16 cancel requested != cancelled', async () => {
  const rec = { order_intent_id: 'oi-c', status: 'SUBMITTED', client_order_id: 'cl', exchange_order_id: 'o1' };
  const statuses = [];
  const out = await demo.confirmCancel(rec, {
    cancelOrder: async () => ({ ok: true }),
    getOrder: async () => ({ state: 'live', accFillSz: '0' }),
    upsert: (row) => statuses.push(row.status),
  });
  assert.equal(out.status, 'CANCEL_REQUESTED');
  assert.ok(statuses.includes('CANCEL_REQUESTED'));
  assert.ok(!statuses.includes('CANCELLED') || out.status !== 'CANCELLED');
});

test('17 cancel confirm', async () => {
  const rec = { order_intent_id: 'oi-c2', status: 'SUBMITTED', client_order_id: 'cl', exchange_order_id: 'o2' };
  const out = await demo.confirmCancel(rec, {
    cancelOrder: async () => ({ ok: true }),
    getOrder: async () => ({ state: 'canceled', accFillSz: '0' }),
    upsert: () => {},
  });
  assert.equal(out.status, 'CANCELLED');
});

test('18 cancel race → fill', async () => {
  const rec = { order_intent_id: 'oi-c3', status: 'SUBMITTED', client_order_id: 'cl', exchange_order_id: 'o3' };
  const out = await demo.confirmCancel(rec, {
    cancelOrder: async () => {
      throw new Error('already filled');
    },
    getOrder: async () => ({ state: 'filled', accFillSz: '2', avgPx: '100000' }),
    upsert: () => {},
  });
  assert.equal(out.status, 'FILLED');
});

test('19 protective stop confirmed after FILLED', async () => {
  const m = mocks({ queryState: 'filled', fillSz: '2' });
  binding.bindEngineOwner('u1');
  const out = await gateway.executeOrderIntent(intent(), { sessionUserId: 'u1' });
  assert.equal(out.report.status, 'FILLED');
  assert.equal(out.report.protective_stop.ok, true);
  assert.equal(m.calls.stop.length, 1);
});

test('20 protective stop failure flags missing', async () => {
  const flags = [];
  mocks({ queryState: 'filled', fillSz: '2', stopFail: true, onStopMissing: () => flags.push('S6') });
  binding.bindEngineOwner('u1');
  const out = await gateway.executeOrderIntent(intent(), { sessionUserId: 'u1' });
  assert.equal(out.report.protective_stop.ok, false);
  assert.equal(out.report.protective_stop.code, 'PROTECTIVE_STOP_MISSING');
  assert.deepEqual(flags, ['S6']);
});

test('21 exit always reduce-only', () => {
  assert.throws(
    () => ready.assertReduceOnlyExit({ purpose: 'exit', reduce_only: false }),
    (e) => e.code === 'REDUCE_ONLY_REQUIRED',
  );
  assert.equal(ready.assertReduceOnlyExit({ purpose: 'exit', reduce_only: true }).reduceOnly, true);
});

test('22 exit qty <= owned qty', () => {
  const cap = ready.capExitToOwned({ base_quantity: 0.03, reduce_only: true }, 0.02);
  assert.equal(cap.capped, true);
  assert.equal(cap.base_quantity, 0.02);
});

test('23 reconciliation matched helper', () => {
  const out = demo.reconcileV1({ ownedBaseQty: 0.02, exchangeBaseQty: 0.02, ownedSide: 'long', exchangeSide: 'long' });
  assert.equal(out.status, 'MATCHED');
  assert.equal(out.block, false);
});

test('24 qty mismatch is a block reason', () => {
  const out = demo.reconcileV1({ ownedBaseQty: 0.02, exchangeBaseQty: 0.03 });
  assert.equal(out.status, 'QTY_MISMATCH');
  assert.equal(out.block, true);
  assert.equal(out.reason_code, 'RECONCILIATION_MISMATCH');
});

test('25 external/manual position protected', async () => {
  const m = mocks({ exchangeQty: 1 });
  binding.bindEngineOwner('u1');
  await assert.rejects(
    () => gateway.executeOrderIntent(intent(), { sessionUserId: 'u1' }),
    (e) => e.code === 'EXTERNAL_POSITION_PRESENT',
  );
  assert.equal(m.calls.place.length, 0);
});

test('26 SHADOW still WOULD_SUBMIT only', async () => {
  process.env.V41_ALPHA_EXECUTION = 'SHADOW';
  const m = mocks();
  binding.bindEngineOwner('u1');
  const out = await gateway.executeOrderIntent(
    { ...intent(), alpha_execution: 'SHADOW', shadow: true },
    { sessionUserId: 'u1' },
  );
  assert.equal(out.shadow, true);
  assert.equal(out.report.status, 'WOULD_SUBMIT');
  assert.equal(m.calls.place.length, 0);
});

test('S2 execute v1 blocked', async () => {
  mocks();
  binding.bindEngineOwner('u1');
  await assert.rejects(
    () =>
      gateway.executeOrderIntent(intent({ origin_strategy_id: 'S2', strategy_id: 'S2', demo_execute_v1_allowed: false }), {
        sessionUserId: 'u1',
      }),
    (e) => e.code === 'DEMO_EXECUTE_V1_STRATEGY_BLOCKED',
  );
});

test('isolated margin blocked', async () => {
  mocks();
  binding.bindEngineOwner('u1');
  await assert.rejects(
    () => gateway.executeOrderIntent(intent({ td_mode: 'isolated' }), { sessionUserId: 'u1' }),
    (e) => e.code === 'UNSUPPORTED_MARGIN_MODE',
  );
});

test('risk sanity 1.05', () => {
  const converted = ready.convertBaseToOkxSz(intent(), SPEC);
  const ok = ready.assertRiskSanity(intent(), converted);
  assert.ok(ok.actual_risk <= 40 * 1.05);
  assert.throws(
    () => ready.assertRiskSanity(intent({ risk_amount_quote: 0.01 }), converted),
    (e) => e.code === 'RISK_SANITY_FAILED',
  );
});
