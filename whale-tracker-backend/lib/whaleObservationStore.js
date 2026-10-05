const { canonicalTradeId, isRawTrade } = require('./positionEventPolicy');
const { buildObservations } = require('./whaleObservationEngine');
const { createHash } = require('node:crypto');
const DAY = 86400000;
const KEEP = 7 * DAY;
function recordInput(db, trade, now = Date.now()) {
  const id = canonicalTradeId(trade), coin = String(trade.assetLabel || trade.asset || '');
  if (!id || !trade.whaleId || !isRawTrade(trade)) return;
  const old = db.prepare('SELECT whale_id,coin,payload_json FROM observation_inputs WHERE id=?').get(id);
  const eligible = trade.source !== 'onchain' && !trade.exotic && trade.instrumentType !== 'spot' && !/[@:/]/.test(coin) && Number(trade.time) >= now-KEEP && Number(trade.time) <= now+60000;
  // Only copy facts needed to reproduce the event, not large collector payloads.
  const payload = { id, whaleId:String(trade.whaleId), asset:coin, time:Number(trade.time),
    side:trade.side, amount:trade.amount, price:trade.price, startPosition:trade.startPosition,
    dir:trade.dir, closedPnl:trade.closedPnl, liquidation:trade.liquidation,
    address:[trade.address,trade.from,trade.to].find(value=>/^0x[0-9a-f]{40}$/i.test(String(value || ''))) || '', source:trade.source };
  const json = JSON.stringify(payload);
  if (eligible && old?.payload_json === json) return;
  if (!eligible && !old) return;
  const dirty = db.prepare('INSERT OR IGNORE INTO observation_jobs(whale_id,coin) VALUES(?,?)');
  if (old) dirty.run(old.whale_id,old.coin);
  if (!eligible) { db.prepare('DELETE FROM observation_inputs WHERE id=?').run(id); return; }
  db.prepare(`INSERT INTO observation_inputs VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    whale_id=excluded.whale_id,coin=excluded.coin,time=excluded.time,payload_json=excluded.payload_json`).run(id,payload.whaleId,coin,payload.time,now,json);
  dirty.run(payload.whaleId,coin);
}
function processPair(db, job, now = Date.now()) {
  return db.transaction(() => {
    const inputs = db.prepare('SELECT payload_json FROM observation_inputs WHERE whale_id=? AND coin=? AND time>=? ORDER BY time,id').all(job.whale_id,job.coin,now-KEEP).map(r=>JSON.parse(r.payload_json));
    const next = buildObservations(inputs, require('./sqliteStore').eventsFromTrade);
    const old = new Map(db.prepare('SELECT id,payload_json FROM whale_observations WHERE whale_id=? AND coin=?').all(job.whale_id,job.coin).map(r=>[r.id,JSON.parse(r.payload_json)]));
    let changed = false;
    const upsert = db.prepare('INSERT OR REPLACE INTO whale_observations VALUES(?,?,?,?,?)');
    for (const fullEvent of next) {
      const {evidence, ...fields} = fullEvent;
      const evidenceJson=JSON.stringify(evidence);
      const event={...fields,evidenceCount:evidence.length,evidenceHash:createHash('sha256').update(evidenceJson).digest('hex')};
      const previous = old.get(event.id); old.delete(event.id);
      const { revision: _revision, publishedAt: _published, updatedAt: _updated, ...before } = previous || {};
      if (JSON.stringify(before) === JSON.stringify(event)) continue;
      changed = true;
      const stored = {...event, revision:(previous?.revision || 0)+1, publishedAt:previous?.publishedAt || now, updatedAt:now};
      upsert.run(event.id,event.whaleId,event.coin,event.lastAt,JSON.stringify(stored));
      db.prepare('INSERT OR REPLACE INTO observation_evidence VALUES(?,?)').run(event.id,evidenceJson);
    }
    for (const id of old.keys()) { db.prepare('DELETE FROM whale_observations WHERE id=?').run(id); db.prepare('DELETE FROM observation_evidence WHERE event_id=?').run(id); changed=true; }
    db.prepare('DELETE FROM observation_jobs WHERE whale_id=? AND coin=?').run(job.whale_id,job.coin);
    return changed;
  })();
}
function list(db, now = Date.now()) {
  const roster=new Map(require('./config').getActiveWhales().map(w=>[String(w.id),w.address]));
  return db.prepare('SELECT payload_json FROM whale_observations WHERE last_at>=? ORDER BY last_at DESC,id LIMIT 100').all(now-DAY).map(r=>{
    const { evidenceHash, ...summary } = JSON.parse(r.payload_json);
    const address=roster.get(summary.whaleId) || (/^0x[0-9a-f]{40}$/i.test(summary.address) ? summary.address : '');
    return {...summary,address};
  });
}
function evidence(db, id, offset) {
  const row = db.prepare('SELECT payload_json FROM whale_observations WHERE id=?').get(id);
  if (!row) return null;
  const event=JSON.parse(row.payload_json);
  const evidence=JSON.parse(db.prepare('SELECT payload_json FROM observation_evidence WHERE event_id=?').get(id)?.payload_json || '[]');
  return {id,revision:event.revision,total:evidence.length,offset,rows:evidence.slice(offset,offset+50)};
}
function prune(db, now=Date.now()) {
  return db.transaction(()=>{
    db.prepare('DELETE FROM observation_inputs WHERE time<?').run(now-KEEP);
    const changed=db.prepare('DELETE FROM whale_observations WHERE last_at<?').run(now-KEEP).changes;
    db.prepare('DELETE FROM observation_evidence WHERE event_id NOT IN (SELECT id FROM whale_observations)').run();
    return changed;
  })();
}
module.exports={recordInput,processPair,list,evidence,prune};
