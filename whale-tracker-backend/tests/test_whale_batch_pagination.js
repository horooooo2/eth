const assert = require('node:assert/strict');
const test = require('node:test');
const { formatCachedBatchPayload, formatKnownCachedBatchPayload } = require('../lib/whales');

test('cached whale batch honors offset/limit and partitions activity by page', () => {
  const whales = Array.from({ length: 5 }, (_, index) => ({
    id: `whale-${index}`,
    name: `Whale ${index}`,
    positions: [{ coin: `COIN${index}`, size: 1 }],
  }));
  const trades = whales.map((whale, index) => ({
    id: `trade-${index}`, whaleId: whale.id, asset: `COIN${index}`, time: 1000 + index,
  }));
  trades.push({ id: 'global-onchain', source: 'onchain', asset: 'BTC', time: 2000 });
  const cached = { updatedAt: 1234, stale: false, data: { mode: 'hf', whales, trades, warnings: [] } };

  const first = formatCachedBatchPayload(cached, 'hf', { offset: 0, limit: 2 });
  assert.deepEqual(first.whales.map((whale) => whale.id), ['whale-0', 'whale-1']);
  assert.deepEqual(first.trades.map((trade) => trade.id), ['trade-0', 'trade-1', 'global-onchain']);
  assert.equal(first.total, 5);
  assert.equal(first.nextOffset, 2);
  assert.equal(first.done, false);

  const second = formatCachedBatchPayload(cached, 'hf', { offset: 2, limit: 2 });
  assert.deepEqual(second.whales.map((whale) => whale.id), ['whale-2', 'whale-3']);
  assert.deepEqual(second.trades.map((trade) => trade.id), ['trade-2', 'trade-3']);
  assert.equal(second.nextOffset, 4);

  const last = formatCachedBatchPayload(cached, 'hf', { offset: 4, limit: 2 });
  assert.deepEqual(last.whales.map((whale) => whale.id), ['whale-4']);
  assert.deepEqual(last.trades.map((trade) => trade.id), ['trade-4']);
  assert.equal(last.done, true);
});

test('read-only cache pages omit uncollected and failed placeholders without changing total semantics', () => {
  const cached = {
    updatedAt: 5678, stale: true, data: {
      mode: 'hf',
      whales: [
        { id: 'known-1', positions: [{ coin: 'BTC', size: 1 }] },
        { id: 'pending', positions: [], error: '等待刷新' },
        { id: 'failed', positions: [], error: 'upstream unavailable' },
        { id: 'known-2', positions: [{ coin: 'ETH', size: 1 }] },
      ],
      trades: [], warnings: [],
    },
  };
  const page = formatKnownCachedBatchPayload(cached, 'hf', { offset: 0, limit: 1 });
  assert.deepEqual(page.whales.map((whale) => whale.id), ['known-1']);
  assert.equal(page.total, 2);
  assert.equal(page.done, false);
  const last = formatKnownCachedBatchPayload(cached, 'hf', { offset: 1, limit: 1 });
  assert.deepEqual(last.whales.map((whale) => whale.id), ['known-2']);
  assert.equal(last.done, true);
});
