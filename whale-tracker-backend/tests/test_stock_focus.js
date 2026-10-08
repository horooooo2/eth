const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
require('./helpers/isolateSqlite');

function load(relative, mocks, env = {}) {
  const filename = path.resolve(__dirname, '..', relative);
  const realRequire = createRequire(filename);
  const context = { module: { exports: {} }, __dirname: path.dirname(filename), console,
    process: { env }, setTimeout, clearTimeout, setInterval, clearInterval,
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : realRequire(name) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context.module.exports;
}

test('old 200-account configuration is capped at 50, with manual accounts first', () => {
  const whales = Array.from({ length: 200 }, (_, i) => ({ id: String(i),
    address: '0x' + (i + 1).toString(16).padStart(40, '0'), enabled: true,
    priority: i, manual: i === 0 }));
  const config = load('lib/config.js', { fs: { existsSync: () => true,
    readFileSync: () => JSON.stringify({ whales }) } }, { TOP_WHALE_LIMIT: '200' });
  const active = config.getActiveWhales();
  assert.equal(active.length, 50);
  assert.equal(active[0].id, '0');
  assert.equal(active[1].id, '199');
});

test('WS subscriptions exclude accounts left in the old cache', () => {
  const whales = [{ id: 'active', address: 'a', netUsd: 100 }, { id: 'retired', address: 'b', netUsd: 1000 }];
  const bridge = load('lib/realtimeBridge.js', {
    './config': { getActiveWhales: () => [whales[0]], normalizeAddress: x => x },
    './cache': { readWhaleModeCache: () => ({ data: { whales } }) },
  });
  assert.equal(bridge.syncFromCache().whales, 1);
  assert.equal(bridge.syncFromCache().uniqueUsers, 1);
});

test('legacy alert queries cannot request totals, facets, later pages or more than 50 rows', () => {
  const handlers = new Map();
  const router = { get: (route, handler) => handlers.set(route, handler), use() {}, post() {}, put() {}, delete() {}, patch() {} };
  const queries = [];
  let summaries = 0;
  load('routes/whales.js', {
    express: { Router: () => router },
    '../lib/sqliteStore': { loadPagedAlerts: query => { queries.push(query); return { alerts: [] }; },
      loadAlertFlowSummary: () => { summaries++; } },
    '../lib/whaleSync': { initialize() {}, stream: { cursor: () => ({ epoch: 'test', seq: 0 }) } },
  });
  let status = 200;
  const res = { json() {}, status(value) { status = value; return this; } };
  for (const query of [{}, { page: '100', limit: '10000', rowsOnly: 'false', side: 'long' }]) {
    handlers.get('/alert-history')({ query }, res);
  }
  assert.equal(queries.length, 2);
  for (const query of queries) {
    assert.equal(query.page, 1); assert.equal(query.limit, 50); assert.equal(query.rowsOnly, true);
  }
  assert.equal(queries[1].side, 'long');
  handlers.get('/alert-history/summary')({}, res);
  assert.equal(status, 410); assert.equal(summaries, 0);
});

test('old fill coverage resumes within the last day, not at the obsolete watermark', async () => {
  const now = Date.now(), day = 86400000;
  let state = { a: { through: now - 7 * day, latestObservedAt: now, latestCoverageStart: now - 60000 } };
  let requested;
  const backfill = load('lib/fillBackfill.js', {
    './config': { getActiveWhales: () => [{ id: 'a', address: 'a' }], normalizeAddress: x => x },
    './db': { getMeta: () => ({ value: JSON.stringify(state) }), setMeta: (_, value) => { state = JSON.parse(value); } },
    './cache': { commitWhaleState() {} },
    './hyperliquid': { FILL_LOOKBACK_MS: day, mapFillToTrade: x => x,
      fetchUserFillsByTime: async (_, start, end) => { requested = { start, end }; return []; } },
  });
  await backfill.runHistoryTick();
  assert.ok(requested.start >= now - day);
  assert.ok(requested.end > requested.start);
  assert.equal(state.a.through, requested.end);
});
