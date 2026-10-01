const axios = require('axios');

const BASE_URL = 'https://fapi.binance.com';
const CATALOG_TTL_MS = 10 * 60 * 1000;
const QUOTE_TTL_MS = 15 * 1000;
const KLINE_CONFIG = {
  '5m': { ttlMs: 45_000, limit: 200 },
  '15m': { ttlMs: 60_000, limit: 200 },
  '1h': { ttlMs: 90_000, limit: 200 },
  '4h': { ttlMs: 180_000, limit: 200 },
  '1d': { ttlMs: 300_000, limit: 200 },
};
const client = axios.create({ baseURL: BASE_URL, timeout: 10000, proxy: false });

let catalogCache = { expiresAt: 0, symbols: [], updatedAt: null };
let catalogPromise = null;
const quoteCache = new Map();
const klineCache = new Map();
const klineInFlight = new Map();

const LABELS = {
  XAU: '黄金', XAG: '白银', XPT: '铂金', XPD: '钯金',
  TSLA: '特斯拉', INTC: '英特尔', SNDK: '闪迪', EWY: '韩国 ETF', EWJ: '日本 ETF',
};

function normalizeCatalog(data) {
  if (!Array.isArray(data?.symbols)) throw new Error('币安合约清单格式异常');
  return data.symbols
    .filter((row) => row.status === 'TRADING' && ['PERPETUAL', 'TRADIFI_PERPETUAL'].includes(row.contractType)
      && Array.isArray(row.underlyingSubType) && row.underlyingSubType.includes('TradFi'))
    .map((row) => ({
      symbol: row.symbol,
      baseAsset: row.baseAsset,
      quoteAsset: row.quoteAsset,
      name: LABELS[row.baseAsset] || row.baseAsset,
      category: row.underlyingType || 'TradFi',
      status: row.status,
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

async function getCatalog() {
  if (catalogCache.expiresAt > Date.now()) return catalogCache;
  if (!catalogPromise) {
    catalogPromise = (async () => {
      const { data } = await client.get('/fapi/v1/exchangeInfo');
      const symbols = normalizeCatalog(data);
      catalogCache = { symbols, updatedAt: new Date().toISOString(), expiresAt: Date.now() + CATALOG_TTL_MS };
      return catalogCache;
    })().finally(() => { catalogPromise = null; });
  }
  try {
    return await catalogPromise;
  } catch (err) {
    if (catalogCache.symbols.length) return { ...catalogCache, stale: true, error: err.message };
    throw err;
  }
}

function parseSymbols(input) {
  if (typeof input !== 'string') return [];
  return [...new Set(input.split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9]{3,30}$/.test(s)))].slice(0, 30);
}

async function fetchQuote(symbol) {
  const cached = quoteCache.get(symbol);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const { data } = await client.get('/fapi/v1/ticker/24hr', { params: { symbol } });
    if (data?.symbol !== symbol || data.lastPrice == null || data.lastPrice === '' || !Number.isFinite(Number(data.lastPrice)) || Number(data.lastPrice) <= 0) {
      throw new Error('行情响应格式异常');
    }
    const value = {
      symbol,
      lastPrice: String(data.lastPrice),
      priceChangePercent: data.priceChangePercent == null || data.priceChangePercent === '' ? null : String(data.priceChangePercent),
      closeTime: Number(data.closeTime) || null,
      source: 'Binance USDⓈ-M Futures',
      stale: false,
    };
    quoteCache.set(symbol, { value, expiresAt: Date.now() + QUOTE_TTL_MS });
    return value;
  } catch (err) {
    if (cached) return { ...cached.value, stale: true };
    return { symbol, lastPrice: null, priceChangePercent: null, closeTime: null, source: 'Binance USDⓈ-M Futures', stale: true, error: err.message };
  }
}

async function getQuotes(input) {
  const requested = parseSymbols(input);
  if (!requested.length) return { quotes: [], invalidSymbols: [], updatedAt: new Date().toISOString() };
  const catalog = await getCatalog();
  const known = new Set(catalog.symbols.map((row) => row.symbol));
  const valid = requested.filter((symbol) => known.has(symbol));
  const invalidSymbols = requested.filter((symbol) => !known.has(symbol));
  const quotes = await Promise.all(valid.map(fetchQuote));
  return { quotes, invalidSymbols, updatedAt: new Date().toISOString(), source: 'Binance USDⓈ-M Futures' };
}

function mapKline(row) {
  if (!Array.isArray(row) || row.length < 7) return null;
  const [openTimeRaw, openRaw, highRaw, lowRaw, closeRaw, volumeRaw, closeTimeRaw] = row;
  if ([openTimeRaw, openRaw, highRaw, lowRaw, closeRaw, volumeRaw, closeTimeRaw].some((value) => value == null || value === '')) return null;
  const openTime = Number(openTimeRaw);
  const open = Number(openRaw);
  const high = Number(highRaw);
  const low = Number(lowRaw);
  const close = Number(closeRaw);
  const volume = Number(volumeRaw);
  const closeTime = Number(closeTimeRaw);
  if (![openTime, open, high, low, close, volume, closeTime].every(Number.isFinite)
    || openTime <= 0 || closeTime < openTime || open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) return null;
  return { openTime, open, high, low, close, volume, closeTime };
}

function intervalMs(interval) {
  const match = /^(\d+)([mhd])$/.exec(interval);
  if (!match) return null;
  const factor = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
  return Number(match[1]) * factor;
}

async function getTradFiKlines(symbolInput, intervalInput, options = {}) {
  const symbol = String(symbolInput || '').trim().toUpperCase();
  const interval = String(intervalInput || '');
  const config = KLINE_CONFIG[interval];
  if (!/^[A-Z0-9]{3,30}$/.test(symbol) || !config) {
    return { symbol, interval, available: false, stale: false, fetchedAt: null, latestBarTime: null, ageMs: null, source: 'binance-futures', bars: [], error: '无效的 TradFi 合约或 K 线周期' };
  }
  const key = `${symbol}:${interval}`;
  const old = klineCache.get(key);
  const now = Date.now();
  if (!options.forceRefresh && old && old.expiresAt > now) {
    return { ...old.value, ageMs: old.value.latestBarTime == null ? null : Math.max(0, now - old.value.latestBarTime) };
  }
  if (klineInFlight.has(key)) return klineInFlight.get(key);
  const request = (async () => {
    try {
      const { data } = await client.get('/fapi/v1/klines', { params: { symbol, interval, limit: config.limit } });
      const bars = Array.isArray(data) ? data.map(mapKline).filter(Boolean).sort((a, b) => a.openTime - b.openTime) : [];
      if (!bars.length) throw new Error('Binance K 线响应为空或格式异常');
      const fetchedAt = Date.now();
      const latestBarTime = bars[bars.length - 1].openTime;
      const barMs = intervalMs(interval);
      const stale = fetchedAt - latestBarTime > barMs * 2;
      const value = { symbol, interval, available: true, stale, fetchedAt, latestBarTime,
        ageMs: Math.max(0, fetchedAt - latestBarTime), source: 'binance-futures', bars };
      klineCache.set(key, { value, expiresAt: fetchedAt + config.ttlMs });
      return value;
    } catch (err) {
      if (old?.value?.available && old.value.bars.length) return { ...old.value, stale: true,
        ageMs: old.value.latestBarTime == null ? null : Math.max(0, Date.now() - old.value.latestBarTime), error: err.message };
      return { symbol, interval, available: false, stale: false, fetchedAt: null, latestBarTime: null,
        ageMs: null, source: 'binance-futures', bars: [], error: err.message || 'K 线请求失败' };
    } finally {
      klineInFlight.delete(key);
    }
  })();
  klineInFlight.set(key, request);
  return request;
}

async function getTradFiMarketContext(symbolInput, options = {}) {
  const symbol = String(symbolInput || '').trim().toUpperCase();
  const intervals = Object.keys(KLINE_CONFIG);
  const [quoteResult, ...klineResults] = await Promise.allSettled([
    getQuotes(symbol),
    ...intervals.map((interval) => getTradFiKlines(symbol, interval, options)),
  ]);
  const quote = quoteResult.status === 'fulfilled'
    ? quoteResult.value.quotes.find((item) => item.symbol === symbol) || null
    : null;
  const klines = Object.fromEntries(intervals.map((interval, index) => [interval,
    klineResults[index].status === 'fulfilled' ? klineResults[index].value : {
      symbol, interval, available: false, stale: false, fetchedAt: null, latestBarTime: null,
      ageMs: null, source: 'binance-futures', bars: [], error: klineResults[index].reason?.message || 'K 线请求失败',
    },
  ]));
  return { symbol, quote, klines, source: 'binance-futures', generatedAt: new Date().toISOString() };
}

module.exports = { getCatalog, getQuotes, getTradFiKlines, getTradFiMarketContext, normalizeCatalog, parseSymbols, KLINE_CONFIG, mapKline };
