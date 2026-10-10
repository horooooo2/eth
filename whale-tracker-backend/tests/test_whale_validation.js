const test = require('node:test');
const assert = require('node:assert/strict');
const { createValidator, matchingPosition } = require('../lib/whaleValidation');
const wallet = n => ({ address: '0x' + n.toString(16).padStart(40, '0'), name: `wallet${n}` });
const flush = async job => { for (let i=0; i<100 && job.status==='running'; i++) await new Promise(setImmediate); };
test('stop aborts an in-flight request and prevents later rows and requests', async () => {
  let signal, resolveRead, calls=0;
  const v=createValidator({candidates:()=>[wallet(1),wallet(2)],pause:async()=>{},request:async(body,_retry,scheduling)=>{
    calls++;
    if(body.type==='meta')return {universe:[{name:'BTC'}]};
    signal=scheduling.signal;
    return new Promise(resolve=>{resolveRead=resolve;});
  }});
  const job=v.start('BTC');
  while(!resolveRead) await new Promise(setImmediate);
  assert.equal(v.stop(job.id).status,'stopped');assert.equal(signal.aborted,true);
  resolveRead({assetPositions:[{position:{coin:'BTC',szi:'1',positionValue:'100'}}]});
  await new Promise(setImmediate);
  assert.equal(calls,2);assert.equal(job.success,0);assert.equal(job.failed,0);assert.equal(job.positions.length,0);
  assert.equal(v.stop(job.id).status,'stopped');assert.equal(v.stop('missing'),null);
});
test('stop during delay prevents the next network call', async()=>{
  let release;
  let calls=0;
  const v=createValidator({candidates:()=>[wallet(1)],pause:()=>new Promise(resolve=>{release=resolve;}),request:async()=>{calls++;return {universe:[{name:'BTC'}]};}});
  const job=v.start('BTC');while(!release)await new Promise(setImmediate);
  v.stop(job.id);release();await new Promise(setImmediate);
  assert.equal(calls,1);assert.equal(job.status,'stopped');
});
test('details preserve snapshot values and unknown fields instead of inventing zeroes', () => {
  const [row] = matchingPosition({assetPositions:[{position:{coin:'xyz:SNDK',szi:'-2',positionValue:'400',entryPx:'210',unrealizedPnl:'20',liquidationPx:null,marginUsed:'80',returnOnEquity:'0.25',leverage:{value:5,type:'isolated'}}}]}, 'xyz:SNDK');
  assert.equal(row.entryPx,210);assert.equal(row.unrealizedPnl,20);assert.equal(row.liquidationPx,null);
  assert.equal(row.marginUsed,80);assert.equal(row.returnOnEquity,0.25);assert.equal(row.leverage,5);assert.equal(row.leverageType,'isolated');
  const [missing] = matchingPosition({assetPositions:[{position:{coin:'BTC',szi:'1',positionValue:'100',entryPx:'',unrealizedPnl:'NaN'}}]},'BTC');
  assert.equal(missing.entryPx,null);assert.equal(missing.unrealizedPnl,null);assert.equal(missing.leverage,null);
});
test('200 candidate cap, duplicate-task reuse, exact market scope, failed reads remain unknown', async () => {
  const calls=[];
  const validator = createValidator({ candidates:()=>[wallet(1),wallet(1),...Array.from({length:205},(_,i)=>wallet(i+2))], pause:async()=>{}, request:async body=>{
    calls.push(body);
    if(body.type==='meta')return {universe:[{name:'xyz:SNDK'}]};
    if(body.user===wallet(2).address)throw new Error('unavailable');
    const short=body.user===wallet(3).address;
    return {assetPositions:[{position:{coin:'xyz:SNDK',szi:short?'-2':'1',positionValue:short?'200':'100'}},{position:{coin:'para:SNDK',szi:'1',positionValue:'9999'}}]};
  }});
  const job=validator.start('xyz:SNDK');
  assert.equal(validator.start('xyz:SNDK'),job);
  assert.throws(()=>validator.start('BTC','normal','other'),/运行/);
  await flush(job);
  assert.equal(job.total,200);assert.equal(job.success,199);assert.equal(job.failed,1);assert.equal(job.status,'partial');
  assert.equal(job.longUsd,19800);assert.equal(job.shortUsd,200);assert.equal(job.longCount,198);assert.equal(job.shortCount,1);
  assert.equal(calls.length,201);assert.ok(calls.every(c=>c.dex==='xyz'));
});
test('unknown market or malformed responses never become successful zero holdings', async()=>{
  assert.throws(()=>matchingPosition({},'BTC'));
  assert.throws(()=>matchingPosition({assetPositions:[{position:{coin:'BTC',szi:'bad',positionValue:'2'}}]},'BTC'));
  const v=createValidator({candidates:()=>[wallet(1)],pause:async()=>{},request:async()=>({universe:[]})});
  const job=v.start('SNDK');await flush(job);assert.equal(job.status,'error');assert.equal(job.success,0);
});
test('successful snapshots reuse cache and correctly report a zero-position account', async()=>{
  let count=0;
  const v=createValidator({candidates:()=>[wallet(1)],pause:async()=>{},request:async body=>{count++;return body.type==='meta'?{universe:[{name:'BTC'}]}:{assetPositions:[]};}});
  const job=v.start('BTC');await flush(job);assert.equal(job.status,'complete');assert.equal(job.success,1);assert.equal(job.positions.length,0);
  assert.equal(v.start('BTC'),job);assert.equal(count,2);
});

test('deep selection validates, deduplicates and caps by account value',()=>{
 const {selectDeepCandidates}=require('../lib/whaleValidation');
 const rows=Array.from({length:1010},(_,i)=>({ethAddress:wallet(i+1).address,accountValue:1000000+i,windowPerformances:[['week',{vlm:'1'}]]}));
 rows.push({...rows[0]}, {...rows[0],ethAddress:'bad'}, {...rows[0],ethAddress:wallet(5000).address,accountValue:999999}, {...rows[0],ethAddress:wallet(5001).address,windowPerformances:[['week',{vlm:0}]]});
 const result=selectDeepCandidates(rows);assert.equal(result.eligible,1010);assert.equal(result.pool.length,1000);assert.equal(result.pool[0].address,wallet(1010).address);
});
test('deep lock precedes leaderboard fetch; ownership and restoration are enforced',async()=>{
 let release;
 const v=createValidator({leaderboard:()=>new Promise(r=>{release=r;}),pause:async()=>{},request:async body=>body.type==='meta'?{universe:[{name:'BTC'}]}:{assetPositions:[]}});
 const job=v.start('BTC','deep','alice');assert.equal(v.isDeepRunning(),true);
 assert.throws(()=>v.start('BTC','deep','bob'),/其他用户正在进行深度验证/);
 assert.throws(()=>v.stop(job.id,'bob'),e=>e.status===403);
 assert.equal(v.start('ETH','normal','alice'),job);assert.equal(v.latest('alice'),job);assert.equal(v.latest('bob'),undefined);
 v.stop(job.id,'alice');assert.equal(v.isDeepRunning(),false);release({pool:[wallet(1)],eligible:1,at:1});await new Promise(setImmediate);assert.equal(job.success,0);
});
test('deep failure and timeout always restore normal capture state',async()=>{
 const failed=createValidator({leaderboard:async()=>{throw Error('offline');}});const a=failed.start('BTC','deep','a');await flush(a);assert.equal(a.status,'error');assert.equal(failed.isDeepRunning(),false);
 const timed=createValidator({timeoutMs:10,leaderboard:async signal=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted'))))});
 const b=timed.start('BTC','deep','a');await new Promise(r=>setTimeout(r,25));assert.equal(b.status,'error');assert.equal(timed.isDeepRunning(),false);
});
test('deep results paginate and normal/deep caches cannot substitute each other',async()=>{
 let clock=100000,boards=0;
 const v=createValidator({now:()=>clock,pause:async()=>{},candidates:()=>[wallet(1)],leaderboard:async()=>{boards++;return {eligible:150,pool:Array.from({length:150},(_,i)=>wallet(i+1)),at:clock};},request:async body=>body.type==='meta'?{universe:[{name:'BTC'}]}:{assetPositions:[{position:{coin:'BTC',szi:'1',positionValue:'2'}}]}});
 const normal=v.start('BTC','normal','a');await flush(normal);clock+=61000;
 const deep=v.start('BTC','deep','a');await flush(deep);assert.equal(deep.success,150);assert.equal(boards,1);assert.notEqual(deep.id,normal.id);
 const first=v.view(deep,'b',0),second=v.view(deep,'b',100);assert.equal(first.positions.length,100);assert.equal(second.positions.length,50);assert.equal(first.canStop,false);assert.equal(first.owner,undefined);assert.equal(v.start('BTC','deep','b'),deep);
});
test('stopping during backoff releases the global slot without waiting for the sleep',async()=>{
 let clock=100000,entered=false;
 const v=createValidator({now:()=>clock,candidates:()=>[wallet(1)],pause:()=>{entered=true;return new Promise(()=>{});},request:async()=>({universe:[{name:'BTC'}]})});
 const first=v.start('BTC','normal','a');while(!entered)await new Promise(setImmediate);
 v.stop(first.id,'a');await new Promise(setImmediate);clock+=61000;
 const next=v.start('BTC','normal','b');assert.notEqual(next.id,first.id);v.stop(next.id,'b');
});
