const test=require('node:test'),assert=require('node:assert/strict');
const {createPositionCache}=require('../lib/validationPositionCache');
const {createValidator}=require('../lib/whaleValidation');
const address='0x'+'1'.repeat(40);
const state=(entries)=>({assetPositions:entries.map(([coin,szi,entryPx])=>({position:{coin,szi,entryPx,positionValue:String(Math.abs(Number(szi))*100)}}))});
const finish=async job=>{for(let i=0;i<100&&job.status==='running';i++)await new Promise(setImmediate);assert.equal(job.status,'complete');};
test('snapshots separate markets and expire at one hour; malformed states never enter cache',()=>{
 let clock=100;const cache=createPositionCache({now:()=>clock});
 cache.put(address,'xyz',state([['xyz:SNDK','1','50']]));cache.put(address,'',state([['ETH','1','80']]));
 assert.equal(cache.get(address.toUpperCase(),'XYZ').state.assetPositions[0].position.coin,'xyz:SNDK');
 assert.equal(cache.get(address,'').state.assetPositions[0].position.coin,'ETH');
 assert.equal(cache.get(address,'para'),null);
 assert.throws(()=>cache.put(address,'para',{}));assert.throws(()=>cache.put(address,'para',{assetPositions:[{position:{coin:'x',szi:'bad',positionValue:'1'}}]}));
 clock+=3600000;assert.equal(cache.get(address,'xyz'),null);assert.equal(cache.stats().entries,0);
});
test('LRU bounds snapshot count and total bytes',()=>{
 const cache=createPositionCache({maxEntries:2,maxBytes:1024});
 cache.put('a','',state([]));cache.put('b','',state([]));cache.get('a','');cache.put('c','',state([]));
 assert.equal(cache.get('b',''),null);assert.equal(cache.stats().entries,2);assert.ok(cache.stats().bytes<=1024);
 const tiny=createPositionCache({maxBytes:1});tiny.put('a','',state([]));assert.equal(tiny.stats().entries,0);
});
test('same-market cross-symbol validation reuses full snapshot, preserves sample time; force refresh replaces it',async()=>{
 let clock=100000,reads=0,current=state([['xyz:SNDK','2','50'],['xyz:NVDA','1','80']]);
 const v=createValidator({now:()=>clock,cooldownMs:0,pause:async()=>{},leaderboard:async()=>({}),candidates:()=>[{address}],request:async body=>{
  if(body.type==='meta')return {universe:[{name:'xyz:SNDK'},{name:'xyz:NVDA'},{name:'ETH'}]};
  reads++;return body.dex==='xyz'?current:state([['ETH','1','70']]);
 }});
 const first=v.start('xyz:SNDK');await finish(first);assert.equal(reads,1);assert.equal(first.freshReads,1);
 clock+=1000;const second=v.start('xyz:NVDA','normal','test',undefined,false,null,true);await finish(second);
 assert.equal(reads,1);assert.equal(second.cacheHits,1);assert.equal(second.positions[0].observedAt,100000);assert.equal(second.longEntryPx,80);
 const eth=v.start('ETH','normal','test',undefined,false,null,true);await finish(eth);assert.equal(reads,2);assert.equal(eth.cacheHits,0);
 current=state([['xyz:SNDK','1','90'],['xyz:NVDA','1','95']]);
 const fresh=v.start('xyz:SNDK');await finish(fresh);assert.equal(reads,3);assert.equal(fresh.positions[0].entryPx,90);
 const replaced=v.start('xyz:NVDA','normal','test',undefined,false,null,true);await finish(replaced);assert.equal(reads,3);assert.equal(replaced.positions[0].entryPx,95);
 clock+=3600000;const expired=v.start('xyz:SNDK','normal','test',undefined,false,null,true);await finish(expired);assert.equal(reads,4);assert.equal(expired.cacheHits,0);
});
test('weighted entry average uses quantities separately per side; null entry is excluded',async()=>{
 const accounts=[1,2,3,4].map(n=>({address:'0x'+String(n).repeat(40)}));
 const data=[state([['ETH','1','100']]),state([['ETH','3','200']]),state([['ETH','-2','50']]),state([['ETH','2',null]])];
 const v=createValidator({cooldownMs:0,pause:async()=>{},leaderboard:async()=>({}),candidates:()=>accounts,request:async body=>body.type==='meta'?{universe:[{name:'ETH'}]}:data[accounts.findIndex(a=>a.address===body.user)]});
 const job=v.start('ETH');await finish(job);assert.equal(job.longEntryPx,175);assert.equal(job.shortEntryPx,50);assert.equal(job.longUsd,600);
});
test('queued validation retains chosen cache mode',async()=>{
 let release;const v=createValidator({cooldownMs:0,pause:async()=>{},leaderboard:()=>new Promise(r=>release=r),candidates:()=>[{address}],request:async body=>body.type==='meta'?{universe:[{name:'ETH'}]}:state([])});
 const active=v.start('ETH');const queued=v.start('ETH','normal','other',undefined,true,null,true);assert.equal(queued.useCache,true);
 v.stop(queued.id,'other');v.stop(active.id);release({});await new Promise(setImmediate);
});

test('1000 cached accounts avoid upstream position requests and remain cancellable',async()=>{
 const cache=createPositionCache(),pool=Array.from({length:1000},(_,i)=>({address:'0x'+i.toString(16).padStart(40,'0')}));
 for(const a of pool)cache.put(a.address,'',state([['ETH','1','50']]));
 let requests=0,delays=0;
 const v=createValidator({cooldownMs:0,positionCache:cache,leaderboard:async()=>({pool,eligible:1000}),pause:async()=>{delays++;},request:async body=>{requests++;assert.equal(body.type,'meta');return {universe:[{name:'ETH'}]};}});
 const job=v.start('ETH','deep','test',undefined,false,null,true);await finish(job);
 assert.equal(job.cacheHits,1000);assert.equal(job.freshReads,0);assert.equal(requests,1);assert.equal(delays,0);assert.equal(job.longEntryPx,50);
 const stopped=v.start('ETH','deep','test',undefined,false,null,true);await new Promise(setImmediate);v.stop(stopped.id);await new Promise(setImmediate);
 assert.equal(stopped.status,'stopped');assert.ok(stopped.success<1000);
});
