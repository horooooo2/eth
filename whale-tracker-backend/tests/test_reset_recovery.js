const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
require('./helpers/isolateSqlite');
const DAY = 86400000, now = 1800000000000;
function fixture(fetchFills = async () => [], meta = new Map(), cached = null, persist = () => ({})) {
  const commits = [], requests = [];
  const context = { module: { exports: {} }, process: { env: {} }, Date: { now: () => now },
    console: { warn() {} }, setImmediate, setInterval: () => ({ unref() {} }), clearInterval() {},
    require: key => ({
      './marketMaintenance': { isPaused: () => false },
      './db': { getMeta: k => ({ value: meta.get(k) }), setMeta: (k,v) => meta.set(k,v) },
      './config': { normalizeAddress: x => x, getActiveWhales: () => [{id:'a',address:'0xa'}] },
      './cache': { readWhaleModeCache: () => cached, captureWhaleRevisions: () => new Map(), commitWhaleState: (_mode, data) => { commits.push(data); return persist(data); } },
      './hyperliquid': { mapFillToTrade: x => x, FILL_LOOKBACK_MS: DAY,
        normalizeToHlFill: x => x, buildPositionOpenTiming: rows => ({openTime: rows[0].time, openHistoryComplete:true}),
        buildPositionEntryFills: rows => ({entryFills:rows}),
        fetchUserFillsByTime: async (...args) => { requests.push(args); return fetchFills(...args); } },
    })[key] };
  vm.runInNewContext(fs.readFileSync(require.resolve('../lib/fillBackfill'),'utf8'), context);
  return { api: context.module.exports, commits, requests, meta };
}
test('reset seeds latest then restores the full 24h in one history request for a quiet address', async () => {
  const f = fixture(async () => [{ id: 'actual-fill' }]);
  f.api.resetFillBackfill(); assert.equal(f.api.getResetRecoveryStatus().status,'recovering');
  await f.api.runOneTick(); assert.equal(f.api.getResetRecoveryStatus().recovered,0);
  await f.api.runHistoryTick();
  assert.equal(f.requests[1][1],now-DAY);assert.equal(f.requests[1][2],now-15*60000);
  assert.equal(f.requests[1][3].priority,'history');assert.equal(f.api.getResetRecoveryStatus().status,'complete');
  assert.equal(f.commits[1].trades[0].id,'actual-fill');
  assert.equal(fixture(undefined,f.meta).api.getResetRecoveryStatus().status,'complete');
});
test('saturated history shrinks its window without advancing coverage or reporting completion', async () => {
  let fail = false;
  const f = fixture(async () => { if(fail) throw Object.assign(new Error('dense'),{code:'HL_FILLS_INCOMPLETE'}); return []; });
  f.api.resetFillBackfill();await f.api.runOneTick();fail=true;await f.api.runHistoryTick();
  const marks=f.api.getBackfillStatus().watermarks['0xa'];
  assert.equal(marks.historyBefore,now-15*60000);assert.equal(marks.historyWindowMs,DAY/2);
  assert.equal(f.api.getResetRecoveryStatus().status,'recovering');assert.equal(f.api.getResetRecoveryStatus().errors,1);
  fail=false;await f.api.runHistoryTick();assert.equal(f.api.getResetRecoveryStatus().errors,0);
});
test('budget deferral leaves recovery pending and cannot advance watermarks', async () => {
  const f=fixture(async(_a,_s,_e,opt)=>{if(opt)throw Object.assign(new Error('budget'),{code:'HL_HISTORY_DEFERRED'});return [];});
  f.api.resetFillBackfill();await f.api.runOneTick();await f.api.runHistoryTick();
  assert.equal(f.api.getResetRecoveryStatus().recovered,0);assert.equal(f.commits.length,1);
});
test('an in-flight request from before a reset cannot repopulate cleared data', async () => {
  let release;const f=fixture(()=>new Promise(resolve=>release=resolve));
  const pending=f.api.runOneTick();f.api.resetFillBackfill();release([{id:'stale'}]);await pending;
  assert.equal(f.commits.length,0);assert.equal(f.api.getResetRecoveryStatus().recovered,0);
});

test('completed historical capture reuses fills for position timing without extra upstream calls', async () => {
  const cached = { data: { whales: [{id:'a', positions:[{coin:'BTC',size:1,side:'long',positionValue:50000},
    {coin:'ETH',size:2,side:'long',openTime:now-DAY*2,openHistoryComplete:true}]}], trades:[] } };
  const f=fixture(async()=>[{id:'fill',time:now-3600000}],new Map(),cached);
  f.api.resetFillBackfill();await f.api.runOneTick();await f.api.runHistoryTick();
  assert.equal(f.requests.length,2);assert.equal(f.commits[2].positionMetadataOnly,true);
  assert.equal(f.commits[2].whales[0].positions[0].openTime,now-3600000);
  assert.equal(f.commits[2].whales[0].positions[0].positionValue,50000);
  assert.equal(f.commits[2].whales[0].positions[1].openTime,now-DAY*2);
});

test('large captures yield between bounded commits and a reset cancels remaining chunks', async () => {
  const f=fixture(async()=>Array.from({length:1201},(_,i)=>({id:'fill-'+i})));
  const pending=f.api.runOneTick();
  for (let i=0;i<10 && !f.commits.length;i++) await Promise.resolve();
  assert.equal(f.commits.length,1);
  f.api.resetFillBackfill();await pending;
  assert.ok(f.commits.every(commit=>commit.trades.length<=500));
  assert.ok(f.commits.length<3);
  assert.equal(f.api.getResetRecoveryStatus().recovered,0);
  assert.equal(f.api.getBackfillStatus().watermarks['0xa'],undefined);
});

test('chunked persistence preserves all executions and replay never duplicates alert amounts', async () => {
  const store = require('../lib/sqliteStore'), database = require('../lib/db').getDb();
  const time = Date.now()-10000;
  const fills=Array.from({length:1201},(_,i)=>({id:'recovery-'+i,whaleId:'a',asset:'BTC',side:'buy',
    startPosition:i,amount:1,amountUsd:1000,price:1000,time:time+i}));
  const f=fixture(async()=>fills,new Map(),null,data=>store.persistStatePatch(data));
  f.api.resetFillBackfill();await f.api.runOneTick();
  const amount=()=>store.loadPagedAlerts({limit:50}).alerts.reduce((sum,alert)=>sum+alert.totalUsd,0);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM fills').get().n,1201);
  assert.equal(amount(),1201000);
  f.api.resetFillBackfill();await f.api.runOneTick();
  assert.equal(database.prepare('SELECT COUNT(*) n FROM fills').get().n,1201);
  assert.equal(amount(),1201000);
});
