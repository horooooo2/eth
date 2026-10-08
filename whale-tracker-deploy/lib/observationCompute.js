const { fork } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { getDb } = require('./db');
const yieldTurn = () => new Promise(resolve => setImmediate(resolve));

function currentVersion(db, meta) {
  return meta.kind === 'pair'
    ? db.prepare('SELECT version FROM observation_versions WHERE whale_id=? AND coin=?').get(meta.job.whale_id,meta.job.coin)?.version || 0
    : db.prepare('SELECT version FROM observation_summary_version WHERE id=1').get().version;
}
async function applyOutput(outputPath, token, isCurrent = () => true) {
  const output = new Database(outputPath,{readonly:true,fileMustExist:true});
  const db=getDb();
  const meta=JSON.parse(output.prepare('SELECT payload_json FROM metadata').get().payload_json);
  if(meta.kind==='prune') {
    try{return await require('./observationGarbage').applyGarbage(db,output,meta,isCurrent);}
    finally{output.close();}
  }
  const valid=()=>{
    if(!isCurrent())return false;
    if(meta.kind!=='pair')return currentVersion(db,meta)===meta.version;
    const guard=db.prepare('SELECT invalidation FROM observation_input_guards WHERE whale_id=? AND coin=?')
      .get(meta.job.whale_id,meta.job.coin)?.invalidation || 0;
    const previous=db.prepare('SELECT version,window_at FROM observation_committed_versions WHERE whale_id=? AND coin=?')
      .get(meta.job.whale_id,meta.job.coin);
    // Strictly later appends do not alter this complete input prefix. Changes
    // to history (including same-time or out-of-order inserts) still reject it.
    return guard===meta.invalidation && currentVersion(db,meta)>=meta.version &&
      (!previous || (previous.version<=meta.version && previous.window_at<=meta.now));
  };
  let changed=false,committed=false;
  const retired=[];
  const pointer=db.prepare('SELECT payload_json FROM observation_evidence WHERE event_id=?');
  function retire(id) {
    const row=pointer.get(id);
    if(!row)return;
    const marker=JSON.parse(row.payload_json);
    if(marker.format===4)retired.push({id,token:marker.token});
  }
  try {
    if (!valid()) return {stale:true,changed:false};
    const old=new Map((meta.kind==='pair'
      ? db.prepare('SELECT id,payload_json FROM whale_observations WHERE whale_id=? AND coin=?').all(meta.job.whale_id,meta.job.coin)
      : db.prepare("SELECT id,payload_json FROM whale_observations WHERE whale_id='__collective__'").all())
      .map(r=>[r.id,JSON.parse(r.payload_json)]));
    const sameEvent=(previous,event)=>{
      const {revision,publishedAt,updatedAt,timing,...before}=previous||{};
      return JSON.stringify(before)===JSON.stringify(event);
    };
    // Unchanged summaries keep their existing evidence pointer. Importing all
    // their links on every run would create a large stream of disposable rows.
    output.exec('CREATE TEMP TABLE changed_events(id TEXT PRIMARY KEY)');
    const markChanged=output.prepare('INSERT INTO changed_events VALUES(?)');
    output.transaction(()=>{
      for(const row of output.prepare('SELECT * FROM events').all()) {
        if(!sameEvent(old.get(row.id),JSON.parse(row.payload_json).event))markChanged.run(row.id);
      }
    })();
    db.prepare('INSERT INTO observation_calculations VALUES(?,?)').run(token,Date.now());
    const putRow=db.prepare('INSERT OR IGNORE INTO observation_evidence_rows VALUES(?,?)');
    const putBlock=db.prepare('INSERT OR IGNORE INTO observation_evidence_blocks VALUES(?,?)');
    const stageBlock=db.prepare('INSERT OR IGNORE INTO observation_staged_blocks VALUES(?,?)');
    const putLink=db.prepare('INSERT INTO observation_evidence_block_versions VALUES(?,?,?,?)');
    async function pump(statement, write) {
      let batch=[];
      for (const row of statement.iterate()) {
        batch.push(row);
        if (batch.length===256) {
          if (!valid()) return false;
          db.transaction(()=>{for(const item of batch)write(item);})(); batch=[];
          await yieldTurn();
        }
      }
      if (!valid()) return false;
      db.transaction(()=>{for(const item of batch)write(item);})();
      await yieldTurn(); return valid();
    }
    // Pin the immutable blocks first. Their hashes protect existing AND newly
    // imported rows from pruning while the new pointer is still invisible.
    if (!await pump(output.prepare(`SELECT * FROM blocks WHERE hash IN
          (SELECT hash FROM links WHERE event_id IN (SELECT id FROM changed_events))`),r=>{putBlock.run(r.hash,r.hashes_json);stageBlock.run(token,r.hash);}) ||
        // The child already deduplicated these rows. Walking that small set is
        // cheaper than expanding every overlapping block on the API thread;
        // INSERT OR IGNORE writes only new content. An unchanged run skips it.
        !await pump(output.prepare('SELECT * FROM rows WHERE EXISTS (SELECT 1 FROM changed_events)'),r=>putRow.run(r.hash,r.payload_json)) ||
        !await pump(output.prepare('SELECT * FROM links WHERE event_id IN (SELECT id FROM changed_events)'),r=>putLink.run(r.event_id,token,r.ordinal,r.hash))) {
      return {stale:true,changed:false};
    }
    // Evidence is invisible until this short transaction flips its pointer.
    // Compare-and-commit also acknowledges ONLY the version just calculated.
    committed=db.transaction(()=>{
      if (!valid()) return false;
      for (const row of output.prepare('SELECT * FROM events').iterate()) {
        const {event,timing}=JSON.parse(row.payload_json);
        const previous=old.get(event.id); old.delete(event.id);
        const {revision,publishedAt}=previous||{};
        if (sameEvent(previous,event)) continue;
        retire(event.id);
        changed=true;
        const stored={...event,timing,revision:(revision||0)+1,publishedAt:publishedAt||meta.now,updatedAt:meta.now};
        db.prepare('INSERT OR REPLACE INTO whale_observations VALUES(?,?,?,?,?)')
          .run(event.id,event.whaleId,event.coin,event.lastAt,JSON.stringify(stored));
        db.prepare('INSERT OR REPLACE INTO observation_evidence VALUES(?,?)').run(event.id,JSON.stringify({format:4,token}));
      }
      for (const id of old.keys()) {
        retire(id);
        changed=true; db.prepare('DELETE FROM whale_observations WHERE id=?').run(id);
        db.prepare('DELETE FROM observation_evidence WHERE event_id=?').run(id);
      }
      if(meta.kind==='pair') {
        db.prepare('INSERT OR REPLACE INTO observation_committed_versions VALUES(?,?,?,?,?)')
          .run(meta.job.whale_id,meta.job.coin,meta.version,meta.now,meta.throughAt);
        // New appends retain their durable job; acknowledge only this prefix.
        if(currentVersion(db,meta)===meta.version)
          db.prepare('DELETE FROM observation_jobs WHERE whale_id=? AND coin=?').run(meta.job.whale_id,meta.job.coin);
        db.prepare('INSERT OR REPLACE INTO observation_pair_runs VALUES(?,?,?)').run(meta.job.whale_id,meta.job.coin,meta.now);
      }
      return true;
    })();
    return {stale:!committed,changed:committed&&changed};
  } finally {
    db.prepare('DELETE FROM observation_calculations WHERE token=?').run(token);
    output.close();
    const unpin=db.prepare(`DELETE FROM observation_staged_blocks WHERE rowid IN
      (SELECT rowid FROM observation_staged_blocks WHERE token=? LIMIT 256)`);
    while(unpin.run(token).changes)await yieldTurn();
    // Retire only obsolete block links, in bounded transactions. Otherwise a
    // busy append stream can create garbage faster than the minute sweep.
    if(committed) {
      const remove=db.prepare(`DELETE FROM observation_evidence_block_versions WHERE rowid IN
        (SELECT rowid FROM observation_evidence_block_versions WHERE token=? AND event_id=? LIMIT 256)`);
      for(const item of retired)while(remove.run(item.token,item.id).changes)await yieldTurn();
    } else {
      const remove=db.prepare(`DELETE FROM observation_evidence_block_versions WHERE rowid IN
        (SELECT rowid FROM observation_evidence_block_versions WHERE token=? LIMIT 256)`);
      while(remove.run(token).changes)await yieldTurn();
    }
  }
}

function createComputeRunner({ timeoutMs=120000, heapMb=256, maxJobs=32, idleMs=30000 } = {}) {
  let active=null, busy=false, cancellation=0, jobs=0, idleTimer;
  function retire() {
    clearTimeout(idleTimer);
    const child=active;active=null;jobs=0;
    if(!child)return Promise.resolve();
    return new Promise(resolve=>{child.once('close',resolve);child.kill();});
  }
  return {
    async run(kind,job,{isCurrent=()=>true,now=Date.now()}={}) {
      if(busy)throw Error('Observation computation is already running');
      busy=true;clearTimeout(idleTimer);
      const check=isCurrent, startedCancellation=cancellation;
      isCurrent=()=>cancellation===startedCancellation&&check();
      let directory,failed=true,rss=0;
      try {
        directory=await fs.mkdtemp(path.join(os.tmpdir(),'whale-compute-'));
        const output=path.join(directory,'result.db');
        if(!isCurrent())throw Error('Observation computation cancelled');
        if(!active) {
          active=fork(path.join(__dirname,'observationComputeChild.js'),[],{
            execArgv:[`--max-old-space-size=${heapMb}`,'--expose-gc'],stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
          const child=active;
          child.on('error',()=>{});
          child.once('close',()=>{if(active===child){active=null;jobs=0;}});
        }
        const child=active;child.ref();child.channel?.ref();
        await new Promise((resolve,reject)=>{
          const requestId=randomUUID();
          let failure;
          const timer=setTimeout(()=>{failure=Error('Observation computation timed out');child.kill();},timeoutMs);
          const clean=()=>{clearTimeout(timer);child.off('message',onMessage);child.off('close',onClose);child.off('error',onError);};
          const onClose=(code,signal)=>{clean();reject(failure||Error(`Observation process exited (${code??signal})`));};
          const onError=err=>{failure=err;child.kill();};
          const onMessage=value=>{
            if(value?.requestId!==requestId)return;
            // Child closes every SQLite handle before replying, including on error.
            clean();rss=value.rss||0;
            if(value.ok)resolve();else reject(Error(value.error||'Observation computation failed'));
          };
          child.on('message',onMessage);child.once('close',onClose);child.once('error',onError);
          child.send({database:getDb().name,output,kind,job,now,requestId},err=>{if(err)onError(err);});
        });
        jobs++;
        const result=await applyOutput(output,randomUUID(),isCurrent);
        failed=false;return result;
      } finally {
        if(failed||jobs>=maxJobs||rss>heapMb*1024*1024)await retire();
        else if(active) {
          active.unref();active.channel?.unref();
          idleTimer=setTimeout(()=>{void retire();},idleMs);idleTimer.unref?.();
        }
        try {
          if(directory&&path.dirname(directory)===path.resolve(os.tmpdir()))await fs.rm(directory,{recursive:true,force:true});
        } finally {busy=false;}
      }
    },
    stop(){cancellation++;void retire();},
    getStatus(){return {pid:active?.pid||null,completedJobs:jobs,maxJobs,idleMs};},
  };
}
module.exports={createComputeRunner,applyOutput};
