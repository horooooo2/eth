const axios = require('axios');

const BASE_URL = 'https://fapi.binance.com';
const CATALOG_TTL_MS = 10 * 60 * 1000;
const QUOTE_TTL_MS = 15 * 1000;
const client = axios.create({ baseURL: BASE_URL, timeout: 10000, proxy: false });

let catalogCache = { expiresAt: 0, symbols: [], updatedAt: null };
let catalogPromise = null;
const quoteCache = new Map();

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
    if (data?.symbol !== symbol || !Number.isFinite(Number(data.lastPrice))) {
      throw new Error('行情响应格式异常');
    }
    const value = {
      symbol,
      lastPrice: String(data.lastPrice),
      priceChangePercent: String(data.priceChangePercent),
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

module.exports = { getCatalog, getQuotes, normalizeCatalog, parseSymbols };
