'use strict';

const MAX_POSITION_AGE_MS = Math.max(30000, Number(process.env.POSITION_FRESH_MS) || 180000);
function summarizeFreshness(whales = [], now = Date.now()) {
  let knownCount = 0, freshCount = 0, oldest = Infinity, newest = 0;
  for (const whale of whales) {
    const time = Number(whale?.positionObservedAt) || 0;
    if (time <= 0 || time > now) continue;
    knownCount++;
    oldest = Math.min(oldest, time); newest = Math.max(newest, time);
    if (now - time <= MAX_POSITION_AGE_MS) freshCount++;
  }
  return {
    asOf: now, scope: 'native-perp', stale: freshCount !== whales.length || !whales.length,
    freshness: { total: whales.length, freshCount, staleCount: knownCount - freshCount,
      unknownCount: whales.length - knownCount, maxAgeMs: MAX_POSITION_AGE_MS,
      oldestObservedAt: knownCount ? oldest : null,
      newestObservedAt: knownCount ? newest : null },
  };
}
module.exports = { summarizeFreshness, MAX_POSITION_AGE_MS };
