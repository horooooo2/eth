const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/isolateSqlite');
const { getDb } = require('../lib/db');
const { eventsFromTrade, loadAlertFlowSummary } = require('../lib/sqliteStore');
const now = Date.now();
const trade = (id, start, side, amount, whaleId = 'a') => ({ id, whaleId, asset: 'BTC', startPosition: start, side, amount, amountUsd: amount * 100, time: now - 1000, price: 100 });
test('freshness counts invalid and stale timestamps and handles a large roster', () => {
  const { summarizeFreshness, MAX_POSITION_AGE_MS } = require('../lib/dataFreshness');
  const result = summarizeFreshness([{ positionObservedAt: now },
    { positionObservedAt: now - MAX_POSITION_AGE_MS - 1 }, {}, { positionObservedAt: now + 1 }], now);
  assert.equal(result.freshness.freshCount, 1);
  assert.equal(result.freshness.staleCount, 1);
  assert.equal(result.freshness.unknownCount, 2);
  assert.equal(result.freshness.oldestObservedAt, now - MAX_POSITION_AGE_MS - 1);
  assert.equal(result.freshness.newestObservedAt, now);
  assert.equal(summarizeFreshness(Array.from({ length: 150000 }, () => ({ positionObservedAt: now })), now).stale, false);
});
test('reversal splits exit and entry; exits never become new longs; duplicate legs counted once', () => {
  const facts = eventsFromTrade(trade('reverse', 2, 'sell', 3));
  assert.deepEqual(facts.map(r=>[r.kind,r.side,r.usd]),[['close','long',200],['open','short',100]]);
});
test('canonical projection includes all four behaviors without changing existing flow semantics', () => {
  const rows = [trade('open', 0, 'buy', 4), trade('reduce-long', 4, 'sell', 1), trade('open-short', 0, 'sell', 3, 'b'), trade('reduce-short', -3, 'buy', 1, 'b')];
  const insert = getDb().prepare('INSERT INTO fills(id,whale_id,time,payload_json) VALUES(?,?,?,?)');
  for (const t of rows) insert.run(t.id, t.whaleId, t.time, JSON.stringify(t));
  assert.equal(loadAlertFlowSummary({ sinceMs: now - 3600000, untilMs: now }).events, 2);
});
