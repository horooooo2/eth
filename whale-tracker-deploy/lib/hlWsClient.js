const { rememberMarketSnapshot } = require('./hlMarkets');
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
  let generation = 0;
  let lastMessageAt = 0;
  let connectedAt = 0;

  /** @type {Set<string>} */
  const fillUsers = new Set();
  /** @type {Set<string>} */
  const webDataUsers = new Set();
  /** 已向当前连接发送的订阅，断线清空 */
  const activeSubs = new Set();
  const acknowledgedSubs = new Set();
  const subscriptionErrors = new Map();
  const sentAt = new Map();
  const lastDataAt = new Map();
  const attempts = new Map();

  function subKey(type, user) {
    return `${type}:${String(user || '').toLowerCase()}`;
  }

  function getStatus() {
    return {
      connected,
      healthy: connected && subscriptionErrors.size === 0 && activeSubs.size === acknowledgedSubs.size &&
        [...webDataUsers].every(user => Date.now() - (lastDataAt.get(subKey('allDexsClearinghouseState', user)) || 0) < 120000),
      positionChannel: 'allDexsClearinghouseState',
      lastDataAt: Object.fromEntries(lastDataAt),
      url: resolveWsUrl().replace(/key=[^&]+/i, 'key=***'),
      usingGoldRush: /goldrushdata\.com/i.test(resolveWsUrl()),
      fillSubs: fillUsers.size,
      webDataSubs: webDataUsers.size,
      ackedSubs: acknowledgedSubs.size,
      pendingAcks: Math.max(0, activeSubs.size - acknowledgedSubs.size),
      subscriptionErrors: [...subscriptionErrors.values()].slice(-20),
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
      sentAt.set(key, Date.now());
      attempts.set(key, (attempts.get(key) || 0) + 1);
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
    sentAt.delete(key);
    attempts.delete(key);
    lastDataAt.delete(key);
    acknowledgedSubs.delete(key);
    subscriptionErrors.delete(key);
  }

  function flushSubscriptions() {
    for (const user of fillUsers) subscribeOne('userFills', user);
    for (const user of webDataUsers) subscribeOne('allDexsClearinghouseState', user);
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
        unsubscribeOne('allDexsClearinghouseState', user);
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

    if (msg.channel === 'subscriptionResponse') {
      const sub = msg.data?.subscription || msg.data;
      if (sub?.type && sub?.user && msg.data?.method !== 'unsubscribe') {
        const key = subKey(sub.type, sub.user);
        if (!activeSubs.has(key)) return;
        acknowledgedSubs.add(key);
        subscriptionErrors.delete(key);
        onStatus(getStatus());
      }
      return;
    }
    if (msg.channel === 'error' || msg.channel === 'subscriptionError') {
      let sub = msg.data?.subscription || msg.data?.subscriptionRequest || null;
      if (!sub && typeof msg.data === 'string') {
        try { sub = JSON.parse(msg.data.slice(msg.data.indexOf('{'))).subscription; } catch {}
      }
      if (sub?.type && sub?.user) {
        const key = subKey(sub.type, sub.user);
        acknowledgedSubs.delete(key);
        subscriptionErrors.set(key, {
          type: sub.type,
          user: String(sub.user).toLowerCase(),
          message: String((typeof msg.data === 'string' ? msg.data : '') || msg.data?.message || msg.data?.error || msg.error || '订阅被拒绝'),
          at: Date.now(),
        });
      } else {
        subscriptionErrors.set(`unknown:${Date.now()}`, {
          type: 'unknown', message: String((typeof msg.data === 'string' ? msg.data : '') || msg.data?.message || msg.data?.error || msg.error || 'WebSocket 返回错误'), at: Date.now(),
        });
      }
      while (subscriptionErrors.size > 100) subscriptionErrors.delete(subscriptionErrors.keys().next().value);
      onStatus(getStatus());
      return;
    }

    if (msg.channel === 'userFills' && msg.data) {
      const user = String(msg.data.user || '').toLowerCase();
      const fills = Array.isArray(msg.data.fills) ? msg.data.fills : [];
      const isSnapshot = Boolean(msg.data.isSnapshot);
      if (!activeSubs.has(subKey('userFills', user))) return;
      if (user) {
        const key = subKey('userFills', user);
        lastDataAt.set(key, Date.now());
        acknowledgedSubs.add(key);
        subscriptionErrors.delete(key);
      }
      const short = user ? `${user.slice(0, 6)}…${user.slice(-4)}` : 'unknown';
      pushSocket({
        kind: isSnapshot ? 'fill-snap' : 'fill',
        message: `userFills ${short} ×${fills.length}${isSnapshot ? ' · snapshot' : ''}`,
        detail: { user, count: fills.length, isSnapshot },
      });
      onFill({ user, fills, isSnapshot });
      onStatus(getStatus());
      return;
    }

    if (msg.channel === 'allDexsClearinghouseState' && msg.data) {
      const user = String(msg.data.user || '').toLowerCase();
      if (!activeSubs.has(subKey('allDexsClearinghouseState', user))) return;
      let state;
      try { state = rememberMarketSnapshot(user, msg.data.clearinghouseStates); }
      catch (err) { pushError({ source: 'hl-ws', message: err.message }); return; }
      if (user) {
        const key = subKey('allDexsClearinghouseState', user);
        lastDataAt.set(key, Date.now());
        acknowledgedSubs.add(key);
        subscriptionErrors.delete(key);
      }
      const short = user ? `${user.slice(0, 6)}…${user.slice(-4)}` : 'unknown';
      const posN = state.assetPositions.length;
      pushSocket({
        kind: 'webData',
        message: `allDexsClearinghouseState ${short}${posN != null ? ` · ${posN}仓` : ''}`,
        detail: { user, positions: posN },
      });
      onWebData({ user, data: { clearinghouseState: state } });
      onStatus(getStatus());
    }
  }

  function connect() {
    if (stopped) return;
    clearTimers();
    const connectionGeneration = ++generation;
    activeSubs.clear();
    sentAt.clear();
    attempts.clear();
    lastDataAt.clear();
    acknowledgedSubs.clear();
    subscriptionErrors.clear();
    connected = false;

    const url = resolveWsUrl();
    console.log(`[hl-ws] connecting ${url.replace(/key=[^&]+/i, 'key=***')}`);

    try {
      socket = new (handlers.WebSocket || WebSocket)(url);
    } catch (err) {
      console.warn('[hl-ws] create failed:', err.message);
      pushError({ source: 'hl-ws', message: `创建连接失败: ${err.message}` });
      scheduleReconnect();
      return;
    }

    const currentSocket = socket;
    socket.on('open', () => {
      if (connectionGeneration !== generation || stopped) return;
      connected = true; lastMessageAt = connectedAt = Date.now();
      console.log(`[hl-ws] connected fills=${fillUsers.size} allDexsClearinghouseState=${webDataUsers.size}`);
      pushSocket({
        kind: 'status',
        message: `WS 已连接 · fills=${fillUsers.size} allDexsClearinghouseState=${webDataUsers.size}`,
      });
      flushSubscriptions();
      pingTimer = setInterval(() => {
        if (connectionGeneration !== generation || stopped) return;
        const now = Date.now();
        const positionSilent = [...webDataUsers].some(user => now - (lastDataAt.get(subKey('allDexsClearinghouseState', user)) || sentAt.get(subKey('allDexsClearinghouseState', user)) || connectedAt) > 120000);
        if (now - lastMessageAt > 60000 || positionSilent) { currentSocket.terminate(); return; }
        send({ method: 'ping' });
        for (const [key, at] of sentAt) {
          if (!acknowledgedSubs.has(key) && Date.now() - at > 15000) {
            subscriptionErrors.set(key, { type: key.split(':')[0], message: '订阅确认超时', at });
            if (Date.now() - at > 30000 && (attempts.get(key) || 0) < 3) {
              const [type, user] = key.split(':');
              activeSubs.delete(key); subscribeOne(type, user);
            }
          }
        }
        onStatus(getStatus());
      }, PING_MS);
      onStatus(getStatus());
    });

    socket.on('message', (data) => {
      if (connectionGeneration !== generation || stopped) return;
      lastMessageAt = Date.now(); handleMessage(data);
    });
    socket.on('pong', () => { if (connectionGeneration === generation) lastMessageAt = Date.now(); });

    socket.on('close', () => {
      if (connectionGeneration !== generation || stopped) return;
      connected = false;
      activeSubs.clear();
      sentAt.clear();
      attempts.clear();
      lastDataAt.clear();
      acknowledgedSubs.clear();
      clearTimers();
      console.warn('[hl-ws] disconnected, reconnecting…');
      pushSocket({ kind: 'status', message: 'WS 断开，正在重连…' });
      onStatus(getStatus());
      scheduleReconnect();
    });

    socket.on('error', (err) => {
      if (connectionGeneration !== generation || stopped) return;
      console.warn('[hl-ws] error:', err.message || err);
      pushError({ source: 'hl-ws', message: String(err.message || err) });
    });
  }

  function start() {
    if (socket && !stopped) return;
    stopped = false;
    connect();
  }

  function stop() {
    stopped = true; generation++;
    clearTimers();
    try {
      socket?.close();
    } catch {
      // ignore
    }
    socket = null;
    connected = false;
    activeSubs.clear();
    sentAt.clear();
    attempts.clear();
    lastDataAt.clear();
    acknowledgedSubs.clear();
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
