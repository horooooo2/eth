/** Continuous reconciliation for every monitored address, independent of WS coverage. */
const { fetchUserFillsByTime, mapFillToTrade, FILL_LOOKBACK_MS } = require('./hyperliquid');
const { commitWhaleState } = require('./cache');
const { getMeta, setMeta } = require('./db');
const { normalizeAddress, getActiveWhales } = require('./config');
const DAY_MS = 86400000;
const META_KEY = 'fills_address_watermarks_v2';
const ENABLED = process.env.WHALE_FILL_CAPTURE !== '0';
const INTERVAL_MS = Math.max(3000, Number(process.env.FILL_BACKFILL_INTERVAL_MS) || 5000);
const DAYS = Math.max(1, Math.min(7, Number(process.env.FILL_BACKFILL_DAYS) || 3));
const RATE_LIMIT_PAUSE_MS = Math.max(60000, Number(process.env.FILL_BACKFILL_RATE_LIMIT_MS) || 300000);
const OVERLAP_MS = 60000;
const INITIAL_WINDOW_MS = 60 * 60 * 1000;
let timer = null;
let startupTimer = null;
let running = false;
let cursor = 0;
let rateLimitedUntil = 0;
let lastError = '';
let resetGeneration = 0;

function loadWatermarks() {
  const raw = getMeta(META_KEY)?.value;
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}
function listWhales() {
  const unique = new Map();
  for (const whale of getActiveWhales()) {
    const address = normalizeAddress(whale.address);
    if (address && !unique.has(address)) unique.set(address, { ...whale, address });
  }
  return [...unique.values()];
}
function saveAddress(address, update, generation) {
  if (generation !== resetGeneration) return;
  const latest = loadWatermarks();
  latest[address] = { ...latest[address], ...update, updatedAt: Date.now() };
  setMeta(META_KEY, JSON.stringify(latest));
}
function noteFailure(address, error, start, width, history, generation) {
  lastError = error.message || String(error);
  if (error.status === 429 || /429|过于频繁/.test(lastError)) rateLimitedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
  if (error.code === 'HL_FILLS_INCOMPLETE' || /Incomplete fill reconciliation/.test(lastError)) {
    const smaller = Math.max(1, Math.floor(width / 2));
    saveAddress(address, history ? { historyWindowMs: smaller, historyGap: width <= 1 ? start : null }
      : { windowMs: smaller, pendingStart: start, gap: width <= 1 ? start : null }, generation);
  }
  console.warn('[fill-backfill]', address, lastError);
}
async function runOneTick() {
  if (running || !ENABLED || rateLimitedUntil > Date.now()) return;
  const whales = listWhales();
  if (!whales.length) return;
  running = true;
  const generation = resetGeneration;
  const whale = whales[cursor % whales.length];
  cursor = (cursor + 1) % whales.length;
  const now = Date.now();
  let start = now - INITIAL_WINDOW_MS;
  let end = now;
  try {
    const entry = loadWatermarks()[whale.address] || {};
    const previous = Number(entry.through) || 0;
    const width = Math.max(1, Number(entry.windowMs) || INITIAL_WINDOW_MS);
    const overlap = Math.min(OVERLAP_MS, Math.floor(width / 10));
    start = entry.pendingStart != null ? Number(entry.pendingStart) : previous ? Math.max(0, previous - overlap) : start;
    end = Math.min(now, start + width);
    const fills = await fetchUserFillsByTime(whale.address, start, end);
    if (generation !== resetGeneration) return;
    if (!Array.isArray(fills) || fills.complete === false) throw new Error('Incomplete fill reconciliation');
    const trades = fills.map((fill) => mapFillToTrade(fill, whale, {})).filter((trade) => trade?.id);
    const committed = commitWhaleState('hf', { trades });
    saveAddress(whale.address, { through: Math.max(previous, end), pendingStart: null, gap: null,
      windowMs: Math.min(INITIAL_WINDOW_MS, width * 2),
      historyBefore: entry.historyBefore ?? start }, generation);
    lastError = '';
    // A forward poll can discover fills older than the live-notification window.
    // Refresh their current position once; initial seeding and historical replay stay quiet.
    const newForwardFills = previous > 0
      ? fills.filter((fill) => Number(fill.time) > previous && Number(fill.time) <= end) : [];
    if (newForwardFills.some((fill) => Number(fill.time) >= now - 120000) && committed?.committedAlerts?.length) {
      require('./whaleSync').markLiveAlerts(committed.committedAlerts);
    }
    if (newForwardFills.length) {
      try { await require('./whales').refreshWhalePositionFromSource(whale.id); }
      catch (error) { console.warn('[fill-backfill] position refresh:', error.message); }
    }
    if (generation !== resetGeneration) return;
    // Historic windows are lower priority, separately checkpointed, at most one per successful revisit.
    const before = Number(entry.historyBefore);
    if (previous && before > now - DAYS * DAY_MS) {
      const historyWidth = Math.max(1, Number(entry.historyWindowMs) || DAY_MS);
      const historyStart = Math.max(now - DAYS * DAY_MS, before - historyWidth);
      try {
        const historical = await fetchUserFillsByTime(whale.address, historyStart, before);
        if (generation !== resetGeneration) return;
        if (!Array.isArray(historical) || historical.complete === false) throw new Error('Incomplete fill reconciliation');
        commitWhaleState('hf', { trades: historical.map((fill) => mapFillToTrade(fill, whale, {})).filter((trade) => trade?.id) });
        saveAddress(whale.address, { historyBefore: historyStart, historyWindowMs: Math.min(DAY_MS, historyWidth * 2), historyGap: null }, generation);
      } catch (error) { noteFailure(whale.address, error, historyStart, before - historyStart, true, generation); }
    }
  } catch (error) {
    noteFailure(whale.address, error, start, end - start, false, generation);
  } finally { running = false; }
}
function getBackfillStatus() {
  const whales = listWhales();
  const watermarks = loadWatermarks();
  return { enabled: ENABLED, feature: 'continuous-fill-capture', legacyBackfillEnabled: process.env.FILL_BACKFILL === '1', intervalMs: INTERVAL_MS, days: DAYS, lookbackMs: FILL_LOOKBACK_MS,
    running, whaleIndex: cursor, whaleTotal: whales.length, done: false, continuous: true,
    reconciledAddresses: whales.filter((whale) => watermarks[whale.address]?.through).length,
    watermarks, lastError, rateLimitPauseMs: RATE_LIMIT_PAUSE_MS,
    rateLimited: rateLimitedUntil > Date.now(), rateLimitedUntil };
}
function resetFillBackfill() {
  resetGeneration += 1;
  setMeta(META_KEY, '{}');
  cursor = 0;
  rateLimitedUntil = 0;
  startFillBackfill();
  return getBackfillStatus();
}
function startFillBackfill() {
  if (!ENABLED || timer) return;
  timer = setInterval(() => { void runOneTick(); }, INTERVAL_MS);
  timer.unref?.();
  startupTimer = setTimeout(() => { void runOneTick(); }, 15000);
  startupTimer.unref?.();
}
function stopFillBackfill() {
  if (timer) clearInterval(timer);
  if (startupTimer) clearTimeout(startupTimer);
  timer = null;
  startupTimer = null;
}
module.exports = { startFillBackfill, stopFillBackfill, resetFillBackfill, getBackfillStatus, runOneTick };
