const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');

function fixture(state, status = 'active') {
  const filename = path.join(__dirname, '../lib/tradfiRangeStrategy.js');
  const localRequire = createRequire(filename);
  const row = { user_id: 'test', symbol: 'XAUUSDT', enabled: 1, simulated: 1, status, additions: 0, state_json: JSON.stringify(state) };
  const calls = [];
  const context = { module: { exports: {} }, require(name) {
    if (name === './db') return { getDb: () => ({ prepare: () => ({ all: () => [row], get: () => row }) }) };
    if (name === './userExchangeKeys') return { getBinanceCredentialsForUser: () => ({ simulated: true }) };
    if (name === './binanceTradfiTrade') return { ...localRequire(name), signedRequest: async (_c, method, url) => { calls.push({ method, url }); return []; } };
    return localRequire(name);
  }, console, process, Buffer, setInterval, clearInterval, setTimeout, row, calls, Date, structuredClone, allowCancel: false };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(filename, 'utf8') + `
    rowFor = () => row;
    save = (_r, patch={}, statePatch=null, explicit=false) => {
      if(!explicit && !row.enabled && patch.enabled !== 0) return;
      Object.assign(row, patch);
      if(statePatch) row.state_json = JSON.stringify({...JSON.parse(row.state_json),...statePatch});
    };
    log = () => {};
    snapshot = async () => ({last:100,bid:99,ask:101,dataFresh:false,atr:1,atr1h:1,addStep:1,trend:'range',trendDirection:'flat',trendBars:0,hourlyRows:[]});
    positionsOf = () => ({long:{positionAmt:'1',entryPrice:'100',notional:'100',unRealizedProfit:'10'},short:{positionAmt:'-1',entryPrice:'100',notional:'100',unRealizedProfit:'10'}});
    fundingSince = async () => 0;
    legCostState = async () => ({netPnl:10,profitTarget:1,recovery:false});
    placeCloseMaker = async (_c,_r,side,quantity) => {calls.push({close:side,quantity});return {orderId:'new-'+side,quantity:String(quantity)};};
    cancelKnown = async () => {if(!allowCancel) throw new Error('must not cancel the other leg protection');};
    cancelOpenCloses = async () => {};
    module.exports.run = () => reconcileRow(row);
    module.exports.closePaused = () => {allowCancel=true;return closeAll('test');};
  `, context, { filename });
  return { run: context.module.exports.run, closePaused: context.module.exports.closePaused, row, calls };
}

test('legacy long pending close does not block short exit or cancel its protection', async () => {
  const f = fixture({ expectedLong: 1, expectedShort: 1, longExpectedQty: 1, shortExpectedQty: 1,
    longPhase: 'close_pending', longClosePlacedAt: Date.now(), longCloseOrders: [{ orderId: 'old-long' }],
    shortPhase: 'active', weekendMode: false });
  await f.run();
  assert.ok(f.calls.some(x => x.close === 'SHORT'));
  assert.deepEqual(JSON.parse(f.row.state_json).longCloseOrders, [{ orderId: 'old-long' }]);
  assert.equal(JSON.parse(f.row.state_json).shortPhase, 'close_pending');
});

test('legacy initializing strategy retires before any exchange mutation', async () => {
  const f = fixture({}, 'initializing');
  await f.run();
  assert.equal(f.row.enabled, 0);
  assert.equal(f.row.status, 'paused');
  assert.equal(f.calls.length, 0);
});

test('explicit close can manage a paused legacy position without re-enabling entry', async () => {
  const f = fixture({ expectedLong: 1, expectedShort: 1, longExpectedQty: 1, shortExpectedQty: 1,
    longPhase: 'active', shortPhase: 'active' }, 'paused');
  f.row.enabled = 0;
  await f.closePaused();
  assert.equal(f.row.status, 'close_pending');
  assert.equal(f.row.enabled, 1);
  assert.equal(JSON.parse(f.row.state_json).stopAfterClose, true);
  assert.equal(f.calls.filter(x => x.close).length, 2);
});
