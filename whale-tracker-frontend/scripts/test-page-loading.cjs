const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ts = require('typescript');
const code = fs.readFileSync(path.join(__dirname, '../src/utils/pageLoadScheduler.ts'), 'utf8');
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: exportsObject, Promise, Map });
const { createPageLoadScheduler } = exportsObject;
async function verify(primary, secondary) {
  const calls = [];
  let finish;
  const scheduler = createPageLoadScheduler({
    [primary]: () => { calls.push(primary); return new Promise(resolve => { finish = resolve; }); },
    [secondary]: async () => { calls.push(secondary); },
  });
  const run = scheduler.start(primary, secondary);
  await Promise.resolve();
  assert.deepEqual(calls, [primary]);
  scheduler.load(primary); // fast repeated tab clicks must share the request
  finish();
  await run;
  assert.deepEqual(calls, [primary, secondary]);
  await scheduler.load(secondary);
  assert.deepEqual(calls, [primary, secondary]);
}
(async () => {
  await verify('virtual', 'tradfi');
  await verify('tradfi', 'virtual');
  let background = 0;
  const failed = createPageLoadScheduler({ virtual: async () => { throw Error('unavailable'); }, tradfi: async () => { background++; } });
  await failed.start('virtual', 'tradfi');
  assert.equal(background, 1);
  const stopped = createPageLoadScheduler({ virtual: async () => {}, tradfi: async () => { background++; } });
  await stopped.start('virtual', 'tradfi', () => false);
  assert.equal(background, 1);
  console.log('Page priority, deduplication, failure and stopped-session checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
