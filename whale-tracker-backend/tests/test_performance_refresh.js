const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/isolateSqlite');
const { BoundedCache } = require('../lib/boundedCache');

test('intel concurrent readers share work and failed refreshes retain an explicitly stale result', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const filename = require.resolve('../lib/tradfiIntel');
  const context = { module: { exports: {} }, require: require('node:module').createRequire(filename), Date, process };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.readCached = cached;', context);
  const read = context.module.exports.readCached;
  let calls = 0;
  const loader = async () => { calls++; await new Promise(resolve => setImmediate(resolve)); return { headline: 'same' }; };
  const [a,b] = await Promise.all([read('test', 0, loader), read('test', 0, loader)]);
  assert.equal(calls, 1); assert.equal(a.headline, b.headline);
  const fallback = await read('test', 0, async () => { throw Error('offline'); });
  assert.equal(fallback.headline, 'same'); assert.equal(fallback.stale, true);
});

test('bounded caches evict least-used entries and expire stale fallback data', () => {
  let now = 100;
  const cache = new BoundedCache(2, 50, () => now);
  try {
    cache.set('a', { expiresAt: 110 }); cache.set('b', { expiresAt: 110 });
    cache.get('a'); cache.set('c', { expiresAt: 110 });
    assert.equal(cache.has('b'), false);
    now = 120; assert.ok(cache.get('a')); // still available as stale fallback
    now = 161; cache.prune(); assert.equal(cache.size, 0);
  } finally { clearInterval(cache.timer); }
});

test('commit deltas avoid full clones and lazy snapshots retain isolation across later commits', () => {
  const cache = require('../lib/cache');
  cache.commitWhaleState('hf', { whales: [{ id: 'lazy-test', positions: [], positionObservedAt: 123 }] });
  const original = global.structuredClone;
  let fullCopies = 0;
  global.structuredClone = value => {
    if (Array.isArray(value?.whales) && Array.isArray(value?.trades)) fullCopies++;
    return original(value);
  };
  let delta;
  const off = cache.subscribeStateCommits(value => { delta = value; });
  try {
    const result = cache.commitWhaleState('hf', { whales: [{ id: 'lazy-test', positionObservedAt: 456 }] });
    assert.equal(fullCopies, 0);
    assert.equal(delta.changedWhales[0].positionObservedAt, 456);
    assert.equal(cache.readPositionObservationTimes().get('lazy-test'), 456);
    cache.commitWhaleState('hf', { whales: [{ id: 'lazy-test', positionObservedAt: 789 }] });
    assert.equal(result.data.whales.find(row => row.id === 'lazy-test').positionObservedAt, 456);
    result.data.whales[0].positionObservedAt = -1;
    assert.equal(cache.readPositionObservationTimes().get('lazy-test'), 789);
  } finally { global.structuredClone = original; off(); }
});

test('default statistics cadence tolerates updates between minute batches and ages without new fills', async () => {
  const { getDb } = require('../lib/db');
  const { createStatisticsWorker } = require('../lib/statisticsWorker');
  let now = Date.now(), calls = 0;
  const db = getDb();
  const worker = createStatisticsWorker({ getDb, getRoster: () => ['minute-test'], now: () => now,
    runner: { stop() {}, async run(request) {
      calls++;
      return { meta: { asOf: request.now, rosterKey: request.rosterKey,
        version: db.prepare('SELECT version FROM statistics_input_version').get().version },
        rows: [2, 4, 6, 12, 24].map(w => ({ key: 'resonance:' + w, payload_json: '{"signals":[]}' })) };
    } } });
  try {
    await worker.tick(); assert.equal(calls, 1);
    db.prepare('UPDATE statistics_input_version SET version=version+1').run();
    now += 59000; await worker.tick(); assert.equal(calls, 1);
    assert.equal(worker.getStatus().pendingUpdates, true);
    assert.equal(worker.getStatus().stale, false);
    now += 1000; await worker.tick(); assert.equal(calls, 2);
    now += 60000; await worker.tick(); assert.equal(calls, 3);
    now += 90001; assert.equal(worker.getStatus().stale, true);
  } finally { worker.stop(); }
});
