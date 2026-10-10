'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/isolateSqlite');
const { getDb } = require('../lib/db');
const store = require('../lib/sqliteStore');
const { alertDocFromEvent } = require('../lib/positionEventPolicy');
const now = Date.now();

function reset() {
  store.invalidateFillProjection(); getDb().exec('DELETE FROM alert_sources; DELETE FROM alert_items; DELETE FROM alerts; DELETE FROM fills; DELETE FROM events; DELETE FROM positions; DELETE FROM whales;');
  store.setAlertCommitObserver(null);
}
function trade(id, usd = 60000, time = now - 5000) {
  return { id, whaleId: 'test-whale', time, asset: 'BTC', assetLabel: 'BTC', side: 'buy',
    amountUsd: usd, amount: usd / 60000, price: 60000, startPosition: 0, source: 'hyperliquid' };
}
function flow(from = now - 60000, to = now) {
  return store.loadAlertFlowSummary({ sinceMs: from, untilMs: to });
}
function snapshot(id, usd = 60000) {
  return { id, whaleId: 'test-whale', at: now - 4000, kind: 'open',
    items: [{ kind: 'open', coin: 'BTC', side: 'long', usd, time: now - 4000, evidenceSource: 'snapshot' }] };
}

test('one 60k fill has one canonical source across both ingestion entries and replay', () => {
  reset();
  const fill = trade('single');
  const first = store.persistTradesIncremental([fill]);
  assert.equal(first.committedAlerts.length, 1);
  const copy = { ...alertDocFromEvent(store.eventsFromTrade(fill)[0]), id: 'other-ingestion-wrapper' };
  assert.equal(store.persistAlerts([copy]).committedAlerts.length, 0);
  assert.equal(store.persistTradesIncremental([fill]).committedAlerts.length, 0);
  assert.equal(flow().longUsd, 60000);
  assert.equal(store.countStoredAlerts(), 1);
});

test('merged 1000 + 2000 retains atomic amounts, times and replay identity', () => {
  reset();
  const a = trade('a', 1000, now - 9000);
  const b = trade('b', 2000, now - 2000);
  store.persistTradesIncremental([a]);
  const result = store.persistTradesIncremental([b]);
  const merged = result.committedAlerts[0];
  assert.equal(merged.totalUsd, 3000);
  assert.deepEqual(merged.items.map(item => item.usd), [2000, 1000]);
  assert.equal(flow().longUsd, 3000);
  assert.equal(flow(now - 4000).longUsd, 2000);
  assert.equal(flow(now - 10000, now - 5000).longUsd, 1000);
  store.persistTradesIncremental([a, b]);
  store.persistAlerts([merged]);
  assert.equal(flow().longUsd, 3000);
});

test('same exchange trade id remains independent for two whales and replayed legacy ids', () => {
  reset();
  const { mapFillToTrade } = require('../lib/hyperliquid');
  const fill = { tid: 42, time: now - 5000, coin: 'BTC', px: 60000, sz: 1, side: 'B', startPosition: 0 };
  const a = mapFillToTrade(fill, { id: 'alice', address: '0xa' });
  const b = mapFillToTrade(fill, { id: 'bob', address: '0xb' });
  assert.equal(a.id, 'alice:42');
  assert.equal(a.tid, 42);
  store.persistTradesIncremental([a, b]);
  store.persistTradesIncremental([{ ...a, id: '42', tid: undefined }, { ...b, id: '42', tid: undefined }]);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM fills').get().n, 2);
  assert.equal(store.countStoredAlerts(), 2);
  assert.equal(flow().longUsd, 120000);
  const legacy = trade('legacy', 1000);
  getDb().prepare('INSERT INTO fills (id, whale_id, time, payload_json) VALUES (?, ?, ?, ?)')
    .run(legacy.id, legacy.whaleId, legacy.time, JSON.stringify(legacy));
  store.persistAlerts([{ ...snapshot('evt-open-legacy', 1000), at: legacy.time,
    items: [{ kind: 'open', coin: 'BTC', side: 'long', usd: 1000, time: legacy.time, evidenceSource: 'fill' }] }]);
  store.persistTradesIncremental([legacy]);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM fills').get().n, 3);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM fills WHERE id = 'legacy'").get().n, 0);
  assert.equal(flow().longUsd, 121000);
});

test('fill is authoritative when snapshot arrives before or after it', () => {
  for (const snapshotFirst of [true, false]) {
    reset();
    const copy = snapshot('snapshot', 90000);
    if (snapshotFirst) store.persistAlerts([copy]);
    const result = store.persistTradesIncremental([trade('fill')]);
    if (snapshotFirst) assert.deepEqual(result.removedAlertIds, []); // unconfirmed snapshots are never stored
    else store.persistAlerts([copy]);
    store.persistAlerts([copy]);
    assert.equal(flow().longUsd, 60000);
    assert.equal(store.countStoredAlerts(), 1);
  }
});

test('raw fills reject presentation aggregates at every persistence and normalization entry', () => {
  reset();
  const bad = [{ ...trade('aggregate'), fillCount: 2 }, trade('one+two')];
  assert.equal(store.persistTradesIncremental(bad).fills, 0);
  assert.equal(store.persistModePayload({ trades: bad }).trades, 0);
  assert.equal(store.persistStatePatch({ trades: bad }).trades, 0);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM fills').get().n, 0);
  const { normalizeToHlFill } = require('../lib/hyperliquid');
  assert.deepEqual(bad.map(normalizeToHlFill), [null, null]);
});

test('state patch commits state and alerts atomically before notifying observers', () => {
  reset();
  const notifications = [];
  store.setAlertCommitObserver(event => {
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM whales').get().n, 1);
    notifications.push(event);
  });
  store.persistStatePatch({ whales: [{ id: 'test-whale', positions: [] }], trades: [trade('atomic')],
    snapshotAlerts: [snapshot('copy')], revision: 7, epoch: 'test-epoch' });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].alerts[0].totalUsd, 60000);
  assert.equal(getDb().prepare("SELECT value FROM sync_meta WHERE key = 'state_revision'").get().value, '7');
  assert.throws(() => store.persistStatePatch({ whales: [{ id: 'test-whale', positions: [
    { coin: 'BTC', side: 'long' }, { coin: 'BTC', side: 'long' },
  ] }], trades: [trade('rolled-back')] }));
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM fills WHERE id = 'test-whale:rolled-back'").get().n, 0);
  assert.equal(notifications.length, 1);
  store.persistStatePatch({ removedWhaleIds: ['test-whale'] });
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM whales').get().n, 0);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM fills').get().n, 1);
});

test('expired clearinghouse data is never returned as a fresh successful snapshot', async () => {
  const clientPath = require.resolve('../lib/hlInfoClient');
  const modulePath = require.resolve('../lib/hyperliquid');
  const originalClient = require.cache[clientPath];
  const originalModule = require.cache[modulePath];
  const originalNow = Date.now;
  let clock = now;
  let failed = false;
  let invalid = false;
  require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: {
    hlPost: async (body) => { if (body.type === 'perpDexs') return [null]; if (failed) throw new Error('upstream unavailable'); return invalid ? {} : { assetPositions: [] }; },
  } };
  const marketsPath = require.resolve('../lib/hlMarkets');
  const originalMarkets = require.cache[marketsPath];
  delete require.cache[marketsPath];
  delete require.cache[modulePath];
  Date.now = () => clock;
  try {
    const { fetchClearinghouseState } = require('../lib/hyperliquid');
    assert.deepEqual(await fetchClearinghouseState('0xtest'), { assetPositions: [], positionScope: 'all-perp', observedAt: clock });
    clock += 21000;
    failed = true;
    await assert.rejects(fetchClearinghouseState('0xtest'), /upstream unavailable/);
    failed = false;
    invalid = true;
    await assert.rejects(fetchClearinghouseState('0xtest'), /Invalid clearinghouse state/);
  } finally {
    Date.now = originalNow;
    if (originalMarkets) require.cache[marketsPath] = originalMarkets;
    else delete require.cache[marketsPath];
    if (originalClient) require.cache[clientPath] = originalClient;
    else delete require.cache[clientPath];
    if (originalModule) require.cache[modulePath] = originalModule;
    else delete require.cache[modulePath];
  }
});

test('fill pagination overlaps timestamp boundaries and refuses incomplete watermark coverage', async () => {
  const clientPath = require.resolve('../lib/hlInfoClient');
  const modulePath = require.resolve('../lib/hyperliquid');
  const originalClient = require.cache[clientPath];
  const originalModule = require.cache[modulePath];
  const requests = [];
  let responder;
  require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: {
    hlPost: async request => { requests.push(request); return responder(request); },
  } };
  delete require.cache[modulePath];
  try {
    const { fetchUserFillsByTime } = require('../lib/hyperliquid');
    const firstPage = Array.from({ length: 2000 }, (_, i) => ({ tid: i, time: i + 1, coin: 'BTC', sz: 1, px: 1 }));
    responder = request => request.startTime === 0 ? firstPage : [firstPage[1999],
      { ...firstPage[1999], tid: 2000 }, { ...firstPage[1999], tid: 2001, time: 2001 }];
    assert.equal((await fetchUserFillsByTime('0xboundary', 0, 5000)).length, 2002);
    assert.equal(requests[1].startTime, 2000);
    responder = () => Array.from({ length: 2000 }, (_, i) => ({ tid: i, time: 100 }));
    await assert.rejects(fetchUserFillsByTime('0xsaturated', 0, 5000), { code: 'HL_FILLS_INCOMPLETE' });
    responder = request => Array.from({ length: 2000 }, (_, i) => ({ tid: request.startTime + i, time: request.startTime + i + 1 }));
    await assert.rejects(fetchUserFillsByTime('0xlimit', 0, 20000), { code: 'HL_FILLS_INCOMPLETE' });
    responder = () => [];
    const before = requests.length;
    await fetchUserFillsByTime('0xexact', 0, 5000);
    await fetchUserFillsByTime('0xexact', 0, 5001);
    assert.equal(requests.length - before, 2);
  } finally {
    require.cache[clientPath] = originalClient;
    require.cache[modulePath] = originalModule;
  }
});
