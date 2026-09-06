/**
 * 上游 HL/GoldRush WS → 落库 / 缓存 / 广播浏览器
 */
const { createHlWsClient } = require('./hlWsClient');
const { broadcast, clientCount } = require('./realtimeHub');
const { pushError } = require('./opsMonitor');
const { mapFillToTrade, deriveDirection } = require('./hyperliquid');
const { readWhaleModeCache, writeWhaleModeCache } = require('./cache');
const { persistAlerts, persistTradesIncremental } = require('./sqliteStore');
const { normalizeAddress } = require('./config');

const MODE = 'hf';
const DISPLAY_TOP_N = 20;
/** userFills 订阅上限：仅有仓地址，按仓位优先截断 */
const FILL_SUB_TOP_N = Math.max(
  20,
  Math.min(120, Number(process.env.FILL_SUB_TOP_N) || 60),
);
const FILL_SUB_MIN_USD = Math.max(0, Number(process.env.FILL_SUB_MIN_USD) || 1000);
const MAX_CACHE_TRADES = 4000;
const SKIP_FILL_SNAPSHOT = process.env.HL_WS_APPLY_SNAPSHOT === '1' ? false : true;
const CACHE_FLUSH_MS = 2_000;

/** @type {Map<string, object>} address(lower) -> whale */
const whalesByAddress = new Map();
/** @type {Map<string, object>} whaleId -> last positions snap for webData2 diff */
const positionSnapByWhale = new Map();
/** @type {ReturnType<typeof createHlWsClient> | null} */
let client = null;
let started = false;
let lastStatus = { connected: false, fillSubs: 0, webDataSubs: 0 };

/** @type {object[]} */
let pendingCacheTrades = [];
let cacheFlushTimer = null;

function positionNotionalUsd(pos) {
  const v = Number(pos?.positionValue);
  if (Number.isFinite(v) && Math.abs(v) > 0) return Math.abs(v);
  return Math.abs((Number(pos?.size) || 0) * (Number(pos?.entryPx) || 0));
}

function sortWhalesForDisplay(list) {
  return [...(list || [])].sort((a, b) => {
    const pa = Number(a.priority) || 0;
    const pb = Number(b.priority) || 0;
    if (pb !== pa) return pb - pa;
    const na = (a.positions || []).reduce((s, p) => s + positionNotionalUsd(p), 0);
    const nb = (b.positions || []).reduce((s, p) => s + positionNotionalUsd(p), 0);
    return nb - na;
  });
}

function rebuildWhaleIndex(whales) {
  whalesByAddress.clear();
  for (const whale of whales || []) {
    const addr = normalizeAddress(whale.address);
    if (!addr) continue;
    whalesByAddress.set(addr.toLowerCase(), whale);
  }
}

function pickTopAddresses(whales, limit = DISPLAY_TOP_N) {
  return sortWhalesForDisplay(whales)
    .filter((w) => (w.positions || []).length > 0 || positionNotionalUsd({ positionValue: w.netUsd }))
    .slice(0, limit)
    .map((w) => normalizeAddress(w.address))
    .filter(Boolean);
}

/** 成交 WS：只订有实质仓位的地址，不再全名单 200 订阅 */
function pickFillAddresses(whales, limit = FILL_SUB_TOP_N) {
  return sortWhalesForDisplay(whales)
    .filter((w) =>
      (w.positions || []).some((p) => positionNotionalUsd(p) >= FILL_SUB_MIN_USD),
    )
    .slice(0, limit)
    .map((w) => normalizeAddress(w.address))
    .filter(Boolean);
}

function syncFromCache() {
  const cached = readWhaleModeCache(MODE);
  const whales = Array.isArray(cached?.data?.whales) ? cached.data.whales : [];
  rebuildWhaleIndex(whales);
  const fillAddresses = pickFillAddresses(whales, FILL_SUB_TOP_N);
  const webDataAddresses = pickTopAddresses(whales, DISPLAY_TOP_N);
  if (client) {
    client.syncSubscriptions({ fillAddresses, webDataAddresses });
  }
  return { whales: whales.length, fills: fillAddresses.length, webData: webDataAddresses.length };
}

function appendTradesToCache(trades) {
  if (!trades?.length) return;
  pendingCacheTrades.push(...trades);
  try {
    persistTradesIncremental(trades);
  } catch (err) {
    console.warn('[realtime] persist trades failed:', err.message);
  }
  if (cacheFlushTimer) return;
  cacheFlushTimer = setTimeout(() => {
    cacheFlushTimer = null;
    const batch = pendingCacheTrades;
    pendingCacheTrades = [];
    if (!batch.length) return;
    try {
      const cached = readWhaleModeCache(MODE);
      if (!cached?.data) return;
      const prev = Array.isArray(cached.data.trades) ? cached.data.trades : [];
      const tradeCutoff = Date.now() - Math.max(
        24 * 60 * 60 * 1000,
        (Number(process.env.FILL_RETENTION_DAYS) || 3) * 24 * 60 * 60 * 1000,
      );
      const seen = new Set(prev.map((t) => String(t?.id || '')));
      const merged = [...batch.filter((t) => t?.id && !seen.has(String(t.id))), ...prev]
        .filter((t) => (Number(t?.time) || 0) >= tradeCutoff)
        .sort((a, b) => Number(b.time || 0) - Number(a.time || 0))
        .slice(0, MAX_CACHE_TRADES);
      // 只写 JSON，避免每次都全量 sqlite whales
      const { writeCache, whaleCacheName } = require('./cache');
      writeCache(whaleCacheName(MODE), { ...cached.data, trades: merged });
    } catch (err) {
      console.warn('[realtime] cache trades flush failed:', err.message);
    }
  }, CACHE_FLUSH_MS);
}

function patchWhaleInCache(whaleId, patch) {
  const cached = readWhaleModeCache(MODE);
  if (!cached?.data?.whales) return null;
  const whales = cached.data.whales.map((w) => {
    if (w.id !== whaleId) return w;
    const next = { ...w, ...patch };
    whalesByAddress.set(normalizeAddress(next.address).toLowerCase(), next);
    return next;
  });
  writeWhaleModeCache(MODE, { ...cached.data, whales });
  return whales.find((w) => w.id === whaleId) || null;
}

/**
 * 单笔 fill → 开/加仓异动。
 * HL：B=买、A=卖；必须结合 startPosition 判断是加多还是平空（买），加空还是平多（卖）。
 * 旧逻辑「买=多、卖=空」会把「减多」误报成「做空加仓」。
 */
function alertFromLiveFill(whale, fill, trade) {
  if (!whale || !trade) return null;
  const coin = String(trade.assetLabel || trade.asset || fill.coin || '').trim();
  if (!coin) return null;

  const dir = String(fill.dir || trade.dir || '');
  // 明确平仓/减仓、或一笔翻仓，不从 fill 出开/加异动（翻仓靠仓位 diff）
  if (/close|reduce/i.test(dir)) return null;
  if (/>/.test(dir)) return null;

  const start = Number(fill.startPosition ?? trade.startPosition);
  const buy = trade.side === 'buy' || fill.side === 'B';
  const eps = 1e-8;

  let side = null;
  let kind = 'increase';

  if (Number.isFinite(start)) {
    if (Math.abs(start) < eps) {
      kind = 'open';
      side = buy ? 'long' : 'short';
    } else if (start > 0) {
      // 原多仓：只有继续买才是加多；卖是减/平多
      if (!buy) return null;
      side = 'long';
    } else {
      // 原空仓：只有继续卖才是加空；买是减/平空
      if (buy) return null;
      side = 'short';
    }
  } else if (/open\s*short|short\s*open/i.test(dir) || (/short/i.test(dir) && /open|add/i.test(dir))) {
    side = 'short';
    if (/open/i.test(dir)) kind = 'open';
  } else if (/open\s*long|long\s*open/i.test(dir) || (/long/i.test(dir) && /open|add/i.test(dir))) {
    side = 'long';
    if (/open/i.test(dir)) kind = 'open';
  } else {
    // 无 startPosition / 无可靠 dir：宁可不报，避免买=多卖=空误伤
    return null;
  }

  if (/open/i.test(dir)) kind = 'open';

  const kindLabel = kind === 'open' ? '开单' : '加仓';
  const title =
    kind === 'open'
      ? side === 'long'
        ? `开多 ${coin}`
        : `开空 ${coin}`
      : `加仓 ${coin}`;
  const ts = Number(trade.time) || Date.now();
  const usd = Math.abs(Number(trade.amountUsd) || 0);
  return {
    id: `ws-${kind}-${whale.id}-${coin}-${trade.id || ts}`,
    at: ts,
    whaleId: whale.id,
    whaleName: whale.name,
    address: whale.address,
    kind,
    kindLabel,
    headline: title,
    layer: 'position',
    items: [
      {
        kind,
        title,
        detail: '',
        coin,
        side,
        usd,
        time: ts,
        price: trade.price ?? null,
      },
    ],
  };
}

function mapAssetPositions(clearinghouseState) {
  const rows = clearinghouseState?.assetPositions || [];
  const positions = [];
  for (const row of rows) {
    const pos = row?.position || row;
    if (!pos) continue;
    const szi = Number(pos.szi) || 0;
    if (!szi) continue;
    const coin = String(pos.coin || '').trim();
    if (!coin) continue;
    const side = szi > 0 ? 'long' : 'short';
    const size = Math.abs(szi);
    const entryPx = Number(pos.entryPx) || 0;
    const positionValue = Math.abs(Number(pos.positionValue) || size * entryPx);
    const leverage =
      pos.leverage && typeof pos.leverage === 'object'
        ? Number(pos.leverage.value) || null
        : Number(pos.leverage) || null;
    positions.push({
      coin,
      side,
      size,
      entryPx,
      positionValue,
      unrealizedPnl: Number(pos.unrealizedPnl) || 0,
      leverage,
      marginUsed: Number(pos.marginUsed) || null,
      openTime: null,
    });
  }
  return positions;
}

/** webData2 快照不含开仓明细：同币同向继承上一轮的 entryFills / 开仓时间 */
function mergePositionMeta(nextPositions, prevPositions = []) {
  const prevMap = new Map(
    (prevPositions || []).map((p) => [`${String(p.coin).toUpperCase()}:${p.side}`, p]),
  );
  return (nextPositions || []).map((pos) => {
    const prev = prevMap.get(`${String(pos.coin).toUpperCase()}:${pos.side}`);
    if (!prev) return pos;
    return {
      ...pos,
      coinLabel: pos.coinLabel || prev.coinLabel,
      liquidationPx: pos.liquidationPx ?? prev.liquidationPx ?? null,
      openTime: Number(pos.openTime) || Number(prev.openTime) || null,
      firstOpenTime:
        Number(pos.firstOpenTime) || Number(prev.firstOpenTime) || Number(prev.openTime) || null,
      lastAddTime: Number(pos.lastAddTime) || Number(prev.lastAddTime) || null,
      openHistoryComplete:
        pos.openHistoryComplete != null ? pos.openHistoryComplete : prev.openHistoryComplete,
      entryFills:
        Array.isArray(pos.entryFills) && pos.entryFills.length
          ? pos.entryFills
          : prev.entryFills,
      entryFillsOmitted:
        pos.entryFillsOmitted != null ? pos.entryFillsOmitted : prev.entryFillsOmitted,
      takeProfit: pos.takeProfit ?? prev.takeProfit,
      stopLoss: pos.stopLoss ?? prev.stopLoss,
      leverageLabel: pos.leverageLabel || prev.leverageLabel,
    };
  });
}

function alertsFromPositionDiff(whale, prevPositions, nextPositions) {
  const prevMap = new Map(
    (prevPositions || []).map((p) => [`${String(p.coin).toUpperCase()}:${p.side}`, p]),
  );
  const alerts = [];
  const now = Date.now();
  for (const pos of nextPositions || []) {
    const key = `${String(pos.coin).toUpperCase()}:${pos.side}`;
    const prev = prevMap.get(key);
    const usd = positionNotionalUsd(pos);
    if (usd < 1) continue;
    let kind = null;
    let title = '';
    if (!prev) {
      kind = 'open';
      title = pos.side === 'long' ? `开多 ${pos.coin}` : `开空 ${pos.coin}`;
    } else {
      const prevUsd = positionNotionalUsd(prev);
      if (usd > prevUsd * 1.04 && usd - prevUsd > 50) {
        kind = 'increase';
        title = `加仓 ${pos.coin}`;
      }
    }
    if (!kind) continue;
    alerts.push({
      id: `ws-pos-${kind}-${whale.id}-${key}-${now}`,
      at: now,
      whaleId: whale.id,
      whaleName: whale.name,
      address: whale.address,
      kind,
      kindLabel: kind === 'open' ? '开单' : '加仓',
      headline: title,
      layer: 'position',
      items: [
        {
          kind,
          title,
          detail: '',
          coin: pos.coin,
          side: pos.side,
          usd,
          time: now,
          price: pos.entryPx || null,
          leverage: pos.leverage,
        },
      ],
    });
  }
  return alerts;
}

function emitAlerts(alerts) {
  if (!alerts?.length) return;
  try {
    persistAlerts(alerts);
  } catch (err) {
    console.warn('[realtime] persistAlerts failed:', err.message);
  }
  for (const alert of alerts) {
    broadcast({ type: 'alert', alert, at: Date.now() });
  }
}

function handleFills({ user, fills, isSnapshot }) {
  if (!user || !fills?.length) return;
  if (isSnapshot && SKIP_FILL_SNAPSHOT) return;
  const whale = whalesByAddress.get(String(user).toLowerCase());
  if (!whale) return;

  const trades = [];
  const alerts = [];
  for (const fill of fills) {
    const trade = mapFillToTrade(fill, whale, {});
    if (!trade?.id) continue;
    trades.push(trade);
    const alert = alertFromLiveFill(whale, fill, trade);
    if (alert) alerts.push(alert);
  }
  if (!trades.length) return;

  try {
    appendTradesToCache(trades);
  } catch (err) {
    console.warn('[realtime] cache trades failed:', err.message);
    pushError({ source: 'realtime', message: `成交缓存失败: ${err.message}` });
  }

  for (const trade of trades) {
    broadcast({ type: 'fill', trade, at: Date.now() });
  }
  emitAlerts(alerts);
}

function handleWebData({ user, data }) {
  const addr = String(user || '').toLowerCase();
  let whale = addr ? whalesByAddress.get(addr) : null;
  // webData2 有时不带 user，用订阅集合反查困难；尝试从 clearinghouse
  if (!whale && data?.clearinghouseState) {
    // 无法可靠匹配则跳过
    return;
  }
  if (!whale) return;

  const prev = positionSnapByWhale.get(whale.id) || whale.positions || [];
  const positions = mergePositionMeta(
    mapAssetPositions(data.clearinghouseState || data),
    prev,
  );
  positionSnapByWhale.set(whale.id, positions);

  const derived = deriveDirection(data.clearinghouseState || { assetPositions: [] });
  const longUsd = Number(derived?.longUsd) || positions.filter((p) => p.side === 'long').reduce((s, p) => s + positionNotionalUsd(p), 0);
  const shortUsd = Number(derived?.shortUsd) || positions.filter((p) => p.side === 'short').reduce((s, p) => s + positionNotionalUsd(p), 0);
  const direction = derived?.direction || (longUsd >= shortUsd ? 'long' : shortUsd > longUsd ? 'short' : 'neutral');
  const patch = {
    positions,
    longUsd,
    shortUsd,
    netUsd: longUsd - shortUsd,
    direction,
    error: null,
  };

  const updated = patchWhaleInCache(whale.id, patch);
  broadcast({
    type: 'whalePatch',
    whaleId: whale.id,
    patch: updated || { id: whale.id, ...patch },
    at: Date.now(),
  });

  const alerts = alertsFromPositionDiff(whale, prev, positions);
  emitAlerts(alerts);
}

function startRealtimeBridge() {
  if (started) return client;
  started = true;
  client = createHlWsClient({
    onFill: handleFills,
    onWebData: handleWebData,
    onStatus: (status) => {
      lastStatus = status;
    },
  });
  client.start();
  const synced = syncFromCache();
  console.log(
    `[realtime] bridge started whales=${synced.whales} fillSubs=${synced.fills} webData2=${synced.webData}`,
  );
  // 缓存刷新后重新订阅
  setInterval(() => {
    try {
      syncFromCache();
    } catch (err) {
      console.warn('[realtime] resync failed:', err.message);
    }
  }, 60_000);
  return client;
}

function isRealtimeConnected() {
  return Boolean(client?.isConnected());
}

function getRealtimeStatus() {
  return {
    ...lastStatus,
    ...(client?.getStatus() || {}),
    browserClients: clientCount(),
  };
}

module.exports = {
  startRealtimeBridge,
  syncFromCache,
  isRealtimeConnected,
  getRealtimeStatus,
};
