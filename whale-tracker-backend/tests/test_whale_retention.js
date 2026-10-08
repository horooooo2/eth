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

test('retention bounds scanned candidates and rotates past protected history and equal timestamps', () => {
  const db=getDb(), now=Date.now(), old=now-Math.max(FILL_RETENTION_MS,CLOSED_POSITION_RETENTION_MS)-5000;
  db.exec('DELETE FROM events; DELETE FROM alert_items; DELETE FROM alert_sources; DELETE FROM alerts; DELETE FROM positions');
  db.prepare('INSERT INTO positions(whale_id,coin,side,size,payload_json,updated_at) VALUES(?,?,?,?,?,?)')
    .run('protected','BTC','long',1,'{}',now);
  const event=db.prepare('INSERT INTO events(id,whale_id,time,kind,coin,side,usd,payload_json) VALUES(?,?,?,?,?,?,?,?)');
  const alert=db.prepare('INSERT INTO alerts(id,whale_id,time,kind,payload_json) VALUES(?,?,?,?,?)');
  db.transaction(()=>{
    for(let i=0;i<601;i++) {
      const id=String(i).padStart(4,'0'), whale=i<600?'protected':'closed';
      event.run(id,whale,old,'open','BTC','long',100,'{}');
      alert.run(id,whale,old,'open',JSON.stringify({items:[{coin:'BTC',side:'long'}]}));
    }
  })();
  const first=runRetentionBatch(now,500);
  assert.equal(first.removedEvents,0,'only the first 500 protected candidates may be inspected');
  assert.equal(first.removedAlertIds.length,0);
  const second=runRetentionBatch(now,500);
  assert.equal(second.removedEvents,1);
  assert.deepEqual(second.removedAlertIds,['0600']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n,600);
  // Closing a position makes previously protected history eligible next sweep.
  db.prepare('DELETE FROM positions WHERE whale_id=?').run('protected');
  const third=runRetentionBatch(now,500);
  assert.equal(third.removedEvents,500);
  assert.equal(third.removedAlertIds.length,500);
  runRetentionBatch(now,500);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM alerts').get().n,0);
});
