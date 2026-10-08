const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),vue=require('vue');
const source=fs.readFileSync(require.resolve('../src/utils/radarRealtime.ts'),'utf8').replace(/^import .*;\r?$/gm,'');
const js=ts.transpile(source,{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}),out={};
new Function('exports','ref','shallowRef',js)(out,vue.ref,vue.shallowRef);
const {createRadarClient,applyRadarDelta,sortRadarRows}=out;
const initial=()=>({epoch:'epoch',seq:0,catalog:[],marketSymbols:[],quotes:[{symbol:'A',lastPrice:'10'}],long:{rows:[{symbol:'WDC',points:[[1,10]],frames:{90:{change:10}}}],running:false,error:''},updatedAt:null,error:''});
function setup(){
 let requests=0;const sockets=[];
 const client=createRadarClient({snapshot:async()=>{requests++;return initial();},socket:()=>{
  const socket={readyState:0,sent:[],send(data){this.sent.push(JSON.parse(data));},close(){this.readyState=3;this.onclose?.();}};sockets.push(socket);return socket;
 }});
 return {client,sockets,requests:()=>requests,open(s){s.readyState=1;s.onopen();},message(s,msg){s.onmessage({data:JSON.stringify(msg)});}};
}
test('one bootstrap, replay before caughtUp, duplicates ignored and chart changes without HTTP',async()=>{
 const h=setup(),c=h.client;
 try{
  c.setActive(true);await Promise.all([c.ensure(),c.ensure()]);assert.equal(h.requests(),1);assert.equal(h.sockets.length,1);
  const s=h.sockets[0];h.open(s);assert.deepEqual(s.sent[0],{type:'resume',epoch:'epoch',seq:0});
  const delta={type:'radarDelta',epoch:'epoch',seq:1,patch:{quotes:{upserts:[{symbol:'A',lastPrice:'11'}],remove:[]}}};
  h.message(s,delta);h.message(s,{type:'caughtUp',epoch:'epoch',seq:1});assert.equal(c.connected.value,true);assert.equal(c.state.value.quotes[0].lastPrice,'11');
  h.message(s,delta);assert.equal(c.state.value.seq,1);c.setWatches(['A']);c.selectChart('A','5m');c.selectChart('A','1h');assert.equal(h.requests(),1);
  c.selectChart('WDCUSDT','1d');
  c.setActive(false);c.setActive(true);const resumed=h.sockets[1];h.open(resumed);h.message(resumed,{type:'caughtUp',epoch:'epoch',seq:1});
  assert.deepEqual(resumed.sent.filter(msg=>msg.type==='chart').map(msg=>msg.interval),['1h','1d']);assert.equal(h.requests(),1);
 }finally{c.setActive(false);}
});
test('reactivation retains state without HTTP; gaps resync and replaced socket messages ignored',async()=>{
 const h=setup(),c=h.client;
 try{
  c.setActive(true);await c.ensure();const first=h.sockets[0];h.open(first);h.message(first,{type:'caughtUp',epoch:'epoch',seq:0});
  const old=c.state.value;c.setActive(false);assert.equal(c.state.value,old);c.setActive(true);assert.equal(h.requests(),1);
  const second=h.sockets[1];h.open(second);h.message(second,{type:'radarDelta',epoch:'epoch',seq:2,patch:{error:'gap'}});await c.ensure();assert.equal(h.requests(),2);
  h.message(second,{type:'radarDelta',epoch:'epoch',seq:1,patch:{error:'old'}});assert.equal(c.state.value.error,'');
 }finally{c.setActive(false);}
});
test('price patches preserve history, delete symbols and reject gaps',()=>{
 const next=applyRadarDelta(initial(),{epoch:'epoch',seq:1,patch:{quotes:{upserts:[],remove:['A']},long:{meta:{running:false,error:''},remove:[],upserts:[{symbol:'WDC',currentPrice:11}]}}});
 assert.equal(next.quotes.length,0);assert.deepEqual(next.long.rows[0].points,[[1,10]]);assert.deepEqual(next.long.rows[0].frames,{90:{change:10}});
 assert.equal(applyRadarDelta(next,{epoch:'epoch',seq:3,patch:{}}),null);assert.equal(applyRadarDelta(next,{epoch:'restart',seq:2,patch:{}}),null);
});
test('chart cache has bounded size',async()=>{
 const h=setup(),c=h.client;
 try{
  c.setActive(true);await c.ensure();const s=h.sockets[0];h.open(s);h.message(s,{type:'caughtUp',epoch:'epoch',seq:0});
  for(let i=0;i<45;i++)h.message(s,{type:'radarChart',key:`TEST${i}:1h`,result:{available:true,bars:[{close:i}]}});
  assert.equal(Object.keys(c.charts.value).length,40);assert.equal(c.charts.value['TEST44:1h'].bars[0].close,44);
  h.message(s,{type:'radarChart',key:'TEST44:1h',result:{available:false,bars:[],error:'offline'}});
  assert.equal(c.charts.value['TEST44:1h'].bars[0].close,44);assert.equal(c.charts.value['TEST44:1h'].stale,true);
 }finally{c.setActive(false);}
});
test('local sorting places missing values last, uses symbol for ties and preserves shared order',()=>{
 const rows=[{symbol:'B',value:2},{symbol:'C',value:null},{symbol:'A',value:2}];
 for(const order of ['asc','desc'])assert.deepEqual(sortRadarRows(rows,row=>row.value,order).map(row=>row.symbol),['A','B','C']);assert.equal(rows[0].symbol,'B');
});

test('radar status distinguishes idle, connecting, synchronized, failed and resumed sockets',async()=>{
 const h=setup(),c=h.client;
 try{
  assert.equal(c.status.value,'idle');c.setActive(true);assert.equal(c.status.value,'connecting');await c.ensure();
  const socket=h.sockets[0];h.open(socket);assert.equal(c.status.value,'connecting');
  h.message(socket,{type:'caughtUp',epoch:'epoch',seq:0});assert.equal(c.status.value,'connected');
  socket.onerror();assert.equal(c.status.value,'disconnected');assert.equal(c.connected.value,false);
  c.setActive(false);assert.equal(c.status.value,'idle');
  c.setActive(true);assert.equal(c.status.value,'connecting');
  const resumed=h.sockets[1];h.open(resumed);h.message(resumed,{type:'caughtUp',epoch:'epoch',seq:0});
  assert.equal(c.status.value,'connected');assert.equal(h.requests(),1);
 }finally{c.setActive(false);}
});
test('snapshot and constructor failures appear in radar status without creating extra connections',async()=>{
 const failed=createRadarClient({snapshot:async()=>{throw Error('offline');},socket:()=>{throw Error('unexpected socket');}});
 try{failed.setActive(true);await failed.ensure();assert.equal(failed.status.value,'disconnected');assert.equal(failed.connected.value,false);}
 finally{failed.setActive(false);}
 let calls=0;
 const broken=createRadarClient({snapshot:async()=>initial(),socket:()=>{calls++;throw Error('blocked');}});
 try{broken.setActive(true);await broken.ensure();assert.equal(broken.status.value,'disconnected');assert.equal(calls,1);}
 finally{broken.setActive(false);}
});
