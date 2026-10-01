const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDirectionResult } = require('../lib/tradfiDirection');
const { makeContextHash, PROMPT_VERSION } = require('../lib/tradfiAnalysis');
const analysisStore = require('../lib/tradfiAnalysisStore');
const { mapKline } = require('../lib/tradfiMarkets');

function bars({ count = 80, trend = 0, flat = false, intervalMs = 300_000, start = 100 } = {}) {
  return Array.from({ length: count }, (_unused, index) => {
    const close = flat ? start : start + trend * index + Math.sin(index / 3) * 0.08;
    return { openTime: 1_700_000_000_000 + index * intervalMs, open: close - 0.03, high: close + 0.15,
      low: close - 0.15, close, volume: flat ? 100 : 80 + (index % 7) * 5, closeTime: 1_700_000_000_000 + (index + 1) * intervalMs - 1 };
  });
}
function marketContext(klines = {}, quoteChange = null) {
  return { quote: quoteChange == null ? null : { lastPrice: '100', priceChangePercent: quoteChange },
    klines: Object.fromEntries(Object.entries(klines).map(([interval, values]) => [interval,
      { available: true, stale: false, latestBarTime: values.at(-1)?.openTime || null, bars: values },
    ])) };
}
const emptyIntel = { fundamentals: { rows: [], status: 'unavailable' }, events: { items: [] }, news: { items: [] } };

test('5m price bars enable ultra-short direction even when every auxiliary source is missing', () => {
  const result = buildDirectionResult({ marketContext: marketContext({ '5m': bars({ trend: 0.3 }) }), ...emptyIntel });
  assert.equal(result.timeframes.ultraShort.directionAllowed, true);
  assert.equal(result.timeframes.ultraShort.status, 'PRICE_ONLY');
  assert.notEqual(result.timeframes.ultraShort.status, 'INSUFFICIENT');
  assert.equal(result.timeframes.shortTerm.status, 'INSUFFICIENT');
  assert.equal(result.timeframes.mediumLong.status, 'INSUFFICIENT');
});

test('1h price bars enable short-term direction even when SEC fundamentals are unavailable', () => {
  const result = buildDirectionResult({ marketContext: marketContext({ '1h': bars({ trend: 0.4, intervalMs: 3_600_000 }) }), ...emptyIntel });
  assert.equal(result.timeframes.shortTerm.directionAllowed, true);
  assert.equal(result.timeframes.shortTerm.status, 'PRICE_ONLY');
  assert.equal(result.timeframes.ultraShort.status, 'INSUFFICIENT');
});

test('daily bars allow medium-long price direction without fundamentals, with limited confidence', () => {
  const result = buildDirectionResult({ marketContext: marketContext({ '1d': bars({ count: 90, trend: 0.5, intervalMs: 86_400_000 }) }), ...emptyIntel });
  const frame = result.timeframes.mediumLong;
  assert.equal(frame.directionAllowed, true);
  assert.ok(['PRICE_ONLY', 'PARTIAL'].includes(frame.status));
  assert.ok(['LOW', 'MEDIUM'].includes(frame.confidenceLevel));
});

test('no core 1h bars means short-term insufficient with null score and confidence', () => {
  const result = buildDirectionResult({ marketContext: marketContext({}), ...emptyIntel });
  const frame = result.timeframes.shortTerm;
  assert.equal(frame.status, 'INSUFFICIENT');
  assert.equal(frame.directionAllowed, false);
  assert.equal(frame.direction, null);
  assert.equal(frame.score, null);
  assert.equal(frame.confidenceScore, null);
  assert.equal(frame.confidenceLevel, null);
});

test('flat complete data is neutral rather than insufficient; 24h zero remains a neutral fact', () => {
  const result = buildDirectionResult({
    marketContext: marketContext({ '1h': bars({ flat: true, intervalMs: 3_600_000 }) }, 0),
    fundamentals: { rows: [{ label: 'metric', value: '1', asOf: null }], status: 'ok' },
    events: { items: [], source: 'calendar' }, news: { items: [{ title: 'item' }] },
  });
  const frame = result.timeframes.shortTerm;
  assert.equal(frame.directionAllowed, true);
  assert.notEqual(frame.status, 'INSUFFICIENT');
  assert.equal(frame.direction, 'NEUTRAL');
  assert.equal(frame.score, 0);
  assert.ok(frame.neutralFacts.some((item) => item.includes('接近平盘')));
  assert.deepEqual(frame.bullEvidenceCandidates, []);
});

test('null values stay unavailable rather than becoming numeric zero', () => {
  const row = [1_700_000_000_000, '10', '11', '9', '10', null, 1_700_000_299_999];
  assert.equal(mapKline(row), null);
  const context = marketContext({ '1h': bars({ flat: true, intervalMs: 3_600_000 }) });
  context.quote = { lastPrice: '100', priceChangePercent: null };
  const result = buildDirectionResult({ marketContext: context, ...emptyIntel });
  assert.ok(!result.timeframes.shortTerm.neutralFacts.some((item) => item.includes('24h 涨跌')));
});

test('stable context hashing makes the same completed context reusable', () => {
  const context = { symbol: 'XAUUSDT', quote: { lastPrice: 100 }, klines: { '5m': { latestBarTime: 1 } } };
  const intel = { fundamentals: { updatedAt: 'a', rows: [] }, events: { updatedAt: 'b', items: [] }, news: { updatedAt: 'c', items: [] } };
  const directionResult = buildDirectionResult({ marketContext: marketContext({}), ...emptyIntel });
  const input = { symbol: 'XAUUSDT', marketContext: context, intel, directionResult };
  const hash1 = makeContextHash(input);
  const hash2 = makeContextHash({ ...input, marketContext: { klines: { '5m': { latestBarTime: 1 } }, quote: { lastPrice: 100 } } });
  assert.equal(hash1, hash2);
  const key = { userId: 'direction-test', symbol: 'XAUUSDT', contextHash: hash1, engineVersion: directionResult.version, promptVersion: PROMPT_VERSION };
  const row = analysisStore.createPending({ ...key, context, directionResult });
  analysisStore.updateStatus(row.analysisId, 'COMPLETED', { model: 'test-model', explanation: { summary: 'cached' } });
  const cached = analysisStore.findByContext(key);
  assert.equal(cached.status, 'COMPLETED');
  assert.equal(cached.analysisId, row.analysisId);
});
