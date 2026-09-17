/**
 * CEX taker 资金流向（Binance / OKX / Bybit WebSocket）
 *
 * - 同时维护现货 (spot) 与 U 本位合约 (swap) 两套缓冲
 * - Binance spot: stream.binance.com aggTrade；swap: fstream.binance.com aggTrade
 * - OKX spot: BTC-USDT trades；swap: BTC-USDT-SWAP trades
 * - Bybit spot: /v5/public/spot；swap: /v5/public/linear
 * - 去重 key = marketType + exchange + symbol + tradeId
 * - 内存 buffer 保留 6h+1min，本地聚合 5m/15m/1h/2h/4h/6h
 */
const WebSocket = require('ws');

const PERIODS = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '2h': 2 * 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
};
const RETENTION_MS = 6 * 60 * 60 * 1000 + 60 * 1000;
const RECONNECT_MS = 5000;
const DEDUP_MAX = 100000;

const SYMBOLS = {
  binance: { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' },
  okxSpot: { BTC: 'BTC-USDT', ETH: 'ETH-USDT', SOL: 'SOL-USDT' },
  okxSwap: { BTC: 'BTC-USDT-SWAP', ETH: 'ETH-USDT-SWAP', SOL: 'SOL-USDT-SWAP' },
  /** OKX U 本位永续：sz 为张数，需 × ctVal 得到币数量 */
  okxSwapCtVal: { BTC: 0.01, ETH: 0.1, SOL: 1 },
  bybit: { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' },
};

/** @type {{ spot: any[], swap: any[] }} */
const buffers = { spot: [], swap: [] };
/** @type {{ spot: Set<string>, swap: Set<string> }} */
const seenIds = { spot: new Set(), swap: new Set() };
const priceCache = {
  spot: { BTC: null, ETH: null, SOL: null },
  swap: { BTC: null, ETH: null, SOL: null },
};

function makeSource(name) {
  return {
    name,
    ws: null,
    reconnectTimer: null,
    heartbeatTimer: null,
    started: false,
    connected: false,
    connectCount: 0,
    totalTrades: 0,
    lastTradeAt: 0,
    lastError: '',
  };
}

const sources = {
  'binance-spot': makeSource('binance-spot'),
  'binance-swap': makeSource('binance-swap'),
  'okx-spot': makeSource('okx-spot'),
  'okx-swap': makeSource('okx-swap'),
  'bybit-spot': makeSource('bybit-spot'),
  'bybit-swap': makeSource('bybit-swap'),
};

function pruneBuffer(marketType) {
  const buffer = buffers[marketType];
  const ids = seenIds[marketType];
  const cutoff = Date.now() - RETENTION_MS;
  while (buffer.length && buffer[0].ts < cutoff) buffer.shift();
  if (ids.size > DEDUP_MAX) ids.clear();
}

function pruneAll() {
  pruneBuffer('spot');
  pruneBuffer('swap');
}

function addTrade(marketType, exchange, coin, side, price, qty, ts, tradeId) {
  const usd = price * qty;
  if (!Number.isFinite(usd) || usd <= 0) return;
  const key = `${marketType}:${exchange}:${coin}:${tradeId}`;
  const ids = seenIds[marketType];
  if (ids.has(key)) return;
  ids.add(key);
  buffers[marketType].push({ ts, coin, side, usd, price, exchange });
  priceCache[marketType][coin] = price;
  const s = sources[`${exchange}-${marketType}`] || sources[exchange];
  if (s) {
    s.totalTrades += 1;
    s.lastTradeAt = Date.now();
  }
}

function scheduleReconnect(sourceKey, connectFn) {
  const s = sources[sourceKey];
  s.connected = false;
  if (s.heartbeatTimer) {
    clearInterval(s.heartbeatTimer);
    s.heartbeatTimer = null;
  }
  if (!s.started) return;
  s.reconnectTimer = setTimeout(connectFn, RECONNECT_MS);
}

// ---------- Binance ----------
function connectBinanceSpot() {
  const s = sources['binance-spot'];
  if (!s.started) return;
  if (s.ws) {
    try {
      s.ws.removeAllListeners();
      s.ws.terminate();
    } catch (_) {}
  }
  const url = 'wss://stream.binance.com:9443/ws/btcusdt@aggTrade/ethusdt@aggTrade/solusdt@aggTrade';
  const ws = new WebSocket(url);
  s.ws = ws;
  s.connectCount += 1;
  s.connected = false;

  ws.on('open', () => {
    s.connected = true;
    s.lastError = '';
    console.log('[cex] Binance spot connected');
  });
  ws.on('message', (data) => {
    try {
      const m = JSON.parse(data.toString());
      if (m.e !== 'aggTrade') return;
      const coin = Object.keys(SYMBOLS.binance).find((k) => SYMBOLS.binance[k] === m.s);
      if (!coin) return;
      const side = m.m ? 'sell' : 'buy';
      addTrade('spot', 'binance', coin, side, parseFloat(m.p), parseFloat(m.q), m.T || Date.now(), m.a);
    } catch (_) {}
  });
  ws.on('error', (e) => {
    s.lastError = e.message || String(e);
  });
  ws.on('close', () => scheduleReconnect('binance-spot', connectBinanceSpot));
}

function connectBinanceSwap() {
  const s = sources['binance-swap'];
  if (!s.started) return;
  if (s.ws) {
    try {
      s.ws.removeAllListeners();
      s.ws.terminate();
    } catch (_) {}
  }
  const url = 'wss://fstream.binance.com/stream?streams=btcusdt@aggTrade/ethusdt@aggTrade/solusdt@aggTrade';
  const ws = new WebSocket(url);
  s.ws = ws;
  s.connectCount += 1;
  s.connected = false;

  ws.on('open', () => {
    s.connected = true;
    s.lastError = '';
    console.log('[cex] Binance swap connected');
  });
  ws.on('message', (data) => {
    try {
      const raw = JSON.parse(data.toString());
      const m = raw.data || raw;
      if (m.e !== 'aggTrade') return;
      const coin = Object.keys(SYMBOLS.binance).find((k) => SYMBOLS.binance[k] === m.s);
      if (!coin) return;
      const side = m.m ? 'sell' : 'buy';
      addTrade('swap', 'binance', coin, side, parseFloat(m.p), parseFloat(m.q), m.T || Date.now(), m.a);
    } catch (_) {}
  });
  ws.on('error', (e) => {
    s.lastError = e.message || String(e);
  });
  ws.on('close', () => scheduleReconnect('binance-swap', connectBinanceSwap));
}

// ---------- OKX ----------
function connectOkx(marketType) {
  const sourceKey = `okx-${marketType}`;
  const s = sources[sourceKey];
  if (!s.started) return;
  if (s.ws) {
    try {
      s.ws.removeAllListeners();
      s.ws.terminate();
    } catch (_) {}
  }
  const url = 'wss://ws.okx.com:8443/ws/v5/public';
  const ws = new WebSocket(url);
  s.ws = ws;
  s.connectCount += 1;
  s.connected = false;

  const symMap = marketType === 'swap' ? SYMBOLS.okxSwap : SYMBOLS.okxSpot;
  const subscribe = {
    op: 'subscribe',
    args: Object.values(symMap).map((instId) => ({ channel: 'trades', instId })),
  };

  ws.on('open', () => {
    s.connected = true;
    s.lastError = '';
    ws.send(JSON.stringify(subscribe));
    console.log(`[cex] OKX ${marketType} connected`);
    s.heartbeatTimer = setInterval(() => {
      if (ws.readyState === 1) {
        try {
          ws.send('ping');
        } catch (_) {}
      }
    }, 25000);
  });
  ws.on('message', (data) => {
    const raw = data.toString();
    if (raw === 'pong') return;
    try {
      const m = JSON.parse(raw);
      if (m.event === 'subscribe') return;
      if (m.arg && m.arg.channel === 'trades' && Array.isArray(m.data)) {
        for (const t of m.data) {
          const coin = Object.keys(symMap).find((k) => symMap[k] === t.instId);
          if (!coin) continue;
          const side = t.side === 'buy' ? 'buy' : 'sell';
          const qty = parseFloat(t.sz) * (marketType === 'swap' ? (SYMBOLS.okxSwapCtVal[coin] || 1) : 1);
          addTrade(marketType, 'okx', coin, side, parseFloat(t.px), qty, Number(t.ts) || Date.now(), t.tradeId);
        }
      }
    } catch (_) {}
  });
  ws.on('error', (e) => {
    s.lastError = e.message || String(e);
  });
  ws.on('close', () => scheduleReconnect(sourceKey, () => connectOkx(marketType)));
}

// ---------- Bybit ----------
function connectBybit(marketType) {
  const sourceKey = `bybit-${marketType}`;
  const s = sources[sourceKey];
  if (!s.started) return;
  if (s.ws) {
    try {
      s.ws.removeAllListeners();
      s.ws.terminate();
    } catch (_) {}
  }
  const url =
    marketType === 'swap'
      ? 'wss://stream.bybit.com/v5/public/linear'
      : 'wss://stream.bybit.com/v5/public/spot';
  const ws = new WebSocket(url);
  s.ws = ws;
  s.connectCount += 1;
  s.connected = false;

  ws.on('open', () => {
    s.connected = true;
    s.lastError = '';
    ws.send(
      JSON.stringify({
        op: 'subscribe',
        args: ['publicTrade.BTCUSDT', 'publicTrade.ETHUSDT', 'publicTrade.SOLUSDT'],
      }),
    );
    console.log(`[cex] Bybit ${marketType} connected`);
    s.heartbeatTimer = setInterval(() => {
      if (ws.readyState === 1) {
        try {
          ws.send(JSON.stringify({ op: 'ping' }));
        } catch (_) {}
      }
    }, 20000);
  });
  ws.on('message', (data) => {
    try {
      const m = JSON.parse(data.toString());
      if (m.op === 'pong' || m.success) return;
      if (m.topic && m.topic.startsWith('publicTrade.') && Array.isArray(m.data)) {
        for (const t of m.data) {
          const coin = Object.keys(SYMBOLS.bybit).find((k) => SYMBOLS.bybit[k] === t.s);
          if (!coin) continue;
          const side = t.S === 'Buy' ? 'buy' : 'sell';
          addTrade(marketType, 'bybit', coin, side, parseFloat(t.p), parseFloat(t.v), Number(t.T) || Date.now(), t.i || t.x);
        }
      }
    } catch (_) {}
  });
  ws.on('error', (e) => {
    s.lastError = e.message || String(e);
  });
  ws.on('close', () => scheduleReconnect(sourceKey, () => connectBybit(marketType)));
}

// ---------- 聚合 ----------
function aggregate(marketType, periodMs) {
  const cutoff = Date.now() - periodMs;
  const coins = ['BTC', 'ETH', 'SOL'];
  const out = {};
  const prices = priceCache[marketType];
  for (const c of coins) out[c] = { buy: 0, sell: 0, count: 0, price: prices[c], byExchange: {} };
  for (const r of buffers[marketType]) {
    if (r.ts < cutoff) continue;
    if (!out[r.coin]) continue;
    out[r.coin][r.side] += r.usd;
    out[r.coin].count += 1;
    if (!out[r.coin].byExchange[r.exchange]) out[r.coin].byExchange[r.exchange] = { buy: 0, sell: 0, count: 0 };
    out[r.coin].byExchange[r.exchange][r.side] += r.usd;
    out[r.coin].byExchange[r.exchange].count += 1;
  }
  return out;
}

function normalizeMarketType(raw) {
  return String(raw || 'spot').toLowerCase() === 'swap' ? 'swap' : 'spot';
}

// ---------- 对外 ----------
function getFlowCoins(periodInput = '1h', coinList = [], marketTypeInput = 'spot') {
  const period = PERIODS[periodInput] ? periodInput : '1h';
  const periodMs = PERIODS[period];
  const marketType = normalizeMarketType(marketTypeInput);
  pruneBuffer(marketType);
  const agg = aggregate(marketType, periodMs);

  const wanted = (coinList.length ? coinList : ['BTC', 'ETH', 'SOL'])
    .map((c) => String(c || '').toUpperCase())
    .filter(Boolean);

  const rows = wanted.map((coin) => {
    const a = agg[coin] || { buy: 0, sell: 0, count: 0, price: null, byExchange: {} };
    const net = a.buy - a.sell;
    return {
      coin,
      buy: Math.round(a.buy),
      sell: Math.round(a.sell),
      net: Math.round(net),
      count: a.count,
      price: a.price,
      changePct: null,
      period,
      marketType,
      source: `cex-ws-${marketType}`,
      byExchange: a.byExchange,
    };
  });
  rows.sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

  return {
    period,
    marketType,
    coins: rows,
    updatedAt: Date.now(),
    accumulating: buffers[marketType].length === 0,
  };
}

function getStatus() {
  pruneAll();
  const out = {
    connected: true,
    exchanges: {},
    bufferSize: { spot: buffers.spot.length, swap: buffers.swap.length },
    prices: {
      spot: { ...priceCache.spot },
      swap: { ...priceCache.swap },
    },
  };
  for (const [name, s] of Object.entries(sources)) {
    out.exchanges[name] = {
      connected: s.connected,
      connectCount: s.connectCount,
      totalTrades: s.totalTrades,
      lastTradeAt: s.lastTradeAt,
      lastError: s.lastError,
    };
  }
  out.connected = Object.values(sources).some((s) => s.connected);
  out.periods = Object.keys(PERIODS).map((p) => ({ period: p, windowMs: PERIODS[p] }));
  return out;
}

function start() {
  for (const s of Object.values(sources)) s.started = true;
  console.log('[cex-flow] 启动 Binance / OKX / Bybit WS（现货 + 合约）');
  connectBinanceSpot();
  connectBinanceSwap();
  connectOkx('spot');
  connectOkx('swap');
  connectBybit('spot');
  connectBybit('swap');
  return getStatus();
}

function stop() {
  for (const s of Object.values(sources)) {
    s.started = false;
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    if (s.heartbeatTimer) clearInterval(s.heartbeatTimer);
    if (s.ws) {
      try {
        s.ws.removeAllListeners();
        s.ws.close();
      } catch (_) {}
    }
    s.ws = null;
  }
}

module.exports = {
  start,
  stop,
  getFlowCoins,
  getStatus,
  PERIODS,
};
