const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/isolateSqlite');
const { getDb } = require('../lib/db');
const { eventsFromTrade, loadDirectionSummary, loadAlertFlowSummary, loadResonanceInputs } = require('../lib/sqliteStore');
const { aggregateDirectionFacts } = require('../lib/directionSummary');
const now = Date.now();
const trade = (id, start, side, amount, whaleId = 'a') => ({ id, whaleId, asset: 'BTC', startPosition: start, side, amount, amountUsd: amount * 100, time: now - 1000, price: 100 });
test('reversal splits exit and entry; exits never become new longs; duplicate legs counted once', () => {
  const facts = eventsFromTrade(trade('reverse', 2, 'sell', 3));
  const { coins, accounts } = aggregateDirectionFacts([...facts, ...facts]);
  assert.equal(coins[0].reduceLong, 200); assert.equal(coins[0].addShort, 100);
  assert.equal(coins[0].net, -300); assert.equal(coins[0].longAccounts, 0);
  assert.equal(coins[0].shortAccounts, 1); assert.equal(accounts.length, 1);
});
test('canonical projection includes all four behaviors without changing existing flow or resonance semantics', () => {
  const rows = [trade('open', 0, 'buy', 4), trade('reduce-long', 4, 'sell', 1), trade('open-short', 0, 'sell', 3, 'b'), trade('reduce-short', -3, 'buy', 1, 'b')];
  const insert = getDb().prepare('INSERT INTO fills(id,whale_id,time,payload_json) VALUES(?,?,?,?)');
  for (const t of rows) insert.run(t.id, t.whaleId, t.time, JSON.stringify(t));
  const summary = loadDirectionSummary(now - 3600000, now);
  assert.equal(summary.coins[0].net, 100);
  assert.equal(summary.coins[0].reduceLong, 100); assert.equal(summary.coins[0].reduceShort, 100);
  assert.equal(summary.coins[0].longAccounts, 1); assert.equal(summary.coins[0].shortAccounts, 1);
  assert.equal(summary.coins[0].concentration, 400 / 700);
  assert.equal(loadResonanceInputs(now - 3600000, now).alerts.length, 2);
  assert.equal(loadAlertFlowSummary({ sinceMs: now - 3600000, untilMs: now }).events, 2);
  assert.equal(loadDirectionSummary(now, now + 1).coins.length, 0);
});
