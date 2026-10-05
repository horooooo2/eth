const test=require('node:test');
const assert=require('node:assert/strict');
require('./helpers/isolateSqlite');
const {getDb}=require('../lib/db');
const {eventsFromTrade,persistTradesIncremental}=require('../lib/sqliteStore');
const {buildObservations}=require('../lib/whaleObservationEngine');
const store=require('../lib/whaleObservationStore');
const now=Date.now()-10000;
const trade=(id,time,start,side,amount,extra={})=>({id,whaleId:'test-observer',asset:'BTC',time:now+time,
  startPosition:start,side,amount,price:100000,amountUsd:amount*100000,...extra});
const builds=[trade('a',-600000,0,'buy',2),trade('b',-300000,2,'buy',2),trade('c',0,4,'buy',2)];
test('dedup and arrival order do not change build amounts; executions, not orders',()=>{
  const a=buildObservations(builds,eventsFromTrade);
  assert.deepEqual(buildObservations([builds[2],builds[0],builds[1],builds[0]],eventsFromTrade),a);
  assert.equal(a.length,1);assert.equal(a[0].metrics.addUsd,600000);assert.equal(a[0].metrics.fillCount,3);
});
test('selling a long produces reduction and realized PnL once; gaps suppress percentage',()=>{
  const rows=[trade('d',-100000,10,'sell',3,{closedPnl:10}),trade('e',0,7,'sell',3,{closedPnl:20})];
  const result=buildObservations(rows,eventsFromTrade);
  assert.equal(result.length,1);assert.equal(result[0].type,'reduce');assert.equal(result[0].side,'long');
  assert.equal(result[0].metrics.reduction,.6);assert.equal(result[0].metrics.closedPnl,30);
  assert.equal(buildObservations([{...rows[0],startPosition:null},{...rows[1],startPosition:null}],eventsFromTrade).length,0);
  assert.equal(buildObservations([rows[0],{...rows[1],startPosition:100}],eventsFromTrade).length,0);
});
test('direct reversal splits notional without copying closed PnL',()=>{
  const result=buildObservations([trade('r',0,2,'sell',8,{closedPnl:12})],eventsFromTrade);
  assert.equal(result.length,1);assert.equal(result[0].type,'reverse');assert.equal(result[0].side,'short');
  assert.equal(result[0].metrics.addUsd,600000);assert.equal(result[0].evidence[0].legs.reduce((s,l)=>s+l.usd,0),800000);
});
test('separate close/open is associated only within the deadline',()=>{
  const rows=[trade('r1',-600000,6,'sell',6),trade('r2',0,0,'sell',6)];
  assert.equal(buildObservations(rows,eventsFromTrade).filter(r=>r.type==='reverse').length,1);
  assert.equal(buildObservations([{...rows[0],time:now-1900000},rows[1]],eventsFromTrade).filter(r=>r.type==='reverse').length,0);
});
test('liquidations and instantaneous split fills are not described as sustained decisions',()=>{
  assert.equal(buildObservations(builds.map(r=>({...r,time:now})),eventsFromTrade).length,0);
  assert.equal(buildObservations(builds.map(r=>({...r,liquidation:{}})),eventsFromTrade).length,0);
});
test('both evidence and pending work persist atomically; duplicate ingestion does not dirty again',()=>{
  const db=getDb();persistTradesIncremental(builds);
  const job=db.prepare('SELECT * FROM observation_jobs WHERE whale_id=?').get('test-observer');assert.ok(job);
  store.processPair(db,job);
  const rows=store.list(db);assert.equal(rows.length,1);assert.equal(rows[0].evidenceCount,3);
  assert.equal(store.evidence(db,rows[0].id,0).rows.length,3);
  persistTradesIncremental(builds);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM observation_jobs').get().n,0);
  // Correct a price below the publication threshold: retract, do not add twice.
  persistTradesIncremental(builds.map(r=>({...r,price:1,amountUsd:r.amount})));
  store.processPair(db,job);assert.equal(store.list(db).length,0);
});
test('failed enclosing transaction leaves no evidence or pending job',()=>{
  const db=getDb();const t=trade('rollback',0,0,'buy',6,{whaleId:'rollback'});
  assert.throws(()=>db.transaction(()=>{store.recordInput(db,t);throw Error('abort');})());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM observation_inputs WHERE whale_id=?').get('rollback').n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM observation_jobs WHERE whale_id=?').get('rollback').n,0);
});
test('unknown fills interrupt reversal evidence; reduction after an opening is recognized',()=>{
  const reverse=[trade('z1',-600000,6,'sell',6),trade('unknown',-300000,null,'buy',1),trade('z2',0,0,'sell',6)];
  assert.equal(buildObservations(reverse,eventsFromTrade).filter(r=>r.type==='reverse').length,0);
  const mixed=[trade('z3',-600000,0,'buy',10),trade('z4',0,10,'sell',6)];
  const reduced=buildObservations(mixed,eventsFromTrade).find(r=>r.type==='reduce');
  assert.equal(reduced.metrics.reduction,.6);
});
test('durable summary excludes evidence payload; revisions remove superseded evidence',()=>{
  const db=getDb(), rows=builds.map(t=>({...t,whaleId:'revision'}));
  persistTradesIncremental(rows);const job={whale_id:'revision',coin:'BTC'};store.processPair(db,job);
  const first=store.list(db).find(r=>r.whaleId==='revision');assert.ok(first);assert.equal(first.evidence,undefined);
  const firstEvidence=store.evidence(db,first.id,0);assert.equal(firstEvidence.revision,1);
  persistTradesIncremental(rows.map(t=>({...t,price:200000,amountUsd:t.amount*200000})));
  store.processPair(db,job);assert.equal(store.evidence(db,first.id,0).revision,2);
  persistTradesIncremental(rows.map(t=>({...t,source:'onchain'})));
  store.processPair(db,job);assert.equal(store.evidence(db,first.id,0),null);
});
test('worker emits bounded deltas only when changed and snapshot survives restart reconstruction',()=>{
  const hub=require('../lib/realtimeHub'), messages=[], original=hub.broadcast;
  hub.broadcast=msg=>messages.push(msg);
  const worker=require('../lib/whaleObservationWorker');
  try {
    persistTradesIncremental(builds.map(t=>({...t,whaleId:'worker',from:'Hyperliquid',to:'0x'+'a'.repeat(40)})));
    worker.tick();
    const snapshot=worker.snapshot();assert.equal(snapshot.type,'observationSnapshot');
    const event=snapshot.rows.find(r=>r.whaleId==='worker');assert.ok(event);
    assert.equal(event.address,'0x'+'a'.repeat(40));
    const first=messages.at(-1);assert.equal(first.type,'observationCommit');assert.equal(first.seq,snapshot.seq);
    assert.ok(first.ids.includes(event.id));assert.equal(first.rows[0].evidence,undefined);
    const count=messages.length;worker.tick();assert.equal(messages.length,count);
    // HTTP and socket share the same complete revision, with no request-triggered work.
    assert.equal(worker.snapshot().seq,snapshot.seq);
  }finally{hub.broadcast=original;worker.stop();}
});
