const { randomUUID } = require('node:crypto');
const store = require('./whaleObservationStore');
const epoch=randomUUID();
let seq=0, timer, cached=[], signature='', error='', warming=true, seedCursor=null, seeded=false, pruneAt=0;
let collectiveDirty=true, collectiveAt=0;
function snapshot() {
  return {type:'observationSnapshot',epoch,seq,rows:cached,error,warming,asOf:Date.now(),windowHours:24};
}
function publish(db) {
  const rows=store.list(db), next=JSON.stringify([rows,error,warming]);
  if (next===signature) return;
  const old=new Map(cached.map(row=>[row.id,JSON.stringify(row)]));
  signature=next; cached=rows; seq++;
  // Ordered ids bound the client to the current 100-record window; only changed
  // summaries travel over the socket. A fresh connection always receives a snapshot.
  require('./realtimeHub').broadcast({type:'observationCommit',epoch,seq,
    rows:rows.filter(row=>old.get(row.id)!==JSON.stringify(row)),ids:rows.map(row=>row.id),
    error,warming,asOf:Date.now(),windowHours:24});
}
function tick() {
  try {
    const db=require('./db').getDb();
    if (!seeded && require('./db').getMeta('observation_seeded_v1')?.value === '1') seeded=true;
    if (!seeded) {
      const rows=seedCursor
        ? db.prepare('SELECT id,time,payload_json FROM fills WHERE time>=? AND (time,id)>(?,?) ORDER BY time,id LIMIT 1000').all(Date.now()-7*86400000,seedCursor.time,seedCursor.id)
        : db.prepare('SELECT id,time,payload_json FROM fills WHERE time>=? ORDER BY time,id LIMIT 1000').all(Date.now()-7*86400000);
      db.transaction(()=>{for(const r of rows) store.recordInput(db,JSON.parse(r.payload_json));})();
      if(rows.length) seedCursor=rows.at(-1);
      if(rows.length<1000) {seeded=true;require('./db').setMeta('observation_seeded_v1','1');}
    }
    // At most four pairs per tick; durable jobs survive process restarts.
    // Coalesce bursts for each pair, without postponing less-active addresses behind a hot one.
    const jobs=seeded ? db.prepare(`SELECT j.whale_id,j.coin FROM observation_jobs j
      LEFT JOIN observation_pair_runs r ON r.whale_id=j.whale_id AND r.coin=j.coin
      WHERE COALESCE(r.last_run,0)<=? ORDER BY COALESCE(r.last_run,0),j.rowid LIMIT 4`).all(Date.now()-5000) : [];
    const batchStart=Date.now();
    for(const job of jobs) {if(store.processPair(db,job))collectiveDirty=true;if(Date.now()-batchStart>=50)break;}
    warming=!seeded || Boolean(db.prepare('SELECT 1 FROM observation_jobs LIMIT 1').get());
    error='';
    if(Date.now()-pruneAt>60000){store.prune(db);pruneAt=Date.now();}
    if(seeded && ((collectiveDirty && Date.now()-collectiveAt>=10000) || Date.now()-collectiveAt>=60000)) {
      store.processCollective(db);collectiveDirty=false;collectiveAt=Date.now();
    }
    publish(db);
  } catch(err) {
    error='观察数据暂未更新，保留最近结果';
    console.warn('[whale-observations]',err.message);
    seq++; require('./realtimeHub').broadcast(snapshot());
  }
}
function start() {
  if(timer || process.env.WHALE_OBSERVATIONS_ENABLED==='0') return;
  // Re-evaluate retained facts after a deployment; old summaries remain readable
  // while the bounded worker applies current rules and text formatting.
  require('./db').getDb().prepare('INSERT OR IGNORE INTO observation_jobs(whale_id,coin) SELECT DISTINCT whale_id,coin FROM observation_inputs').run();
  const run=()=>{tick();timer=setTimeout(run,warming?250:2000);timer.unref?.();};
  run();
}
function stop(){clearTimeout(timer);timer=undefined;}
module.exports={start,stop,snapshot,tick};
