'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/isolateSqlite');
const rules = require('../lib/contractResearchRules');
const service = require('../lib/contractResearch');
const store = require('../lib/contractResearchStore');
const { getDb } = require('../lib/db');
const now = Date.parse('2026-10-15T12:30:00+08:00');
function bars(interval = '1h', count = 90) {
  const ms = { '1h': 3600000, '4h': 14400000, '1d': 86400000 }[interval], boundary = Math.floor(now / ms) * ms;
  return Array.from({ length: count }, (_, i) => { const close = 100 + i * 0.2; return { openTime: boundary - (count - i) * ms, closeTime: boundary - (count - i - 1) * ms - 1,
    open: close - 0.1, high: close + 0.3, low: close - 0.3, close, volume: 100 }; });
}
const kline = (interval = '1h') => ({ available: true, stale: false, bars: bars(interval) });
function emptySnapshot(id = 'test-snapshot') {
  return { id, symbol: 'SNDKUSDT', horizon: 3, generatedAt: Date.now(), sources: [
    { id: 'finance', kind: 'financial', title: 'filing', url: 'https://www.sec.gov/', stale: false },
    { id: 'ref', kind: 'reference', title: 'directory' }, { id: 'event', kind: 'event', title: 'future' },
    { id: 'stale', kind: 'headline', title: 'old cache', stale: true }, { id: 'tech', kind: 'computed', title: 'MA' },
  ], dimensions: rules.DIMENSIONS.map(d => ({ ...d, bull: d.id === 'technical' ? 8 : null, bear: d.id === 'technical' ? 1 : null, sourceIds: [], method: 'test' })) };
}
test('missing and zero are distinct, and unsafe source URLs are rejected', () => {
  assert.equal(rules.number(null), null); assert.equal(rules.number(''), null); assert.equal(rules.number(false), null);
  assert.equal(rules.number(0), 0); assert.equal(rules.safeUrl('javascript:alert(1)'), null); assert.equal(rules.safeUrl('https://name:secret@example.com/'), null);
});

test('research defaults to a 30-day analysis and retains only the last 30 days of collected news/events', async () => {
  assert.equal(service.normalize({symbol:'BTCUSDT'}).horizon,30);
  const market={symbol:'BTCUSDT',name:'比特币',baseAsset:'BTC',assetType:'CRYPTO'};
  const loaders=Array.from({length:9},()=>()=>Promise.reject(Error('offline')));
  loaders[4]=()=>({items:[20,31,-1].map(days=>({title:`news-${days}`,publishedAt:new Date(now-days*86400000).toISOString(),url:'https://example.com/news',source:'fixture'}))});
  loaders[6]=()=>({events:[20,31,-1].map(days=>({title:`CPI-${days}`,date:new Date(now-days*86400000).toISOString().slice(0,10),actual:'3%',sourceUrl:'https://www.bls.gov/'}))});
  const data=await service.buildSnapshot('BTCUSDT',30,{now,resolveMarket:async()=>market,loaders});
  assert.equal(data.lookbackDays,30);
  assert.deepEqual(data.sources.filter(s=>s.kind==='headline').map(s=>s.title),['news-20']);
  assert.deepEqual(data.sources.filter(s=>s.kind==='macro').map(s=>s.title),['CPI-20']);
  assert.ok(data.events.some(e=>e.title==='CPI-20'));assert.ok(!data.events.some(e=>e.title==='CPI-31'));
});

test('research news has its own 30-day window without widening the shared news page default', () => {
  const {rssRows}=require('../lib/tradfiIntel');
  const xml=[20,31].map(days=>`<item><title>Day ${days}</title><link>https://news.google.com/articles/${days}</link><pubDate>${new Date(Date.now()-days*86400000).toUTCString()}</pubDate></item>`).join('');
  const market={baseAsset:'BTC',assetType:'CRYPTO'};
  assert.equal(rssRows(xml,market).length,0);
  assert.equal(rssRows(xml,market,30).length,1);
});
test('technical analysis ignores live candle and does not infer a reversal from RSI alone', () => {
  const data = kline(), expected = rules.technicalFrame(data, '1h', now);
  assert.equal(expected.available, true); assert.equal(expected.rsi, 100); assert.ok(expected.bull > expected.bear);
  data.bars.push({ ...data.bars.at(-1), openTime: now, closeTime: now + 3600000, close: 1 });
  assert.deepEqual(rules.technicalFrame(data, '1h', now), expected);
});
test('insufficient, stale, gapped and invalid candles cannot produce a score', () => {
  assert.equal(rules.technicalFrame({ available: true, bars: bars('1h', 54) }, '1h', now).bull, null);
  assert.equal(rules.technicalFrame({ ...kline(), stale: true }, '1h', now).available, false);
  const gap = kline(); gap.bars.splice(-20, 1); assert.equal(rules.technicalFrame(gap, '1h', now).available, false);
  const invalid = kline(); invalid.bars.at(-1).low = 200; assert.equal(rules.technicalFrame(invalid, '1h', now).available, false);
  assert.equal(rules.technicalFrame(kline(), '1h', now + 3 * 3600000).available, false);
});
test('missing timeframes are never silently reweighted', () => {
  const output = rules.technicalSummary({ '1h': kline() }, 3, now); assert.equal(output.bull, null); assert.equal(output.frames[0].available, true);
});
test('partial coverage is an interval, not zero-filled or normalized to available weights', () => {
  const dimensions = rules.DIMENSIONS.map(d => ({ ...d, bull: 8, bear: 2 })); dimensions.find(d => d.id === 'technical').bull = null;
  const result = rules.aggregate(dimensions); assert.equal(result.coverage, 75); assert.deepEqual(result.bull, { low: 6, high: 8.5 });
  assert.equal(rules.aggregate(dimensions.map(d => ({ ...d, bull: null, bear: null }))).bull, null);
});
test('today events with unknown time remain visible, and date timezone is Shanghai', () => {
  const events = [{ id: 'today', date: '2026-10-15', title: 'time unknown' }, { id: 'past', at: '2026-10-14T23:00:00+08:00' }, { id: 'earnings', at: '2026-10-29T16:30:00-04:00' }];
  const windows = rules.eventWindows(events, now); assert.deepEqual(windows[0].events, ['today']); assert.deepEqual(windows[2].events, ['today', 'earnings']);
  assert.equal(new Date(rules.eventTime(events[2])).toISOString(), '2026-10-29T20:30:00.000Z');
});
test('stress uses trade direction and optional margin; unknown funding remains unknown', () => {
  const input = { notional: 10000, margin: 1000, side: 'short', days: 30, fundingRate: 0.0001, intervalHours: 8 }, result = rules.calculateStress(input);
  assert.equal(result.moves.find(m => m.move === -10).pnl, 1000); assert.equal(result.moves.find(m => m.move === -10).marginRatio, 100); assert.equal(result.funding[1].cost, -90);
  assert.deepEqual(rules.calculateStress({ ...input, fundingRate: null }).funding, []); assert.equal(rules.calculateStress({ ...input, margin: null }).moves[0].marginRatio, null);
  assert.throws(() => rules.calculateStress({ ...input, notional: 0 }), /有效/);
});
test('source references and program scores are enforced on AI output', () => {
  const snapshot = emptySnapshot(), analysis = rules.parseAnalysis(JSON.stringify({ summary: 'test', dimensions: [
    { id: 'fundamental', bull: 7, bear: 3, reason: 'filing', sourceIds: ['finance'] }, { id: 'technical', bull: 0, bear: 10, reason: 'overwrite', sourceIds: ['finance'] },
    { id: 'institutional', bull: 8, bear: 2, reason: 'fake source', sourceIds: ['invented'] }, { id: 'event', bull: 9, bear: 0, reason: 'future result', sourceIds: ['event'] },
  ], bullEvidence: [{ text: 'valid', sourceIds: ['finance'] }, { text: 'unsupported', sourceIds: ['unknown'] }] }), snapshot);
  assert.equal(analysis.dimensions.find(d => d.id === 'fundamental').bull, 7); assert.equal(analysis.dimensions.find(d => d.id === 'technical').bull, 8);
  for (const id of ['institutional', 'event']) assert.equal(analysis.dimensions.find(d => d.id === id).bull, null, id);
  assert.equal(analysis.bullEvidence.length, 1); assert.throws(() => rules.parseAnalysis('not json', snapshot), /格式/);
});
test('loader coalesces requests, bounds concurrency, caches and recovers after failure', async () => {
  const loader = service.createLoader({ limit: 1 }); let release, calls = 0; const task = () => new Promise(resolve => { calls++; release = resolve; });
  const a = loader.get('a', task), b = loader.get('a', task); await assert.rejects(loader.get('b', task), e => e.status === 429);
  await Promise.resolve(); release({ value: 10 }); assert.deepEqual(await a, await b); assert.equal(calls, 1);
  assert.deepEqual(await loader.get('a', () => { throw Error('should not load'); }), { value: 10 });
  await assert.rejects(loader.get('c', () => { throw Error('fail'); }), /fail/); assert.equal(loader.pending(), 0);
});
test('partial upstream failures still return a snapshot with explicit missing data', async () => {
  const market = { symbol: 'SNDKUSDT', name: '闪迪', assetType: 'TRADFI', baseAsset: 'SNDK', category: 'EQUITY' }, loaders = Array.from({ length: 8 }, () => () => Promise.reject(Error('offline')));
  loaders[1] = () => kline('1h'); loaders[2] = () => kline('4h'); loaders[3] = () => kline('1d');
  const snapshot = await service.buildSnapshot('SNDKUSDT', 30, { now, resolveMarket: async () => market, loaders });
  assert.equal(snapshot.technical.available, true); assert.equal(snapshot.scores.coverage, 25); assert.equal(snapshot.quote, null); assert.equal(snapshot.derivatives.fundingRate, null);
  assert.ok(snapshot.events.some(e => e.id === 'sndk-fy2027-q1-call')); assert.ok(snapshot.warnings.length >= 3); assert.ok(snapshot.id);
});
test('recent published macro actuals enter the source set but future releases do not', async () => {
  const market = { symbol: 'SNDKUSDT', name: '闪迪', assetType: 'TRADFI', baseAsset: 'SNDK', category: 'EQUITY' }, loaders = Array.from({ length: 8 }, () => () => Promise.reject(Error('offline')));
  loaders[6] = () => ({ events: [
    { title: 'CPI（同比）', date: '2026-10-14', time: '20:30', previous: '3.4%', forecast: '3.6%', actual: '3.7%', actualSource: 'BLS', actualUrl: 'https://api.bls.gov/publicAPI/v2/timeseries/data/' },
    { title: 'CPI（未来）', date: '2026-10-20', time: '20:30', actual: '9%' },
  ] });
  const snapshot = await service.buildSnapshot('SNDKUSDT', 3, { now, resolveMarket: async () => market, loaders });
  const macro = snapshot.sources.filter(s => s.kind === 'macro'); assert.equal(macro.length, 1); assert.match(macro[0].text, /3.7%/); assert.match(macro[0].text, /3.6%/);
});
test('derivatives reject stale and discontinuous periods without inventing a funding interval', () => {
  const empty = service.normalizeDerivatives({}, now); assert.equal(empty.intervalHours, null); assert.equal(empty.takerRatio, null);
  const old = service.normalizeDerivatives({ premium: { time: now - 3600000, markPrice: 100, indexPrice: 99, lastFundingRate: 0.1 } }, now); assert.equal(old.markPrice, null); assert.equal(old.fundingRate, null);
  const boundary = Math.floor(now / 3600000) * 3600000, oi = Array.from({ length: 25 }, (_, i) => ({ timestamp: boundary - (24 - i) * 3600000, sumOpenInterest: 100 + i }));
  const taker = Array.from({ length: 24 }, (_, i) => ({ timestamp: boundary - (24 - i) * 3600000, buyVol: '200', sellVol: '100' }));
  const result = service.normalizeDerivatives({ oi, taker }, now); assert.equal(result.takerRatio, 2); assert.equal(result.oiChangePct, 24);
  oi[3].timestamp += 1; assert.equal(service.normalizeDerivatives({ oi, taker }, now).openInterest, null); taker.splice(5, 1); assert.equal(service.normalizeDerivatives({ taker }, now).takerRatio, null);
});
test('stored snapshots are isolated, immutable on finish, bounded and interrupted jobs recover', () => {
  const snapshot = emptySnapshot(), row = store.create('alice', snapshot, 'RUNNING'); assert.equal(store.get(row.id, 'bob'), null); assert.deepEqual(store.list('bob', 'SNDKUSDT'), []);
  snapshot.horizon = 30; assert.equal(store.get(row.id, 'alice').snapshot.horizon, 3); store.finish(row.id, 'alice', { analysis: { summary: 'first' } }); store.finish(row.id, 'alice', { analysis: { summary: 'second' } });
  assert.equal(store.get(row.id, 'alice').analysis.summary, 'first'); const abandoned = store.create('alice', emptySnapshot('interrupted'), 'RUNNING');
  getDb().prepare('UPDATE contract_research_history SET created_at=? WHERE id=?').run(Date.now() - 130000, abandoned.id); assert.equal(store.get(abandoned.id, 'alice').status, 'FAILED');
  for (let i = 0; i < 110; i++) store.create('charlie', emptySnapshot(String(i))); assert.equal(store.list('charlie', 'SNDKUSDT').length, 100);
  assert.ok(store.list('charlie', 'SNDKUSDT').every(r => !('payload_json' in r) && !('snapshot' in r)));
  const kept = store.create('charlie', emptySnapshot('keep-running'), 'RUNNING');
  for (let i = 0; i < 105; i++) store.create('charlie', emptySnapshot('new-' + i));
  assert.equal(store.get(kept.id, 'charlie').status, 'RUNNING'); assert.equal(store.list('charlie', 'SNDKUSDT').length, 100);
});
test('research routes require auth and preserve user isolation', async () => {
  const express = require('express'), auth = require('../lib/authStore'); auth.createUser('research-alice', 'test-only-password'); const token = auth.login('research-alice', 'test-only-password').token;
  const app = express(); app.use(express.json()); app.use('/research', require('../routes/contractResearch')); const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/research`;
  try {
    assert.equal((await fetch(base + '/history?symbol=SNDKUSDT')).status, 401); const privateRow = store.create('someone-else', emptySnapshot('private'));
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    assert.equal((await fetch(base + '/history/' + privateRow.id, { headers })).status, 404);
    assert.equal((await fetch(base + '/analyze', { method: 'POST', headers, body: JSON.stringify({ snapshotId: 'missing' }) })).status, 409);
    assert.equal((await fetch(base + '/history?symbol=bad', { headers })).status, 400); assert.equal((await fetch(base + '/history?symbol=SNDKUSDT', { headers })).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('AI jobs deduplicate, bound concurrency, complete once and reuse saved result', async () => {
  const express = require('express'), auth = require('../lib/authStore'), keys = require('../lib/userAiKeys');
  const client = require('../lib/deepseekClient'), originalAi = client.deepseekFetch, originalFind = service.findSnapshot;
  const calls = [], users = ['job-a', 'job-b', 'job-c'].map(name => { const user = auth.createUser(name, 'test-job-password'); keys.upsertAiKey(user.id, 'deepseek', 'test-key-never-sent'); return { id: user.id, token: auth.login(name, 'test-job-password').token }; });
  client.deepseekFetch = () => new Promise(resolve => calls.push(resolve));
  service.findSnapshot = id => ({ ...emptySnapshot(id), market: { name: '闪迪' } });
  const routePath = require.resolve('../routes/contractResearch'); delete require.cache[routePath];
  const app = express(); app.use(express.json()); app.use('/research', require(routePath));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/research`;
  const post = (index, id = 'job-snapshot') => fetch(base + '/analyze', { method: 'POST', headers: { Authorization: `Bearer ${users[index].token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshotId: id, web: false }) });
  try {
    const first = await post(0); assert.equal(first.status, 202); const record = await first.json();
    assert.equal((await (await post(0)).json()).id, record.id);
    assert.equal((await post(0, 'other-snapshot')).status, 429);
    assert.equal((await post(1)).status, 202); assert.equal((await post(2)).status, 429); assert.equal(calls.length, 2);
    calls.forEach(resolve => resolve({ choices: [{ message: { content: JSON.stringify({ summary: '完成研判', dimensions: [] }) } }] }));
    await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
    const done = store.get(record.id, users[0].id); assert.equal(done.status, 'COMPLETED'); assert.equal(done.analysis.summary, '完成研判');
    const reused = await post(0); assert.equal(reused.status, 200); assert.equal((await reused.json()).id, record.id); assert.equal(calls.length, 2);
  } finally { client.deepseekFetch = originalAi; service.findSnapshot = originalFind; delete require.cache[routePath]; await new Promise(resolve => server.close(resolve)); }
});
