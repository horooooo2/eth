/**
 * 诊币分层 TTL 模块缓存（复用文件 cache）
 */
const { readCache, writeCache } = require('./cache');

const MODULE_TTL_MS = {
  price: 10 * 1000,
  derivatives: 60 * 1000,
  whales: 2 * 60 * 1000,
  technical: 3 * 60 * 1000,
  news: 15 * 60 * 1000,
  macro: 30 * 60 * 1000,
  tvl: 30 * 60 * 1000,
};

function cacheName(coin, module) {
  return `brief-mod-${String(coin || '').toUpperCase()}-${module}`;
}

/**
 * @returns {{ data: any, fetchedAt: number, status: string, ageMs: number } | null}
 */
function readModule(coin, module, ttlMs = MODULE_TTL_MS[module]) {
  const hit = readCache(cacheName(coin, module));
  if (!hit?.data) return null;
  const fetchedAt = Number(hit.data.fetchedAt || hit.updatedAt) || 0;
  const ageMs = Date.now() - fetchedAt;
  const ttl = Number(ttlMs) || MODULE_TTL_MS[module] || 60_000;
  if (!fetchedAt || ageMs > ttl) return null;
  return {
    data: hit.data.data != null ? hit.data.data : hit.data,
    fetchedAt,
    status: hit.data.status || 'ok',
    ageMs,
    cached: true,
  };
}

function writeModule(coin, module, data, status = 'ok') {
  const fetchedAt = Date.now();
  const payload = {
    fetchedAt,
    status: status || 'ok',
    data,
  };
  writeCache(cacheName(coin, module), payload);
  return { data, fetchedAt, status: payload.status, ageMs: 0, cached: false };
}

function wrapModule(result, status = 'ok') {
  return {
    ...(result && typeof result === 'object' ? result : { value: result }),
    fetchedAt: Date.now(),
    status,
  };
}

module.exports = {
  MODULE_TTL_MS,
  readModule,
  writeModule,
  wrapModule,
};
