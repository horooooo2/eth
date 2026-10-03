const axios = require('axios');

const BASE_URL = 'https://fapi.binance.com';
const CATALOG_TTL_MS = 10 * 60 * 1000;
const QUOTE_TTL_MS = 15 * 1000;
const RADAR_MARKET_TTL_MS = 15 * 1000;
const RADAR_AVAILABLE_TTL_MS = 60 * 1000;
const KLINE_CONFIG = {
  '5m': { ttlMs: 45_000, limit: 200 },
  '15m': { ttlMs: 60_000, limit: 200 },
  '1h': { ttlMs: 90_000, limit: 200 },
  '4h': { ttlMs: 180_000, limit: 200 },
  '1d': { ttlMs: 300_000, limit: 200 },
};
const client = axios.create({ baseURL: BASE_URL, timeout: 10000, proxy: false });
const coinGecko = axios.create({ baseURL: 'https://api.coingecko.com/api/v3', timeout: 8000, proxy: false });
const COIN_IDS = {
  BTC: 'bitcoin', ETH: 'ethereum', BNB: 'binancecoin', SOL: 'solana', XRP: 'ripple', ADA: 'cardano',
  LINK: 'chainlink', LTC: 'litecoin', BCH: 'bitcoin-cash', TRX: 'tron', DOT: 'polkadot', UNI: 'uniswap',
  ETC: 'ethereum-classic', ATOM: 'cosmos', AVAX: 'avalanche-2', TON: 'the-open-network', SUI: 'sui',
  APT: 'aptos', NEAR: 'near', ARB: 'arbitrum', OP: 'optimism', PEPE: 'pepe', DOGE: 'dogecoin',
};
const marketCapCache = new Map();

let catalogCache = { expiresAt: 0, symbols: [], updatedAt: null };
let catalogPromise = null;
const quoteCache = new Map();
const klineCache = new Map();
const klineInFlight = new Map();

const LABELS = {
  XAU: '黄金', XAG: '白银', XPT: '铂金', XPD: '钯金',
  TSLA: '特斯拉', INTC: '英特尔', SNDK: '闪迪', SKHYNIX: '海力士', SPCX: 'SpaceX',
  QQQ: '纳指 100 ETF', SPY: '标普 500 ETF', NVDA: '英伟达', AAPL: '苹果', MSFT: '微软',
  AMZN: '亚马逊', AVGO: '博通', AMD: '超威半导体', META: 'Meta', EWY: '韩国 ETF', EWJ: '日本 ETF',
  BTC: '比特币', ETH: '以太坊', BNB: '币安币', SOL: 'Solana', XRP: '瑞波币',
  DOGE: '狗狗币', ADA: '艾达币', AVAX: '雪崩协议', LINK: 'Chainlink', LTC: '莱特币',
  BCH: '比特币现金', DOT: '波卡', TRX: '波场', TON: 'Toncoin', SUI: 'Sui',
  APT: 'Aptos', NEAR: 'NEAR Protocol', UNI: 'Uniswap', ETC: '以太经典', ATOM: 'Cosmos',
  ARB: 'Arbitrum', OP: 'Optimism', PEPE: 'Pepe', WTI: 'WTI 原油', USOIL: 'WTI 原油',
  BZ: '布伦特原油', BRENT: '布伦特原油', CL: 'WTI 原油', XTI: 'WTI 原油',
};

// Core: liquid, established crypto and mainstream TradFi contracts.
const RADAR_CORE_SYMBOLS = new Set([
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'LINKUSDT', 'LTCUSDT',
  'BCHUSDT', 'TRXUSDT', 'DOTUSDT', 'UNIUSDT', 'ETCUSDT', 'ATOMUSDT',
  'XAUUSDT', 'XAGUSDT', 'QQQUSDT', 'SPYUSDT', 'CLUSDT',
  'NVDAUSDT', 'AAPLUSDT', 'MSFTUSDT', 'AMZNUSDT', 'AVGOUSDT', 'AMDUSDT', 'METAUSDT',
]);
// Higher-volatility instruments stay available for manual observation, but
// are visibly separated from the core universe and are not default favorites.
const RADAR_VOLATILE_SYMBOLS = new Set([
  'AVAXUSDT', 'TONUSDT', 'SUIUSDT', 'SPCXUSDT', 'SNDKUSDT', 'SKHYNIXUSDT', 'TSLAUSDT', 'BZUSDT',
]);
const RADAR_SYMBOLS = new Set([...RADAR_CORE_SYMBOLS, ...RADAR_VOLATILE_SYMBOLS]);

const SHORT_INTERVALS = ['5m', '15m', '1h'];
const SHORT_CHANGE_TTL_MS = 12_000;
const shortChangeCache = new Map();
let exchangeInfoCache = { expiresAt: 0, data: null, updatedAt: null };
let exchangeInfoPromise = null;
let radarMarketCache = { expiresAt: 0, quotes: [], updatedAt: null };
let radarMarketPromise = null;
let radarAvailableCache = { expiresAt: 0, contracts: [], updatedAt: null };
let radarAvailablePromise = null;

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

function normalizeAvailableRadarCatalog(data) {
  if (!Array.isArray(data?.symbols)) throw new Error('币安合约清单格式异常');
  return data.symbols
    .filter((row) => row.status === 'TRADING'
      && ['PERPETUAL', 'TRADIFI_PERPETUAL'].includes(row.contractType)
      && row.quoteAsset === 'USDT')
    .map((row) => {
      const isTradFi = row.contractType === 'TRADIFI_PERPETUAL'
        || (Array.isArray(row.underlyingSubType) && row.underlyingSubType.includes('TradFi'));
      return {
        symbol: row.symbol,
        baseAsset: row.baseAsset,
        quoteAsset: row.quoteAsset,
        name: LABELS[row.baseAsset] || row.baseAsset,
        category: isTradFi ? (row.underlyingType || 'TradFi') : 'CRYPTO',
        assetType: isTradFi ? 'TRADFI' : 'CRYPTO',
        radarTier: RADAR_VOLATILE_SYMBOLS.has(row.symbol) ? 'VOLATILE' : 'CORE',
        status: row.status,
      };
    })
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function normalizeRadarCatalog(data, includeSymbols = []) {
  const requested = new Set(Array.isArray(includeSymbols) ? includeSymbols : parseSymbols(includeSymbols));
  return normalizeAvailableRadarCatalog(data)
    .filter((row) => RADAR_SYMBOLS.has(row.symbol) || requested.has(row.symbol));
}

async function getExchangeInfo() {
  if (exchangeInfoCache.expiresAt > Date.now() && exchangeInfoCache.data) return exchangeInfoCache;
  if (!exchangeInfoPromise) {
    exchangeInfoPromise = (async () => {
      const { data } = await client.get('/fapi/v1/exchangeInfo');
      if (!Array.isArray(data?.symbols)) throw new Error('币安合约清单格式异常');
      exchangeInfoCache = { data, updatedAt: new Date().toISOString(), expiresAt: Date.now() + CATALOG_TTL_MS };
      return exchangeInfoCache;
    })().finally(() => { exchangeInfoPromise = null; });
  }
  try {
    return await exchangeInfoPromise;
  } catch (err) {
    if (exchangeInfoCache.data) return { ...exchangeInfoCache, stale: true, error: err.message };
    throw err;
  }
}

async function getRadarCatalog(includeSymbols = []) {
  const exchangeInfo = await getExchangeInfo();
  const requested = Array.isArray(includeSymbols) ? includeSymbols : parseSymbols(includeSymbols);
  return {
    symbols: normalizeRadarCatalog(exchangeInfo.data, requested),
    updatedAt: exchangeInfo.updatedAt,
    stale: Boolean(exchangeInfo.stale),
    error: exchangeInfo.error,
  };
}

async function getRadarAvailableContracts() {
  if (radarAvailableCache.expiresAt > Date.now()) return radarAvailableCache;
  if (!radarAvailablePromise) {
    radarAvailablePromise = (async () => {
      const [exchangeInfo, tickerResponse] = await Promise.all([
        getExchangeInfo(),
        client.get('/fapi/v1/ticker/24hr'),
      ]);
      if (!Array.isArray(tickerResponse.data)) throw new Error('全市场行情格式异常');
      const tickerBySymbol = new Map(tickerResponse.data.map((row) => [row.symbol, row]));
      const contracts = normalizeAvailableRadarCatalog(exchangeInfo.data)
        .map((contract) => {
          const ticker = tickerBySymbol.get(contract.symbol);
          return {
            ...contract,
            lastPrice: ticker?.lastPrice == null ? null : String(ticker.lastPrice),
            priceChangePercent: ticker?.priceChangePercent == null ? null : String(ticker.priceChangePercent),
            quoteVolume24h: ticker?.quoteVolume == null ? null : String(ticker.quoteVolume),
          };
        })
        .filter((contract) => contract.lastPrice && Number.isFinite(Number(contract.lastPrice))
          && Number(contract.lastPrice) > 0)
        .sort((a, b) => Number(b.quoteVolume24h || 0) - Number(a.quoteVolume24h || 0));
      radarAvailableCache = {
        contracts,
        updatedAt: new Date().toISOString(),
        expiresAt: Date.now() + RADAR_AVAILABLE_TTL_MS,
      };
      return radarAvailableCache;
    })().finally(() => { radarAvailablePromise = null; });
  }
  try {
    return await radarAvailablePromise;
  } catch (err) {
    if (radarAvailableCache.contracts.length) return { ...radarAvailableCache, stale: true, error: err.message };
    throw err;
  }
}

// A single bulk ticker request keeps the all-contract radar list inexpensive;
// detailed short-interval klines remain limited to the user's watchlist.
async function getRadarMarketQuotes() {
  if (radarMarketCache.expiresAt > Date.now()) return radarMarketCache;
  if (!radarMarketPromise) {
    radarMarketPromise = (async () => {
      const [{ data }, catalog] = await Promise.all([
        client.get('/fapi/v1/ticker/24hr'),
        getRadarCatalog(),
      ]);
      if (!Array.isArray(data)) throw new Error('全市场行情格式异常');
      const known = new Set(catalog.symbols.map((row) => row.symbol));
      const quotes = data.filter((row) => known.has(row.symbol)
        && Number.isFinite(Number(row.lastPrice)) && Number(row.lastPrice) > 0)
        .map((row) => ({
          symbol: row.symbol,
          lastPrice: String(row.lastPrice),
          priceChangePercent: row.priceChangePercent == null ? null : String(row.priceChangePercent),
          quoteVolume24h: row.quoteVolume == null ? null : String(row.quoteVolume),
          closeTime: Number(row.closeTime) || null,
          source: 'Binance USDⓈ-M Futures',
          stale: false,
        }));
      radarMarketCache = { quotes, updatedAt: new Date().toISOString(), expiresAt: Date.now() + RADAR_MARKET_TTL_MS };
      for (const quote of quotes) quoteCache.set(quote.symbol, { value: quote, expiresAt: Date.now() + QUOTE_TTL_MS });
      return radarMarketCache;
    })().finally(() => { radarMarketPromise = null; });
  }
  try {
    return await radarMarketPromise;
  } catch (err) {
    if (radarMarketCache.quotes.length) return {
      ...radarMarketCache,
      quotes: radarMarketCache.quotes.map((quote) => ({ ...quote, stale: true })),
      stale: true,
      error: err.message,
    };
    throw err;
  }
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
      quoteVolume24h: data.quoteVolume == null || data.quoteVolume === '' ? null : String(data.quoteVolume),
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

async function getRadarMarketCap(symbolInput) {
  const symbol = String(symbolInput || '').trim().toUpperCase().replace(/USDT$/, '');
  const coinId = COIN_IDS[symbol];
  if (!coinId) return { symbol: String(symbolInput || '').trim().toUpperCase(), marketCapUsd: null, source: null, updatedAt: null };
  const cached = marketCapCache.get(coinId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const headers = process.env.COINGECKO_API_KEY ? { 'x-cg-demo-api-key': process.env.COINGECKO_API_KEY } : undefined;
    const { data } = await coinGecko.get('/coins/markets', { params: { vs_currency: 'usd', ids: coinId }, headers });
    const marketCap = Array.isArray(data) ? data[0]?.market_cap : null;
    const value = { symbol: `${symbol}USDT`, marketCapUsd: Number.isFinite(Number(marketCap)) && Number(marketCap) > 0 ? String(marketCap) : null, source: 'CoinGecko', updatedAt: new Date().toISOString() };
    marketCapCache.set(coinId, { value, expiresAt: Date.now() + 10 * 60 * 1000 });
    return value;
  } catch (err) {
    if (cached) return { ...cached.value, stale: true };
    return { symbol: `${symbol}USDT`, marketCapUsd: null, source: 'CoinGecko', updatedAt: null, error: err.message };
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

async function fetchShortChange(symbol, interval, currentPrice) {
  const key = `${symbol}:${interval}`;
  const cached = shortChangeCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const { data } = await client.get('/fapi/v1/klines', { params: { symbol, interval, limit: 1 } });
    const row = Array.isArray(data) ? data[0] : null;
    const open = Number(row?.[1]);
    const price = Number(currentPrice);
    if (!Number.isFinite(open) || open <= 0 || !Number.isFinite(price) || price <= 0) throw new Error('短周期行情格式异常');
    const value = (price / open - 1) * 100;
    shortChangeCache.set(key, { value, expiresAt: Date.now() + SHORT_CHANGE_TTL_MS });
    return value;
  } catch {
    return cached ? cached.value : null;
  }
}

async function getRadarQuotes(input) {
  const requested = parseSymbols(input);
  if (!requested.length) return { quotes: [], invalidSymbols: [], updatedAt: new Date().toISOString(), source: 'Binance USDⓈ-M Futures' };
  const catalog = await getRadarCatalog(requested);
  const known = new Set(catalog.symbols.map((row) => row.symbol));
  const valid = requested.filter((symbol) => known.has(symbol));
  const invalidSymbols = requested.filter((symbol) => !known.has(symbol));
  const quotes = new Array(valid.length);
  let nextIndex = 0;
  const workerCount = Math.min(8, valid.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < valid.length) {
      const index = nextIndex++;
      const symbol = valid[index];
      const quote = await fetchQuote(symbol);
      const shortChanges = await Promise.all(SHORT_INTERVALS.map((interval) => fetchShortChange(symbol, interval, quote.lastPrice)));
      quotes[index] = {
        ...quote,
        changes: { '5m': shortChanges[0], '15m': shortChanges[1], '1h': shortChanges[2] },
      };
    }
  }));
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

module.exports = { getCatalog, getQuotes, getRadarCatalog, getRadarQuotes, getRadarMarketQuotes, getRadarAvailableContracts, getRadarMarketCap, getTradFiKlines, getTradFiMarketContext, normalizeCatalog, normalizeRadarCatalog, normalizeAvailableRadarCatalog, parseSymbols, KLINE_CONFIG, mapKline, RADAR_SYMBOLS, RADAR_CORE_SYMBOLS, RADAR_VOLATILE_SYMBOLS };
