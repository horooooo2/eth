const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/isolateSqlite');
const { getDb } = require('../lib/db');
const { createFillFactProjection } = require('../lib/fillFactProjection');
const { canonicalTradeId } = require('../lib/positionEventPolicy');
const { eventsFromTrade } = require('../lib/sqliteStore');
const now = Date.now(), day = 86400000;
const projection = () => createFillFactProjection({ getDb, retentionMs: 2 * day,
  classify: eventsFromTrade, canonicalId: canonicalTradeId });
const trade = (id, extra = {}) => ({ id, whaleId: 'a', asset: 'BTC', side: 'buy',
  startPosition: 0, amount: 1, amountUsd: 100, time: now - 1000, price: 100, ...extra });
function save(t) {
  getDb().prepare('INSERT OR REPLACE INTO fills(id,whale_id,time,payload_json) VALUES(?,?,?,?)')
    .run(t.id, t.whaleId, t.time, JSON.stringify(t));
}

test('batched rebuild yields, shares work and preserves same-timestamp fills and live corrections', async () => {
  const db = getDb(); db.exec('DELETE FROM fills');
  db.transaction(() => { for (let i = 0; i < 1100; i++) save(trade(String(i).padStart(6, '0'))); })();
  const p = projection();
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  const first = p.prepare();
  // Correct a row already read by the first batch, then add a late fill behind its cursor.
  for (const t of [trade('000000', { side: 'sell', amountUsd: 200 }), trade('late', { time: now - 2000 })]) {
    save(t); p.update([t]);
  }
  try { await Promise.all([first, p.prepare()]); } finally { clearInterval(timer); }
  assert.ok(ticks > 0, 'the rebuild must not monopolize the event loop');
  const facts = [...p.read(now - day, now, true)];
  assert.equal(facts.length, 1101);
  assert.equal(facts.filter(r=>r.side==='long').reduce((n,r)=>n+r.usd,0),110000);
  assert.equal(facts.filter(r=>r.side==='short').reduce((n,r)=>n+r.usd,0),200);
  assert.equal([...p.read(now - day, now, true, new Set(['missing']))].length, 0);
  p.invalidate(); await p.prepare();
  const byId=(a,b)=>a.id.localeCompare(b.id);
  assert.deepEqual([...p.read(now - day, now, true)].sort(byId), facts.sort(byId));
});

test('corrections remove ineligible facts and reversal legs retain exact values', async () => {
  getDb().exec('DELETE FROM fills');
  const t = trade('reverse', { startPosition: 2, side: 'sell', amount: 3, amountUsd: 300 });
  save(t); const p = projection(); await p.prepare();
  assert.deepEqual([...p.read(now - day, now, true)].map(e => [e.kind, e.usd]), [['close', 200], ['open', 100]]);
  const invalid = { ...t, instrumentType: 'spot' }; save(invalid); p.update([invalid]);
  assert.equal([...p.read(now - day, now, true)].length, 0);
});

test('fixed batch clock retains both window boundaries and excludes old and future fills', async () => {
  const db = getDb(); db.exec('DELETE FROM fills');
  const batchNow = now - 3 * day;
  for (const [id,time] of [['old',batchNow-day-1],['lower',batchNow-day],['upper',batchNow],['future',batchNow+1]]) {
    save(trade(id,{time}));
  }
  const progress=[];
  const p=createFillFactProjection({getDb,retentionMs:day,now:()=>batchNow,untilMs:batchNow,
    classify:eventsFromTrade,canonicalId:canonicalTradeId,onProgress:value=>progress.push(value)});
  await p.prepare();
  assert.equal(progress.at(-1).scanned,2);
  assert.equal(progress.at(-1).ready,true);
  assert.deepEqual([...p.read(batchNow-day,batchNow,true)].map(row=>row.time),[batchNow-day,batchNow]);
  assert.equal([...p.read(batchNow-day,batchNow,true)].reduce((sum,r)=>sum+r.usd,0),200);
});

test('large raw payloads are not retained in JS heap and statistics have no display cap', async () => {
  const db = getDb(); db.exec('DELETE FROM fills');
  const count = Number(process.env.FILL_MEMORY_ROWS) || 3000;
  const padding = 'x'.repeat(Number(process.env.FILL_MEMORY_PADDING) || 4096);
  const insert = db.prepare('INSERT INTO fills(id,whale_id,time,payload_json) VALUES(?,?,?,?)');
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const t = trade('large-' + i, { irrelevantRawPayload: padding });
      insert.run(t.id, t.whaleId, t.time, JSON.stringify(t));
    }
  })();
  const p = projection(); let ticks = 0, peakHeap = 0;
  const timer = setInterval(() => { ticks++; peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed); }, 1);
  const start = Date.now();
  try { await p.prepare(); } finally { clearInterval(timer); }
  const result = [...p.read(now - day, now, true)];
  assert.equal(result.reduce((sum,r)=>sum+r.usd,0), count * 100);
  assert.equal(result.length, count);
  assert.ok(ticks > 0);
  assert.equal(db.pragma('temp_store', { simple: true }), 1);
  console.log(JSON.stringify({ rows: count, rawPaddingBytes: count * padding.length,
    buildMs: Date.now() - start, heartbeatTicks: ticks, peakHeapMiB: Math.round(peakHeap / 1048576) }));
});
