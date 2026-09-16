/**
 * CEX taker 资金流向（Binance / OKX / Bybit WebSocket）
 *
 * - 三家现货 BTC/USDT、ETH/USDT、SOL/USDT
 * - Binance: aggTrade，m=false=taker buy
 * - OKX:     trades-all，side=buy/sell
 * - Bybit:   publicTrade，S=Buy/Sell
 * - 去重 key = exchange + symbol + tradeId，不跨所去重
 * - 一家断线不影响其他两家；各自独立心跳 + 重连
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
  okx:     { BTC: 'BTC-USDT', ETH: 'ETH-USDT', SOL: 'SOL-USDT' },
  bybit:   { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' },
};

// ---------- 运行时状态 ----------
/** @type {{ts:number, coin:string, side:'buy'|'sell', usd:number, price:number, exchange:string}[]} */
const buffer = [];
const seenIds = new Set();
const priceCache = { BTC: null, ETH: null, SOL: null };

const sources = {
  binance: {
    name: 'binance',
    ws: null,
    reconnectTimer: null,
    heartbeatTimer: null,
    started: false,
    connected: false,
    connectCount: 0,
    totalTrades: 0,
    lastTradeAt: 0,
    lastError: '',
  },
  okx: {
    name: 'okx',
    ws: null,
    reconnectTimer: null,
    heartbeatTimer: null,
    started: false,
    connected: false,
    connectCount: 0,
    totalTrades: 0,
    lastTradeAt: 0,
    lastError: '',
  },
  bybit: {
    name: 'bybit',
    ws: null,
    reconnectTimer: null,
    heartbeatTimer: null,
    started: false,
    connected: false,
    connectCount: 0,
    totalTrades: 0,
    lastTradeAt: 0,
    lastError: '',
  },
};

// ---------- 工具 ----------
function pruneBuffer() {
  const cutoff = Date.now() - RETENTION_MS;
  while (buffer.length && buffer[0].ts < cutoff) buffer.shift();
  if (seenIds.size > DEDUP_MAX) seenIds.clear();
}

function addTrade(exchange, coin, side, price, qty, ts, tradeId) {
  const usd = price * qty;
  if (!Number.isFinite(usd) || usd <= 0) return;
  const key = `${exchange}:${coin}:${tradeId}`;
  if (seenIds.has(key)) return;
  seenIds.add(key);
  buffer.push({ ts, coin, side, usd, price, exchange });
  priceCache[coin] = price;
  const s = sources[exchange];
  s.totalTrades += 1;
  s.lastTradeAt = Date.now();
}

// ---------- Binance ----------
function connectBinance() {
  const s = sources.binance;
  if (!s.started) return;
  if (s.ws) { try { s.ws.removeAllListeners(); s.ws.terminate(); } catch (_) {} }
  const url = 'wss://stream.binance.com:9443/ws/btcusdt@aggTrade/ethusdt@aggTrade/solusdt@aggTrade';
  const ws = new WebSocket(url);
  s.ws = ws;
  s.connectCount += 1;
  s.connected = false;

  ws.on('open', () => { s.connected = true; s.lastError = ''; console.log('[cex] Binance connected'); });
  ws.on('message', (data) => {
    try {
      const m = JSON.parse(data.toString());
      if (m.e !== 'aggTrade') return;
      const coin = Object.keys(SYMBOLS.binance).find((k) => SYMBOLS.binance[k] === m.s);
      if (!coin) return;
      const side = m.m ? 'sell' : 'buy';
      addTrade('binance', coin, side, parseFloat(m.p), parseFloat(m.q), m.T || Date.now(), m.a);
    } catch (_) {}
  });
  ws.on('error', (e) => { s.lastError = e.message || String(e); });
  ws.on('close', () => {
    s.connected = false;
    if (!s.started) return;
    s.reconnectTimer = setTimeout(connectBinance, RECONNECT_MS);
  });
}

// ---------- OKX ----------
function connectOkx() {
  const s = sources.okx;
  if (!s.started) return;
  if (s.ws) { try { s.ws.removeAllListeners(); s.ws.terminate(); } catch (_) {} }
  const url = 'wss://ws.okx.com:8443/ws/v5/public';
  const ws = new WebSocket(url);
  s.ws = ws;
  s.connectCount += 1;
  s.connected = false;

  const subscribe = {
    op: 'subscribe',
    args: [
      { channel: 'trades', instId: 'BTC-USDT' },
      { channel: 'trades', instId: 'ETH-USDT' },
      { channel: 'trades', instId: 'SOL-USDT' },
    ],
  };

  ws.on('open', () => {
    s.connected = true;
    s.lastError = '';
    ws.send(JSON.stringify(subscribe));
    console.log('[cex] OKX connected');
    // OKX 心跳：每 25s 发 ping
    s.heartbeatTimer = setInterval(() => {
      if (ws.readyState === 1) { try { ws.send('ping'); } catch (_) {} }
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
          const coin = Object.keys(SYMBOLS.okx).find((k) => SYMBOLS.okx[k] === t.instId);
          if (!coin) continue;
          const side = t.side === 'buy' ? 'buy' : 'sell';
          addTrade('okx', coin, side, parseFloat(t.px), parseFloat(t.sz), Number(t.ts) || Date.now(), t.tradeId);
        }
      }
    } catch (_) {}
  });
  ws.on('error', (e) => { s.lastError = e.message || String(e); });
  ws.on('close', () => {
    s.connected = false;
    if (s.heartbeatTimer) { clearInterval(s.heartbeatTimer); s.heartbeatTimer = null; }
    if (!s.started) return;
    s.reconnectTimer = setTimeout(connectOkx, RECONNECT_MS);
  });
}

// ---------- Bybit ----------
function connectBybit() {
  const s = sources.bybit;
  if (!s.started) return;
  if (s.ws) { try { s.ws.removeAllListeners(); s.ws.terminate(); } catch (_) {} }
  const url = 'wss://stream.bybit.com/v5/public/spot';
  const ws = new WebSocket(url);
  s.ws = ws;
  s.connectCount += 1;
  s.connected = false;

  ws.on('open', () => {
    s.connected = true;
    s.lastError = '';
    ws.send(JSON.stringify({
      op: 'subscribe',
      args: ['publicTrade.BTCUSDT', 'publicTrade.ETHUSDT', 'publicTrade.SOLUSDT'],
    }));
    console.log('[cex] Bybit connected');
    // Bybit 心跳：每 20s 发 ping
    s.heartbeatTimer = setInterval(() => {
      if (ws.readyState === 1) { try { ws.send(JSON.stringify({ op: 'ping' })); } catch (_) {} }
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
          addTrade('bybit', coin, side, parseFloat(t.p), parseFloat(t.v), Number(t.T) || Date.now(), t.i || t.x);
        }
      }
    } catch (_) {}
  });
  ws.on('error', (e) => { s.lastError = e.message || String(e); });
  ws.on('close', () => {
    s.connected = false;
    if (s.heartbeatTimer) { clearInterval(s.heartbeatTimer); s.heartbeatTimer = null; }
    if (!s.started) return;
    s.reconnectTimer = setTimeout(connectBybit, RECONNECT_MS);
  });
}

// ---------- 聚合 ----------
function aggregate(periodMs) {
  const cutoff = Date.now() - periodMs;
  const coins = ['BTC', 'ETH', 'SOL'];
  const out = {};
  for (const c of coins) out[c] = { buy: 0, sell: 0, count: 0, price: priceCache[c], byExchange: {} };
  for (const r of buffer) {
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

// ---------- 对外 ----------
function getFlowCoins(periodInput = '1h', coinList = []) {
  const period = PERIODS[periodInput] ? periodInput : '1h';
  const periodMs = PERIODS[period];
  pruneBuffer();
  const agg = aggregate(periodMs);

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
      source: 'cex-ws',
      byExchange: a.byExchange,
    };
  });
  rows.sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

  return {
    period,
    coins: rows,
    updatedAt: Date.now(),
    accumulating: buffer.length === 0,
  };
}

function getStatus() {
  pruneBuffer();
  const out = { connected: true, exchanges: {}, bufferSize: buffer.length, prices: { ...priceCache } };
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
  console.log('[cex-flow] 启动 Binance / OKX / Bybit WS');
  connectBinance();
  connectOkx();
  connectBybit();
  return getStatus();
}

function stop() {
  for (const s of Object.values(sources)) {
    s.started = false;
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    if (s.heartbeatTimer) clearInterval(s.heartbeatTimer);
    if (s.ws) { try { s.ws.removeAllListeners(); s.ws.close(); } catch (_) {} }
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
