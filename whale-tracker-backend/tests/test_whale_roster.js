const test = require('node:test');
const assert = require('node:assert/strict');
const { selectWhaleRoster } = require('../lib/whaleRoster');
const whale = i => ({ id: String(i), address: `0x${i.toString(16).padStart(40, '0')}`, enabled: true });
test('verified TradFi wallets replace part of the roster without increasing fifty-wallet cap', () => {
  const ranked = Array.from({ length: 100 }, (_, i) => whale(i + 1));
  const selection = { addresses: ranked.slice(50, 85) };
  const rows = selectWhaleRoster([], ranked, selection);
  assert.equal(rows.length, 50);
  assert.deepEqual(rows.slice(0, 30), ranked.slice(50, 80));
  assert.deepEqual(rows.slice(30), ranked.slice(0, 20));
});
test('manual accounts survive, duplicates/disabled/unknown candidates never take slots', () => {
  const manual = { ...whale(100), manual: true };
  const ranked = Array.from({ length: 60 }, (_, i) => whale(i + 1));
  ranked[59].enabled = false;
  const selected = { addresses: [whale(999), whale(60), whale(51), whale(51), ...ranked.slice(51)] };
  const rows = selectWhaleRoster([manual], ranked, selected, 50);
  assert.equal(rows[0], manual);
  assert.equal(rows[1].id, '51');
  assert.equal(rows.length, 50);
  assert.equal(new Set(rows.map(w => w.address)).size, 50);
  assert.ok(!rows.some(w => w.id === '60' || w.id === '999'));
});
test('missing selection keeps original ranking and lower configured limits', () => {
  const ranked = Array.from({ length: 60 }, (_, i) => whale(i + 1));
  assert.deepEqual(selectWhaleRoster([], ranked, null, 5), ranked.slice(0, 5));
  assert.equal(selectWhaleRoster([], ranked, null, 500).length, 50);
});
