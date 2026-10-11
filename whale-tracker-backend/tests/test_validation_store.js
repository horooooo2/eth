const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createValidationStore}=require('../lib/validationStore');
const {createValidator,matchingPosition}=require('../lib/whaleValidation');
test('completed snapshots survive restart, replace same symbol and expire after 24 hours',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'validation-store-test-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 let clock=100000;const store=createValidationStore(dir,()=>clock);
 const old={id:'old',coin:'xyz:SNDK',owner:'alice',mode:'deep',status:'complete',startedAt:clock-10,finishedAt:clock,positions:[{address:'wallet',size:1,usd:200}],failures:[]};
 await store.save(old);
 const restored=createValidator({store,now:()=>clock});await restored.ready;
 assert.equal(restored.history()[0].id,'old');assert.equal(restored.view(restored.get('old'),'alice').positions[0].usd,200);
 await store.save({...old,id:'new',status:'partial',finishedAt:++clock});
 assert.deepEqual((await store.load()).map(x=>x.id),['new']);
 clock+=86400000;assert.equal((await store.load()).length,0);assert.equal((await fs.readdir(dir)).length,0);
});
test('completed validation writes snapshot and disk errors do not destroy results',async()=>{
 for(const fails of [false,true]){
  let saved;const v=createValidator({store:{load:async()=>[],save:async job=>{if(fails)throw Error('disk full');saved=job;}},leaderboard:async()=>({}),pause:async()=>{},candidates:()=>[{address:'0x'+'1'.repeat(40)}],request:async body=>body.type==='meta'?{universe:[{name:'BTC'}]}:{assetPositions:[{position:{coin:'BTC',szi:'-2',positionValue:'200',entryPx:'120'}}]}});
  await v.ready;const job=v.start('BTC');for(let n=0;n<20;n++)await new Promise(setImmediate);
  assert.equal(job.status,'complete');assert.equal(job.positions[0].currentPx,100);
  if(fails)assert.ok(job.persistenceError);else assert.equal(saved.id,job.id);
 }
});
test('sample price uses absolute quantity for both directions and preserves missing entry',()=>{
 for(const szi of ['2','-2']){
  const [p]=matchingPosition({assetPositions:[{position:{coin:'BTC',szi,positionValue:'200'}}]},'BTC');
  assert.equal(p.currentPx,100);assert.equal(p.entryPx,null);
 }
});
