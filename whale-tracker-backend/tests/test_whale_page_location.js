const assert = require('node:assert/strict');
const test = require('node:test');
// Mock only snapshot/config readers: never write the real cache or request upstream data.
const config = require('../lib/config');
const cache = require('../lib/cache');
const whales = Array.from({ length: 45 }, (_, i) => ({
  id: 'w' + i, name: 'whale ' + i, fills24h: 45 - i,
  positions: [{ coin: 'BTC', side: 'long', size: 1, positionValue: 1000 + i, unrealizedPnl: i, lastAddTime: i + 1 }],
}));
const noPosition = { id: 'closed', positions: [] };
config.readConfig = () => ({ mode: 'hf' });
config.getActiveWhales = () => [...whales, noPosition];
cache.readWhaleModeCache = () => ({ data: { mode: 'hf', whales: [...whales, noPosition] }, updatedAt: 123 });
const { queryWhaleCache } = require('../lib/whales');

test('location loads the natural page at every boundary without changing rank', () => {
  for (const index of [0, 19, 20, 39, 40, 44]) {
    const result = queryWhaleCache({ limit: 20, sort: 'all', locateId: 'w' + index });
    const offset = Math.floor(index / 20) * 20;
    assert.equal(result.located, true);
    assert.equal(result.page, Math.floor(index / 20) + 1);
    assert.deepEqual(result.whales.map(w => w.id), whales.slice(offset, offset + 20).map(w => w.id));
    assert.equal(result.whales[index % 20].id, 'w' + index);
    assert.equal(result.total, 45);
    const ordinary = queryWhaleCache({ offset, limit: 20, sort: 'all' });
    assert.deepEqual(result.whales, ordinary.whales);
  }
});
test('location respects the requested ordering and does not fabricate closed/missing profiles', () => {
  const result = queryWhaleCache({ limit: 20, sort: 'positionValue', locateId: 'w0' });
  assert.equal(result.page, 3);
  assert.equal(result.whales[4].id, 'w0');
  for (const locateId of ['closed', 'unknown']) {
    const missing = queryWhaleCache({ limit: 20, locateId });
    assert.equal(missing.located, false);
    assert.deepEqual(missing.whales, []);
    assert.equal(missing.total, 45);
  }
});
