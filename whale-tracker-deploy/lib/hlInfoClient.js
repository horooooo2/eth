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
const budget = [];
const WEIGHT_LIMIT = Math.max(120, Math.min(1100, Number(process.env.HL_WEIGHT_PER_MINUTE) || 900));
let lastSuccessAt = 0;
let lastFailureAt = 0;
let lastError = '';
function requestWeight(body) {
  if (['clearinghouseState','allMids','l2Book','orderStatus','spotClearinghouseState','exchangeStatus'].includes(body.type)) return 2;
  if (body.type === 'userRole') return 60;
  // Reserve the documented maximum page surcharge before a request.
  if (['userFills','userFillsByTime'].includes(body.type)) return 120;
  if (body.type === 'candleSnapshot') return 104;
  return 20;
}
let budgetTimer;
function canTakeWeight(body, scheduling = {}) {
  const now = Date.now();
  while (budget.length && budget[0].at <= now - 60000) budget.shift();
  const limit = body.type === 'clearinghouseState' ? WEIGHT_LIMIT : WEIGHT_LIMIT - 120;
  const weight = requestWeight(body);
  if (scheduling.priority === "history" && budget.filter(row => row.history).reduce((sum, row) => sum + row.weight, 0) + weight > Math.max(120, WEIGHT_LIMIT * 0.2)) return false;
  if (budget.reduce((sum, row) => sum + row.weight, 0) + weight > Math.max(120, limit)) return false;
  const reservation = { at: now, weight, history: scheduling.priority === "history" }; budget.push(reservation); return reservation;
}

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
    queue.sort((a, b) => (b.priority + (Date.now() - b.at) / 5000) - (a.priority + (Date.now() - a.at) / 5000));
    const index = queue.findIndex(job => (job.reservation = canTakeWeight(job.body, job.scheduling)));
    if (index < 0) {
      if (!budgetTimer) budgetTimer = setTimeout(() => { budgetTimer = null; runQueue(); }, 1000);
      return;
    }
    const [job] = queue.splice(index, 1);
    clearTimeout(job.timer);
    active += 1;
    job
      .fn()
      .then(data => {
        if (['userFills', 'userFillsByTime'].includes(job.body.type) && Array.isArray(data)) {
          job.reservation.weight = 20 + Math.ceil(data.length / 20);
        }
        job.resolve(data);
      }, job.reject)
      .finally(() => {
        active -= 1;
        runQueue();
      });
  }
}

function enqueue(fn, body = {}, scheduling = {}) {
  return new Promise((resolve, reject) => {
    if (queue.length >= 256) return reject(Object.assign(new Error('上游采集队列已满'), { code: 'HL_QUEUE_FULL' }));
    const job = { fn, resolve, reject, body, scheduling, at: Date.now(), priority: scheduling.priority === 'history' ? -20 : body.type === 'clearinghouseState' ? 10 : body.type === 'userFillsByTime' ? (Number(body.endTime) < Date.now() - 120000 ? -10 : 0) : 5 };
    job.timer = setTimeout(() => {
      const index = queue.indexOf(job);
      if (index >= 0) { queue.splice(index, 1); reject(Object.assign(new Error(scheduling.priority === 'history' ? '历史采集等待剩余预算' : '上游采集排队超时'), { code: scheduling.priority === 'history' ? 'HL_HISTORY_DEFERRED' : 'HL_QUEUE_TIMEOUT' })); }
    }, scheduling.priority === "history" ? 5000 : 45000);
    queue.push(job);
    runQueue();
  });
}

async function postOnce(url, body, scheduling) {
  const coolUntil = cooldownUntilByUrl.get(url) || 0;
  const wait = coolUntil - Date.now();
  if (wait > 0) await sleep(wait);
  return enqueue(async () => {
  try {
    const { data } = await client.post(url, body, { headers: authHeaders(url) });
    lastSuccessAt = Date.now(); lastError = ''; return data;
  } catch (error) { lastFailureAt = Date.now(); lastError = error.code || error.message; throw error; }
  }, body, scheduling);
}

async function postWithRetries(url, body, retries = 2, scheduling = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await postOnce(url, body, scheduling);
    } catch (err) {
      lastError = err;
      if (isAuthError(err) || ['ECONNREFUSED', 'HL_QUEUE_TIMEOUT', 'HL_QUEUE_FULL', 'HL_HISTORY_DEFERRED'].includes(err.code)) throw err;
      if (!isTransient(err) || attempt === retries) break;
      if (isRateLimited(err)) {
        cooldownUntilByUrl.set(url, Date.now() + RATE_LIMIT_COOLDOWN_MS);
      }
      await sleep(800 * (attempt + 1));
    }
  }
  throw wrapRateLimit(lastError);
}

async function hlPost(body, retries = 2, scheduling = {}) {
  return (async () => {
    const endpoints = listEndpoints();
    let lastError;
    for (let i = 0; i < endpoints.length; i += 1) {
      const url = endpoints[i];
      try {
        return await postWithRetries(url, body, retries, scheduling);
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
  })();
}

/** Bypass configured mirrors and query Hyperliquid's official Info API directly. */
async function hlPostOfficial(body, retries = 2) {
  return postWithRetries(OFFICIAL_INFO_URL, body, retries);
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
    queued: queue.length, active, weightLimit: WEIGHT_LIMIT, lastSuccessAt, lastFailureAt, lastError,
    timeoutMs: REQUEST_TIMEOUT_MS,
  };
}

console.info(
  `[hl-info] 使用${usingGoldRush ? 'GoldRush' : '官方 Hyperliquid'}: ${primaryUrl}` +
    `（并发 ${MAX_CONCURRENT}，GoldRush 开关 ${useGoldRush ? '开' : '关'}，回退 ${fallbackEnabled ? '开' : '关'}）`,
);

module.exports = {
  hlPost,
  hlPostOfficial,
  getHlInfoConfig,
  OFFICIAL_INFO_URL,
  GOLDRUSH_INFO_URL,
  MAX_CONCURRENT,
  isRateLimited,
};
