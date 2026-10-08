const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const ts=require('typescript');
test('settings changed during a save are sent next, while a failed save is retried',async()=>{
  const preferred={value:['BTC']},saved=[],timers=new Map();let id=0,complete;
  const exports={};
  const api={saveAuthSettings:payload=>{saved.push(JSON.parse(JSON.stringify(payload)));return new Promise((resolve,reject)=>{complete={resolve,reject};});}};
  const modules={
    vue:{ref:value=>({value}),computed:fn=>({get value(){return fn();}}),watch(){}},
    '@/api':api,
    '@/utils/monitoredWhales':{monitoredWhaleIds:{value:[]}},
    '@/utils/watchedCoins':{preferredCoinsState:preferred},
    '@/utils/alertView':{readAlertMinUsd:()=>10000},
    '@/utils/alertSound':{alertSoundEnabled:{value:false}},
  };
  const code=fs.readFileSync(path.join(__dirname,'../stores/auth.ts'),'utf8');
  vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{
    exports,require:name=>{assert.ok(modules[name],name);return modules[name];},
    localStorage:{getItem:key=>key==='whale-tracker-auth-user'?'{"id":"test"}':null},
    console:{warn(){}},setTimeout:(fn,ms)=>{const key=++id;timers.set(key,{fn,ms});return key;},clearTimeout:key=>timers.delete(key),
  });
  const first=exports.flushSettingsSync();
  preferred.value=['SOL'];exports.patchAuthUiSettings({alertSideFilter:'short'});
  await exports.flushSettingsSync(); // coalesced while the first save is pending
  complete.resolve({settings:saved[0]});await first;
  assert.equal(exports.getAuthUiSettings().alertSideFilter,'short');
  const second=exports.flushSettingsSync();
  assert.deepEqual(saved[1].preferredCoins,['SOL']);assert.equal(saved[1].alertSideFilter,'short');
  complete.reject(Error('temporary network failure'));await second;
  assert.equal([...timers.values()].at(-1).ms,5000);
});
