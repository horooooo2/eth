'use strict';

require('./helpers/isolateSqlite');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const ev = require('../lib/v41RuntimeEvents');

function memoryDb() {
  const db = new Database(':memory:');
  ev.ensureTable(db);
  return db;
}

function put(row, db) {
  return ev.append(row, db, { allowInjected: true });
}

test('UI disconnect: events A/B/C remain queryable from the server store', () => {
  const db = memoryDb();
  const a = put({ event_id: 'A', event_type: 'ENGINE_START', occurred_at: '2026-09-10T01:00:00.000Z' }, db);
  // no browser connected
  const b = put({ event_id: 'B', event_type: 'STRATEGY_NO_TRADE', occurred_at: '2026-09-10T01:01:00.000Z', strategy_id: 'S1', symbol: 'BTC-USDT-SWAP', decision: 'NO_TRADE', reason_codes: ['CLOSE_VS_EMA20'], source_closed_candle_timestamp: 'c1' }, db);
  const c = ev.recordGatewayReport({
    order_intent_id: 'oi-1',
    status: 'FILLED',
    submitted_at: '2026-09-10T01:02:00.000Z',
    completed_at: '2026-09-10T01:02:00.000Z',
    origin_strategy_id: 'S1',
    symbol: 'BTC-USDT-SWAP',
  }, db);
  const rows = ev.list({ limit: 20 }, db);
  const ids = rows.map((r) => r.event_id);
  assert.ok(a);
  assert.ok(b);
  assert.ok(c.length);
  assert.ok(ids.includes('A'));
  assert.ok(ids.includes('B'));
  assert.ok(ids.some((id) => String(id).includes('ORDER_FILLED')));
});

test('server restart: new store instance still has A/B/C', () => {
  const db = memoryDb();
  put({ event_id: 'A', event_type: 'ENGINE_START', occurred_at: '2026-09-10T01:00:00.000Z' }, db);
  put({ event_id: 'B', event_type: 'ORDER_SUBMITTED', occurred_at: '2026-09-10T01:01:00.000Z', order_intent_id: 'oi-1' }, db);
  put({ event_id: 'C', event_type: 'ORDER_FILLED', occurred_at: '2026-09-10T01:02:00.000Z', order_intent_id: 'oi-1' }, db);
  const dump = db.serialize();
  const restored = new Database(dump);
  ev.ensureTable(restored);
  const ids = ev.list({ limit: 20 }, restored).map((r) => r.event_id).sort();
  assert.deepEqual(ids, ['A', 'B', 'C']);
});

test('NO_TRADE same candle + reasons inserts once; order fills never dedupe', () => {
  const db = memoryDb();
  const payload = {
    event_type: 'STRATEGY_NO_TRADE',
    strategy_id: 'S1',
    symbol: 'BTC-USDT-SWAP',
    decision: 'NO_TRADE',
    reason_codes: ['CLOSE_VS_EMA20', 'S3_DIRECTION_BLOCK'],
    source_closed_candle_timestamp: '2026-09-10T04:00:00Z',
  };
  const first = put({ ...payload, event_id: 'nt-1' }, db);
  const second = put({ ...payload, event_id: 'nt-2' }, db);
  assert.ok(first);
  assert.equal(second, null);
  assert.equal(ev.list({ event_type: 'STRATEGY_NO_TRADE' }, db).length, 1);

  ev.recordGatewayReport({ order_intent_id: 'oi-1', status: 'SUBMITTED', submitted_at: 't1' }, db);
  ev.recordGatewayReport({ order_intent_id: 'oi-1', status: 'PARTIALLY_FILLED', first_fill_at: 't2' }, db);
  ev.recordGatewayReport({ order_intent_id: 'oi-1', status: 'FILLED', completed_at: 't3' }, db);
  const types = ev.list({ limit: 20 }, db).map((r) => r.event_type);
  assert.ok(types.includes('ORDER_SUBMITTED'));
  assert.ok(types.includes('ORDER_PARTIALLY_FILLED'));
  assert.ok(types.includes('ORDER_FILLED'));
});

test('history merge dedupes the same event_id from python + node', () => {
  const python = [
    { event_id: 'shared', occurred_at: '2026-09-10T01:00:00Z', event_type: 'ORDER_FILLED', order_intent_id: 'oi-1' },
    { event_id: 'py-only', occurred_at: '2026-09-10T01:01:00Z', event_type: 'ENGINE_START' },
  ];
  const node = [
    { event_id: 'shared', occurred_at: '2026-09-10T01:00:00Z', event_type: 'ORDER_FILLED', order_intent_id: 'oi-1' },
    { event_id: 'node-only', occurred_at: '2026-09-10T01:02:00Z', event_type: 'STARTUP_RECOVERY_READY' },
  ];
  const merged = ev.mergeEvents(python, node, { limit: 200 });
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.map((r) => r.event_id).sort(), ['node-only', 'py-only', 'shared']);
});

test('secrets are redacted in details', () => {
  const db = memoryDb();
  const saved = put({
    event_id: 'sec-1',
    event_type: 'ORDER_SUBMITTED',
    details: { api_secret: 'super-secret', passphrase: 'pp', Authorization: 'Bearer x', safe: 1 },
  }, db);
  assert.equal(saved.details.api_secret, '[REDACTED]');
  assert.equal(saved.details.passphrase, '[REDACTED]');
  assert.equal(saved.details.Authorization, '[REDACTED]');
  assert.equal(saved.details.safe, 1);
});

test('empty order_intent_id does not merge same event_type across stores', () => {
  const python = [
    { event_id: 'py_nt_1', occurred_at: '2026-09-10T04:00:00Z', event_type: 'STRATEGY_NO_TRADE' },
    { event_id: 'py_nt_2', occurred_at: '2026-09-10T05:00:00Z', event_type: 'STRATEGY_NO_TRADE' },
    { event_id: 'py_s6_1', occurred_at: '2026-09-10T06:00:00Z', event_type: 'S6_BLOCK' },
    { event_id: 'py_eng_1', occurred_at: '2026-09-10T07:00:00Z', event_type: 'ENGINE_START' },
  ];
  const node = [
    { event_id: 'node_s6_2', occurred_at: '2026-09-10T06:01:00Z', event_type: 'S6_BLOCK' },
    { event_id: 'node_eng_2', occurred_at: '2026-09-10T07:01:00Z', event_type: 'ENGINE_START' },
  ];
  const merged = ev.mergeEvents(python, node, { limit: 200 });
  assert.equal(merged.length, 6);
  assert.equal(ev.logicalKey(python[0]), '');
  assert.ok(ev.logicalKey({ event_type: 'ORDER_FILLED', order_intent_id: 'oi-1', details: { accFillSz: 10 } }));
});

test('order_intent_id present is the only cross-store type key', () => {
  const python = [
    { event_id: 'py_fill', occurred_at: '2026-09-10T01:00:00Z', event_type: 'ORDER_FILLED', order_intent_id: 'oi-1' },
    { event_id: 'py_fill_empty', occurred_at: '2026-09-10T01:01:00Z', event_type: 'ORDER_FILLED' },
  ];
  const node = [
    { event_id: 'node_fill', occurred_at: '2026-09-10T01:00:00Z', event_type: 'ORDER_FILLED', order_intent_id: 'oi-1' },
    { event_id: 'node_fill_empty', occurred_at: '2026-09-10T01:02:00Z', event_type: 'ORDER_FILLED' },
  ];
  const merged = ev.mergeEvents(python, node, { limit: 200 });
  const ids = merged.map((r) => r.event_id).sort();
  assert.deepEqual(ids, ['node_fill_empty', 'py_fill', 'py_fill_empty']);
});

test('generated node event_id cannot collide with python prefix', () => {
  const id = ev.newEventId();
  assert.match(id, /^node_/);
  assert.equal(id.startsWith('py_'), false);
});

test('merged pagination with identical occurred_at visits each event once', () => {
  const ts = '2026-09-10T04:00:00.000Z';
  const python = [
    { event_id: 'py_c', occurred_at: ts, event_type: 'S6_BLOCK' },
    { event_id: 'py_a', occurred_at: ts, event_type: 'ENGINE_START' },
  ];
  const node = [
    { event_id: 'node_d', occurred_at: ts, event_type: 'STRATEGY_NO_TRADE' },
    { event_id: 'node_b', occurred_at: ts, event_type: 'S6_BLOCK' },
  ];
  const expected = [...python, ...node].sort(ev.compareEventDesc).map((r) => r.event_id);
  const seen = [];
  let before;
  let beforeEventId;
  for (let i = 0; i < 8; i += 1) {
    const page = ev.mergeEvents(python, node, {
      limit: 2,
      before,
      before_event_id: beforeEventId,
    });
    if (!page.length) break;
    seen.push(...page.map((r) => r.event_id));
    before = page[page.length - 1].occurred_at;
    beforeEventId = page[page.length - 1].event_id;
  }
  assert.deepEqual(seen, expected);
  assert.equal(new Set(seen).size, 4);
});

test('Python and Node PARTIAL same qty merge to one history row', () => {
  const python = [{
    event_id: 'py_partial_4',
    occurred_at: '2026-09-10T01:00:00Z',
    event_type: 'ORDER_PARTIALLY_FILLED',
    order_intent_id: 'oi_123',
    details: { accFillSz: 4, exchange_order_id: 'ord-1' },
  }];
  const node = [{
    event_id: 'node_partial_4',
    occurred_at: '2026-09-10T01:00:00Z',
    event_type: 'ORDER_PARTIALLY_FILLED',
    order_intent_id: 'oi_123',
    details: { accFillSz: 4, exchange_order_id: 'ord-1' },
  }];
  assert.equal(ev.logicalKey(python[0]), ev.logicalKey(node[0]));
  const merged = ev.mergeEvents(python, node, { limit: 20 });
  assert.equal(merged.length, 1);
});

test('PARTIAL 4 and PARTIAL 7 are both kept', () => {
  const events = [
    {
      event_id: 'py_p4',
      occurred_at: '2026-09-10T01:00:00Z',
      event_type: 'ORDER_PARTIALLY_FILLED',
      order_intent_id: 'oi_123',
      details: { accFillSz: 4 },
    },
    {
      event_id: 'node_p7',
      occurred_at: '2026-09-10T01:00:01Z',
      event_type: 'ORDER_PARTIALLY_FILLED',
      order_intent_id: 'oi_123',
      details: { accFillSz: 7 },
    },
  ];
  assert.notEqual(ev.logicalKey(events[0]), ev.logicalKey(events[1]));
  const merged = ev.mergeEvents(events, [], { limit: 20 });
  assert.equal(merged.length, 2);
});

test('PARTIAL 4 → 7 → FILLED 10 keeps three stages', () => {
  const db = memoryDb();
  ev.recordGatewayReport({ order_intent_id: 'oi_123', status: 'PARTIALLY_FILLED', accFillSz: 4, filled_contracts: 4 }, db);
  ev.recordGatewayReport({ order_intent_id: 'oi_123', status: 'PARTIALLY_FILLED', accFillSz: 7, filled_contracts: 7 }, db);
  ev.recordGatewayReport({ order_intent_id: 'oi_123', status: 'FILLED', accFillSz: 10, filled_contracts: 10 }, db);
  const rows = ev.list({ limit: 20 }, db);
  const fills = rows.filter((r) => String(r.event_type).startsWith('ORDER_'));
  assert.equal(fills.length, 3);
  assert.deepEqual(
    fills.map((r) => `${r.event_type}:${r.details.accFillSz}`).sort(),
    ['ORDER_FILLED:10', 'ORDER_PARTIALLY_FILLED:4', 'ORDER_PARTIALLY_FILLED:7'],
  );
});

test('protective stop cover 4 then amend 7 keeps both events', () => {
  const db = memoryDb();
  ev.recordGatewayReport({
    order_intent_id: 'oi_123',
    status: 'FILLED',
    filled_contracts: 4,
    protective_stop: { status: 'ACTIVE', position_id: 'pos-1', covered_contracts: 4, ok: true },
  }, db);
  ev.recordGatewayReport({
    order_intent_id: 'oi_123',
    status: 'PARTIALLY_FILLED',
    filled_contracts: 7,
    protective_stop: { status: 'AMENDED', position_id: 'pos-1', covered_contracts: 7, ok: true },
  }, db);
  const types = ev.list({ limit: 20 }, db).map((r) => r.event_type);
  assert.ok(types.includes('PROTECTIVE_STOP_ACTIVE'));
  assert.ok(types.includes('PROTECTIVE_STOP_AMENDED'));
  const stops = ev.list({ limit: 20 }, db).filter((r) => String(r.event_type).startsWith('PROTECTIVE_STOP_'));
  assert.equal(stops.length, 2);
  assert.deepEqual(stops.map((r) => String(r.details.covered_contracts)).sort(), ['4', '7']);
});

test('production auto event_id stays in py_/node_ namespace', () => {
  const db = memoryDb();
  const auto = ev.append({ event_type: 'ENGINE_START' }, db);
  assert.match(auto.event_id, /^node_/);
  const rewritten = ev.append({ event_id: 'bare-id', event_type: 'S6_BLOCK' }, db);
  assert.match(rewritten.event_id, /^node_/);
  assert.notEqual(rewritten.event_id, 'bare-id');
  const injected = ev.append({ event_id: 'bare-id', event_type: 'S6_LOCK' }, db, { allowInjected: true });
  assert.equal(injected.event_id, 'bare-id');
  const report = ev.recordGatewayReport({ order_intent_id: 'oi-9', status: 'FILLED', filled_contracts: 10 }, db);
  assert.ok(report[0].event_id.startsWith('node:'));
  assert.ok(ev.hasEventIdNamespace(ev.newEventId()));
  assert.ok(ev.hasEventIdNamespace('py_abc'));
  assert.equal(ev.hasEventIdNamespace('bare-id'), false);
});

test('protective stop and recovery events persist', () => {
  const db = memoryDb();
  ev.recordRecovery('STARTED', { event_id: 'rec-s', at: '2026-09-10T01:00:00.000Z' }, db);
  ev.recordRecovery('READY', { event_id: 'rec-r', at: '2026-09-10T01:00:01.000Z' }, db);
  ev.recordReconciliation(false, { event_id: 'rec-m', reason_code: 'RECONCILIATION_MISMATCH' }, db);
  ev.recordGatewayReport({
    order_intent_id: 'oi-9',
    status: 'FILLED',
    protective_stop: { status: 'ACTIVE', position_id: 'pos-1', ok: true },
  }, db);
  const types = ev.list({ limit: 20 }, db).map((r) => r.event_type);
  assert.ok(types.includes('STARTUP_RECOVERY_STARTED'));
  assert.ok(types.includes('STARTUP_RECOVERY_READY'));
  assert.ok(types.includes('RECONCILIATION_MISMATCH'));
  assert.ok(types.includes('PROTECTIVE_STOP_ACTIVE'));
});
