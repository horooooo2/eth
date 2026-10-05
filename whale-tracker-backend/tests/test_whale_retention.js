const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/isolateSqlite');
const { getDb, FILL_RETENTION_MS, CLOSED_POSITION_RETENTION_MS } = require('../lib/db');
const { persistStatePatch, loadPagedAlerts } = require('../lib/sqliteStore');
const { runRetentionBatch } = require('../lib/whaleRetention');
const { stream } = require('../lib/whaleSync');

test('bounded retention preserves open-position history and deletes closed alerts with tombstones', () => {
  const now = Date.now();
  const old = now - Math.max(FILL_RETENTION_MS, CLOSED_POSITION_RETENTION_MS) - 1000;
  const trades = ['live', 'closed'].map(id => ({ id, whaleId: id, time: old, asset: 'BTC', side: 'buy',
    amount: 1, amountUsd: 60000, price: 60000, startPosition: 0 }));
  persistStatePatch({ whales: [{ id: 'live', positions: [{ coin: 'BTC', side: 'long', size: 1, positionValue: 60000 }] },
    { id: 'closed', positions: [] }], trades });
  const before = loadPagedAlerts({}).alerts;
  assert.equal(before.length, 2);
  const result = runRetentionBatch(now, 1);
  assert.equal(result.removedFills, 1);
  assert.equal(result.removedAlertIds.length, 1);
  assert.equal(result.removedEvents, 1);
  const after = loadPagedAlerts({}).alerts;
  assert.equal(after.length, 1);
  assert.equal(after[0].whaleId, 'live');
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM alert_items WHERE alert_id=?').get(result.removedAlertIds[0]).n, 0);
  stream.close();
});
