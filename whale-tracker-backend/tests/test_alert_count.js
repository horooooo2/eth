const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/isolateSqlite');

test('alert count uses only a transactional counter and reflects deletes, replace and rollback', () => {
  const db = require('../lib/db').getDb();
  const count = require('../lib/alertCount').getAlertCount;
  const insert = db.prepare('INSERT INTO alerts(id,whale_id,time,kind,payload_json) VALUES(?,?,?,?,?)');
  db.transaction(() => { for (let i = 0; i < 121; i++) insert.run(`count-${i}`, 'count-whale', Date.now(), 'open', '{}'); })();
  const original = db.prepare;
  db.prepare = function(sql) { assert.equal(sql, 'SELECT total FROM alert_totals WHERE id=1'); return original.call(this,sql); };
  try { assert.equal(count().total, 121); assert.ok(count().countedAt > 0); }
  finally { db.prepare = original; }
  db.prepare('UPDATE alerts SET is_visible=0 WHERE id=?').run('count-0');
  assert.equal(count().total,121);
  db.prepare('INSERT OR REPLACE INTO alerts(id,whale_id,time,kind,payload_json) VALUES(?,?,?,?,?)').run('count-0','a',Date.now(),'open','{}');
  assert.equal(count().total,121);
  assert.throws(db.transaction(() => { insert.run('rollback','a',1,'open','{}'); throw new Error('rollback'); }));
  assert.equal(count().total,121);
  db.prepare('DELETE FROM alerts WHERE id LIKE ?').run('count-%');
  assert.equal(count().total,0);
});

test('alert count API requires login and returns only the count and observation time', async () => {
  const auth = require('../lib/authStore');
  auth.createUser('count-member', 'test-password');
  const { token } = auth.login('count-member', 'test-password');
  const server = require('../lib/createApp').createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/data/alert-count`;
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.deepEqual(Object.keys(result).sort(), ['countedAt', 'status', 'total']);
    assert.equal(result.total, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
