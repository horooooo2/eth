/**
 * Hyperliquid 上游 WebSocket 客户端
 * 默认官方 wss://api.hyperliquid.xyz/ws
 * 仅当 HL_USE_GOLDRUSH=1 且有 Key 时走 GoldRush WS
 */
const WebSocket = require('ws');
const { pushSocket, pushError } = require('./opsMonitor');

const OFFICIAL_WS = 'wss://api.hyperliquid.xyz/ws';
const GOLDRUSH_WS_BASE = 'wss://hypercore.goldrushdata.com/ws';
const PING_MS = 20_000;
const RECONNECT_MS = 3_000;

const apiKey = String(process.env.GOLDRUSH_API_KEY || process.env.HL_INFO_API_KEY || '').trim();
const useGoldRush = process.env.HL_USE_GOLDRUSH === '1' && Boolean(apiKey);

function resolveWsUrl() {
  const forced = String(process.env.HL_WS_URL || '').trim();
  if (forced) return forced;
  if (useGoldRush) return `${GOLDRUSH_WS_BASE}?key=${encodeURIComponent(apiKey)}`;
  return OFFICIAL_WS;
}

function createHlWsClient(handlers = {}) {
  const onFill = typeof handlers.onFill === 'function' ? handlers.onFill : () => {};
  const onWebData = typeof handlers.onWebData === 'function' ? handlers.onWebData : () => {};
  const onStatus = typeof handlers.onStatus === 'function' ? handlers.onStatus : () => {};

  let socket = null;
  let pingTimer = null;
  let reconnectTimer = null;
  let stopped = false;
  let connected = false;

  /** @type {Set<string>} */
  const fillUsers = new Set();
  /** @type {Set<string>} */
  const webDataUsers = new Set();
  /** 已向当前连接发送的订阅，断线清空 */
  const activeSubs = new Set();

  function subKey(type, user) {
    return `${type}:${String(user || '').toLowerCase()}`;
  }

  function getStatus() {
    return {
      connected,
      url: resolveWsUrl().replace(/key=[^&]+/i, 'key=***'),
      usingGoldRush: /goldrushdata\.com/i.test(resolveWsUrl()),
      fillSubs: fillUsers.size,
      webDataSubs: webDataUsers.size,
    };
  }

  function send(obj) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  function subscribeOne(type, user) {
    const addr = String(user || '').trim().toLowerCase();
    if (!addr.startsWith('0x')) return;
    const key = subKey(type, addr);
    if (activeSubs.has(key)) return;
    if (
      send({
        method: 'subscribe',
        subscription: { type, user: addr },
      })
    ) {
      activeSubs.add(key);
    }
  }

  function unsubscribeOne(type, user) {
    const addr = String(user || '').trim().toLowerCase();
    if (!addr.startsWith('0x')) return;
    const key = subKey(type, addr);
    send({
      method: 'unsubscribe',
      subscription: { type, user: addr },
    });
    activeSubs.delete(key);
  }

  function flushSubscriptions() {
    for (const user of fillUsers) subscribeOne('userFills', user);
    for (const user of webDataUsers) subscribeOne('webData2', user);
  }

  /**
   * @param {{ fillAddresses?: string[], webDataAddresses?: string[] }} next
   */
  function syncSubscriptions(next = {}) {
    const nextFills = new Set(
      (next.fillAddresses || [])
        .map((a) => String(a || '').trim().toLowerCase())
        .filter((a) => a.startsWith('0x')),
    );
    const nextWeb = new Set(
      (next.webDataAddresses || [])
        .map((a) => String(a || '').trim().toLowerCase())
        .filter((a) => a.startsWith('0x')),
    );

    for (const user of [...fillUsers]) {
      if (!nextFills.has(user)) {
        fillUsers.delete(user);
        unsubscribeOne('userFills', user);
      }
    }
    for (const user of nextFills) fillUsers.add(user);

    for (const user of [...webDataUsers]) {
      if (!nextWeb.has(user)) {
        webDataUsers.delete(user);
        unsubscribeOne('webData2', user);
      }
    }
    for (const user of nextWeb) webDataUsers.add(user);

    if (connected) flushSubscriptions();
    onStatus(getStatus());
  }

  function clearTimers() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_MS);
  }

  function handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.channel === 'pong' || msg.method === 'pong') return;

    if (msg.channel === 'userFills' && msg.data) {
      const user = String(msg.data.user || '').toLowerCase();
      const fills = Array.isArray(msg.data.fills) ? msg.data.fills : [];
      const isSnapshot = Boolean(msg.data.isSnapshot);
      const short = user ? `${user.slice(0, 6)}…${user.slice(-4)}` : 'unknown';
      pushSocket({
        kind: isSnapshot ? 'fill-snap' : 'fill',
        message: `userFills ${short} ×${fills.length}${isSnapshot ? ' · snapshot' : ''}`,
        detail: { user, count: fills.length, isSnapshot },
      });
      onFill({ user, fills, isSnapshot });
      return;
    }

    if (msg.channel === 'webData2' && msg.data) {
      const user = String(msg.data.user || msg.data?.clearinghouseState?.user || '').toLowerCase();
      const short = user ? `${user.slice(0, 6)}…${user.slice(-4)}` : 'unknown';
      const posN = Array.isArray(msg.data?.clearinghouseState?.assetPositions)
        ? msg.data.clearinghouseState.assetPositions.length
        : null;
      pushSocket({
        kind: 'webData',
        message: `webData2 ${short}${posN != null ? ` · ${posN}仓` : ''}`,
        detail: { user, positions: posN },
      });
      onWebData({ user, data: msg.data });
    }
  }

  function connect() {
    if (stopped) return;
    clearTimers();
    activeSubs.clear();
    connected = false;

    const url = resolveWsUrl();
    console.log(`[hl-ws] connecting ${url.replace(/key=[^&]+/i, 'key=***')}`);

    try {
      socket = new WebSocket(url);
    } catch (err) {
      console.warn('[hl-ws] create failed:', err.message);
      pushError({ source: 'hl-ws', message: `创建连接失败: ${err.message}` });
      scheduleReconnect();
      return;
    }

    socket.on('open', () => {
      connected = true;
      console.log(`[hl-ws] connected fills=${fillUsers.size} webData2=${webDataUsers.size}`);
      pushSocket({
        kind: 'status',
        message: `WS 已连接 · fills=${fillUsers.size} webData2=${webDataUsers.size}`,
      });
      flushSubscriptions();
      pingTimer = setInterval(() => {
        send({ method: 'ping' });
      }, PING_MS);
      onStatus(getStatus());
    });

    socket.on('message', (data) => handleMessage(data));

    socket.on('close', () => {
      connected = false;
      activeSubs.clear();
      clearTimers();
      console.warn('[hl-ws] disconnected, reconnecting…');
      pushSocket({ kind: 'status', message: 'WS 断开，正在重连…' });
      onStatus(getStatus());
      scheduleReconnect();
    });

    socket.on('error', (err) => {
      console.warn('[hl-ws] error:', err.message || err);
      pushError({ source: 'hl-ws', message: String(err.message || err) });
    });
  }

  function start() {
    stopped = false;
    connect();
  }

  function stop() {
    stopped = true;
    clearTimers();
    try {
      socket?.close();
    } catch {
      // ignore
    }
    socket = null;
    connected = false;
    onStatus(getStatus());
  }

  function isConnected() {
    return connected;
  }

  return {
    start,
    stop,
    syncSubscriptions,
    isConnected,
    getStatus,
  };
}

module.exports = {
  createHlWsClient,
  resolveWsUrl,
};
