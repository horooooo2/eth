const test=require('node:test'),assert=require('node:assert/strict');
require('./helpers/isolateSqlite');
const {getDb}=require('../lib/db');
const {createStatisticsWorker}=require('../lib/statisticsWorker');
const {createStatisticsRunner}=require('../lib/statisticsCompute');
const store=require('../lib/sqliteStore');
const {scanResonanceSignals,selectResonanceSignals,DEFAULT_RESONANCE_CONFIG}=require('../lib/resonanceEngine');
const {DURATIONS,WINDOWS}=require('../lib/statisticsComputeChild');
let clock=Date.now(),roster=['a','b','c'];
const whales=roster.map(id=>({id,name:id,winRate:80,positions:[],enabled:true}));
const db=getDb();
function fill(id,whale='a',coin='BTC',extra={}) {
  const trade={id,whaleId:whale,asset:coin,side:'buy',startPosition:0,amount:2,amountUsd:200000,price:100000,time:clock-1000,...extra};
  db.prepare('INSERT OR REPLACE INTO fills(id,whale_id,time,payload_json) VALUES(?,?,?,?)').run(id,whale,trade.time,JSON.stringify(trade));
  return trade;
}
db.transaction(()=>{
  for(const whale of whales)db.prepare('INSERT INTO whales(id,enabled,payload_json,updated_at) VALUES(?,?,?,?)').run(whale.id,1,JSON.stringify(whale),clock);
  for(const id of roster) {fill('btc-'+id,id);fill('eth-'+id,id,'ETH',{side:'sell'});fill('pepe-'+id,id,'KPEPE');}
  fill('reverse','a','SOL',{side:'sell',startPosition:1,amount:2,amountUsd:200000});
  fill('spot','a','BTC',{instrumentType:'spot'});
  fill('old','a','BTC',{time:clock-25*3600000});
})();
const baseline=()=>{
  store.invalidateFillProjection();
  const directions=new Map(),resonances=new Map();
  for(const [window,duration] of Object.entries(DURATIONS))directions.set(window,store.loadDirectionSummary(clock-duration,clock));
  for(const windowHours of WINDOWS) {
    const config={...DEFAULT_RESONANCE_CONFIG,windowHours};
    const inputs=store.loadResonanceInputs(clock-Math.max(windowHours,config.accumulationWindowHours)*3600000,clock,config.minNotionalUsd,new Set(roster),{stream:true});
    resonances.set(windowHours,scanResonanceSignals({...inputs,whales:whales.filter(w=>roster.includes(w.id)),config,now:clock,watchedCoins:['BTC','ETH','SOL','PEPE']}));
  }
  return {directions,resonances};
};
const runner=createStatisticsRunner();
const worker=createStatisticsWorker({getDb,getRoster:()=>roster,runner,now:()=>clock,minIntervalMs:0});
test('all precomputed windows and coin subsets exactly match the original algorithms',async()=>{
  assert.throws(()=>worker.direction('1h'),error=>error.status===503);
  const expected=baseline();await worker.tick();
  assert.equal(worker.getStatus().error,null);
  for(const [window,value] of expected.directions) {
    const result=JSON.parse(worker.direction(window));
    assert.deepEqual({coins:result.coins,accounts:result.accounts},value);
    assert.equal(result.statistics.pendingUpdates,false);
  }
  for(const [window,value] of expected.resonances) {
    for(const coins of [['BTC'],['ETH'],['BTC','ETH'],['SOL'],['UBTC'],['PEPE'],['KPEPE'],['BTC','PEPE'],['NONEXISTENT']]) {
      const config={...DEFAULT_RESONANCE_CONFIG,windowHours:window};
      const inputs=store.loadResonanceInputs(clock-Math.max(window,config.accumulationWindowHours)*3600000,clock,config.minNotionalUsd,new Set(roster),{stream:true});
      const expectedSubset=scanResonanceSignals({...inputs,whales,config,now:clock,watchedCoins:coins});
      const {updatedAt,statistics,basis,coverage,executionCoverage,...result}=worker.resonance(window,coins);
      assert.deepEqual(JSON.parse(JSON.stringify(result)),JSON.parse(JSON.stringify(expectedSubset)));
    }
    assert.ok(value.signals.length>0);
  }
});
test('append and correction during computation publish a coherent batch and expose pending updates',async()=>{
  const realRun=runner.run.bind(runner);
  runner.run=async request=>{
    const result=await realRun(request);
    fill('during','b','BTC',{amountUsd:300000});
    db.prepare("UPDATE fills SET payload_json=json_set(payload_json,'$.amountUsd',400000) WHERE id='btc-a'").run();
    return result;
  };
  try {
    fill('before');const version=db.prepare('SELECT version FROM statistics_input_version').get().version;
    await worker.tick();
    const snapshot=JSON.parse(worker.direction('1h'));
    assert.equal(snapshot.statistics.inputVersion,version);
    assert.equal(snapshot.statistics.pendingUpdates,true);
    assert.equal(snapshot.coins.find(row=>row.coin==='BTC').addLong,800000);
  } finally {runner.run=realRun;}
  await worker.tick();assert.equal(JSON.parse(worker.direction('1h')).statistics.pendingUpdates,false);
  const expected=baseline();assert.deepEqual(JSON.parse(worker.direction('1h')).coins,expected.directions.get('1h').coins);
});
test('failed computation retains persisted complete results and restart hydrates them first',async()=>{
  clock+=11000;
  const persisted=worker.direction('1h'),realRun=runner.run;
  runner.run=async()=>{throw Error('forced statistics failure');};
  try {await worker.tick();assert.equal(JSON.parse(worker.direction('1h')).statistics.stale,true);assert.match(worker.getStatus().error,/保留/);}
  finally {runner.run=realRun;}
  const restarted=createStatisticsWorker({getDb,getRoster:()=>roster,now:()=>clock,runner:{run:async()=>{throw Error('restart failure');},stop(){}}});
  await restarted.tick();
  assert.deepEqual(JSON.parse(restarted.direction('1h')).coins,JSON.parse(persisted).coins);
  restarted.stop();
});
test('window aging, history deletion and roster changes update without a new fill',async()=>{
  clock+=25*3600000;
  await worker.tick();assert.equal(JSON.parse(worker.direction('24h')).coins.length,0);
  fill('fresh-after-time');await worker.tick();
  assert.equal(JSON.parse(worker.direction('1h')).coins[0].addLong,200000);
  db.prepare('DELETE FROM fills WHERE id=?').run('fresh-after-time');await worker.tick();
  assert.equal(JSON.parse(worker.direction('1h')).coins.length,0);
  roster=['a'];assert.throws(()=>worker.resonance(6,['BTC']),error=>error.status===503);
  await worker.tick();assert.equal(worker.resonance(6,['BTC']).hit,false);
});
test('requests read completed snapshots while computation is pending, without scanning facts',async()=>{
  clock+=11000;
  let release;
  const realRun=runner.run;
  runner.run=()=>new Promise((resolve,reject)=>{release=()=>reject(Error('held computation'));});
  const task=worker.tick();
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  const originalPrepare=db.prepare;
  db.prepare=function(sql){assert.doesNotMatch(sql,/\bFROM (fills|events|whales)\b/i);return originalPrepare.call(this,sql);};
  try {
    for(let i=0;i<30;i++){assert.ok(worker.direction('1h'));assert.equal(worker.resonance(6,['BTC']).hit,false);}
    assert.equal(worker.getStatus().running,true);
  } finally {db.prepare=originalPrepare;release();await task;runner.run=realRun;}
});
test('HTTP routes return cached results and warming status without invoking the old statistics builders',async()=>{
  const express=require('express'),service=require('../lib/statisticsWorker');
  const original={direction:service.direction,resonance:service.resonance,prepare:store.prepareFillProjection};
  service.direction=worker.direction;service.resonance=worker.resonance;
  store.prepareFillProjection=async()=>{throw Error('HTTP must never rebuild facts');};
  const app=express();app.use('/api/whales',require('../routes/whales'));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const url='http://127.0.0.1:'+server.address().port;
  try {
    const direction=await fetch(url+'/api/whales/direction-summary?window=1h');
    assert.equal(direction.status,200);assert.equal(direction.headers.get('cache-control'),'no-store');
    assert.ok((await direction.json()).statistics);
    assert.equal((await fetch(url+'/api/whales/resonance?windowHours=6&coins=BTC,ETH')).status,200);
    assert.equal((await fetch(url+'/api/whales/direction-summary?window=bad')).status,400);
    worker.invalidate();
    assert.equal((await fetch(url+'/api/whales/direction-summary?window=1h')).status,503);
    assert.equal((await fetch(url+'/api/whales/resonance?windowHours=6&coins=BTC')).status,503);
  } finally {
    service.direction=original.direction;service.resonance=original.resonance;store.prepareFillProjection=original.prepare;
    await new Promise(resolve=>server.close(resolve));worker.stop();
  }
});

test('cancelled staging never exposes partial windows or overwrites the current pointer',async()=>{
  await worker.tick();
  const before=db.prepare('SELECT batch_id FROM statistics_current WHERE id=1').get().batch_id;
  clock+=11000;
  const originalPrepare=db.prepare;
  db.prepare=function(sql) {
    const statement=originalPrepare.call(this,sql);
    if(sql==='INSERT INTO statistics_results VALUES(?,?,?)') {
      const run=statement.run.bind(statement);
      statement.run=(...args)=>{const result=run(...args);worker.stop();return result;};
    }
    return statement;
  };
  try {await worker.tick();}
  finally {db.prepare=originalPrepare;}
  assert.equal(db.prepare('SELECT batch_id FROM statistics_current WHERE id=1').get().batch_id,before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM statistics_results WHERE batch_id!=?').get(before).n,0);
  assert.ok(worker.direction('1h'));
});
test('an import write failure keeps the old pointer and retries the complete batch',async()=>{
  clock+=11000;
  const before=db.prepare('SELECT batch_id FROM statistics_current WHERE id=1').get().batch_id;
  const originalPrepare=db.prepare;
  db.prepare=function(sql) {
    if(sql==='INSERT INTO statistics_results VALUES(?,?,?)')return {run(){throw Error('forced import failure');}};
    return originalPrepare.call(this,sql);
  };
  try {await worker.tick();}
  finally {db.prepare=originalPrepare;}
  assert.equal(db.prepare('SELECT batch_id FROM statistics_current WHERE id=1').get().batch_id,before);
  assert.equal(JSON.parse(worker.direction('1h')).statistics.stale,true);
  await worker.tick();
  assert.equal(JSON.parse(worker.direction('1h')).statistics.error,null);
});
test('a timed-out child is terminated and the next runner can compute successfully',async()=>{
  const request={database:db.name,now:clock,roster,rosterKey:'timeout',retentionMs:2*86400000};
  const timed=createStatisticsRunner({timeoutMs:1});
  await assert.rejects(timed.run(request),/timed out/);
  const recovery=createStatisticsRunner();
  try {assert.equal((await recovery.run(request)).rows.length,9);}
  finally {timed.stop();recovery.stop();worker.stop();}
});
test('corrupt persisted resonance summaries rebuild instead of trapping startup in hydration failures',async()=>{
  db.prepare("UPDATE statistics_results SET payload_json='broken' WHERE batch_id=(SELECT batch_id FROM statistics_current WHERE id=1) AND key='resonance:6'").run();
  db.prepare("UPDATE statistics_results SET payload_json='{}' WHERE batch_id=(SELECT batch_id FROM statistics_current WHERE id=1) AND key='direction:1h'").run();
  const restored=createStatisticsWorker({getDb,getRoster:()=>roster,now:()=>clock,minIntervalMs:0});
  try {
    await restored.tick();
    assert.equal(restored.getStatus().warming,false);
    assert.equal(restored.getStatus().error,null);
    assert.equal(restored.resonance(6,['BTC']).hit,false);
    assert.equal(JSON.parse(restored.direction('1h')).statistics.pendingUpdates,false);
  } finally {restored.stop();}
});
