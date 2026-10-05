const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');

test('failed webData commit does not advance diff baseline; partial payload cannot close positions', () => {
  const file = path.resolve(__dirname, '../lib/realtimeBridge.js');
  const realRequire = createRequire(file);
  let fail = false;
  let whale = { id: 'a', address: '0xabc', positions: [] };
  const commits = [];
  const sandbox = { module: { exports: {} }, console, process, setTimeout, clearTimeout, setInterval,
    require(name) {
      if (name === './cache') return {
        readWhaleModeCache: () => ({ data: { whales: [whale] } }),
        commitWhaleState: (_mode, patch) => {
          if (fail) throw new Error('disk unavailable');
          commits.push(patch); whale = patch.whales[0];
          return { data: { whales: [whale] }, committedAlerts: [] };
        },
      };
      if (name === './whaleSync') return { markLiveAlerts() {} };
      if (name === './opsMonitor') return { pushError() {} };
      return realRequire(name);
    } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nmodule.exports.testHooks={handleWebData,whalesByAddress,positionSnapByWhale,rememberPositionFill,recentPositionFills};', sandbox, { filename: file });
  const hooks = sandbox.module.exports.testHooks;
  hooks.whalesByAddress.set('0xabc', whale);
  const data = size => ({ clearinghouseState: { assetPositions: [{ position: {
    coin: 'BTC', szi: String(size), positionValue: String(size * 60000), entryPx: '60000', unrealizedPnl: '0', leverage: { value: 2 },
  } }] } });
  hooks.handleWebData({ user: '0xabc', data: data(1) });
  assert.equal(commits.length, 1);
  const executionTime = Date.now() - 1000;
  hooks.rememberPositionFill(whale, { id: 'increase-1', startPosition: 1, side: 'buy', asset: 'BTC', amount: 1, time: executionTime });
  fail = true;
  hooks.handleWebData({ user: '0xabc', data: data(2) });
  assert.equal(hooks.positionSnapByWhale.get('a')[0].size, 1);
  assert.ok(!hooks.recentPositionFills.get('a')[0].used);
  fail = false;
  hooks.handleWebData({ user: '0xabc', data: data(2) });
  assert.equal(commits.length, 2);
  assert.equal(commits[1].snapshotAlerts[0].kind, 'increase');
  assert.equal(commits[1].snapshotAlerts[0].items[0].time, executionTime);
  assert.equal(commits[1].snapshotAlerts[0].items[0].timeSource, 'execution');
  assert.equal(hooks.recentPositionFills.get('a')[0].used, true);
  hooks.handleWebData({ user: '0xabc', data: { clearinghouseState: {} } });
  assert.equal(commits.length, 2);
  assert.equal(hooks.positionSnapByWhale.get('a')[0].size, 2);
});
