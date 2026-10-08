/**
 * 上游 HL/GoldRush WS → 落库 / 缓存 / 广播浏览器
 */
const { createHlWsClient } = require('./hlWsClient');
const { broadcast, clientCount } = require('./realtimeHub');
const { pushError } = require('./opsMonitor');
const { mapFillToTrade, deriveDirection, isExoticAsset } = require('./hyperliquid');
const { readWhaleModeCache, commitWhaleState } = require('./cache');
const { normalizeAddress, getActiveWhales } = require('./config');
const { OPEN_KINDS, fillSourceId } = require('./positionEventPolicy');

const MODE = 'hf';
/** Hyperliquid 对 user-specific WS 订阅最多允许 10 个不同用户；两路订阅共用地址集合。 */
const USER_WS_ADDRESS_LIMIT = Math.max(1, Math.min(10, Number(process.env.HL_WS_USER_LIMIT) || 10));
const ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;
const ACTIVITY_HALF_LIFE_MS = 6 * 60 * 60 * 1000;
const MIN_SUBSCRIPTION_DWELL_MS = 5 * 60 * 1000;
const REPLACEMENT_SCORE_MULTIPLIER = 1.25;

/** @type {Map<string, object>} address(lower) -> whale */
const whalesByAddress = new Map();
/** @type {Map<string, object>} whaleId -> last positions snap for webData2 diff */
const positionSnapByWhale = new Map();
/** 最近真实成交用于把状态快照变化回连到执行时间；只保留短窗口内的小型内存索引。 */
const recentPositionFills = new Map();
/** @type {ReturnType<typeof createHlWsClient> | null} */
let client = null;
let started = false;
let lastStatus = { connected: false, fillSubs: 0, webDataSubs: 0 };
let liveAddressSelection = [];
let liveAddressSelectionChangedAt = 0;


function positionNotionalUsd(pos) {
  const v = Number(pos?.positionValue);
  if (Number.isFinite(v) && Math.abs(v) > 0) return Math.abs(v);
  return Math.abs((Number(pos?.size) || 0) * (Number(pos?.entryPx) || 0));
}

function recentOpenActivityScores(trades = [], now = Date.now()) {
  const scores = new Map();
  for (const trade of trades || []) {
    const time = Number(trade?.time) || 0;
    const usd = Math.abs(Number(trade?.amountUsd) || (Number(trade?.amount) || 0) * (Number(trade?.price) || 0));
    const startValue = trade?.startPosition;
    const start = startValue == null || startValue === '' ? NaN : Number(startValue);
    const side = String(trade?.side || '').toLowerCase();
    const isBuy = side === 'buy' || side === 'b' || side === 'in';
    const isSell = side === 'sell' || side === 'a' || side === 'out';
    if (!trade?.whaleId || !time || now - time < 0 || now - time > ACTIVITY_WINDOW_MS || usd < 1000 || !Number.isFinite(start)) continue;
    if (Math.abs(Number(trade?.closedPnl) || 0) > 1) continue;
    const isOpen = Math.abs(start) < 1e-8;
    const isIncrease = (start > 0 && isBuy) || (start < 0 && isSell);
    if (!isOpen && !isIncrease) continue;
    const weight = Math.exp(-Math.LN2 * (now - time) / ACTIVITY_HALF_LIFE_MS);
    const row = scores.get(String(trade.whaleId)) || { score: 0, weightedCount: 0, weightedUsd: 0, lastAt: 0 };
    row.score += weight * (1 + Math.min(3, Math.log10(Math.max(1, usd) / 1000)));
    row.weightedCount += weight;
    row.weightedUsd += weight * usd;
    row.lastAt = Math.max(row.lastAt, time);
    scores.set(String(trade.whaleId), row);
  }
  return scores;
}

function sortWhalesForDisplay(list, activityScores = new Map()) {
  return [...(list || [])].sort((a, b) => {
    const activeA = activityScores.get(String(a.id)) || { score: 0, weightedCount: 0, weightedUsd: 0 };
    const activeB = activityScores.get(String(b.id)) || { score: 0, weightedCount: 0, weightedUsd: 0 };
    if (activeB.score !== activeA.score) return activeB.score - activeA.score;
    if (activeB.weightedCount !== activeA.weightedCount) return activeB.weightedCount - activeA.weightedCount;
    if (activeB.weightedUsd !== activeA.weightedUsd) return activeB.weightedUsd - activeA.weightedUsd;
    const pa = Number(a.priority) || 0;
    const pb = Number(b.priority) || 0;
    if (pb !== pa) return pb - pa;
    const na = (a.positions || []).reduce((s, p) => s + positionNotionalUsd(p), 0);
    const nb = (b.positions || []).reduce((s, p) => s + positionNotionalUsd(p), 0);
    return nb - na;
  });
}

function pickLiveAddresses(whales, trades = [], now = Date.now()) {
  const scores = recentOpenActivityScores(trades, now);
  const eligible = sortWhalesForDisplay(whales, scores).filter((whale) =>
    (whale.positions || []).length > 0 || positionNotionalUsd({ positionValue: whale.netUsd }) || scores.has(String(whale.id)),
  );
  const addressToWhale = new Map();
  for (const whale of eligible) {
    const address = normalizeAddress(whale.address);
    if (address && !addressToWhale.has(address.toLowerCase())) addressToWhale.set(address.toLowerCase(), { address, whale });
  }
  const ideal = [...addressToWhale.values()].slice(0, USER_WS_ADDRESS_LIMIT).map((row) => row.address);
  if (!liveAddressSelection.length || !liveAddressSelection.some((address) => addressToWhale.has(address.toLowerCase()))) {
    liveAddressSelection = ideal;
    liveAddressSelectionChangedAt = now;
    return [...liveAddressSelection];
  }

  const selected = liveAddressSelection.filter((address) => addressToWhale.has(address.toLowerCase()));
  const selectedSet = new Set(selected.map((address) => address.toLowerCase()));
  for (const address of ideal) {
    if (selected.length >= USER_WS_ADDRESS_LIMIT) break;
    if (selectedSet.has(address.toLowerCase())) continue;
    selected.push(address);
    selectedSet.add(address.toLowerCase());
  }

  if (now - liveAddressSelectionChangedAt >= MIN_SUBSCRIPTION_DWELL_MS) {
    const candidates = [...addressToWhale.values()].filter((row) => !selectedSet.has(row.address.toLowerCase()));
    for (const candidate of candidates) {
      if (!selected.length) break;
      const weakestIndex = selected.reduce((weakest, address, index) => {
        const currentId = addressToWhale.get(address.toLowerCase())?.whale.id;
        const currentScore = scores.get(String(currentId))?.score || 0;
        const weakestId = addressToWhale.get(selected[weakest].toLowerCase())?.whale.id;
        const weakestScore = scores.get(String(weakestId))?.score || 0;
        return currentScore < weakestScore ? index : weakest;
      }, 0);
      const currentId = addressToWhale.get(selected[weakestIndex].toLowerCase())?.whale.id;
      const weakestScore = scores.get(String(currentId))?.score || 0;
      const candidateScore = scores.get(String(candidate.whale.id))?.score || 0;
      if (candidateScore < Math.max(1.25, weakestScore * REPLACEMENT_SCORE_MULTIPLIER)) break;
      selectedSet.delete(selected[weakestIndex].toLowerCase());
      selected[weakestIndex] = candidate.address;
      selectedSet.add(candidate.address.toLowerCase());
      liveAddressSelectionChangedAt = now;
    }
  }
  liveAddressSelection = selected;
  return [...liveAddressSelection];
}

function rebuildWhaleIndex(whales) {
  whalesByAddress.clear();
  for (const whale of whales || []) {
    const addr = normalizeAddress(whale.address);
    if (!addr) continue;
    whalesByAddress.set(addr.toLowerCase(), whale);
  }
}

function syncFromCache() {
  const cached = readWhaleModeCache(MODE);
  const activeIds = new Set(getActiveWhales().map(whale => whale.id));
  const whales = (Array.isArray(cached?.data?.whales) ? cached.data.whales : []).filter(whale => activeIds.has(whale.id));
  rebuildWhaleIndex(whales);
  // userFills + webData2 都属于 user-specific 订阅，使用同一组最多 10 个唯一地址。
  const liveAddresses = pickLiveAddresses(whales, cached?.data?.trades || []);
  const fillAddresses = liveAddresses;
  const webDataAddresses = liveAddresses;
  if (client) {
    client.syncSubscriptions({ fillAddresses, webDataAddresses });
  }
  return { whales: whales.length, fills: fillAddresses.length, webData: webDataAddresses.length, uniqueUsers: new Set([...fillAddresses, ...webDataAddresses]).size };
}

function appendTradesToCache(trades) {
  if (!trades?.length) return;
  return commitWhaleState(MODE, { trades });
}

function patchWhaleInCache(whaleId, patch, snapshotAlerts = []) {
  const cached = readWhaleModeCache(MODE);
  const current = cached?.data?.whales?.find(w => w.id === whaleId);
  if (!current) return null;
  const result = commitWhaleState(MODE, { whales: [{ ...current, ...patch }], snapshotAlerts });
  require('./whaleSync').markLiveAlerts(result.committedAlerts || []);
  const next = result.data.whales.find(w => w.id === whaleId);
  if (next) whalesByAddress.set(normalizeAddress(next.address).toLowerCase(), next);
  return next;
}

/**
 * 单笔 fill → 开/加/减/平异动。
 * HL：B=买、A=卖；结合 startPosition 判断：
 * - 多仓再买=加多，卖=减/平多
 * - 空仓再卖=加空，买=减/平空
 * 翻仓（dir 含 >）交给仓位 diff。
 */
function alertFromLiveFill(whale, fill, trade) {
  if (!whale || !trade) return null;
  const rawCoin = String(trade.asset || fill.coin || '').trim();
  const coin = String(trade.assetLabel || trade.asset || fill.coin || '').trim();
  if (!coin) return null;
  // 跳过 HIP-3 美股等（xyz:SNDK）——与主仓位路径一致，不进异动/跟单
  if (isExoticAsset(rawCoin) || isExoticAsset(coin) || Boolean(trade.exotic)) return null;

  const dir = String(fill.dir || trade.dir || '');
  if (/>/.test(dir)) return null;

  const startValue = fill.startPosition != null ? fill.startPosition : trade.startPosition;
  const start = startValue == null || startValue === '' ? NaN : Number(startValue);
  const buy = trade.side === 'buy' || fill.side === 'B';
  const eps = 1e-8;
  const fillSz = Math.abs(Number(fill.sz ?? fill.size ?? trade.size) || 0);
  const px = Number(trade.price) || Number(fill.px) || 0;
  const usd = Math.abs(Number(trade.amountUsd) || (fillSz * px) || 0);

  let side = null;
  let kind = null;
  let prevUsd = 0;
  let remainingUsd = 0;

  if (Number.isFinite(start)) {
    if (Math.abs(start) < eps) {
      kind = 'open';
      side = buy ? 'long' : 'short';
    } else if (start > 0) {
      side = 'long';
      if (buy) {
        kind = 'increase';
        prevUsd = px > 0 ? start * px : 0;
        remainingUsd = px > 0 ? (start + fillSz) * px : 0;
      } else {
        const remainSz = Math.max(0, start - fillSz);
        kind = remainSz <= eps || remainSz / start < 0.02 ? 'close' : 'decrease';
        prevUsd = px > 0 ? start * px : usd + remainSz * px;
        remainingUsd = px > 0 ? remainSz * px : Math.max(0, prevUsd - usd);
      }
    } else {
      side = 'short';
      const startAbs = Math.abs(start);
      if (!buy) {
        kind = 'increase';
        prevUsd = px > 0 ? startAbs * px : 0;
        remainingUsd = px > 0 ? (startAbs + fillSz) * px : 0;
      } else {
        const remainSz = Math.max(0, startAbs - fillSz);
        kind = remainSz <= eps || remainSz / startAbs < 0.02 ? 'close' : 'decrease';
        prevUsd = px > 0 ? startAbs * px : usd + remainSz * px;
        remainingUsd = px > 0 ? remainSz * px : Math.max(0, prevUsd - usd);
      }
    }
  } else if (/close|reduce/i.test(dir)) {
    // dir 明确减/平，但无 startPosition：尽量推断方向
    if (/short/i.test(dir)) side = 'short';
    else if (/long/i.test(dir)) side = 'long';
    else side = buy ? 'short' : 'long'; // 买平空 / 卖平多
    kind = /close/i.test(dir) ? 'close' : 'decrease';
  } else {
    // startPosition 缺失时，Open Long/Short 无法区分新开仓与加仓；等待仓位快照 diff。
    return null;
  }

  if (!kind || !side) return null;
  // 注意：HL 加仓的 dir 也经常是 "Open Long/Short"，不能据此把 increase 改成 open。
  // 有 startPosition 时以仓位变化为准；无 start 时上面分支已按 dir 判定。

  const kindLabel =
    kind === 'open' ? '开单' : kind === 'increase' ? '加仓' : kind === 'decrease' ? '减仓' : '平仓';
  const title =
    kind === 'open'
      ? side === 'long'
        ? `开多 ${coin}`
        : `开空 ${coin}`
      : kind === 'increase'
        ? `加仓 ${coin}`
        : kind === 'decrease'
          ? `减仓 ${coin}`
          : `平仓 ${coin}`;
  const ts = Number(trade.time) || Date.now();
  return {
    id: `ws-${kind}-${whale.id}-${coin}-${trade.id || ts}`,
    sourceId: fillSourceId(trade),
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
        evidenceSource: 'fill',
        coin,
        side,
        usd,
        prevUsd: prevUsd || undefined,
        remainingUsd: remainingUsd || undefined,
        time: ts,
        price: trade.price ?? null,
      },
    ],
  };
}

function rememberPositionFill(whale, trade) {
  const start = trade?.startPosition == null ? NaN : Number(trade.startPosition);
  if (Math.abs(Number(trade.closedPnl) || 0) > 1) return;
  const isBuy = trade.side === 'buy';
  const kind = !Number.isFinite(start)
    ? 'unknown'
    : Math.abs(start) < 1e-8
      ? 'open'
      : ((start > 0 && isBuy) || (start < 0 && !isBuy) ? 'increase' : null);
  if (!kind) return;
  const side = !Number.isFinite(start) || Math.abs(start) < 1e-8 ? (isBuy ? 'long' : 'short') : (start > 0 ? 'long' : 'short');
  const key = String(whale.id);
  const now = Date.now();
  const rows = (recentPositionFills.get(key) || []).filter((row) => now - row.receivedAt < 10 * 60_000);
  rows.push({ coin: String(trade.asset || '').toUpperCase(), side, kind, size: Math.abs(Number(trade.amount) || 0), time: Number(trade.time) || now, receivedAt: now, id: String(trade.id || '') });
  recentPositionFills.set(key, rows.slice(-500));
}

function matchSnapshotExecution(whale, pos, kind, deltaSize) {
  const now = Date.now();
  const rows = recentPositionFills.get(String(whale.id)) || [];
  const candidates = rows.filter((row) =>
    !row.used && row.coin === String(pos.coin || '').toUpperCase() && row.side === pos.side &&
    (row.kind === kind || row.kind === 'unknown') && now - row.receivedAt <= 120_000 && Math.abs(now - row.time) <= 120_000,
  );
  if (!candidates.length) return null;
  let total = 0;
  const matched = [];
  for (const row of candidates) {
    total += row.size;
    matched.push(row);
    if (total >= deltaSize * 0.85) break;
  }
  if (Math.abs(total - deltaSize) > Math.max(deltaSize * 0.15, 1e-8)) return null;
  for (const row of matched) row.used = true;
  return Math.max(...matched.map((row) => row.time));
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
    // 与 deriveDirection 一致：排除 @index / xyz:美股 等 HIP-3
    if (isExoticAsset(coin)) continue;
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
  const nextMap = new Map(
    (nextPositions || []).map((p) => [`${String(p.coin).toUpperCase()}:${p.side}`, p]),
  );
  const alerts = [];
  const now = Date.now();

  const pushAlert = (kind, pos, extras = {}) => {
    const coin = pos.coin;
    const side = pos.side;
    const title =
      kind === 'open'
        ? side === 'long'
          ? `开多 ${coin}`
          : `开空 ${coin}`
        : kind === 'increase'
          ? `加仓 ${coin}`
          : kind === 'decrease'
            ? `减仓 ${coin}`
            : `平仓 ${coin}`;
    const kindLabel =
      kind === 'open' ? '开单' : kind === 'increase' ? '加仓' : kind === 'decrease' ? '减仓' : '平仓';
    const key = `${String(coin).toUpperCase()}:${side}`;
    const knownTime = Number(extras.executionTime) || (kind === 'open' ? Number(pos.openTime) : 0);
    const eventTime = knownTime || now;
    const timeSource = knownTime ? 'execution' : 'observed';
    alerts.push({
      id: `ws-pos-${kind}-${whale.id}-${key}-${now}`,
      at: eventTime,
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
          evidenceSource: 'snapshot',
          timeSource,
          coin,
          side,
          usd: extras.usd ?? positionNotionalUsd(pos),
          prevUsd: extras.prevUsd,
          remainingUsd: extras.remainingUsd,
          time: eventTime,
          price: pos.entryPx || pos.markPx || null,
          leverage: pos.leverage,
        },
      ],
    });
  };

  for (const pos of nextPositions || []) {
    const key = `${String(pos.coin).toUpperCase()}:${pos.side}`;
    const prev = prevMap.get(key);
    const usd = positionNotionalUsd(pos);
    const currentSize = Math.abs(Number(pos.size) || 0);
    if (usd < 1) continue;
    if (!prev) {
      pushAlert('open', pos, { usd, executionTime: matchSnapshotExecution(whale, pos, 'open', currentSize) });
      continue;
    }
    const prevUsd = positionNotionalUsd(prev);
    const previousSize = Math.abs(Number(prev.size) || 0);
    const deltaSize = Math.abs(currentSize - previousSize);
    // positionValue 随 mark price 变化；只能用仓位数量变化认定加/减仓，
    // 否则单纯的行情涨跌会伪装成仓位异动。
    const unitUsd = currentSize > 0 ? usd / currentSize : 0;
    const deltaUsd = deltaSize * unitUsd;
    if (currentSize > previousSize && deltaSize > previousSize * 0.04 && deltaUsd > 50) {
      const previousAtCurrentPrice = Math.max(0, currentSize - deltaSize) * unitUsd;
      const matchedTime = matchSnapshotExecution(whale, pos, 'increase', deltaSize);
      const knownAddTime = Number(pos.lastAddTime) > Number(prev.lastAddTime || 0) ? Number(pos.lastAddTime) : 0;
      pushAlert('increase', pos, {
        usd: deltaUsd,
        prevUsd: previousAtCurrentPrice || prevUsd,
        remainingUsd: usd,
        executionTime: matchedTime || knownAddTime,
      });
    } else if (currentSize < previousSize && deltaSize > previousSize * 0.04 && deltaUsd > 50) {
      pushAlert('decrease', pos, {
        usd: deltaUsd,
        prevUsd,
        remainingUsd: usd,
      });
    }
  }

  // 上一轮有仓、本轮消失 → 平仓
  for (const prev of prevPositions || []) {
    const key = `${String(prev.coin).toUpperCase()}:${prev.side}`;
    if (nextMap.has(key)) continue;
    const prevUsd = positionNotionalUsd(prev);
    if (prevUsd < 1) continue;
    pushAlert('close', prev, { usd: prevUsd, prevUsd, remainingUsd: 0 });
  }

  return alerts;
}

function handleFills({ user, fills, isSnapshot }) {
  if (!user || !fills?.length) return;
  const whale = whalesByAddress.get(String(user).toLowerCase());
  if (!whale) return;

  const trades = [];
  for (const fill of fills) {
    const trade = mapFillToTrade(fill, whale, {});
    if (!trade?.id) continue;
    trades.push(trade);
    rememberPositionFill(whale, trade);
  }
  if (!trades.length) return;

  try {
    const result = appendTradesToCache(trades);
    if (!isSnapshot) require('./whaleSync').markLiveAlerts(result?.committedAlerts || []);
  } catch (err) {
    console.warn('[realtime] cache trades failed:', err.message);
    pushError({ source: 'realtime', message: `成交缓存失败: ${err.message}` });
    return;
  }

  if (!isSnapshot) {
    for (const trade of trades) {
      broadcast({ type: 'fill', trade, at: Date.now() });
    }
  }
}

function handleWebData({ user, data }) {
  const state = data?.clearinghouseState || data;
  // A partial heartbeat/account message is not evidence that positions closed.
  if (!state || !Array.isArray(state.assetPositions)) return;
  const addr = String(user || '').toLowerCase();
  let whale = addr ? whalesByAddress.get(addr) : null;
  // webData2 有时不带 user，用订阅集合反查困难；尝试从 clearinghouse
  if (!whale && data?.clearinghouseState) {
    // 无法可靠匹配则跳过
    return;
  }
  if (!whale) return;

  const hadRealtimeBaseline = positionSnapByWhale.has(whale.id);
  const prev = positionSnapByWhale.get(whale.id) || whale.positions || [];
  const positions = mergePositionMeta(
    mapAssetPositions(state),
    prev,
  );
  const derived = deriveDirection(state);
  const longUsd = Number(derived?.longUsd) || positions.filter((p) => p.side === 'long').reduce((s, p) => s + positionNotionalUsd(p), 0);
  const shortUsd = Number(derived?.shortUsd) || positions.filter((p) => p.side === 'short').reduce((s, p) => s + positionNotionalUsd(p), 0);
  const direction = derived?.direction || (longUsd >= shortUsd ? 'long' : shortUsd > longUsd ? 'short' : 'neutral');
  const patch = {
    positionObservedAt: Date.now(),
    positionSource: 'websocket',
    positionScope: 'native-perp',
    positions,
    longUsd,
    shortUsd,
    netUsd: longUsd - shortUsd,
    direction,
    error: null,
  };

  const fillUsage = (recentPositionFills.get(String(whale.id)) || []).map(row => [row, row.used]);
  let committed = false;
  try {
    const snapshotAlerts = hadRealtimeBaseline ? alertsFromPositionDiff(whale, prev, positions) : [];
    if (!patchWhaleInCache(whale.id, patch, snapshotAlerts.filter(a => OPEN_KINDS.has(a.kind)))) return;
    committed = true;
    positionSnapByWhale.set(whale.id, positions);
  } catch (err) {
    pushError({ source: 'realtime', message: '仓位提交失败: ' + err.message });
  } finally {
    // Matching execution evidence is consumed only with the durable position diff.
    if (!committed) for (const [row, used] of fillUsage) row.used = used;
  }
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
    userAddressLimit: USER_WS_ADDRESS_LIMIT,
    browserClients: clientCount(),
  };
}

function getWhaleByAddress(address) {
  const key = String(address || '')
    .trim()
    .toLowerCase();
  if (!key) return null;
  return whalesByAddress.get(key) || null;
}

module.exports = {
  startRealtimeBridge,
  syncFromCache,
  isRealtimeConnected,
  getRealtimeStatus,
  getWhaleByAddress,
  // Exported for deterministic tests of the position/fill event classifiers.
  alertsFromPositionDiff,
  alertFromLiveFill,
  rememberPositionFill,
  pickLiveAddresses,
};
