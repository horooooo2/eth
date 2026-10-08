const test=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
require('./helpers/isolateSqlite');
const {getDb}=require('../lib/db');
const store=require('../lib/whaleObservationStore');
const {buildObservations}=require('../lib/whaleObservationEngine');
const {eventsFromTrade}=require('../lib/sqliteStore');
const {readEvidence,readTriggerEvidence,encodeEvidence}=require('../lib/observationEvidence');
const {createComputeRunner}=require('../lib/observationCompute');
const now=Date.now(),job={whale_id:'block-observer',coin:'BTC'};
function trade(i,extra={}) {
  return {id:`block-${i}`,whaleId:job.whale_id,asset:'BTC',side:'buy',startPosition:i,
    amount:1,price:10000,time:now-(700-i)*60000,...extra};
}
function baseline() {
  const inputs=getDb().prepare('SELECT payload_json,received_at FROM observation_inputs WHERE whale_id=? ORDER BY time,id').all(job.whale_id)
    .map(r=>({...JSON.parse(r.payload_json),observationReceivedAt:r.received_at}));
  return buildObservations(inputs,eventsFromTrade);
}
function verify() {
  const expected=baseline(),db=getDb();
  const actual=db.prepare('SELECT payload_json FROM whale_observations WHERE whale_id=? ORDER BY last_at DESC,id').all(job.whale_id)
    .map(r=>JSON.parse(r.payload_json));
  assert.equal(actual.length,expected.length);
  for(let i=0;i<expected.length;i++) {
    const {evidence,...fields}=expected[i];
    const {revision,publishedAt,updatedAt,timing,...stored}=actual[i];
    assert.deepEqual(stored,{...fields,evidenceCount:evidence.length,evidenceHash:encodeEvidence(evidence).hash});
    assert.deepEqual([...readEvidence(db,fields.id)],evidence);
  }
  return expected;
}
function counts() {
  return getDb().prepare(`SELECT (SELECT COUNT(*) FROM observation_evidence_blocks) blocks,
    (SELECT COUNT(*) FROM observation_evidence_rows) rows,
    (SELECT COUNT(*) FROM observation_evidence_block_versions) links,
    (SELECT COUNT(*) FROM observation_staged_blocks) pins`).get();
}
function blockHashes(id) {
  return getDb().prepare(`SELECT l.ordinal,l.hash FROM observation_evidence_block_versions l
    JOIN observation_evidence e ON json_extract(e.payload_json,'$.token')=l.token AND e.event_id=l.event_id
    WHERE l.event_id=? ORDER BY l.ordinal`).all(id);
}
test('block pages preserve order at boundaries and out-of-range offsets',async()=>{
  const db=getDb();db.transaction(()=>{for(let i=0;i<700;i++)store.recordInput(db,trade(i),now);})();
  await createComputeRunner().run('pair',job,{now});
  const expected=verify(),event=expected.find(r=>r.evidence.length===700);assert.ok(event);
  for(const offset of [0,50,127,128,129,255,256,699,700,701]) {
    assert.deepEqual([...readEvidence(db,event.id,offset,50)],event.evidence.slice(offset,offset+50));
  }
  assert.deepEqual([...readEvidence(db,event.id,128,0)],[]);
  assert.deepEqual([...readEvidence(db,event.id,129)],event.evidence.slice(129));
  assert.deepEqual([...readTriggerEvidence(db,event.id,event.lastAt)],event.evidence.filter(r=>r.time<=event.lastAt));
  const current=counts();assert.equal(current.pins,0);
  assert.ok(current.links<expected.reduce((n,r)=>n+r.evidence.length,0)/50);
});
test('append reuses full blocks; corrections, late inputs and deletions match full rebuilds',async()=>{
  const db=getDb(),runner=createComputeRunner(),before=baseline().find(r=>r.evidence.length===700);
  const oldHashes=blockHashes(before.id),countBefore=counts();
  store.recordInput(db,trade(700),now);await runner.run('pair',job,{now});
  const expected=verify(),countAfter=counts(),newHashes=blockHashes(before.id);
  assert.deepEqual(newHashes.slice(0,-1),oldHashes.slice(0,-1));
  assert.equal(countAfter.rows-countBefore.rows,1);
  assert.ok(countAfter.blocks-countBefore.blocks<=expected.length);
  assert.equal(countAfter.links,expected.reduce((n,r)=>n+Math.ceil(r.evidence.length/128),0));
  assert.equal(countAfter.pins,0);
  await runner.run('pair',job,{now});assert.deepEqual(counts(),countAfter);
  store.recordInput(db,trade(150,{price:1}),now);await runner.run('pair',job,{now});verify();
  store.recordInput(db,trade(350,{id:'late-middle',time:trade(350).time+1,startPosition:351,side:'sell',amount:1}),now);
  await runner.run('pair',job,{now});verify();
  db.prepare('DELETE FROM observation_inputs WHERE id=?').run('late-middle');
  await runner.run('pair',job,{now});verify();
  const beforePrune=counts();store.prune(db,now);await runner.run('prune',null);verify();assert.ok(counts().blocks<beforePrune.blocks);
});
test('legacy formats 2 and 3 remain readable alongside blocks',()=>{
  const db=getDb(),rows=Array.from({length:260},(_,i)=>({id:`legacy-${i}`,time:now+i}));
  const encoded=encodeEvidence(rows).encoded;
  require('../lib/observationEvidence').writeEvidence(db,'legacy-v2',encoded);
  const put=db.prepare('INSERT INTO observation_evidence_versions VALUES(?,?,?,?)');
  db.transaction(()=>{for(let i=0;i<encoded.length;i++)put.run('legacy-v3','legacy-token',i,encoded[i].hash);})();
  db.prepare('INSERT INTO observation_evidence VALUES(?,?)').run('legacy-v3',JSON.stringify({format:3,token:'legacy-token'}));
  for(const id of ['legacy-v2','legacy-v3']) {
    assert.deepEqual([...readEvidence(db,id,127,50)],rows.slice(127,177));
    assert.deepEqual([...readTriggerEvidence(db,id,now+128)],rows.slice(0,129));
  }
});
test('pruning protects pinned blocks and their rows before publication, then reclaims cancelled work',async()=>{
  const db=getDb(),row={id:'only-in-pinned-block',time:now};
  const packed=encodeEvidence([row]).encoded[0],json=JSON.stringify([packed.hash]);
  const block=createHash('sha256').update('evidence-block-v4:').update(json).digest('hex');
  db.prepare('INSERT INTO observation_calculations VALUES(?,?)').run('pin-test',now);
  db.prepare('INSERT INTO observation_evidence_blocks VALUES(?,?)').run(block,json);
  db.prepare('INSERT INTO observation_staged_blocks VALUES(?,?)').run('pin-test',block);
  db.prepare('INSERT INTO observation_evidence_rows VALUES(?,?)').run(packed.hash,packed.json);
  store.prune(db,now);
  await createComputeRunner().run('prune',null);
  assert.ok(db.prepare('SELECT 1 FROM observation_evidence_blocks WHERE hash=?').get(block));
  assert.ok(db.prepare('SELECT 1 FROM observation_evidence_rows WHERE hash=?').get(packed.hash));
  db.prepare('DELETE FROM observation_calculations WHERE token=?').run('pin-test');store.prune(db,now);
  await createComputeRunner().run('prune',null);
  assert.equal(db.prepare('SELECT 1 FROM observation_evidence_blocks WHERE hash=?').get(block),undefined);
  assert.equal(db.prepare('SELECT 1 FROM observation_evidence_rows WHERE hash=?').get(packed.hash),undefined);
});

test('collective trigger-only reads match complete evidence histories across multiple blocks',async()=>{
  const db=getDb(),runner=createComputeRunner();
  for(let member=1;member<=3;member++) {
    const whaleId=`block-collective-${member}`;
    db.transaction(()=>{
      for(let i=0;i<200;i++)store.recordInput(db,{...trade(i),id:`${whaleId}-${i}`,whaleId,
        address:'0x'+String(member).repeat(40),time:now-(200-i)*60000},now);
    })();
    await runner.run('pair',{whale_id:whaleId,coin:'BTC'},{now});
  }
  await runner.run('collective',null,{now});
  const query=db.prepare("SELECT payload_json FROM whale_observations WHERE whale_id='__collective__' ORDER BY id");
  const before=query.all();assert.ok(before.length>0);
  // The baseline consumes complete histories, including later follow-up rows.
  store.processCollective(db,now);assert.deepEqual(query.all(),before);
  for(const row of before) {
    const event=JSON.parse(row.payload_json),actual=[...readEvidence(db,event.id)];
    assert.equal(actual.length,event.evidenceCount);
    assert.equal(encodeEvidence(actual).hash,event.evidenceHash);
  }
});

test('garbage collection rejects its old plan when a row is pinned after the snapshot',async()=>{
  const db=getDb(),row=encodeEvidence([{id:'gc-after-snapshot',time:now}]).encoded[0];
  db.prepare('INSERT INTO observation_evidence_rows VALUES(?,?)').run(row.hash,row.json);
  const json=JSON.stringify([row.hash]),hash=createHash('sha256').update(json).digest('hex');
  let calls=0;
  const result=await createComputeRunner().run('prune',null,{isCurrent:()=>{
    if(++calls===2) {
      db.prepare('INSERT INTO observation_calculations VALUES(?,?)').run('gc-concurrent-pin',now);
      db.prepare('INSERT INTO observation_evidence_blocks VALUES(?,?)').run(hash,json);
      db.prepare('INSERT INTO observation_staged_blocks VALUES(?,?)').run('gc-concurrent-pin',hash);
    }
    return true;
  }});
  assert.equal(result.stale,true);
  assert.ok(db.prepare('SELECT 1 FROM observation_evidence_rows WHERE hash=?').get(row.hash));
  db.prepare('DELETE FROM observation_calculations WHERE token=?').run('gc-concurrent-pin');
  await createComputeRunner().run('prune',null);
  assert.equal(db.prepare('SELECT 1 FROM observation_evidence_rows WHERE hash=?').get(row.hash),undefined);
});

test('garbage collection rechecks references between deletion batches',async()=>{
  const db=getDb();
  db.transaction(()=>{
    const put=db.prepare('INSERT INTO observation_evidence_rows VALUES(?,?)');
    for(const row of encodeEvidence(Array.from({length:300},(_,i)=>({id:`gc-race-${i}`,time:now}))).encoded)put.run(row.hash,row.json);
  })();
  let pinned;
  const result=await createComputeRunner().run('prune',null,{isCurrent:()=>{
    const remaining=db.prepare("SELECT COUNT(*) n FROM observation_evidence_rows WHERE json_extract(payload_json,'$.id') LIKE 'gc-race-%'").get().n;
    if(remaining>0&&remaining<300&&!pinned) {
      pinned=db.prepare("SELECT hash FROM observation_evidence_rows WHERE json_extract(payload_json,'$.id') LIKE 'gc-race-%' LIMIT 1").get().hash;
      db.prepare('INSERT INTO observation_calculations VALUES(?,?)').run('gc-race-pin',now);
      db.prepare('INSERT INTO observation_evidence_blocks VALUES(?,?)').run('race-block',JSON.stringify([pinned]));
      db.prepare('INSERT INTO observation_staged_blocks VALUES(?,?)').run('gc-race-pin','race-block');
    }
    return true;
  }});
  assert.ok(pinned);assert.equal(result.stale,true);
  assert.ok(db.prepare('SELECT 1 FROM observation_evidence_rows WHERE hash=?').get(pinned));
  db.prepare('DELETE FROM observation_calculations WHERE token=?').run('gc-race-pin');
  await createComputeRunner().run('prune',null);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM observation_evidence_rows WHERE json_extract(payload_json,'$.id') LIKE 'gc-race-%'").get().n,0);
});
