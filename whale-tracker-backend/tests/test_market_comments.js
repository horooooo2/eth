const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseComments, createCommentService, boardFor } = require('../lib/marketComments');
const tick = () => new Promise(resolve => setImmediate(resolve));
test('only matching user posts survive, dates use Shanghai timezone, scripts are not executed', () => {
  const row = { post_id: 123, post_type: 0, stockbar_code: 'hk01810', user_nickname: '<b>A</b>', post_title: 'quote " brace }', post_publish_time: '2026-10-09 09:00:00' };
  const html = `var article_list=${JSON.stringify({ re: [row, row, { ...row, post_id: 124, post_type: 1 }, { ...row, post_id: 125, stockbar_code: 'usnvda' }] })};alert('must not run')`;
  const items = parseComments(html, 'hk01810');
  assert.equal(items.length, 1); assert.equal(items[0].author, 'A');
  assert.equal(items[0].publishedAt, Date.parse('2026-10-09T01:00:00Z'));
  assert.throws(() => parseComments('<html>login required</html>', 'hk01810'));
  assert.equal(boardFor('BTCUSDT'), null);
  assert.equal(boardFor('MUUUSDT'), 'usmuu');
});
test('requests return immediately, deduplicate by board, limit concurrency to two and reuse cache', async () => {
  const pending = []; let calls = 0, now = 1000;
  const service = createCommentService({ now: () => now, fetcher: () => { calls++; return new Promise((resolve, reject) => pending.push({ resolve, reject })); } });
  assert.equal(service.get('HK1810USDT').pending, true);
  service.get('XIAOMIUSDT'); service.get('NVDAUSDT'); service.get('WDCUSDT');
  await tick(); assert.equal(calls, 2);
  pending[0].resolve([{ id: '1' }]); await tick(); assert.equal(calls, 3);
  pending[1].resolve([]); pending[2].resolve([]); await tick();
  assert.equal(service.get('HK1810USDT').items.length, 1); assert.equal(calls, 3);
  now += 600001; service.get('HK1810USDT'); await tick(); pending[3].reject(new Error('offline')); await tick();
  const stale = service.get('HK1810USDT'); assert.equal(stale.stale, true); assert.equal(stale.items.length, 1);
  assert.equal(calls, 4); assert.equal(service.get('BTCUSDT').supported, false);
});
