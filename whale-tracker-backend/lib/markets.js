const { hlPost } = require('./hlInfoClient');
const vm = require('node:vm');
const axios = require('axios');
const { getCalendar } = require('./calendar');
const {
  fetchFfRows,
  mergeFfMacroEvents,
  eventSeverity,
  inferPreviousDate,
  shiftYmd,
} = require('./calendarFeed');
const { readCache, readWhaleModeCache } = require('./cache');
const { readConfig, normalizeMode } = require('./config');

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const client = axios.create({
  timeout: 12000,
  headers: { Accept: 'application/json,text/html,*/*', 'User-Agent': BROWSER_UA },
  validateStatus: (code) => code < 500,
});

const COINS = [
  { id: 'BTC', symbol: 'BTCUSDT', gate: 'BTC_USDT', geckoId: 'bitcoin', name: 'Bitcoin', bucket: 500 },
  { id: 'ETH', symbol: 'ETHUSDT', gate: 'ETH_USDT', geckoId: 'ethereum', name: 'Ethereum', bucket: 25 },
];

const KEY_LEVELS = {
  BTC: [70000, 75000, 77000, 78000, 80000, 82000, 85000, 90000],
  ETH: [2000, 2200, 2300, 2400, 2500, 2600, 2700, 2800, 3000],
};

const VISION = 'https://data-api.binance.vision';
const GECKO = 'https://api.coingecko.com/api/v3';
const BYTICK = 'https://api.bytick.com';
const GATE = 'https://api.gateio.ws/api/v4';

async function tryGet(url, params) {
  try {
    const { data, status } = await client.get(url, { params });
    return status === 200 ? data : null;
  } catch (_err) {
    return null;
  }
}

async function tryGetText(url) {
  try {
    const { data, status } = await client.get(url, {
      responseType: 'text',
      transformResponse: [(value) => value],
    });
    return status === 200 && typeof data === 'string' ? data : null;
  } catch (_err) {
    return null;
  }
}

async function tryPost(url, body) {
  try {
    const { data, status } = await client.post(url, body);
    return status === 200 ? data : null;
  } catch (_err) {
    return null;
  }
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function shanghaiParts(ts) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ts)).map((item) => [item.type, item.value]));
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    hm: `${parts.hour}:${parts.minute}`,
    mdhm: `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`,
  };
}

async function mapPool(items, limit, mapper) {
  const result = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      result[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return result;
}

function mapKlines(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    time: Number(row[0]),
    close: num(row[4]),
    high: num(row[2]),
    low: num(row[3]),
    volume: num(row[5]),
    quote: num(row[7]),
  }));
}

async function fetchVisionTicker(symbol) {
  const data = await tryGet(`${VISION}/api/v3/ticker/24hr`, { symbol });
  if (!data) return null;
  return {
    price: num(data.lastPrice),
    high24h: num(data.highPrice),
    low24h: num(data.lowPrice),
    change24h: num(data.priceChangePercent),
    volume24h: num(data.quoteVolume),
  };
}

async function fetchVisionKlines(symbol, interval, limit) {
  const data = await tryGet(`${VISION}/api/v3/klines`, { symbol, interval, limit });
  return mapKlines(data);
}

function normalizeCoinId(raw) {
  let id = String(raw || '').trim().toUpperCase();
  id = id.replace(/[-_/]/g, '');
  id = id.replace(/USDT$|USD$|PERP$/, '');
  id = id.replace(/[^A-Z0-9]/g, '');
  return id.slice(0, 12);
}

function defaultBucket(price) {
  if (price >= 1000) return 10;
  if (price >= 100) return 1;
  if (price >= 1) return 0.01;
  if (price >= 0.01) return 0.0001;
  return 0.000001;
}

function coinSpec(id) {
  const pinned = COINS.find((item) => item.id === id);
  if (pinned) return pinned;
  return {
    id,
    symbol: `${id}USDT`,
    gate: `${id}_USDT`,
    geckoId: '',
    name: id,
    bucket: 0,
  };
}

function parseExtraIds(ids) {
  const seen = new Set();
  const out = [];
  for (const raw of ids || []) {
    const id = normalizeCoinId(raw);
    if (!id || id.length < 2 || id === 'BTC' || id === 'ETH' || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 8) break;
  }
  return out;
}

async function fetchHlCtx(ids) {
  const wanted = Array.isArray(ids) && ids.length ? ids : COINS.map((item) => item.id);
  const data = await hlPost({ type: 'metaAndAssetCtxs' }).catch(() => null);
  const universe = data?.[0]?.universe || [];
  const ctxs = data?.[1] || [];
  const map = {};
  for (const id of wanted) {
    const index = universe.findIndex((item) => item.name === id);
    if (index >= 0) map[id] = ctxs[index] || {};
  }
  return map;
}

async function fetchBytickTicker(symbol) {
  const data = await tryGet(`${BYTICK}/v5/market/tickers`, { category: 'linear', symbol });
  const row = data?.result?.list?.[0];
  if (!row) return null;
  return {
    price: num(row.lastPrice),
    high24h: num(row.highPrice24h),
    low24h: num(row.lowPrice24h),
    change24h: num(row.price24hPcnt) * 100,
    volume24h: num(row.turnover24h),
    oiUsd: num(row.openInterestValue),
    funding: num(row.fundingRate),
  };
}

function packLsShare(longShare, shortShare, ratio) {
  const long = num(longShare);
  const short = num(shortShare) || (long ? 1 - long : 0);
  const packedRatio = num(ratio) || (short ? long / short : 0);
  return { long, short, ratio: packedRatio };
}

async function fetchBytickLs(symbol) {
  const data = await tryGet(`${BYTICK}/v5/market/account-ratio`, {
    category: 'linear',
    symbol,
    period: '1h',
    limit: 1,
  });
  const row = data?.result?.list?.[0];
  if (!row) return null;
  const account = packLsShare(row.buyRatio, row.sellRatio);
  return {
    longAccount: account.long,
    shortAccount: account.short,
    accountRatio: account.ratio,
    longPosition: 0,
    shortPosition: 0,
    positionRatio: 0,
  };
}

async function fetchPositionLs(contract) {
  const data = await tryGet(`${GATE}/futures/usdt/contract_stats`, {
    contract,
    interval: '1h',
    limit: 1,
  });
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) return null;
  const longSize = num(row.top_long_size);
  const shortSize = num(row.top_short_size);
  const total = longSize + shortSize;
  const positionRatio = num(row.top_lsr_size) || (shortSize ? longSize / shortSize : 0);
  if (!positionRatio && !total) return null;
  return {
    longPosition: total ? longSize / total : 0,
    shortPosition: total ? shortSize / total : 0,
    positionRatio,
  };
}

async function fetchBytickOiChange(symbol) {
  const data = await tryGet(`${BYTICK}/v5/market/open-interest`, {
    category: 'linear',
    symbol,
    intervalTime: '1h',
    limit: 24,
  });
  const list = data?.result?.list || [];
  if (list.length < 2) return 0;
  const newest = num(list[0].openInterest);
  const oldest = num(list[list.length - 1].openInterest);
  if (!oldest) return 0;
  return ((newest - oldest) / oldest) * 100;
}

async function fetchGeckoDerivOi(specs) {
  const coins = Array.isArray(specs) && specs.length ? specs : COINS;
  const data = await tryGet(`${GECKO}/derivatives`, { include_tickers: 'unexpired' });
  const map = {};
  if (!Array.isArray(data)) return map;
  for (const coin of coins) {
    const row = data.find(
      (item) =>
        /binance/i.test(String(item.market || '')) &&
        String(item.symbol || '').toUpperCase() === coin.symbol,
    );
    if (row) map[coin.id] = num(row.open_interest);
  }
  return map;
}

const liqCache = new Map();
const LIQ_CACHE_TTL_MS = 60 * 1000;

async function fetchGateLiq(contract, quanto, hours = 24) {
  const h = Math.max(1, Math.min(24, Number(hours) || 24));
  const cacheKey = `${contract || ''}:${h}:v3`;
  const hit = liqCache.get(cacheKey);
  if (hit && Date.now() - hit.at < LIQ_CACHE_TTL_MS) return hit.value;

  const now = Math.floor(Date.now() / 1000);
  const windows = Array.from({ length: h }, (_, index) => ({
    hourAgo: index,
    from: now - (index + 1) * 3600,
    to: now - index * 3600,
  }));
  const chunks = await mapPool(windows, Math.min(h, 8), async (slot) => ({
    slot,
    rows: await tryGet(`${GATE}/futures/usdt/liq_orders`, {
      contract,
      from: slot.from,
      to: slot.to,
      limit: 1000,
    }),
  }));

  let longUsd = 0;
  let shortUsd = 0;
  let count = 0;
  const buckets = windows.map((slot) => ({
    hourAgo: slot.hourAgo,
    from: slot.from * 1000,
    to: slot.to * 1000,
    longUsd: 0,
    shortUsd: 0,
    totalUsd: 0,
    count: 0,
  }));

  for (const chunk of chunks) {
    const bucket = buckets[chunk.slot.hourAgo];
    const rows = chunk.rows;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      // Gate liq_orders: size = 仓位（正多负空）；order_size = 强平委托（符号相反）
      const pos = num(row.size);
      const signed = pos !== 0 ? pos : -num(row.order_size);
      const size = Math.abs(signed);
      const px = num(row.fill_price || row.order_price);
      if (!size || !px) continue;
      const usd = size * quanto * px;
      const side = signed > 0 ? 'long' : 'short';
      count += 1;
      if (side === 'long') longUsd += usd;
      else shortUsd += usd;
      if (bucket) {
        bucket.count += 1;
        bucket.totalUsd += usd;
        if (side === 'long') bucket.longUsd += usd;
        else bucket.shortUsd += usd;
      }
    }
  }

  const value = {
    longUsd,
    shortUsd,
    totalUsd: longUsd + shortUsd,
    count,
    hours: h,
    source: count ? 'Gate.io' : '',
    buckets,
  };
  liqCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

const LIQ_PERIODS = [1, 4, 12, 24];

function aggregateLiqPeriods(buckets = []) {
  return LIQ_PERIODS.map((hours) => {
    let longUsd = 0;
    let shortUsd = 0;
    let count = 0;
    for (const bucket of buckets) {
      if (Number(bucket.hourAgo) >= hours) continue;
      longUsd += Number(bucket.longUsd) || 0;
      shortUsd += Number(bucket.shortUsd) || 0;
      count += Number(bucket.count) || 0;
    }
    return {
      hours,
      label: `${hours}小时爆仓`,
      longUsd,
      shortUsd,
      totalUsd: longUsd + shortUsd,
      count,
    };
  });
}

async function getLiquidations(coinId = 'BTC', hours = 24) {
  const id = normalizeCoinId(coinId) || 'BTC';
  const emptyPeriods = aggregateLiqPeriods([]);
  const empty = {
    coin: id,
    hours: 24,
    longUsd: 0,
    shortUsd: 0,
    totalUsd: 0,
    count: 0,
    source: '',
    buckets: [],
    periods: emptyPeriods,
    updatedAt: Date.now(),
  };
  const spec = coinSpec(id);
  const quanto = await fetchGateQuanto(spec.gate);
  if (!quanto) return empty;
  // 始终拉 24h，再聚合成 1/4/12/24 四档
  const liq = await fetchGateLiq(spec.gate, quanto, 24);
  const periods = aggregateLiqPeriods(liq.buckets || []);
  const summary = periods.find((item) => item.hours === 24) || periods[periods.length - 1];
  return {
    coin: id,
    hours: 24,
    longUsd: summary?.longUsd || liq.longUsd,
    shortUsd: summary?.shortUsd || liq.shortUsd,
    totalUsd: summary?.totalUsd || liq.totalUsd,
    count: summary?.count || liq.count,
    source: liq.source,
    buckets: liq.buckets || [],
    periods,
    updatedAt: Date.now(),
  };
}

async function fetchGateQuanto(contract) {
  const data = await tryGet(`${GATE}/futures/usdt/contracts/${contract}`);
  return num(data?.quanto_multiplier) || 0;
}

function quoteResult(value, prev) {
  if (!value) return null;
  return {
    value,
    change: prev ? value - prev : 0,
    changePct: prev ? ((value - prev) / prev) * 100 : 0,
  };
}

async function fetchYahoo(symbol) {
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    const data = await tryGet(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}`, {
      interval: '1d',
      range: '5d',
    });
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) continue;
    const parsed = quoteResult(num(meta.regularMarketPrice), num(meta.chartPreviousClose || meta.previousClose));
    if (parsed) return parsed;
  }
  return null;
}

async function fetchStooq(symbol) {
  const text = await tryGetText(`https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&f=sd2t2ohlcv&h&e=csv`);
  if (!text) return null;
  const line = text.trim().split(/\r?\n/).pop() || '';
  const cols = line.split(',');
  if (cols.length < 7 || /close/i.test(cols[6])) return null;
  return quoteResult(num(cols[6]), num(cols[3]));
}

async function fetchMacroQuote(yahooSymbol, stooqSymbol) {
  return (await fetchYahoo(yahooSymbol)) || fetchStooq(stooqSymbol);
}

async function fetchFearGreed() {
  const data = await tryGet('https://api.alternative.me/fng/', { limit: 1 });
  const row = data?.data?.[0];
  if (!row) return { value: 0, label: '' };
  return { value: num(row.value), label: row.value_classification || '' };
}

function parsePrices(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return num(Array.isArray(parsed) ? parsed[0] : 0);
  } catch (_err) {
    return 0;
  }
}

function unwrapPolyEvent(data) {
  if (!data) return null;
  if (Array.isArray(data)) return data[0] || null;
  if (Array.isArray(data.events)) return data.events[0] || null;
  return data;
}

function parseFedEvent(event) {
  let markets = event?.markets || [];
  if (typeof markets === 'string') {
    try {
      markets = JSON.parse(markets);
    } catch {
      markets = [];
    }
  }
  const items = (Array.isArray(markets) ? markets : []).map((market) => {
    const title = String(market.groupItemTitle || market.question || '');
    let label = title;
    if (/50\+ bps decrease/i.test(title)) label = '降息 50bp+';
    else if (/25 bps decrease/i.test(title)) label = '降息 25bp';
    else if (/No change/i.test(title)) label = '维持利率';
    else if (/50\+ bps increase/i.test(title)) label = '加息 50bp+';
    else if (/25 bps increase/i.test(title)) label = '加息 25bp';
    const pct = parsePrices(market.outcomePrices) * 100;
    return { label, pct, kind: label.includes('加息') ? 'hike' : label.includes('降息') ? 'cut' : 'hold' };
  });
  const hikePct = items.filter((item) => item.kind === 'hike').reduce((sum, item) => sum + item.pct, 0);
  const cutPct = items.filter((item) => item.kind === 'cut').reduce((sum, item) => sum + item.pct, 0);
  const holdPct = items.filter((item) => item.kind === 'hold').reduce((sum, item) => sum + item.pct, 0);
  return {
    title: event?.title || '9 月 FOMC',
    items: items.sort((a, b) => b.pct - a.pct),
    hikePct,
    cutPct,
    holdPct,
    source: 'Polymarket',
  };
}

async function tryGetFed(url) {
  try {
    const { data, status } = await client.get(url, {
      timeout: 15000,
      headers: {
        Accept: 'application/json',
        Origin: 'https://polymarket.com',
        Referer: 'https://polymarket.com/event/fed-decision-in-september-762',
      },
    });
    return status === 200 ? data : null;
  } catch (_err) {
    return null;
  }
}

async function fetchFedOdds() {
  const urls = [
    'https://gamma-api.polymarket.com/events?slug=fed-decision-in-september-762',
    'https://gamma-api.polymarket.com/events/slug/fed-decision-in-september-762',
    'https://gamma-api.polymarket.com/events?slug=fed-decision-in-september-2026',
    'https://gamma-api.polymarket.com/events?slug=fed-decision-in-september',
  ];
  for (const url of urls) {
    const parsed = parseFedEvent(unwrapPolyEvent(await tryGetFed(url)));
    if (parsed.items.length) return parsed;
  }
  const search = await tryGetFed('https://gamma-api.polymarket.com/public-search?q=fed%20decision%20september');
  const hit = unwrapPolyEvent(search) || search?.events?.[0];
  const parsed = parseFedEvent(hit);
  if (parsed.items.length) return parsed;
  return {
    title: '9 月 FOMC',
    items: [],
    hikePct: 0,
    cutPct: 0,
    holdPct: 0,
    source: 'Polymarket',
  };
}

const LAST_FOMC = {
  date: '2026-07-29',
  label: '维持利率',
  detail: '9-3 维持 3.50–3.75%，三人主张加息 25bp',
  kind: 'hold',
};

async function buildMacroEvents() {
  const local = await getCalendar(false);
  const todayYmd = shanghaiParts(Date.now()).ymd;
  const weekUntil = shanghaiParts(Date.now() + 16 * 86400000).ymd;
  const weekSince = shiftYmd(todayYmd, -7);
  const events = (local.events || [])
    .filter((item) => item.date >= weekSince && item.date <= weekUntil)
    .map((item) => ({
      id: item.id,
      date: item.date,
      time: item.time || '',
      title: item.title,
      forecast: item.forecast || '',
      previous: item.previous || '',
      actual: item.actual || '',
      previousDate: item.previousDate || inferPreviousDate(item.date, item.title),
      severity: eventSeverity(item.importance, item.impact),
      source: item.source || 'local',
      sortKey: `${item.date} ${item.time || '99:99'}`,
    }));
  return { today: local.today, since: weekSince, events };
}

async function fetchFfEvents(base) {
  const ff = await fetchFfRows(false);
  const since = base.since || shiftYmd(shanghaiParts(Date.now()).ymd, -7);
  const merged = mergeFfMacroEvents(base.events, ff.rows, { since });
  return merged.sort((a, b) => a.sortKey.localeCompare(b.sortKey)).slice(0, 30);
}

function parseBitboNuxt(html) {
  const marker = String(html).indexOf('__NUXT__=');
  if (marker < 0) return null;
  const raw = String(html).slice(marker + 9);
  const end = raw.indexOf('</script>');
  if (end < 0) return null;
  const code = raw.slice(0, end).replace(/;+\s*$/, '');
  return vm.runInNewContext(code, Object.create(null), { timeout: 2000 });
}

async function fetchBitboEtf(kind, spotPrice) {
  const url = kind === 'ETH' ? 'https://bitbo.io/etf/ethereum/' : 'https://bitbo.io/etf/';
  try {
    const { data, status } = await client.get(url, {
      timeout: 8000,
      headers: { Accept: 'text/html', 'User-Agent': BROWSER_UA },
    });
    if (status !== 200 || typeof data !== 'string') {
      return { netUsd: 0, netCoins: 0, window: '', source: '' };
    }
    const nuxt = parseBitboNuxt(data);
    const flows = nuxt?.data?.[0]?.etfFlows;
    if (!flows || typeof flows !== 'object') {
      return { netUsd: 0, netCoins: 0, window: '', source: '' };
    }
    let coins1d = 0;
    let coins7d = 0;
    for (const row of Object.values(flows)) {
      coins1d += num(row.flow_1d);
      coins7d += num(row.flow_7d);
    }
    const nonzero1d = Object.values(flows).filter((row) => Math.abs(num(row.flow_1d)) > 0.01).length;
    const use1d = nonzero1d >= 3;
    const coinsAmt = use1d ? coins1d : coins7d / 7;
    return {
      netUsd: coinsAmt * spotPrice,
      netCoins: coinsAmt,
      window: use1d ? '1d' : '7d-avg',
      source: 'Bitbo',
    };
  } catch (_err) {
    return { netUsd: 0, netCoins: 0, window: '', source: '' };
  }
}

function whaleSnapshot() {
  const mode = normalizeMode(readConfig().mode || 'hf');
  const cached = readWhaleModeCache(mode);
  const whales = cached?.data?.whales || [];
  const trades = cached?.data?.trades || [];
  let long = 0;
  let short = 0;
  let neutral = 0;
  let netUsd = 0;
  for (const whale of whales) {
    if (whale.direction === 'long') long += 1;
    else if (whale.direction === 'short') short += 1;
    else neutral += 1;
    netUsd += num(whale.netUsd);
  }
  const since = Date.now() - 24 * 3600000;
  const flow = { BTC: { inUsd: 0, outUsd: 0, count: 0 }, ETH: { inUsd: 0, outUsd: 0, count: 0 } };
  for (const trade of trades) {
    const asset = String(trade.asset || '').toUpperCase();
    if (!asset || num(trade.time) < since) continue;
    if (!flow[asset]) flow[asset] = { inUsd: 0, outUsd: 0, count: 0 };
    const usd = Math.abs(num(trade.amountUsd));
    flow[asset].count += 1;
    if (trade.side === 'buy' || trade.side === 'in') flow[asset].inUsd += usd;
    else flow[asset].outUsd += usd;
  }
  return { long, short, neutral, netUsd, flow };
}

async function whaleSnapshotFresh() {
  const mode = normalizeMode(readConfig().mode || 'hf');
  const cached = readWhaleModeCache(mode);
  if (!cached?.data?.whales?.length) {
    try {
      const { getWhales } = require('./whales');
      await getWhales(false);
    } catch (err) {
      console.warn('[markets] 巨鲸快照补齐失败:', err.message);
    }
  }
  return whaleSnapshot();
}

function slimKlines(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    time: row.time,
    close: Number(num(row.close).toFixed(4)),
  }));
}

function slimCoin(coin) {
  return {
    ...coin,
    klinesHour: slimKlines(coin.klinesHour),
    klinesDay: slimKlines(coin.klinesDay),
    costDist: {
      belowPct: coin.costDist?.belowPct || 0,
      abovePct: coin.costDist?.abovePct || 0,
      buckets: [],
    },
    openInterest: {
      ...coin.openInterest,
      history: [],
    },
  };
}

function slimPayload(payload) {
  if (!payload) return payload;
  return {
    ...payload,
    coins: (payload.coins || []).map(slimCoin),
  };
}

function buildLevels(coinId, price, high24h, low24h) {
  const set = new Set([...(KEY_LEVELS[coinId] || []), high24h, low24h].filter((value) => value > 0));
  const rows = [...set]
    .map((level) => {
      const distancePct = price ? ((level - price) / price) * 100 : 0;
      let label = `${Math.round(level).toLocaleString('en-US')}`;
      if (Math.abs(level - high24h) < 1) label = '日内高点';
      if (Math.abs(level - low24h) < 1) label = '日内低点';
      if (coinId === 'BTC' && level === 80000) label = '整数阻力';
      if (coinId === 'BTC' && level === 77000) label = '近端支撑';
      if (coinId === 'BTC' && level === 75000) label = '强支撑';
      return {
        price: level,
        kind: level >= price ? 'resist' : 'support',
        distancePct,
        label,
      };
    })
    .sort((a, b) => a.price - b.price);
  const nearby = rows.filter((item) => Math.abs(item.distancePct) <= 8 || /强支撑|整数/.test(item.label));
  const resists = nearby.filter((item) => item.kind === 'resist').slice(0, 2);
  const supports = nearby.filter((item) => item.kind === 'support').slice(-3).reverse();
  return [...resists, { price, kind: 'price', distancePct: 0, label: '现价' }, ...supports];
}

function buildCostDist(klines, price, bucket) {
  const rows = Array.isArray(klines) ? klines : [];
  const map = new Map();
  let total = 0;
  let below = 0;
  for (const row of rows) {
    const vol = num(row.quote || row.volume * row.close);
    if (!vol || !row.close) continue;
    const key = Math.round(row.close / bucket) * bucket;
    map.set(key, (map.get(key) || 0) + vol);
    total += vol;
    if (row.close < price) below += vol;
  }
  const buckets = [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([level, volume]) => ({ price: level, volume, share: total ? volume / total : 0 }));
  return {
    belowPct: total ? (below / total) * 100 : 0,
    abovePct: total ? ((total - below) / total) * 100 : 0,
    buckets,
  };
}

function buildHeat({ funding, longAccount, rangePos, fng, oiChangePct }) {
  const fundingScore = clamp(50 + (funding / 0.0001) * 40, 0, 100);
  const lsScore = clamp((longAccount || 0.5) * 100, 0, 100);
  const rangeScore = clamp(rangePos, 0, 100);
  const fngScore = clamp(fng || 50, 0, 100);
  const oiScore = clamp(50 + oiChangePct * 4, 0, 100);
  const score = fundingScore * 0.25 + lsScore * 0.2 + rangeScore * 0.2 + fngScore * 0.2 + oiScore * 0.15;
  let label = '均衡';
  if (score >= 70) label = '过热';
  else if (score >= 58) label = '偏热';
  else if (score <= 30) label = '恐慌';
  else if (score <= 42) label = '偏冷';
  return {
    score: Math.round(score),
    label,
    parts: {
      funding: Math.round(fundingScore),
      longShort: Math.round(lsScore),
      range: Math.round(rangeScore),
      sentiment: Math.round(fngScore),
      oi: Math.round(oiScore),
    },
  };
}

function buildBias({ heat, levels, whale, coinFlow, fed }) {
  const support = levels.find((item) => item.kind === 'support');
  const resist = levels.find((item) => item.kind === 'resist');
  let technical = 'range';
  if (heat.score >= 62) technical = 'long';
  else if (heat.score <= 38) technical = 'short';
  if (support && Math.abs(support.distancePct) <= 1.2) technical = 'long';
  if (resist && resist.distancePct <= 1.2 && heat.score >= 60) technical = 'short';

  let whaleBias = 'range';
  if (whale.long >= 2 && whale.long > whale.short) whaleBias = 'long';
  else if (whale.short >= 2 && whale.short > whale.long) whaleBias = 'short';
  else if (coinFlow && coinFlow.inUsd - coinFlow.outUsd > 500000) whaleBias = 'long';
  else if (coinFlow && coinFlow.outUsd - coinFlow.inUsd > 500000) whaleBias = 'short';

  const fedBias = fed.hikePct > fed.cutPct + 15 ? 'short' : fed.cutPct > fed.hikePct + 15 ? 'long' : 'range';
  const votes = [technical, whaleBias, fedBias].filter((item) => item !== 'range');
  const longVotes = votes.filter((item) => item === 'long').length;
  const shortVotes = votes.filter((item) => item === 'short').length;
  let direction = 'range';
  if (longVotes >= 2 && shortVotes === 0) direction = 'long';
  else if (shortVotes >= 2 && longVotes === 0) direction = 'short';
  else if (longVotes > shortVotes) direction = 'long';
  else if (shortVotes > longVotes) direction = 'short';

  const resonance = (technical === whaleBias && technical !== 'range') || (whaleBias !== 'range' && whaleBias === fedBias);
  const label = direction === 'long' ? '偏多' : direction === 'short' ? '偏空' : '震荡';
  const reasons = [];
  reasons.push(`情绪 ${heat.label}（${heat.score}）`);
  if (whale.long || whale.short) reasons.push(`巨鲸 ${whale.long}多/${whale.short}空`);
  if (fed.hikePct || fed.cutPct) reasons.push(`加息 ${fed.hikePct.toFixed(0)}% / 降息 ${fed.cutPct.toFixed(0)}%`);
  return { direction, label, resonance, reason: reasons.join(' · ') };
}

function changeFromHl(ctx) {
  const mark = num(ctx.markPx || ctx.midPx);
  const prev = num(ctx.prevDayPx);
  if (!mark || !prev) return 0;
  return ((mark - prev) / prev) * 100;
}

async function fetchCoin(coin, ctx, derivOi, extras) {
  const [ticker, hour, day, bytick, ls, posLs, oiChange, quanto] = await Promise.all([
    fetchVisionTicker(coin.symbol),
    fetchVisionKlines(coin.symbol, '1h', 48),
    fetchVisionKlines(coin.symbol, '1d', 90),
    fetchBytickTicker(coin.symbol),
    fetchBytickLs(coin.symbol),
    fetchPositionLs(coin.gate),
    fetchBytickOiChange(coin.symbol),
    fetchGateQuanto(coin.gate),
  ]);
  const liq = quanto ? await fetchGateLiq(coin.gate, quanto, 24) : {
    longUsd: 0, shortUsd: 0, totalUsd: 0, count: 0, hours: 24, source: '',
  };
  const mark = num(ctx.markPx || ctx.midPx || bytick?.price || ticker?.price);
  const hlOiUsd = num(ctx.openInterest) && mark ? num(ctx.openInterest) * mark : 0;
  const price = ticker?.price || bytick?.price || mark;
  const bucket = coin.bucket || defaultBucket(price);
  const high24h = ticker?.high24h || bytick?.high24h || 0;
  const low24h = ticker?.low24h || bytick?.low24h || 0;
  const volume24h = bytick?.volume24h || ticker?.volume24h || num(ctx.dayNtlVlm);
  const funding = num(ctx.funding) || bytick?.funding || 0;
  const longShort = {
    longAccount: 0,
    shortAccount: 0,
    accountRatio: 0,
    longPosition: 0,
    shortPosition: 0,
    positionRatio: 0,
    ...(ls || {}),
    ...(posLs || {}),
  };
  const rangePos = high24h && low24h && high24h !== low24h ? ((price - low24h) / (high24h - low24h)) * 100 : 50;
  const etf =
    coin.id === 'BTC' || coin.id === 'ETH'
      ? await fetchBitboEtf(coin.id, price)
      : { netUsd: 0, netCoins: 0, window: '', source: '' };
  const coinFlow = extras.whale.flow[coin.id] || { inUsd: 0, outUsd: 0, count: 0 };
  const levels = buildLevels(coin.id, price, high24h, low24h);
  const costDist = buildCostDist(day, price, bucket);
  const heat = buildHeat({
    funding,
    longAccount: longShort.longAccount,
    rangePos,
    fng: extras.fearGreed.value,
    oiChangePct: oiChange,
  });
  const bias = buildBias({
    heat,
    levels,
    whale: extras.whale,
    coinFlow,
    fed: extras.fed,
  });
  return {
    id: coin.id,
    name: coin.name,
    symbol: coin.symbol,
    price,
    high24h,
    low24h,
    change24h: ticker?.change24h || bytick?.change24h || changeFromHl(ctx),
    volume24h,
    klinesHour: hour,
    klinesDay: day,
    funding,
    premium: num(ctx.premium),
    openInterest: {
      contracts: num(ctx.openInterest),
      usd: derivOi[coin.id] || bytick?.oiUsd || hlOiUsd,
      hlUsd: hlOiUsd,
      binanceUsd: derivOi[coin.id] || 0,
      changePct: oiChange,
      history: [],
    },
    longShort,
    liquidations: liq,
    etf,
    whaleFlow: {
      inUsd: coinFlow.inUsd,
      outUsd: coinFlow.outUsd,
      netUsd: coinFlow.inUsd - coinFlow.outUsd,
      count: coinFlow.count,
    },
    levels,
    costDist,
    heat,
    bias,
  };
}

const MARKET_TTL = 25 * 1000;
const QUOTES_TTL = 15 * 1000;
let cache = { at: 0, value: null };
const quotesCache = new Map();
const extraCache = new Map();
let coreInflight = null;

async function tickerPrice(symbol) {
  const vision = await fetchVisionTicker(symbol);
  if (vision?.price) return vision.price;
  const bytick = await fetchBytickTicker(symbol);
  return bytick?.price || 0;
}

function parseQuoteIds(ids) {
  const seen = new Set();
  const out = [];
  for (const raw of ids || []) {
    const id = normalizeCoinId(raw);
    if (!id || id.length < 2 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 12) break;
  }
  return out.length ? out : ['BTC', 'ETH'];
}

async function getQuotes(coinIds = []) {
  const ids = parseQuoteIds(coinIds);
  const key = ids.join(',');
  const hit = quotesCache.get(key);
  if (hit && Date.now() - hit.at < QUOTES_TTL) {
    return hit.value;
  }
  const hlCtx = await fetchHlCtx(ids).catch(() => ({}));
  const tickers = await Promise.all(
    ids.map(async (id) => {
      const spec = coinSpec(id);
      const bytick = await fetchBytickTicker(spec.symbol);
      const price = bytick?.price || (await tickerPrice(spec.symbol));
      const hlFunding = num(hlCtx[id]?.funding);
      const funding =
        bytick && Number.isFinite(bytick.funding) ? bytick.funding : hlFunding || 0;
      return { id, price, funding };
    }),
  );
  const prices = {};
  const funding = {};
  for (const row of tickers) {
    prices[row.id] = row.price;
    funding[row.id] = row.funding;
  }
  const value = { ...prices, funding, updatedAt: Date.now() };
  quotesCache.set(key, { at: Date.now(), value });
  return value;
}

async function lookupCoin(raw) {
  const id = normalizeCoinId(raw);
  if (!id || id.length < 2) {
    return { ok: false, error: '币种输入错误，请检查后再试' };
  }
  const spec = coinSpec(id);
  const ticker = await fetchVisionTicker(spec.symbol);
  let price = ticker?.price || 0;
  if (!price) {
    const bytick = await fetchBytickTicker(spec.symbol);
    price = bytick?.price || 0;
  }
  if (!price) return { ok: false, error: '币种输入错误，请检查后再试' };
  return { ok: true, id, symbol: spec.symbol, name: spec.name, price };
}

async function buildCoreMarkets() {
  const localCal = await buildMacroEvents();
  const emptyFed = {
    title: '9 月 FOMC',
    items: [],
    hikePct: 0,
    cutPct: 0,
    holdPct: 0,
    source: 'Polymarket',
  };
  const [hlCtx, derivOi, treasury10y, dxy, fearGreed, ffEvents, whale] = await Promise.all([
    fetchHlCtx(['BTC', 'ETH']),
    fetchGeckoDerivOi(COINS),
    fetchMacroQuote('^TNX', '10y.us'),
    fetchMacroQuote('DX-Y.NYB', 'usd.i'),
    fetchFearGreed(),
    fetchFfEvents(localCal),
    whaleSnapshotFresh(),
  ]);
  const extras = { fearGreed, fed: emptyFed, whale };
  const coins = [];
  for (const coin of COINS) {
    coins.push(await fetchCoin(coin, hlCtx[coin.id] || {}, derivOi, extras));
  }
  return {
    coins,
    macro: {
      events: ffEvents,
      treasury10y,
      dxy,
      fed: {
        ...emptyFed,
        previous: LAST_FOMC,
      },
      fearGreed,
    },
    whale: {
      long: whale.long,
      short: whale.short,
      neutral: whale.neutral,
      netUsd: whale.netUsd,
    },
    updatedAt: Date.now(),
    source: 'Binance / Bybit / Hyperliquid / Gate',
  };
}

async function attachExtraCoins(payload, extraIds) {
  if (!extraIds.length) return { ...payload, stale: false };
  const coins = [...payload.coins];
  const pending = [];
  for (const id of extraIds) {
    if (coins.some((item) => item.id === id)) continue;
    const hit = extraCache.get(id);
    if (hit && Date.now() - hit.at < MARKET_TTL && hit.value?.price) {
      coins.push(hit.value);
    } else {
      pending.push(id);
    }
  }
  if (pending.length) {
    const specs = pending.map(coinSpec);
    const whale = whaleSnapshot();
    const [hlCtx, derivOi] = await Promise.all([fetchHlCtx(pending), fetchGeckoDerivOi(specs)]);
    const extras = { fearGreed: payload.macro.fearGreed, fed: payload.macro.fed, whale };
    for (const spec of specs) {
      const row = await fetchCoin(spec, hlCtx[spec.id] || {}, derivOi, extras);
      if (row.price) {
        extraCache.set(spec.id, { at: Date.now(), value: row });
        coins.push(row);
      }
    }
  }
  return { ...payload, coins, stale: false };
}

async function getMarkets(force = false, extraIds = []) {
  const extra = parseExtraIds(extraIds);
  const hasCore = Boolean(cache.value);
  const stale = !hasCore || Date.now() - cache.at >= MARKET_TTL;

  const rebuildCore = async () => {
    if (coreInflight) return coreInflight;
    coreInflight = buildCoreMarkets()
      .then((value) => {
        cache = { at: Date.now(), value };
        if (force) extraCache.clear();
        return value;
      })
      .finally(() => {
        coreInflight = null;
      });
    return coreInflight;
  };

  if (force) {
    await rebuildCore();
  } else if (!hasCore) {
    await rebuildCore();
  } else if (stale) {
    // 有旧数据时先返回，后台刷新，避免行情页卡住
    rebuildCore().catch((err) => {
      console.warn('[markets] 后台刷新失败:', err.message);
    });
  }

  return slimPayload(await attachExtraCoins(cache.value, extra));
}

module.exports = {
  getMarkets,
  getQuotes,
  getLiquidations,
  lookupCoin,
  fetchFedOdds,
  MAIN_COINS: COINS.map((item) => item.id),
};
