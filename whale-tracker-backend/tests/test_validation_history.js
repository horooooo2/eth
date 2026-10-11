const test=require('node:test'),assert=require('node:assert/strict');
const {createValidator}=require('../lib/whaleValidation');
test('completed snapshots survive other symbols, expire at 24h, and same-symbol results replace old snapshots',async()=>{
 let clock=1000000;
 const v=createValidator({now:()=>clock,cooldownMs:0,pause:async()=>{},candidates:()=>[{address:'0x'+'1'.repeat(40)}],request:async body=>body.type==='meta'?{universe:[{name:'BTC'},{name:'ETH'}]}:{assetPositions:[]}});
 const first=v.start('BTC','normal','a');await new Promise(setImmediate);
 clock+=3600000;assert.equal(v.get(first.id).status,'complete');assert.equal(v.history().length,1);
 const second=v.start('ETH','normal','b');await new Promise(setImmediate);
 assert.equal(v.history().length,2);
 const replaced=v.start('BTC','normal','a');await new Promise(setImmediate);
 assert.equal(v.get(first.id),undefined);assert.equal(v.get(replaced.id).status,'complete');assert.equal(v.history().length,2);
 clock+=86400000;assert.equal(v.get(second.id),undefined);assert.equal(v.history().length,0);
});
