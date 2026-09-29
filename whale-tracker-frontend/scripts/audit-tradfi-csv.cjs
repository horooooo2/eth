// Usage: node scripts/audit-tradfi-csv.cjs <1m-csv> <funding-csv>
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const [candlePath, fundingPath] = process.argv.slice(2);
if (!candlePath || !fundingPath) throw new Error('请提供分钟 K 线与资金费 CSV 路径');
const assets = path.join(__dirname, '..', 'dist', 'assets');
const workerFile = fs.readdirSync(assets).find((name) => /^replay\.worker-.*\.js$/.test(name));
if (!workerFile) throw new Error('请先运行前端构建');

const candleLines = fs.readFileSync(candlePath, 'utf8').trim().split(/\r?\n/);
const heads = candleLines[0].split(',');
const column = (name) => { const index = heads.indexOf(name); if (index < 0) throw new Error(`K 线缺少 ${name}`); return index; };
const columns = ['open_time_ms', 'open', 'high', 'low', 'close', 'volume'].map(column);
const count = candleLines.length - 1;
const flat = new Float64Array(count * 6);
for (let i = 0; i < count; i += 1) {
  const cells = candleLines[i + 1].split(',');
  for (let j = 0; j < 6; j += 1) flat[i * 6 + j] = Number(cells[columns[j]]);
  if (i > 0 && flat[i * 6] - flat[(i - 1) * 6] !== 60_000) throw new Error(`第 ${i + 2} 行 K 线不连续`);
}
const funding = fs.readFileSync(fundingPath, 'utf8').trim().split(/\r?\n/).slice(1).map((line) => {
  const [timestamp, rate] = line.split(',');
  return { t: Date.parse(timestamp), rate: Number(rate) };
});

const inspectFrom = Date.parse('2026-03-18T00:00:00+08:00');
const inspectTo = Date.parse('2026-03-25T00:00:00+08:00');
let intervalCallback = null;
let ready;
const prepared = new Promise((resolve, reject) => { ready = { resolve, reject }; });
let last = null; let lastSpecialMargin = 0; let previousOrderKey = ''; let previousOrderLabel = '';
let inspected = false;
let peakFills = null;
const events = []; const closes = []; const daily = [];
let lastDay = '';
const context = {
  setTimeout, clearTimeout,
  setInterval: (callback) => { intervalCallback = callback; return 1; },
  clearInterval: () => { intervalCallback = null; },
};
context.self = context;
context.postMessage = (message) => {
  if (message.type === 'replay-error') ready.reject(new Error(message.message));
  if (message.type === 'ready') ready.resolve();
  if (message.type === 'peak-fills') { peakFills = message.payload; return; }
  if (message.type !== 'tick') return;
  last = message.payload;
  const time = last.time;
  for (const log of message.newLogs || []) if (log.type === 'position-close' && log.side === 'long'
    && log.closedAt >= inspectFrom && log.closedAt <= Date.parse('2026-04-03T00:00:00+08:00'))
    closes.push({ time: log.closedAt, openedAt: log.openedAt, openPrice: log.openPrice,
      closePrice: log.closePrice, pnl: log.pnl, funding: log.funding });
  if (time < inspectFrom || time > inspectTo) return;
  if (!inspected) { lastSpecialMargin = Number(last.special.margin.long || 0); inspected = true; }
  const order = last.orders.long;
  const key = order?.deepLongStage ? `${order.createdAt}:${order.deepLongStage}` : '';
  if (key && key !== previousOrderKey) events.push({ type: 'placed', time, stage: order.deepLongStage,
    price: order.price, margin: order.margin, adds: last.positions.long?.adds });
  if (key) { previousOrderKey = key; previousOrderLabel = order.label; }
  const margin = Number(last.special.margin.long || 0);
  if (margin > lastSpecialMargin + 0.001) events.push({ type: 'filled', time,
    delta: margin - lastSpecialMargin, label: previousOrderLabel,
    adds: last.positions.long?.adds, positionMargin: last.positions.long?.margin });
  lastSpecialMargin = margin;
  const day = new Date(time + 8 * 3600_000).toISOString().slice(0, 10);
  if (day !== lastDay) {
    daily.push({ day, time, price: last.price, phase: last.overheat?.phase,
      longAdds: last.positions.long?.adds, longMargin: last.positions.long?.margin,
      longPnl: last.positions.long?.pnl, state: last.state });
    lastDay = day;
  }
};
let workerCode = fs.readFileSync(path.join(assets, workerFile), 'utf8');
const levelsOverride = process.env.DEEP_LEVELS;
if (levelsOverride) {
  if (!/^\.\d+,\.\d+,\.\d+$/.test(levelsOverride) || !workerCode.includes('.12,.22,.25'))
    throw new Error('DEEP_LEVELS 格式错误或当前构建中未找到原始档位');
  workerCode = workerCode.replace('.12,.22,.25', levelsOverride);
}
vm.runInNewContext(workerCode, context, { filename: workerFile });

(async () => {
  context.onmessage({ data: { type: 'init-start', candleCount: count, funding,
    settings: { symbol: 'XAUUSDT', marginUsdt: 20, leverage: 20, makerFee: 0,
      tickSize: 0.01, qtyStep: 0.001, walletBalance: 40000, orderTtlMs: 90_000 } } });
  const chunkSize = 4000;
  for (let start = 0; start < count; start += chunkSize) {
    const end = Math.min(count, start + chunkSize);
    const chunk = flat.slice(start * 6, end * 6);
    context.onmessage({ data: { type: 'init-chunk', buffer: chunk.buffer, start, count: end - start } });
  }
  context.onmessage({ data: { type: 'init-complete' } });
  await prepared;
  context.onmessage({ data: { type: 'play', speed: 5000 } });
  while (last?.progress < 1 || !last) {
    if (!intervalCallback) throw new Error('回放计时器意外停止');
    if (last?.time >= inspectFrom && last.time < inspectTo) context.onmessage({ data: { type: 'speed', speed: 1 } });
    else context.onmessage({ data: { type: 'speed', speed: 5000 } });
    intervalCallback();
  }
  context.onmessage({ data: { type: 'peak-fills', side: 'long' } });
  console.log(JSON.stringify({ count, fundingCount: funding.length, levels: levelsOverride || '.12,.22,.25', settings: { margin: 20, leverage: 20,
    makerFee: 0, tickSize: 0.01, qtyStep: 0.001, walletBalance: 40000 },
  events, daily, closes, peakFills,
  final: { realized: last.realized, realizedBySide: last.realizedBySide,
    realizedFunding: last.realizedFunding, maxLossPeak: last.maxLossPeak,
    special: last.special, tradeCount: last.tradeCount } }, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; });
