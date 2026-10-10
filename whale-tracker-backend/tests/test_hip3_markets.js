const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/isolateSqlite');
const { mergeMarketStates, rememberMarketSnapshot, latestMarketSnapshot } = require('../lib/hlMarkets');
const { deriveDirection, mapFillToTrade } = require('../lib/hyperliquid');
const store = require('../lib/sqliteStore');
const state = (coin, size = 1) => ({ marginSummary: { accountValue: '100' }, assetPositions: coin ? [{ position: {
  coin, szi: String(size), entryPx: '100', positionValue: String(Math.abs(size) * 100), unrealizedPnl: '5', leverage: { value: 2 },
} }] : [] });

test('all-market snapshot preserves namespace and native collateral; empty market closes only itself', () => {
  const merged = mergeMarketStates([['', state('BTC')], ['xyz', state('SNDK')], ['cash', state('SNDK', -2)]]);
  assert.deepEqual(deriveDirection(merged).positions.map(p => p.coin), ['BTC', 'xyz:SNDK', 'cash:SNDK']);
  assert.equal(merged.marginSummary.accountValue, '100');
  const closed = mergeMarketStates([['', state('BTC')], ['xyz', state()], ['cash', state('SNDK', -2)]]);
  assert.deepEqual(deriveDirection(closed).positions.map(p => p.coin), ['BTC', 'cash:SNDK']);
});

test('malformed/partial market data never replaces the last complete snapshot', () => {
  rememberMarketSnapshot('0xhip3', [['', state('BTC')], ['xyz', state('SNDK')]]);
  assert.throws(() => rememberMarketSnapshot('0xhip3', [['', state()], ['xyz', {}]]));
  assert.throws(() => mergeMarketStates([['xyz', state('SNDK')]]));
  assert.throws(() => mergeMarketStates([['', state()], ['cash', state('xyz:SNDK')]]));
  assert.equal(latestMarketSnapshot('0xhip3').assetPositions.length, 2);
});

test('HIP-3 executions persist and remain visible in paginated alerts with spot exclusion', () => {
  const whale = { id: 'hip3-wallet', address: '0xhip3', name: 'test' };
  const at = Date.now();
  for (const [i, coin] of ['xyz:SNDK', 'cash:SNDK', '@123'].entries()) {
    const trade = mapFillToTrade({ tid: 8000 + i, coin, sz: '20', px: '100', side: 'B', startPosition: '0', time: at }, whale);
    store.persistTradesIncremental([trade]);
  }
  const page = store.loadPagedAlerts({ whaleId: whale.id, sinceMs: at - 1, excludeExotic: true });
  assert.equal(page.total, 2);
  assert.deepEqual(Object.keys(page.facets.byCoin).sort(), ['CASH:SNDK', 'XYZ:SNDK']);
  const selected = store.loadPagedAlerts({ whaleId: whale.id, coin: 'xyz:SNDK', sinceMs: at - 1, excludeExotic: true });
  assert.equal(selected.total, 1);
});

test('REST extension refresh deduplicates concurrent reads and rejects incomplete coverage', async () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  let now = 1000000, fail = false;
  const calls = [];
  const sandbox = { module: { exports: {} }, Date: { now: () => now }, require: () => ({ hlPost: async body => {
    calls.push(body);
    if (body.type === 'perpDexs') return [null, { name: 'xyz' }, { name: 'cash' }];
    if (fail && body.dex === 'cash') throw new Error('market unavailable');
    return state('SNDK');
  } }) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../lib/hlMarkets'), 'utf8'), sandbox);
  const api = sandbox.module.exports;
  await Promise.all([api.fetchExtendedStates('0xabc'), api.fetchExtendedStates('0xabc')]);
  assert.equal(calls.length, 3);
  await api.fetchExtendedStates('0xabc');
  assert.equal(calls.length, 3);
  now += 121000; fail = true;
  await assert.rejects(api.fetchExtendedStates('0xabc'), /market unavailable/);
  fail = false;
  assert.equal((await api.fetchExtendedStates('0xabc')).length, 2);
});

test('open orders cover markets without positions, share requests, and bound fan-out', async () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  let active = 0, peak = 0, calls = 0, fail = false;
  const sandbox = { module: { exports: {} }, process, console, require: name => {
    if (name === './hlMarkets') return { fetchDexNames: async () => ['xyz', 'cash'] };
    if (name === './hlInfoClient') return { hlPost: async body => {
      calls++; peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      if (fail && body.dex === 'cash') throw new Error('orders unavailable');
      return body.dex ? [{ coin: 'SNDK', oid: body.dex, timestamp: 100 }] : [];
    } };
    return require('../lib/positionEventPolicy');
  } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../lib/hyperliquid'), 'utf8'), sandbox);
  const api = sandbox.module.exports;
  const [rows] = await Promise.all([api.fetchFrontendOpenOrders('0xa'), api.fetchFrontendOpenOrders('0xa')]);
  assert.deepEqual(Array.from(rows, r => r.coin).sort(), ['cash:SNDK', 'xyz:SNDK']);
  assert.equal(calls, 3);
  assert.equal(peak, 2);
  fail = true;
  await assert.rejects(api.fetchFrontendOpenOrders('0xb'), /orders unavailable/);
});
