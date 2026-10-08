const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/isolateSqlite');

test('alert count uses a read-only worker, shares concurrent requests and reflects deletions', async () => {
  const db = require('../lib/db').getDb();
  const count = require('../lib/alertCount').getAlertCount;
  const insert = db.prepare('INSERT INTO alerts(id,whale_id,time,kind,payload_json) VALUES(?,?,?,?,?)');
  db.transaction(() => { for (let i = 0; i < 121; i++) insert.run(`count-${i}`, 'count-whale', Date.now(), 'open', '{}'); })();
  const original = db.prepare;
  db.prepare = () => { throw new Error('count must not query the main-thread connection'); };
  try {
    const first = count();
    assert.equal(first, count());
    const result = await first;
    assert.equal(result.total, 121);
    assert.ok(result.countedAt > 0);
  } finally { db.prepare = original; }
  db.prepare('DELETE FROM alerts WHERE id LIKE ?').run('count-%');
  assert.equal((await count()).total, 0);
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
    assert.deepEqual(Object.keys(result).sort(), ['countedAt', 'total']);
    assert.equal(result.total, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
