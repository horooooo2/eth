const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const lib = path.resolve(__dirname, '../lib');
const plain = (value) => JSON.parse(JSON.stringify(value));
function load(name, mocks, extra = {}) {
  const filename = path.join(lib, name);
  const realRequire = createRequire(filename);
  const context = { module: { exports: {} }, exports: {}, __dirname: lib,
    require: (id) => Object.hasOwn(mocks, id) ? mocks[id] : realRequire(id),
    process: { env: {}, pid: process.pid }, structuredClone, console: { log() {}, warn() {} },
    setTimeout: () => ({ unref() {} }), clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {},
    ...extra };
  let clock = Date.now();
  if (name === 'fillBackfill.js') context.Date = class extends Date { static now() { return clock; } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  if (name === 'fillBackfill.js') { const tick = context.module.exports.runOneTick; context.module.exports.runOneTick = () => { clock += 121000; return tick(); }; }
  return context.module.exports;
}
function stateFixture() {
  let stored = { updatedAt: 1, data: { whales: [], trades: [] } };
  let failure = false;
  const writes = [];
  const cache = load('cache.js', {
    './sqliteStore': {
      loadModePayload: () => structuredClone(stored),
      persistStatePatch: (patch) => {
        if (failure) throw new Error('disk full');
        writes.push(plain(patch));
        return { committedAlerts: patch.snapshotAlerts || [] };
      },
    },
    fs: { existsSync: () => false },
  });
  return { cache, writes, fail: () => { failure = true; }, setStored: (value) => { stored = value; } };
}
const whale = (id, size = 1) => ({ id, name: id, address: id, positions: [{ coin: 'ETH', side: 'long', size, unrealizedPnl: size * 10 }], longUsd: size * 1000 });
const trade = (id, whaleId = 'a') => ({ id, whaleId, amount: 0.001, amountUsd: 1, time: Date.now(), asset: 'ETH' });

test('REST baseline cannot roll back WS state or emit stale snapshot alerts; raw fills still merge', () => {
  const { cache, writes } = stateFixture();
  cache.commitWhaleState('hf', { whales: [whale('a'), whale('b')], trades: [trade('old')] });
  const baseline = cache.captureWhaleRevisions('hf');
  cache.commitWhaleState('hf', { whales: [whale('a', 4)], trades: [trade('ws')] });
  const result = cache.commitWhaleState('hf', { whales: [whale('a', 2), whale('b', 3)],
    trades: [trade('rest')], expectedWhaleRevisions: baseline, snapshotAlerts: [{ whaleId: 'a', id: 'stale' }] });
  assert.equal(result.data.whales.find((w) => w.id === 'a').positions[0].size, 4);
  assert.equal(result.data.whales.find((w) => w.id === 'b').positions[0].size, 3);
  assert.equal(result.data.trades.length, 3);
  assert.deepEqual(plain(writes.at(-1).snapshotAlerts), []);
  assert.deepEqual(plain(result.changedWhaleIds), ['b']);
});

test('metadata enrichment cannot replace size, totals, PnL or resurrect a closed position', () => {
  const { cache } = stateFixture();
  cache.commitWhaleState('hf', { whales: [whale('a', 2)] });
  const enrichment = whale('a', 2);
  enrichment.longUsd = 999;
  enrichment.positions[0].unrealizedPnl = 999;
  enrichment.positions[0].openTime = 123;
  let result = cache.commitWhaleState('hf', { whales: [enrichment], positionMetadataOnly: true });
  assert.equal(result.data.whales[0].longUsd, 2000);
  assert.equal(result.data.whales[0].positions[0].unrealizedPnl, 20);
  assert.equal(result.data.whales[0].positions[0].openTime, 123);
  cache.commitWhaleState('hf', { whales: [{ ...whale('a'), positions: [] }] });
  result = cache.commitWhaleState('hf', { whales: [enrichment], positionMetadataOnly: true });
  assert.equal(result.data.whales[0].positions.length, 0);
});

test('SQLite failure publishes nothing and read snapshots cannot mutate committed memory', () => {
  const fixture = stateFixture();
  const { cache } = fixture;
  cache.commitWhaleState('hf', { whales: [whale('a')], trades: [trade('old')] });
  const before = cache.readStateSnapshot('hf');
  const leaked = cache.readStateSnapshot('hf');
  leaked.data.whales[0].positions[0].size = 100;
  let delivered = 0;
  cache.subscribeStateCommits(() => delivered++);
  fixture.fail();
  assert.throws(() => cache.commitWhaleState('hf', { whales: [whale('a', 9)] }), /disk full/);
  assert.equal(delivered, 0);
  assert.deepEqual(plain(cache.readStateSnapshot('hf')), plain(before));
});

test('light position commits keep every existing fill and only persist changed whales', () => {
  const { cache, writes } = stateFixture();
  cache.commitWhaleState('hf', { whales: [whale('a'), whale('b')], trades: [trade('old')] });
  cache.commitWhaleState('hf', { whales: [whale('a', 2)], trades: [] });
  assert.equal(cache.readStateSnapshot('hf').data.trades.length, 1);
  assert.equal(writes.at(-1).whales.length, 1);
  assert.equal(writes.at(-1).trades.length, 0);
});

test('authoritative roster removal and reset invalidate pending REST baselines', () => {
  const { cache, setStored } = stateFixture();
  cache.commitWhaleState('hf', { whales: [whale('a'), whale('b')] });
  const baseline = cache.captureWhaleRevisions('hf');
  const result = cache.commitWhaleState('hf', { rosterIds: ['a'] });
  assert.deepEqual(plain(result.removedWhaleIds), ['b']);
  setStored({ updatedAt: 0, data: { whales: [], trades: [] } });
  cache.clearWhaleModeCache('hf');
  const late = cache.commitWhaleState('hf', { whales: [whale('a')], expectedWhaleRevisions: baseline });
  assert.equal(late.data.whales.length, 0);
});

test('continuous per-address fill watermarks retry failure without skipping an address', async () => {
  const watermarks = new Map();
  const calls = [];
  const commits = [];
  let fail = true;
  const backfill = load('fillBackfill.js', {
    './db': { getMeta: (key) => ({ value: watermarks.get(key) }), setMeta: (key, value) => watermarks.set(key, value) },
    './config': { normalizeAddress: (s) => s, getActiveWhales: () => [whale('a'), whale('b')] },
    './cache': { commitWhaleState: (_, patch) => commits.push(patch) },
    './hyperliquid': { FILL_LOOKBACK_MS: 86400000,
      fetchUserFillsByTime: async (address, start, end) => {
        calls.push({ address, start, end });
        if (address === 'a' && fail) throw new Error('network failed');
        return [{ id: address }];
      }, mapFillToTrade: (fill, profile) => trade(fill.id, profile.id) },
  });
  await backfill.runOneTick();
  assert.equal(backfill.getBackfillStatus().reconciledAddresses, 0);
  await backfill.runOneTick();
  assert.equal(backfill.getBackfillStatus().watermarks.b.through, calls[1].end);
  assert.equal(backfill.getBackfillStatus().watermarks.a?.through, undefined);
  fail = false;
  await backfill.runOneTick();
  assert.equal(backfill.getBackfillStatus().reconciledAddresses, 2);
  assert.equal(commits.length, 2);
  assert.deepEqual(calls.map((call) => call.address), ['a', 'b', 'a']);
  assert.ok(calls.every((call) => call.end - call.start <= 86400000));
});

test('watermark stays put when durable commit fails', async () => {
  const meta = new Map();
  const backfill = load('fillBackfill.js', {
    './db': { getMeta: (key) => ({ value: meta.get(key) }), setMeta: (key, value) => meta.set(key, value) },
    './config': { normalizeAddress: (s) => s, getActiveWhales: () => [whale('a')] },
    './cache': { commitWhaleState: () => { throw new Error('disk full'); } },
    './hyperliquid': { fetchUserFillsByTime: async () => [], mapFillToTrade: (x) => x },
  });
  await backfill.runOneTick();
  assert.equal(backfill.getBackfillStatus().watermarks.a?.through, undefined);
  assert.match(backfill.getBackfillStatus().lastError, /disk full/);
});

test('deferred shard reads latest commit and preserves fills written while REST waits', async () => {
  const { cache, writes } = stateFixture();
  const roster = [whale('a'), whale('b')];
  cache.commitWhaleState('hf', { whales: roster, trades: [trade('prior')] });
  let release;
  let fetching = false;
  const pending = new Promise((resolve) => { release = resolve; });
  const whales = load('whales.js', {
    './cache': cache,
    './config': { readConfig: () => ({ mode: 'hf', whales: roster }), normalizeAddress: (s) => s,
      sortWhales: (items) => items, normalizeMode: () => 'hf', getActiveWhales: () => roster },
    './onchain': { fetchWhaleAlerts: async () => ({ alerts: [] }), attachWatchedWhale: (t) => t, MIN_USD: 1000 },
    './hlInfoClient': { MAX_CONCURRENT: 2, getHlInfoConfig: () => ({}) },
    './hyperliquid': { fetchCoinNameMap: async () => ({}), fetchUserFills: async () => [],
      fetchBatchClearinghouseStates: async () => { fetching = true; return pending; },
      deriveDirection: (state) => state, coinLabel: (coin) => coin },
    './realtimeBridge': { alertsFromPositionDiff: (profile) => [{ id: profile.id + '-diff', whaleId: profile.id, kind: 'increase' }] },
    './realtimeHub': { broadcast() {} },
  });
  const request = whales.refreshWhalesShard({ force: true });
  for (let i = 0; !fetching && i < 20; i++) await Promise.resolve();
  assert.equal(fetching, true);
  cache.commitWhaleState('hf', { whales: [whale('a', 9)], trades: [trade('while-waiting')] });
  release({ a: whale('a', 2), b: whale('b', 3) });
  const result = await request;
  assert.equal(result.whales.find((profile) => profile.id === 'a').positions[0].size, 9);
  assert.equal(result.whales.find((profile) => profile.id === 'b').positions[0].size, 3);
  assert.equal(result.trades.length, 2);
  const shardWrite = writes.find((patch) => patch.snapshotAlerts.some((alert) => alert.id === 'b-diff'));
  assert.ok(shardWrite);
  assert.equal(shardWrite.snapshotAlerts.some((alert) => alert.whaleId === 'a'), false);
});

test('same exchange fill id at two monitored addresses remains distinct and replays idempotently', () => {
  const { cache, writes } = stateFixture();
  const input = [trade('123', 'a'), trade('123', 'b')].map((item) => ({ ...item, time:  Date.now() }));
  input[1].time = input[0].time;
  cache.commitWhaleState('hf', { trades: input });
  const once = cache.readStateSnapshot('hf');
  cache.commitWhaleState('hf', { trades: input });
  assert.equal(cache.readStateSnapshot('hf').data.trades.length, 2);
  assert.notEqual(once.data.trades[0].id, once.data.trades[1].id);
  assert.equal(writes.length, 1);
});

test('unchanged WS observations invalidate old REST baselines without rewriting SQLite', () => {
  const { cache, writes } = stateFixture();
  cache.commitWhaleState('hf', { whales: [whale('a', 2)] });
  const baseline = cache.captureWhaleRevisions('hf');
  cache.commitWhaleState('hf', { whales: [whale('a', 2)] });
  assert.equal(writes.length, 1);
  const late = cache.commitWhaleState('hf', { whales: [whale('a', 1)], expectedWhaleRevisions: baseline });
  assert.equal(late.data.whales[0].positions[0].size, 2);
  assert.equal(writes.length, 1);
});

test('incomplete fill windows shrink adaptively and never advance the coverage watermark', async () => {
  const meta = new Map();
  const windows = [];
  let failure = true;
  const backfill = load('fillBackfill.js', {
    './db': { getMeta: (key) => ({ value: meta.get(key) }), setMeta: (key, value) => meta.set(key, value) },
    './config': { normalizeAddress: (s) => s, getActiveWhales: () => [whale('a')] },
    './cache': { commitWhaleState() {} },
    './hyperliquid': { fetchUserFillsByTime: async (_, start, end) => {
      windows.push({ start, end });
      if (failure) throw Object.assign(new Error('saturated page'), { code: 'HL_FILLS_INCOMPLETE' });
      return [];
    }, mapFillToTrade: (x) => x },
  });
  await backfill.runOneTick();
  assert.equal(backfill.getBackfillStatus().watermarks.a.through, undefined);
  await backfill.runOneTick();
  assert.equal(windows[1].end - windows[1].start, (windows[0].end - windows[0].start) / 2);
  failure = false;
  await backfill.runOneTick();
  assert.equal(backfill.getBackfillStatus().watermarks.a.through, windows[2].end);
});

test('reset during a fill request discards the delayed response before any commit', async () => {
  const meta = new Map();
  let release;
  let committed = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const backfill = load('fillBackfill.js', {
    './db': { getMeta: (key) => ({ value: meta.get(key) }), setMeta: (key, value) => meta.set(key, value) },
    './config': { normalizeAddress: (s) => s, getActiveWhales: () => [whale('a')] },
    './cache': { commitWhaleState() { committed++; } },
    './hyperliquid': { fetchUserFillsByTime: async () => pending, mapFillToTrade: (x) => x },
  });
  const request = backfill.runOneTick();
  backfill.resetFillBackfill();
  release([trade('late')]);
  await request;
  assert.equal(committed, 0);
  assert.deepEqual(plain(backfill.getBackfillStatus().watermarks), {});
});

test('only new recent forward fills trigger one current-position refresh per address', async () => {
  const meta = new Map([['fills_address_watermarks_v2', JSON.stringify({ a: { through: Date.now() - 60000 } })]]);
  const refreshed = [];
  const now = Date.now();
  const backfill = load('fillBackfill.js', {
    './db': { getMeta: (key) => ({ value: meta.get(key) }), setMeta: (key, value) => meta.set(key, value) },
    './config': { normalizeAddress: (s) => s, getActiveWhales: () => [whale('a')] },
    './cache': { commitWhaleState() {} },
    './whales': { refreshWhalePositionFromSource: async (id) => refreshed.push(id) },
    './hyperliquid': { fetchUserFillsByTime: async () => [1, 2, 3].map((id) => ({ ...trade(String(id)), time: now - 1000 })),
      mapFillToTrade: (x) => x },
  });
  await backfill.runOneTick();
  await backfill.runOneTick();
  assert.deepEqual(refreshed, ['a']);
});

test('a delayed forward fill refreshes current position without creating a live toast', async () => {
  const now = Date.now();
  const meta = new Map([['fills_address_watermarks_v2', JSON.stringify({ a: { through: now - 20 * 60000 } })]]);
  const refreshed = [];
  let notifications = 0;
  const backfill = load('fillBackfill.js', {
    './db': { getMeta: (key) => ({ value: meta.get(key) }), setMeta: (key, value) => meta.set(key, value) },
    './config': { normalizeAddress: (s) => s, getActiveWhales: () => [whale('a')] },
    './cache': { commitWhaleState: () => ({ committedAlerts: [{ id: 'delayed-fill', at: now - 10 * 60000 }] }) },
    './whales': { refreshWhalePositionFromSource: async (id) => refreshed.push(id) },
    './whaleSync': { markLiveAlerts: () => notifications++ },
    './hyperliquid': { fetchUserFillsByTime: async () => [{ ...trade('delayed-fill'), time: now - 10 * 60000 }],
      mapFillToTrade: (x) => x },
  });
  await backfill.runOneTick();
  assert.deepEqual(refreshed, ['a']);
  assert.equal(notifications, 0);
});

test('initial fill seeding and historic windows never request current positions or live notifications', async () => {
  const now = Date.now();
  const meta = new Map();
  let refreshed = 0;
  let notifications = 0;
  let requests = 0;
  const backfill = load('fillBackfill.js', {
    './db': { getMeta: (key) => ({ value: meta.get(key) }), setMeta: (key, value) => meta.set(key, value) },
    './config': { normalizeAddress: (s) => s, getActiveWhales: () => [whale('a')] },
    './cache': { commitWhaleState: () => ({ committedAlerts: [{ id: 'seed-fill', at: now - 1000 }] }) },
    './whales': { refreshWhalePositionFromSource: async () => refreshed++ },
    './whaleSync': { markLiveAlerts: () => notifications++ },
    './hyperliquid': { fetchUserFillsByTime: async (_, start, end) => {
      requests++;
      if (requests === 2) return []; // No new fill in the next forward poll.
      return [{ ...trade('seed-fill'), time: Math.min(end, now - 1000) }];
    }, mapFillToTrade: (x) => x },
  });
  await backfill.runOneTick();
  await backfill.runOneTick();
  await backfill.runHistoryTick();
  assert.equal(requests, 3);
  assert.equal(refreshed, 0);
  assert.equal(notifications, 0);
});
