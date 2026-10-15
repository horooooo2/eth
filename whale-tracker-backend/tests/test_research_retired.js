'use strict';
require('./helpers/isolateSqlite');
const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb } = require('../lib/db');

test('fresh databases no longer create the retired analysis history table', () => {
  assert.equal(getDb().prepare("SELECT name FROM sqlite_master WHERE name='contract_research_history'").get(), undefined);
});

test('deleting an account works on both fresh and legacy history schemas', () => {
  const auth = require('../lib/authStore');
  const fresh = auth.createUser('retired-fresh', 'test-only-password');
  assert.equal(auth.deleteUser(fresh.id).id, fresh.id);
  const legacy = auth.createUser('retired-legacy', 'test-only-password');
  const db = getDb();
  db.exec('CREATE TABLE contract_research_history(id TEXT PRIMARY KEY,user_id TEXT,payload_json TEXT)');
  db.prepare('INSERT INTO contract_research_history VALUES(?,?,?)').run('old-record', legacy.id, '{}');
  auth.deleteUser(legacy.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM contract_research_history').get().total, 0);
  assert.equal(db.prepare('SELECT id FROM users WHERE id=?').get(legacy.id), undefined);
});

test('retired analysis endpoints return 404 while hot news and health remain available', async () => {
  const hot = require('../lib/hotNews'), original = hot.getHotNews;
  hot.getHotNews = async () => ({ items: [], ranking: 'test fixture', stale: false });
  const app = require('../lib/createApp').createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    for (const route of ['/catalog', '/snapshot', '/context', '/latest', '/history', '/history/old-record']) {
      assert.equal((await fetch(base + '/research' + route)).status, 404, route);
    }
    for (const route of ['/alerts', '/save', '/analyze']) {
      assert.equal((await fetch(base + '/research' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404, route);
    }
    const response = await fetch(base + '/news/hot');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ranking, 'test fixture');
    assert.equal((await fetch(base + '/health')).status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    hot.getHotNews = original;
  }
});
