// Run after `npm run build`: node scripts/smoke-tradfi-short-guard.cjs
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const assets = path.join(__dirname, '..', 'dist', 'assets');
const workerFile = fs.readdirSync(assets).find((name) => /^replay\.worker-.*\.js$/.test(name));
if (!workerFile) throw new Error('请先运行前端构建');
const guardStates = new Set();
let longSeenWhileProtected = false;
let last = null;
let failure = null;
let finished;
const done = new Promise((resolve, reject) => { finished = { resolve, reject }; });
const context = { setTimeout, clearTimeout, setInterval, clearInterval };
context.self = context;
context.postMessage = (message) => {
  if (message.type === 'replay-error') { failure = message.message; finished.reject(new Error(failure)); }
  if (message.type === 'ready') context.onmessage({ data: { type: 'play', speed: 5000 } });
  if (message.type === 'tick') {
    last = message.payload;
    assert.ok((last.positions.long?.adds || 0) <= 100, '多头补仓超过 100 档');
    assert.ok((last.positions.short?.adds || 0) <= 20, '空头补仓超过 20 档');
    guardStates.add(last.shortTrendProtected);
    if (last.shortTrendProtected) {
      assert.ok(!last.orders.short || ((last.orders.short.purpose !== 'add' || last.orders.short.label === '反转补仓')
        && last.orders.short.label !== '止盈后同向重建'), '上涨保护期间出现未确认的空头新增委托');
      longSeenWhileProtected ||= Boolean(last.positions.long || last.orders.long);
    }
    if (last.progress >= 1) { context.onmessage({ data: { type: 'stop' } }); finished.resolve(); }
  }
};
vm.runInNewContext(fs.readFileSync(path.join(assets, workerFile), 'utf8'), context, { filename: workerFile });

const days = 33;
const count = days * 1440;
const flat = new Float64Array(count * 6);
const start = Date.UTC(2026, 0, 1);
for (let i = 0; i < count; i += 1) {
  const trend = i < 26 * 1440 ? 0 : (i - 26 * 1440) * 0.03;
  const close = 4000 + trend + Math.sin(i * Math.PI / 60) * 6;
  const at = i * 6;
  flat[at] = start + i * 60_000;
  flat[at + 1] = close;
  flat[at + 2] = close + 0.4;
  flat[at + 3] = close - 0.4;
  flat[at + 4] = close;
  flat[at + 5] = 1;
}
context.onmessage({ data: { type: 'init-start', candleCount: count, funding: [],
  settings: { symbol: 'XAUUSDT', marginUsdt: 20, leverage: 20, budgetUsdt: 3740,
    makerFee: 0, tickSize: 0.01, qtyStep: 0.001, orderTtlMs: 90_000 } } });
context.onmessage({ data: { type: 'init-chunk', buffer: flat.buffer, start: 0, count } });
context.onmessage({ data: { type: 'init-complete' } });

let watchdog;
Promise.race([done, new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('回放超时')), 120_000); })])
  .then(() => {
    assert.equal(failure, null);
    assert.ok(guardStates.has(false) && guardStates.has(true), `上涨保护未正常切换：${[...guardStates]}`);
    assert.ok(longSeenWhileProtected, '上涨保护期间未见多头仓位或委托');
    assert.ok(last.tradeCount > 0, '回放没有任何成交');
    console.log(`回放通过：${count} 根分钟线，空头上涨保护已触发，多头仍在管理，成交 ${last.tradeCount} 笔`);
  })
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => clearTimeout(watchdog));
