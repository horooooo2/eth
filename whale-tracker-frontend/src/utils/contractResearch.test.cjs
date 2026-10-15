const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ts=require('typescript'),vue=require('vue');
function setup(coins,saved='SNDKUSDT'){
  const preferences=vue.ref(coins),requests=[],cleanup=[],scope=vue.effectScope();
  const http={
    async get(url,options={}){
      requests.push({url,params:options.params});
      if(url==='/research/catalog')return {data:{contracts:['BTCUSDT','ETHUSDT','SNDKUSDT'].map(symbol=>({symbol})),stale:false}};
      if(url==='/research/latest')return {data:{item:null}};
      if(url==='/research/snapshot')return {data:{id:options.params.symbol,symbol:options.params.symbol,horizon:options.params.horizon,events:[],sources:[]}};
      throw Error('Unexpected endpoint '+url);
    },
    async post(url){assert.equal(url,'/research/alerts');return {data:{alerts:[],thresholds:[]}};},
  };
  const exports={},source=fs.readFileSync(path.join(__dirname,'../composables/useContractResearch.ts'),'utf8');
  const modules={vue:{...vue,onUnmounted:fn=>cleanup.push(fn)},'@/api':{http},'@/utils/watchedCoins':{preferredCoinsState:preferences}};
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
    exports,require:name=>{assert.ok(modules[name],name);return modules[name];},
    localStorage:{getItem:()=>saved,setItem(){}},document:{visibilityState:'visible',addEventListener(){},removeEventListener(){}},
    AbortController,setTimeout,clearTimeout,console,
  });
  const model=scope.run(()=>exports.useContractResearch(vue.ref(true)));
  return {model,preferences,requests,close(){cleanup.forEach(fn=>fn());scope.stop();}};
}
async function settle(){for(let i=0;i<5;i++){await vue.nextTick();await new Promise(resolve=>setImmediate(resolve));}}

test('research uses preference order, ignores retired saved symbols, and reads only the selected contract at 30 days',async()=>{
  const app=setup(['ETH','BTC','ETH','NOTLISTED']);
  try{
    await settle();
    assert.deepEqual(Array.from(app.model.quickAssets),['ETHUSDT','BTCUSDT']);
    assert.equal(app.model.symbol,'ETHUSDT');assert.equal(app.model.horizon,30);
    const snapshots=app.requests.filter(r=>r.url==='/research/snapshot');
    assert.equal(snapshots.length,1);assert.equal(snapshots[0].params.horizon,30);
    assert.equal(snapshots[0].params.symbol,'ETHUSDT');
    app.model.select('SNDKUSDT');assert.equal(app.model.symbol,'ETHUSDT');
    app.preferences.value=['BTC','SNDK'];await settle();
    assert.deepEqual(Array.from(app.model.quickAssets),['BTCUSDT','SNDKUSDT']);assert.equal(app.model.symbol,'BTCUSDT');
    app.model.select('SNDKUSDT');await settle();assert.equal(app.model.current.symbol,'SNDKUSDT');
    assert.ok(app.requests.filter(r=>r.url==='/research/snapshot').every(r=>r.params.horizon===30));
  }finally{app.close();}
});

test('unavailable preferences clear the selected snapshot instead of retaining a removed asset',async()=>{
  const app=setup(['NOTLISTED','BTC']);
  try{
    await settle();assert.ok(app.model.current,JSON.stringify({symbol:app.model.symbol,pending:app.model.pending,error:app.model.error,requests:app.requests}));assert.equal(app.model.current.symbol,'BTCUSDT');
    assert.ok(app.requests.filter(r=>r.url==='/research/snapshot').every(r=>r.params.symbol!=='NOTLISTEDUSDT'));
    app.preferences.value=['NOTLISTED'];await settle();
    assert.equal(app.model.symbol,'');assert.equal(app.model.current,null);assert.equal(app.model.pending,false);
    const before=app.requests.length;await app.model.load();assert.equal(app.requests.length,before);
    app.preferences.value=['ETH'];await settle();assert.equal(app.model.current.symbol,'ETHUSDT');
  }finally{app.close();}
});
