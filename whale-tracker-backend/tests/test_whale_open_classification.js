const assert = require('node:assert/strict');
const test = require('node:test');

require('./helpers/isolateSqlite');
const { mapFillToTrade, normalizeToHlFill, aggregateTradesByWindow } = require('../lib/hyperliquid');
const { eventsFromTrade, persistAlerts, loadPagedAlerts, loadAlertFlowSummary } = require('../lib/sqliteStore');
const { alertsFromPositionDiff, alertFromLiveFill, rememberPositionFill, pickLiveAddresses } = require('../lib/realtimeBridge');

const whale = { id: 'w1', name: 'whale', address: '0xabc' };

test('null startPosition stays unknown and cannot be treated as a fresh open', () => {
  const mapped = mapFillToTrade(
    { tid: 'fill-null', time: 1000, coin: 'BTC', side: 'B', sz: '1', px: '50000', startPosition: null, dir: 'Open Long' },
    whale,
  );

  assert.equal(mapped.startPosition, null);
  assert.equal(normalizeToHlFill(mapped).startPosition, undefined);
  assert.deepEqual(eventsFromTrade(mapped), []);
});

test('confirmed zero-position open and nonzero-position add remain distinct', () => {
  const trades = [
    { id: 'open', whaleId: 'w1', whaleName: 'whale', asset: 'BTC', side: 'buy', amount: 1, amountUsd: 50000, price: 50000, time: 1000, startPosition: 0, dir: 'Open Long', closedPnl: 0 },
    { id: 'add', whaleId: 'w1', whaleName: 'whale', asset: 'BTC', side: 'buy', amount: 1, amountUsd: 50000, price: 50000, time: 2000, startPosition: 1, dir: 'Open Long', closedPnl: 0 },
  ];

  const aggregated = aggregateTradesByWindow(trades);
  assert.equal(aggregated.length, 2);
  assert.deepEqual(aggregated.map((trade) => trade.startPosition), [0, 1]);
  assert.equal(eventsFromTrade(trades[0])[0].kind, 'open');
  assert.equal(eventsFromTrade(trades[1])[0].kind, 'increase');
});

test('realtime fill does not infer an open from Open Long when startPosition is unknown', () => {
  const missing = { tid: 'unknown', time: 1000, coin: 'BTC', side: 'B', sz: '1', px: '50000', startPosition: null, dir: 'Open Long' };
  const missingTrade = mapFillToTrade(missing, whale);
  assert.equal(alertFromLiveFill(whale, missing, missingTrade), null);

  const confirmed = { ...missing, tid: 'confirmed', startPosition: '0' };
  const confirmedTrade = mapFillToTrade(confirmed, whale);
  assert.equal(alertFromLiveFill(whale, confirmed, confirmedTrade).kind, 'open');
});

test('position value changes without size changes are not reported as adds', () => {
  const prev = [{ coin: 'BTC', side: 'long', size: 10, positionValue: 10000, entryPx: 1000 }];
  const markedUp = [{ coin: 'BTC', side: 'long', size: 10, positionValue: 12000, entryPx: 1200 }];
  assert.deepEqual(alertsFromPositionDiff(whale, prev, markedUp), []);

  const actuallyAdded = [{ coin: 'BTC', side: 'long', size: 12, positionValue: 12000, entryPx: 1000 }];
  const alerts = alertsFromPositionDiff(whale, prev, actuallyAdded);
  assert.equal(alerts[0]?.kind, 'increase');
  assert.equal(alerts[0]?.items[0]?.usd, 2000);
});

test('snapshot open uses matched fill execution time and marks unmatched time as observed', () => {
  const eventTime = Date.now() - 3_000;
  rememberPositionFill(whale, { id: 'time-fill', asset: 'BTC', side: 'buy', amount: 2, time: eventTime, startPosition: 0, closedPnl: 0 });
  const matched = alertsFromPositionDiff(whale, [], [{ coin: 'BTC', side: 'long', size: 2, positionValue: 100000, entryPx: 50000 }])[0];
  assert.equal(matched.at, eventTime);
  assert.equal(matched.items[0].timeSource, 'execution');

  const unmatched = alertsFromPositionDiff(whale, [], [{ coin: 'ETH', side: 'short', size: 1, positionValue: 3000, entryPx: 3000 }])[0];
  assert.equal(unmatched.items[0].timeSource, 'observed');
});

test('live subscription address selection is unique and capped at ten', () => {
  const whales = Array.from({ length: 12 }, (_, index) => ({
    id: `w${index}`, address: `0x${String(index).padStart(40, '0')}`, priority: 12 - index,
    positions: [{ positionValue: 10000, size: 1, entryPx: 10000 }],
  }));
  whales.push({ ...whales[0], id: 'duplicate-address' });
  const selected = pickLiveAddresses(whales);
  assert.equal(selected.length, 10);
  assert.equal(new Set(selected.map((address) => address.toLowerCase())).size, 10);

  const activeWhale = whales[11];
  const now = Date.now() + 6 * 60_000;
  const activeTrades = Array.from({ length: 6 }, (_, index) => ({
    id: `active-${index}`, whaleId: activeWhale.id, time: now - (index + 1) * 10_000,
    amountUsd: 25_000, startPosition: index === 0 ? 0 : index, side: 'buy', closedPnl: 0,
  }));
  const refreshed = pickLiveAddresses(whales, activeTrades, now);
  assert.ok(refreshed.some((address) => address.toLowerCase() === activeWhale.address.toLowerCase()));
});

test('fill and snapshot evidence for one open do not double the notional', () => {
  const now = Date.now();
  const makeAlert = (id, source, at) => ({
    id, at, whaleId: whale.id, whaleName: whale.name, address: whale.address,
    kind: 'open', kindLabel: '开单', headline: '开多 BTC', layer: 'position',
    items: [{ kind: 'open', title: '开多 BTC', coin: 'BTC', side: 'long', usd: 50000, time: at, evidenceSource: source }],
  });
  persistAlerts([makeAlert('snapshot-open', 'snapshot', now)]);
  persistAlerts([makeAlert('fill-open', 'fill', now + 1)]);

  const result = loadPagedAlerts({ sinceMs: now - 1000, limit: 10 });
  assert.equal(result.total, 1);
  assert.equal(result.alerts[0].items[0].usd, 50000);
  assert.equal(result.alerts[0].items[0].evidenceSource, 'fill');
});

test('indexed alert filters preserve multi-coin and long/short facet counts', () => {
  // Future cutoff isolates this case from earlier tests sharing the same DB.
  const now = Date.now() + 60_000;
  const multi = {
    id: `multi-${now}`, at: now, whaleId: 'multi-whale', whaleName: 'multi',
    kind: 'open', items: [
      { kind: 'open', coin: 'btc', side: 'long', usd: 500, time: now },
      { kind: 'increase', coin: 'eth', side: 'short', usd: 2500, time: now - 1 },
      { kind: 'open', coin: 'BTC', side: 'short', usd: 3000, time: now - 2 },
    ],
  };
  const second = {
    id: `single-${now}`, at: now - 5_000, whaleId: 'other-whale', whaleName: 'other',
    kind: 'open', items: [{ kind: 'open', coin: 'BTC', side: 'long', usd: 1200, time: now - 5_000 }],
  };
  persistAlerts([multi, second]);

  const all = loadPagedAlerts({ sinceMs: now - 10_000, minUsd: 1000, limit: 10 });
  assert.equal(all.total, 2, 'an alert counts once even when multiple items match');
  assert.equal(all.facets.all, 2);
  assert.equal(all.facets.byCoin.BTC, 2);
  assert.equal(all.facets.byCoin.ETH, 1);
  assert.equal(all.facets.long, 1);
  assert.equal(all.facets.short, 1);

  const ethShort = loadPagedAlerts({ sinceMs: now - 10_000, coin: 'eth', side: 'short', minUsd: 1000, limit: 10 });
  assert.equal(ethShort.total, 1);
  assert.equal(ethShort.facets.all, 1);
  assert.deepEqual(ethShort.alerts[0].items.map((item) => item.coin), ['btc', 'eth', 'BTC']);
  assert.deepEqual(ethShort.facets.byCoin, { ETH: 1 });
  assert.equal(ethShort.facets.long, 0);
  assert.equal(ethShort.facets.short, 1);
});

test('default rolling retention query reuses the short pagination cache', () => {
  const query = { whaleId: 'pagination-cache-fixture', limit: 10 };
  const first = loadPagedAlerts(query);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  const second = loadPagedAlerts(query);
  assert.strictEqual(second, first, 'same default query should reuse cached page inside TTL');
});

test('retrying a source alert after merge does not double-count its notional', () => {
  const at = Date.now() + 120_000;
  const make = (id, time) => ({
    id, at: time, whaleId: 'retry-whale', whaleName: 'retry', kind: 'increase',
    items: [{ kind: 'increase', coin: 'SOL', side: 'long', usd: 1500, time }],
  });
  const first = make(`retry-a-${at}`, at);
  const second = make(`retry-b-${at}`, at + 1);
  persistAlerts([first]);
  persistAlerts([second]);
  persistAlerts([second]); // simulate a request retry after an ambiguous timeout

  const result = loadPagedAlerts({ sinceMs: at - 1, limit: 10 });
  assert.equal(result.total, 1);
  assert.equal(result.alerts[0].totalUsd, 3000);
  assert.deepEqual(result.alerts[0].items.map(item => item.usd), [1500, 1500]);
  assert.equal(result.alerts[0].mergedCount, 2);
});

test('server alert flow summary scopes by event time and coin, and nets shorts', () => {
  const at = Date.now() + 180_000;
  require('../lib/sqliteStore').persistTradesIncremental([
    { id: 'flow-long', whaleId: 'flow-a', time: at, asset: 'BTC', side: 'buy', startPosition: 0, amount: 1, amountUsd: 1000 },
    { id: 'flow-eth', whaleId: 'flow-a', time: at, asset: 'ETH', side: 'buy', startPosition: 1, amount: 1, amountUsd: 400 },
    { id: 'flow-short', whaleId: 'flow-b', time: at, asset: 'KBTC', side: 'sell', startPosition: -1, amount: 1, amountUsd: 1500 },
  ]);
  const btc = loadAlertFlowSummary({ sinceMs: at - 1, untilMs: at + 1, coin: 'BTC' });
  assert.equal(btc.longUsd, 1000);
  assert.equal(btc.shortUsd, 1500);
  assert.equal(btc.netUsd, -500);
  assert.equal(btc.events, 2);
  assert.equal(btc.whales, 2);
});

test('server alert pagination applies side, coin and exotic filters before slicing', () => {
  const at = Date.now() + 240_000;
  persistAlerts([
    { id: `page-a-${at}`, at, whaleId: 'page-a', kind: 'open', items: [
      { kind: 'open', coin: '@123', side: 'long', usd: 2000, time: at },
      { kind: 'open', coin: 'BTC', side: 'long', usd: 3000, time: at },
    ] },
    { id: `page-b-${at}`, at: at - 1000, whaleId: 'page-b', kind: 'open', items: [
      { kind: 'open', coin: 'ETH', side: 'short', usd: 2500, time: at - 1000 },
    ] },
  ]);
  const page = loadPagedAlerts({ sinceMs: at - 5000, page: 1, limit: 1, side: 'long', excludeExotic: true });
  assert.equal(page.total, 1);
  assert.equal(page.alerts.length, 1);
  assert.equal(page.facets.all, 2, 'the all facet remains side-independent');
  assert.deepEqual(page.facets.byCoin, { BTC: 1, ETH: 1 });
});
