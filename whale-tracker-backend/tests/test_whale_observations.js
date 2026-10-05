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

test('follow-up crosses session boundaries, stops at close and never uses reopened holdings',()=>{
  const rows=[...builds,trade('later',3600000,6,'buy',1),trade('exit',3700000,7,'sell',7),trade('reopen',3800000,0,'buy',20)];
  const event=buildObservations(rows,eventsFromTrade).find(r=>r.type==='build');
  assert.equal(event.tracking.status,'closed');assert.equal(event.tracking.lastSize,0);
  assert.equal(event.tracking.addUsd,100000);assert.equal(event.tracking.reduceUsd,700000);
  assert.equal(event.evidence.length,5);assert.equal(event.lastAt,now);
  const gap=buildObservations([...builds,trade('gap',1000,100,'buy',1)],eventsFromTrade).find(r=>r.type==='build');
  assert.equal(gap.tracking.status,'gap');assert.equal(gap.tracking.lastSize,6);
  assert.equal(gap.tracking.interruption.reason,'position-mismatch');
  const missing=buildObservations([...builds,trade('missing',1000,null,'buy',1)],eventsFromTrade).find(r=>r.type==='build');
  assert.equal(missing.tracking.interruption.reason,'missing-fields');
  const tied=buildObservations([...builds,trade('zz-tie',0,66,'sell',80)],eventsFromTrade).find(r=>r.type==='build');
  assert.equal(tied.tracking.interruption.reason,'ambiguous-order');
});

test('same-millisecond executions reorder only for one complete unique chain',()=>{
  const {orderExecutions}=require('../lib/whaleObservationEngine');
  const chain=[{id:'a',time:1,start:2,end:3},{id:'z',time:1,start:0,end:1},{id:'m',time:1,start:1,end:2}];
  const sorted=orderExecutions(chain);assert.deepEqual(sorted.map(r=>r.id),['z','m','a']);assert.ok(sorted.every(r=>r.orderVerified));
  const branching=orderExecutions([...chain,{id:'branch',time:1,start:1,end:4}]);assert.ok(branching.every(r=>r.orderAmbiguous));
  const cycle=orderExecutions([{id:'a',time:1,start:0,end:1},{id:'b',time:1,start:1,end:0}]);assert.ok(cycle.every(r=>r.orderAmbiguous));
  const rows=[...builds,trade('zz-order',0,6,'sell',8)];
  const event=buildObservations(rows,eventsFromTrade).find(r=>r.type==='build');
  assert.equal(event.tracking.status,'reversed');assert.equal(event.tracking.lastSize,-2);
});

test('snapshot status requires complete fresh native positions newer than the event',()=>{
  const w={positionObservedAt:now,positionScope:'native-perp',positions:[{coin:'BTC',side:'long',size:3}]};
  const check=(whale=w,eventAt=now-1,at=now)=>store.latestPosition(whale,'BTC','long',eventAt,at);
  assert.equal(check().status,'same');assert.equal(check({...w,positions:[]}).status,'flat');
  assert.equal(check({...w,positions:[{coin:'BTC',side:'short',size:2}]}).status,'opposite');
  assert.equal(check(w,now+1).reason,'before-event');assert.equal(check(w,now-1,now+180001).reason,'stale');
  assert.equal(check({...w,error:'upstream'}).status,'unknown');assert.equal(check({...w,positions:null}).status,'unknown');
  assert.equal(check({...w,positions:[{coin:'BTC',side:'long',size:null}]}).status,'unknown');
});

test('collective counts distinct addresses, deduplicates overlapping events, separates sides and hours',()=>{
  const {buildCollective}=require('../lib/whaleObservationEngine');
  const base=Math.floor(now/3600000)*3600000;
  const events=[];
  for(let i=0;i<3;i++) {
    const rows=builds.map((r,j)=>({...r,id:`member-${i}-${j}`,time:base+j*300000,whaleId:`member-${i}`,address:'0x'+String(i+1).repeat(40)}));
    events.push(...buildObservations(rows,eventsFromTrade));
  }
  const result=buildCollective([...events,events[0]]);
  assert.equal(result.length,1);assert.equal(result[0].members.length,3);
  assert.equal(result[0].metrics.addUsd,1800000);assert.equal(result[0].evidence.length,9);
  assert.equal(buildCollective(events.slice(0,2)).length,0);
  const separated=events.map((e,i)=>i===2?{...e,evidence:e.evidence.map(r=>({...r,time:r.time+3600000})),lastAt:e.lastAt+3600000}:e);
  assert.equal(buildCollective(separated).length,0);
  const sameAddress=events.map(e=>({...e,evidence:e.evidence.map(r=>({...r,address:'0x'+'a'.repeat(40)}))}));
  assert.equal(buildCollective(sameAddress).length,0);
  const shorts=events.map(e=>({...e,side:'short',evidence:e.evidence.map(r=>({...r,legs:r.legs.map(l=>({...l,side:'short'}))}))}));
  assert.equal(buildCollective([...events,...shorts]).length,2);
  const followed=events.map(e=>({...e,evidence:[...e.evidence,{...e.evidence.at(-1),id:'later',time:e.lastAt+1,legs:[{kind:'increase',side:'long',usd:9999999}]}]}));
  assert.equal(buildCollective(followed)[0].metrics.addUsd,1800000);
});

test('collective summaries persist with evidence and retract after source correction',()=>{
  const db=getDb(), base=Math.floor(now/3600000)*3600000;
  for(let i=0;i<3;i++) {
    const rows=builds.map((r,j)=>({...r,id:`persist-group-${i}-${j}`,time:base-3600000+j*300000,whaleId:`group-${i}`,asset:'ETH',address:'0x'+String(i+4).repeat(40)}));
    persistTradesIncremental(rows);store.processPair(db,{whale_id:`group-${i}`,coin:'ETH'});
  }
  store.processCollective(db);
  const result=store.list(db).find(r=>r.type==='collective');assert.ok(result);
  assert.equal(store.evidence(db,result.id,0).total,9);
  const put=db.prepare('INSERT OR REPLACE INTO whales(id,payload_json,updated_at) VALUES(?,?,?)');
  for(let i=0;i<3;i++)put.run(`group-${i}`,JSON.stringify({positionScope:'native-perp',positionObservedAt:now,positions:i===1?[]:[{coin:'ETH',side:i===2?'short':'long',size:6}]}),now);
  const enriched=store.list(db,now).find(r=>r.id===result.id);
  assert.deepEqual(enriched.positionCounts,{same:1,flat:1,opposite:1,unknown:0});
  assert.deepEqual(store.list(db,now+180001).find(r=>r.id===result.id).positionCounts,{same:0,flat:0,opposite:0,unknown:3});
  assert.equal(enriched.revision,result.revision);
  db.prepare("DELETE FROM whale_observations WHERE whale_id='group-2'").run();
  store.processCollective(db);assert.equal(store.evidence(db,result.id,0),null);
  db.prepare("DELETE FROM whale_observations WHERE whale_id LIKE 'group-%'").run();
});
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
  assert.ok(first.timing.latestExecutionReceivedAt>=now);
  assert.ok(first.timing.generatedAt>=first.timing.inputsReadyAt);
  store.processPair(db,job);
  assert.equal(store.list(db).find(r=>r.id===first.id).revision,1);
  assert.deepEqual(store.list(db).find(r=>r.id===first.id).timing,first.timing);
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
