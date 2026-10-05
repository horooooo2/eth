/** Latest observations and historical coverage have independent, bounded workers. */
const { fetchUserFillsByTime, mapFillToTrade, FILL_LOOKBACK_MS } = require('./hyperliquid');
const { commitWhaleState } = require('./cache');
const { getMeta, setMeta } = require('./db');
const { normalizeAddress, getActiveWhales } = require('./config');
const DAY_MS = 86400000;
const META_KEY = 'fills_address_watermarks_v2';
const ENABLED = process.env.WHALE_FILL_CAPTURE !== '0';
const INTERVAL_MS = Math.max(1000, Number(process.env.FILL_BACKFILL_INTERVAL_MS) || 1000);
const DAYS = Math.max(1, Math.min(7, Number(process.env.FILL_BACKFILL_DAYS) || 3));
const RATE_LIMIT_PAUSE_MS = Math.max(60000, Number(process.env.FILL_BACKFILL_RATE_LIMIT_MS) || 300000);
const OVERLAP_MS = 60000;
const LATEST_WINDOW_MS = 15 * 60000;
let timer, historyTimer;
let historyRunning = false, cursor = 0, historyCursor = 0, rateLimitedUntil = 0, lastError = '', resetGeneration = 0;
const active = new Set(), attempted = new Map();
function loadWatermarks() {
  try { return JSON.parse(getMeta(META_KEY)?.value || '{}') || {}; } catch { return {}; }
}
function listWhales() {
  return [...new Map(getActiveWhales().filter(w => normalizeAddress(w.address)).map(w => {
    const address = normalizeAddress(w.address); return [address, { ...w, address }];
  })).values()];
}
function saveAddress(address, update, generation) {
  if (generation !== resetGeneration) return;
  const latest = loadWatermarks();
  latest[address] = { ...latest[address], ...update, updatedAt: Date.now() };
  setMeta(META_KEY, JSON.stringify(latest));
}
function failed(address, error, generation, update = {}) {
  if (generation !== resetGeneration || error.code === "HL_HISTORY_DEFERRED") return;
  lastError = error.message || String(error);
  if (error.status === 429 || /429|过于频繁/.test(lastError)) rateLimitedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
  saveAddress(address, { ...update, lastError }, generation);
  console.warn('[fill-backfill]', address, lastError);
}
function ingest(whale, fills) {
  if (!Array.isArray(fills) || fills.complete === false) throw Object.assign(new Error('Incomplete fill reconciliation'), { code: 'HL_FILLS_INCOMPLETE' });
  return commitWhaleState('hf', { trades: fills.map(f => mapFillToTrade(f, whale, {})).filter(t => t?.id) });
}
async function runOneTick() {
  if (!ENABLED || active.size >= 2 || rateLimitedUntil > Date.now()) return;
  const marks = loadWatermarks(), now = Date.now();
  const roster = listWhales();
  const ids = new Set(roster.map(w => w.address));
  for (const id of attempted.keys()) if (!ids.has(id)) attempted.delete(id);
  const whale = roster.filter(w => !active.has(w.address) && now - (attempted.get(w.address) || 0) >= 30000)
    .sort((a, b) => Math.max(attempted.get(a.address) || 0, marks[a.address]?.latestObservedAt || 0) -
      Math.max(attempted.get(b.address) || 0, marks[b.address]?.latestObservedAt || 0))[0];
  if (!whale) return;
  const generation = resetGeneration, entry = marks[whale.address] || {};
  const width = Math.max(1, Number(entry.latestWindowMs) || LATEST_WINDOW_MS);
  const start = Math.max(now - width, Number(entry.latestObservedAt) ? Number(entry.latestObservedAt) - OVERLAP_MS : now - width);
  active.add(whale.address); attempted.set(whale.address, now); cursor++;
  try {
    const fills = await fetchUserFillsByTime(whale.address, start, now);
    if (generation !== resetGeneration) return;
    const result = ingest(whale, fills);
    // Re-read after await: the historical worker may have advanced the same address.
    const current = loadWatermarks()[whale.address] || entry;
    const previous = Number(current.through) || 0;
    const through = previous && previous < start ? previous : Math.max(previous, now);
    saveAddress(whale.address, { latestObservedAt: now, latestCoverageStart: start, through,
      coverageStart: current.coverageStart ?? start, historyBefore: current.historyBefore ?? start,
      coverageStatus: through < now - 120000 ? 'catching-up' : 'observed-window',
      historicalCompleteness: 'unknown-upstream-retention', latestWindowMs: Math.min(LATEST_WINDOW_MS, width * 2), lastError: '' }, generation);
    const previousObservation = Number(entry.latestObservedAt || entry.through) || 0;
    const newFills = previousObservation ? fills.filter(fill => Number(fill.time) > previousObservation) : [];
    if (newFills.some(fill => now - Number(fill.time) <= 120000) && result?.committedAlerts?.length) require('./whaleSync').markLiveAlerts(result.committedAlerts);
    if (newFills.length) void require('./whales').refreshWhalePositionFromSource(whale.id).catch(() => {});
    lastError = '';
  } catch (error) {
    failed(whale.address, error, generation, error.code === 'HL_FILLS_INCOMPLETE' ? { latestWindowMs: Math.max(1, Math.floor(width / 2)) } : {});
  } finally { active.delete(whale.address); }
}
async function runHistoryTick() {
  if (!ENABLED || historyRunning || rateLimitedUntil > Date.now()) return;
  const roster = listWhales(); if (!roster.length) return;
  const marks = loadWatermarks(), now = Date.now(), generation = resetGeneration;
  const ordered = roster.map((_,i) => roster[(historyCursor + i) % roster.length]);
  const eligible = ordered.filter(w => marks[w.address]?.latestObservedAt && marks[w.address]?.through);
  const whale = eligible.find(w => Number(marks[w.address].through) < Number(marks[w.address].latestCoverageStart || marks[w.address].latestObservedAt))
    || eligible.find(w => Number(marks[w.address].historyBefore) > now - DAYS * DAY_MS);
  if (!whale) return;
  historyCursor = (roster.indexOf(whale) + 1) % roster.length;
  const entry = marks[whale.address];
  // Never allow history to seed or delay the first latest observation.
  if (!entry.latestObservedAt || !entry.through) return;
  const forward = Number(entry.through) < Number(entry.latestCoverageStart || entry.latestObservedAt);
  const width = Math.max(1, Number(forward ? entry.windowMs : entry.historyWindowMs) || 3600000);
  const before = Number(entry.historyBefore);
  if (!forward && !(before > now - DAYS * DAY_MS)) return;
  const start = forward ? Number(entry.through) : Math.max(now - DAYS * DAY_MS, before - width);
  const end = forward ? Math.min(start + width, entry.latestObservedAt) : before;
  historyRunning = true;
  try {
    const fills = await fetchUserFillsByTime(whale.address, start, end, { priority: 'history' });
    if (generation !== resetGeneration) return;
    ingest(whale, fills);
    const current = loadWatermarks()[whale.address] || entry;
    saveAddress(whale.address, forward ? { through: Math.max(Number(current.through) || 0, end), windowMs: Math.min(3600000, width * 2), gap: null }
      : { historyBefore: start, coverageStart: Math.min(Number(current.coverageStart) || start, start), historyWindowMs: Math.min(DAY_MS, width * 2), historyGap: null }, generation);
  } catch (error) {
    failed(whale.address, error, generation, error.code === 'HL_FILLS_INCOMPLETE' ?
      (forward ? { windowMs: Math.max(1, Math.floor(width / 2)), gap: start } : { historyWindowMs: Math.max(1, Math.floor(width / 2)), historyGap: start }) : {});
  } finally { historyRunning = false; }
}
function getCoverageStatus(now = Date.now()) {
  const marks = loadWatermarks(), whales = listWhales();
  const fresh = whales.filter(w => now - (marks[w.address]?.latestObservedAt || 0) <= 180000).length;
  const continuous = whales.filter(w => marks[w.address]?.coverageStart && marks[w.address].coverageStart <= now - DAY_MS &&
    now - (marks[w.address].through || 0) <= 180000 &&
    Number(marks[w.address].through) >= Number(marks[w.address].latestCoverageStart || marks[w.address].latestObservedAt) && !marks[w.address].gap && !marks[w.address].historyGap).length;
  return { monitored: whales.length, freshAddresses: fresh, continuous24hAddresses: continuous,
    complete: whales.length > 0 && continuous === whales.length, scope: 'locally-observed',
    historicalCompleteness: 'unknown-upstream-retention' };
}
function getBackfillStatus() {
  const watermarks = loadWatermarks(), whales = listWhales();
  return { enabled: ENABLED, feature: 'continuous-fill-capture', intervalMs: INTERVAL_MS, days: DAYS, lookbackMs: FILL_LOOKBACK_MS,
    running: active.size > 0, activeLatestWorkers: active.size, historyRunning, whaleIndex: cursor, whaleTotal: whales.length,
    done: false, continuous: true, reconciledAddresses: whales.filter(w => watermarks[w.address]?.through).length,
    watermarks, coverage: getCoverageStatus(), lastError, rateLimited: rateLimitedUntil > Date.now(), rateLimitedUntil };
}
function resetFillBackfill() { resetGeneration++; setMeta(META_KEY, '{}'); attempted.clear(); cursor = historyCursor = 0; rateLimitedUntil = 0; startFillBackfill(); return getBackfillStatus(); }
function startFillBackfill() {
  if (!ENABLED || timer) return;
  timer = setInterval(() => void runOneTick(), INTERVAL_MS); timer.unref?.();
  historyTimer = setInterval(() => void runHistoryTick(), 15000); historyTimer.unref?.();
}
function stopFillBackfill() { resetGeneration++; clearInterval(timer); clearInterval(historyTimer); timer = historyTimer = null; }
module.exports = { startFillBackfill, stopFillBackfill, resetFillBackfill, getBackfillStatus, getCoverageStatus, runOneTick, runHistoryTick };
