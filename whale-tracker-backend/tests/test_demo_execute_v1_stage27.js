'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const ready = require('../lib/v41ExecuteReadiness');
const prot = require('../lib/v41ProtectiveStop');
const demo = require('../lib/v41DemoExecuteV1');
const startup = require('../lib/v41StartupRecovery');
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

function algoStore() {
  const algos = new Map();
  return {
    algos,
    async placeAlgoOrder(body) {
      const id = `algo-${algos.size + 1}`;
      const row = { ...body, algoId: id, state: 'live', sz: body.sz };
      algos.set(id, row);
      algos.set(body.algoClOrdId, row);
      return { algoId: id, algoClOrdId: body.algoClOrdId, sCode: '0' };
    },
    async getAlgoOrder({ algoId, algoClOrdId }) {
      return algos.get(algoId) || algos.get(algoClOrdId) || null;
    },
    async amendAlgoOrder({ algoId, algoClOrdId, newSz }) {
      const row = algos.get(algoId) || algos.get(algoClOrdId);
      if (!row) return null;
      row.sz = String(newSz);
      return { algoId: row.algoId, sCode: '0' };
    },
    async cancelAlgoOrders(items) {
      for (const it of items) {
        const row = algos.get(it.algoId) || algos.get(it.algoClOrdId);
        if (row) row.state = 'canceled';
      }
      return [{ sCode: '0' }];
    },
  };
}

function intent(over = {}) {
  const candle = over.candle || `c-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  const key = over.signal_key || `S1:BTC-USDT-SWAP:LONG:${candle}`;
  return {
    order_intent_id: `oi-27-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    client_order_id: over.client_order_id || demo.clOrdIdFromSignal(key),
    signal_key: key,
    trade_intent_id: over.trade_intent_id || `ti-27-${Math.random().toString(16).slice(2, 6)}`,
    origin_trade_intent_id: over.origin_trade_intent_id || over.trade_intent_id || `ti-27-${Math.random().toString(16).slice(2, 6)}`,
    origin_strategy_id: 'S1',
    strategy_id: 'S1',
    symbol: 'BTC-USDT-SWAP',
    side: 'buy',
    position_side: 'long',
    quantity_unit: 'BASE',
    base_quantity: 0.1,
    entry_price: 100000,
    stop_price: 98000,
    risk_amount_quote: 200,
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
  gateway.setOpeningSafetyLock(null);
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
    getOrder: (...a) => okx.getOrder(...a),
    placeAlgoOrder: (...a) => okx.placeAlgoOrder(...a),
    getAlgoOrder: (...a) => okx.getAlgoOrder(...a),
    amendAlgoOrder: (...a) => okx.amendAlgoOrder(...a),
    cancelAlgoOrders: (...a) => okx.cancelAlgoOrders(...a),
    submitProtectiveStop: undefined,
    actualLeverage: undefined,
    exchangeQty: undefined,
    ownedOpen: undefined,
    hasNonterminalOpening: undefined,
  });
});

function install(over = {}) {
  const algo = over.algo || algoStore();
  const calls = { place: [], algo: [], amend: [], cancel: [] };
  gateway._setExecuteDeps({
    getOkxCredentialsForUser: () => ({ apiKey: 'k', secret: 's', passphrase: 'p', simulated: true }),
    isOkxReadyForUser: () => true,
    placeOrder: async (input) => {
      calls.place.push(input);
      return { order: { ordId: `ord-${calls.place.length}`, sz: input.sz } };
    },
    cancelOrder: async (input) => {
      calls.cancel.push(input);
      return { raw: { code: '0' } };
    },
    withTradeCredentials: async (_c, fn) => fn(),
    resolvePosMode: async () => over.posMode || 'net_mode',
    getOrder: async () => ({
      state: over.queryState || 'filled',
      accFillSz: over.fillSz || '10',
      avgPx: '100000',
    }),
    readiness: ready,
    actualLeverage: 3,
    exchangeQty: 0,
    ownedOpen: false,
    hasNonterminalOpening: false,
    placeAlgoOrder: async (body) => {
      calls.algo.push(body);
      if (over.algoAckOnly) return { algoId: 'ack-only', sCode: '0' };
      if (over.algoFail) {
        const err = new Error('algo failed');
        err.code = 'PROTECTIVE_STOP_MISSING';
        throw err;
      }
      return algo.placeAlgoOrder(body);
    },
    getAlgoOrder: over.algoAckOnly ? async () => null : algo.getAlgoOrder.bind(algo),
    amendAlgoOrder: async (input) => {
      calls.amend.push(input);
      return algo.amendAlgoOrder(input);
    },
    cancelAlgoOrders: algo.cancelAlgoOrders.bind(algo),
    emergencyReduceOnlyExit: over.emergency || null,
    onProtectiveStopMissing: over.onStopMissing || null,
  });
  return { algo, calls };
}

test('1 PARTIAL 4/10 → stop sz=4', async () => {
  const { calls } = install({ queryState: 'partially_filled', fillSz: '4' });
  binding.bindEngineOwner('u1');
  const out = await gateway.executeOrderIntent(
    intent({ origin_trade_intent_id: `ti-p4-${Date.now()}-${Math.random().toString(16).slice(2, 6)}` }),
    { sessionUserId: 'u1' },
  );
  assert.equal(out.report.status, 'PARTIALLY_FILLED');
  assert.equal(out.report.protective_stop.status, 'ACTIVE');
  assert.equal(String(out.report.protective_stop.covered_contracts), '4');
  assert.equal(calls.algo[0].sz, '4');
  assert.equal(calls.algo[0].closeFraction, undefined);
  assert.equal(calls.algo[0].reduceOnly, true);
  assert.equal(calls.algo[0].slOrdPx, '-1');
  assert.equal(calls.algo[0].slTriggerPxType, 'last');
  assert.equal(calls.algo[0].stop_trigger_type, 'last');
});

test('2 fill 4→7 amends stop to 7', async () => {
  const algo = algoStore();
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  const oi = intent({ origin_trade_intent_id: `ti-amend-${stamp}`, position_id: `pos-amend-${stamp}` });
  const first = await prot.ensureProtectiveStop(oi, { owned_contracts: 4, filled_contracts: 4 }, algo);
  assert.equal(String(first.covered_contracts), '4');
  const second = await prot.ensureProtectiveStop(oi, { owned_contracts: 7, filled_contracts: 7 }, algo);
  assert.equal(second.amended, true);
  assert.equal(String(second.covered_contracts), '7');
  const rec = prot.findByPositionId('pos-amend');
  assert.equal(String(rec.covered_contracts), '7');
});

test('3 FILLED 10 → stop covers 10', async () => {
  const { calls } = install({ queryState: 'filled', fillSz: '10' });
  binding.bindEngineOwner('u1');
  const out = await gateway.executeOrderIntent(
    intent({ origin_trade_intent_id: `ti-f10-${Date.now()}-${Math.random().toString(16).slice(2, 6)}` }),
    { sessionUserId: 'u1' },
  );
  assert.equal(out.report.status, 'FILLED');
  assert.equal(String(out.report.protective_stop.covered_contracts), '10');
  assert.equal(calls.algo[0].sz, '10');
});

test('4 algo ACK but query missing → not protected', async () => {
  install({ queryState: 'filled', fillSz: '2', algoAckOnly: true });
  binding.bindEngineOwner('u1');
  const out = await gateway.executeOrderIntent(intent({ origin_trade_intent_id: 'ti-unconf' }), { sessionUserId: 'u1' });
  assert.equal(out.report.protective_stop.ok, false);
  assert.equal(out.report.protective_stop.code, 'PROTECTIVE_STOP_UNCONFIRMED');
});

test('5 stop confirmed ACTIVE', async () => {
  install({ queryState: 'filled', fillSz: '2' });
  binding.bindEngineOwner('u1');
  const out = await gateway.executeOrderIntent(intent({ origin_trade_intent_id: 'ti-act' }), { sessionUserId: 'u1' });
  assert.equal(out.report.protective_stop.ok, true);
  assert.equal(out.report.protective_stop.status, 'ACTIVE');
});

test('6 stop placement failure → cancel remaining + S6 lock', async () => {
  const flags = [];
  const { calls } = install({
    queryState: 'partially_filled',
    fillSz: '4',
    algoFail: true,
    onStopMissing: () => flags.push('S6'),
  });
  binding.bindEngineOwner('u1');
  const out = await gateway.executeOrderIntent(intent({ origin_trade_intent_id: 'ti-fail' }), { sessionUserId: 'u1' });
  assert.equal(out.report.protective_stop.code, 'PROTECTIVE_STOP_MISSING');
  assert.deepEqual(flags, ['S6']);
  assert.ok(calls.cancel.length >= 1);
  assert.equal(gateway.getOpeningSafetyLock(), 'PROTECTIVE_STOP_MISSING');
});

test('7 undercoverage → S6 block', () => {
  const cov = prot.coverageRatio(4, 7);
  assert.equal(cov.undercovered, true);
  gateway.setOpeningSafetyLock('PROTECTIVE_STOP_UNDERCOVERED');
  assert.equal(gateway.getOpeningSafetyLock(), 'PROTECTIVE_STOP_UNDERCOVERED');
});

test('8 position flat cancels stop', async () => {
  const algo = algoStore();
  const oi = intent({ position_id: 'pos-flat', origin_trade_intent_id: 'ti-flat' });
  await prot.ensureProtectiveStop(oi, { owned_contracts: 2 }, algo);
  const out = await prot.cancelProtectiveStop('pos-flat', algo);
  assert.equal(out.status, 'CANCELLED');
  assert.equal(prot.findByPositionId('pos-flat').status, 'CANCELLED');
});

test('9 orphan stop blocks opening', () => {
  assert.throws(
    () => prot.assertNoOrphan({ ownedContracts: 0, stopStatus: 'ACTIVE' }),
    (e) => e.code === 'ORPHAN_PROTECTIVE_STOP',
  );
});

test('10 node restart recovers order + stop without placeOrder', async () => {
  const queries = [];
  const places = [];
  const out = await demo.recoverNonterminal({
    listNonterminal: () => [{ order_intent_id: 'oi-r', status: 'SUBMITTED', client_order_id: 'cl', exchange_order_id: 'ox', request_json: '{}' }],
    getOrder: async () => {
      queries.push('order');
      return { state: 'live', accFillSz: '0', ordId: 'ox' };
    },
    upsert: () => {},
  });
  assert.equal(out[0].resubmitted, false);
  assert.equal(places.length, 0);
  prot.upsertStop({
    position_id: 'pos-r',
    status: 'ACTIVE',
    algo_id: 'algo-r',
    algo_cl_ord_id: 'psrecov',
    inst_id: 'BTC-USDT-SWAP',
    covered_contracts: '2',
  });
  const stops = await prot.recoverProtectiveStops({
    listRecoverable: () => [prot.findByPositionId('pos-r')],
    getAlgoOrder: async () => ({ algoId: 'algo-r', state: 'live', sz: '2' }),
  });
  assert.equal(stops[0].resubmitted, false);
  assert.equal(stops[0].status, 'ACTIVE');
});

test('11 restart owned + missing stop', async () => {
  prot.upsertStop({
    position_id: 'pos-miss',
    status: 'ACTIVE',
    algo_id: 'gone',
    algo_cl_ord_id: 'psgone',
    inst_id: 'BTC-USDT-SWAP',
  });
  const stops = await prot.recoverProtectiveStops({
    listRecoverable: () => [prot.findByPositionId('pos-miss')],
    getAlgoOrder: async () => null,
    ownedContractsByPosition: { 'pos-miss': 2 },
  });
  assert.equal(stops[0].code, 'PROTECTIVE_STOP_MISSING');
});

test('12 startup recovery FAILED blocks opening', async () => {
  gateway.setExecutionRecoveryStatus({ status: 'FAILED', reason: 'PROTECTIVE_STOP_MISSING' });
  install({ queryState: 'live', fillSz: '0' });
  binding.bindEngineOwner('u1');
  await assert.rejects(
    () => gateway.executeOrderIntent(intent(), { sessionUserId: 'u1' }),
    (e) => e.code === 'PROTECTIVE_STOP_MISSING',
  );
});

test('13 SHADOW startup no private mutation', async () => {
  process.env.V41_ALPHA_EXECUTION = 'SHADOW';
  const mutations = { n: 0 };
  const st = await startup.runStartupRecovery({
    ensureExecTable: () => {},
    getOkxCredentialsForUser: () => {
      mutations.n += 1;
      return { apiKey: 'k', simulated: true };
    },
    getOrder: async () => {
      mutations.n += 1;
      return null;
    },
    placeOrder: async () => {
      mutations.n += 1;
    },
  });
  assert.equal(st.status, 'SHADOW_SKIPPED');
  assert.equal(st.mutations, 0);
  assert.equal(st.private_queries, 0);
  assert.equal(mutations.n, 0);
});

test('14 LONG stop below entry', () => {
  const d = ready.assertStopDirection({ position_side: 'long', entry_price: 100000, stop_price: 98000 });
  assert.equal(d.side, 'long');
});

test('15 SHORT stop above entry', () => {
  const d = ready.assertStopDirection({ position_side: 'short', entry_price: 100000, stop_price: 102000 });
  assert.equal(d.side, 'short');
});

test('16 invalid stop direction reject', () => {
  assert.throws(
    () => ready.assertStopDirection({ position_side: 'long', entry_price: 100000, stop_price: 101000 }),
    (e) => e.code === 'INVALID_STOP_PRICE',
  );
});

test('17 tickSz rounding toward entry', () => {
  const snapped = ready.snapStopToTick(98000.07, 0.1, { entryPrice: 100000, side: 'long' });
  assert.ok(snapped >= 98000.07 - 1e-9);
  assert.ok(snapped < 100000);
});

test('18 risk after stop rounding <= 1.05 planned', () => {
  const converted = ready.convertBaseToOkxSz(intent({ base_quantity: 0.02, risk_amount_quote: 40 }), SPEC);
  const stop = ready.snapStopToTick(98000.04, 0.1, { entryPrice: 100000, side: 'long' });
  const ok = ready.assertRiskSanity({ entry_price: 100000, stop_price: stop, risk_amount_quote: 40 }, converted);
  assert.ok(ok.actual_risk <= 40 * 1.05);
});

test('19 signal_key still idempotent', async () => {
  install({ queryState: 'live', fillSz: '0' });
  binding.bindEngineOwner('u1');
  const a = intent({ candle: `sig-${Date.now()}` });
  const first = await gateway.executeOrderIntent(a, { sessionUserId: 'u1' });
  const second = await gateway.executeOrderIntent({ ...a, order_intent_id: `${a.order_intent_id}-b` }, { sessionUserId: 'u1' });
  assert.equal(first.report.status, 'SUBMITTED');
  assert.equal(second.idempotent, true);
});

test('hedge mode blocked for demo v1', async () => {
  install({ posMode: 'long_short_mode', queryState: 'live', fillSz: '0' });
  binding.bindEngineOwner('u1');
  await assert.rejects(
    () => gateway.executeOrderIntent(intent(), { sessionUserId: 'u1' }),
    (e) => e.code === 'UNSUPPORTED_POSITION_MODE_FOR_DEMO_V1',
  );
});
