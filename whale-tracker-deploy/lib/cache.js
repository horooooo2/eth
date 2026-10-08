const fs = require('fs');
const os = require('os');
const path = require('path');

/** 缓存有效期：3 分钟。过期仍可读，只是标记 stale 并后台分片刷新 */
const TTL_MS = 3 * 60 * 1000;

let cacheDir;

function resolveCacheDir() {
  if (process.env.CACHE_DIR) return process.env.CACHE_DIR;
  const local = path.join(__dirname, '..', 'cache');
  try {
    if (!fs.existsSync(local)) fs.mkdirSync(local, { recursive: true });
    fs.accessSync(local, fs.constants.W_OK);
    return local;
  } catch {
    const tmp = path.join(os.tmpdir(), 'whale-tracker-cache');
    fs.mkdirSync(tmp, { recursive: true });
    return tmp;
  }
}

function getCacheDir() {
  if (!cacheDir) cacheDir = resolveCacheDir();
  return cacheDir;
}

function ensureDir() {
  const dir = getCacheDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function cachePath(name) {
  return path.join(getCacheDir(), `${name}.json`);
}

/**
 * 读取磁盘缓存。
 * @returns {{ data: any, updatedAt: number, stale: boolean } | null}
 */
function readCache(name) {
  try {
    const file = cachePath(name);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const updatedAt = Number(parsed.updatedAt) || 0;
    return {
      data: parsed.data,
      updatedAt,
      stale: Date.now() - updatedAt > TTL_MS,
    };
  } catch (err) {
    console.warn(`[cache] 读取 ${name} 失败:`, err.message);
    return null;
  }
}

function writeCache(name, data, options = {}) {
  const payload = {
    updatedAt: Date.now(),
    data,
  };
  try {
    ensureDir();
    if (options.strict) {
      const target = cachePath(name);
      const temporary = `${target}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify(payload), 'utf8');
        fs.renameSync(temporary, target);
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
    } else {
      fs.writeFileSync(cachePath(name), JSON.stringify(payload), 'utf8');
    }
  } catch (err) {
    console.warn(`[cache] 写入 ${name} 失败:`, err.message);
    if (options.strict) throw err;
  }
  return payload;
}

function clearCache(name) {
  try {
    const file = cachePath(name);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (err) {
    console.warn(`[cache] 清除 ${name} 失败:`, err.message);
  }
}

/** 高频 / 稳健各自独立缓存，切换类型时可秒开 */
function whaleCacheName(mode) {
  return mode === 'stable' ? 'whales-stable' : 'whales-hf';
}

// SQLite is authoritative. JSON is only a best-effort compatibility mirror.
const { randomUUID } = require('crypto');
const { isRawTrade, canonicalTradeId } = require('./positionEventPolicy');
const RAW_CACHE_MAX = 8000;
const RAW_CACHE_RETENTION_MS = 86400000;
function rawTradeView(trades) {
  const cutoff = Date.now() - RAW_CACHE_RETENTION_MS;
  const byId = new Map();
  for (const trade of trades || []) {
    if (!isRawTrade(trade) || Number(trade.time) < cutoff) continue;
    const id = canonicalTradeId(trade);
    if (id) byId.set(id, { ...trade, id });
  }
  return [...byId.values()].sort((a, b) => Number(b.time) - Number(a.time)).slice(0, RAW_CACHE_MAX);
}
const stateEpoch = randomUUID();
const states = new Map();
let observationClock = 0;
let summaryClock = 0;
const commitListeners = new Set();
const mirrorTimers = new Map();
const mirrorWriter = require('./asyncMirror').createMirrorWriter(cachePath);
function scheduleMirror(mode, data) {
  // SQLite is authoritative; full JSON mirrors are disabled in stock-focused mode.
  if (process.env.WHALE_JSON_MIRROR !== '1') return;
  const pending = mirrorTimers.get(mode);
  if (pending) { pending.data = data; return; }
  const entry = { data };
  entry.timer = setTimeout(() => {
    mirrorTimers.delete(mode);
    void mirrorWriter.write(whaleCacheName(mode), entry.data);
  }, 2000);
  entry.timer.unref?.();
  mirrorTimers.set(mode, entry);
}
const copy = (value) => value == null ? value : structuredClone(value);
const POSITION_METADATA = ['coinLabel', 'openTime', 'firstOpenTime', 'lastAddTime',
  'openHistoryComplete', 'entryFills', 'entryFillsOmitted'];

function stateFor(mode = 'hf') {
  const key = mode === 'stable' ? 'stable' : 'hf';
  if (!states.has(key)) {
    const store = require('./sqliteStore');
    const stored = store.loadModePayload();
    // Never promote a possibly newer JSON snapshot over durable state.
    const data = stored?.data || { mode: key, whales: [], trades: [], warnings: [] };
    states.set(key, { data: { ...copy(data), mode: key, trades: rawTradeView(data.trades) }, updatedAt: stored?.updatedAt || 0,
      revision: 0, summaryVersion: ++summaryClock, epoch: stateEpoch, whaleRevisions: new Map() });
  }
  return states.get(key);
}

function readStateSnapshot(mode = 'hf', { includeTrades = true } = {}) {
  const state = stateFor(mode);
  return { data: copy(includeTrades ? retainedSnapshotData(state.data) : { ...state.data, trades: [] }), updatedAt: state.updatedAt, revision: state.revision,
    epoch: state.epoch, stale: Date.now() - state.updatedAt > TTL_MS };
}

function retainedSnapshotData(data) {
  const cutoff = Date.now() - RAW_CACHE_RETENTION_MS;
  return { ...data, trades: data.trades.filter(trade => Number(trade.time) >= cutoff) };
}

function commitSnapshot(state) {
  const data = state.data;
  let snapshot;
  return { updatedAt: state.updatedAt, revision: state.revision, epoch: state.epoch,
    stale: Date.now() - state.updatedAt > TTL_MS,
    get data() { return snapshot ||= copy(retainedSnapshotData(data)); } };
}

function readWhaleModeCache(mode) {
  const snapshot = readStateSnapshot(mode);
  return snapshot.updatedAt || snapshot.data.whales.length ? snapshot : null;
}

function captureWhaleRevisions(mode = 'hf', ids) {
  const state = stateFor(mode);
  const selected = ids || state.data.whales.map((whale) => whale.id);
  return Object.fromEntries(selected.map((id) => [id, state.whaleRevisions.get(String(id)) || 0]));
}

function commitWhaleState(mode = 'hf', patch = {}) {
  const state = stateFor(mode);
  const byId = new Map((state.data.whales || []).map((whale) => [String(whale.id), whale]));
  const roster = Array.isArray(patch.rosterIds) ? new Set(patch.rosterIds.map(String)) : null;
  const removedWhaleIds = roster ? [...byId.keys()].filter((id) => !roster.has(id)) : [];
  for (const id of removedWhaleIds) byId.delete(id);
  const changedWhales = [];
  const observedWhaleIds = [];
  const rejectedWhaleIds = [];
  for (const incoming of patch.whales || []) {
    if (!incoming?.id) continue;
    const id = String(incoming.id);
    if (roster && !roster.has(id)) continue;
    const previous = byId.get(id);
    if (patch.expectedWhaleRevisions &&
        (patch.expectedWhaleRevisions[id] ?? 0) !== (state.whaleRevisions.get(id) || 0)) {
      rejectedWhaleIds.push(id);
      continue;
    }
    if (incoming.__snapshotFresh === false && previous) { rejectedWhaleIds.push(id); continue; }
    let next;
    if (patch.positionMetadataOnly) {
      if (!previous) continue;
      next = { ...previous, positions: (previous.positions || []).map((position) => {
        const enriched = (incoming.positions || []).find((item) =>
          item.coin === position.coin && item.side === position.side &&
          Number(item.size) === Number(position.size));
        if (!enriched) return position;
        const fields = Object.fromEntries(POSITION_METADATA.filter((key) => enriched[key] !== undefined)
          .map((key) => [key, enriched[key]]));
        return { ...position, ...fields };
      }) };
    } else {
      next = { ...previous, ...incoming };
    }
    delete next.trades;
    delete next.__snapshotFresh;
    if (!patch.positionMetadataOnly) observedWhaleIds.push(id);
    if (JSON.stringify(previous) === JSON.stringify(next)) continue;
    byId.set(id, copy(next));
    changedWhales.push(next);
  }
  const incomingTrades = (patch.trades || []).filter((trade) => trade?.id && isRawTrade(trade))
    .map((trade) => ({ ...trade, id: canonicalTradeId(trade) }));
  const tradeMap = incomingTrades.length ? new Map((state.data.trades || []).map((trade) => [String(trade.id), trade])) : null;
  const changedTrades = [];
  for (const trade of incomingTrades) {
    if (JSON.stringify(tradeMap.get(String(trade.id))) !== JSON.stringify(trade)) changedTrades.push(trade);
    tradeMap.set(String(trade.id), copy(trade));
  }
  const metadata = patch.metadata || {};
  const metadataChanged = Object.entries(metadata).some(([key, value]) =>
    JSON.stringify(state.data[key]) !== JSON.stringify(value));
  if (!changedWhales.length && !changedTrades.length && !metadataChanged && !removedWhaleIds.length && !(patch.snapshotAlerts || []).length) {
    for (const id of observedWhaleIds) state.whaleRevisions.set(id, ++observationClock);
    return Object.assign(commitSnapshot(state), { changedWhaleIds: [], changedWhales: [], removedWhaleIds: [], rejectedWhaleIds,
      committedAlerts: [], removedAlertIds: [] });
  }
  const updatedAt = Date.now();
  const revision = state.revision + 1;
  const data = { ...state.data, ...copy(metadata), mode,
    whales: [...byId.values()], trades: changedTrades.length ? rawTradeView([...tradeMap.values()]) : state.data.trades };
  const store = require('./sqliteStore');
  const result = store.persistStatePatch({ whales: changedWhales, trades: changedTrades,
    metadata, revision, epoch: state.epoch, removedWhaleIds, snapshotAlerts: (patch.snapshotAlerts || []).filter((alert) =>
      !rejectedWhaleIds.includes(String(alert.whaleId)) && !removedWhaleIds.includes(String(alert.whaleId))) }, updatedAt);
  // Nothing observable advances before the transaction succeeds.
  state.data = data;
  if (changedWhales.length || removedWhaleIds.length) state.summaryVersion = ++summaryClock;
  state.updatedAt = updatedAt;
  state.revision = revision;
  for (const id of new Set([...observedWhaleIds, ...changedWhales.map((whale) => String(whale.id)), ...removedWhaleIds])) {
    state.whaleRevisions.set(id, ++observationClock);
  }
  scheduleMirror(mode, data);
  const committed = Object.assign(commitSnapshot(state), { changedWhaleIds: changedWhales.map((whale) => whale.id),
    changedWhales: copy(changedWhales), removedWhaleIds, rejectedWhaleIds, committedAlerts: result?.committedAlerts || [],
    removedAlertIds: result?.removedAlertIds || [] });
  for (const listener of commitListeners) {
    try { const delta = Object.fromEntries(Object.keys(committed).filter(key => key !== 'data').map(key => [key, committed[key]])); listener({ ...copy(delta), data: { mode } }); } catch (error) { console.warn('[state] subscriber:', error.message); }
  }
  return committed;
}

function subscribeStateCommits(listener) {
  commitListeners.add(listener);
  return () => commitListeners.delete(listener);
}

function writeWhaleModeCache(mode, data, options = {}) {
  const { whales = [], trades = [], ...metadata } = data;
  return commitWhaleState(mode, { whales, trades, metadata, ...options });
}

function clearWhaleModeCache(mode) {
  const modes = mode ? [mode === 'stable' ? 'stable' : 'hf'] : ['hf', 'stable'];
  for (const key of modes) {
    const previous = states.get(key);
    const mirror = mirrorTimers.get(key);
    if (mirror) clearTimeout(mirror.timer);
    mirrorTimers.delete(key);
    void mirrorWriter.clear(whaleCacheName(key));
    clearCache(whaleCacheName(key));
    states.delete(key);
    // Reload durable state after reset/config mutation and invalidate in-flight baselines.
    const state = stateFor(key);
    state.revision = (previous?.revision || 0) + 1;
    const allIds = new Set([...(previous?.data?.whales || []), ...state.data.whales].map((whale) => String(whale.id)));
    for (const id of previous?.whaleRevisions.keys() || []) allIds.add(id);
    for (const id of allIds) state.whaleRevisions.set(id, ++observationClock);
    const currentIds = new Set(state.data.whales.map((whale) => String(whale.id)));
    const change = { ...readStateSnapshot(key), changedWhales: copy(state.data.whales),
      changedWhaleIds: [...currentIds], removedWhaleIds: [...allIds].filter((id) => !currentIds.has(id)),
      committedAlerts: [], removedAlertIds: [] };
    for (const listener of commitListeners) {
      try { listener(copy(change)); } catch (error) { console.warn('[state] subscriber:', error.message); }
    }
  }
  if (!mode) clearCache('whales');
}

module.exports = {
  readSummaryVersion: () => { const s = stateFor('hf'); return { version: s.summaryVersion, updatedAt: s.updatedAt }; },
  readPositionObservationTimes: (mode = 'hf') => new Map(stateFor(mode).data.whales.map(row => [row.id, Number(row.positionObservedAt) || 0])),
  readStateSnapshot,
  captureWhaleRevisions,
  commitWhaleState,
  subscribeStateCommits,
  TTL_MS,
  readCache,
  writeCache,
  clearCache,
  whaleCacheName,
  readWhaleModeCache,
  writeWhaleModeCache,
  clearWhaleModeCache,
};
