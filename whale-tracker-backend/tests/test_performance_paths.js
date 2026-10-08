const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { dir } = require('./helpers/isolateSqlite');
process.env.CACHE_DIR = path.join(dir, 'cache');
const { getDb } = require('../lib/db');
const store = require('../lib/sqliteStore');
const evidence = require('../lib/observationEvidence');

test('visible counter stays exact across replace, visibility correction, deletion and rollback', () => {
  const db = getDb(); db.exec('DELETE FROM alerts');
  const put = db.prepare('INSERT OR REPLACE INTO alerts(id,whale_id,time,kind,payload_json,is_visible) VALUES(?,?,?,?,?,?)');
  const check = () => assert.equal(store.countStoredAlerts(), db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE is_visible=1').get().n);
  put.run('counter', 'a', Date.now(), 'open', '{}', 1); check();
  put.run('counter', 'a', Date.now(), 'open', '{}', 1); check();
  db.prepare('UPDATE alerts SET is_visible=0 WHERE id=?').run('counter'); check();
  assert.throws(() => db.transaction(() => { put.run('counter', 'a', 1, 'open', '{}', 1); throw Error('rollback'); })()); check();
  db.exec('DELETE FROM alerts'); check();
});

test('evidence pages preserve order, legacy compatibility, shared rows and atomic corrections', () => {
  const db = getDb(), rows = Array.from({ length: 140 }, (_, i) => ({ id: String(i), time: i }));
  db.transaction(() => {
    const encoded = evidence.encodeEvidence(rows).encoded;
    evidence.writeEvidence(db, 'one', encoded); evidence.writeEvidence(db, 'two', encoded);
  })();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM observation_evidence_rows').get().n, 140);
  assert.deepEqual([...evidence.readEvidence(db, 'two', 50, 50)], rows.slice(50, 100));
  const crypto = require('node:crypto');
  assert.equal(evidence.encodeEvidence(rows).hash, crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'));
  assert.throws(() => db.transaction(() => { evidence.writeEvidence(db, 'one', []); throw Error('rollback'); })());
  assert.equal([...evidence.readEvidence(db, 'one')].length, 140);
  db.prepare('INSERT INTO observation_evidence VALUES(?,?)').run('legacy', JSON.stringify(rows));
  assert.deepEqual([...evidence.readEvidence(db, 'legacy', 100, 50)], rows.slice(100));
  db.transaction(() => evidence.removeEvidence(db, 'one'))();
  assert.equal([...evidence.readEvidence(db, 'two')].length, 140);
});

test('mirror writes stay ordered, resets cannot resurrect old data, failures do not spin', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whale-mirror-'));
  const target = path.join(dir, 'mirror.json');
  const writer = require('../lib/asyncMirror').createMirrorWriter(() => target);
  try {
    void writer.write('a', { rows: Array.from({ length: 600 }, (_, i) => ({ i })) });
    void writer.clear('a'); void writer.write('a', { rows: ['latest'] });
    await writer.flush('a');
    assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')).data, { rows: ['latest'] });
    await writer.clear('a'); await writer.flush('a');
    await assert.rejects(fs.access(target));
    let failures = 0;
    const broken = require('../lib/asyncMirror').createMirrorWriter(() => { throw Error('bad path'); }, () => failures++);
    await broken.write('bad', { rows: [] }); await broken.flush('bad'); assert.equal(failures, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('rows-only alert reads do not run facet queries and preserve filtered page rows', () => {
  const db = getDb(); db.exec('DELETE FROM alert_items; DELETE FROM alerts');
  for (const [id, side, coin] of [['l', 'long', 'BTC'], ['s', 'short', 'ETH']]) {
    db.prepare('INSERT INTO alerts(id,whale_id,time,kind,payload_json) VALUES(?,?,?,?,?)').run(id, 'a', Date.now(), 'open', JSON.stringify({ id, items: [{ side, coin }] }));
    db.prepare('INSERT INTO alert_items(alert_id,item_index,coin,side,usd,kind) VALUES(?,0,?,?,?,?)').run(id, coin, side, 1000, 'open');
  }
  store.invalidateAlertQueries();
  const full = store.loadPagedAlerts({ coin: 'BTC', limit: 100 });
  const quick = store.loadPagedAlerts({ coin: 'BTC', limit: 100, rowsOnly: true });
  assert.deepEqual(quick.alerts, full.alerts); assert.equal(quick.facets, undefined);
  assert.equal(full.total, 1); assert.deepEqual(full.facets, { all: 1, byCoin: { BTC: 1 }, long: 1, short: 0 });
});

test('summary cache invalidates on positions, reuses on fills, and refreshes freshness with time', () => {
  const config = require('../lib/config'), previous = config.getActiveWhales;
  config.getActiveWhales = () => [{ id: 'summary-test' }];
  const cache = require('../lib/cache'), { getWhaleSummary } = require('../lib/whales');
  const originalRead = cache.readStateSnapshot, originalNow = Date.now;
  const at = Date.now(); let reads = 0;
  cache.readStateSnapshot = (...args) => { reads++; return originalRead(...args); };
  try {
    const whale = { id: 'summary-test', positionObservedAt: at, positions: [{ coin: 'BTC', side: 'long', positionValue: 100, unrealizedPnl: 5, leverage: 2 }] };
    cache.commitWhaleState('hf', { whales: [whale] });
    assert.equal(getWhaleSummary().longUsd, 100);
    const first = reads; getWhaleSummary(); assert.equal(reads, first);
    cache.commitWhaleState('hf', { trades: [{ id: 'summary-fill', whaleId: 'summary-test', asset: 'BTC', side: 'buy', startPosition: 0, amount: 1, amountUsd: 100, time: at }] });
    const afterCommit = reads; assert.equal(getWhaleSummary().longUsd, 100); assert.equal(reads, afterCommit);
    Date.now = () => at + 600000;
    assert.equal(getWhaleSummary().freshness.freshCount, 0);
    Date.now = originalNow;
    cache.commitWhaleState('hf', { whales: [{ ...whale, positions: [{ ...whale.positions[0], positionValue: 200 }] }] });
    assert.equal(getWhaleSummary().longUsd, 200);
  } finally { cache.readStateSnapshot = originalRead; Date.now = originalNow; config.getActiveWhales = previous; }
});
