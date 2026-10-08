const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../lib/whales'), 'utf8');
const start = source.indexOf('async function getWhalePosition(');
const end = source.indexOf('/** 前端只读', start);
function setup() {
  const observed = Date.now() - 1000;
  const position = { coin:'BTC', side:'long', size:1, entryPx:50000, positionValue:60000, unrealizedPnl:10000, openHistoryComplete:false, entryFills:[] };
  const calls=[];
  const remote = name => async () => { calls.push(name); return name==='fills' ? [] : {}; };
  const context = {
    Date, console, FILL_LOOKBACK_MS:86400000, findConfiguredWhale:()=>({id:'a',address:'0xa'}), normalizeAddress:x=>x,
    fetchCoinNameMap:remote('names'), fetchClearinghouseState:remote('state'), fetchUserFillsByCoin:remote('fills'), fetchAllMids:remote('mids'),
    readActiveWhaleCache:()=>({updatedAt:Date.now(),data:{whales:[{id:'a',positionObservedAt:observed,positions:[position]}]}}),
    captureWhaleRevisions:()=>({}), loadLocalFillsForCoin:()=>[], entryFillsThin:()=>true, fillsExplainEnough:()=>false,
    mergeFillLists:(a,b)=>[...a,...b], buildPositionOpenTiming:()=>({openHistoryComplete:false}),
    buildPositionEntryFills:()=>({entryFills:[]}), patchCachedPositionFields:()=>{}, coinLabel:x=>x, explorerUrl:x=>x,
  };
  vm.runInNewContext(source.slice(start,end)+'\nthis.lookup=getWhalePosition;',context);
  return {context,calls,observed};
}
test('cached position detail makes no upstream calls and preserves observation time and PnL', async()=>{
  const {context,calls,observed}=setup();
  const result=await context.lookup('a','BTC',{side:'long',cacheOnly:true});
  assert.equal(calls.length,0);assert.equal(result.updatedAt,observed);
  assert.equal(result.position.unrealizedPnl,10000);assert.equal(result.position.openHistoryComplete,false);
});
test('full detail still enriches history when explicitly requested',async()=>{
  const {context,calls}=setup();await context.lookup('a','BTC',{side:'long'});
  assert.deepEqual(calls,['names','fills','mids']);
});
