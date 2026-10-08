const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./helpers/isolateSqlite');
process.env.CACHE_DIR = require('node:path').join(fixture.dir, 'cache');
const db = require('../lib/db').getDb();
const maintenance = require('../lib/marketMaintenance');
const reset = require('../lib/siteReset');
const count = require('../lib/alertCount');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function finished() {
  const deadline = Date.now() + 10000;
  while (reset.isBusy() && Date.now() < deadline) await sleep(10);
  assert.equal(reset.isBusy(), false, 'cleanup must terminate');
  return reset.getResetStatus();
}

test('background cleanup rejects duplicates, preserves users and serves health during deletion', async () => {
  const auth = require('../lib/authStore');
  const user = auth.createUser('job-user', 'test-password');
  auth.writeSettings(user.id, { watchedCoins:['BTC'] });
  const roster = require('../lib/config').getActiveWhales();
  const { token } = auth.login('job-user', 'test-password');
  const insert = db.prepare('INSERT INTO alerts(id,whale_id,time,kind,payload_json) VALUES(?,?,?,?,?)');
  db.transaction(() => { for (let i=0;i<2500;i++) insert.run(`job-${i}`,'a',Date.now(),'open','{}'); })();
  db.exec(`
    INSERT INTO fills(id,time,payload_json) VALUES('job-fill',1,'{}');
    INSERT INTO events(id,time,kind,payload_json) VALUES('job-event',1,'open','{}');
    INSERT INTO alert_items(alert_id,item_index) VALUES('job-0',0);
    INSERT INTO alert_sources(source_id,alert_id) VALUES('job-source','job-0');
    INSERT INTO positions(whale_id,coin,side,payload_json,updated_at) VALUES('a','BTC','long','{}',1);
    INSERT INTO whales(id,payload_json,updated_at) VALUES('a','{}',1);
  `);
  const fills = require('../lib/fillBackfill'), poller = require('../lib/positionPoller');
  const originals = { start: fills.startFillBackfill, restart: poller.restart };
  fills.startFillBackfill = () => {}; poller.restart = () => {};
  const server = require('../lib/createApp').createApp().listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const options = { method:'POST', headers:{ Authorization:`Bearer ${token}` } };
    const response = await fetch(base+'/data/reset',options);
    assert.equal(response.status,202);
    assert.ok((await response.json()).job.id);
    assert.equal(reset.isBusy(),true);
    assert.equal((await fetch(base+'/data/reset',options)).status,409);
    assert.throws(() => require('../lib/sqliteStore').persistTradesIncremental([]),{code:'MARKET_RESET'});
    let healthReads = 0;
    while (reset.isBusy()) {
      assert.equal((await fetch(base+'/health')).status,200);
      healthReads++; await sleep(25);
    }
    assert.ok(healthReads >= 2);
    const status = await finished();
    assert.equal(status.job.deletedRows,2506);
    assert.equal(count.getAlertCount().total,0);
    for (const table of ['fills','events','alert_items','alert_sources','alerts','positions','whales']) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
    assert.equal(auth.requireUser({headers:{authorization:`Bearer ${token}`}}).user.username,'job-user');
    assert.deepEqual(auth.readSettings(user.id).settings,{watchedCoins:['BTC']});
    assert.deepEqual(require('../lib/config').getActiveWhales(),roster);
    assert.equal(maintenance.isPaused(),false);
  } finally {
    fills.startFillBackfill = originals.start; poller.restart = originals.restart;
    fills.stopFillBackfill(); poller.stop();
    await new Promise(resolve => server.close(resolve));
  }
});

test('failed cleanup stays paused and a retry completes without claiming success', async () => {
  db.exec('ALTER TABLE whales RENAME TO missing_whales');
  try {
    reset.startResetJob();
    const status = await finished();
    assert.equal(status.job.status,'failed');
    assert.match(status.job.error,/whales/);
    assert.equal(status.recovery,null);
    assert.equal(maintenance.isPaused(),true);
  } finally { db.exec('ALTER TABLE missing_whales RENAME TO whales'); }
  const fills = require('../lib/fillBackfill'), poller = require('../lib/positionPoller');
  const start = fills.startFillBackfill, restart = poller.restart;
  fills.startFillBackfill = () => {}; poller.restart = () => {};
  try { reset.startResetJob(); assert.notEqual((await finished()).job.status,'failed'); }
  finally { fills.startFillBackfill=start; poller.restart=restart; fills.stopFillBackfill(); poller.stop(); }
});

test('responses from old collector generations cannot write even with a new baseline after resume', async () => {
  const cache = require('../lib/cache');
  let release;
  const old = maintenance.runCollection(async () => {
    await new Promise(resolve => { release=resolve; });
    const baseline = cache.captureWhaleRevisions('hf');
    cache.commitWhaleState('hf',{ trades:[], expectedWhaleRevisions:baseline });
  });
  const baseline = cache.captureWhaleRevisions('hf');
  maintenance.begin(); maintenance.resume(); release();
  await assert.rejects(old,{code:'MARKET_RESET'});
  assert.throws(() => cache.commitWhaleState('hf',{trades:[],expectedWhaleRevisions:baseline}),{code:'MARKET_RESET'});
});

test('interrupted cleanup resumes the same durable job before allowing collectors', async () => {
  require('../lib/db').setMeta('market_reset_job_v1',JSON.stringify({id:'interrupted',status:'clearing',deletedRows:0,error:null}));
  const original = reset.resetSiteData;
  let release;
  reset.resetSiteData = () => new Promise(resolve => { release=resolve; });
  try {
    reset.resumeInterruptedReset();
    assert.equal(maintenance.isPaused(),true);
    assert.equal(reset.getResetStatus().job.id,'interrupted');
    await sleep(10);
    release({recovery:{status:'complete'}});
    await finished();
    assert.equal(maintenance.isPaused(),false);
  } finally { reset.resetSiteData = original; }
});

test('session checks are read-only and still reject expired tokens', () => {
  const auth = require('../lib/authStore');
  const { token } = auth.login('job-user','test-password');
  const prepare = db.prepare;
  db.prepare = function(sql) { assert.match(sql,/^\s*SELECT/i); return prepare.call(this,sql); };
  try { assert.equal(auth.getSessionUser(token).user.username,'job-user'); }
  finally { db.prepare=prepare; }
  db.prepare('UPDATE sessions SET expires_at=0 WHERE token=?').run(token);
  db.prepare = function(sql) { assert.match(sql,/^\s*SELECT/i); return prepare.call(this,sql); };
  try { assert.equal(auth.getSessionUser(token),null); }
  finally { db.prepare=prepare; }
});

test('legacy count bootstrap reconciles concurrent writes and never overwrites reset zero', async () => {
  const insert = db.prepare('INSERT INTO alerts(id,whale_id,time,kind,payload_json) VALUES(?,?,?,?,?)');
  db.transaction(() => { for (let i=0;i<3500;i++) insert.run(`init-${i}`,'a',1,'open','{}'); })();
  db.exec('UPDATE alert_totals SET total=NULL WHERE id=1');
  assert.equal(count.getAlertCount().status,'initializing');
  await sleep(75);
  db.transaction(() => {
    insert.run('concurrent','a',1,'open','{}');
    db.prepare('DELETE FROM alerts WHERE id=?').run('init-0');
  })();
  const deadline=Date.now()+5000;
  while (count.getAlertCount().total===null && Date.now()<deadline) await sleep(20);
  assert.equal(count.getAlertCount().total,3500);
  db.exec('UPDATE alert_totals SET total=NULL WHERE id=1');
  count.getAlertCount(); await sleep(75);
  db.transaction(() => { db.exec('DELETE FROM alerts'); db.exec('UPDATE alert_totals SET total=0 WHERE id=1'); })();
  await sleep(200);
  assert.equal(count.getAlertCount().total,0);
  await count.stopInitialization();
});
