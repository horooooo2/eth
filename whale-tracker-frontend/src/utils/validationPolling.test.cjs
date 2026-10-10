const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function fixture(get){
 const exports={};const timers=new Map();let timerId=0;
 const ref=value=>({value});const computed=fn=>({get value(){return fn();}});
 const source=fs.readFileSync(__dirname+'/../components/WhaleValidation.vue','utf8').split('<script setup lang="ts">')[1].split('</script>')[0]+ '\nObject.assign(exports,{poll,accept,job,visible,chooser,choose});';
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports,defineProps:()=>({coin:'BTC'}),require:name=>name==='vue'?{ref,computed,watch(){},onMounted(){},onUnmounted(){}}:name==='@/api'?{http:{get}}:{},setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id)});
 exports.visible.value=true;exports.job.value={id:'a',status:'running',canStop:true,positions:[]};return {...exports,timers};
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
