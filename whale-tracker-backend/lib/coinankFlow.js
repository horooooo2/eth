/**
 * CoinAnk 资金流数据源
 *
 * - POST https://api.coinank.com/api/fund/fundReal
 * - 同时拉 SPOT（现货）和 SWAP（合约）
 * - apikey 是动态生成的（从 JS bundle 逆向），不需要写死
 * - 30~60s 刷新一次，服务器内存缓存
 * - 失败不抛错，保留上次成功缓存并标记 stale
 */
const axios = require('axios');

const API_URL = 'https://api.coinank.com/api/fund/fundReal';
const REFRESH_MS = Math.max(20000, Number(process.env.COINANK_REFRESH_MS) || 45000);
const STALE_AFTER_MS = 120 * 1000; // 2 分钟算 stale
const PERIOD_FIELD = {
  '5m': 'm5net',
  '15m': 'm15net',
  '1h': 'h1net',
  '2h': 'h2net',
  '4h': 'h4net',
  '6h': 'h6net',
};
const COINS = ['BTC', 'ETH', 'SOL'];

// ---------- 动态 apikey 生成（从 CoinAnk JS bundle 逆向） ----------
// const UUID = "b2d903dd-b31e-c547-d299-b6d07b7631ab";
// W$(e) = e.substring(0, 8) = "b2d903dd"
// H$(e, t) = e.replace(t, "").concat(t)  // 前8字符移到末尾
// V$() = String(Date.now() + 2222222222222)
// K$(e) = e + "347"
// Uo() = btoa(H$(UUID, W$(UUID)) + "|" + K$(V$()))
const UUID_PART = 'b2d903dd-b31e-c547-d299-b6d07b7631ab';
const PREFIX = UUID_PART.substring(0, 8); // "b2d903dd"
const REARRANGED = UUID_PART.replace(PREFIX, '') + PREFIX; // "-b31e-c547-d299-b6d07b7631abb2d903dd"

function makeApikey() {
  const ts = String(Number(Date.now()) + 2222222222222);
  const payload = REARRANGED + '|' + ts + '347';
  return Buffer.from(payload, 'utf8').toString('base64');
}

// ---------- 状态 ----------
let started = false;
let timer = null;
let spotCache = {};
let swapCache = {};
let lastFetchAt = 0;
let lastSuccessAt = 0;
let lastError = '';
let totalFetches = 0;
let totalFailures = 0;

// ---------- 拉取 ----------
async function fetchOne(productType) {
  // 每个币种单独请求，确保 BTC/ETH/SOL 都能拿到（按 m5net 排序前 100 可能不含大币）
  const out = {};
  await Promise.all(COINS.map(async (coin) => {
    const params = new URLSearchParams({
      page: '1', size: '10', type: '1',
      productType, sortBy: 'm5net', sortType: 'ascend',
      baseCoin: coin, isFollow: 'false',
    });
    const { data } = await axios.post(`${API_URL}?${params.toString()}`, null, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'client': 'web',
        'coinank-apikey': makeApikey(),
        'token': '',
        'web-version': '102',
      },
      timeout: 15000,
    });
    if (!data || data.success !== true) throw new Error(data?.msg || 'coinank api error');
    const item = (data.data?.list || []).find((x) => x.baseCoin === coin);
    if (item) {
      out[coin] = {
        m5net: Number(item.m5net) || 0,
        m15net: Number(item.m15net) || 0,
        h1net: Number(item.h1net) || 0,
        h2net: Number(item.h2net) || 0,
        h4net: Number(item.h4net) || 0,
        h6net: Number(item.h6net) || 0,
      };
    }
  }));
  return out;
}

async function pollOnce() {
  lastFetchAt = Date.now();
  try {
    const [spot, swap] = await Promise.all([fetchOne('SPOT'), fetchOne('SWAP')]);
    spotCache = spot;
    swapCache = swap;
    lastSuccessAt = Date.now();
    lastError = '';
    totalFetches += 1;
  } catch (e) {
    lastError = e.message || String(e);
    totalFailures += 1;
    console.warn('[coinank] poll failed:', lastError);
  }
}

// ---------- 对外 ----------
function getNet(period, marketType = 'spot') {
  const field = PERIOD_FIELD[period];
  if (!field) return null;
  if (Date.now() - lastSuccessAt > STALE_AFTER_MS) return null;
  const cache = marketType === 'swap' ? swapCache : spotCache;
  const out = {};
  for (const c of COINS) {
    const v = cache[c];
    if (v) out[c] = v[field];
  }
  return out;
}

function getStatus() {
  return {
    started,
    apiUrl: API_URL,
    refreshMs: REFRESH_MS,
    lastFetchAt,
    lastSuccessAt,
    lastError,
    totalFetches,
    totalFailures,
    spotCached: Object.keys(spotCache),
    swapCached: Object.keys(swapCache),
    stale: Date.now() - lastSuccessAt > STALE_AFTER_MS,
  };
}

function start() {
  if (started) return getStatus();
  started = true;
  console.log(`[coinank] 启动 SPOT+SWAP 轮询 every ${REFRESH_MS}ms (动态 apikey)`);
  void pollOnce();
  timer = setInterval(pollOnce, REFRESH_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return getStatus();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

module.exports = { start, stop, getNet, getStatus, PERIOD_FIELD };
