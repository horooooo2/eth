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
test('SQL signal window has no display limit and uses item execution time', () => {
  const db = getDb();
  const insert = db.prepare('INSERT INTO alerts(id, whale_id, time, kind, payload_json) VALUES (?, ?, ?, ?, ?)');
  const insertItem = db.prepare('INSERT INTO alert_items(alert_id, item_index, kind, coin, side, usd, time) VALUES (?, 0, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    for (let i = 0; i < 2101; i++) {
      const row = alert('db-' + i, 'a');
      // Stored record time is deliberately old; execution time controls the window.
      insert.run(row.id, row.whaleId, now - 30 * 3600000, row.kind, JSON.stringify(row));
      insertItem.run(row.id, 'open', 'BTC', 'long', 100000, row.items[0].time);
    }
  })();
  assert.equal(loadResonanceInputs(now - 3600000, now, 50000).alerts.length, 2101);
  assert.equal(countStoredAlerts(), 2101);
  assert.equal(loadResonanceInputs(now - 3600000, now - 2000, 50000).alerts.length, 0);
  assert.equal(loadResonanceInputs(now - 3600000, now, 200000).alerts.length, 0);
});
