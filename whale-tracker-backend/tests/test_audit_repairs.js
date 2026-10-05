const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
require('./helpers/isolateSqlite');
const store = require('../lib/sqliteStore');
const { scanResonanceSignals, DEFAULT_RESONANCE_CONFIG } = require('../lib/resonanceEngine');
function isolated(name, mocks, extra = {}) {
  const filename = require.resolve('../lib/' + name), real = createRequire(filename);
  const ctx = { module: { exports: {} }, __dirname: require('node:path').dirname(filename), process: { env: {} },
    console: { log() {}, warn() {}, info() {} }, setTimeout, clearTimeout, setInterval, clearInterval,
    require: key => Object.hasOwn(mocks, key) ? mocks[key] : real(key), ...extra };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), ctx); return ctx.module.exports;
}
const now = Date.now();
const whales = ['a','b','c'].map(id => ({ id, name: id, winRate: 80, positions: [] }));
const event = (w, i, usd, kind = 'open', time = now - 1000 + i) => ({ id: w + '-' + i, whaleId: w, kind, at: time,
  items: [{ sourceId: `fill:${w}:${i}`, coin: 'BTC', kind, side: 'long', usd, price: 60000, time }] });
const scan = alerts => scanResonanceSignals({ whales, activity: [], alerts, now, config: DEFAULT_RESONANCE_CONFIG, watchedCoins: ['BTC'] });
test('six independent same-minute fills conserve 600k; exact replays do not add money', () => {
  const rows = whales.flatMap(w => [event(w.id,0,100000),event(w.id,1,100000)]);
  assert.equal(scan(rows).primary.totalUsd, 600000);
  assert.equal(scan([...rows,...rows]).primary.totalUsd, 600000);
});
test('initial small open plus split additions qualify only after event aggregation', () => {
  const rows = whales.flatMap(w => Array.from({length:10},(_,i)=>event(w.id,i,6000,i ? 'increase':'open')));
  const result = scan(rows);
  assert.equal(result.primary.totalUsd, 180000); assert.equal(result.primary.whaleCount,3);
  assert.equal(result.signals.some(s=>s.kind==='accumulation'),false);
});
test('independent event intervals count accumulation; one split burst does not', () => {
  const rows = [0,1,2].map(i=>event('a',i,200000,'increase',now-1000-i*360000));
  assert.equal(scan(rows).primary.kind,'accumulation');
  assert.equal(scan(rows).primary.tradeCount,3);
});
test('future and expired raw facts cannot enter flow; correction replaces the original', () => {
  store.invalidateFillProjection();
  const trade = { id:'projection',whaleId:'projector',asset:'BTC',side:'buy',startPosition:0,amount:1,amountUsd:60000,price:60000,time:now-1000 };
  store.persistTradesIncremental([trade]);
  const query=()=>store.loadAlertFlowSummary({sinceMs:now-5000,untilMs:now,coin:'BTC'});
  assert.equal(query().longUsd,60000);
  store.persistTradesIncremental([{...trade,amountUsd:80000}]); assert.equal(query().longUsd,80000);
  store.persistTradesIncremental([{...trade,time:now+60000}]); assert.equal(query().longUsd,0);
  store.invalidateFillProjection(); assert.equal(query().longUsd,0);
});
test('a failed SQLite transaction never updates the in-memory fact projection', () => {
  const db=require('../lib/db').getDb();
  db.exec("CREATE TRIGGER fail_projection BEFORE INSERT ON fills WHEN NEW.id LIKE '%fail-project%' BEGIN SELECT RAISE(ABORT, 'disk failure'); END");
  try { assert.throws(()=>store.persistTradesIncremental([{id:'fail-project',whaleId:'a',asset:'ETH',side:'buy',startPosition:0,amount:1,amountUsd:123,time:now}]),/disk failure/);
    assert.equal(store.loadAlertFlowSummary({sinceMs:now-5000,untilMs:now,coin:'ETH'}).longUsd,0);
  } finally { db.exec('DROP TRIGGER fail_projection'); }
});
test('reverse history does not jump over a full older page: all 2501 executions returned', async () => {
  const source=[{tid:'latest',time:now-600000,coin:'BTC',sz:'1',px:'100'}];
  for(let i=0;i<2500;i++)source.push({tid:String(i),time:now-2400000+100+i*100,coin:'BTC',sz:'1',px:'100'});
  const api=isolated('hyperliquid',{ './hlInfoClient':{ hlPost:async b=>source.filter(x=>x.time>=b.startTime&&x.time<=b.endTime).sort((a,b)=>a.time-b.time).slice(0,2000) } }, {Date:{now:()=>now}});
  const rows=await api.fetchUserFillsByCoin('0xtest','BTC',{lookbackMs:3600000,maxPages:20});
  assert.equal(rows.length,2501); assert.equal(new Set(rows.map(x=>x.tid)).size,2501);
});
test('unresolvable saturated timestamp is reported instead of crossed',async()=>{
  const source=Array.from({length:2000},(_,i)=>({tid:String(i),time:now,coin:'BTC',sz:'1',px:'100'}));
  const api=isolated('hyperliquid',{'./hlInfoClient':{hlPost:async()=>source}}, {Date:{now:()=>now}});
  await assert.rejects(api.fetchUserFillsByCoin('0xdense','BTC',{lookbackMs:60000,maxPages:20}),e=>e.code==='HL_FILLS_INCOMPLETE');
});
test('history budget exhaustion does not consume the latest-execution budget',async()=>{
  const filename=require.resolve('../lib/hlInfoClient');
  const ctx={module:{exports:{}},process:{env:{}},console:{info(){}},setTimeout,clearTimeout,require:()=>({create:()=>({})})};
  vm.runInNewContext(fs.readFileSync(filename,'utf8')+'\nmodule.exports.reserve=canTakeWeight;',ctx);
  const take=ctx.module.exports.reserve;
  assert.ok(take({type:'userFillsByTime'},{priority:'history'}));
  assert.equal(take({type:'userFillsByTime'},{priority:'history'}),false);
  assert.ok(take({type:'userFillsByTime'}));
});
test('silent upstream is terminated, while retired socket messages are ignored',()=>{
  let clock=now, ping, filled=0;
  class Socket extends EventEmitter{static instance;constructor(){super();Socket.instance=this;this.readyState=1;}send(){}close(){}terminate(){this.terminated=true;this.emit('close');}}
  Socket.OPEN=1;
  const api=isolated('hlWsClient',{ws:Socket,'./opsMonitor':{pushSocket(){},pushError(){}}},{Date:{now:()=>clock},
    setInterval:fn=>(ping=fn,{unref(){}}),clearInterval(){},setTimeout:()=>({unref(){}}),clearTimeout(){}});
  const c=api.createHlWsClient({WebSocket:Socket,onFill:()=>filled++});
  c.syncSubscriptions({fillAddresses:['0xabc'],webDataAddresses:['0xabc']});c.start();const old=Socket.instance;old.emit('open');
  clock+=61000;ping();assert.equal(old.terminated,true);
  c.stop();c.start();Socket.instance.emit('open');old.emit('message',JSON.stringify({channel:'userFills',data:{user:'0xabc',fills:[]}}));
  assert.equal(filled,0);c.stop();
});

test('latest worker progresses while an independent history request is waiting; gaps remain explicit',async()=>{
  const address='0xabc';const marks={ [address]: { through:now-7200000,latestObservedAt:now-600000,coverageStart:now-86400000,historyBefore:now-86400000 } };
  const meta=new Map([['fills_address_watermarks_v2',JSON.stringify(marks)]]);let release,commits=0;
  const pending=new Promise(resolve=>release=resolve);
  const api=isolated('fillBackfill',{
    './db':{getMeta:k=>({value:meta.get(k)}),setMeta:(k,v)=>meta.set(k,v)},
    './config':{normalizeAddress:x=>x,getActiveWhales:()=>[{id:'a',address}]},
    './cache':{commitWhaleState:()=>{commits++;return {};}},
    './hyperliquid':{fetchUserFillsByTime:async(_a,_s,_e,options)=>options?.priority==='history'?pending:[],mapFillToTrade:x=>x},
  },{Date:{now:()=>now}});
  const history=api.runHistoryTick();await api.runOneTick();
  assert.equal(commits,1);assert.equal(api.getBackfillStatus().historyRunning,true);
  assert.equal(api.getBackfillStatus().watermarks[address].latestObservedAt,now);
  assert.equal(api.getBackfillStatus().watermarks[address].through,now-7200000);
  assert.equal(api.getCoverageStatus().complete,false);
  release([]);await history;assert.equal(api.getBackfillStatus().watermarks[address].through,now-3600000);
});



test('corrections keep merged alerts, events and flow consistent and retract changed sides', () => {
  const db=require('../lib/db').getDb(), time=Date.now()-1000;
  const base={whaleId:'correction-test',asset:'SOL',side:'buy',startPosition:0,amount:1,amountUsd:60000,price:60000,time};
  store.persistTradesIncremental([{...base,id:'first'},{...base,id:'second',startPosition:1}]);
  const result=store.persistTradesIncremental([{...base,id:'first',amountUsd:80000}]);
  const alerts=()=>db.prepare("SELECT payload_json FROM alerts WHERE whale_id='correction-test'").all().map(r=>JSON.parse(r.payload_json));
  assert.equal(alerts().reduce((s,a)=>s+a.totalUsd,0),140000);
  assert.equal(result.committedAlerts[0].totalUsd,140000);
  const replay=store.persistTradesIncremental([{...base,id:'first',amountUsd:80000}]);
  assert.equal(replay.committedAlerts.length,0);
  store.persistTradesIncremental([{...base,id:'first',side:'sell',amountUsd:80000}]);
  assert.equal(alerts().length,2);
  assert.equal(alerts().find(a=>a.items[0].side==='short').totalUsd,80000);
  const closed=store.persistTradesIncremental([{...base,id:'first',side:'sell',startPosition:1,amountUsd:80000}]);
  assert.equal(alerts().length,1);assert.equal(alerts()[0].totalUsd,60000);
  assert.ok(closed.removedAlertIds.length);
  assert.equal(db.prepare("SELECT count(*) n FROM events WHERE whale_id='correction-test' AND kind='open'").get().n,0);
});

test('a small coverage hole is incomplete and is backfilled before older history',async()=>{
  const marks={'0xa':{coverageStart:now-86400000,through:now-110000,latestObservedAt:now,latestCoverageStart:now-20000,historyBefore:now-86400000}};
  let requested;
  const api=isolated('fillBackfill',{
    './db':{getMeta:()=>({value:JSON.stringify(marks)}),setMeta:(_k,v)=>Object.assign(marks,JSON.parse(v))},
    './config':{normalizeAddress:x=>x,getActiveWhales:()=>[{id:'a',address:'0xa'}]},
    './cache':{commitWhaleState:()=>({})},
    './hyperliquid':{fetchUserFillsByTime:async(_a,s,e)=>(requested=[s,e],[]),mapFillToTrade:x=>x}
  },{Date:{now:()=>now}});
  assert.equal(api.getCoverageStatus().complete,false);
  await api.runHistoryTick();assert.deepEqual(requested,[now-110000,now]);
  assert.equal(api.getCoverageStatus().complete,true);
});

test('resonance detail notional equals event total rather than current positions',()=>{
  const positioned=whales.map(w=>({...w,positions:[{coin:'BTC',side:'long',szi:10,entryPx:50000,positionValue:600000}]}));
  const r=scanResonanceSignals({whales:positioned,activity:[],alerts:whales.map(w=>event(w.id,0,60000)),now,config:DEFAULT_RESONANCE_CONFIG,watchedCoins:['BTC']});
  assert.equal(r.primary.totalUsd,180000);
  assert.equal(r.primary.rows.reduce((s,r)=>s+r.notionalUsd,0),180000);
  assert.equal(r.primary.rows[0].price,60000);
});



test('state-patch corrections retract hidden alerts and rollback preserves old facts',()=>{
  const db=require('../lib/db').getDb(), time=Date.now()-1000;
  const trade={id:'patch-correction',whaleId:'patch-correction',asset:'ETH',side:'buy',startPosition:0,amount:1,amountUsd:80000,price:2000,time};
  store.persistStatePatch({trades:[trade]});
  db.exec("CREATE TRIGGER fail_correction BEFORE INSERT ON fills WHEN NEW.amount_usd=77777 BEGIN SELECT RAISE(ABORT,'correction failed'); END");
  try {assert.throws(()=>store.persistStatePatch({trades:[{...trade,amountUsd:77777}]}),/correction failed/);
    assert.equal(JSON.parse(db.prepare("SELECT payload_json FROM alerts WHERE whale_id='patch-correction'").get().payload_json).totalUsd,80000);
  } finally {db.exec('DROP TRIGGER fail_correction');}
  const result=store.persistStatePatch({trades:[{...trade,amountUsd:1}]});
  assert.ok(result.removedAlertIds.length);assert.equal(result.committedAlerts.length,0);
  assert.equal(db.prepare("SELECT is_visible FROM alerts WHERE whale_id='patch-correction'").get().is_visible,0);
});
