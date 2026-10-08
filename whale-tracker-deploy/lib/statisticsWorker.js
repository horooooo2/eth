const {randomUUID}=require('node:crypto');
const {createStatisticsRunner}=require('./statisticsCompute');
const {selectResonanceSignals,DEFAULT_RESONANCE_CONFIG}=require('./resonanceEngine');
const KEYS=['direction:15m','direction:1h','direction:4h','direction:24h',...['2','4','6','12','24'].map(w=>'resonance:'+w)];
const yieldTurn=()=>new Promise(resolve=>setImmediate(resolve));

function createStatisticsWorker({getDb=()=>require('./db').getDb(),getRoster=()=>require('./config').getActiveWhales().map(w=>String(w.id)),
  runner=createStatisticsRunner(),now=Date.now,minIntervalMs=5000,maxAgeMs=10000}={}) {
  let timer,running=false,generation=0,hydrated=false,frames=new Map(),meta=null;
  let lastAttemptAt=null,lastDurationMs=null,error='',attempts=0;
  function context() {
    const roster=[...new Set(getRoster())].sort();
    return {roster,rosterKey:JSON.stringify([1,DEFAULT_RESONANCE_CONFIG,roster])};
  }
  const version=()=>getDb().prepare('SELECT version FROM statistics_input_version WHERE id=1').get().version;
  function decodeFrame(row) {
    const value=JSON.parse(row.payload_json);
    if(row.key.startsWith('direction:')) {
      if(!Array.isArray(value.coins)||!Array.isArray(value.accounts))throw Error('Invalid persisted direction summary');
      return row.payload_json;
    }
    if(!Array.isArray(value.signals))throw Error('Invalid persisted resonance summary');
    return value;
  }
  async function cleanup(db) {
    // Failed stages and retired batches are invisible, and are reclaimed one
    // result at a time instead of deleting a large payload transaction at once.
    const remove=db.prepare(`DELETE FROM statistics_results WHERE (batch_id,key) IN (
      SELECT batch_id,key FROM statistics_results WHERE batch_id NOT IN (SELECT batch_id FROM statistics_current) LIMIT 1)`);
    while(remove.run().changes)await yieldTurn();
    db.exec('DELETE FROM statistics_batches WHERE id NOT IN (SELECT batch_id FROM statistics_current)');
  }
  async function hydrate(db,ctx,isCurrent) {
    try {
      const stored=db.prepare(`SELECT b.* FROM statistics_batches b JOIN statistics_current c ON c.batch_id=b.id WHERE c.id=1`).get();
      if(stored&&stored.roster_key===ctx.rosterKey) {
        const rows=db.prepare('SELECT key,payload_json FROM statistics_results WHERE batch_id=?').all(stored.id);
        if(rows.length===KEYS.length&&KEYS.every(key=>rows.some(row=>row.key===key))) {
          const next=new Map();
          for(const row of rows) {
            next.set(row.key,decodeFrame(row));
            await yieldTurn();if(!isCurrent())return;
          }
          frames=next;meta={version:stored.version,asOf:stored.as_of,rosterKey:stored.roster_key};
        }
      }
    } catch(err) {
      // Derived-cache damage must not prevent rebuilding from authoritative fills.
      if(isCurrent()){error=err.message;require('./opsMonitor').pushError({source:'statistics-cache',message:err.message});}
    }
    if(isCurrent())hydrated=true;
  }
  async function tick() {
    if(running)return;
    running=true;const current=generation,isCurrent=()=>current===generation;
    let stage,didRun=false;
    try {
      const db=getDb(),ctx=context();
      if(!hydrated)await hydrate(db,ctx,isCurrent);
      if(!isCurrent())return;
      const inputVersion=version();
      if(lastAttemptAt!==null&&now()-lastAttemptAt<minIntervalMs)return;
      if(meta&&meta.version===inputVersion&&meta.rosterKey===ctx.rosterKey&&now()-meta.asOf<maxAgeMs&&!error)return;
      lastAttemptAt=now();attempts++;didRun=true;
      const result=await runner.run({database:db.name,...ctx,now:now(),retentionMs:require('./db').FILL_RETENTION_MS});
      if(!isCurrent()||context().rosterKey!==ctx.rosterKey)return;
      const {meta:nextMeta,rows}=result;
      if(nextMeta.rosterKey!==ctx.rosterKey||rows.length!==KEYS.length||!KEYS.every(key=>rows.some(row=>row.key===key)))throw Error('Incomplete statistics batch');
      if(meta&&(nextMeta.version<meta.version||nextMeta.asOf<meta.asOf))return;
      // Validate final summaries only, one window per event-loop turn.
      const next=new Map();
      stage=randomUUID();
      db.prepare('INSERT INTO statistics_batches VALUES(?,?,?,?)').run(stage,nextMeta.version,nextMeta.asOf,nextMeta.rosterKey);
      const put=db.prepare('INSERT INTO statistics_results VALUES(?,?,?)');
      for(const row of rows) {
        const value=decodeFrame(row);
        next.set(row.key,value);put.run(stage,row.key,row.payload_json);
        await yieldTurn();if(!isCurrent())return;
      }
      if(context().rosterKey!==ctx.rosterKey)return;
      // Strictly newer facts do not starve publication: publish this coherent
      // snapshot and expose pendingUpdates until the next complete batch.
      db.prepare('INSERT OR REPLACE INTO statistics_current VALUES(1,?)').run(stage);
      frames=next;meta=nextMeta;error='';stage=null;
      try {await cleanup(db);}
      catch(err){require('./opsMonitor').pushError({source:'statistics-cleanup',message:err.message});}
    } catch(err) {
      if(isCurrent()) {
        error=err.message;
        require('./opsMonitor').pushError({source:'statistics-worker',message:err.message});
        console.warn('[statistics-worker]',err.message);
      }
    } finally {
      // A cancelled generation cannot publish; its private stage is safe to drop.
      try {
        if(stage) {
          const db=getDb();
          const remove=db.prepare('DELETE FROM statistics_results WHERE batch_id=? AND key IN (SELECT key FROM statistics_results WHERE batch_id=? LIMIT 1)');
          while(remove.run(stage,stage).changes)await yieldTurn();
          db.prepare('DELETE FROM statistics_batches WHERE id=?').run(stage);
        }
      } catch(err) {require('./opsMonitor').pushError({source:'statistics-cleanup',message:err.message});}
      finally {if(didRun)lastDurationMs=now()-lastAttemptAt;running=false;}
    }
  }
  function freshness() {
    const inputVersion=version();
    return {asOf:meta?.asOf||null,inputVersion:meta?.version??null,currentInputVersion:inputVersion,
      pendingUpdates:!meta||meta.version!==inputVersion,refreshing:running,
      stale:!meta||now()-meta.asOf>15000||Boolean(error),error:error?(meta?'统计暂未更新，保留最近完整结果':'统计暂未生成，请稍后重试'):null};
  }
  function ready(key) {
    const value=frames.get(key);
    if(value===undefined||meta?.rosterKey!==context().rosterKey) {
      const err=Error('统计正在预计算，请稍后重试');err.status=503;throw err;
    }
    return value;
  }
  function direction(window) {
    const raw=ready('direction:'+window);
    const extra={statistics:freshness(),basis:'stored-executions',coverage:'locally-observed',executionCoverage:require('./fillBackfill').getCoverageStatus()};
    return raw.slice(0,-1)+','+JSON.stringify(extra).slice(1);
  }
  function resonance(window,watched) {
    const completed=ready('resonance:'+window);
    return {...selectResonanceSignals(completed.signals,watched),updatedAt:meta.asOf,statistics:freshness(),
      basis:'stored-executions',coverage:'locally-observed',executionCoverage:require('./fillBackfill').getCoverageStatus()};
  }
  function start() {
    if(timer)return;
    const current=++generation;
    const run=async()=>{
      try {await tick();}
      catch(err){console.warn('[statistics-worker]',err.message);}
      finally {if(current===generation){timer=setTimeout(run,1000);timer.unref?.();}}
    };
    timer=true;void run();
  }
  function stop(){generation++;clearTimeout(timer);timer=undefined;runner.stop();}
  function invalidate(){const restart=Boolean(timer);stop();frames=new Map();meta=null;hydrated=false;lastAttemptAt=null;error='';if(restart)start();}
  return {tick,start,stop,invalidate,direction,resonance,getStatus:()=>({running,warming:!meta||meta.rosterKey!==context().rosterKey,lastAttemptAt,lastDurationMs,attempts,...freshness(),processHeapLimitMb:256,processTimeoutMs:60000})};
}
const worker=createStatisticsWorker();
module.exports={...worker,createStatisticsWorker};
