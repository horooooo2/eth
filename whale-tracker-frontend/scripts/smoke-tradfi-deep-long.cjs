// Run after `npm run build`: node scripts/smoke-tradfi-deep-long.cjs
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const assets = path.join(__dirname, '..', 'dist', 'assets');
const workerFile = fs.readdirSync(assets).find((name) => /^replay\.worker-.*\.js$/.test(name));
if (!workerFile) throw new Error('请先运行前端构建');
let final = null;
let finish;
const done = new Promise((resolve, reject) => { finish = { resolve, reject }; });
const context = { setTimeout, clearTimeout, setInterval, clearInterval };
context.self = context;
context.postMessage = (message) => {
  if (message.type === 'replay-error') finish.reject(new Error(message.message));
  if (message.type === 'ready') context.onmessage({ data: { type: 'play', speed: 5000 } });
  if (message.type === 'tick') {
    final = message.payload;
    assert.ok((final.positions.long?.adds || 0) <= 100);
    if (final.progress >= 1) { context.onmessage({ data: { type: 'stop' } }); finish.resolve(); }
  }
};
vm.runInNewContext(fs.readFileSync(path.join(assets, workerFile), 'utf8'), context, { filename: workerFile });

const day = 1440;
const count = 35 * day;
const flat = new Float64Array(count * 6);
const start = Date.UTC(2026, 4, 1);
const anchors = [[0, 5000], [24, 5000], [25.5, 4350], [26, 4460],
  [27, 4100], [27.5, 4200], [28.5, 3900], [29, 4020], [35, 4020]];
function pathPrice(days) {
  let at = 0;
  while (at < anchors.length - 2 && days > anchors[at + 1][0]) at += 1;
  const [fromDay, fromPrice] = anchors[at]; const [toDay, toPrice] = anchors[at + 1];
  return fromPrice + (toPrice - fromPrice) * (days - fromDay) / (toDay - fromDay);
}
for (let i = 0; i < count; i += 1) {
  const close = pathPrice(i / day) + Math.sin(i * Math.PI / 50) * 2;
  const at = i * 6;
  flat[at] = start + i * 60_000;
  flat[at + 1] = close;
  flat[at + 2] = close + 0.2;
  flat[at + 3] = close - 0.2;
  flat[at + 4] = close;
  flat[at + 5] = 1;
}
context.onmessage({ data: { type: 'init-start', candleCount: count, funding: [],
  settings: { symbol: 'XAUUSDT', marginUsdt: 20, leverage: 20, makerFee: 0,
    tickSize: 0.01, qtyStep: 0.001, orderTtlMs: 90_000, walletBalance: 40000 } } });
context.onmessage({ data: { type: 'init-chunk', buffer: flat.buffer, start: 0, count } });
context.onmessage({ data: { type: 'init-complete' } });

let watchdog;
Promise.race([done, new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('回放超时')), 120_000); })])
  .then(() => {
    assert.ok(final.special.margin.long > 100, `极端下跌未产生成交的深跌补多委托：${JSON.stringify(final?.special)}`);
    assert.ok(final.special.filled >= 1, '深跌补仓没有成交');
    console.log(`深跌回放通过：${count} 根分钟线，特殊成交 ${final.special.filled} 笔，多头补仓本金 ${final.special.margin.long.toFixed(2)}U`);
  })
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => clearTimeout(watchdog));
