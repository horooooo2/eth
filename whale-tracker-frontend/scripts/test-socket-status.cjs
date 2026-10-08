const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
const out={};new Function('exports',ts.transpile(fs.readFileSync(require.resolve('../src/utils/socketStatus.ts'),'utf8'),{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}))(out);
const summarize=(crypto,radar)=>out.summarizeSocketConnections([{name:'虚拟币数据',status:crypto},{name:'雷达数据',status:radar}]);
test('all active sockets must be synchronized before the indicator turns green',()=>{
 assert.equal(summarize('connected','connected').status,'connected');
 assert.equal(summarize('connected','connecting').status,'connecting');
 assert.equal(summarize('connecting','connected').status,'connecting');
 assert.equal(summarize('connected','disconnected').status,'disconnected');
 assert.equal(summarize('disconnected','connected').status,'disconnected');
});
test('paused radar is excluded and tooltip lists both sockets separately',()=>{
 const result=summarize('connected','idle');assert.equal(result.status,'connected');
 assert.match(result.title,/虚拟币数据：已连接并同步/);assert.match(result.title,/雷达数据：未启用/);
 assert.equal(summarize('idle','idle').status,'idle');
});

test('virtual socket heartbeat timeout stops reporting healthy before the close handshake finishes',()=>{
 const vm=require('node:vm');let clock=1000,heartbeat,socket;
 class FakeSocket { static OPEN=1; constructor(){socket=this;this.readyState=0;}send(){}close(){this.readyState=2;} }
 const exports={};
 const code=ts.transpile(fs.readFileSync(require.resolve('../src/composables/useRealtime.ts'),'utf8'),{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS});
 vm.runInNewContext(code,{exports,Date:{now:()=>clock},WebSocket:FakeSocket,
  window:{location:{protocol:'https:',host:'example.invalid'}},
  require:name=>name==='vue'?{ref:value=>({value}),onUnmounted(){}}:{readWatchedCoins:()=>[]},
  setInterval:fn=>{heartbeat=fn;return 1;},clearInterval(){},setTimeout(){return 1;},clearTimeout(){} });
 const client=exports.useRealtime(()=>{},()=>({epoch:'a',seq:0}));
 client.start();socket.readyState=1;socket.onopen();assert.equal(client.status.value,'connected');
 clock+=61000;heartbeat();
 assert.equal(client.connected.value,false);assert.equal(client.status.value,'connecting');
 client.stop();
});
