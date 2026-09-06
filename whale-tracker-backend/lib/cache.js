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

function writeCache(name, data) {
  const payload = {
    updatedAt: Date.now(),
    data,
  };
  try {
    ensureDir();
    fs.writeFileSync(cachePath(name), JSON.stringify(payload), 'utf8');
  } catch (err) {
    console.warn(`[cache] 写入 ${name} 失败:`, err.message);
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

function readWhaleModeCache(mode) {
  const key = mode === 'stable' ? 'stable' : 'hf';
  const named = readCache(whaleCacheName(mode));
  if (named) return named;
  const legacy = readCache('whales');
  if (!legacy?.data?.whales?.length) return null;
  const legacyMode = legacy.data.mode === 'stable' ? 'stable' : 'hf';
  return legacyMode === key ? legacy : null;
}

function writeWhaleModeCache(mode, data) {
  const saved = writeCache(whaleCacheName(mode), data);
  try {
    const { persistModePayload } = require('./sqliteStore');
    const result = persistModePayload(data, saved.updatedAt);
    console.log(
      `[sqlite] 已写入 whales=${result.whales} fills=${result.trades}` +
        ` purgedFills=${result.purged.fillsDeleted} purgedEvents=${result.purged.eventsDeleted}`,
    );
  } catch (err) {
    console.warn('[sqlite] 写入失败（不影响 JSON 缓存）:', err.message);
  }
  return saved;
}

function clearWhaleModeCache(mode) {
  if (mode) {
    clearCache(whaleCacheName(mode));
    return;
  }
  clearCache('whales');
  clearCache('whales-hf');
  clearCache('whales-stable');
}

module.exports = {
  TTL_MS,
  readCache,
  writeCache,
  clearCache,
  whaleCacheName,
  readWhaleModeCache,
  writeWhaleModeCache,
  clearWhaleModeCache,
};
