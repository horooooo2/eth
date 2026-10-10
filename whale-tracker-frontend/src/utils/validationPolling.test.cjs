const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function fixture(get,post){
 const exports={};const timers=new Map();let timerId=0,mount;
 const ref=value=>({value});const computed=fn=>({get value(){return fn();}});
 const source=fs.readFileSync(__dirname+'/../components/WhaleValidation.vue','utf8').split('<script setup lang="ts">')[1].split('</script>')[0]+ '\nObject.assign(exports,{poll,accept,job,visible,minimized,chooser,choose,togglePosition,timingState,start,queueRequest});';
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports,defineProps:()=>({coin:'BTC'}),require:name=>name==='vue'?{ref,computed,watch(){},onMounted(fn){mount=fn;},onUnmounted(){}}:name==='@/api'?{http:{get,post}}:{},setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id)});
 exports.visible.value=true;exports.job.value={id:'a',status:'running',canStop:true,positions:[]};return {...exports,timers,mount};
}
test('expired and unauthorized tasks stop polling and allow mode chooser again',async()=>{
 for(const status of [401,403,404]){
  const f=fixture(async()=>{throw Object.assign(new Error('expired'),{status});});await f.poll('a',0);
  assert.equal(f.job.value.status,'error');assert.equal(f.job.value.canStop,false);assert.equal(f.timers.size,0);f.choose();assert.equal(f.chooser.value,true);
 }
});
test('manual retry cannot duplicate an in-flight progress request',async()=>{
 let count=0,release;const f=fixture(()=>{count++;return new Promise(r=>{release=r;});});
 const first=f.poll('a',0);await f.poll('a',0);assert.equal(count,1);
 release({data:{id:'a',status:'running',offset:0,nextOffset:0,positionTotal:0,positions:[]}});await first;assert.equal(f.timers.size,1);
});
test('incremental pages merge and a new task replaces the old snapshot',()=>{
 const f=fixture();f.accept({id:'a',offset:0,positions:[{address:'1'}]});f.accept({id:'a',offset:1,positions:[{address:'2'}]});assert.equal(f.job.value.positions.length,2);
 f.accept({id:'b',offset:0,positions:[]});assert.equal(f.job.value.positions.length,0);
});

test('refresh does not reopen stopped, completed or failed tasks',async()=>{
 for(const status of ['stopped','complete','partial','error']){
  let calls=0;const f=fixture(async()=>{calls++;return {data:{id:'old',status,finishedAt:Date.now(),positions:[],offset:0,nextOffset:0,positionTotal:0}};});
  f.visible.value=false;f.job.value=null;await f.mount();
  assert.equal(f.visible.value,false);assert.equal(f.minimized.value,false);assert.equal(f.job.value,null);assert.equal(calls,1);assert.equal(f.timers.size,0);
 }
});
test('refresh restores and polls a running task',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return {data:{id:'active',status:'running',positions:[],offset:0,nextOffset:0,positionTotal:0}};});
 f.visible.value=false;f.job.value=null;await f.mount();await Promise.resolve();
 assert.equal(f.minimized.value,true);assert.equal(f.job.value.id,'active');assert.equal(calls,2);assert.equal(f.timers.size,1);
});

test('opening-time lookup is lazy, deduplicated and ignores another job response',async()=>{
 let calls=0,resolve;const f=fixture(()=>{calls++;return new Promise(r=>resolve=r);});
 const row={address:'wallet',side:'long'};f.job.value.positions=[row];
 const first=f.togglePosition(row);await f.togglePosition(row);await f.togglePosition(row);assert.equal(calls,1);
 resolve({data:{openTime:123}});await first;assert.equal(row.openTime,123);
 await f.togglePosition(row);await f.togglePosition(row);assert.equal(calls,1);
 const other={address:'other',side:'short'};f.job.value.positions.push(other);
 const late=f.togglePosition(other);f.job.value={id:'new',positions:[]};resolve({data:{openTime:456}});await late;
 assert.equal(other.openTime,undefined);assert.equal(f.job.value.positions.length,0);
});

test('queue is explicit after a queueable error and retains requested symbol and mode',async()=>{
 const requests=[];const f=fixture(undefined,async(url,body)=>{requests.push(body);if(!body.enqueue)throw Object.assign(new Error('busy'),{details:{queueable:true}});return {data:{id:'queued',status:'queued',offset:0,nextOffset:0,positionTotal:0,positions:[]}};});
 f.job.value=null;await f.start('deep','xyz:SNDK');assert.equal(f.queueRequest.value.coin,'xyz:SNDK');assert.equal(requests.length,1);
 await f.start(f.queueRequest.value.mode,f.queueRequest.value.coin,undefined,true);
 assert.equal(f.job.value.status,'queued');assert.equal(requests[1].enqueue,true);assert.equal(f.timers.size,1);
});
test('refresh restores a queued task and continues status polling',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return {data:{id:'q',status:'queued',queuePosition:2,positions:[],offset:0,nextOffset:0,positionTotal:0}};});
 f.job.value=null;await f.mount();await Promise.resolve();assert.equal(f.minimized.value,true);assert.equal(f.job.value.status,'queued');assert.equal(calls,2);
});
