const test=require('node:test'),assert=require('node:assert/strict');
const {createValidator}=require('../lib/whaleValidation');
test('restart requires stopped task owner, uses fresh snapshot, and cannot be replayed',async()=>{
 let releases=[];
 const v=createValidator({candidates:()=>[{address:'0x'+'1'.repeat(40)}],pause:async()=>{},request:()=>new Promise(resolve=>releases.push(resolve))});
 const first=v.start('BTC','normal','alice');v.stop(first.id,'alice');
 assert.throws(()=>v.start('BTC','normal','bob',first.id),e=>e.status===403);
 const next=v.start('BTC','normal','alice',first.id);assert.notEqual(next.id,first.id);assert.equal(next.success,0);assert.equal(next.positions.length,0);
 assert.throws(()=>v.start('BTC','normal','alice',first.id),e=>e.status===403);
 releases[0]({universe:[{name:'BTC'}]});await new Promise(setImmediate);
 assert.throws(()=>v.start('BTC','normal','bob'),e=>e.status===409);
 v.stop(next.id,'alice');releases[1]({universe:[{name:'BTC'}]});
});
