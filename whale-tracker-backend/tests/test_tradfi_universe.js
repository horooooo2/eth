const test = require('node:test'), assert = require('node:assert/strict');
require('./helpers/isolateSqlite');
const { classifyTradfi, liquidityFor, tradingDay } = require('../lib/tradfiUniverse');
const { mapKline } = require('../lib/tradfiMarkets');
const DAY = 86400000, end = Date.parse('2026-10-08T00:00:00Z');
const bars = (volume = 1000000, cutoff = end) => Array.from({ length: 91 }, (_, i) => ({
  openTime: cutoff - (91 - i) * DAY, closeTime: cutoff - (90 - i) * DAY - 1, close: 100 + i, quoteVolume: volume,
}));

test('stocks, funds and commodities are distinct; China ADRs and Chinese listings are exempt', () => {
  for (const symbol of ['HK1810USDT', 'KUAISHOUUSDT', 'BYDUSDT', 'ZHONGJIUSDT', 'BABAUSDT', 'PDDUSDT', 'JDUSDT', 'BIDUUSDT', 'NTESUSDT', 'TCOMUSDT']) {
    assert.equal(classifyTradfi(symbol).assetGroup, 'STOCK');
    assert.equal(classifyTradfi(symbol).liquidityExempt, true);
    assert.equal(liquidityFor(symbol, bars(0), end).filtered, false);
  }
  for (const symbol of ['QQQUSDT', 'KORUUSDT', 'NVDLUSDT', 'CSOPSKHYNIX2LUSDT']) assert.equal(classifyTradfi(symbol).assetGroup, 'INDEX_ETF');
  for (const symbol of ['XAUUSDT', 'COPPERUSDT', 'CLUSDT', 'NATGASUSDT']) assert.equal(classifyTradfi(symbol).assetGroup, 'METAL_ENERGY');
  assert.equal(classifyTradfi('NEWUNKNOWNUSDT').assetGroup, 'UNKNOWN');
  assert.equal(liquidityFor('NEWUNKNOWNUSDT', bars(0), end).filtered, false);
});

test('daily bars retain actual quote turnover; missing volume is never synthesized from closing price', () => {
  const raw = [end - DAY, '1', '2', '.5', '1.5', '123', end - 1, '5000000'];
  assert.equal(mapKline(raw).quoteVolume, 5000000);
  assert.equal(mapKline(raw.slice(0, 7)).quoteVolume, null);
  assert.equal(mapKline([...raw.slice(0, 7), '']).quoteVolume, null);
  assert.equal(mapKline([...raw.slice(0, 7), '-1']).quoteVolume, null);
});

test('recent 20 trading-day average excludes weekends, US holidays and unfinished bars; exactly 5M passes', () => {
  const history = bars().map(bar => ({ ...bar, quoteVolume: tradingDay(bar.openTime, 'US') ? 1000000 : 999999999 }));
  history.push({ openTime: end, closeTime: end + DAY - 1, quoteVolume: 999999999 });
  const result = liquidityFor('WDCUSDT', history, end);
  assert.equal(result.sampleDays, 20); assert.equal(result.averageQuoteVolume, 1000000); assert.equal(result.filtered, true);
  assert.equal(liquidityFor('WDCUSDT', bars(5000000), end).filtered, false);
  const holidayEnd = Date.parse('2026-07-06T00:00:00Z');
  const holidayHistory = bars(1000000, holidayEnd).map(bar => ({ ...bar, quoteVolume: bar.openTime === Date.parse('2026-07-03T00:00:00Z') ? 999999999 : 1000000 }));
  assert.equal(liquidityFor('AAPLUSDT', holidayHistory, holidayEnd).averageQuoteVolume, 1000000);
});

test('KR holiday calendar excludes Chuseok and substitute holidays without using the US calendar', () => {
  for (const date of ['2026-09-24', '2026-09-25', '2026-10-05', '2026-05-01', '2026-12-31']) assert.equal(tradingDay(Date.parse(date + 'T00:00:00Z'), 'KR'), false);
  assert.equal(tradingDay(Date.parse('2026-10-07T00:00:00Z'), 'KR'), true);
  const history = bars().map(bar => ({ ...bar, quoteVolume: tradingDay(bar.openTime, 'KR') ? 1000000 : 999999999 }));
  assert.equal(liquidityFor('SKHYNIXUSDT', history, end).averageQuoteVolume, 1000000);
  assert.equal(tradingDay(Date.parse('2027-12-31T00:00:00Z'), 'US'), true);
  assert.equal(tradingDay(Date.parse('2025-01-09T00:00:00Z'), 'US'), false);
});

test('missing, conflicting or unsupported-calendar samples are retained; real zero volume still counts', () => {
  const history = bars();
  const missing = history.filter(bar => bar.openTime !== end - DAY);
  assert.equal(liquidityFor('WDCUSDT', missing, end).status, 'insufficient');
  assert.equal(liquidityFor('WDCUSDT', missing, end).filtered, false);
  assert.equal(liquidityFor('WDCUSDT', [...history, { ...history.at(-1), quoteVolume: 2 }], end).status, 'conflicting-data');
  assert.equal(liquidityFor('WDCUSDT', bars(null), end).filtered, false);
  assert.equal(liquidityFor('WDCUSDT', bars(0), end).filtered, true);
  const future = Date.parse('2029-10-08T00:00:00Z');
  assert.equal(liquidityFor('WDCUSDT', bars(0, future), future).status, 'calendar-unavailable');
});

test('persisted filtering leaves full Socket rows and watch cards intact, and fails open on stale history', async () => {
  const { getDb } = require('../lib/db'), { createService } = require('../lib/radarLongTrend');
  const database = getDb();
  database.exec('CREATE TABLE IF NOT EXISTS radar_long_trends(symbol TEXT PRIMARY KEY,payload_json TEXT NOT NULL); DELETE FROM radar_long_trends');
  let clock = end, fail = false;
  const contracts = ['WDCUSDT', 'PDDUSDT', 'QQQUSDT'].map(symbol => ({ symbol, name: symbol, assetType: 'TRADFI' }));
  const service = createService({ getDb, now: () => clock, catalog: async () => ({ contracts }), pause: async () => {}, fetchBars: async () => { if (fail) throw Error('offline'); return bars(); } });
  await service.refresh();
  assert.equal(service.snapshot().count, 2);
  assert.equal(service.snapshotAll().rows.length, 3);
  assert.equal(service.snapshot({ watchSymbols: ['WDCUSDT'] }).watched[0].symbol, 'WDCUSDT');
  let requests = 0;
  const restored = createService({ getDb, now: () => clock, catalog: async () => ({ contracts }), pause: async () => {}, fetchBars: async () => { requests++; return bars(); } });
  await restored.refresh(); assert.equal(requests, 0); assert.equal(restored.snapshot().count, 2);
  clock += DAY; fail = true; await service.refresh();
  assert.equal(service.snapshot().count, 3);
  assert.equal(service.snapshotAll().rows.find(row => row.symbol === 'WDCUSDT').liquidity.filtered, false);
});
