const test=require('node:test');
const assert=require('node:assert/strict');
require('./helpers/isolateSqlite');
const {getDb}=require('../lib/db');
const store=require('../lib/whaleObservationStore');
const {createComputeRunner}=require('../lib/observationCompute');
const now=Math.floor(Date.now()/3600000)*3600000-30*60000;
function seed(id,count=3) {
  const db=getDb();
  db.transaction(()=>{
    for(let i=0;i<count;i++)store.recordInput(db,{id:`${id}-${i}`,whaleId:id,asset:'BTC',side:'buy',
      startPosition:i*2,amount:2,price:100000,time:now-count*300000+i*300000,address:'0x'+'a'.repeat(40)},now);
  })();
  return {whale_id:id,coin:'BTC'};
}
function summary(id) {
  return getDb().prepare('SELECT payload_json FROM whale_observations WHERE whale_id=? ORDER BY id').all(id).map(r=>JSON.parse(r.payload_json));
}
test('isolated pair and collective match the synchronous baseline, including ordered evidence',async()=>{
  const db=getDb(),runner=createComputeRunner();
  for(const id of ['match-a','match-b','match-c']) {
    const job=seed(id);
    // Collective identity must refer to three distinct addresses.
    db.prepare('UPDATE observation_inputs SET payload_json=json_set(payload_json,\'$.address\',?) WHERE whale_id=?')
      .run('0x'+String(['match-a','match-b','match-c'].indexOf(id)+1).repeat(40),id);
    store.processPair(db,job,now);
    const expected=summary(id);
    const evidence=store.evidence(db,expected[0].id,0);
    db.prepare('DELETE FROM whale_observations WHERE whale_id=?').run(id);
    db.prepare('DELETE FROM observation_evidence WHERE event_id=?').run(expected[0].id);
    assert.deepEqual(await runner.run('pair',job,{now}),{stale:false,changed:true});
    assert.deepEqual(summary(id),expected);
    assert.deepEqual(store.evidence(db,expected[0].id,0),evidence);
    const links=db.prepare('SELECT COUNT(*) AS n FROM observation_evidence_block_versions').get().n;
    const staged=db.prepare('SELECT COUNT(*) AS n FROM observation_staged_rows').get().n;
    assert.deepEqual(await runner.run('pair',job,{now}),{stale:false,changed:false});
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM observation_evidence_block_versions').get().n,links);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM observation_staged_rows').get().n,staged);
  }
  store.processCollective(db,now);
  const expected=summary('__collective__');assert.equal(expected.length,1);
  const evidence=store.evidence(db,expected[0].id,0);
  db.prepare("DELETE FROM whale_observations WHERE whale_id='__collective__'").run();
  db.prepare('DELETE FROM observation_evidence WHERE event_id=?').run(expected[0].id);
  await runner.run('collective',null,{now});
  assert.deepEqual(summary('__collective__'),expected);
  assert.deepEqual(store.evidence(db,expected[0].id,0),evidence);
});

test('correction after the input snapshot rejects stale output and preserves durable work',async()=>{
  const db=getDb(),job=seed('correction'),runner=createComputeRunner();
  store.processPair(db,job,now); const before=summary(job.whale_id);
  let calls=0;
  const result=await runner.run('pair',job,{now,isCurrent:()=>{
    if(++calls===2) {
      const trade=JSON.parse(db.prepare('SELECT payload_json FROM observation_inputs WHERE whale_id=? LIMIT 1').get(job.whale_id).payload_json);
      store.recordInput(db,{...trade,price:1},now);
    }
    return true;
  }});
  assert.equal(result.stale,true);assert.deepEqual(summary(job.whale_id),before);
  assert.ok(db.prepare('SELECT 1 FROM observation_jobs WHERE whale_id=?').get(job.whale_id));
  await runner.run('pair',job,{now});
  assert.equal(summary(job.whale_id).length,0);
  assert.equal(db.prepare('SELECT 1 FROM observation_jobs WHERE whale_id=?').get(job.whale_id),undefined);
});

test('cancelled computation and child timeout leave work recoverable by a new runner',async()=>{
  const db=getDb(),job=seed('retry');
  await assert.rejects(createComputeRunner({timeoutMs:1}).run('pair',job,{now}),/timed out|exited/);
  assert.ok(db.prepare('SELECT 1 FROM observation_jobs WHERE whale_id=?').get(job.whale_id));
  await assert.rejects(createComputeRunner().run('pair',job,{now,isCurrent:()=>false}),/cancelled/);
  await createComputeRunner().run('pair',job,{now});
  assert.equal(summary(job.whale_id).length,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM observation_calculations').get().n,0);
});

test('large evidence staging yields, stays invisible and survives concurrent pruning',async()=>{
  const db=getDb(),id='large',job={whale_id:id,coin:'BTC'};
  db.transaction(()=>{
    for(let i=0;i<3000;i++)store.recordInput(db,{id:`${id}-${i}`,whaleId:id,asset:'BTC',side:'buy',
      startPosition:i,amount:1,price:10000,time:now-3000*10000+i*10000},now);
  })();
  let ticks=0,staged=false,checks=0;
  const timer=setInterval(()=>ticks++,1);
  try {
    const result=await createComputeRunner().run('pair',job,{now,isCurrent:()=>{
      if(++checks>3 && !staged) {
        staged=true;
        assert.equal(summary(id).length,0);
        store.prune(db,now);
      }
      return true;
    }});
    assert.equal(result.changed,true);assert.ok(ticks>0);assert.ok(staged);
    const rows=summary(id);assert.ok(rows.length>0);
    for(const row of rows) {
      const actual=[...require('../lib/observationEvidence').readEvidence(db,row.id)];
      assert.equal(actual.length,row.evidenceCount);
      assert.equal(require('../lib/observationEvidence').encodeEvidence(actual).hash,row.evidenceHash);
    }
  }finally{clearInterval(timer);}
});

test('correction during evidence staging preserves the complete old revision and retries safely',async()=>{
  const db=getDb(),job=seed('during-stage',600),runner=createComputeRunner();
  await runner.run('pair',job,{now});
  const before=summary(job.whale_id), evidence=store.evidence(db,before[0].id,0);
  db.prepare('UPDATE observation_inputs SET payload_json=json_set(payload_json,\'$.price\',200000) WHERE whale_id=?').run(job.whale_id);
  let interrupted=false;
  const result=await runner.run('pair',job,{now,isCurrent:()=>{
    const staged=db.prepare(`SELECT 1 FROM observation_evidence_block_versions l
      JOIN observation_calculations c ON c.token=l.token LIMIT 1`).get();
    if(staged&&!interrupted) {
      interrupted=true;
      store.recordInput(db,{id:'during-stage-new',whaleId:job.whale_id,asset:'BTC',side:'buy',
        startPosition:1200,amount:2,price:200000,time:now-1000000},now);
    }
    return true;
  }});
  assert.ok(interrupted);assert.equal(result.stale,true);
  assert.deepEqual(summary(job.whale_id),before);
  assert.deepEqual(store.evidence(db,before[0].id,0),evidence);
  assert.ok(db.prepare('SELECT 1 FROM observation_jobs WHERE whale_id=?').get(job.whale_id));
  store.prune(db,now);
  assert.deepEqual(store.evidence(db,before[0].id,0),evidence);
  await runner.run('pair',job,{now});
  assert.equal(summary(job.whale_id)[0].revision,2);
  assert.equal(db.prepare('SELECT 1 FROM observation_jobs WHERE whale_id=?').get(job.whale_id),undefined);
});

test('a failed pair yields its queue position and monitor exposes the remaining backlog',async()=>{
  const db=getDb();db.prepare('DELETE FROM observation_jobs').run();
  const bad=seed('bad-queue'),good=seed('good-queue');
  db.prepare("UPDATE observation_inputs SET payload_json='invalid-json' WHERE whale_id=?").run(bad.whale_id);
  const worker=require('../lib/whaleObservationWorker'),hub=require('../lib/realtimeHub'),original=hub.broadcast;
  hub.broadcast=()=>{};
  try {
    await worker.tick();
    assert.equal(worker.getStatus().failedRuns,1);
    await worker.tick();
    assert.equal(summary(good.whale_id).length,1);
    assert.equal(worker.getStatus().pendingPairs,1);
    assert.equal(worker.getStatus().warming,true);
    assert.equal(require('../lib/opsMonitor').getMonitorSnapshot().observationCompute.pendingPairs,1);
  }finally{worker.stop();hub.broadcast=original;}
});

test('stopping after the child exits also cancels an in-progress evidence import',async()=>{
  const db=getDb(),job=seed('stop-stage',600),runner=createComputeRunner();
  let stopped=false;
  const result=await runner.run('pair',job,{now,isCurrent:()=>{
    if(!stopped&&db.prepare(`SELECT 1 FROM observation_evidence_block_versions l
      JOIN observation_calculations c ON c.token=l.token LIMIT 1`).get()) {
      stopped=true;runner.stop();
    }
    return true;
  }});
  assert.ok(stopped);assert.equal(result.stale,true);
  assert.equal(summary(job.whale_id).length,0);
  assert.ok(db.prepare('SELECT 1 FROM observation_jobs WHERE whale_id=?').get(job.whale_id));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM observation_calculations').get().n,0);
  await runner.run('pair',job,{now});
  assert.ok(summary(job.whale_id).length>0);
});

test('continuous strictly later appends publish complete prefixes and retain newer work',async()=>{
  const db=getDb(),job=seed('continuous'),runner=createComputeRunner();
  for(let i=0;i<3;i++) {
    const captured=db.prepare('SELECT version FROM observation_versions WHERE whale_id=? AND coin=?').get(job.whale_id,job.coin).version;
    let calls=0;
    const result=await runner.run('pair',job,{now,isCurrent:()=>{
      if(++calls===2)store.recordInput(db,{id:`continuous-new-${i}`,whaleId:job.whale_id,asset:'BTC',side:'buy',
        startPosition:6+i,amount:1,price:100000,time:now+i*1000},now);
      return true;
    }});
    assert.equal(result.stale,false);assert.equal(result.changed,true);
    assert.ok(summary(job.whale_id).length>0);
    assert.equal(db.prepare('SELECT version FROM observation_committed_versions WHERE whale_id=?').get(job.whale_id).version,captured);
    const visible=store.list(db,now).find(r=>r.whaleId===job.whale_id);
    assert.equal(visible.calculation.inputVersion,captured);
    assert.equal(visible.calculation.pendingUpdates,true);
    assert.ok(db.prepare('SELECT 1 FROM observation_jobs WHERE whale_id=?').get(job.whale_id));
  }
  await runner.run('pair',job,{now});
  assert.equal(db.prepare('SELECT 1 FROM observation_jobs WHERE whale_id=?').get(job.whale_id),undefined);
  assert.equal(store.list(db,now).find(r=>r.whaleId===job.whale_id).calculation.pendingUpdates,false);
  const before=summary(job.whale_id);
  assert.equal(store.processPair(db,job,now),false);assert.deepEqual(summary(job.whale_id),before);
});

test('a previously computed prefix cannot overwrite a newer committed prefix',async()=>{
  const db=getDb(),job=seed('version-order'),runner=createComputeRunner();
  const version=db.prepare('SELECT version FROM observation_versions WHERE whale_id=?').get(job.whale_id).version;
  const invalidation=db.prepare('SELECT invalidation FROM observation_input_guards WHERE whale_id=?').get(job.whale_id).invalidation;
  store.recordInput(db,{id:'version-order-extra',whaleId:job.whale_id,asset:'BTC',side:'buy',
    startPosition:6,amount:1,price:100000,time:now},now);
  await runner.run('pair',job,{now});const before=summary(job.whale_id);
  const Database=require('better-sqlite3'),path=require('node:path');
  const outputPath=path.join(require('./helpers/isolateSqlite').dir,'old-prefix.db');
  const output=new Database(outputPath);output.exec('CREATE TABLE metadata(payload_json TEXT)');
  output.prepare('INSERT INTO metadata VALUES(?)').run(JSON.stringify({kind:'pair',job,version,invalidation,now}));output.close();
  assert.equal((await require('../lib/observationCompute').applyOutput(outputPath,'old-prefix-token')).stale,true);
  assert.deepEqual(summary(job.whale_id),before);
});

test('late and same-time inserts invalidate a snapshot; deleting facts does too',async()=>{
  const db=getDb(),runner=createComputeRunner();
  for(const mode of ['late','same-time','delete']) {
    const job=seed(`invalidate-${mode}`);await runner.run('pair',job,{now});
    const before=summary(job.whale_id);let calls=0;
    const result=await runner.run('pair',job,{now,isCurrent:()=>{
      if(++calls===2) {
        if(mode==='delete')db.prepare('DELETE FROM observation_inputs WHERE whale_id=?').run(job.whale_id);
        else store.recordInput(db,{id:`${mode}-extra`,whaleId:job.whale_id,asset:'BTC',side:'buy',startPosition:4,
          amount:1,price:100000,time:now-(mode==='late'?400000:300000)},now);
      }
      return true;
    }});
    assert.equal(result.stale,true);assert.deepEqual(summary(job.whale_id),before);
    assert.ok(db.prepare('SELECT 1 FROM observation_jobs WHERE whale_id=?').get(job.whale_id));
  }
});
