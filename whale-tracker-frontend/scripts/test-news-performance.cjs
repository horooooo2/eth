const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ts=require('typescript'),{parse,compileScript}=require('@vue/compiler-sfc'),vue=require('vue');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function mount(file,props,modules){
  const timers=new Map(),dispose=[];let id=0;
  const descriptor=parse(fs.readFileSync(path.join(__dirname,'../src/components',file),'utf8')).descriptor;
  const code=ts.transpileModule(compileScript(descriptor,{id:'test'}).content,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const context={exports:{},AbortController,Date,URL,requestAnimationFrame:()=>++id,cancelAnimationFrame:()=>{},setTimeout:(fn,delay)=>{timers.set(++id,{fn,delay});return id},clearTimeout:n=>timers.delete(n),setInterval:(fn,delay)=>{timers.set(++id,{fn,delay});return id},clearInterval:n=>timers.delete(n),require:n=>n==='vue'?{...vue,onUnmounted:fn=>dispose.push(fn)}:modules[n]||{}};
  vm.runInNewContext(code,context);
  const scope=vue.effectScope(),reactiveProps=vue.reactive(props);
  const state=scope.run(()=>context.exports.default.setup(reactiveProps,{expose:()=>{}}));
  return {state,props:reactiveProps,timers,close:()=>{dispose.forEach(fn=>fn());scope.stop()}};
}
test('news switches immediately; obsolete completion cannot overwrite loading or latest result',async()=>{
  const requests=[];
  const app=mount('MarketNews.vue',{active:true},{'@/api':{http:{get:(url,config)=>new Promise(resolve=>requests.push({url,config,resolve}))}},'@/utils/radarRealtime':{radarClient:{state:vue.ref(null)}},'@/utils/newsWatch':{newsWatch:vue.ref(['NVDAUSDT'])},'@/utils/watchedCoins':{preferredCoinsState:vue.ref([])}});
  try{
    app.state.symbol.value='NVDAUSDT';await tick();assert.equal(requests.length,2);assert.equal(requests[0].config.signal.aborted,true);
    requests[0].resolve({data:{articles:[{title:'old',url:'https://example.com'}]}});await tick();assert.equal(app.state.pending.value,true);assert.equal(app.state.cache.value.all,undefined);
    requests[1].resolve({data:{items:[{title:'new',url:'https://example.com/new'}]}});await tick();assert.equal(app.state.rows.value[0].title,'new');
    app.props.active=false;await tick();assert.equal(app.timers.size,0);app.props.active=true;await tick();assert.equal(requests.length,2);
  }finally{app.close()}
});
test('comments reuse fresh cache and stop timers while inactive',async()=>{
  let calls=0;
  const app=mount('MarketComments.vue',{active:true,symbol:'NVDAUSDT'},{'@/api':{http:{get:async()=>{calls++;return {data:{items:[],supported:true,pending:false,updatedAt:Date.now()}}}}}});
  try{await tick();app.props.active=false;await tick();assert.equal(app.timers.size,0);app.props.active=true;await tick();assert.equal(calls,1);assert.equal(app.timers.size,1);}finally{app.close()}
});
test('leaving news aborts AI, cancels timer and ignores late chunks',async()=>{
  let handlers,finish,prunes=0;
  const app=mount('NewsAiChat.vue',{active:true,symbol:'NVDAUSDT',url:'article',title:'news',summary:'summary',publishedAt:null},{
    '@/stores/aiKey':{aiKeyReady:vue.ref(true)},'@/stores/auth':{authUser:vue.ref({id:'one'})},'@/utils/radarRealtime':{radarClient:{state:vue.ref(null)}},
    '@/utils/newsChatHistory':{chatKey:()=> 'key',cleanNewsChat:m=>m,readNewsChat:()=>[],saveNewsChat:()=>{},pruneNewsChats:()=>prunes++},
    '@/api':{streamChatMarketBrief:(_,h)=>{handlers=h;return new Promise(resolve=>finish=resolve)}}
  });
  try{app.state.input.value='question';const send=app.state.send();assert.equal(app.timers.size,1);app.props.active=false;await tick();assert.equal(handlers.signal.aborted,true);assert.equal(app.timers.size,0);handlers.onDelta('late');finish();await send;assert.equal(app.state.reply.value,'');assert.equal(app.state.messages.value.length,1);assert.equal(prunes,1);}finally{app.close()}
});
