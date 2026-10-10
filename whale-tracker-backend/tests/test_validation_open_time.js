const test=require('node:test'), assert=require('node:assert/strict');
const {inferOpenTime,createOpenTimeReader}=require('../lib/validationOpenTime');
const position={address:'0x'+'a'.repeat(40),observedAt:1000,side:'long',size:3};
const fill=(time,startPosition,sz,side='B',coin='xyz:SNDK')=>({time,tid:time,startPosition:String(startPosition),sz:String(sz),side,coin});
test('opening survives adds and reductions, excludes other markets and future fills',()=>{
 const rows=[fill(100,0,2),fill(200,2,2),fill(300,4,1,'A'),fill(1100,3,3,'A'),fill(400,0,3,'B','para:SNDK')];
 assert.equal(inferOpenTime(rows,'xyz:SNDK',position),100);
});
test('reversal is a new opening; missing history or discontinuity remains unknown',()=>{
 assert.equal(inferOpenTime([fill(100,-2,5)],'xyz:SNDK',position),100);
 assert.equal(inferOpenTime([fill(100,2,1)],'xyz:SNDK',position),null);
 assert.equal(inferOpenTime([fill(100,0,3),fill(200,1,2)],'xyz:SNDK',position),null);
 assert.equal(inferOpenTime([fill(100,0,2)],'xyz:SNDK',position),null);
 assert.equal(inferOpenTime([fill(100,0,3,'A')],'xyz:SNDK',{...position,side:'short'}),100);
});
test('same-account requests coalesce, reuse cache; other accounts cannot bypass global limit',async()=>{
 let resolve,calls=0,clock=1100;
 const read=createOpenTimeReader({now:()=>clock,request:(_,retries,options)=>{calls++;assert.equal(retries,0);assert.equal(options.priority,'history');return new Promise(r=>resolve=r);}});
 const a=read('xyz:SNDK',position),b=read('xyz:SNDK',position);
 await assert.rejects(read('BTC',{...position,address:'0x'+'b'.repeat(40)}),{status:429});
 resolve([fill(100,0,3)]);assert.equal((await a).openTime,100);await b;assert.equal(calls,1);
 await read('xyz:SNDK',position);await read('para:SNDK',position);assert.equal(calls,1);
 await assert.rejects(read('BTC',{...position,address:'0x'+'b'.repeat(40)}),{status:429});
});
test('timeout aborts request, releases slot and does not cache failure',async()=>{
 let calls=0;
 const read=createOpenTimeReader({intervalMs:0,timeoutMs:5,request:(_,r,{signal})=>{calls++;if(calls>1)return Promise.resolve([]);return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))));}});
 await assert.rejects(read('xyz:SNDK',position),/aborted/);
 assert.equal((await read('xyz:SNDK',position)).openTime,null);assert.equal(calls,2);
});
