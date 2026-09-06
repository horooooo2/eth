/**
 * Hyperliquid /info 统一客户端。
 *
 * 默认只用官方 https://api.hyperliquid.xyz/info。
 * 可选：HL_USE_GOLDRUSH=1 且配置 GOLDRUSH_API_KEY 时才启用 GoldRush。
 *
 * 环境变量：
 * - HL_USE_GOLDRUSH=1：启用 GoldRush（需 Key）
 * - GOLDRUSH_API_KEY / HL_INFO_API_KEY
 * - HL_INFO_URL：强制指定 endpoint
 * - HL_INFO_FALLBACK=0：关闭回退
 * - HL_MAX_CONCURRENT：默认 2
 * - HL_INFO_TIMEOUT_MS：默认 30000
 */
const axios = require('axios');

const OFFICIAL_INFO_URL = 'https://api.hyperliquid.xyz/info';
const GOLDRUSH_INFO_URL = 'https://hypercore.goldrushdata.com/info';

const REQUEST_TIMEOUT_MS = Math.max(8000, Number(process.env.HL_INFO_TIMEOUT_MS) || 30000);
const RATE_LIMIT_COOLDOWN_MS = 4000;

const apiKey = String(process.env.GOLDRUSH_API_KEY || process.env.HL_INFO_API_KEY || '').trim();
const useGoldRush = process.env.HL_USE_GOLDRUSH === '1' && Boolean(apiKey);
const configuredUrl = String(process.env.HL_INFO_URL || '').trim();
const fallbackEnabled = process.env.HL_INFO_FALLBACK !== '0';

const primaryUrl =
  configuredUrl || (useGoldRush ? GOLDRUSH_INFO_URL : OFFICIAL_INFO_URL);
const usingGoldRush = /goldrushdata\.com/i.test(primaryUrl);

const MAX_CONCURRENT = Math.max(
  1,
  Math.min(12, Number(process.env.HL_MAX_CONCURRENT) || 2),
);

const client = axios.create({
  timeout: REQUEST_TIMEOUT_MS,
  headers: { 'Content-Type': 'application/json' },
});

const queue = [];
let active = 0;
const cooldownUntilByUrl = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimited(err) {
  return err.response?.status === 429 || /过于频繁|rate.?limit/i.test(String(err.message || ''));
}

function isAuthError(err) {
  const status = err.response?.status;
  return status === 401 || status === 403;
}

function isTransient(err) {
  const status = err.response?.status;
  return !status || status >= 500 || status === 429 || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT';
}

function wrapRateLimit(err) {
  if (!isRateLimited(err)) return err instanceof Error ? err : new Error(String(err || '请求失败'));
  const next = new Error('Hyperliquid 请求过于频繁，请稍后再试');
  next.status = 429;
  next.cause = err;
  return next;
}

function authHeaders(url) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey && /goldrushdata\.com/i.test(url)) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function shortUrl(url) {
  if (/goldrushdata\.com/i.test(url)) return 'GoldRush';
  if (/hyperliquid\.xyz/i.test(url)) return '官方';
  return url;
}

/** 默认仅官方；显式启用 GoldRush 时：首选 → 官方回退 */
function listEndpoints() {
  const urls = [];
  const add = (url) => {
    const value = String(url || '').trim();
    if (value && !urls.includes(value)) urls.push(value);
  };
  add(primaryUrl);
  if (!fallbackEnabled) return urls;
  add(OFFICIAL_INFO_URL);
  if (useGoldRush) add(GOLDRUSH_INFO_URL);
  return urls;
}

function runQueue() {
  while (active < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    active += 1;
    job
      .fn()
      .then(job.resolve, job.reject)
      .finally(() => {
        active -= 1;
        runQueue();
      });
  }
}

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    runQueue();
  });
}

async function postOnce(url, body) {
  const coolUntil = cooldownUntilByUrl.get(url) || 0;
  const wait = coolUntil - Date.now();
  if (wait > 0) await sleep(wait);
  const { data } = await client.post(url, body, { headers: authHeaders(url) });
  return data;
}

async function postWithRetries(url, body, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await postOnce(url, body);
    } catch (err) {
      lastError = err;
      if (isAuthError(err)) throw err;
      if (!isTransient(err) || attempt === retries) break;
      if (isRateLimited(err)) {
        cooldownUntilByUrl.set(url, Date.now() + RATE_LIMIT_COOLDOWN_MS);
      }
      await sleep(800 * (attempt + 1));
    }
  }
  throw wrapRateLimit(lastError);
}

async function hlPost(body, retries = 2) {
  return enqueue(async () => {
    const endpoints = listEndpoints();
    let lastError;
    for (let i = 0; i < endpoints.length; i += 1) {
      const url = endpoints[i];
      try {
        return await postWithRetries(url, body, retries);
      } catch (err) {
        lastError = err;
        const hasNext = i < endpoints.length - 1;
        const canSwitch = hasNext && (isAuthError(err) || isTransient(err) || isRateLimited(err));
        if (!canSwitch) throw wrapRateLimit(err);
        console.warn(
          `[hl-info] ${shortUrl(url)} 失败，切换 ${shortUrl(endpoints[i + 1])}：`,
          err.response?.status || err.message || err,
        );
      }
    }
    throw wrapRateLimit(lastError);
  });
}

function getHlInfoConfig() {
  return {
    primaryUrl,
    officialUrl: OFFICIAL_INFO_URL,
    goldRushUrl: GOLDRUSH_INFO_URL,
    usingGoldRush,
    hasApiKey: Boolean(apiKey),
    useGoldRushOptIn: useGoldRush,
    fallbackEnabled,
    endpoints: listEndpoints(),
    maxConcurrent: MAX_CONCURRENT,
    timeoutMs: REQUEST_TIMEOUT_MS,
  };
}

console.info(
  `[hl-info] 使用${usingGoldRush ? 'GoldRush' : '官方 Hyperliquid'}: ${primaryUrl}` +
    `（并发 ${MAX_CONCURRENT}，GoldRush 开关 ${useGoldRush ? '开' : '关'}，回退 ${fallbackEnabled ? '开' : '关'}）`,
);

module.exports = {
  hlPost,
  getHlInfoConfig,
  OFFICIAL_INFO_URL,
  GOLDRUSH_INFO_URL,
  MAX_CONCURRENT,
  isRateLimited,
};
