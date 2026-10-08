const {observationsEnabled}=require('./featureFlags');
const { randomUUID } = require('node:crypto');
const store = require('./whaleObservationStore');
const scope = require('./observationScope');
let watched=[], selected=[], scopeKey='';
const RULES_KEY=JSON.stringify([require('./whaleObservationEngine').POLICY,2]);
function refreshScope(db) {
  watched=scope.coins(db);
  selected=scope.retainedCoins(db,watched);
  const next=JSON.stringify([RULES_KEY,watched]);
  if(next===scopeKey)return false;
  db.transaction(()=>{
    const stored=require('./db').getMeta('observation_scope_rules_v2')?.value;
    if(stored!==next) {
      let previous;
      try{previous=JSON.parse(stored);}catch{}
      const rebuild=Array.isArray(previous)&&previous[0]===RULES_KEY&&Array.isArray(previous[1])
        ? selected.filter(coin=>!scope.matches(coin,previous[1])) : selected;
      db.prepare(`INSERT OR IGNORE INTO observation_jobs(whale_id,coin)
        SELECT whale_id,coin FROM observation_versions WHERE coin IN (SELECT value FROM json_each(?))`).run(JSON.stringify(rebuild));
      require('./db').setMeta('observation_scope_rules_v2',next);
    }
  })();
  scopeKey=next;collectiveDirty=true;
  return true;
}
let pendingPairs = null, pendingPairsObservedAt = null;
function pendingCount(db) {
  pendingPairs = db.prepare('SELECT COUNT(*) AS n FROM observation_jobs WHERE coin IN (SELECT value FROM json_each(?))').get(JSON.stringify(selected)).n;
  pendingPairsObservedAt = Date.now();
  return pendingPairs;
}
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
  if(!observationsEnabled())return {enabled:false,running:false,warming:false,process:compute.getStatus()};
  return {running,warming,activeJob,lastFinishedAt,lastDurationMs,lastError,collectiveError,staleRuns,failedRuns,
    pendingPairs,pendingPairsObservedAt,watchedCoins:watched,
    processHeapLimitMb:256,processTimeoutMs:120000,process:compute.getStatus()};
}
function snapshot(coins = ['BTC','ETH']) {
  if(!observationsEnabled())return {type:'observationSnapshot',epoch,seq,enabled:false,rows:[],warming:false,error:'',asOf:Date.now(),windowHours:24};
  return {type:'observationSnapshot',epoch,seq,rows:cached.filter(row=>scope.matches(row.coin,coins)).slice(0,50),error,warming,asOf:Date.now(),windowHours:24};
}
function publish(db) {
  // Each user's 50-record window is selected before merging the shared cache.
  const lists=new Map(scope.watchlists(db).map(coins=>[JSON.stringify([...coins].sort()),coins]));
  const unique=new Map();
  for(const coins of lists.values())for(const row of store.list(db,Date.now(),coins))unique.set(row.id,row);
  const rows=[...unique.values()].sort((a,b)=>b.lastAt-a.lastAt||a.id.localeCompare(b.id));
  const next=JSON.stringify([rows,error,warming]);
  if (next===signature) return;
  signature=next; cached=rows; seq++;
  require('./realtimeHub').broadcastObservations();
}
async function tick() {
  if(!observationsEnabled()||running)return;
  running=true;
  const currentGeneration=generation;
  const isCurrent=()=>generation===currentGeneration;
  try {
    const db=require('./db').getDb();
    const scopeChanged=refreshScope(db);
    if (!seeded && require('./db').getMeta('observation_seeded_v1')?.value === '1') seeded=true;
    if (!seeded) {
      const rows=seedCursor
        ? db.prepare('SELECT id,time,payload_json FROM fills WHERE time>=? AND (time,id)>(?,?) ORDER BY time,id LIMIT 1000').all(Date.now()-7*86400000,seedCursor.time,seedCursor.id)
        : db.prepare('SELECT id,time,payload_json FROM fills WHERE time>=? ORDER BY time,id LIMIT 1000').all(Date.now()-7*86400000);
      db.transaction(()=>{for(const r of rows) store.recordInput(db,JSON.parse(r.payload_json));})();
      if(rows.length) seedCursor=rows.at(-1);
      if(rows.length<1000) {seeded=true;require('./db').setMeta('observation_seeded_v1','1');}
    }
    warming=!seeded || pendingCount(db)>0;
    if(!signature||scopeChanged)publish(db);
    // At most four pairs per tick; durable jobs survive process restarts.
    // Coalesce bursts for each pair, without postponing less-active addresses behind a hot one.
    const jobs=seeded ? db.prepare(`SELECT j.whale_id,j.coin FROM observation_jobs j
      LEFT JOIN observation_pair_runs r ON r.whale_id=j.whale_id AND r.coin=j.coin
      WHERE COALESCE(r.last_run,0)<=? AND j.coin IN (SELECT value FROM json_each(?))
      ORDER BY COALESCE(r.last_run,0),j.rowid LIMIT 4`).all(Date.now()-5000,JSON.stringify(selected)) : [];
    const batchStart=Date.now();
    for(const job of jobs) {
      // Failed or superseded work must also yield its place in the queue.
      // Keep the durable job until a matching version is committed.
      db.prepare('INSERT OR REPLACE INTO observation_pair_runs VALUES(?,?,?)')
        .run(job.whale_id,job.coin,Date.now());
      const result=await calculate('pair',job,isCurrent);
      if(!isCurrent())return;
      if(result.changed)collectiveDirty=true;
      if(Date.now()-batchStart>=50)break;
    }
    warming=!seeded || pendingCount(db)>0;
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
        const result=await calculate('collective',{coins:selected},isCurrent);
        if(!isCurrent())return;
        collectiveDirty=result.stale;
        if(!result.stale){collectiveAt=Date.now();collectiveError='';}
      } catch(err) {
        if(!isCurrent())return;
        collectiveDirty=true;
        collectiveError='集体观察暂未更新，单地址结果仍可读取';
        console.warn('[observation-collective]',err.message);
      }
      error=collectiveError;
      publish(db);
    }
  } catch(err) {
    if(!isCurrent())return;
    error='观察数据暂未更新，保留最近结果';
    console.warn('[whale-observations]',err.message);
    seq++; require('./realtimeHub').broadcastObservations();
  } finally {running=false;}
}
function start() {
  if(timer || !observationsEnabled()) return;
  generation++;
  if(require('./db').getMeta('observation_paused')?.value==='1'){
    seeded=false;seedCursor=null;require('./db').setMeta('observation_seeded_v1','0');require('./db').setMeta('observation_paused','0');
  }
  require('./db').getDb().prepare('DELETE FROM observation_calculations').run();
  // Durable input jobs already survive restart. Rebuild only on scope/rule changes.
  scopeKey='';
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
