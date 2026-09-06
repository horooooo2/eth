const axios = require('axios');
const { normalizeAddress } = require('./config');
const { readCache, writeCache } = require('./cache');
const {
  resolvePartyMeta,
  formatExchangeTag,
  resolveFlowDirection,
} = require('./exchangeLabels');

const REQUEST_TIMEOUT_MS = 12000;
const MIN_USD = 1000;
/** 上游传高 min_usd 会退化成历史大额归档；始终用低阈值拉近实时数据，金额在本地筛 */
const UPSTREAM_MIN_USD = 100_000;
const ALERT_CACHE_TTL_MS = 30 * 1000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** 24h 样本过少时，展示放宽到 72h，避免 EdgeOne 冷启动几乎空白 */
const SOFT_AGE_MS = 72 * 60 * 60 * 1000;
const WINDOW_LIMIT = 200;
const ONCHAIN_WINDOW_CACHE = 'onchain-alert-window';
const SOFT_FILL_MIN = 8;

const BROWSER_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Referer: 'https://cryptocurrency.cv/',
  Origin: 'https://cryptocurrency.cv',
};

const client = axios.create({
  timeout: REQUEST_TIMEOUT_MS,
  headers: BROWSER_HEADERS,
});

/** 资金动向主数据源：cryptocurrency.cv Whale Alerts */
const WHALE_ALERT_URL = 'https://cryptocurrency.cv/api/whale-alerts';

/** 近 24h 滚动窗口（跨请求累积；EdgeOne 无状态时落盘 /tmp，避免每次冷启动只剩 1 条） */
const alertWindow = new Map();
let alertCache = { at: 0, key: '', value: null, inflight: null };
let windowHydrated = false;

function hydrateAlertWindow() {
  if (windowHydrated) return;
  windowHydrated = true;
  try {
    const cached = readCache(ONCHAIN_WINDOW_CACHE);
    const list = Array.isArray(cached?.data?.alerts) ? cached.data.alerts : [];
    const now = Date.now();
    for (const item of list) {
      if (!item?.id || !item.time) continue;
      if (now - item.time > SOFT_AGE_MS) continue;
      alertWindow.set(item.id, item);
    }
  } catch (err) {
    console.warn('[onchain] 恢复资金动向窗口失败:', err.message);
  }
}

function persistAlertWindow() {
  try {
    writeCache(ONCHAIN_WINDOW_CACHE, {
      alerts: [...alertWindow.values()],
      savedAt: Date.now(),
    });
  } catch (err) {
    console.warn('[onchain] 持久化资金动向窗口失败:', err.message);
  }
}

function isWithinAge(time, maxAgeMs, now = Date.now()) {
  if (!time) return false;
  if (time > now + 5 * 60 * 1000) return false;
  return now - time <= maxAgeMs;
}

function pickNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function pickString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function pickAddress(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value === 'object') {
      const addr = pickString(value.address, value.addr, value.wallet);
      if (addr) return addr;
    }
  }
  return '';
}

function pickPartyObject(...values) {
  for (const value of values) {
    if (value && typeof value === 'object') return value;
  }
  return null;
}

function toTimestamp(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function unwrapAlerts(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  return (
    payload.alerts ||
    payload.data ||
    payload.transactions ||
    payload.whaleAlerts ||
    payload.items ||
    []
  );
}

function isWithin24h(time, now = Date.now()) {
  return isWithinAge(time, MAX_AGE_MS, now);
}

function normalizeAlert(raw, index) {
  const fromParty = pickPartyObject(raw.from, raw.sender);
  const toParty = pickPartyObject(raw.to, raw.receiver);
  const from = pickAddress(raw.from, raw.fromAddress, raw.sender, raw.from_address);
  const to = pickAddress(raw.to, raw.toAddress, raw.receiver, raw.to_address);
  const fromMeta = resolvePartyMeta(fromParty, from);
  const toMeta = resolvePartyMeta(toParty, to);
  const fromTag = formatExchangeTag(fromMeta.label);
  const toTag = formatExchangeTag(toMeta.label);
  const flowDirection = resolveFlowDirection(fromMeta, toMeta);
  const amountUsd = pickNumber(
    raw.amount_usd,
    raw.amountUsd,
    raw.value,
    raw.usd,
    raw.usd_value,
  );
  const time = toTimestamp(raw.timestamp || raw.time || raw.date || raw.created_at);
  const asset = pickString(raw.symbol, raw.coin, raw.asset, raw.token);
  const blockchain = pickString(raw.blockchain, raw.chain, raw.network) || 'Unknown';
  const amount = pickNumber(raw.amount, raw.quantity, raw.token_amount);
  const exchangeName =
    flowDirection === 'inflow'
      ? toMeta.label
      : flowDirection === 'outflow'
        ? fromMeta.label
        : flowDirection === 'exchange'
          ? toMeta.label || fromMeta.label
          : '';

  return {
    id: pickString(raw.id, raw.hash, raw.txid, raw.tx_hash) || `onchain-${time}-${index}`,
    time,
    from,
    to,
    fromLabel: fromTag,
    toLabel: toTag,
    fromOwnerType: fromMeta.ownerType || '',
    toOwnerType: toMeta.ownerType || '',
    flowDirection,
    exchangeName: exchangeName || '',
    amountUsd,
    amount,
    asset,
    blockchain,
    whaleId: null,
    whaleName: '全网巨鲸',
    side: '',
    closedPnl: 0,
    hash: pickString(raw.hash, raw.txid, raw.tx_hash),
    source: 'onchain',
    price: amount ? amountUsd / amount : 0,
  };
}

function pruneWindow(now = Date.now()) {
  for (const [id, item] of alertWindow.entries()) {
    // 磁盘窗口保留 72h，列表默认仍按 24h 筛
    if (!isWithinAge(item.time, SOFT_AGE_MS, now)) alertWindow.delete(id);
  }
}

function mergeIntoWindow(alerts, now = Date.now()) {
  hydrateAlertWindow();
  for (const item of alerts) {
    if (!isWithinAge(item.time, SOFT_AGE_MS, now)) continue;
    if (!item.id) continue;
    const prev = alertWindow.get(item.id);
    if (!prev || item.time >= prev.time) alertWindow.set(item.id, item);
  }
  pruneWindow(now);
  if (alertWindow.size > WINDOW_LIMIT) {
    const sorted = [...alertWindow.values()].sort((a, b) => b.time - a.time);
    alertWindow.clear();
    for (const item of sorted.slice(0, WINDOW_LIMIT)) {
      alertWindow.set(item.id, item);
    }
  }
  persistAlertWindow();
}

function listFromWindow(minUsd, limit, now = Date.now(), maxAgeMs = MAX_AGE_MS) {
  hydrateAlertWindow();
  pruneWindow(now);
  return [...alertWindow.values()]
    .filter((item) => item.amountUsd >= minUsd && isWithinAge(item.time, maxAgeMs, now))
    .sort((a, b) => b.time - a.time)
    .slice(0, limit);
}

function listFromWindowWithSoftFill(minUsd, limit, now = Date.now()) {
  const strict = listFromWindow(minUsd, limit, now, MAX_AGE_MS);
  if (strict.length >= Math.min(SOFT_FILL_MIN, limit)) return { alerts: strict, soft: false };
  const soft = listFromWindow(minUsd, limit, now, SOFT_AGE_MS);
  return { alerts: soft, soft: soft.length > strict.length };
}

async function fetchWhaleAlertsLive(minUsd, limit) {
  hydrateAlertWindow();
  try {
    const { data, status } = await client.get(WHALE_ALERT_URL, {
      params: {
        limit: 200,
        // 切勿把页面阈值原样传给上游，否则会只返回陈旧历史大额
        min_usd: UPSTREAM_MIN_USD,
        minUsd: UPSTREAM_MIN_USD,
        min_value: UPSTREAM_MIN_USD,
      },
      validateStatus: (code) => code < 500,
    });
    if (status !== 200) {
      const { alerts: cached, soft } = listFromWindowWithSoftFill(minUsd, limit);
      return {
        alerts: cached,
        source: cached.length ? WHALE_ALERT_URL : null,
        error: cached.length ? null : `${WHALE_ALERT_URL} 返回 ${status}`,
        warning: cached.length
          ? soft
            ? `${WHALE_ALERT_URL} 返回 ${status}，近 24h 较少，已展示近 72h 缓存`
            : `${WHALE_ALERT_URL} 返回 ${status}，已展示近 24h 缓存`
          : null,
      };
    }
    const now = Date.now();
    const normalized = unwrapAlerts(data).map((item, index) => normalizeAlert(item, index));
    mergeIntoWindow(normalized, now);
    const { alerts, soft } = listFromWindowWithSoftFill(minUsd, limit, now);
    return {
      alerts,
      source: WHALE_ALERT_URL,
      error: null,
      warning: soft ? '近 24h 大额异动较少，已补充展示近 72h 资金动向' : null,
    };
  } catch (err) {
    const { alerts: cached, soft } = listFromWindowWithSoftFill(minUsd, limit);
    const message = err.message || 'cryptocurrency.cv whale-alerts 请求失败';
    return {
      alerts: cached,
      source: cached.length ? WHALE_ALERT_URL : null,
      error: cached.length ? null : message,
      warning: cached.length
        ? soft
          ? `${message}，近 24h 较少，已展示近 72h 缓存`
          : `${message}，已展示近 24h 缓存`
        : null,
    };
  }
}

async function fetchWhaleAlerts(minUsd = MIN_USD, limit = 50) {
  hydrateAlertWindow();
  const key = `${minUsd}:${limit}`;
  const now = Date.now();
  if (alertCache.value && alertCache.key === key && now - alertCache.at < ALERT_CACHE_TTL_MS) {
    const { alerts, soft } = listFromWindowWithSoftFill(minUsd, limit, now);
    return {
      ...alertCache.value,
      alerts,
      warning:
        soft && !alertCache.value.warning
          ? '近 24h 大额异动较少，已补充展示近 72h 资金动向'
          : alertCache.value.warning,
    };
  }
  if (alertCache.inflight && alertCache.key === key) return alertCache.inflight;

  alertCache.key = key;
  alertCache.inflight = fetchWhaleAlertsLive(minUsd, limit)
    .then((value) => {
      alertCache = { at: Date.now(), key, value, inflight: null };
      return value;
    })
    .finally(() => {
      if (alertCache.key === key) alertCache.inflight = null;
    });

  return alertCache.inflight;
}

function attachWatchedWhale(trade, whales) {
  const from = normalizeAddress(trade.from);
  const to = normalizeAddress(trade.to);
  const matched = whales.find((whale) => {
    const addr = normalizeAddress(whale.address);
    return addr && (addr === from || addr === to);
  });
  if (!matched) return trade;
  return {
    ...trade,
    whaleId: matched.id,
    whaleName: matched.name,
  };
}

module.exports = {
  MIN_USD,
  MAX_AGE_MS,
  UPSTREAM_MIN_USD,
  fetchWhaleAlerts,
  attachWatchedWhale,
};
