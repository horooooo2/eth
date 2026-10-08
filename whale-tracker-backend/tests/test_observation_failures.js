process.env.WHALE_OBSERVATIONS_ENABLED='1';
const test=require('node:test');
const assert=require('node:assert/strict');
require('./helpers/isolateSqlite');
const {getDb,setMeta}=require('../lib/db');
const store=require('../lib/whaleObservationStore');
const compute=require('../lib/observationCompute');
const originalFactory=compute.createComputeRunner;
let failure='collective';
compute.createComputeRunner=()=>{
  const runner=originalFactory();
  return {run:(kind,...args)=>kind===failure?Promise.reject(Error(`forced ${kind} failure`)):runner.run(kind,...args),stop:()=>runner.stop(),getStatus:()=>runner.getStatus()};
};
const hub=require('../lib/realtimeHub'),messages=[];
hub.broadcastObservations=()=>messages.push(require('../lib/whaleObservationWorker').snapshot());
const now=Math.floor(Date.now()/3600000)*3600000-30*60000;
function seed(id) {
  for(let i=0;i<3;i++)store.recordInput(getDb(),{id:`${id}-${i}`,whaleId:id,asset:'BTC',side:'buy',
    startPosition:i*2,amount:2,price:100000,time:now-900000+i*300000},now);
}
test('collective failure does not suppress pair commits, and retries have a backoff',async()=>{
  setMeta('observation_seeded_v1','1');seed('failure-first');
  const worker=require('../lib/whaleObservationWorker');
  try {
    await worker.tick();
    assert.ok(worker.snapshot().rows.some(r=>r.whaleId==='failure-first'));
    assert.match(worker.snapshot().error,/集体观察/);
    assert.equal(worker.getStatus().pendingPairs,0);
    assert.equal(worker.getStatus().failedRuns,1);
    assert.ok(messages.some(m=>m.type==='observationSnapshot'&&m.rows.some(r=>r.whaleId==='failure-first')&&!m.error));
    seed('failure-second');await worker.tick();
    assert.ok(worker.snapshot().rows.some(r=>r.whaleId==='failure-second'));
    assert.equal(worker.getStatus().failedRuns,1);
    assert.match(worker.snapshot().error,/集体观察/);
  }finally{worker.stop();}
});
test('restart exposes durable summaries even when its first pair calculation fails',async()=>{
  failure='pair';seed('failure-third');
  delete require.cache[require.resolve('../lib/whaleObservationWorker')];
  const worker=require('../lib/whaleObservationWorker');
  try {
    assert.equal(worker.snapshot().rows.length,0);
    await worker.tick();
    assert.ok(worker.snapshot().rows.some(r=>r.whaleId==='failure-first'));
    assert.ok(worker.snapshot().rows.some(r=>r.whaleId==='failure-second'));
    assert.equal(worker.getStatus().pendingPairs,1);
    assert.match(worker.snapshot().error,/暂未更新/);
  }finally{worker.stop();compute.createComputeRunner=originalFactory;}
});
