// Synthetic isolated DB only; never opens the user's live history.
require('../tests/helpers/isolateSqlite');
const {performance,monitorEventLoopDelay}=require('node:perf_hooks');
const assert=require('node:assert/strict');
const {getDb}=require('../lib/db');
const {createStatisticsWorker}=require('../lib/statisticsWorker');
const express=require('express');
const db=getDb(),now=Date.now(),count=Math.max(1000,Number(process.argv[2])||30000);
const roster=Array.from({length:100},(_,i)=>'bench-'+i);
const put=db.prepare('INSERT INTO fills(id,whale_id,time,payload_json) VALUES(?,?,?,?)');
db.transaction(()=>{
  for(const id of roster)db.prepare('INSERT INTO whales(id,enabled,payload_json,updated_at) VALUES(?,?,?,?)').run(id,1,JSON.stringify({id,name:id,winRate:80,positions:[]}),now);
  for(let i=0;i<count;i++) {
    const whaleId=roster[i%roster.length],time=now-1000-i*100;
    put.run('trade-'+i,whaleId,time,JSON.stringify({id:'trade-'+i,whaleId,asset:i%2?'BTC':'ETH',side:'buy',startPosition:0,amount:1,amountUsd:100000,price:100000,time}));
  }
})();
async function main() {
  const worker=createStatisticsWorker({getDb,getRoster:()=>roster,minIntervalMs:0});
  const coldAt=performance.now();await worker.tick();const coldMs=performance.now()-coldAt;
  assert.equal(worker.getStatus().warming,false);
  const store=require('../lib/sqliteStore');
  const summary=JSON.parse(worker.direction('24h'));
  const expected=store.loadDirectionSummary(summary.sinceMs,summary.untilMs);
  assert.deepEqual(summary.coins,expected.coins);assert.deepEqual(summary.accounts,expected.accounts);
  const app=express();
  app.get('/direction',(_req,res)=>res.type('json').send(worker.direction('24h')));
  app.get('/resonance',(_req,res)=>res.json(worker.resonance(24,['BTC','ETH'])));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const delays=monitorEventLoopDelay({resolution:10});delays.enable();
  const latencies=[],pending=[];let errors=0;
  const timer=setInterval(()=>{
    for(const endpoint of ['/direction','/resonance'])pending.push((async()=>{
      const at=performance.now();
      try {const response=await fetch(base+endpoint);if(response.status!==200)errors++;await response.arrayBuffer();latencies.push(performance.now()-at);}
      catch{errors++;}
    })());
  },25);
  try {
    const time=Date.now()-1;
    put.run('append',roster[0],time,JSON.stringify({id:'append',whaleId:roster[0],asset:'BTC',side:'buy',startPosition:0,amount:1,amountUsd:100000,price:100000,time}));
    const started=performance.now();await worker.tick();const refreshMs=performance.now()-started;
    clearInterval(timer);await Promise.all(pending);delays.disable();
    assert.equal(errors,0);assert.ok(latencies.length>0);assert.equal(JSON.parse(worker.direction('24h')).statistics.pendingUpdates,false);
    const final=JSON.parse(worker.direction('24h'));store.invalidateFillProjection();
    assert.deepEqual(final.coins,store.loadDirectionSummary(final.sinceMs,final.untilMs).coins);
    latencies.sort((a,b)=>a-b);
    console.log(JSON.stringify({inputCount:count,coldMs:Math.round(coldMs),refreshMs:Math.round(refreshMs),requests:latencies.length,
      requestP95Ms:Math.round(latencies[Math.floor((latencies.length-1)*.95)]),requestMaxMs:Math.round(latencies.at(-1)),mainLoopMaxDelayMs:Math.round(delays.max/1e6),resultsEqual:true},null,2));
  } finally {clearInterval(timer);delays.disable();worker.stop();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
