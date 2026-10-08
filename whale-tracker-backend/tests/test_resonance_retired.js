const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/isolateSqlite');
const { getDb, closeDb } = require('../lib/db');

test('upgrade removes resonance write triggers without removing source data', () => {
  let db = getDb();
  db.exec('CREATE TABLE statistics_input_version(id INTEGER PRIMARY KEY, version INTEGER); INSERT INTO statistics_input_version VALUES(1, 7)');
  for (const table of ['fills', 'whales']) for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
    db.exec(`CREATE TRIGGER statistics_${table}_${action.toLowerCase()} AFTER ${action} ON ${table}
      BEGIN UPDATE statistics_input_version SET version=version+1 WHERE id=1; END`);
  }
  db.prepare('INSERT INTO whales(id,payload_json,updated_at) VALUES(?,?,?)').run('retirement-test', '{}', Date.now());
  closeDb(); db = getDb();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'statistics_%'").get().n, 0);
  assert.ok(db.prepare('SELECT id FROM whales WHERE id=?').get('retirement-test'));
  const version = db.prepare('SELECT version FROM statistics_input_version').get().version;
  db.prepare('UPDATE whales SET updated_at=? WHERE id=?').run(Date.now(), 'retirement-test');
  assert.equal(db.prepare('SELECT version FROM statistics_input_version').get().version, version);
});

test('retired endpoint returns 404; health and data management still respond', async () => {
  const { createApp } = require('../lib/createApp');
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/api/whales/resonance?windowHours=6&coins=BTC')).status, 404);
    for (const path of ['/api/health', '/api/data/monitor', '/api/data/browse']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200, path);
      const body = await response.json();
      if (path.endsWith('monitor')) assert.equal(body.statisticsCompute, undefined);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
