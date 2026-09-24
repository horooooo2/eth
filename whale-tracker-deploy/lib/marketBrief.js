/**
 * 组装单币「市场简报」上下文
 * - 技术面：1h / 1d K 线指标
 * - 新闻：站内新闻 + 网络检索（股权/公司类加大公司资讯）
 * - 情绪：巨鲸多空 + 交易所账户多空比 + 资金费率
 */
const axios = require('axios');
const { getQuotes, getLiquidations } = require('./markets');
const { getNews } = require('./newsService');
const { getCalendar } = require('./calendar');
const { getWhales } = require('./whales');
const { loadRecentAlerts } = require('./sqliteStore');
const { readCache, writeCache } = require('./cache');
const { resolveAsset } = require('./assetRegistry');
const { MODULE_TTL_MS, readModule, writeModule } = require('./briefModuleCache');
const { buildAnalysisCapability } = require('./analysisCapability');

const BRIEF_CTX_TTL_MS = 15 * 60 * 1000; // legacy fallback only

const VISION = 'https://data-api.binance.vision';
const BINANCE_FAPI = 'https://fapi.binance.com';
const BYTICK = 'https://api.bytick.com';
const BYBIT = 'https://api.bybit.com';
const OKX = 'https://www.okx.com';
const GATE = 'https://api.gateio.ws/api/v4';

const COIN_ALIASES = {
  BTC: ['BTC', '比特币', 'Bitcoin', 'BTCETF', '比特币ETF'],
  ETH: ['ETH', '以太坊', 'Ethereum', '以太坊ETF'],
  SOL: ['SOL', 'Solana', '索拉纳'],
  HYPE: ['HYPE', 'Hyperliquid'],
  BNB: ['BNB', '币安币', 'Binance Coin'],
  AVAX: ['AVAX', 'Avalanche'],
  SUI: ['SUI'],
  ARB: ['ARB', 'Arbitrum'],
  OP: ['OP', 'Optimism'],
  DOGE: ['DOGE', '狗狗币', 'Dogecoin'],
  XRP: ['XRP', '瑞波'],
  LINK: ['LINK', 'Chainlink'],
  UNI: ['UNI', 'Uniswap'],
  AAVE: ['AAVE'],
};

/** 传统金融 / 公司类标的：网络新闻用公司名检索 */
const EQUITY_META = {
  SNDK: { names: ['SNDK', 'SanDisk', '闪迪'], query: 'SanDisk OR SNDK 闪迪' },
  UNITREE: { names: ['Unitree', '宇树科技', '宇树'], query: 'Unitree Robotics OR 宇树科技' },
  TSLA: { names: ['Tesla', '特斯拉', 'TSLA'], query: 'Tesla OR 特斯拉 股票' },
  NVDA: { names: ['Nvidia', '英伟达', 'NVDA'], query: 'Nvidia OR 英伟达' },
  AAPL: { names: ['Apple', '苹果', 'AAPL'], query: 'Apple stock OR 苹果公司' },
  MSFT: { names: ['Microsoft', '微软', 'MSFT'], query: 'Microsoft stock OR 微软' },
  META: { names: ['Meta', 'Facebook', 'META'], query: 'Meta stock OR Facebook' },
  GOOGL: { names: ['Google', 'Alphabet', '谷歌'], query: 'Alphabet OR Google stock' },
  AMZN: { names: ['Amazon', '亚马逊', 'AMZN'], query: 'Amazon stock OR 亚马逊' },
  COIN: { names: ['Coinbase', 'COIN'], query: 'Coinbase stock' },
  MSTR: { names: ['MicroStrategy', 'Strategy', 'MSTR'], query: 'MicroStrategy OR Strategy bitcoin' },
};

const CRYPTO_CORE = new Set([
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'DOT', 'LINK',
  'UNI', 'AAVE', 'ATOM', 'NEAR', 'APT', 'SUI', 'ARB', 'OP', 'HYPE', 'TON',
  'TRX', 'LTC', 'BCH', 'FIL', 'INJ', 'SEI', 'PEPE', 'WIF', 'BONK',
]);

function normalizeCoin(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function aliasesFor(coin) {
  const asset = resolveAsset(coin);
  const id = asset.id;
  const extra = COIN_ALIASES[id] || EQUITY_META[id]?.names || asset.names || [];
  return [...new Set([id, ...extra.map(String)])];
}

function isEquityLike(coin) {
  return Boolean(resolveAsset(coin).equityLike);
}

function textHit(haystack, needles) {
  const text = String(haystack || '');
  if (!text) return false;
  const upper = text.toUpperCase();
  return needles.some((n) => {
    const s = String(n || '');
    if (!s) return false;
    if (/^[A-Z0-9]+$/i.test(s) && s.length <= 8) {
      return new RegExp(`(^|[^A-Z0-9])${s}([^A-Z0-9]|$)`, 'i').test(text);
    }
    return upper.includes(s.toUpperCase()) || text.includes(s);
  });
}

function clip(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function fundingPct(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const pct = Math.abs(n) < 0.01 ? n * 100 : n;
  return Number(pct.toFixed(4));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function httpGet(url, params, timeoutMs = 8000) {
  const { data, status } = await axios.get(url, {
    params,
    timeout: timeoutMs,
    headers: { Accept: 'application/json,text/xml,*/*', 'User-Agent': 'WhaleTracker/1.0' },
    validateStatus: (s) => s < 500,
  });
  return status === 200 ? data : null;
}

function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function mapKlines(rows) {
  if (!Array.isArray(rows) || !rows.length) return [];
  // Binance / Gate style: [t,o,h,l,c,v,...]
  if (Array.isArray(rows[0])) {
    return rows
      .map((row) => ({
        time: Number(row[0]),
        open: num(row[1]),
        high: num(row[2]),
        low: num(row[3]),
        close: num(row[4]),
        volume: num(row[5]),
      }))
      .filter((k) => k.time && k.close > 0)
      .sort((a, b) => a.time - b.time);
  }
  return [];
}

function mapBybitKlines(payload) {
  const list = payload?.result?.list;
  if (!Array.isArray(list)) return [];
  // Bybit returns newest first: [start, open, high, low, close, volume, turnover]
  return list
    .map((row) => ({
      time: Number(row[0]),
      open: num(row[1]),
      high: num(row[2]),
      low: num(row[3]),
      close: num(row[4]),
      volume: num(row[5]),
    }))
    .filter((k) => k.time && k.close > 0)
    .sort((a, b) => a.time - b.time);
}

function mapOkxKlines(payload) {
  const list = payload?.data;
  if (!Array.isArray(list)) return [];
  // OKX newest first: [ts,o,h,l,c,vol,volCcy,...]
  return list
    .map((row) => ({
      time: Number(row[0]),
      open: num(row[1]),
      high: num(row[2]),
      low: num(row[3]),
      close: num(row[4]),
      volume: num(row[5]),
    }))
    .filter((k) => k.time && k.close > 0)
    .sort((a, b) => a.time - b.time);
}

function sma(closes, period) {
  if (!closes.length || closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function emaSeries(values, period) {
  if (!values.length || values.length < period) return null;
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let e = 0;
  for (let i = 0; i < period; i += 1) e += values[i];
  e /= period;
  out[period - 1] = e;
  for (let i = period; i < values.length; i += 1) {
    e = values[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i += 1) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Number((100 - 100 / (1 + rs)).toFixed(2));
}

function macdSnapshot(closes) {
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  if (!ema12 || !ema26) return null;
  const dif = closes.map((_, i) =>
    ema12[i] != null && ema26[i] != null ? ema12[i] - ema26[i] : null,
  );
  const difVals = dif.filter((v) => v != null);
  if (difVals.length < 9) return null;
  // DEA on aligned dif series (skip nulls at start)
  const first = dif.findIndex((v) => v != null);
  const compact = dif.slice(first);
  const deaSeries = emaSeries(compact, 9);
  if (!deaSeries) return null;
  const last = compact.length - 1;
  const prev = compact.length - 2;
  const difNow = compact[last];
  const deaNow = deaSeries[last];
  const difPrev = compact[prev];
  const deaPrev = deaSeries[prev];
  if (difNow == null || deaNow == null) return null;
  const hist = difNow - deaNow;
  let cross = '无';
  if (difPrev != null && deaPrev != null) {
    if (difPrev <= deaPrev && difNow > deaNow) cross = '金叉';
    else if (difPrev >= deaPrev && difNow < deaNow) cross = '死叉';
  }
  return {
    dif: Number(difNow.toFixed(6)),
    dea: Number(deaNow.toFixed(6)),
    hist: Number(hist.toFixed(6)),
    cross,
  };
}

function bollSnapshot(closes, period = 20) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mid) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  const upper = mid + 2 * std;
  const lower = mid - 2 * std;
  const last = closes[closes.length - 1];
  let pos = '中轨附近';
  if (last >= upper) pos = '触及/突破上轨';
  else if (last <= lower) pos = '触及/跌破下轨';
  else if (last > mid) pos = '中轨上方';
  else pos = '中轨下方';
  return {
    mid: Number(mid.toFixed(6)),
    upper: Number(upper.toFixed(6)),
    lower: Number(lower.toFixed(6)),
    widthPct: mid ? Number((((upper - lower) / mid) * 100).toFixed(2)) : null,
    position: pos,
  };
}

function atrSnapshot(klines, period = 14) {
  if (klines.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < klines.length; i += 1) {
    const cur = klines[i];
    const prev = klines[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    );
    trs.push(tr);
  }
  if (trs.length < period) return null;
  const atr = trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  const last = klines[klines.length - 1].close;
  return {
    atr: Number(atr.toFixed(6)),
    atrPct: last ? Number(((atr / last) * 100).toFixed(2)) : null,
  };
}

function summarizeTf(klines, label) {
  if (!klines.length) return null;
  const closes = klines.map((k) => k.close).filter((c) => c > 0);
  if (closes.length < 5) return null;
  const vols = klines.map((k) => k.volume || 0);
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2] || last;
  const agoN = closes[Math.max(0, closes.length - 25)] || closes[0];
  const change1 = prev ? ((last - prev) / prev) * 100 : 0;
  const changeN = agoN ? ((last - agoN) / agoN) * 100 : 0;
  const hi = Math.max(...klines.slice(-24).map((k) => k.high));
  const lo = Math.min(...klines.slice(-24).map((k) => k.low));
  const ma7 = sma(closes, 7);
  const ma25 = sma(closes, Math.min(25, closes.length));
  const r = rsi(closes, 14);
  const volMa5 = sma(vols, Math.min(5, vols.length));
  const lastVol = vols[vols.length - 1] || 0;
  const volRatio = volMa5 ? Number((lastVol / volMa5).toFixed(2)) : null;
  let volNote = '量能中性';
  if (volRatio != null) {
    if (volRatio >= 1.8 && change1 > 0) volNote = '放量上涨';
    else if (volRatio >= 1.8 && change1 < 0) volNote = '放量下跌';
    else if (volRatio <= 0.7 && change1 < 0) volNote = '缩量阴跌';
    else if (volRatio <= 0.7 && change1 > 0) volNote = '缩量上涨';
    else if (volRatio >= 1.5) volNote = '放量';
    else if (volRatio <= 0.7) volNote = '缩量';
  }
  let structure = '震荡';
  if (ma7 != null && ma25 != null) {
    if (last > ma7 && ma7 > ma25 && changeN > 0) structure = '偏多';
    else if (last < ma7 && ma7 < ma25 && changeN < 0) structure = '偏空';
  }
  if (r != null) {
    if (r >= 70) structure = `${structure}/超买`;
    else if (r <= 30) structure = `${structure}/超卖`;
  }
  return {
    tf: label,
    bars: klines.length,
    last,
    change1Pct: Number(change1.toFixed(2)),
    changeRecentPct: Number(changeN.toFixed(2)),
    high: hi,
    low: lo,
    ma7: ma7 != null ? Number(ma7.toFixed(6)) : null,
    ma25: ma25 != null ? Number(ma25.toFixed(6)) : null,
    rsi14: r,
    macd: macdSnapshot(closes),
    boll: bollSnapshot(closes, 20),
    atr: atrSnapshot(klines, 14),
    volRatio,
    volNote,
    structure,
  };
}

function roundPx(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1000) return Number(n.toFixed(2));
  if (n >= 1) return Number(n.toFixed(4));
  if (n >= 0.01) return Number(n.toFixed(6));
  return Number(n.toFixed(8));
}

/** 供前端绘制的 K 线 + 技术位（服务端计算，模型勿改价） */
function buildChartPack(klines, maxBars = 48) {
  if (!Array.isArray(klines) || klines.length < 5) return null;
  const slice = klines.slice(-maxBars);
  const candles = slice
    .map((k) => ({
      t: k.time,
      o: roundPx(k.open),
      h: roundPx(k.high),
      l: roundPx(k.low),
      c: roundPx(k.close),
    }))
    .filter((k) => k.t && k.c != null);

  if (candles.length < 5) return null;

  const recent = slice.slice(-Math.min(36, slice.length));
  const highs = recent.map((k) => k.high);
  const lows = recent.map((k) => k.low);
  const lastClose = slice[slice.length - 1].close;
  let swingHigh = null;
  let swingLow = null;
  for (let i = 2; i < recent.length - 2; i += 1) {
    if (
      highs[i] >= highs[i - 1] &&
      highs[i] >= highs[i - 2] &&
      highs[i] >= highs[i + 1] &&
      highs[i] >= highs[i + 2]
    ) {
      swingHigh = highs[i];
    }
    if (
      lows[i] <= lows[i - 1] &&
      lows[i] <= lows[i - 2] &&
      lows[i] <= lows[i + 1] &&
      lows[i] <= lows[i + 2]
    ) {
      swingLow = lows[i];
    }
  }
  const prior = recent.slice(0, -1);
  const rangeHigh = prior.length ? Math.max(...prior.map((k) => k.high)) : null;
  const rangeLow = prior.length ? Math.min(...prior.map((k) => k.low)) : null;

  const levels = [];
  const pushLevel = (key, price, label) => {
    const p = roundPx(price);
    if (p == null) return;
    if (levels.some((x) => Math.abs(x.price - p) / p < 0.0015)) return;
    levels.push({ key, price: p, label });
  };

  if (swingHigh != null) pushLevel('resistance', swingHigh, '压力位');
  if (swingLow != null) pushLevel('support', swingLow, '支撑位');
  if (swingLow != null) pushLevel('swingLow', swingLow, '短期底部');
  if (rangeHigh != null && lastClose >= rangeHigh * 0.998) {
    pushLevel('breakout', rangeHigh, '突破位');
  } else if (rangeLow != null && lastClose <= rangeLow * 1.002) {
    pushLevel('breakdown', rangeLow, '跌破位');
  } else if (rangeHigh != null) {
    pushLevel('breakout', rangeHigh, '突破观察位');
  }

  return { candles, levels: levels.slice(0, 6) };
}

function attachChart(summary, klines) {
  if (!summary) return null;
  const maxBars = summary.tf === '5m' ? 60 : summary.tf === '1h' ? 48 : 60;
  return {
    ...summary,
    chart: buildChartPack(klines, maxBars),
  };
}

function klineSourceList(coin, tf) {
  const symbol = `${coin}USDT`;
  const gateContract = `${coin}_USDT`;
  const t = 4500;
  if (tf === '5m') {
    return [
      {
        name: 'binance-fapi',
        run: async () =>
          mapKlines(await httpGet(`${BINANCE_FAPI}/fapi/v1/klines`, { symbol, interval: '5m', limit: 96 }, t)),
      },
      {
        name: 'bybit',
        run: async () =>
          mapBybitKlines(
            await httpGet(
              `${BYBIT}/v5/market/kline`,
              { category: 'linear', symbol, interval: '5', limit: 96 },
              t,
            ),
          ),
      },
      {
        name: 'binance-spot',
        run: async () =>
          mapKlines(await httpGet(`${VISION}/api/v3/klines`, { symbol, interval: '5m', limit: 96 }, t)),
      },
      {
        name: 'okx',
        run: async () =>
          mapOkxKlines(
            await httpGet(
              `${OKX}/api/v5/market/candles`,
              { instId: `${coin}-USDT`, bar: '5m', limit: '96' },
              t,
            ),
          ),
      },
      {
        name: 'gate',
        run: async () =>
          mapKlines(
            await httpGet(
              `${GATE}/futures/usdt/candlesticks`,
              { contract: gateContract, interval: '5m', limit: 96 },
              t,
            ),
          ),
      },
    ];
  }
  if (tf === '1h') {
    return [
      {
        name: 'binance-fapi',
        run: async () =>
          mapKlines(await httpGet(`${BINANCE_FAPI}/fapi/v1/klines`, { symbol, interval: '1h', limit: 72 }, t)),
      },
      {
        name: 'bybit',
        run: async () =>
          mapBybitKlines(
            await httpGet(
              `${BYBIT}/v5/market/kline`,
              { category: 'linear', symbol, interval: '60', limit: 72 },
              t,
            ),
          ),
      },
      {
        name: 'binance-spot',
        run: async () =>
          mapKlines(await httpGet(`${VISION}/api/v3/klines`, { symbol, interval: '1h', limit: 72 }, t)),
      },
      {
        name: 'okx',
        run: async () =>
          mapOkxKlines(
            await httpGet(
              `${OKX}/api/v5/market/candles`,
              { instId: `${coin}-USDT`, bar: '1H', limit: '72' },
              t,
            ),
          ),
      },
      {
        name: 'gate',
        run: async () =>
          mapKlines(
            await httpGet(
              `${GATE}/futures/usdt/candlesticks`,
              { contract: gateContract, interval: '1h', limit: 72 },
              t,
            ),
          ),
      },
    ];
  }
  return [
    {
      name: 'binance-fapi',
      run: async () =>
        mapKlines(await httpGet(`${BINANCE_FAPI}/fapi/v1/klines`, { symbol, interval: '1d', limit: 90 }, t)),
    },
    {
      name: 'bybit',
      run: async () =>
        mapBybitKlines(
          await httpGet(
            `${BYBIT}/v5/market/kline`,
            { category: 'linear', symbol, interval: 'D', limit: 90 },
            t,
          ),
        ),
    },
    {
      name: 'binance-spot',
      run: async () =>
        mapKlines(await httpGet(`${VISION}/api/v3/klines`, { symbol, interval: '1d', limit: 90 }, t)),
    },
    {
      name: 'okx',
      run: async () =>
        mapOkxKlines(
          await httpGet(
            `${OKX}/api/v5/market/candles`,
            { instId: `${coin}-USDT`, bar: '1D', limit: '90' },
            t,
          ),
        ),
    },
    {
      name: 'gate',
      run: async () =>
        mapKlines(
          await httpGet(
            `${GATE}/futures/usdt/candlesticks`,
            { contract: gateContract, interval: '1d', limit: 90 },
            t,
          ),
        ),
    },
  ];
}

async function fetchKlinesMulti(coin, tf) {
  const sources = klineSourceList(coin, tf);

  // 先并行打前两个常用源，命中即返回
  const primary = sources.slice(0, 2);
  const primaryHits = await Promise.all(
    primary.map(async (src) => {
      try {
        const rows = await src.run();
        if (rows.length >= 5) return { klines: rows, source: src.name };
      } catch (_) {
        /* next */
      }
      return null;
    }),
  );
  const firstHit = primaryHits.find(Boolean);
  if (firstHit) return firstHit;

  for (const src of sources.slice(2)) {
    try {
      const rows = await src.run();
      if (rows.length >= 5) return { klines: rows, source: src.name };
    } catch (_) {
      /* try next */
    }
  }
  return { klines: [], source: null };
}

function pctShare(longShare) {
  if (longShare == null || !Number.isFinite(Number(longShare))) return null;
  const n = Number(longShare);
  const pct = n > 0 && n <= 1 ? n * 100 : n;
  return Number(pct.toFixed(2));
}

async function fetchExternalCrowd(coin) {
  const symbol = `${coin}USDT`;
  const gateContract = `${coin}_USDT`;
  const out = {
    binanceGlobal: null,
    binanceTopAccount: null,
    binanceTopPosition: null,
    binanceTaker: null,
    bybitAccount: null,
    gateTop: null,
    onchainWhales: [],
  };

  const tasks = [
    httpGet(`${BINANCE_FAPI}/futures/data/globalLongShortAccountRatio`, {
      symbol,
      period: '1h',
      limit: 1,
    }).then((data) => {
      const row = Array.isArray(data) ? data[0] : null;
      if (!row) return;
      out.binanceGlobal = {
        longPct: pctShare(row.longAccount),
        shortPct: pctShare(row.shortAccount),
        ratio: num(row.longShortRatio) || null,
      };
    }),
    httpGet(`${BINANCE_FAPI}/futures/data/topLongShortAccountRatio`, {
      symbol,
      period: '1h',
      limit: 1,
    }).then((data) => {
      const row = Array.isArray(data) ? data[0] : null;
      if (!row) return;
      out.binanceTopAccount = {
        longPct: pctShare(row.longAccount),
        shortPct: pctShare(row.shortAccount),
        ratio: num(row.longShortRatio) || null,
      };
    }),
    httpGet(`${BINANCE_FAPI}/futures/data/topLongShortPositionRatio`, {
      symbol,
      period: '1h',
      limit: 1,
    }).then((data) => {
      const row = Array.isArray(data) ? data[0] : null;
      if (!row) return;
      out.binanceTopPosition = {
        longPct: pctShare(row.longAccount),
        shortPct: pctShare(row.shortAccount),
        ratio: num(row.longShortRatio) || null,
      };
    }),
    httpGet(`${BINANCE_FAPI}/futures/data/takerlongshortRatio`, {
      symbol,
      period: '1h',
      limit: 1,
    }).then((data) => {
      const row = Array.isArray(data) ? data[0] : null;
      if (!row) return;
      out.binanceTaker = {
        buySellRatio: num(row.buySellRatio) || null,
        buyVol: num(row.buyVol) || null,
        sellVol: num(row.sellVol) || null,
      };
    }),
    httpGet(`${BYBIT}/v5/market/account-ratio`, {
      category: 'linear',
      symbol,
      period: '1h',
      limit: 1,
    }).then((data) => {
      const row = data?.result?.list?.[0];
      if (!row) return;
      const longPct = pctShare(row.buyRatio);
      const shortPct = pctShare(row.sellRatio) ?? (longPct != null ? Number((100 - longPct).toFixed(2)) : null);
      out.bybitAccount = { longPct, shortPct };
    }),
    httpGet(`${GATE}/futures/usdt/contract_stats`, {
      contract: gateContract,
      interval: '1h',
      limit: 1,
    }).then((data) => {
      const row = Array.isArray(data) ? data[0] : null;
      if (!row) return;
      const longSize = num(row.top_long_size);
      const shortSize = num(row.top_short_size);
      const total = longSize + shortSize;
      out.gateTop = {
        longPct: total ? Number(((longSize / total) * 100).toFixed(2)) : null,
        shortPct: total ? Number(((shortSize / total) * 100).toFixed(2)) : null,
        ratio: num(row.top_lsr_size) || null,
        accountRatio: num(row.lsr_account) || null,
      };
    }),
  ];

  await Promise.all(tasks.map((p) => p.catch(() => null)));

  try {
    const { fetchWhaleAlerts } = require('./onchain');
    const payload = await withTimeout(fetchWhaleAlerts(100000, 80), 6000, null);
    const needles = aliasesFor(coin);
    out.onchainWhales = (payload?.alerts || [])
      .filter((a) => textHit(`${a.asset || ''} ${a.blockchain || ''}`, needles))
      .slice(0, 8)
      .map((a) => ({
        asset: a.asset || coin,
        usd: Math.round(a.amountUsd || 0),
        flow: a.flowDirection || '',
        from: clip(a.fromLabel || a.from || '', 28),
        to: clip(a.toLabel || a.to || '', 28),
        time: a.time || null,
      }));
  } catch (_) {
    out.onchainWhales = [];
  }

  return out;
}

async function fetchTechSnapshot(coin) {
  const symbol = `${coin}USDT`;
  try {
    const [m5Pack, hourPack, dayPack, tickerRaw, crowd] = await Promise.all([
      fetchKlinesMulti(coin, '5m'),
      fetchKlinesMulti(coin, '1h'),
      fetchKlinesMulti(coin, '1d'),
      httpGet(`${BYBIT}/v5/market/tickers`, { category: 'linear', symbol }).catch(() => null),
      fetchExternalCrowd(coin),
    ]);
    const m5 = attachChart(summarizeTf(m5Pack.klines, '5m'), m5Pack.klines);
    const hour = attachChart(summarizeTf(hourPack.klines, '1h'), hourPack.klines);
    const day = attachChart(summarizeTf(dayPack.klines, '1d'), dayPack.klines);
    if (m5) m5.source = m5Pack.source;
    if (hour) hour.source = hourPack.source;
    if (day) day.source = dayPack.source;
    const tick = tickerRaw?.result?.list?.[0];
    const exchangeLong =
      crowd.bybitAccount?.longPct ??
      crowd.binanceGlobal?.longPct ??
      crowd.binanceTopAccount?.longPct ??
      null;
    const exchangeShort =
      crowd.bybitAccount?.shortPct ??
      crowd.binanceGlobal?.shortPct ??
      crowd.binanceTopAccount?.shortPct ??
      null;
    return {
      available: Boolean(m5 || hour || day),
      symbol,
      m5,
      hour,
      day,
      klineSources: { m5: m5Pack.source, hour: hourPack.source, day: dayPack.source },
      exchangeSentiment: {
        longAccountPct: exchangeLong,
        shortAccountPct: exchangeShort,
        fundingPct: tick ? fundingPct(tick.fundingRate) : null,
        oiUsd: tick ? Math.round(num(tick.openInterestValue)) : null,
        change24hPct: tick ? Number((num(tick.price24hPcnt) * 100).toFixed(2)) : null,
      },
      externalCrowd: crowd,
    };
  } catch (e) {
    return { available: false, symbol: `${coin}USDT`, error: e.message || String(e) };
  }
}

function decodeXml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function fetchGoogleNews(query, limit = 8) {
  const q = String(query || '').trim();
  if (!q) return [];
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
  try {
    const { data, status } = await axios.get(url, {
      timeout: 12000,
      responseType: 'text',
      headers: { 'User-Agent': 'WhaleTracker/1.0', Accept: 'application/rss+xml,text/xml,*/*' },
      validateStatus: (s) => s < 500,
    });
    if (status !== 200 || typeof data !== 'string') return [];
    const items = [];
    const re = /<item>([\s\S]*?)<\/item>/gi;
    let m;
    while ((m = re.exec(data)) && items.length < limit) {
      const block = m[1];
      const title = decodeXml((block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '');
      const link = decodeXml((block.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || '');
      const pubDate = decodeXml((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1] || '');
      const source = decodeXml((block.match(/<source[^>]*>([\s\S]*?)<\/source>/i) || [])[1] || '');
      if (title) {
        items.push({
          title: clip(title, 120),
          summary: clip(title, 80),
          link,
          pubDate,
          source: clip(source, 40),
        });
      }
    }
    return items;
  } catch {
    return [];
  }
}

async function fetchWebNewsBundle(coin) {
  const asset = resolveAsset(coin);
  const id = asset.id;
  const equity = Boolean(asset.equityLike);
  const names = (asset.names || aliasesFor(id)).slice(0, 3);
  const nameOr = names.join(' OR ');
  const queries = [];
  let status = 'ok';
  if (equity) {
    queries.push(
      asset.newsQuery ||
        EQUITY_META[id]?.query ||
        `(${nameOr}) (业绩预告 OR 减持 OR 问询函 OR 解禁 OR 回购 OR 停牌 OR 财报 OR 利好 OR 利空)`,
    );
    queries.push(`(${nameOr}) (最新消息 OR 公司公告)`);
  } else {
    queries.push(`${id} crypto OR 加密货币`);
    queries.push(`${names.slice(0, 2).join(' OR ')} 行情`);
  }
  const seen = new Set();
  const out = [];
  let fetched = 0;
  for (const q of queries) {
    const rows = await fetchGoogleNews(q, 6);
    if (rows.length) fetched += 1;
    for (const row of rows) {
      const key = row.title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        title: clip(row.title, 120),
        summary: clip(row.summary || '', 80),
        link: row.link,
        pubDate: row.pubDate,
        source: clip(row.source, 40),
      });
      if (out.length >= 10) break;
    }
    if (out.length >= 10) break;
  }
  if (!fetched) status = 'unavailable';
  return { equityLike: equity || Boolean(meta), query: queries[0], items: out, status };
}

async function fetchBenchmarks(coin, equityLike) {
  const out = { status: 'ok', btc24hPct: null, dxyNote: null, equityIndex: null, usdcny: null };
  try {
    if (!equityLike && coin !== 'BTC') {
      const btcDay = await fetchKlinesMulti('BTC', '1d');
      const closes = btcDay.klines.map((k) => k.close);
      if (closes.length >= 2) {
        const a = closes[closes.length - 2];
        const b = closes[closes.length - 1];
        out.btc24hPct = a ? Number((((b - a) / a) * 100).toFixed(2)) : null;
      }
    } else if (coin === 'BTC') {
      const btcDay = await fetchKlinesMulti('BTC', '1d');
      const closes = btcDay.klines.map((k) => k.close);
      if (closes.length >= 2) {
        const a = closes[closes.length - 2];
        const b = closes[closes.length - 1];
        out.btc24hPct = a ? Number((((b - a) / a) * 100).toFixed(2)) : null;
      }
    }
  } catch (_) {
    /* ignore */
  }

  // Yahoo chart: 轻量指数/汇率（失败则 unavailable 字段保留）
  async function yahooChange(symbol) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
      const data = await httpGet(url, { interval: '1d', range: '5d' });
      const meta = data?.chart?.result?.[0]?.meta;
      const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
      const last = Number(meta?.regularMarketPrice);
      const prev =
        Number(meta?.chartPreviousClose) ||
        (closes.length >= 2 ? Number(closes[closes.length - 2]) : NaN);
      if (!Number.isFinite(last) || !Number.isFinite(prev) || !prev) return null;
      return {
        symbol,
        last,
        changePct: Number((((last - prev) / prev) * 100).toFixed(2)),
      };
    } catch {
      return null;
    }
  }

  try {
    if (equityLike) {
      const [sh, star, cny] = await Promise.all([
        yahooChange('000001.SS'),
        yahooChange('000688.SS'),
        yahooChange('CNY=X'),
      ]);
      out.equityIndex = {
        shanghai: sh,
        star50: star,
      };
      out.usdcny = cny;
      if (!sh && !star && !cny) out.status = 'partial';
    } else {
      const [dxy, ndx] = await Promise.all([yahooChange('DX-Y.NYB'), yahooChange('^NDX')]);
      out.dxyNote = dxy;
      out.ndxNote = ndx;
      if (!dxy && !ndx && out.btc24hPct == null) out.status = 'partial';
    }
  } catch (_) {
    out.status = 'unavailable';
  }
  return out;
}

async function buildMarketBriefContext(coinInput, opts = {}) {
  const forceRefresh = Boolean(opts.forceRefresh);
  const asset = resolveAsset(coinInput);
  const coin = asset.id || normalizeCoin(coinInput) || 'BTC';
  const needles = [...new Set([...(asset.names || []), ...aliasesFor(coin)])];
  const equityGuess = Boolean(asset.equityLike);
  const statusMeta = {};

  async function loadOrFetch(module, ttl, fetcher, softForce) {
    const must = forceRefresh && softForce;
    if (!must) {
      const hit = readModule(coin, module, ttl);
      if (hit) {
        statusMeta[module] = { fetchedAt: hit.fetchedAt, status: hit.status, cached: true };
        const data = hit.data && typeof hit.data === 'object' ? { ...hit.data } : { value: hit.data };
        return { ...data, _status: hit.status, _fetchedAt: hit.fetchedAt };
      }
    }
    const raw = await fetcher();
    const st = raw?._status || 'ok';
    const data = { ...raw };
    delete data._status;
    writeModule(coin, module, data, st);
    statusMeta[module] = { fetchedAt: Date.now(), status: st, cached: false };
    return { ...data, _status: st, _fetchedAt: Date.now() };
  }

  const priceMod = await loadOrFetch(
    'price',
    MODULE_TTL_MS.price,
    async () => {
      const quotes = await withTimeout(getQuotes([coin]).catch(() => ({})), 8000, {});
      const price = Number(quotes?.[coin]);
      const funding = fundingPct(quotes?.funding?.[coin]);
      const ok = Number.isFinite(price) && price > 0;
      return { price: ok ? price : null, fundingPct: funding, _status: ok ? 'ok' : 'unavailable' };
    },
    true,
  );

  const techMod = await loadOrFetch(
    'technical',
    MODULE_TTL_MS.technical,
    async () => {
      const tech = await withTimeout(fetchTechSnapshot(coin), 16000, {
        available: false,
        symbol: `${coin}USDT`,
      });
      return { ...tech, _status: tech?.available ? 'ok' : 'unavailable' };
    },
    true,
  );

  const [derivMod, whalesMod, newsMod, macroMod, tvlMod, benchmarks] = await Promise.all([
    loadOrFetch(
      'derivatives',
      MODULE_TTL_MS.derivatives,
      async () => {
        const liq = await withTimeout(getLiquidations(coin, 24).catch(() => null), 10000, null);
        const liqStatus = liq && Number(liq.totalUsd) > 0 ? 'ok' : liq ? 'empty' : 'unavailable';
        const crowd = techMod?.externalCrowd || {};
        const hasTaker = Boolean(crowd.binanceTaker);
        const funding = techMod?.exchangeSentiment?.fundingPct ?? priceMod.fundingPct ?? null;
        const status =
          liqStatus === 'ok' || hasTaker || funding != null
            ? liqStatus === 'unavailable' && !hasTaker && funding == null
              ? 'unavailable'
              : liqStatus === 'unavailable'
                ? 'ok'
                : liqStatus
            : 'unavailable';
        return {
          liquidations: liq
            ? {
                longUsd: Math.round(liq.longUsd || 0),
                shortUsd: Math.round(liq.shortUsd || 0),
                totalUsd: Math.round(liq.totalUsd || 0),
                count: liq.count || 0,
                source: liq.source || '',
                longSharePct:
                  liq.totalUsd > 0 ? Number(((liq.longUsd / liq.totalUsd) * 100).toFixed(1)) : null,
                shortSharePct:
                  liq.totalUsd > 0 ? Number(((liq.shortUsd / liq.totalUsd) * 100).toFixed(1)) : null,
              }
            : null,
          taker: crowd.binanceTaker || null,
          fundingPct: funding,
          _status: status,
        };
      },
      true,
    ),
    loadOrFetch(
      'whales',
      MODULE_TTL_MS.whales,
      async () => {
        const [whalesPayload, alerts] = await Promise.all([
          withTimeout(getWhales(false).catch(() => ({ whales: [] })), 10000, { whales: [] }),
          withTimeout(Promise.resolve().then(() => loadRecentAlerts(200)).catch(() => []), 5000, []),
        ]);
        const whales = Array.isArray(whalesPayload?.whales) ? whalesPayload.whales : [];
        let longCount = 0;
        let shortCount = 0;
        let longUsd = 0;
        let shortUsd = 0;
        const topPositions = [];
        for (const w of whales) {
          for (const p of Array.isArray(w.positions) ? w.positions : []) {
            const pCoin = normalizeCoin(p.coin || p.coinLabel || '');
            if (pCoin !== coin && !needles.includes(pCoin)) continue;
            const side = String(p.side || '').toLowerCase() === 'short' ? 'short' : 'long';
            const usd = Math.abs(Number(p.positionValueUsd ?? p.usd ?? p.sizeUsd) || 0);
            if (side === 'short') {
              shortCount += 1;
              shortUsd += usd;
            } else {
              longCount += 1;
              longUsd += usd;
            }
            topPositions.push({
              whale: clip(w.name || w.id || '', 24),
              side,
              usd: Math.round(usd),
              leverage: p.leverage || p.leverageLabel || null,
              entryPx: p.entryPx || p.entryPrice || null,
              pnlPct: p.pnlPct ?? p.unrealizedPnlPct ?? null,
            });
          }
        }
        topPositions.sort((a, b) => b.usd - a.usd);
        const coinAlerts = (Array.isArray(alerts) ? alerts : [])
          .filter((a) => {
            const itemCoin = normalizeCoin(a.items?.[0]?.coin || a.coin || '');
            return itemCoin === coin || textHit(`${a.headline || ''} ${a.kindLabel || ''}`, needles);
          })
          .slice(0, 8)
          .map((a) => ({
            headline: clip(a.headline || a.kindLabel || a.kind || '', 100),
            kind: a.kind || '',
            at: a.at || a.time || null,
            whale: clip(a.whaleName || a.whaleId || '', 24),
            usd: Math.round(Math.abs(Number(a.items?.[0]?.usd) || 0)),
          }));
        const crowd = techMod?.externalCrowd || {};
        const hasExternal =
          Boolean(crowd.binanceTopAccount || crowd.bybitAccount) ||
          (crowd.onchainWhales || []).length > 0;
        const empty = longCount === 0 && shortCount === 0 && !hasExternal;
        return {
          longCount,
          shortCount,
          longUsd: Math.round(longUsd),
          shortUsd: Math.round(shortUsd),
          topPositions: topPositions.slice(0, 8),
          alerts: coinAlerts,
          _status: empty ? 'empty' : 'ok',
        };
      },
      true,
    ),
    loadOrFetch(
      'news',
      MODULE_TTL_MS.news,
      async () => {
        const [news, webNews] = await Promise.all([
          withTimeout(getNews(false).catch(() => ({ articles: [] })), 8000, { articles: [] }),
          withTimeout(fetchWebNewsBundle(coin), 12000, {
            equityLike: equityGuess,
            query: '',
            items: [],
            status: 'unavailable',
          }),
        ]);
        const articles = Array.isArray(news?.articles) ? news.articles : [];
        const relatedNews = articles
          .filter((a) => {
            const blob = `${a.title || ''} ${a.summary || ''} ${(a.matchedKeywords || []).join(' ')}`;
            return textHit(blob, needles);
          })
          .slice(0, 8)
          .map((a) => ({
            title: clip(a.title, 120),
            summary: clip(a.summary, 180),
            source: a.source || a.site || '',
            time: a.publishedAt || a.time || a.createdAt || null,
          }));
        const fallbackNews =
          relatedNews.length >= 3
            ? []
            : articles.slice(0, 5).map((a) => ({
                title: clip(a.title, 120),
                summary: clip(a.summary, 180),
                source: a.source || a.site || '',
                time: a.publishedAt || a.time || a.createdAt || null,
              }));
        const list = relatedNews.length ? relatedNews : fallbackNews;
        const st =
          webNews?.status === 'unavailable' && !list.length
            ? 'unavailable'
            : list.length || webNews?.items?.length
              ? 'ok'
              : 'empty';
        return {
          news: list,
          newsMode: relatedNews.length ? 'coin-matched' : 'latest-fallback',
          webNews: webNews?.items || [],
          webNewsQuery: webNews?.query || '',
          _status: st,
        };
      },
      false,
    ),
    loadOrFetch(
      'macro',
      MODULE_TTL_MS.macro,
      async () => {
        const calendar = await withTimeout(
          getCalendar(forceRefresh).catch(() => ({ events: [] })),
          12000,
          { events: [] },
        );
        const events = Array.isArray(calendar?.events) ? calendar.events : [];
        const macro = events
          .filter((e) => {
            const d = Number(e.daysUntil);
            if (!Number.isFinite(d) || d < -2 || d > 7) return false;
            return e.importance === 'high' || e.importance === 'mid';
          })
          .slice(0, 8)
          .map((e) => ({
            title: clip(e.title, 100),
            dateLabel: e.dateLabel || e.date || '',
            time: e.time || e.timeNote || '',
            daysUntil: e.daysUntil,
            importance: e.importance,
            note: clip(e.note, 160),
            previous: e.previous || '',
            forecast: e.forecast || '',
            actual: e.actual || '',
            released: Number(e.daysUntil) < 0 || (Number(e.daysUntil) === 0 && Boolean(e.actual)),
          }));
        return { macro, _status: macro.length ? 'ok' : 'empty' };
      },
      true,
    ),
    loadOrFetch(
      'tvl',
      MODULE_TTL_MS.tvl,
      async () => {
        let defi = null;
        try {
          const defillama = require('./defillamaMacro');
          const snap = await withTimeout(defillama.getSnapshot(coin), 8000, null);
          const row = (snap?.coins || []).find((c) => normalizeCoin(c.coin) === coin);
          if (row && !row.unsupported) {
            defi = {
              chain: row.chain,
              chainTvl: row.chainTvl,
              tvlChange1dPct: row.tvlChange1dPct,
              dexVolume24h: row.dexVolume24h,
              protocols: (row.protocols || []).slice(0, 5).map((p) => ({
                name: p.name,
                tvl: p.tvl,
                change1dPct: p.change1dPct,
                category: p.category,
              })),
            };
          }
        } catch (_) {
          defi = null;
        }
        return { defi, _status: defi ? 'ok' : 'empty' };
      },
      false,
    ),
    withTimeout(fetchBenchmarks(coin, equityGuess), 10000, {
      status: 'unavailable',
      btc24hPct: null,
      dxyNote: null,
      equityIndex: null,
      usdcny: null,
    }),
  ]);

  const tech = techMod;
  const crowd = tech?.externalCrowd || {};
  const liquidations = derivMod?.liquidations || null;
  const funding = derivMod?.fundingPct ?? tech?.exchangeSentiment?.fundingPct ?? priceMod.fundingPct ?? null;

  const longCount = whalesMod.longCount || 0;
  const shortCount = whalesMod.shortCount || 0;
  const longUsd = whalesMod.longUsd || 0;
  const shortUsd = whalesMod.shortUsd || 0;
  const totalWhaleUsd = longUsd + shortUsd;

  const sentiment = {
    whaleLongCount: longCount,
    whaleShortCount: shortCount,
    whaleLongUsd: longUsd,
    whaleShortUsd: shortUsd,
    whaleLongSharePct: totalWhaleUsd ? Number(((longUsd / totalWhaleUsd) * 100).toFixed(1)) : null,
    whaleShortSharePct: totalWhaleUsd ? Number(((shortUsd / totalWhaleUsd) * 100).toFixed(1)) : null,
    exchangeLongAccountPct: tech?.exchangeSentiment?.longAccountPct ?? null,
    exchangeShortAccountPct: tech?.exchangeSentiment?.shortAccountPct ?? null,
    fundingPct: funding,
    oiUsd: tech?.exchangeSentiment?.oiUsd ?? null,
    change24hPct: tech?.exchangeSentiment?.change24hPct ?? null,
    liquidations,
    external: {
      binanceGlobal: crowd.binanceGlobal || null,
      binanceTopAccount: crowd.binanceTopAccount || null,
      binanceTopPosition: crowd.binanceTopPosition || null,
      binanceTaker: crowd.binanceTaker || derivMod?.taker || null,
      bybitAccount: crowd.bybitAccount || null,
      gateTop: crowd.gateTop || null,
      onchainWhales: crowd.onchainWhales || [],
    },
  };

  const marketSensitivity = computeMarketSensitivity(tech, benchmarks);
  const status = {
    tech_klines: statusMeta.technical?.status || (tech?.available ? 'ok' : 'unavailable'),
    market_sentiment:
      sentiment.exchangeLongAccountPct != null || crowd.binanceTopAccount || crowd.bybitAccount
        ? 'ok'
        : 'unavailable',
    liquidations: liquidations?.totalUsd > 0 ? 'ok' : liquidations ? 'empty' : 'unavailable',
    web_news: statusMeta.news?.status || 'unavailable',
    site_whales: longCount + shortCount > 0 ? 'ok' : 'empty',
    benchmarks: benchmarks?.status || 'unavailable',
    market_sensitivity: marketSensitivity?.status || 'unavailable',
  };

  const price =
    Number.isFinite(priceMod.price) && priceMod.price > 0
      ? priceMod.price
      : tech?.hour?.last || tech?.day?.last || null;

  const payload = {
    coin,
    asset,
    asOf: Date.now(),
    equityLike: equityGuess,
    forceRefresh,
    status,
    statusMeta,
    market: { price, fundingPct: funding },
    tech: {
      available: Boolean(tech?.available),
      m5: tech?.m5 || null,
      hour: tech?.hour || null,
      day: tech?.day || null,
      sources: tech?.klineSources || null,
    },
    benchmarks: benchmarks || null,
    marketSensitivity,
    news: newsMod.news || [],
    newsMode: newsMod.newsMode || 'latest-fallback',
    webNews: newsMod.webNews || [],
    webNewsQuery: newsMod.webNewsQuery || '',
    macro: macroMod.macro || [],
    whales: {
      longCount,
      shortCount,
      longUsd,
      shortUsd,
      topPositions: whalesMod.topPositions || [],
    },
    sentiment,
    alerts: whalesMod.alerts || [],
    defi: tvlMod.defi || null,
    sources: [
      'quotes',
      'tech-klines',
      'liquidations',
      'news',
      'web-news',
      'calendar',
      'whales',
      'external-crowd',
      'benchmarks',
      'sentiment',
      'alerts',
      tvlMod.defi ? 'defillama' : null,
    ].filter(Boolean),
  };
  payload.capability = buildAnalysisCapability(payload);
  return payload;
}

function computeMarketSensitivity(tech, benchmarks) {
  try {
    if (!tech?.day || tech.day.bars < 20) {
      return { status: 'unavailable', beta7d: null, beta30d: null, corr7d: null, corr30d: null, r2: null };
    }
    return {
      status: 'unavailable',
      beta7d: null,
      beta30d: null,
      corr7d: null,
      corr30d: null,
      r2: null,
      note: '需要完整收益序列后启用；当前仅有摘要指标',
    };
  } catch {
    return { status: 'unavailable', beta7d: null, beta30d: null, corr7d: null, corr30d: null, r2: null };
  }
}

function budgetClip(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

function fmtTf(tf) {
  if (!tf) return '- 暂无';
  const macd = tf.macd
    ? `MACD DIF=${tf.macd.dif} DEA=${tf.macd.dea} HIST=${tf.macd.hist} ${tf.macd.cross}`
    : 'MACD=--';
  const boll = tf.boll
    ? `BOLL 上=${tf.boll.upper} 中=${tf.boll.mid} 下=${tf.boll.lower}（${tf.boll.position}）`
    : 'BOLL=--';
  const atr = tf.atr ? `ATR=${tf.atr.atr}（${tf.atr.atrPct ?? '--'}%）` : 'ATR=--';
  const levels = (tf.chart?.levels || [])
    .map((l) => `${l.label}=${l.price}`)
    .join('；');
  return [
    `- ${tf.tf}${tf.source ? `（${tf.source}）` : ''}: 收盘 ${tf.last}｜近1根 ${tf.change1Pct}%｜近段 ${tf.changeRecentPct}%`,
    `  MA7=${tf.ma7 ?? '--'} MA25=${tf.ma25 ?? '--'} RSI14=${tf.rsi14 ?? '--'} 结构=${tf.structure}`,
    `  量比=${tf.volRatio ?? '--'}（${tf.volNote || '--'}）｜${atr}`,
    `  ${macd}`,
    `  ${boll}`,
    `  近窗高低 ${tf.low} ~ ${tf.high}`,
    levels ? `  图示价位：${levels}` : '  图示价位：暂无',
  ].join('\n');
}

function fmtCrowdPct(row, label) {
  if (!row || (row.longPct == null && row.shortPct == null)) return null;
  return (
    `- ${label}：多 ${row.longPct ?? '--'}% / 空 ${row.shortPct ?? '--'}%` +
    (row.ratio != null ? `｜比 ${row.ratio}` : '')
  );
}

function contextToPrompt(ctx) {
  const BUDGET = {
    header: 400,
    technical: 2200,
    derivatives: 1200,
    whales: 1400,
    news: 1800,
    macro: 1400,
    tvl: 500,
    capability: 500,
    footer: 400,
  };
  const s = ctx.sentiment || {};
  const ext = s.external || {};
  const st = ctx.status || {};
  const sm = ctx.statusMeta || {};
  const asset = ctx.asset || {};
  const cap = ctx.capability || {};
  const unavailable = Object.entries(st)
    .filter(([, v]) => v === 'unavailable' || v === 'empty')
    .map(([k, v]) => `${k}=${v}`);

  const header = budgetClip(
    [
      `标的：${ctx.coin}｜assetType=${asset.assetType || (ctx.equityLike ? 'equity_mapped' : 'crypto')}｜entity=${asset.entity || ctx.coin}｜instrument=${asset.instrumentType || 'perp'}｜benchmark=${asset.benchmark || '--'}`,
      `现价：${ctx.market?.price ?? '未知'}｜资金费率(约%)：${ctx.market?.fundingPct ?? '未知'}`,
      `数据可用性：${unavailable.length ? unavailable.join('；') : '各主维可用'}`,
      `模块：price=${sm.price?.status || '-'}(${sm.price?.cached ? 'cache' : 'live'}) tech=${sm.technical?.status || '-'} der=${sm.derivatives?.status || '-'} whales=${sm.whales?.status || '-'} news=${sm.news?.status || '-'}`,
      '规则：unavailable/empty 必须直说；能力 unavailable 时跳过该能力结论，禁止编造。',
    ].join('\n'),
    BUDGET.header,
  );

  const technical = budgetClip(
    [
      '【技术分析 · 5分钟 / 小时线 / 日线】',
      st.tech_klines === 'unavailable' ? '- K 线：unavailable' : null,
      ctx.tech?.m5 ? fmtTf(ctx.tech.m5) : '- 5分钟：暂无',
      ctx.tech?.hour ? fmtTf(ctx.tech.hour) : '- 小时线：暂无',
      ctx.tech?.day ? fmtTf(ctx.tech.day) : '- 日线：暂无',
    ]
      .filter(Boolean)
      .join('\n'),
    BUDGET.technical,
  );

  const liq = s.liquidations;
  const derivatives = budgetClip(
    [
      '【衍生品 · 爆仓 / 费率 / 主动买卖】',
      liq
        ? `- 24h 爆仓 ≈$${liq.totalUsd}（多 ${liq.longSharePct ?? '--'}% / 空 ${liq.shortSharePct ?? '--'}%）`
        : '- 爆仓：unavailable',
      `费率≈${s.fundingPct ?? '--'}%｜OI≈$${s.oiUsd ?? '--'}｜24h=${s.change24hPct ?? '--'}%`,
      ext.binanceTaker
        ? `- Taker ${ext.binanceTaker.buySellRatio ?? '--'}`
        : '- Taker：unavailable',
    ].join('\n'),
    BUDGET.derivatives,
  );

  const crowdLines = [
    fmtCrowdPct(ext.binanceTopAccount, '币安大户账户'),
    fmtCrowdPct(ext.binanceTopPosition, '币安大户持仓'),
    fmtCrowdPct(ext.bybitAccount, 'Bybit 账户'),
    ...(ext.onchainWhales || []).slice(0, 4).map((w) => `- 链上 ${w.asset} $${w.usd}`),
  ].filter(Boolean);

  const whales = budgetClip(
    [
      '【大户】',
      `站内：多 ${s.whaleLongCount}/$${s.whaleLongUsd}｜空 ${s.whaleShortCount}/$${s.whaleShortUsd}`,
      ...(ctx.whales?.topPositions || []).slice(0, 5).map((p) => `- ${p.whale} ${p.side} $${p.usd}`),
      '站外：',
      ...(crowdLines.length ? crowdLines : ['- 暂无']),
    ].join('\n'),
    BUDGET.whales,
  );

  const news = budgetClip(
    [
      '【新闻】',
      `模式=${ctx.newsMode}｜status=${st.web_news || sm.news?.status || '--'}`,
      ...((ctx.news || []).slice(0, 5).map((n) => `- [站内] ${clip(n.title, 90)}`) || []),
      ...((ctx.webNews || []).slice(0, 5).map((n) => `- [网络] ${clip(n.title, 90)}`) || []),
    ].join('\n'),
    BUDGET.news,
  );

  const bm = ctx.benchmarks || {};
  const bmLines = [];
  if (bm.btc24hPct != null) bmLines.push(`- BTC：${bm.btc24hPct}%`);
  if (bm.dxyNote) bmLines.push(`- DXY：${bm.dxyNote.changePct}%`);
  if (bm.ndxNote) bmLines.push(`- NDX：${bm.ndxNote.changePct}%`);
  if (bm.equityIndex?.shanghai) bmLines.push(`- 上证：${bm.equityIndex.shanghai.changePct}%`);
  if (bm.usdcny) bmLines.push(`- USDCNY：${bm.usdcny.last}`);

  const fmtMacro = (e) => {
    const bits = [
      e.dateLabel || '',
      e.time ? `${e.time}` : '',
      e.title || '',
      e.forecast ? `预期${e.forecast}` : '',
      e.previous ? `前值${e.previous}` : '',
      e.actual ? `实际${e.actual}` : Number(e.daysUntil) <= 0 ? '实际暂未入库' : '待公布',
      e.importance ? `重要性${e.importance}` : '',
    ].filter(Boolean);
    return `- ${bits.join(' · ')}`;
  };

  const macro = budgetClip(
    [
      '【宏观 / 基准 · 含预期/前值/实际，供定价与开仓判断】',
      ...(bmLines.length ? bmLines : ['- 基准 unavailable']),
      ...((ctx.macro || []).slice(0, 6).map(fmtMacro) || ['- 日历暂无']),
      '解读要求：若实际已出，比较实际 vs 预期/前值判断超预期或不及预期；若未公布，用预期+市场定价（是否已提前计价）做情景；警惕「利空出尽是利好 / 利好出尽是利空」。',
      `marketSensitivity: ${ctx.marketSensitivity?.status || 'unavailable'}`,
    ].join('\n'),
    Math.max(BUDGET.macro, 1400),
  );

  const tvl = ctx.defi
    ? budgetClip(
        `【TVL】链 ${ctx.defi.chain} ≈$${Math.round(ctx.defi.chainTvl)}`,
        BUDGET.tvl,
      )
    : '';

  const capability = budgetClip(
    [
      '【分析能力】',
      `shortTerm=${cap.shortTerm?.status}/${cap.shortTerm?.score}`,
      `newsDriven=${cap.newsDriven?.status}/${cap.newsDriven?.score}`,
      `whaleAnalysis=${cap.whaleAnalysis?.status}/${cap.whaleAnalysis?.score}`,
    ].join('\n'),
    BUDGET.capability,
  );

  const footer = budgetClip(
    `【复述】价=${ctx.market?.price ?? '--'}｜费率=${ctx.market?.fundingPct ?? '--'}｜5m=${ctx.tech?.m5?.structure ?? '--'}｜1h=${ctx.tech?.hour?.structure ?? '--'}｜1d=${ctx.tech?.day?.structure ?? '--'}｜爆仓≈$${liq?.totalUsd ?? '--'}`,
    BUDGET.footer,
  );

  return [header, technical, derivatives, whales, news, macro, tvl, capability, footer]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * 新闻/宏观 AI「走向预判」用的精简市场上下文（短线压力 + 资金流向）
 */
function buildAnalyzeMarketSnippet(ctx, maxChars = 2600) {
  if (!ctx) return '';
  const s = ctx.sentiment || {};
  const ext = s.external || {};
  const liq = s.liquidations;
  const lines = [
    `标的：${ctx.coin}｜现价 ${ctx.market?.price ?? '--'}｜资金费率(约%) ${ctx.market?.fundingPct ?? '--'}｜24h ${s.change24hPct ?? '--'}%`,
    '【短期 K 线 · 压力/支撑】',
    ctx.tech?.m5 ? fmtTf(ctx.tech.m5) : '- 5分钟：暂无',
    ctx.tech?.hour ? fmtTf(ctx.tech.hour) : '- 小时线：暂无',
    '【资金流向 / 衍生品】',
    liq
      ? `- 24h 爆仓 ≈$${liq.totalUsd}（多 ${liq.longSharePct ?? '--'}% / 空 ${liq.shortSharePct ?? '--'}%）`
      : '- 爆仓：unavailable',
    ext.binanceTaker
      ? `- Taker 买卖比 ${ext.binanceTaker.buySellRatio ?? '--'}`
      : '- Taker：unavailable',
    `费率≈${s.fundingPct ?? '--'}%｜OI≈$${s.oiUsd ?? '--'}`,
    '【大户多空】',
    `站内：多 ${s.whaleLongCount ?? 0}/$${s.whaleLongUsd ?? 0}｜空 ${s.whaleShortCount ?? 0}/$${s.whaleShortUsd ?? 0}`,
    fmtCrowdPct(ext.binanceTopAccount, '币安大户账户'),
    fmtCrowdPct(ext.binanceTopPosition, '币安大户持仓'),
  ].filter(Boolean);
  const text = lines.join('\n');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

module.exports = {
  buildMarketBriefContext,
  contextToPrompt,
  buildAnalyzeMarketSnippet,
  normalizeCoin,
};
