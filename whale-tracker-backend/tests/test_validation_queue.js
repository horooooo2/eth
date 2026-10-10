const test=require('node:test'),assert=require('node:assert/strict');
const {createValidator}=require('../lib/whaleValidation');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function fixture(){
 const requests=[];
 const v=createValidator({cooldownMs:20,pause:async()=>{},candidates:()=>[{address:'0x'+'1'.repeat(40)}],request:body=>new Promise(resolve=>requests.push({body,resolve}))});
 return {v,requests};
}
test('FIFO starts automatically, one queued task per owner, no jumping ahead',async()=>{
 const {v,requests}=fixture();const first=v.start('BTC','normal','a');
 const second=v.start('ETH','normal','b',undefined,true);
 const third=v.start('SOL','normal','c',undefined,true);
 assert.equal(second.status,'queued');assert.equal(v.view(third,'c').queuePosition,2);
 assert.equal(v.start('BTC','normal','b',undefined,true),second);
 assert.throws(()=>v.start('BTC','normal','d'),e=>e.queueable===true);
 assert.throws(()=>v.stop(second.id,'c'),e=>e.status===403);
 v.stop(first.id,'a');requests[0].resolve({universe:[]});await sleep(35);
 assert.equal(second.status,'running');assert.equal(third.status,'queued');assert.equal(requests.length,2);
 v.stop(second.id,'b');requests[1].resolve({universe:[]});await sleep(35);
 assert.equal(third.status,'running');assert.equal(requests.length,3);
 v.stop(third.id,'c');requests[2].resolve({universe:[]});await sleep(1);
});
test('cooldown exposes queue button flag; cancelled queue never starts',async()=>{
 const {v,requests}=fixture();const first=v.start('BTC','normal','a');
 v.stop(first.id,'a');requests[0].resolve({universe:[]});await sleep(1);
 assert.throws(()=>v.start('ETH','normal','b'),e=>e.status===429&&e.queueable);
 const queued=v.start('ETH','normal','b',undefined,true);
 assert.equal(v.latest('b'),queued);assert.equal(queued.status,'queued');
 v.stop(queued.id,'b');await sleep(30);
 assert.equal(queued.status,'stopped');assert.equal(requests.length,1);
});
