const { randomUUID } = require('node:crypto');
const store = require('./whaleObservationStore');
const epoch=randomUUID();
let seq=0, timer, cached=[], signature='', error='', warming=true, seedCursor=null, seeded=false, pruneAt=0;
let collectiveDirty=true, collectiveAt=0;
let collectiveAttemptAt=0, collectiveError='';
const compute=require('./observationCompute').createComputeRunner();
let running=false, generation=0;
let activeJob=null, lastFinishedAt=null, lastDurationMs=null, lastError=null, staleRuns=0, failedRuns=0;
async function calculate(kind,job,isCurrent) {
  const startedAt=Date.now();
  activeJob={kind,whaleId:job?.whale_id||null,coin:job?.coin||null,startedAt};
  try {
    const result=await compute.run(kind,job,{isCurrent});
    if(result.stale)staleRuns++;
    lastError=null;
    return result;
  } catch(err) {
    if(isCurrent()){failedRuns++;lastError=err.message;}
    throw err;
  } finally {
    activeJob=null;lastFinishedAt=Date.now();lastDurationMs=lastFinishedAt-startedAt;
  }
}
function getStatus() {
  return {running,warming,activeJob,lastFinishedAt,lastDurationMs,lastError,collectiveError,staleRuns,failedRuns,
    pendingPairs:require('./db').getDb().prepare('SELECT COUNT(*) AS n FROM observation_jobs').get().n,
    processHeapLimitMb:256,processTimeoutMs:120000};
}
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
async function tick() {
  if(running)return;
  running=true;
  const currentGeneration=generation;
  const isCurrent=()=>generation===currentGeneration;
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
    warming=!seeded || Boolean(db.prepare('SELECT 1 FROM observation_jobs LIMIT 1').get());
    publish(db);
    // At most four pairs per tick; durable jobs survive process restarts.
    // Coalesce bursts for each pair, without postponing less-active addresses behind a hot one.
    const jobs=seeded ? db.prepare(`SELECT j.whale_id,j.coin FROM observation_jobs j
      LEFT JOIN observation_pair_runs r ON r.whale_id=j.whale_id AND r.coin=j.coin
      WHERE COALESCE(r.last_run,0)<=? ORDER BY COALESCE(r.last_run,0),j.rowid LIMIT 4`).all(Date.now()-5000) : [];
    const batchStart=Date.now();
    for(const job of jobs) {
      // Failed or superseded work must also yield its place in the queue.
      // Keep the durable job until a matching version is committed.
      db.prepare('INSERT OR REPLACE INTO observation_pair_runs VALUES(?,?,?)')
        .run(job.whale_id,job.coin,Date.now());
      const result=await calculate('pair',job,isCurrent);
      if(!isCurrent())return;
      if(result.changed)collectiveDirty=true;
      warming=Boolean(db.prepare('SELECT 1 FROM observation_jobs LIMIT 1').get());
      error=collectiveError;
      publish(db);
      if(Date.now()-batchStart>=50)break;
    }
    warming=!seeded || Boolean(db.prepare('SELECT 1 FROM observation_jobs LIMIT 1').get());
    error=collectiveError;
    // Publish pair commits before optional maintenance or collective work.
    publish(db);
    if(Date.now()-pruneAt>60000){
      pruneAt=Date.now();
      if(store.prune(db))collectiveDirty=true;
      try {await calculate('prune',null,isCurrent);}
      catch(err){if(!isCurrent())return;console.warn('[observation-prune]',err.message);}
      if(!isCurrent())return;
    }
    if(seeded && Date.now()-collectiveAttemptAt>=10000 && (collectiveDirty || Date.now()-collectiveAt>=60000)) {
      collectiveAttemptAt=Date.now();
      try {
        const result=await calculate('collective',null,isCurrent);
        if(!isCurrent())return;
        collectiveDirty=result.stale;
        if(!result.stale){collectiveAt=Date.now();collectiveError='';}
      } catch(err) {
        if(!isCurrent())return;
        collectiveDirty=true;
        collectiveError='集体观察暂未更新，单地址结果仍可读取';
        console.warn('[observation-collective]',err.message);
      }
    }
    error=collectiveError;
    publish(db);
  } catch(err) {
    if(!isCurrent())return;
    error='观察数据暂未更新，保留最近结果';
    console.warn('[whale-observations]',err.message);
    seq++; require('./realtimeHub').broadcast(snapshot());
  } finally {running=false;}
}
function start() {
  if(timer || process.env.WHALE_OBSERVATIONS_ENABLED==='0') return;
  generation++;
  require('./db').getDb().prepare('DELETE FROM observation_calculations').run();
  // Re-evaluate retained facts after a deployment; old summaries remain readable
  // while the bounded worker applies current rules and text formatting.
  require('./db').getDb().prepare('INSERT OR IGNORE INTO observation_jobs(whale_id,coin) SELECT DISTINCT whale_id,coin FROM observation_inputs').run();
  const run=async()=>{
    const current=generation;
    await tick();
    if(current!==generation)return;
    timer=setTimeout(run,warming?250:2000);timer.unref?.();
  };
  timer=true;
  run();
}
function stop(){generation++;clearTimeout(timer);timer=undefined;compute.stop();}
module.exports={start,stop,snapshot,tick,getStatus};
