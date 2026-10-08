const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/isolateSqlite');

test('ordinary signed-in users can reset; anonymous requests remain rejected', async () => {
  const auth = require('../lib/authStore');
  auth.createUser('reset-member', 'test-password');
  const { token } = auth.login('reset-member', 'test-password');
  const reset = require('../lib/siteReset');
  const original = reset.resetSiteData;
  let calls = 0;
  reset.resetSiteData = async () => { calls++; return { keptManuals: 0, backfill: {} }; };
  const server = require('../lib/createApp').createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/data/reset`;
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    assert.equal(calls, 0);
    const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).ok, true);
    while (reset.isBusy()) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(calls, 1);
  } finally {
    reset.resetSiteData = original;
    await new Promise(resolve => server.close(resolve));
  }
});

test('management whale endpoint only reads the whale list', async () => {
  const db = require('../lib/db').getDb();
  const server = require('../lib/createApp').createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const prepare = db.prepare;
  let queries = 0;
  db.prepare = function(sql) {
    assert.match(sql, /FROM whales/);
    assert.doesNotMatch(sql, /GROUP\s+BY/i);
    queries++;
    return prepare.call(this, sql);
  };
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/data/whales`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(Object.keys(data), ['whales', 'total']);
    assert.ok(Array.isArray(data.whales));
    assert.equal(data.total, data.whales.length);
    assert.equal(queries, 2);
  } finally {
    db.prepare = prepare;
    await new Promise(resolve => server.close(resolve));
  }
});

test('management browse returns bounded recent rows without table counts or source aggregation', () => {
  const db = require('../lib/db').getDb();
  const store = require('../lib/sqliteStore');
  const now = Date.now();
  const insert = db.prepare('INSERT INTO alerts(id,whale_id,time,kind,payload_json) VALUES(?,?,?,?,?)');
  db.transaction(() => {
    for (let i = 0; i < 65; i++) insert.run(`browse-${i}`, 'a', now - i, 'open', '{}');
  })();
  const prepare = db.prepare;
  db.prepare = function(sql) {
    assert.doesNotMatch(sql, /COUNT\s*\(|GROUP\s+BY/i);
    return prepare.call(this, sql);
  };
  try {
    const data = store.loadDbBrowse({ limit: 50 });
    assert.equal(data.alerts.length, 50);
    assert.equal(data.alerts[0].id, 'browse-0');
    assert.equal(data.alerts[49].id, 'browse-49');
    assert.equal(data.status.countsAvailable, false);
    assert.equal(data.status.alerts, null);
    assert.equal(data.fillBySource, null);
  } finally { db.prepare = prepare; }
});

test('health and monitor respond without SQLite or configuration reads, including enabled observations', async () => {
  const db = require('../lib/db');
  const config = require('../lib/config');
  const app = require('../lib/createApp').createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const original = { getDb: db.getDb, getMeta: db.getMeta, dbStatus: db.dbStatus,
    getActiveWhales: config.getActiveWhales, readConfig: config.readConfig };
  const previous = process.env.WHALE_OBSERVATIONS_ENABLED;
  let reads = 0;
  const forbidden = () => { reads++; throw new Error('synchronous storage read in liveness request'); };
  db.getDb = db.getMeta = db.dbStatus = forbidden;
  config.getActiveWhales = config.readConfig = forbidden;
  process.env.WHALE_OBSERVATIONS_ENABLED = '1';
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (let i = 0; i < 3; i++) {
      const health = await fetch(base + '/api/health');
      assert.equal(health.status, 200);
      const data = await health.json();
      assert.equal(data.sqlite.scope, 'connection-only');
      assert.equal(data.sqlite.checked, false);
      assert.equal(data.fillBackfill.feature, 'continuous-fill-capture');
      assert.equal('watermarks' in data.fillBackfill, false);
      const monitor = await fetch(base + '/api/data/monitor');
      assert.equal(monitor.status, 200);
      assert.equal((await monitor.json()).observationCompute.pendingPairs, null);
    }
    assert.equal(reads, 0);
  } finally {
    for (const name of ['getDb', 'getMeta', 'dbStatus']) db[name] = original[name];
    for (const name of ['getActiveWhales', 'readConfig']) config[name] = original[name];
    if (previous === undefined) delete process.env.WHALE_OBSERVATIONS_ENABLED;
    else process.env.WHALE_OBSERVATIONS_ENABLED = previous;
    await new Promise(resolve => server.close(resolve));
  }
});

test('reset returns partial refresh errors and progress endpoint never scans historical tables', async () => {
  const auth = require('../lib/authStore');
  auth.createUser('reset-progress-member', 'test-password');
  const { token } = auth.login('reset-progress-member', 'test-password');
  const reset = require('../lib/siteReset'), worker = require('../lib/fillBackfill');
  const originals = { reset: reset.resetSiteData, status: worker.getResetRecoveryStatus };
  const recovery = { status: 'recovering', monitored: 50, recovered: 3, errors: 1 };
  reset.resetSiteData = async () => ({ keptManuals: 2, recovery, refresh: { error: 'upstream unavailable' } });
  worker.getResetRecoveryStatus = () => recovery;
  const server = require('../lib/createApp').createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const database = require('../lib/db').getDb(), prepare = database.prepare;
  database.prepare = function(sql) { assert.doesNotMatch(sql, /FROM (fills|alerts|events)/i); return prepare.call(this,sql); };
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/data`;
    assert.equal((await fetch(base+'/reset-status')).status,401);
    const options = { headers: { Authorization: `Bearer ${token}` } };
    const response = await fetch(base+'/reset',{ ...options, method:'POST' });
    const data = await response.json();
    assert.equal(response.status,202); assert.ok(data.job.id);
    while (reset.isBusy()) await new Promise(resolve => setTimeout(resolve, 5));
    const status = await (await fetch(base+'/reset-status',options)).json();
    assert.equal(status.recovery.recovered,3); assert.equal(status.error,'upstream unavailable');
  } finally {
    database.prepare = prepare;
    reset.resetSiteData = originals.reset; worker.getResetRecoveryStatus = originals.status;
    await new Promise(resolve => server.close(resolve));
  }
});
