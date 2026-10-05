const { canonicalTradeId, isRawTrade } = require('./positionEventPolicy');
const { buildObservations } = require('./whaleObservationEngine');
const { createHash } = require('node:crypto');
const DAY = 86400000;
const KEEP = 7 * DAY;
function timingFor(evidence, generatedAt) {
  const latest=evidence.reduce((a,r)=>!a||r.time>a.time?r:a,null);
  const received=evidence.map(r=>r.receivedAt).filter(n=>Number.isFinite(n)&&n>0);
  return {eventAt:latest?.time || null,latestExecutionReceivedAt:latest?.receivedAt || null,
    inputsReadyAt:received.length===evidence.length?received.reduce((a,b)=>Math.max(a,b),0):null,generatedAt};
}
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
    const inputs = db.prepare('SELECT payload_json,received_at FROM observation_inputs WHERE whale_id=? AND coin=? AND time>=? ORDER BY time,id').all(job.whale_id,job.coin,now-KEEP).map(r=>({...JSON.parse(r.payload_json),observationReceivedAt:r.received_at}));
    const next = buildObservations(inputs, require('./sqliteStore').eventsFromTrade);
    const old = new Map(db.prepare('SELECT id,payload_json FROM whale_observations WHERE whale_id=? AND coin=?').all(job.whale_id,job.coin).map(r=>[r.id,JSON.parse(r.payload_json)]));
    let changed = false;
    const upsert = db.prepare('INSERT OR REPLACE INTO whale_observations VALUES(?,?,?,?,?)');
    for (const fullEvent of next) {
      const {evidence, ...fields} = fullEvent;
      const evidenceJson=JSON.stringify(evidence);
      const event={...fields,evidenceCount:evidence.length,evidenceHash:createHash('sha256').update(evidenceJson).digest('hex')};
      const previous = old.get(event.id); old.delete(event.id);
      const { revision: _revision, publishedAt: _published, updatedAt: _updated, timing: _timing, ...before } = previous || {};
      if (JSON.stringify(before) === JSON.stringify(event)) continue;
      changed = true;
      const stored = {...event, timing:timingFor(evidence,now), revision:(previous?.revision || 0)+1, publishedAt:previous?.publishedAt || now, updatedAt:now};
      upsert.run(event.id,event.whaleId,event.coin,event.lastAt,JSON.stringify(stored));
      db.prepare('INSERT OR REPLACE INTO observation_evidence VALUES(?,?)').run(event.id,evidenceJson);
    }
    for (const id of old.keys()) { db.prepare('DELETE FROM whale_observations WHERE id=?').run(id); db.prepare('DELETE FROM observation_evidence WHERE event_id=?').run(id); changed=true; }
    db.prepare('DELETE FROM observation_jobs WHERE whale_id=? AND coin=?').run(job.whale_id,job.coin);
    return changed;
  })();
}
function processCollective(db, now=Date.now()) {
  return db.transaction(()=>{
    const events=db.prepare(`SELECT w.payload_json,e.payload_json AS evidence FROM whale_observations w
      JOIN observation_evidence e ON e.event_id=w.id WHERE w.last_at>=? AND json_extract(w.payload_json,'$.type') IN ('build','reverse')`).all(now-DAY-3600000)
      .map(r=>({...JSON.parse(r.payload_json),evidence:JSON.parse(r.evidence)}));
    const next=require('./whaleObservationEngine').buildCollective(events);
    const old=new Map(db.prepare("SELECT id,payload_json FROM whale_observations WHERE whale_id='__collective__'").all().map(r=>[r.id,JSON.parse(r.payload_json)]));
    for(const {evidence,...fields} of next) {
      const json=JSON.stringify(evidence);
      const event={...fields,evidenceCount:evidence.length,evidenceHash:createHash('sha256').update(json).digest('hex')};
      const previous=old.get(event.id);old.delete(event.id);
      const {revision,publishedAt,updatedAt,timing,...before}=previous || {};
      if(JSON.stringify(before)===JSON.stringify(event))continue;
      const stored={...event,timing:timingFor(evidence,now),revision:(revision||0)+1,publishedAt:publishedAt||now,updatedAt:now};
      db.prepare('INSERT OR REPLACE INTO whale_observations VALUES(?,?,?,?,?)').run(event.id,event.whaleId,event.coin,event.lastAt,JSON.stringify(stored));
      db.prepare('INSERT OR REPLACE INTO observation_evidence VALUES(?,?)').run(event.id,json);
    }
    for(const id of old.keys()) {
      db.prepare('DELETE FROM whale_observations WHERE id=?').run(id);
      db.prepare('DELETE FROM observation_evidence WHERE event_id=?').run(id);
    }
  })();
}
function latestPosition(whale,coin,side,eventAt,now) {
  const at=Number(whale?.positionObservedAt)||null;
  const unknown=reason=>({status:'unknown',reason,asOf:at});
  if(!whale||!Array.isArray(whale.positions)||whale.positionScope!=='native-perp'||!at)return unknown('missing');
  if(whale.error)return unknown('error');
  if(at<eventAt)return unknown('before-event');
  if(at>now+60000)return unknown('clock');
  if(now-at>180000)return unknown('stale');
  const positions=whale.positions.filter(p=>p.coin===coin);
  if(positions.some(p=>p.size==null||p.size===''||!Number.isFinite(Number(p.size))||!['long','short'].includes(p.side)))return unknown('invalid');
  const active=positions.filter(p=>Math.abs(Number(p.size))>0);
  if(active.length>1)return unknown('ambiguous');
  if(!active.length)return {status:'flat',asOf:at,size:0};
  const p=active[0];return {status:p.side===side?'same':'opposite',asOf:at,side:p.side,size:Math.abs(Number(p.size))};
}
function list(db, now = Date.now()) {
  const roster=new Map(require('./config').getActiveWhales().map(w=>[String(w.id),w.address]));
  const whales=new Map();
  const current=(id,coin,side,lastAt)=>{
    if(!whales.has(id)) {
      const row=db.prepare('SELECT payload_json FROM whales WHERE id=?').get(id);
      whales.set(id,row?JSON.parse(row.payload_json):null);
    }
    return latestPosition(whales.get(id),coin,side,lastAt,now);
  };
  return db.prepare('SELECT payload_json FROM whale_observations WHERE last_at>=? ORDER BY last_at DESC,id LIMIT 100').all(now-DAY).map(r=>{
    const { evidenceHash, ...summary } = JSON.parse(r.payload_json);
    const address=roster.get(summary.whaleId) || (/^0x[0-9a-f]{40}$/i.test(summary.address) ? summary.address : '');
    if(summary.type==='collective') {
      const members=summary.members.map(m=>({...m,latestPosition:current(m.whaleId,summary.coin,summary.side,summary.lastAt)}));
      const counts={same:0,opposite:0,flat:0,unknown:0};
      for(const member of members)counts[member.latestPosition.status]++;
      return {...summary,address,members,positionCounts:counts};
    }
    return {...summary,address,latestPosition:current(summary.whaleId,summary.coin,summary.side,Math.max(summary.lastAt,summary.tracking?.asOf||0))};
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
module.exports={recordInput,processPair,processCollective,list,evidence,prune,latestPosition};
