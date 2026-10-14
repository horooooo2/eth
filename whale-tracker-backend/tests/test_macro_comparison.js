const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fork } = require('node:child_process');
const isolated = require('./helpers/isolateSqlite');
const { getDb, resolveDbPath, setMeta } = require('../lib/db');
const { persistTradesIncremental, persistStatePatch } = require('../lib/sqliteStore');
const { createStore } = require('../lib/macroComparisonStore');
const { computeWindow } = require('../lib/macroComparisonCompute');
const { RULE_VERSION, macroDirection, numberReading, compare, eventIdentity } = require('../lib/macroComparisonRules');
const { translateFfTitle,mergeCalendarEvents,normalizeFfRows } = require('../lib/calendarFeed');
const at = Date.UTC(2026,9,14,12,30), from = at-3600000;
const event = { title:'CPI（同比）',date:'2026-10-14',time:'20:30',forecast:'3.6%',actual:'3.7%',previous:'3.4%' };
const roster = [{id:'a',address:'0x'+'1'.repeat(40)},{id:'b',address:'0x'+'2'.repeat(40)}];
const trade = (id,whaleId,usd,side='sell',time=at-60000,asset='BTC') => ({id,whaleId,asset,amount:usd/100,amountUsd:usd,price:100,side,startPosition:0,time,source:'hyperliquid'});
function reset(){const db=getDb();db.exec('DELETE FROM fills; DELETE FROM events; DELETE FROM alerts; DELETE FROM alert_items; DELETE FROM alert_sources;');}
function coverage(){setMeta('fills_address_watermarks_v2',JSON.stringify(Object.fromEntries(roster.map(row=>[row.address,{coverageStart:from-1000,through:at+1000}]))));}
test('reading units and event identity keep CPI, core CPI and PCE periods distinct; surprise rules are explicit',()=>{
  assert.equal(macroDirection(event,at+1),'SHORT');
  assert.equal(macroDirection({...event,actual:'3.5%'},at+1),'LONG');
  assert.equal(macroDirection({...event,actual:'3.6%'},at+1),'NEUTRAL');
  assert.equal(macroDirection({...event,actual:'3.7'},at+1),'PENDING');
  assert.equal(macroDirection(event,at-1),'PENDING');
  assert.equal(numberReading('-12.5K').value,-12500);
  assert.notEqual(eventIdentity(event),eventIdentity({...event,title:'核心 CPI（同比）'}));
  assert.equal(translateFfTitle('Core PCE Price Index m/m'),'核心 PCE（环比）');
  const rows=normalizeFfRows(['Core PCE Price Index m/m','Core PCE Price Index y/y','PCE Price Index m/m'].map(title=>({title,country:'USD',impact:'High',date:'2026-10-14T08:30:00-04:00'})),{today:'2026-10-14',until:'2026-10-15'});
  assert.equal(mergeCalendarEvents([],rows).length,3);
});
test('a whole-hour atomic scan excludes exits, post-release trades, other coins and duplicate fills; reversals count only opening leg',()=>{
  reset();coverage();
  persistTradesIncremental([trade('1','a',700),trade('2','b',300),trade('1','a',700),
    {...trade('close','a',800,'sell'),startPosition:10},trade('after','a',999999,'buy',at),
    trade('other','a',999999,'buy',at-1,'SOL'),trade('eth','b',200,'buy',at-1,'ETH'),
    {...trade('flip','b',1000,'sell'),startPosition:5}]);
  const result=computeWindow({database:resolveDbPath(),releaseAt:at,mode:'RETROSPECTIVE',roster,now:at+60000});
  assert.equal(result.coins.BTC.shortUsd,1500);assert.equal(result.coins.BTC.longUsd,0);assert.equal(result.coins.BTC.fills,3);
  assert.equal(result.coins.ETH.longUsd,200);assert.equal(result.coins.BTC.whales,2);
  assert.equal(result.coverage.complete,true);
  assert.equal(compare('SHORT',result.coins.BTC,result).status,'MATCH');
  assert.equal(compare('SHORT',result.coins.BTC,result).eligible,false);
});
test('first receipt stays fixed on replay; metadata enrichment does not revise facts; both persistence paths track real revisions',()=>{
  reset();const originalNow=Date.now;let clock=at-10000;Date.now=()=>clock;
  try{
    persistTradesIncremental([trade('receipt','a',1000)]);
    const before=getDb().prepare('SELECT received_at,fact_updated_at FROM fills').get();
    clock=at+10000;persistStatePatch({trades:[{...trade('receipt','a',1000),whaleName:'new label'}]});
    assert.deepEqual(getDb().prepare('SELECT received_at,fact_updated_at FROM fills').get(),before);
    clock++;persistTradesIncremental([trade('receipt','a',2000)]);
    const after=getDb().prepare('SELECT received_at,fact_updated_at FROM fills').get();
    assert.equal(after.received_at,before.received_at);assert.equal(after.fact_updated_at,clock);
  }finally{Date.now=originalNow;}
});
test('prospective result excludes unknown, late and revised records; they remain available in a separate retrospective repair',()=>{
  reset();coverage();const originalNow=Date.now;
  try{
    Date.now=()=>at-10000;persistTradesIncremental([trade('pre-a','a',700),trade('pre-b','b',300),trade('change','a',100)]);
    Date.now=()=>at+10000;persistTradesIncremental([trade('late','a',2000),trade('change','a',200)]);
    getDb().prepare('UPDATE fills SET received_at=NULL,fact_updated_at=NULL WHERE id=?').run('a:pre-a');
    const input={database:resolveDbPath(),releaseAt:at,roster,now:at+60000};
    const primary=computeWindow({...input,mode:'PRE_RELEASE'}),revision=computeWindow({...input,mode:'RETROSPECTIVE'});
    assert.equal(primary.coins.BTC.shortUsd,300);assert.equal(revision.coins.BTC.shortUsd,3200);
    assert.equal(primary.quality.unknownReceipts,1);assert.equal(primary.quality.lateFills,1);assert.equal(primary.quality.revisedFills,1);
    assert.equal(compare('SHORT',primary.coins.BTC,primary).eligible,false);
  }finally{Date.now=originalNow;}
});
test('archived key data and immutable first result survive restart and calendar expiration; same-release indicators share one job',()=>{
  const file=path.join(isolated.dir,'history.db');let store=createStore(file,from-86400000);
  const variants=[event,{...event,title:'核心 CPI（同比）',forecast:'2.5%',actual:'2.6%'},{...event,title:'核心 CPI（环比）',forecast:'0.2%',actual:'0.3%'}];
  try{
    store.archive(variants,from-60000);let job=store.nextJob(at+1000);assert.equal(job.mode,'PRE_RELEASE');
    const base={ruleVersion:RULE_VERSION,mode:'PRE_RELEASE',sinceMs:from,untilMs:at,retentionExpired:false,coins:{BTC:{longUsd:0,shortUsd:1000,whales:2},ETH:{longUsd:0,shortUsd:1000,whales:2}},coverage:{complete:true},quality:{unknownReceipts:0,lateFills:0,revisedFills:0,invalidRows:0,unclassifiedFills:0}};
    store.running(job,at);store.commit(job,base,at+1000);
    assert.equal(store.summary(at+1000).BTC.eligible,1); // Three CPI entries do not inflate the denominator.
    store.commit(job,{...base,mode:'RETROSPECTIVE'},at+2000);
    assert.equal(store.list({at:at+2000}).rows[0].result.mode,'PRE_RELEASE');
    store.archive([{...event,forecast:'999%',actual:'3.8%'}],at+3000);
    const updated=store.list({at:at+4000}).rows.find(row=>row.event.title==='CPI（同比）');assert.equal(updated.event.forecast,'3.6%');assert.equal(updated.event.actual,'3.7%');assert.equal(updated.event.revisedActual,'3.8%');
    job=store.nextJob(at+900000);assert.equal(job.revision,true);store.running(job,at+900000);
    store.close();store=createStore(file,at+901000);job=store.nextJob(at+902000);assert.equal(job.revision,true);
    store.commit(job,{...base,mode:'RETROSPECTIVE'},at+902000);
    store.archive([],at+90*86400000);const history=store.list({at:at+90*86400000});assert.equal(history.total,3);
    assert.equal(history.rows[0].result.mode,'PRE_RELEASE');assert.equal(history.rows[0].revision.mode,'RETROSPECTIVE');
    assert.equal(store.nextJob(at+90*86400000),null);
  }finally{store.close();}
});
test('retroactive, neutral, low-coverage, expired and conflicting batches never inflate forward consistency',()=>{
  const result={ruleVersion:RULE_VERSION,mode:'PRE_RELEASE',sinceMs:from,retentionExpired:false,coverage:{complete:true},quality:{unknownReceipts:0,lateFills:0,revisedFills:0,invalidRows:0,unclassifiedFills:0}};
  const flow={longUsd:0,shortUsd:1000,whales:2};
  assert.equal(compare('SHORT',flow,result).eligible,true);
  for(const patch of [{mode:'RETROSPECTIVE'},{coverage:{complete:false}},{retentionExpired:true}])assert.equal(compare('SHORT',flow,{...result,...patch}).eligible,false);
  assert.equal(compare('NEUTRAL',flow,result).eligible,false);
  assert.equal(compare('SHORT',{longUsd:49,shortUsd:51,whales:3},result).status,'FLOW_NEUTRAL');
  assert.equal(compare('SHORT',flow,result,{...event,forecastObservedAt:at+1}).eligible,false);
  const store=createStore(path.join(isolated.dir,'conflict.db'),from-86400000);
  try{store.archive([event,{...event,title:'核心 CPI（同比）',forecast:'2.5%',actual:'2.4%'}],from-60000);const job=store.nextJob(at+1);store.commit(job,{...result,coins:{BTC:flow,ETH:flow}},at+1000);assert.equal(store.summary(at+2000).BTC.eligible,0);}finally{store.close();}
});
test('actual child process returns the same bounded result while parent timers continue',async()=>{
  reset();coverage();const originalNow=Date.now;
  try{Date.now=()=>at-10000;persistTradesIncremental([trade('a','a',1000),trade('b','b',1000)]);}finally{Date.now=originalNow;}
  const input={database:resolveDbPath(),releaseAt:at,mode:'RETROSPECTIVE',roster,now:at+60000};
  const primary=computeWindow({...input,mode:'PRE_RELEASE'});input.frozenEvidenceHash=primary.evidenceHash;
  const expected=computeWindow(input);let ticks=0;const timer=setInterval(()=>ticks++,5);
  const child=fork(require.resolve('../lib/macroComparisonCompute'),[],{execArgv:['--max-old-space-size=128'],stdio:['ignore','ignore','ignore','ipc']});
  try{
    const result=await new Promise((resolve,reject)=>{child.once('message',message=>message.ok?resolve(message.result):reject(Error(message.error)));child.once('error',reject);child.send(input);});
    assert.deepEqual(result,expected);assert.ok(ticks>0);
    assert.equal(compare('SHORT',primary.coins.BTC,primary,null,result.verification).eligible,true);
  }finally{clearInterval(timer);child.kill();}
});
test('a later fact commit requests a throttled repair; repaired versions never overwrite the first snapshot',()=>{
  const store=createStore(path.join(isolated.dir,'repairs.db'),from-86400000);
  const initial={mode:'RETROSPECTIVE',coins:{BTC:{longUsd:0,shortUsd:10,whales:2},ETH:{longUsd:0,shortUsd:10,whales:2}},quality:{},coverage:{},evidenceHash:'first'};
  try{
    store.archive([event],at+1000);let job=store.nextJob(at+1000);store.commit(job,initial,at+1000);
    assert.equal(store.requestRevision(at,at+2000),true);
    assert.equal(store.nextJob(at+299000),null);
    job=store.nextJob(at+302000);assert.equal(job.revision,true);store.commit(job,{...initial,evidenceHash:'repair-1'},at+302000);
    store.requestRevision(at,at+303000);job=store.nextJob(at+603000);store.commit(job,{...initial,evidenceHash:'repair-2'},at+603000);
    const row=store.list({at:at+604000}).rows[0];assert.equal(row.result.evidenceHash,'first');assert.equal(row.revision.evidenceHash,'repair-2');
    assert.ok(store.repairable(at+604000).includes(at));assert.deepEqual(store.repairable(at+24*3600000),[]);
  }finally{store.close();}
});
test('only changed committed facts notify repair scheduling; replays and metadata-only enrichment do not',()=>{
  reset();const sqlite=require('../lib/sqliteStore');let count=0;sqlite.setMacroComparisonObserver(trades=>count+=trades.length);
  try{
    const row=trade('notify','a',1000);persistTradesIncremental([row]);assert.equal(count,1);
    persistTradesIncremental([row]);persistStatePatch({trades:[{...row,whaleName:'renamed'}]});assert.equal(count,1);
    persistTradesIncremental([{...row,amountUsd:2000}]);assert.equal(count,2);
  }finally{sqlite.setMacroComparisonObserver(null);}
});

test('watermark-only verification qualifies unchanged frozen evidence, survives restart, and stops once complete',()=>{
  reset(); const originalNow=Date.now;
  try { Date.now=()=>at-10000;persistTradesIncremental([trade('verify-a','a',700),trade('verify-b','b',300)]); } finally {Date.now=originalNow;}
  const file=path.join(isolated.dir,'verification.db'); let store=createStore(file,from-86400000);
  const input={database:resolveDbPath(),releaseAt:at,roster};
  try {
    setMeta('fills_address_watermarks_v2',JSON.stringify(Object.fromEntries(roster.map(w=>[w.address,{coverageStart:from-1,through:at-60000}]))));
    store.archive([event],from-60000);let job=store.nextJob(at+1000);
    const first=computeWindow({...input,mode:job.mode,now:at+1000});store.commit(job,first,at+1000);
    assert.equal(store.summary(at+1000).BTC.eligible,0);
    job=store.nextJob(at+900000);assert.equal(job.frozenEvidenceHash,first.evidenceHash);
    store.commit(job,computeWindow({...input,mode:job.mode,frozenEvidenceHash:job.frozenEvidenceHash,now:at+900000}),at+900000);
    assert.equal(store.nextJob(at+1199999),null);
    store.close();store=createStore(file,at+1200000);coverage();
    job=store.nextJob(at+1200000);assert.equal(job.revision,true);
    store.commit(job,computeWindow({...input,mode:job.mode,frozenEvidenceHash:job.frozenEvidenceHash,now:at+1200000}),at+1200000);
    const row=store.list({at:at+1200000}).rows[0];
    assert.deepEqual(row.result,first);assert.equal(row.verification.coverage.complete,true);
    assert.equal(row.comparisons.BTC.eligible,true);assert.equal(store.summary(at+1200000).BTC.matches,1);
    assert.equal(store.nextJob(at+1800000),null);
  } finally {store.close();}
});

test('late fills, corrected exits, unknown classifications and changed timely evidence cannot qualify a frozen result',()=>{
  reset();coverage();const originalNow=Date.now;
  const input={database:resolveDbPath(),releaseAt:at,roster};
  try {
    Date.now=()=>at-10000;persistTradesIncremental([trade('frozen-a','a',700),trade('frozen-b','b',300)]);
    const first=computeWindow({...input,mode:'PRE_RELEASE',now:at+1000});
    const verify=()=>computeWindow({...input,mode:'RETROSPECTIVE',frozenEvidenceHash:first.evidenceHash,now:at+900000}).verification;
    assert.equal(compare('SHORT',first.coins.BTC,first,null,verify()).eligible,true);
    assert.equal(compare('SHORT',first.coins.BTC,{...first,quality:{...first.quality,unclassifiedFills:1}},null,verify()).eligible,false);
    Date.now=()=>at+10000;persistTradesIncremental([trade('late-verify','a',100000,'buy')]);
    assert.equal(compare('SHORT',first.coins.BTC,first,null,verify()).eligible,false);
    getDb().prepare('DELETE FROM fills WHERE id=?').run('a:late-verify');
    persistTradesIncremental([{...trade('frozen-a','a',700),startPosition:10}]);
    const corrected=verify();assert.equal(corrected.evidenceUnchanged,false);assert.equal(corrected.quality.revisedFills,1);
    assert.equal(compare('SHORT',first.coins.BTC,first,null,corrected).eligible,false);
    Date.now=()=>at-9000;persistTradesIncremental([trade('frozen-a','a',700),trade('unclassified','a',10000000,'buy')]);
    getDb().prepare('UPDATE fills SET payload_json=? WHERE id=?').run(JSON.stringify({...trade('unclassified','a',10000000,'buy'),startPosition:null}),'a:unclassified');
    const unresolved=verify();assert.equal(unresolved.quality.unclassifiedFills,1);
    assert.equal(compare('SHORT',first.coins.BTC,first,null,unresolved).eligible,false);
    getDb().prepare('DELETE FROM fills WHERE id=?').run('a:unclassified');
    persistTradesIncremental([trade('new-timely','a',100000,'buy')]);
    const changed=verify();assert.equal(changed.evidenceUnchanged,false);
    assert.equal(compare('SHORT',first.coins.BTC,first,null,changed).eligible,false);
  } finally {Date.now=originalNow;}
});

test('unclassifiable trades block forward qualification; known exits do not; an empty cohort scans no accounts',()=>{
  reset();coverage();const originalNow=Date.now;
  try {
    Date.now=()=>at-10000;
    persistTradesIncremental([trade('class-a','a',700),trade('class-b','b',300),{...trade('exit','a',100000,'sell'),startPosition:10000}]);
    const input={database:resolveDbPath(),releaseAt:at,mode:'PRE_RELEASE',roster,now:at+1000};
    let result=computeWindow(input);assert.equal(compare('SHORT',result.coins.BTC,result).eligible,true);
    persistTradesIncremental([{...trade('unknown-start','a',10000000,'buy'),startPosition:null}]);
    result=computeWindow(input);assert.equal(result.quality.unclassifiedFills,1);assert.equal(result.coins.BTC.shortUsd,1000);
    assert.equal(compare('SHORT',result.coins.BTC,result).eligible,false);
    const empty=computeWindow({...input,roster:[]});assert.equal(empty.quality.scanned,0);assert.equal(empty.coverage.complete,false);
    assert.equal(empty.coins.BTC.fills,0);assert.equal(empty.coins.BTC.whales,0);assert.equal(empty.coins.BTC.shortUsd,0);
  } finally {Date.now=originalNow;}
});

test('forecast version changes reset observation time and cannot borrow an earlier value timestamp',()=>{
  const store=createStore(path.join(isolated.dir,'forecast-version.db'),from-86400000);
  try {
    store.archive([{...event,actual:''}],from-60000);
    store.archive([{...event,forecast:'4.0%',actual:''}],from+1800000);
    store.archive([{...event,forecast:'4.0%'}],at+1000);
    const result={ruleVersion:RULE_VERSION,mode:'PRE_RELEASE',sinceMs:from,retentionExpired:false,
      coins:{BTC:{longUsd:1000,shortUsd:0,whales:2},ETH:{longUsd:1000,shortUsd:0,whales:2}},
      coverage:{complete:true},quality:{unknownReceipts:0,lateFills:0,revisedFills:0,invalidRows:0,unclassifiedFills:0}};
    store.commit(store.nextJob(at+1000),result,at+1000);
    const row=store.list({at:at+2000}).rows[0];assert.equal(row.event.forecast,'4.0%');assert.equal(row.event.forecastObservedAt,from+1800000);
    assert.equal(row.comparisons.BTC.eligible,false);assert.equal(store.summary(at+2000).BTC.eligible,0);
    store.archive([{...event,forecast:'999%'}],at+3000);
    assert.equal(store.list({at:at+4000}).rows[0].event.forecastObservedAt,from+1800000);
  } finally {store.close();}
});
