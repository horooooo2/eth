'use strict';

const MAX_POSITION_AGE_MS = Math.max(30000, Number(process.env.POSITION_FRESH_MS) || 180000);
function summarizeFreshness(whales = [], now = Date.now()) {
  const times = whales.map(w => Number(w?.positionObservedAt) || 0);
  const known = times.filter(t => t > 0 && t <= now);
  const freshCount = known.filter(t => now - t <= MAX_POSITION_AGE_MS).length;
  return {
    asOf: now, scope: 'native-perp', stale: freshCount !== times.length || !times.length,
    freshness: { total: times.length, freshCount, staleCount: known.length - freshCount,
      unknownCount: times.length - known.length, maxAgeMs: MAX_POSITION_AGE_MS,
      oldestObservedAt: known.length ? Math.min(...known) : null,
      newestObservedAt: known.length ? Math.max(...known) : null },
  };
}
module.exports = { summarizeFreshness, MAX_POSITION_AGE_MS };
