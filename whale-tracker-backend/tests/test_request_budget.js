const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const file = require.resolve('../lib/hlInfoClient');
test('weight exhaustion leaves concurrency available for position requests', async () => {
  const timers = [], calls = [];
  const context = { module: { exports: {} }, process: { env: {} }, console: { info() {} },
    require: () => ({ create: () => ({ post: async (_, body) => { calls.push(body.type); return { data: { assetPositions: [] } }; } }) }),
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nmodule.exports.testReserve = canTakeWeight;', context);
  const api = context.module.exports;
  for (let i = 0; i < 6; i++) assert.ok(api.testReserve({ type: 'userFillsByTime' }));
  assert.equal(api.testReserve({ type: 'userFillsByTime' }), false);
  const slow = api.hlPost({ type: 'userFillsByTime', user: 'x' }, 0).catch(error => error.code);
  const current = await api.hlPost({ type: 'clearinghouseState', user: 'x' }, 0);
  assert.ok(Array.isArray(current.assetPositions));
  assert.deepEqual(calls, ['clearinghouseState']);
  // Expire the queued low-priority request; it must never reach upstream.
  timers[0](); assert.equal(await slow, 'HL_QUEUE_TIMEOUT');
  assert.equal(api.getHlInfoConfig().queued, 0);
});

test('bounded recovery budget admits three maximum-size pages while preserving position capacity', () => {
  const context = { module: { exports: {} }, process: { env: {} }, console: { info() {} },
    require: () => ({ create: () => ({}) }), setTimeout() {}, clearTimeout() {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nmodule.exports.reserve = canTakeWeight;', context);
  const reserve = context.module.exports.reserve;
  for(let i=0;i<3;i++) assert.ok(reserve({type:'userFillsByTime'},{priority:'history'}));
  assert.equal(reserve({type:'userFillsByTime'},{priority:'history'}),false);
  assert.ok(reserve({type:'userFillsByTime'}));
  assert.ok(reserve({type:'clearinghouseState'}));
});
