const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
function load(file, dependencies = {}) {
  const exports = {};
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: name => dependencies[name] });
  return exports;
}
const cards = load('whaleCardUtils.ts', { '@/utils/watchedCoins': { normalizeCoinId: s => s.toUpperCase().replace(/[^A-Z0-9]/g, '') } });
const assets = load('assets.ts');
test('HIP-3 positions and filters preserve market identity without admitting spot indices', () => {
  const whale = { positions: ['BTC', 'xyz:SNDK', 'cash:SNDK', '@12'].map(coin => ({ coin, side: 'long', size: 1, positionValue: 100 })) };
  assert.equal(cards.visibleWhalePositions(whale, 'all').length, 3);
  assert.equal(cards.visibleWhalePositions(whale, 'xyz:SNDK').length, 1);
  assert.equal(cards.visibleWhalePositions(whale, 'SNDK').length, 0);
  assert.equal(assets.isSelectableAsset('xyz:SNDK'), true);
  assert.equal(assets.isSelectableAsset('@12'), false);
});

const details = load('contractDetails.ts');
const labels = load('whaleAssetLabel.ts', { './contractDetails': details });
const preferences = load('whalePreferredAssets.ts', {
  vue: {}, '@/stores/whale': {}, './watchedCoins': {}, './tradfiWatch': {}, './whaleAssetLabel': labels,
});
test('whale filters include only preferred underlyings and preserve separate DEX symbols', () => {
  const result = preferences.preferredWhaleAssets(['BTC', 'SNDK', 'XAU'],
    ['ETH', 'xyz:SNDK', 'para:SNDK', 'xyz:GOLD', 'xyz:NVDA']);
  assert.deepEqual(Array.from(result), ['BTC', 'xyz:SNDK', 'para:SNDK', 'xyz:GOLD']);
  assert.deepEqual(Array.from(preferences.preferredWhaleAssets(['BTC'], ['xyz:SNDK'])), ['BTC']);
});
test('TradFi badges use known underlyings instead of all expanded market assets', () => {
  assert.equal(labels.whaleAssetLabel('xyz:SNDK'), 'SNDK（闪迪）');
  for (const coin of ['xyz:SNDK', 'xyz:GOLD', 'xyz:SOXL']) assert.equal(labels.isWhaleTradfi(coin), true);
  for (const coin of ['BTC', 'xyz:BTC', 'para:OTHERS', 'xyz:UNKNOWN']) assert.equal(labels.isWhaleTradfi(coin), false);
});

const sorting=load('validationSort.ts');
test('validation sorting keeps unknown values last in either direction and leaves snapshots unchanged',()=>{
 const rows=[{address:'a',usd:10,entryPx:null,unrealizedPnl:-4},{address:'b',usd:20,entryPx:12,unrealizedPnl:null},{address:'c',usd:5,entryPx:3,unrealizedPnl:2}];
 const ids=list=>Array.from(list,row=>row.address).join(',');
 assert.equal(ids(sorting.sortValidationPositions(rows,'entryPx',true)),'c,b,a');
 assert.equal(ids(sorting.sortValidationPositions(rows,'entryPx',false)),'b,c,a');
 assert.equal(ids(sorting.sortValidationPositions(rows,'unrealizedPnl',false)),'c,a,b');
 assert.equal(ids(sorting.sortValidationPositions(rows,'usd',false)),'b,a,c');assert.equal(ids(rows),'a,b,c');
});

test('opening-time sort puts unavailable times last without substituting observation times',()=>{
 const rows=[{address:'a',usd:1,entryPx:1,unrealizedPnl:0,openTime:null,observedAt:1},{address:'b',usd:1,entryPx:1,unrealizedPnl:0,openTime:200},{address:'c',usd:1,entryPx:1,unrealizedPnl:0,openTime:100}];
 assert.equal(Array.from(sorting.sortValidationPositions(rows,'openTime',true),r=>r.address).join(','),'c,b,a');
 assert.equal(Array.from(sorting.sortValidationPositions(rows,'openTime',false),r=>r.address).join(','),'b,c,a');
});
