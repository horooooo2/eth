const axios = require('axios');
const { BoundedCache } = require('./boundedCache');

const BASE_URL = 'https://fapi.binance.com';
const CATALOG_TTL_MS = 10 * 60 * 1000;
const QUOTE_TTL_MS = 15 * 1000;
const RADAR_AVAILABLE_TTL_MS = 60 * 1000;
const KLINE_CONFIG = {
  '5m': { ttlMs: 45_000, limit: 200 },
  '15m': { ttlMs: 60_000, limit: 200 },
  '1h': { ttlMs: 90_000, limit: 200 },
  '4h': { ttlMs: 180_000, limit: 200 },
  '1d': { ttlMs: 300_000, limit: 200 },
};
const client = axios.create({ baseURL: BASE_URL, timeout: 10000, ...(process.env.OUTBOUND_PROXY_URL ? {} : { proxy: false }) });
const coinGecko = axios.create({ baseURL: 'https://api.coingecko.com/api/v3', timeout: 8000, ...(process.env.OUTBOUND_PROXY_URL ? {} : { proxy: false }) });
const COIN_IDS = {
  BTC: 'bitcoin', ETH: 'ethereum', BNB: 'binancecoin', SOL: 'solana', XRP: 'ripple', ADA: 'cardano',
  LINK: 'chainlink', LTC: 'litecoin', BCH: 'bitcoin-cash', TRX: 'tron', DOT: 'polkadot', UNI: 'uniswap',
  ETC: 'ethereum-classic', ATOM: 'cosmos', AVAX: 'avalanche-2', TON: 'the-open-network', SUI: 'sui',
  APT: 'aptos', NEAR: 'near', ARB: 'arbitrum', OP: 'optimism', PEPE: 'pepe', DOGE: 'dogecoin',
};
const marketCapCache = new BoundedCache(64, 3600000, () => Date.now());

let catalogCache = { expiresAt: 0, symbols: [], updatedAt: null };
let catalogPromise = null;
const quoteCache = new BoundedCache(512, 3600000, () => Date.now());
const klineCache = new BoundedCache(128, 3600000, () => Date.now());
const klineInFlight = new Map();

const LABELS = {
  XAU: '黄金', XAG: '白银', XPT: '铂金', XPD: '钯金',
  TSLA: '特斯拉', INTC: '英特尔', SNDK: '闪迪', SKHYNIX: '海力士', SPCX: 'SpaceX',
  WDC: '西部数据', KUAISHOU: '快手', XIAOMI: '小米', HK1810: '小米',
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

const SHORT_INTERVALS = ['5m', '1h'];
const shortChangeCache = new BoundedCache(512, 3600000, () => Date.now());
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

let tickerSnapshot = null, tickerPromise = null;
async function getTickerSnapshot() {
  if (tickerSnapshot?.expiresAt > Date.now()) return tickerSnapshot;
  if (!tickerPromise) tickerPromise = client.get('/fapi/v1/ticker/24hr').then(({data}) => {
    if (!Array.isArray(data) || !data.length) throw Error('全市场行情格式异常');
    tickerSnapshot = { data, expiresAt: Date.now() + QUOTE_TTL_MS };
    return tickerSnapshot;
  }).finally(() => { tickerPromise = null; });
  return tickerPromise;
}
async function getLongTrendPrices(){
  const [catalog,response]=await Promise.all([getLongTrendContracts(),getTickerSnapshot()]);
  if(catalog.stale||!Array.isArray(response.data))throw Error('合约现价暂不可用');
  const symbols=new Set(catalog.contracts.map(row=>row.symbol));
  return response.data.filter(row=>symbols.has(row.symbol)&&Number(row.lastPrice)>0&&Number.isFinite(Number(row.lastPrice))).map(row=>({symbol:row.symbol,price:Number(row.lastPrice),time:Number(row.closeTime)||Date.now()}));
}
async function getLongTrendContracts() {
  const info=await getExchangeInfo();
  return {contracts:normalizeAvailableRadarCatalog(info.data).filter(row=>row.assetType==='TRADFI'),stale:Boolean(info.stale)};
}

async function getRadarAvailableContracts() {
  if (radarAvailableCache.expiresAt > Date.now()) return radarAvailableCache;
  if (!radarAvailablePromise) {
    radarAvailablePromise = (async () => {
      const [exchangeInfo, tickerResponse] = await Promise.all([
        getExchangeInfo(),
        getTickerSnapshot(),
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
// Only the selected short interval is enriched, using shared caches and bounded concurrency.
async function getRadarMarketQuotes(interval = '24h') {
  if (SHORT_INTERVALS.includes(interval)) {
    const snapshot = await getRadarMarketQuotes();
    const quotes = new Array(snapshot.quotes.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, quotes.length) }, async () => {
      while (next < quotes.length) {
        const index = next++;
        const quote = snapshot.quotes[index];
        const change = await fetchShortChange(quote.symbol, interval, quote.lastPrice, Number(quote.closeTime) || Date.now());
        quotes[index] = { ...quote, changes: { [interval]: change.change }, changeMeta: { [interval]: change }, stale: quote.stale || change.stale };
      }
    }));
    return { ...snapshot, quotes, interval, stale: Boolean(snapshot.stale) || quotes.some(quote => quote.stale) };
  }
  if (radarMarketCache.expiresAt > Date.now()) return radarMarketCache;
  if (!radarMarketPromise) {
    radarMarketPromise = (async () => {
      const [{ data, expiresAt }, catalog] = await Promise.all([
        getTickerSnapshot(),
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
          highPrice24h: Number(row.highPrice)>0 ? String(row.highPrice) : null,
          lowPrice24h: Number(row.lowPrice)>0 ? String(row.lowPrice) : null,
          closeTime: Number(row.closeTime) || null,
          source: 'Binance USDⓈ-M Futures',
          stale: false,
        }));
      radarMarketCache = { quotes, updatedAt: new Date().toISOString(), expiresAt };
      for (const quote of quotes) quoteCache.set(quote.symbol, { value: quote, expiresAt });
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
    const snapshot = await getTickerSnapshot();
    const data = snapshot.data.find(row => row.symbol === symbol);
    if (data?.symbol !== symbol || data.lastPrice == null || data.lastPrice === '' || !Number.isFinite(Number(data.lastPrice)) || Number(data.lastPrice) <= 0) {
      throw new Error('行情响应格式异常');
    }
    const value = {
      symbol,
      lastPrice: String(data.lastPrice),
      priceChangePercent: data.priceChangePercent == null || data.priceChangePercent === '' ? null : String(data.priceChangePercent),
      quoteVolume24h: data.quoteVolume == null || data.quoteVolume === '' ? null : String(data.quoteVolume),
      highPrice24h: Number(data.highPrice)>0 ? String(data.highPrice) : null,
      lowPrice24h: Number(data.lowPrice)>0 ? String(data.lowPrice) : null,
      closeTime: Number(data.closeTime) || null,
      source: 'Binance USDⓈ-M Futures',
      stale: false,
    };
    quoteCache.set(symbol, { value, expiresAt: snapshot.expiresAt });
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

const shortChangeInflight = new Map();
async function fetchShortChange(symbol, interval, currentPrice, observedAt = Date.now()) {
  const key = `${symbol}:${interval}`;
  const cached = shortChangeCache.get(key);
  const minutes = { '5m': 5, '1h': 60 }[interval];
  const referenceAt = Math.floor((observedAt - minutes * 60000) / 60000) * 60000;
  try {
    let baseline = cached;
    if (!baseline || baseline.referenceAt !== referenceAt) {
      const requestKey = `${key}:${referenceAt}`;
      let task = shortChangeInflight.get(requestKey);
      if (!task) {
        task = client.get('/fapi/v1/klines', { params: { symbol, interval: '1m', startTime: referenceAt, endTime: observedAt, limit: minutes + 1 } }).then(({data}) => {
          const row = Array.isArray(data) ? data[0] : null, open = Number(row?.[1]);
          if (Number(row?.[0]) !== referenceAt || !(open > 0) || !Number.isFinite(open)) throw Error('滚动周期基准数据缺失');
          // The existing minute request also supplies real wick extrema, with no additional requests.
          const bars = Array.isArray(data) ? data.map(mapKline) : [];
          const expected = Math.floor(observedAt / 60000) - referenceAt / 60000 + 1;
          const complete = bars.length === expected && bars.every((bar,i) => bar && bar.openTime === referenceAt+i*60000 && bar.high >= Math.max(bar.open,bar.close) && bar.low <= Math.min(bar.open,bar.close));
          const highPrice = complete ? bars.reduce((high,bar)=>Math.max(high,bar.high),0) : null;
          const lowPrice = complete ? bars.reduce((low,bar)=>Math.min(low,bar.low),Infinity) : null;
          return { open, referenceAt, highPrice, lowPrice, rangeAsOf: observedAt, expiresAt: Date.now() + 60000 };
        }).finally(() => shortChangeInflight.delete(requestKey));
        shortChangeInflight.set(requestKey, task);
      }
      baseline = await task;
    }
    const price = Number(currentPrice);
    if (!(price > 0) || !Number.isFinite(price)) throw Error('现价不可用');
    const value = { change: (price / baseline.open - 1) * 100, asOf: observedAt, referenceAt, stale: false, highPrice: baseline.highPrice == null ? null : Math.max(baseline.highPrice,price,baseline.value?.highPrice || 0),
      lowPrice: baseline.lowPrice == null ? null : Math.min(baseline.lowPrice,price,baseline.value?.lowPrice || Infinity), rangeAsOf: baseline.rangeAsOf,
      rangeStale: baseline.highPrice == null || observedAt > baseline.rangeAsOf, windowMode: 'rolling-minute' };
    const latest = shortChangeCache.get(key);
    if (!latest || !latest.value || observedAt >= latest.value.asOf) shortChangeCache.set(key, { ...baseline, value });
    return value;
  } catch {
    return cached?.value ? { ...cached.value, stale: true } : { change: null, asOf: null, referenceAt: null, stale: true };
  }
}

async function getRadarQuotes(input, interval = '24h') {
  const intervals = SHORT_INTERVALS.includes(interval) ? [interval] : [];
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
      const shortChanges = await Promise.all(intervals.map((interval) => fetchShortChange(symbol, interval, quote.lastPrice, Number(quote.closeTime) || Date.now())));
      quotes[index] = {
        ...quote,
        changes: Object.fromEntries(intervals.map((interval, i) => [interval, shortChanges[i].change])),
        changeMeta: Object.fromEntries(intervals.map((interval, i) => [interval, shortChanges[i]])),
        stale: quote.stale || shortChanges.some(value => value.stale),
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
  const quoteVolume = row[7] == null || row[7] === '' ? null : Number(row[7]);
  return { openTime, open, high, low, close, volume, closeTime,
    quoteVolume: Number.isFinite(quoteVolume) && quoteVolume >= 0 ? quoteVolume : null };
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

async function getRadarDailyHistory(symbol, day) {
  if(!/^[A-Z0-9]{3,30}$/.test(symbol))throw Error('无效合约');
  const {data}=await client.get('/fapi/v1/klines',{params:{symbol,interval:'1d',endTime:day-1,limit:91}});
  if(!Array.isArray(data)||!data.length)throw Error('日线响应为空');
  return data.map(mapKline).filter(Boolean);
}

async function getRadarStreamQuotes(extra=[],onBase=()=>{}){
  const info=await getExchangeInfo();
  const catalog=normalizeAvailableRadarCatalog(info.data);
  const marketSymbols=normalizeRadarCatalog(info.data).map(row=>row.symbol);
  const wanted=new Set([...marketSymbols,...extra.slice(0,150)]);
  const {data}=await getTickerSnapshot();
  const known=new Set(catalog.map(row=>row.symbol));
  const quotes=data.filter(row=>known.has(row.symbol)&&Number(row.lastPrice)>0).map(row=>({symbol:row.symbol,
    lastPrice:String(row.lastPrice),priceChangePercent:row.priceChangePercent==null?null:String(row.priceChangePercent),
    highPrice24h:Number(row.highPrice)>0?String(row.highPrice):null,lowPrice24h:Number(row.lowPrice)>0?String(row.lowPrice):null,
    quoteVolume24h:row.quoteVolume==null?null:String(row.quoteVolume),closeTime:Number(row.closeTime)||null,
    source:'Binance USDⓈ-M Futures',stale:Boolean(info.stale)}));
  const base={catalog,marketSymbols,quotes,updatedAt:new Date().toISOString(),stale:Boolean(info.stale),error:''};
  onBase(base);
  const tracked=quotes.filter(row=>wanted.has(row.symbol));let next=0;
  await Promise.all(Array.from({length:Math.min(4,tracked.length)},async()=>{
    while(next<tracked.length){
      const quote=tracked[next++];quote.changes={};quote.changeMeta={};
      for(const interval of SHORT_INTERVALS){
        const change=await fetchShortChange(quote.symbol,interval,quote.lastPrice,quote.closeTime||Date.now());
        quote.changes[interval]=change.change;quote.changeMeta[interval]=change;
      }
      quote.shortStale=Object.values(quote.changeMeta).some(value=>value.stale);
    }
  }));
  return base;
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

module.exports = { getRadarStreamQuotes, getLongTrendPrices, getLongTrendContracts, getRadarDailyHistory, getCatalog, getQuotes, getRadarCatalog, getRadarQuotes, getRadarMarketQuotes, getRadarAvailableContracts, getRadarMarketCap, getTradFiKlines, getTradFiMarketContext, normalizeCatalog, normalizeRadarCatalog, normalizeAvailableRadarCatalog, parseSymbols, KLINE_CONFIG, mapKline, RADAR_SYMBOLS, RADAR_CORE_SYMBOLS, RADAR_VOLATILE_SYMBOLS };
