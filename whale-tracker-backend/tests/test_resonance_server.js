const assert = require('node:assert/strict');
const test = require('node:test');
require('./helpers/isolateSqlite');
const { getDb } = require('../lib/db');
const { loadResonanceInputs, countStoredAlerts } = require('../lib/sqliteStore');
const { scanResonanceSignals, DEFAULT_RESONANCE_CONFIG } = require('../lib/resonanceEngine');
const now = Date.now();
const whales = ['a', 'b', 'c'].map(id => ({ id, name: id, address: '0x' + id, winRate: 80, positions: [] }));
const alert = (id, whaleId, time = now - 1000, extra = {}) => ({
  id, whaleId, whaleName: whaleId, at: time, kind: 'open',
  items: [{ kind: 'open', coin: 'BTC', side: 'long', usd: 100000, price: 60000, time, ...extra }],
});
function scan(alerts, roster = whales) {
  return scanResonanceSignals({ whales: roster, activity: [], alerts, now, config: DEFAULT_RESONANCE_CONFIG, watchedCoins: ['BTC'] });
}

test('streamed resonance inputs match arrays and large input sets do not overflow argument stack', () => {
  const small = whales.map(w => alert('stream-' + w.id, w.id));
  function* events() { yield* small; }
  assert.deepEqual(scan(events()), scan(small));
  function* large() {
    for (let i = 0; i < 150000; i++) yield alert('many-' + i, whales[i % 3].id);
  }
  assert.equal(scan(large()).primary.totalUsd, 150000 * 100000);
});
test('server uses the complete roster rather than the visible whale page', () => {
  const events = whales.map(w => alert('e' + w.id, w.id));
  assert.equal(scan(events).primary.whaleCount, 3);
  assert.equal(scan(events, whales.slice(0, 1)).hit, false);
});
test('observed snapshots are not mistaken for timed opens; time and followed coin remain filters', () => {
  const events = whales.map(w => alert('e' + w.id, w.id));
  events[2].items[0].evidenceSource = 'snapshot';
  events[2].items[0].timeSource = 'observed';
  assert.equal(scan(events).hit, false);
  events[2] = alert('old', 'c', now - 25 * 3600000);
  assert.equal(scan(events).hit, false);
  events[2] = alert('eth', 'c', now - 1000, { coin: 'ETH' });
  assert.equal(scan(events).hit, false);
});
test('canonical signal window has no display limit and uses actual execution time', () => {
  const db = getDb();
  const insert = db.prepare('INSERT INTO fills(id, whale_id, time, payload_json) VALUES (?, ?, ?, ?)');
  db.transaction(() => {
    for (let i = 0; i < 2101; i++) {
      const row = { id: 'db-' + i, whaleId: 'a', time: now - 1000, asset: 'BTC', side: 'buy', amount: 1, amountUsd: 100000, startPosition: 0 };
      insert.run(row.id, row.whaleId, row.time, JSON.stringify(row));
    }
  })();
  assert.equal(loadResonanceInputs(now - 3600000, now, 50000).alerts.length, 2101);
  assert.equal(loadResonanceInputs(now - 3600000, now - 2000, 50000).alerts.length, 0);
  assert.equal(loadResonanceInputs(now - 3600000, now, 200000).alerts.length, 2101);
});
