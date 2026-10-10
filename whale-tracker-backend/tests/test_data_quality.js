const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/isolateSqlite');
const s = require('../lib/sqliteStore');
const { getDb } = require('../lib/db');
const { summarizeFreshness } = require('../lib/dataFreshness');
const now = Date.now();
function reset() { s.invalidateFillProjection(); getDb().exec('DELETE FROM alert_sources; DELETE FROM alert_items; DELETE FROM alerts; DELETE FROM fills; DELETE FROM events;'); }
function trade(id, extra = {}) { return { id, whaleId: 'audit', asset: 'BTC', time: now - 1000,
  side: 'buy', startPosition: 0, amount: 1, amountUsd: 60000, price: 60000, ...extra }; }
const flow = () => s.loadAlertFlowSummary({ sinceMs: now - 3600000, untilMs: now });
test('both reversal directions conserve value and retain the new-position leg on replay', () => {
  for (const direction of ['sell', 'buy']) {
    reset();
    const t = trade('flip', { side: direction, startPosition: direction === 'sell' ? 1 : -1, amount: 2, amountUsd: 120000 });
    const legs = s.eventsFromTrade(t);
    assert.deepEqual(legs.map(l => [l.kind, l.usd]), [['close', 60000], ['open', 60000]]);
    assert.notEqual(legs[0].sourceId, legs[1].sourceId);
    s.persistTradesIncremental([t, t]);
    assert.equal(flow().netUsd, direction === 'sell' ? -60000 : 60000);
    assert.equal(s.countStoredAlerts(), 1);
  }
});
test('split fills count in flow before display threshold, aggregate once, and survive replay', () => {
  reset(); const fills = Array.from({ length: 10 }, (_, i) => trade('small-' + i, { startPosition: 1 + i / 100, amount: .01, amountUsd: 600, time: now - 1000 + i }));
  s.persistTradesIncremental([fills[0]]);
  assert.equal(s.loadPagedAlerts().total, 0);
  assert.equal(flow().longUsd, 600);
  for (const t of fills.slice(1)) s.persistTradesIncremental([t]);
  s.persistTradesIncremental(fills);
  assert.equal(flow().longUsd, 6000);
  assert.equal(s.loadPagedAlerts().alerts[0].totalUsd, 6000);
});
test('snapshot observation and arbitrarily delayed execution never double monetary facts', () => {
  reset(); s.persistAlerts([{ id: 'snapshot', whaleId: 'audit', at: now, kind: 'open',
    items: [{ kind: 'open', coin: 'BTC', side: 'long', usd: 60000, time: now, evidenceSource: 'snapshot' }] }]);
  assert.equal(s.countStoredAlerts(), 0);
  s.persistTradesIncremental([trade('late', { time: now - 600000 })]);
  assert.equal(s.countStoredAlerts(), 1); assert.equal(flow().longUsd, 60000);
});
test('spot fills stay excluded while HIP-3 perp flows preserve market identity', () => {
  reset();
  s.persistTradesIncremental([trade('spot', { asset: '@107' }), trade('spot-pair', {asset:'BTC/USDC'})]);
  assert.equal(flow().netUsd,0);assert.equal(s.countStoredAlerts(),0);
  s.persistTradesIncremental([trade('hip3', {asset:'xyz:SNDK'}),trade('other-dex',{asset:'para:SNDK',side:'sell',amountUsd:20000})]);
  assert.equal(flow().scope,'all-perp');assert.equal(flow().netUsd,40000);assert.equal(s.countStoredAlerts(),2);
  const scoped=coin=>s.loadAlertFlowSummary({sinceMs:now-3600000,untilMs:now,coin});
  assert.equal(scoped('xyz:SNDK').longUsd,60000);assert.equal(scoped('xyz:SNDK').shortUsd,0);
  assert.equal(scoped('para:SNDK').shortUsd,20000);assert.equal(scoped('BTC').netUsd,0);
  assert.equal(scoped('SNDK').netUsd,0);
});

test('merged shorts never acquire a long-direction label', () => {
  reset(); s.persistTradesIncremental([trade('s1', { side: 'sell' }), trade('s2', { side: 'sell', startPosition: -1 })]);
  const a = s.loadPagedAlerts().alerts[0];
  assert.equal(a.items[0].side, 'short'); assert.ok(!a.kindLabel.includes('多单'));
});
test('freshness depends on position observation, not any dataset write', () => {
  const result = summarizeFreshness([{ positionObservedAt: now }, { positionObservedAt: now - 3600000 }, {}], now);
  assert.equal(result.stale, true);
  assert.equal(result.freshness.freshCount, 1); assert.equal(result.freshness.unknownCount, 1);
});

test('retention does not discard the 201st recent execution used by rolling statistics', () => {
  reset();
  s.persistTradesIncremental(Array.from({ length: 220 }, (_, i) => trade('retain-' + i, { amountUsd: 1, amount: 1 / 60000, startPosition: 1, time: now - 2000 + i })));
  require('../lib/whaleRetention').runRetentionBatch(now);
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM fills').get().n, 220);
  assert.equal(flow().longUsd, 220);
});
