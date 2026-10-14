'use strict';
const axios = require('axios');
const WebSocket = require('ws');
const { createEngine, validBar, MINUTE } = require('./marketMovementEngine');

function createCollector({ now = Date.now, catalog = () => require('./tradfiMarkets').getRadarAvailableContracts(),
  fetchBars = async symbol => (await axios.get('https://fapi.binance.com/fapi/v1/klines', {
    params: { symbol, interval: '1m', limit: 1500 }, timeout: 10000,
    ...(process.env.OUTBOUND_PROXY_URL ? {} : { proxy: false }),
  })).data, openSocket = url => new WebSocket(url, { maxPayload: 256 * 1024 }), enabled = () => process.env.MARKET_MOVEMENTS_ENABLED !== '0' } = {}) {
  const engine = createEngine({ now }), pending = new Map();
  let contracts = [], socket = null, timer = null, discovery = null, seeding = false;
  let connected = false, error = '', lastMessageAt = 0, nextConnect = 0, nextCatalog = 0, nextSeed = 0, stopped = true, generation = 0, connectedAt = 0, subscriptionId = 0;
  function requestSeed(symbol) { if (!pending.has(symbol)) pending.set(symbol, now()); }
  function disconnect() { const old = socket; socket = null; connected = false; old?.terminate(); }
  function subscribe(symbols, method = 'SUBSCRIBE') {
    if (!symbols.length) return true;
    try { socket.send(JSON.stringify({ method, params: symbols.map(symbol => `${symbol.toLowerCase()}@kline_1m`), id: ++subscriptionId })); return true; }
    catch { error = '币安订阅发送失败，正在重连'; disconnect(); nextConnect = now() + 10000; return false; }
  }
  function connect() {
    if (!contracts.length || socket || now() < nextConnect || stopped) return;
    nextConnect = now() + 10000;
    const current = openSocket('wss://fstream.binance.com/market/stream'); socket = current;
    current.on('open', () => {
      if (socket !== current || stopped) return;
      connected = true; error = ''; lastMessageAt = connectedAt = now();
      if (!subscribe(contracts.map(row => row.symbol))) return;
      for (const row of contracts) if (engine.latest(row.symbol) == null || engine.latest(row.symbol) < now() - 2 * MINUTE) requestSeed(row.symbol);
    });
    current.on('message', raw => {
      if (socket !== current || stopped) return;
      lastMessageAt = now();
      try {
        const message = JSON.parse(String(raw)), data = message.data || message;
        if (data.code != null) { error = '币安订阅失败，正在重连'; disconnect(); return; }
        const k = data.k;
        if (data.e !== 'kline' || k?.x !== true || k.i !== '1m' || Number(k.T) >= now()) return;
        const symbol = data.s, previous = engine.latest(symbol);
        if (previous != null && Number(k.t) > previous + MINUTE) requestSeed(symbol);
        engine.ingest(symbol, { time: Number(k.t), open: Number(k.o), close: Number(k.c), high: Number(k.h), low: Number(k.l) });
      } catch { error = '行情消息格式异常'; }
    });
    current.on('error', () => { if (socket === current) error = '币安实时连接失败，正在重试'; });
    current.on('close', () => {
      if (socket !== current) return;
      socket = null; connected = false; nextConnect = now() + 10000;
      error = '币安实时连接已断开，正在重连';
    });
  }
  async function discover() {
    if (discovery) return discovery;
    if (now() < nextCatalog) return;
    nextCatalog = now() + 60000; const version = generation;
    discovery = (async () => {
      const result = await catalog();
      if (stopped || version !== generation) return;
      if (result.stale) throw new Error('合约清单已过期');
      const selected = result.contracts.filter(row => /^[A-Z0-9]{1,30}USDT$/.test(row.symbol) && Number(row.quoteVolume24h) > 0)
        .sort((a, b) => Number(b.quoteVolume24h) - Number(a.quoteVolume24h) || a.symbol.localeCompare(b.symbol)).slice(0, 100);
      if (!selected.length) throw new Error('没有可监控的合约');
      const before = new Set(contracts.map(row => row.symbol)), after = new Set(selected.map(row => row.symbol));
      const added = selected.filter(row => !before.has(row.symbol)).map(row => row.symbol);
      const removed = contracts.filter(row => !after.has(row.symbol)).map(row => row.symbol);
      contracts = selected; engine.configure(contracts);
      for (const symbol of pending.keys()) if (!selected.some(row => row.symbol === symbol)) pending.delete(symbol);
      // Retained contracts keep both their live subscription and complete windows.
      for (const symbol of added) requestSeed(symbol);
      if (connected && socket) { if (subscribe(removed, 'UNSUBSCRIBE')) subscribe(added); }
      nextCatalog = now() + 3600000; error = ''; connect();
    })().catch(() => { if (version === generation) error = '币安合约清单暂不可用，稍后重试'; }).finally(() => { discovery = null; });
    return discovery;
  }
  async function seedNext() {
    if (seeding || stopped || now() < nextSeed) return;
    const item = [...pending].find(([, due]) => due <= now()); if (!item) return;
    const [symbol] = item; pending.delete(symbol); seeding = true; const version = generation;
    try {
      const rows = await fetchBars(symbol);
      if (stopped || version !== generation) return;
      if (!Array.isArray(rows) || !rows.length) throw new Error('历史行情为空');
      const bars = rows.filter(row => Array.isArray(row) && Number(row[6]) < now()).map(row => ({ time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]) })).filter(validBar);
      if (!bars.length) throw new Error('没有已收盘行情');
      engine.seed(symbol, bars);
      if (!engine.snapshot().ready5m) error = '历史行情正在补齐';
    } catch (failure) {
      if (!stopped && version === generation && contracts.some(row => row.symbol === symbol)) {
        error = '部分历史行情未补齐，正在限速重试'; pending.set(symbol, now() + 60000);
        if ([418, 429].includes(failure.response?.status)) {
          const retry = Number(failure.response?.headers?.['retry-after']);
          nextSeed = now() + Math.max(60000, (Number.isFinite(retry) ? retry : 60) * 1000);
        }
      }
    } finally { seeding = false; nextSeed = Math.max(nextSeed, now() + 1500); }
  }
  function tick() {
    if (stopped) return;
    if (!enabled()) { disconnect(); return; }
    if (connected && (now() - lastMessageAt > 90000 || now() - connectedAt > 23 * 3600000)) disconnect();
    if (socket && !connected && now() > nextConnect + 20000) disconnect();
    void discover(); connect(); void seedNext();
  }
  function start() { if (!stopped) return; stopped = false; generation++; timer = setInterval(tick, 1000); timer.unref?.(); tick(); }
  function stop() { stopped = true; generation++; clearInterval(timer); timer = null; disconnect(); }
  function snapshot() {
    const state = engine.snapshot();
    return { ...state, events: state.events.slice(0, 100), enabled: enabled(), connected,
      stale: !connected || !state.latestAt || now() - state.latestAt > 120000,
      warming: pending.size + Number(seeding), error: pending.size || !connected ? error : '',
      source: 'Binance USDⓈ-M Futures', scope: '成交额前100个USDT永续合约（每小时更新）', dayTimezone: 'UTC',
      windowMode: 'closed-1m', retentionHours: 24, maxEvents: 1000 };
  }
  return { start, stop, snapshot, tick, seedNext, discover, engine };
}
const collector = createCollector();
module.exports = { createCollector, start: collector.start, stop: collector.stop, snapshot: collector.snapshot };
