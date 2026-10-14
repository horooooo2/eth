'use strict';
// Historical pre-fix reproductions: these deliberately assert the old bugs and should fail after fixes.
// Current regressions live in whale-tracker-backend/tests; all fixtures here use a private temp directory.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '../whale-tracker-backend');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-market-review-'));
process.env.SQLITE_PATH = path.join(dir, 'facts.db');
process.env.CACHE_DIR = path.join(dir, 'cache');
const Database = require(path.join(root, 'node_modules/better-sqlite3'));
const { computeWindow } = require(path.join(root, 'lib/macroComparisonCompute'));
const { createStore } = require(path.join(root, 'lib/macroComparisonStore'));
const { compare } = require(path.join(root, 'lib/macroComparisonRules'));
const at = Date.UTC(2026, 9, 14, 12, 30), from = at - 3600000;
const event = { title: 'CPI（同比）', date: '2026-10-14', time: '20:30', forecast: '3.6%', actual: '3.7%' };
const roster = [{ id: 'a', address: '0x' + '1'.repeat(40) }, { id: 'b', address: '0x' + '2'.repeat(40) }];
const findings = [];
let db, stores = [];
function history(name) { const store = createStore(path.join(dir, name + '.db'), from - 86400000); stores.push(store); return store; }
function marks(through) { db.prepare('INSERT OR REPLACE INTO sync_meta VALUES(?,?)').run('fills_address_watermarks_v2', JSON.stringify(Object.fromEntries(roster.map(row => [row.address, { coverageStart: from - 1, through }])))); }
function insert(id, whaleId, side, usd, startPosition = 0) {
  const trade = { id, whaleId, asset: 'BTC', time: at - 60000, side, amount: usd / 100, amountUsd: usd, source: 'hyperliquid', startPosition };
  db.prepare('INSERT INTO fills VALUES(?,?,?,?,?,?,?)').run(id, trade.time, 'BTC', 'hyperliquid', JSON.stringify(trade), at - 10000, at - 10000);
}
async function main() {
  db = new Database(process.env.SQLITE_PATH);
  db.exec('CREATE TABLE fills(id TEXT PRIMARY KEY,time INTEGER,asset TEXT,source TEXT,payload_json TEXT,received_at INTEGER,fact_updated_at INTEGER); CREATE INDEX fills_time ON fills(time); CREATE TABLE sync_meta(key TEXT PRIMARY KEY,value TEXT);');
  insert('a:1', 'a', 'sell', 700); insert('b:2', 'b', 'sell', 300);
  const input = { database: process.env.SQLITE_PATH, releaseAt: at, roster, now: at + 2000 };
  marks(at - 60000);
  const store = history('coverage'); store.archive([event], from - 60000);
  const job = store.nextJob(at + 2000), initial = computeWindow({ ...input, mode: job.mode });
  store.commit(job, initial, at + 2000);
  marks(at + 60000);
  const repairedJob = store.nextJob(at + 900000), repaired = computeWindow({ ...input, mode: repairedJob.mode, now: at + 900000 });
  store.commit(repairedJob, repaired, at + 900000);
  assert.equal(initial.coverage.complete, false); assert.equal(repaired.coverage.complete, true);
  assert.equal(store.summary(at + 900000).BTC.eligible, 0);
  findings.push({ issue: 'coverage_frozen_too_early', initialCoverage: initial.coverage, repairedCoverage: repaired.coverage, repairedMode: repaired.mode, summary: store.summary(at + 900000).BTC });

  insert('a:unknown', 'a', 'buy', 10000000, null);
  const skipped = computeWindow({ ...input, mode: 'PRE_RELEASE' });
  assert.equal(skipped.quality.scanned, 3); assert.equal(skipped.coins.BTC.fills, 2);
  assert.equal(compare('SHORT', skipped.coins.BTC, skipped).eligible, true);
  findings.push({ issue: 'unclassifiable_fill_not_flagged', scanned: skipped.quality.scanned, counted: skipped.coins.BTC.fills, quality: skipped.quality, comparison: compare('SHORT', skipped.coins.BTC, skipped) });

  const empty = computeWindow({ ...input, mode: 'RETROSPECTIVE', roster: [] });
  assert.equal(empty.coverage.monitored, 0); assert.equal(empty.coins.BTC.whales, 2);
  findings.push({ issue: 'empty_cohort_includes_unmonitored_fills', monitored: empty.coverage.monitored, countedWhales: empty.coins.BTC.whales, countedUsd: empty.coins.BTC.shortUsd });

  const forecasts = history('forecast');
  forecasts.archive([{ ...event, actual: '' }], from - 60000);
  forecasts.archive([{ ...event, actual: '', forecast: '4.0%' }], from + 1800000);
  forecasts.archive([{ ...event, forecast: '4.0%' }], at + 1000);
  const forecastJob = forecasts.nextJob(at + 2000);
  // Only use fully classified, timely data for this independent scenario.
  db.prepare('DELETE FROM fills WHERE id=?').run('a:unknown');
  const complete = computeWindow({ ...input, mode: 'PRE_RELEASE' });
  forecasts.commit(forecastJob, complete, at + 2000);
  const changed = forecasts.list({ at: at + 3000 }).rows[0];
  assert.equal(changed.event.forecast, '4.0%'); assert.equal(changed.event.forecastObservedAt, from - 60000);
  assert.equal(forecasts.summary(at + 3000).BTC.eligible, 1);
  findings.push({ issue: 'forecast_change_keeps_old_observation_time', forecast: changed.event.forecast, observationBeforeWindow: changed.event.forecastObservedAt <= from, summary: forecasts.summary(at + 3000).BTC });

  const { createCollector } = require(path.join(root, 'lib/marketMovements'));
  const M = 60000; let clock = Date.UTC(2026, 9, 14, 10), replacements = false;
  const symbols = Array.from({ length: 100 }, (_, i) => ({ symbol: `SYM${String(i).padStart(3, '0')}USDT`, quoteVolume24h: String(1000 - i) }));
  const bars = () => Array.from({ length: 121 }, (_, i) => { const t = Math.floor(clock / M) * M - (121 - i) * M; return [t,100,100,100,100,1,t+M-1]; });
  const socket = () => { const s = new EventEmitter(); s.send = () => {}; s.terminate = () => s.emit('close'); return s; };
  const collector = createCollector({ now: () => clock, catalog: async () => ({ contracts: replacements ? [...symbols.slice(0,99),{symbol:'SYM100USDT',quoteVolume24h:'1'}] : symbols }), openSocket: socket, fetchBars: async () => bars() });
  collector.start();
  try {
    await new Promise(resolve => setImmediate(resolve));
    for (let i = 0; i < 100; i++) { await collector.seedNext(); clock += 2000; }
    assert.equal(collector.snapshot().warming, 0);
    clock += 3600000;
    const freshBars = bars().map(row => ({ time: row[0], open: 100, high: 100, low: 100, close: 100 }));
    for (const row of symbols) collector.engine.seed(row.symbol, freshBars);
    assert.equal(collector.snapshot().ready2h, 100);
    replacements = true; await collector.discover();
    assert.equal(collector.snapshot().warming, 100);
    findings.push({ issue: 'one_universe_change_reseeds_all_100', changedContracts: 1, readyRetainedContracts: collector.snapshot().ready2h, queuedSeeds: collector.snapshot().warming });
  } finally { collector.stop(); }

  const axios = require(path.join(root, 'node_modules/axios/dist/node/axios.cjs'));
  const oldPost = axios.post, oldNow = Date.now; let calls = 0, cpiClock = at + 61000;
  const { enrichCpiActuals } = require(path.join(root, 'lib/cpiActuals'));
  axios.post = async () => {
    calls++;
    return { data: { status: 'REQUEST_SUCCEEDED', Results: { series: [{ seriesID:'CUUR0000SA0', data: calls === 1 ? [] : [{year:'2026',period:'M09',value:'103.7'},{year:'2025',period:'M09',value:'100'}] }] } } };
  };
  Date.now = () => cpiClock;
  try {
    const pendingEvent = { ...event, actual: '' };
    const first = await enrichCpiActuals([pendingEvent]);
    cpiClock += 120000;
    const twoMinutes = await enrichCpiActuals([pendingEvent]);
    assert.equal(calls, 1); assert.equal(twoMinutes[0].actual, '');
    cpiClock += 3600000;
    const hourLater = await enrichCpiActuals([pendingEvent]);
    assert.equal(calls, 2); assert.equal(hourLater[0].actual, '3.7%');
    findings.push({ issue: 'incomplete_bls_response_cached_one_hour', firstActual: first[0].actual, afterTwoMinutes: twoMinutes[0].actual, callsAfterTwoMinutes: 1, afterOneHour: hourLater[0].actual });
  } finally { axios.post = oldPost; Date.now = oldNow; }
  console.log(JSON.stringify({ reproduced: findings.length, findings }, null, 2));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
  for (const store of stores) store.close(); db?.close();
  const resolved = path.resolve(dir);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('macro-market-review-')) throw Error('Unexpected cleanup path');
  fs.rmSync(resolved, { recursive: true, force: true });
});
