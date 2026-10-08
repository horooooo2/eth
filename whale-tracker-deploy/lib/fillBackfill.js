/** Latest observations and historical coverage have independent, bounded workers. */
const { fetchUserFillsByTime, mapFillToTrade, FILL_LOOKBACK_MS, normalizeToHlFill, buildPositionOpenTiming, buildPositionEntryFills } = require('./hyperliquid');
const { commitWhaleState, readWhaleModeCache, captureWhaleRevisions } = require('./cache');
const { getMeta, setMeta } = require('./db');
const { normalizeAddress, getActiveWhales } = require('./config');
const DAY_MS = 86400000;
const META_KEY = 'fills_address_watermarks_v2';
const RESET_META_KEY = 'fills_reset_recovery_v1';
const ENABLED = process.env.WHALE_FILL_CAPTURE !== '0';
const INTERVAL_MS = Math.max(5000, Number(process.env.FILL_BACKFILL_INTERVAL_MS) || 5000);
const DAYS = 1;
const RATE_LIMIT_PAUSE_MS = Math.max(60000, Number(process.env.FILL_BACKFILL_RATE_LIMIT_MS) || 300000);
const OVERLAP_MS = 60000;
const LATEST_WINDOW_MS = 15 * 60000;
let timer, historyTimer;
let historyRunning = false, cursor = 0, historyCursor = 0, rateLimitedUntil = 0, lastError = '', resetGeneration = 0;
const active = new Set(), attempted = new Map();
let lastWhaleTotal = null, rosterObservedAt = null;
function loadRecovery() {
  try { return JSON.parse(getMeta(RESET_META_KEY)?.value || 'null'); } catch { return null; }
}
function loadWatermarks() {
  try { return JSON.parse(getMeta(META_KEY)?.value || '{}') || {}; } catch { return {}; }
}
function listWhales() {
  const whales = [...new Map(getActiveWhales().filter(w => normalizeAddress(w.address)).map(w => {
    const address = normalizeAddress(w.address); return [address, { ...w, address }];
  })).values()];
  lastWhaleTotal = whales.length; rosterObservedAt = Date.now();
  return whales;
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
async function ingest(whale, fills, generation, restoreTiming = false) {
  if (!Array.isArray(fills) || fills.complete === false) throw Object.assign(new Error('Incomplete fill reconciliation'), { code: 'HL_FILLS_INCOMPLETE' });
  const committedAlerts = [];
  if (!fills.length && generation === resetGeneration) commitWhaleState('hf', { trades: [] });
  for (let offset = 0; offset < fills.length; offset += 500) {
    if (generation !== resetGeneration) return null;
    const trades = fills.slice(offset, offset + 500).map(f => mapFillToTrade(f, whale, {})).filter(t => t?.id);
    const result = commitWhaleState('hf', { trades });
    committedAlerts.push(...(result?.committedAlerts || []));
    if (committedAlerts.length > 50) committedAlerts.splice(0, committedAlerts.length - 50);
    if (offset + 500 < fills.length) await new Promise(resolve => setImmediate(resolve));
  }
  if (generation !== resetGeneration) return null;
  const patch = { trades: [] };
  // Reuse captured executions for metadata; never fetch the same history again.
  if (restoreTiming) {
    const cached = readWhaleModeCache('hf')?.data;
    const current = cached?.whales?.find(w => w.id === whale.id);
    if (current && fills.length) {
      const lastFillAt = fills.reduce((last, f) => Math.max(last, Number(f.time) || 0), 0);
      const later = (cached.trades || []).filter(t => t.whaleId === whale.id && Number(t.time) > lastFillAt)
        .map(normalizeToHlFill);
      const captured = [...fills, ...later];
      patch.whales = [{ ...current, positions: (current.positions || []).map(pos => {
        if (pos.openHistoryComplete) return pos;
        const timing = buildPositionOpenTiming(captured, pos.coin, pos.size, pos.side);
        if (!timing.openTime || (!timing.openHistoryComplete && Number(pos.openTime) < timing.openTime && Number(pos.openTime) > 0)) return pos;
        return { ...pos, ...timing, ...buildPositionEntryFills(captured, pos.coin, pos.size, pos.side) };
      }) }];
      patch.expectedWhaleRevisions = captureWhaleRevisions('hf');
      patch.positionMetadataOnly = true;
    }
  }
  if (patch.whales) commitWhaleState('hf', patch);
  return { committedAlerts };
}
async function runOneTick() {
  if (!ENABLED || active.size >= 2 || rateLimitedUntil > Date.now()) return;
  const marks = loadWatermarks(), now = Date.now();
  const roster = listWhales();
  const ids = new Set(roster.map(w => w.address));
  for (const id of attempted.keys()) if (!ids.has(id)) attempted.delete(id);
  const whale = roster.filter(w => !active.has(w.address) && now - (attempted.get(w.address) || 0) >= 120000)
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
    const result = await ingest(whale, fills, generation);
    if (generation !== resetGeneration) return;
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
  const historyFloor = now - DAY_MS;
  const ordered = roster.map((_,i) => roster[(historyCursor + i) % roster.length]);
  const eligible = ordered.filter(w => marks[w.address]?.latestObservedAt && marks[w.address]?.through);
  const whale = eligible.find(w => Number(marks[w.address].through) < Number(marks[w.address].latestCoverageStart || marks[w.address].latestObservedAt))
    || eligible.find(w => Number(marks[w.address].historyBefore) > historyFloor);
  if (!whale) return;
  historyCursor = (roster.indexOf(whale) + 1) % roster.length;
  const entry = marks[whale.address];
  // Never allow history to seed or delay the first latest observation.
  if (!entry.latestObservedAt || !entry.through) return;
  const forward = Number(entry.through) < Number(entry.latestCoverageStart || entry.latestObservedAt);
  const width = Math.max(1, Number(forward ? entry.windowMs : entry.historyWindowMs) || (forward ? 3600000 : DAY_MS));
  const before = Number(entry.historyBefore);
  if (!forward && !(before > historyFloor)) return;
  const start = Math.max(historyFloor, forward ? Number(entry.through) : before - width);
  const end = forward ? Math.min(start + width, entry.latestObservedAt) : before;
  if (end <= start) return;
  historyRunning = true;
  try {
    const fills = await fetchUserFillsByTime(whale.address, start, end, { priority: 'history' });
    if (generation !== resetGeneration) return;
    await ingest(whale, fills, generation, !forward && start === historyFloor);
    if (generation !== resetGeneration) return;
    const current = loadWatermarks()[whale.address] || entry;
    saveAddress(whale.address, forward ? { through: Math.max(Number(current.through) || 0, end), windowMs: Math.min(3600000, width * 2), gap: null, lastError: '' }
      : { historyBefore: start, coverageStart: Math.min(Number(current.coverageStart) || start, start), historyWindowMs: Math.min(DAY_MS, width * 2), historyGap: null, lastError: '' }, generation);
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
// Health checks read only worker state; detailed coverage remains on-demand.
function getRuntimeStatus() {
  return { enabled: ENABLED, feature: 'continuous-fill-capture', intervalMs: INTERVAL_MS,
    days: DAYS, lookbackMs: FILL_LOOKBACK_MS, running: active.size > 0,
    activeLatestWorkers: active.size, historyRunning, whaleIndex: cursor,
    whaleTotal: lastWhaleTotal, rosterObservedAt, done: false, continuous: true,
    lastError, rateLimited: rateLimitedUntil > Date.now(), rateLimitedUntil };
}
function getBackfillStatus() {
  const watermarks = loadWatermarks(), whales = listWhales();
  return { enabled: ENABLED, feature: 'continuous-fill-capture', intervalMs: INTERVAL_MS, days: DAYS, lookbackMs: FILL_LOOKBACK_MS,
    running: active.size > 0, activeLatestWorkers: active.size, historyRunning, whaleIndex: cursor, whaleTotal: whales.length,
    done: false, continuous: true, reconciledAddresses: whales.filter(w => watermarks[w.address]?.through).length,
    watermarks, coverage: getCoverageStatus(), lastError, rateLimited: rateLimitedUntil > Date.now(), rateLimitedUntil };
}
function getResetRecoveryStatus() {
  const recovery = loadRecovery();
  if (!recovery) return null;
  const marks = loadWatermarks(), whales = listWhales();
  const ids = new Set(whales.map(w => w.address));
  const addresses = recovery.addresses.filter(address => ids.has(address));
  const recovered = addresses.filter(address => {
    const entry = marks[address];
    return entry && Number(entry.coverageStart) <= Math.max(recovery.since, Date.now() - DAY_MS) && Number(entry.through) >= recovery.startedAt
      && !entry.gap && !entry.historyGap;
  }).length;
  const errors = addresses.filter(address => marks[address]?.lastError).length;
  return { startedAt: recovery.startedAt, since: recovery.since, monitored: addresses.length,
    recovered, errors, status: !ENABLED ? 'disabled' : recovered === addresses.length ? 'complete' : 'recovering',
    historicalCompleteness: 'unknown-upstream-retention' };
}
function resetFillBackfill() {
  resetGeneration++;
  const startedAt = Date.now();
  setMeta(META_KEY, '{}');
  setMeta(RESET_META_KEY, JSON.stringify({ startedAt, since: startedAt - DAY_MS, addresses: listWhales().map(w => w.address) }));
  attempted.clear(); cursor = historyCursor = 0; rateLimitedUntil = 0; lastError = '';
  startFillBackfill();
  return getBackfillStatus();
}
function startFillBackfill() {
  if (!ENABLED || timer) return;
  timer = setInterval(() => void runOneTick(), INTERVAL_MS); timer.unref?.();
  historyTimer = setInterval(() => void runHistoryTick(), 15000); historyTimer.unref?.();
}
function stopFillBackfill() { resetGeneration++; clearInterval(timer); clearInterval(historyTimer); timer = historyTimer = null; }
module.exports = { startFillBackfill, stopFillBackfill, resetFillBackfill, getBackfillStatus, getRuntimeStatus, getCoverageStatus, getResetRecoveryStatus, runOneTick, runHistoryTick };
