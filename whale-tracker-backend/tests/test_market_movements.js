const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createEngine, MINUTE: M, DAY } = require('../lib/marketMovementEngine');
const { createCollector } = require('../lib/marketMovements');
const day = Date.UTC(2026, 9, 14), end = day + 180 * M;
const contract = { symbol: 'BTCUSDT', name: '比特币', quoteVolume24h: '100' };
const bar = (time, price = 100) => ({ time, open: price, close: price, high: price, low: price });
const history = Array.from({ length: 180 }, (_, i) => bar(day + i * M));
function setup(maxEvents) {
  const engine = createEngine({ now: () => end + M, maxEvents }); engine.configure([contract]); engine.seed(contract.symbol, history); return engine;
}
test('completed minute windows use exact 5m/120m baselines and classify threshold boundaries', () => {
  for (const [price, label] of [[103, '小涨'], [107, '中涨'], [111, '大涨'], [97, '小跌'], [93, '中跌'], [89, '大跌']]) {
    const engine = setup(); engine.ingest('BTCUSDT', bar(end, price));
    const events = engine.snapshot().events;
    assert.ok(events.some(row => row.label === `5分钟${label}`));
    assert.ok(events.some(row => row.label === `2小时${label}`));
  }
});
test('seed and repeated or older closed bars never replay notifications', () => {
  const engine = setup(); assert.equal(engine.snapshot().events.length, 0);
  const live = bar(end, 111); engine.ingest('BTCUSDT', live);
  const before = engine.snapshot().events;
  engine.ingest('BTCUSDT', live); engine.ingest('BTCUSDT', bar(end - M, 130));
  engine.seed('BTCUSDT', history);
  assert.equal(engine.latest('BTCUSDT'), end);
  assert.deepEqual(engine.snapshot().events, before);
});
test('gaps suppress rolling and day extrema until repaired; delayed seed preserves later live bar', () => {
  const engine = createEngine({ now: () => end + 3 * M }); engine.configure([contract]); engine.seed('BTCUSDT', history);
  engine.ingest('BTCUSDT', bar(end + M, 110));
  assert.equal(engine.snapshot().events.length, 0);
  assert.equal(engine.snapshot().readyDay, 0);
  engine.seed('BTCUSDT', [...history, bar(end)]);
  assert.equal(engine.latest('BTCUSDT'), end + M);
  assert.equal(engine.snapshot().readyDay, 1);
  assert.equal(engine.snapshot().ready2h, 1);
});
test('UTC day rollover does not reuse prior day extremes; a partial day cannot claim daily new highs', () => {
  const engine = createEngine({ now: () => day + DAY + 2 * M }); engine.configure([contract]);
  engine.seed('BTCUSDT', [bar(day + DAY - M, 200)]);
  engine.ingest('BTCUSDT', bar(day + DAY, 100));
  assert.equal(engine.snapshot().events.length, 0);
  engine.ingest('BTCUSDT', bar(day + DAY + M, 101));
  assert.ok(engine.snapshot().events.some(row => row.kind === 'HIGH'));
  const empty = createEngine({ now: () => end + M }); empty.configure([contract]);
  empty.seed('BTCUSDT', history.slice(-121)); empty.ingest('BTCUSDT', bar(end, 103));
  assert.equal(empty.snapshot().readyDay, 0);
  assert.ok(!empty.snapshot().events.some(row => row.kind === 'HIGH'));
});
test('invalid, future and stale data cannot emit; memory, cooldown and retention are bounded', () => {
  let clock = end + M;
  const engine = createEngine({ now: () => clock, maxEvents: 5 }); engine.configure([contract]); engine.seed('BTCUSDT', history);
  assert.equal(engine.ingest('BTCUSDT', { ...bar(end), close: NaN }), false);
  assert.equal(engine.ingest('BTCUSDT', bar(end + M)), false);
  engine.ingest('BTCUSDT', bar(end, 111));
  clock += M; engine.ingest('BTCUSDT', bar(end + M, 112));
  assert.equal(engine.snapshot().events.filter(row => row.kind === 'HIGH').length, 1);
  for (let i = 2; i < 1000; i++) { clock = end + (i + 1) * M; engine.ingest('BTCUSDT', bar(end + i * M, 100 + i)); }
  assert.equal(engine.buffered(), 121); assert.ok(engine.snapshot().events.length <= 5);
  clock += DAY; assert.equal(engine.snapshot().events.length, 0);
  assert.equal(engine.snapshot().ready5m, 0);
});
function fakeSocket() {
  const socket = new EventEmitter(); socket.sent = []; socket.send = value => socket.sent.push(JSON.parse(value));
  socket.terminate = () => socket.emit('close'); return socket;
}
test('collector shares one connection, caps universe at 100, and only closed 1m bars can notify', async () => {
  let socket, requests = 0;
  const collector = createCollector({ now: () => end + M,
    catalog: async () => ({ contracts: Array.from({ length: 120 }, (_, i) => ({ ...contract, symbol: `A${i}USDT`, quoteVolume24h: String(i + 1) })) }),
    openSocket: () => (socket = fakeSocket()), fetchBars: async () => { requests++; return history.map(row => [row.time, row.open, row.high, row.low, row.close, 1, row.time + M - 1]); } });
  collector.start();
  try {
    await collector.discover(); socket.emit('open');
    assert.equal(socket.sent[0].params.length, 100); assert.equal(collector.snapshot().monitored, 100);
    await collector.seedNext(); assert.equal(requests, 1);
    const symbol = 'A119USDT';
    const message = x => JSON.stringify({ data: { e: 'kline', s: symbol, k: { i: '1m', t: end, T: end + M - 1, o: '111', c: '111', h: '111', l: '111', x } } });
    socket.emit('message', message(false)); assert.equal(collector.engine.latest(symbol), end - M);
    socket.emit('message', message(true)); assert.ok(collector.snapshot().events.length);
    socket.emit('close'); assert.equal(collector.snapshot().stale, true);
  } finally { collector.stop(); }
});
test('429 pauses the shared backfill queue and late results after stop are discarded', async () => {
  let clock = end + M, calls = 0, resolve;
  const collector = createCollector({ now: () => clock, catalog: async () => ({ contracts: [contract] }), openSocket: fakeSocket,
    fetchBars: async () => { calls++; throw { response: { status: 429, headers: { 'retry-after': '120' } } }; } });
  collector.start();
  try {
    await collector.discover(); await collector.seedNext(); assert.equal(calls, 1);
    clock += 61000; await collector.seedNext(); assert.equal(calls, 1);
    clock += 61000; await collector.seedNext(); assert.equal(calls, 2);
  } finally { collector.stop(); }
  const late = createCollector({ now: () => end + M, catalog: async () => ({ contracts: [contract] }), openSocket: fakeSocket,
    fetchBars: () => new Promise(done => { resolve = done; }) });
  late.start(); await late.discover(); const task = late.seedNext(); late.stop();
  resolve(history.map(row => [row.time, row.open, row.high, row.low, row.close, 1, row.time + M - 1])); await task;
  assert.equal(late.engine.buffered(), 0);
});
