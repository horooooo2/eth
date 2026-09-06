const { readConfig, normalizeAddress, sortWhales, normalizeMode, getActiveWhales } = require('./config');
const { readWhaleModeCache, writeWhaleModeCache, clearWhaleModeCache } = require('./cache');
const { fetchWhaleAlerts, attachWatchedWhale, MIN_USD } = require('./onchain');
const {
  fetchClearinghouseState,
  fetchBatchClearinghouseStates,
  fetchUserFills,
  fetchUserFillsByTime,
  fetchUserFillsByCoin,
  fetchUserNonFundingLedgerUpdates,
  resolveFillsForPosition,
  fetchAllMids,
  fetchSpotClearinghouseState,
  fetchCoinNameMap,
  deriveDirection,
  mapFillToTrade,
  mapAndFilterFills,
  normalizeToHlFill,
  computeSideWinRates,
  computeTopCoins,
  findPerpPosition,
  findSpotBalance,
  inferOpenTime,
  inferPositionEntries,
  buildPositionEntryFills,
  buildPositionOpenTiming,
  analyzePositionEntries,
  coinLabel,
  isExoticAsset,
  explorerUrl,
  fetchFrontendOpenOrders,
  extractTpslForCoin,
  FILL_LOOKBACK_MS,
} = require('./hyperliquid');
const { getHlInfoConfig, MAX_CONCURRENT } = require('./hlInfoClient');

const WHALE_MODES = ['hf'];
/** 共振扫描最长窗口 24h，活动流按时间保留而非仅取全局最新 N 条 */
const ACTIVITY_WINDOW_MS = Math.max(
  24 * 60 * 60 * 1000,
  (Number(process.env.FILL_RETENTION_DAYS) || 1) * 24 * 60 * 60 * 1000,
);
const ACTIVITY_MAX = 3000;
/** 并发拉取 HL 仓位；GoldRush 下跟随 hlInfoClient 并发 */
const WHALE_SNAPSHOT_CONCURRENCY = Math.max(
  2,
  Math.min(12, Number(process.env.WHALE_SNAPSHOT_CONCURRENCY) || MAX_CONCURRENT),
);
const WHALE_BATCH_DEFAULT = 12;
const WHALE_BATCH_MAX = 30;
/** 定时刷新每轮更新一批；待补齐时用更大分片加快首屏 */
const WHALE_SHARD_SIZE = Math.max(4, Math.min(30, Number(process.env.WHALE_SHARD_SIZE) || 10));
/**
 * 名单已完整时，分片刷新最小间隔（毫秒）。
 * 默认 5 分钟（有 WS 时 REST 仅兜底）；可用 REFRESH_INTERVAL 覆盖。
 * 仍有「等待刷新」占位时不节流。
 */
const SHARD_REFRESH_MIN_INTERVAL_MS = Math.max(
  30_000,
  Number(process.env.REFRESH_INTERVAL_MS || process.env.REFRESH_INTERVAL) || 300_000,
);
/** 每轮分片中优先刷新「有仓 / 高 priority」的比例 */
const HOT_SHARD_RATIO = Math.min(0.9, Math.max(0.4, Number(process.env.HOT_SHARD_RATIO) || 0.7));
let whalesInflightByMode = { hf: null };
let whalesGenerationByMode = { hf: 0 };
/** 分段加载会话：按 offset 累加快照，完成后写入完整缓存 */
let progressiveSession = null;
/** 仅批次进行中让路；批间允许分片并行补齐 */
const PROGRESSIVE_ACTIVE_MS = 90 * 1000;
/** 分片轮转：冷门地址游标；热门按「距上次刷新时长 + 权重」选 */
let shardCursor = 0;
let shardInflight = null;
let shardOnchainAt = 0;
let lastShardRefreshAt = 0;
/** whaleId → 上次分片成功刷新时间 */
const lastShardAtById = new Map();
const SHARD_ONCHAIN_TTL_MS = 2 * 60 * 1000;

/** 前端正在打某一批时分片让路；批与批之间不再堵 3 分钟 */
function isProgressiveLoading() {
  if (!progressiveSession) return false;
  const activeAt = Number(progressiveSession.activeAt) || 0;
  return activeAt > 0 && Date.now() - activeAt < PROGRESSIVE_ACTIVE_MS;
}

function formatCachedBatchPayload(cached, mode) {
  const pending = countPendingWhales(cached.data.whales);
  const incomplete = pending > 0;
  const { trades, ...rest } = cached.data;
  return {
    ...rest,
    trades,
    activity: buildActivityFeed(trades),
    progressive: incomplete,
    loaded: Math.max(0, cached.data.whales.length - pending),
    total: cached.data.whales.length,
    offset: 0,
    nextOffset: incomplete
      ? findFirstPendingOffset(getActiveWhales(), cached.data.whales)
      : cached.data.whales.length,
    limit: cached.data.whales.length,
    done: !incomplete,
    incomplete,
    pending,
    stale: Boolean(cached.stale || incomplete),
    updatedAt: cached.updatedAt,
    mode: rest.mode || mode,
  };
}

function buildActivityFeed(trades) {
  const cutoff = Date.now() - ACTIVITY_WINDOW_MS;
  return (trades || [])
    .filter((item) => item.whaleId && Number(item.time || 0) >= cutoff)
    .sort((a, b) => Number(b.time || 0) - Number(a.time || 0))
    .slice(0, ACTIVITY_MAX);
}

/**
 * 增量活动流：只读磁盘缓存里的成交（列表主路径已不再全员拉 fills）。
 * 新开仓验证由前端对单个地址按需 refresh；单卡详情仍可拉成交。
 */
async function getActivitySince(sinceMs) {
  const since = Math.max(0, Number(sinceMs) || Date.now() - FILL_LOOKBACK_MS);
  const cached = readActiveWhaleCache();
  const cachedTrades = cached?.data?.trades || [];
  const activity = buildActivityFeed(cachedTrades).filter((item) => Number(item.time || 0) > since);

  return {
    activity,
    since,
    updatedAt: Date.now(),
  };
}

async function mapLimit(items, limit, mapper) {
  const result = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      result[index] = await mapper(items[index]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return result;
}

function readActiveWhaleCache() {
  const mode = normalizeMode(readConfig().mode || 'hf');
  return readWhaleModeCache(mode);
}

function isWhaleCacheCompatible(cached) {
  if (!cached?.data?.whales?.length) return false;
  return cached.data.whales.length === getActiveWhales().length;
}

/** 分片冷启动写入的占位：有条目但尚未真正拉过 HL */
const PENDING_REFRESH_ERROR = '等待刷新';

function isPendingPlaceholder(whale) {
  return Boolean(whale) && String(whale.error || '') === PENDING_REFRESH_ERROR;
}

function countPendingWhales(whales) {
  return (whales || []).filter(isPendingPlaceholder).length;
}

function whaleHasOpenPosition(snap) {
  if (!snap || isPendingPlaceholder(snap)) return false;
  if (Array.isArray(snap.positions) && snap.positions.length > 0) return true;
  return Math.abs(Number(snap.longUsd) || 0) + Math.abs(Number(snap.shortUsd) || 0) >= 1_000;
}

/**
 * 方案 C：每轮优先刷「待补 / 有仓 / 高 priority 且较久未刷」的地址，
 * 剩余名额给冷门地址轮转，保证名单内地址仍会更新。
 */
function pickShardSlice(roster, cachedWhales, size) {
  const total = roster.length;
  if (!total || size <= 0) return [];
  const take = Math.min(size, total);
  const byId = new Map((cachedWhales || []).map((item) => [item.id, item]));
  const now = Date.now();

  function freshnessScore(whale) {
    const snap = byId.get(whale.id);
    const lastAt = lastShardAtById.get(whale.id) || 0;
    const ageSec = (now - lastAt) / 1000;
    const priority = Number(whale.priority) || 0;
    let score = ageSec;
    if (!snap || isPendingPlaceholder(snap)) score += 1_000_000;
    else if (whaleHasOpenPosition(snap)) score += 80_000 + priority * 2;
    else score += priority;
    return score;
  }

  const ranked = [...roster].sort((a, b) => freshnessScore(b) - freshnessScore(a));
  const hotSlots = Math.min(take, Math.max(1, Math.ceil(take * HOT_SHARD_RATIO)));
  const hot = ranked.slice(0, hotSlots);
  const hotIds = new Set(hot.map((item) => item.id));

  const coldPool = roster.filter((item) => !hotIds.has(item.id));
  const cold = [];
  const coldNeed = take - hot.length;
  if (coldNeed > 0 && coldPool.length) {
    for (let i = 0; i < coldNeed; i += 1) {
      const idx = shardCursor % coldPool.length;
      cold.push(coldPool[idx]);
      shardCursor = (shardCursor + 1) % coldPool.length;
    }
  }

  return [...hot, ...cold];
}

function findFirstPendingOffset(roster, whales) {
  const byId = new Map((whales || []).map((item) => [item.id, item]));
  for (let i = 0; i < roster.length; i += 1) {
    const hit = byId.get(roster[i].id);
    if (!hit || isPendingPlaceholder(hit)) return i;
  }
  return roster.length;
}

/** 用不完整缓存种下分段会话，方便从首个「等待刷新」继续补齐 */
function seedProgressiveFromCache(mode, roster, cached) {
  const total = roster.length;
  const rosterKey = roster.map((item) => String(item.id || '')).join('|');
  if (
    progressiveSession &&
    progressiveSession.mode === mode &&
    progressiveSession.rosterKey === rosterKey &&
    Array.isArray(progressiveSession.snapshots)
  ) {
    progressiveSession.updatedAt = Date.now();
    return progressiveSession;
  }
  const byId = new Map((cached?.data?.whales || []).map((item) => [item.id, item]));
  const snapshots = roster.map((whale) => {
    const hit = byId.get(whale.id);
    if (!hit || isPendingPlaceholder(hit)) return null;
    return { ...hit, trades: [] };
  });
  progressiveSession = {
    mode,
    rosterKey,
    names: null,
    onchain: null,
    snapshots,
    updatedAt: Date.now(),
    activeAt: Date.now(),
  };
  return progressiveSession;
}

function findConfiguredWhale(id) {
  const config = readConfig();
  const key = String(id || '').trim().toLowerCase();
  return config.whales.find((item) => {
    const itemId = String(item.id || '').toLowerCase();
    const addr = normalizeAddress(item.address);
    return itemId === key || addr === key || addr === normalizeAddress(id);
  });
}

/**
 * 拉取单个巨鲸快照。
 * light=true：只拉仓位（列表首屏）；完整成交由 activity 轮询补。
 * 限流失败时优先用 fallback。
 */
async function loadWhaleSnapshot(whale, names = {}, fallback = null, options = {}) {
  const light = options.light !== false; // 默认轻量：列表加载不拉 7 天成交
  const address = normalizeAddress(whale.address);
  const base = {
    ...whale,
    address,
    direction: 'neutral',
    longUsd: 0,
    shortUsd: 0,
    netUsd: 0,
    positions: [],
    error: null,
  };

  if (!address) {
    return {
      ...base,
      error: '缺少完整 0x 地址，无法查询 Hyperliquid 仓位',
      trades: [],
    };
  }

  const usableFallback =
    fallback && !isPendingPlaceholder(fallback) && Array.isArray(fallback.positions)
      ? fallback
      : null;

  const fromFallback = () => ({
    ...usableFallback,
    ...base,
    direction: usableFallback.direction || 'neutral',
    longUsd: usableFallback.longUsd || 0,
    shortUsd: usableFallback.shortUsd || 0,
    netUsd: usableFallback.netUsd || 0,
    positions: usableFallback.positions || [],
    longWinRate: usableFallback.longWinRate,
    shortWinRate: usableFallback.shortWinRate,
    topCoins: usableFallback.topCoins,
    error: null,
    trades: [],
  });

  try {
    let state;
    try {
      state = await fetchClearinghouseState(address);
    } catch (err) {
      if (usableFallback) {
        console.warn(`[whales] ${whale.name} 仓位源失败（${err.message}），沿用缓存仓位`);
        return fromFallback();
      }
      throw err;
    }

    return finalizeSnapshotFromState(whale, address, state, names, {
      light,
      base,
      prevPositions: usableFallback?.positions || [],
    });
  } catch (err) {
    console.warn(`[whales] ${whale.name} Hyperliquid 查询失败:`, err.message);
    if (usableFallback) return fromFallback();
    return {
      ...base,
      error: err.message,
      trades: [],
    };
  }
}

/** 轻量刷新时继承上次开仓时间，避免把 openTime 冲成 null 导致异动补种失败 */
function mergePrevPositionTiming(pos, prevPositions = []) {
  const prev = (prevPositions || []).find(
    (item) => item?.coin === pos.coin && item?.side === pos.side,
  );
  if (!prev) return pos;
  const openTime = Number(pos.openTime) || Number(prev.openTime) || null;
  const firstOpenTime =
    Number(pos.firstOpenTime) || Number(prev.firstOpenTime) || openTime || null;
  const lastAddTime = Number(pos.lastAddTime) || Number(prev.lastAddTime) || null;
  return {
    ...pos,
    openTime,
    firstOpenTime,
    lastAddTime,
    openHistoryComplete:
      pos.openHistoryComplete != null ? pos.openHistoryComplete : prev.openHistoryComplete,
    entryFills: Array.isArray(pos.entryFills) && pos.entryFills.length
      ? pos.entryFills
      : prev.entryFills,
    entryFillsOmitted:
      pos.entryFillsOmitted != null ? pos.entryFillsOmitted : prev.entryFillsOmitted,
  };
}

function positionNotional(whale) {
  return (whale?.positions || []).reduce((sum, pos) => sum + (Number(pos.positionValue) || 0), 0);
}

function needsOpenTiming(whale) {
  return (whale?.positions || []).some(
    (pos) => (Number(pos.positionValue) || 0) >= MIN_USD && !(Number(pos.openTime) || Number(pos.firstOpenTime)),
  );
}

function countHlTrades(trades = []) {
  return (trades || []).filter((trade) => trade && trade.source !== 'onchain').length;
}

function needsFillEnrichment(whale, existingHlCount = 0) {
  if (!whale || whale.error) return false;
  if (!positionNotional(whale) && !(whale.positions || []).length) return false;
  // 有仓但几乎没有 HL 成交明细，或仍缺开仓时间 / 补仓明细
  return needsOpenTiming(whale) || needsEntryFillDetail(whale) || existingHlCount < 5;
}

/** 大额仓位缺少可展开的开/补仓明细（（合）） */
function needsEntryFillDetail(whale) {
  return (whale?.positions || []).some((pos) => {
    if ((Number(pos.positionValue) || 0) < MIN_USD) return false;
    const n = Array.isArray(pos.entryFills) ? pos.entryFills.length : 0;
    return n <= 1;
  });
}

let openTimingEnrichInflight = null;

/**
 * 补齐 openTime，并把近 7 天 HL 成交写入 snap.trades（供异动「成交明细」/补种）。
 * 线上 light 列表默认不拉 fills，必须靠这步灌历史。
 */
async function enrichWhaleFillsAndTiming(whales, names = {}, options = {}) {
  const maxWhales = Math.max(1, Number(options.maxWhales) || 8);
  const concurrency = Math.max(1, Number(options.concurrency) || 2);
  const existingTradesByWhale = options.tradesByWhale instanceof Map ? options.tradesByWhale : new Map();

  const candidates = (whales || [])
    .filter((whale) => {
      if (!whale || whale.error) return false;
      if (options.force) return positionNotional(whale) > 0 || (whale.positions || []).length > 0;
      return needsFillEnrichment(whale, countHlTrades(existingTradesByWhale.get(whale.id)));
    })
    .sort((a, b) => positionNotional(b) - positionNotional(a))
    .slice(0, maxWhales);
  if (!candidates.length) return { updated: 0, trades: [] };

  let updated = 0;
  const collectedTrades = [];
  await mapLimit(candidates, concurrency, async (whale) => {
    const address = normalizeAddress(whale.address);
    if (!address) return;
    let fills = [];
    try {
      fills = await fetchUserFills(address);
    } catch (err) {
      console.warn(`[whales] ${whale.name} 成交补齐失败:`, err.message);
      return;
    }
    const positions = await Promise.all(
      (whale.positions || []).map(async (pos) => {
        if ((Number(pos.positionValue) || 0) < MIN_USD) return pos;
        const posFills = await resolveFillsForPosition(
          address,
          pos.coin,
          pos.size,
          pos.side,
          fills,
        );
        const timing = buildPositionOpenTiming(posFills, pos.coin, pos.size, pos.side);
        const entries = buildPositionEntryFills(posFills, pos.coin, pos.size, pos.side);
        // 已有更完整开仓时间则保留
        const keepOpen = Number(pos.openTime) || Number(pos.firstOpenTime);
        return {
          ...pos,
          coinLabel: pos.coinLabel || coinLabel(pos.coin, names),
          ...(keepOpen && !timing.openTime
            ? {}
            : {
                ...timing,
                openTime: timing.openTime || pos.openTime || null,
                firstOpenTime: timing.firstOpenTime || pos.firstOpenTime || pos.openTime || null,
                lastAddTime: timing.lastAddTime || pos.lastAddTime || null,
              }),
          ...entries,
          entryFills:
            Array.isArray(entries.entryFills) && entries.entryFills.length
              ? entries.entryFills
              : pos.entryFills,
        };
      }),
    );
    whale.positions = positions;
    const trades = mapAndFilterFills(fills, { ...whale, address }, names, MIN_USD);
    whale.trades = trades;
    collectedTrades.push(...trades);
    updated += 1;
  });
  return { updated, trades: collectedTrades };
}

/** @deprecated 兼容旧调用名 */
async function enrichMissingOpenTiming(whales, names = {}, options = {}) {
  const result = await enrichWhaleFillsAndTiming(whales, names, options);
  return result.updated;
}

async function persistOpenTimingEnrichment(mode = 'hf') {
  try {
    const { isRealtimeConnected } = require('./realtimeBridge');
    if (isRealtimeConnected() && process.env.HL_WS_FORCE_ENRICH !== '1') {
      // 实时 WS 已接管成交流，跳过 REST 补齐以免再打满配额
      return null;
    }
  } catch {
    // bridge 未加载时照常补齐
  }
  if (openTimingEnrichInflight) return openTimingEnrichInflight;
  openTimingEnrichInflight = (async () => {
    const cached = readWhaleModeCache(mode);
    const whales = Array.isArray(cached?.data?.whales) ? cached.data.whales : [];
    if (!whales.length) return;
    const names = await fetchCoinNameMap().catch(() => ({}));
    const prevTrades = Array.isArray(cached?.data?.trades) ? cached.data.trades : [];
    const tradesByWhale = new Map();
    for (const trade of prevTrades) {
      if (!trade?.whaleId || trade.source === 'onchain') continue;
      const list = tradesByWhale.get(trade.whaleId) || [];
      list.push(trade);
      tradesByWhale.set(trade.whaleId, list);
    }
    const { updated, trades: newTrades } = await enrichWhaleFillsAndTiming(whales, names, {
      maxWhales: 40,
      concurrency: 3,
      force: true,
      tradesByWhale,
    });
    if (!updated && !newTrades.length) return;

    const refreshedIds = new Set(
      whales.filter((w) => Array.isArray(w.trades) && w.trades.length).map((w) => w.id),
    );
    const keptHl = prevTrades.filter(
      (trade) => trade?.source !== 'onchain' && !(trade?.whaleId && refreshedIds.has(trade.whaleId)),
    );
    const onchain = prevTrades.filter((trade) => trade?.source === 'onchain');
    const seen = new Set();
    const mergedTrades = [...newTrades, ...keptHl, ...onchain]
      .filter((trade) => {
        const id = String(trade?.id || '');
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .sort((a, b) => Number(b.time || 0) - Number(a.time || 0))
      .slice(0, ACTIVITY_MAX + 500);

    const cleanedWhales = whales.map(({ trades: _t, ...rest }) => rest);
    writeWhaleModeCache(mode, {
      ...cached.data,
      whales: sortWhales(cleanedWhales, mode),
      trades: mergedTrades,
    });
    console.log(`[whales] 已补齐 ${updated} 个巨鲸开仓时间/成交明细（+${newTrades.length} 笔）`);
  })()
    .catch((err) => {
      console.warn('[whales] 开仓时间/成交补齐任务失败:', err.message);
    })
    .finally(() => {
      openTimingEnrichInflight = null;
    });
  return openTimingEnrichInflight;
}

/**
 * 手动拉取异动历史：强制给高名义巨鲸补成交 + openTime，写回缓存并返回 activity。
 */
async function refreshAlertHistory(query = {}) {
  const mode = 'hf';
  const maxWhales = Math.min(200, Math.max(8, Number(query.maxWhales) || 40));
  const concurrency = Math.min(5, Math.max(1, Number(query.concurrency) || 4));

  let cached = readWhaleModeCache(mode);
  let whales = Array.isArray(cached?.data?.whales) ? [...cached.data.whales] : [];
  if (!whales.length) {
    const cold = await getWhales(false);
    whales = Array.isArray(cold?.whales) ? [...cold.whales] : [];
    cached = readWhaleModeCache(mode);
  }
  if (!whales.length) {
    return {
      whales: [],
      trades: [],
      activity: [],
      enriched: 0,
      tradeCount: 0,
      warning: '暂无巨鲸数据，请先加载列表',
      updatedAt: Date.now(),
    };
  }

  const names = await fetchCoinNameMap().catch(() => ({}));
  const prevTrades = Array.isArray(cached?.data?.trades) ? cached.data.trades : [];
  const { updated, trades: newTrades } = await enrichWhaleFillsAndTiming(whales, names, {
    maxWhales,
    concurrency,
    force: true,
  });

  const refreshedIds = new Set(
    whales.filter((w) => Array.isArray(w.trades) && w.trades.length).map((w) => w.id),
  );
  const keptHl = prevTrades.filter(
    (trade) => trade?.source !== 'onchain' && !(trade?.whaleId && refreshedIds.has(trade.whaleId)),
  );
  const onchain = prevTrades.filter((trade) => trade?.source === 'onchain');
  const seen = new Set();
  const mergedTrades = [...newTrades, ...keptHl, ...onchain]
    .filter((trade) => {
      const id = String(trade?.id || '');
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => Number(b.time || 0) - Number(a.time || 0))
    .slice(0, ACTIVITY_MAX + 500);

  const cleanedWhales = sortWhales(
    whales.map(({ trades: _t, ...rest }) => rest),
    mode,
  );
  const payload = {
    ...(cached?.data || {}),
    mode,
    whales: cleanedWhales,
    trades: mergedTrades,
    minUsd: MIN_USD,
  };
  const saved = writeWhaleModeCache(mode, payload);
  return {
    whales: cleanedWhales,
    trades: mergedTrades,
    activity: buildActivityFeed(mergedTrades),
    enriched: updated,
    tradeCount: newTrades.length,
    warning: null,
    updatedAt: saved.updatedAt,
  };
}

async function finalizeSnapshotFromState(whale, address, state, names, { light, base, prevPositions = [] }) {
  let fills = [];
  if (!light) {
    try {
      fills = await fetchUserFills(address);
    } catch (err) {
      console.warn(`[whales] ${whale.name} 成交拉取失败，仅更新仓位:`, err.message);
      fills = [];
    }
  }

  const derived = deriveDirection(state);
  let positions;
  if (light) {
    positions = (derived.positions || []).map((pos) =>
      mergePrevPositionTiming(
        {
          ...pos,
          coinLabel: coinLabel(pos.coin, names),
        },
        prevPositions,
      ),
    );
  } else {
    positions = await Promise.all(
      (derived.positions || []).map(async (pos) => {
        const posFills = await resolveFillsForPosition(
          address,
          pos.coin,
          pos.size,
          pos.side,
          fills,
        );
        return mergePrevPositionTiming(
          {
            ...pos,
            coinLabel: coinLabel(pos.coin, names),
            ...buildPositionOpenTiming(posFills, pos.coin, pos.size, pos.side),
            ...buildPositionEntryFills(posFills, pos.coin, pos.size, pos.side),
          },
          prevPositions,
        );
      }),
    );
  }

  const trades = light ? [] : mapAndFilterFills(fills, { ...whale, address }, names, MIN_USD);
  const sideRates = light ? {} : computeSideWinRates(fills);
  const topCoins = light ? whale.topCoins || [] : computeTopCoins(fills, names);
  return {
    ...base,
    ...derived,
    ...sideRates,
    topCoins,
    positions,
    trades,
  };
}

/**
 * 批量轻量拉取：优先 GoldRush batchClearinghouseState，一次最多 50 个。
 */
async function loadWhaleSnapshotsBatch(whales, names = {}, fallbackById = new Map(), options = {}) {
  const light = options.light !== false;
  const list = whales || [];
  if (!list.length) return [];

  const addressList = list.map((w) => normalizeAddress(w.address)).filter(Boolean);
  let states = {};
  try {
    states = await fetchBatchClearinghouseStates(addressList);
  } catch (err) {
    console.warn('[whales] 批量仓位失败，改逐个轻量拉取:', err.message || err);
  }

  return mapLimit(list, WHALE_SNAPSHOT_CONCURRENCY, async (whale) => {
    const address = normalizeAddress(whale.address);
    const fallback = fallbackById.get(whale.id) || null;
    const state = address ? states[address] : null;
    if (state) {
      const base = {
        ...whale,
        address,
        direction: 'neutral',
        longUsd: 0,
        shortUsd: 0,
        netUsd: 0,
        positions: [],
        error: null,
      };
      try {
        const prevPositions = Array.isArray(fallback?.positions) ? fallback.positions : [];
        return await finalizeSnapshotFromState(whale, address, state, names, {
          light,
          base,
          prevPositions,
        });
      } catch (err) {
        if (fallback && !isPendingPlaceholder(fallback)) {
          return { ...fallback, ...base, error: null, trades: [] };
        }
        return { ...base, error: err.message, trades: [] };
      }
    }
    return loadWhaleSnapshot(whale, names, fallback, { light });
  });
}

async function buildWhalePayload(mode, enabledWhales) {
  const names = await fetchCoinNameMap().catch(() => ({}));
  const [snapshots, onchain] = await Promise.all([
    mapLimit(enabledWhales, WHALE_SNAPSHOT_CONCURRENCY, (whale) =>
      loadWhaleSnapshot(whale, names, null, { light: true }),
    ),
    fetchWhaleAlerts(MIN_USD, 50),
  ]);

  const hlTrades = snapshots.flatMap((item) => item.trades || []);
  const watchedOnchain = onchain.alerts
    .map((trade) => attachWatchedWhale(trade, enabledWhales))
    .filter((trade) => trade.whaleId);

  const globalOnchain = onchain.alerts
    .map((trade) => attachWatchedWhale(trade, enabledWhales))
    .filter((trade) => !trade.whaleId)
    .slice(0, 30);

  const trades = [...hlTrades, ...watchedOnchain, ...globalOnchain].sort(
    (a, b) => b.time - a.time,
  );

  return {
    mode,
    whales: sortWhales(
      snapshots.map(({ trades: _t, ...rest }) => rest),
      mode,
    ),
    trades,
    warnings: snapshots
      .filter((item) => item.error)
      .map((item) => `${item.name}：${item.error}`),
    minUsd: MIN_USD,
  };
}

async function refreshWhalesForMode(mode, force = false) {
  const key = 'hf';
  let cached = readWhaleModeCache(key);
  if (cached && !isWhaleCacheCompatible(cached)) {
    // 名单长度变了：保留旧缓存给接口读，后台用分片慢慢补齐，不要整份清掉导致冷启动
    cached = null;
  }
  if (!force && cached && !cached.stale) {
    return { ...cached.data, stale: false, updatedAt: cached.updatedAt };
  }

  if (!force && cached?.data?.whales?.length) {
    refreshWhalesShard().catch((err) => {
      console.warn(`[cache] 后台分片刷新失败:`, err.message);
    });
    return { ...cached.data, stale: true, updatedAt: cached.updatedAt };
  }

  // 无缓存且非强制：启动分片预热，接口路径不要死等全量
  if (!force) {
    refreshWhalesShard().catch((err) => {
      console.warn(`[cache] 冷启动分片预热失败:`, err.message);
    });
    return {
      mode: key,
      whales: [],
      trades: [],
      warnings: ['缓存预热中，请稍后刷新'],
      minUsd: MIN_USD,
      stale: true,
      updatedAt: 0,
    };
  }

  if (whalesInflightByMode[key]) {
    return whalesInflightByMode[key];
  }

  const generation = ++whalesGenerationByMode[key];
  whalesInflightByMode[key] = (async () => {
    const enabledWhales = getActiveWhales();
    const payload = await buildWhalePayload(key, enabledWhales);

    if (generation !== whalesGenerationByMode[key]) {
      const err = new Error('巨鲸列表已切换，本次刷新已取消');
      err.code = 'WHALE_REFRESH_CANCELLED';
      throw err;
    }

    const saved = writeWhaleModeCache(key, payload);
    return { ...payload, stale: false, updatedAt: saved.updatedAt };
  })().finally(() => {
    if (generation === whalesGenerationByMode[key]) whalesInflightByMode[key] = null;
  });

  return whalesInflightByMode[key];
}

/**
 * 分片轮转刷新：每轮只拉 WHALE_SHARD_SIZE 个巨鲸，合并进磁盘缓存。
 * 线上用这个替代「每分钟全量刷新」，避免接口被 HL 队列堵死。
 * @param {{ force?: boolean }} [options] force=true 时跳过完整名单的节流
 */
async function refreshWhalesShard(options = {}) {
  if (shardInflight) return shardInflight;
  if (isProgressiveLoading()) {
    console.log('[cache] 分片刷新让路：前端分段加载进行中');
    return null;
  }

  const force = Boolean(options.force);
  const cachedPreview = readWhaleModeCache('hf');
  const pendingPreview = countPendingWhales(cachedPreview?.data?.whales);
  const sinceLast = Date.now() - lastShardRefreshAt;
  if (!force && pendingPreview === 0 && lastShardRefreshAt > 0 && sinceLast < SHARD_REFRESH_MIN_INTERVAL_MS) {
    return null;
  }

  shardInflight = (async () => {
    const mode = 'hf';
    const roster = getActiveWhales();
    const total = roster.length;
    if (!total) return null;
    lastShardRefreshAt = Date.now();

    const cachedBefore = readWhaleModeCache(mode);
    const prevCachedWhales = Array.isArray(cachedBefore?.data?.whales) ? cachedBefore.data.whales : [];
    const slice = pickShardSlice(roster, prevCachedWhales, WHALE_SHARD_SIZE);
    const hotCount = slice.filter((whale) => {
      const snap = prevCachedWhales.find((item) => item.id === whale.id);
      return whaleHasOpenPosition(snap) || isPendingPlaceholder(snap) || !snap;
    }).length;

    const names = await fetchCoinNameMap().catch(() => ({}));
    const needOnchain = Date.now() - shardOnchainAt >= SHARD_ONCHAIN_TTL_MS;
    const byIdPreview = new Map(prevCachedWhales.map((item) => [item.id, item]));
    const [snapshots, onchain] = await Promise.all([
      loadWhaleSnapshotsBatch(slice, names, byIdPreview, { light: true }),
      needOnchain
        ? fetchWhaleAlerts(MIN_USD, 50).catch(() => ({ alerts: [], warning: null }))
        : Promise.resolve(null),
    ]);
    if (needOnchain) shardOnchainAt = Date.now();

    const refreshedAt = Date.now();
    for (const snap of snapshots) {
      if (snap?.id && !snap.error) lastShardAtById.set(snap.id, refreshedAt);
    }

    const cached = cachedBefore || readWhaleModeCache(mode);
    const prevWhales = Array.isArray(cached?.data?.whales) ? cached.data.whales : [];
    const prevTrades = Array.isArray(cached?.data?.trades) ? cached.data.trades : [];
    const prevWarnings = Array.isArray(cached?.data?.warnings) ? cached.data.warnings : [];

    const byId = new Map(prevWhales.map((item) => [item.id, item]));
    for (const snap of snapshots) {
      const { trades: _t, ...rest } = snap;
      const prev = byId.get(snap.id);
      if (prev?.positions?.length) {
        rest.positions = (rest.positions || []).map((pos) =>
          mergePrevPositionTiming(pos, prev.positions),
        );
      }
      byId.set(snap.id, rest);
    }
    // 按当前名单顺序输出，缺的用空壳占位，避免名单变了整份缓存失效
    const whales = roster.map((whale) => {
      const hit = byId.get(whale.id);
      if (hit) return { ...hit, name: whale.name, address: whale.address, enabled: whale.enabled };
      return {
        ...whale,
        direction: 'neutral',
        longUsd: 0,
        shortUsd: 0,
        netUsd: 0,
        positions: [],
        error: '等待刷新',
      };
    });

    const refreshedIds = new Set(snapshots.map((item) => item.id));
    const keptTrades = prevTrades.filter((trade) => {
      if (!trade?.whaleId) return true;
      return !refreshedIds.has(trade.whaleId);
    });
    const newHlTrades = snapshots.flatMap((item) => item.trades || []);
    let trades = [...keptTrades.filter((t) => t.source !== 'onchain' || !onchain), ...newHlTrades];
    if (onchain) {
      const watchedOnchain = (onchain.alerts || [])
        .map((trade) => attachWatchedWhale(trade, roster))
        .filter((trade) => trade.whaleId);
      const globalOnchain = (onchain.alerts || [])
        .map((trade) => attachWatchedWhale(trade, roster))
        .filter((trade) => !trade.whaleId)
        .slice(0, 30);
      trades = [...trades.filter((t) => t.source !== 'onchain'), ...watchedOnchain, ...globalOnchain];
    }
    trades.sort((a, b) => b.time - a.time);

    const shardWarnings = snapshots
      .filter((item) => item.error)
      .map((item) => `${item.name}：${item.error}`);
    const otherWarnings = prevWarnings.filter((w) => !shardWarnings.some((s) => w.startsWith(s.split('：')[0])));
    const warnings = [...otherWarnings, ...shardWarnings];
    if (onchain?.warning) warnings.push(onchain.warning);

    const payload = {
      mode,
      whales: sortWhales(whales, mode),
      trades,
      warnings,
      minUsd: MIN_USD,
    };
    const saved = writeWhaleModeCache(mode, payload);
    const pendingLeft = countPendingWhales(whales);
    console.log(
      `[cache] 分片刷新 ${slice.length}/${total}（优先热门≈${hotCount}，待补 ${pendingLeft}），写入完成`,
    );
    // 轻量快照缺 openTime：后台补齐，供异动补种使用
    persistOpenTimingEnrichment(mode).catch(() => null);
    // 冷启动还有占位时尽快续刷，避免前端只看到「等待刷新」干等定时器
    if (pendingLeft > 0 && !isProgressiveLoading()) {
      setTimeout(() => {
        refreshWhalesShard().catch((err) => {
          console.warn('[cache] 续刷分片失败:', err.message);
        });
      }, 1200);
    }
    return { ...payload, stale: pendingLeft > 0, updatedAt: saved.updatedAt, pending: pendingLeft, incomplete: pendingLeft > 0 };
  })()
    .catch((err) => {
      console.warn('[cache] 分片刷新失败:', err.message);
      throw err;
    })
    .finally(() => {
      shardInflight = null;
    });

  return shardInflight;
}

async function refreshWhales(force = false) {
  // 定时/软刷新走分片；只有显式 force 且无缓存时才全量
  if (!force) return refreshWhalesForMode('hf', false);
  const cached = readWhaleModeCache('hf');
  if (cached?.data?.whales?.length) {
    return refreshWhalesShard();
  }
  return refreshWhalesForMode('hf', true);
}

function invalidateWhaleCache(mode) {
  progressiveSession = null;
  if (mode) {
    const key = normalizeMode(mode);
    whalesGenerationByMode[key] += 1;
    whalesInflightByMode[key] = null;
    clearWhaleModeCache(key);
    return;
  }
  for (const key of WHALE_MODES) {
    whalesGenerationByMode[key] += 1;
    whalesInflightByMode[key] = null;
  }
  clearWhaleModeCache();
}

const MAIN_ASSETS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT', 'UNI', 'AAVE', 'LTC', 'SUI', 'APT', 'TON', 'HYPE', 'NEAR', 'ARB', 'OP', 'PEPE', 'WIF', 'FIL', 'ATOM', 'BCH', 'ETC', 'TRX', 'POL', 'SHIB', 'ENA', 'BONK', 'KBONK', 'WLD', 'INJ', 'SEI', 'TIA', 'ONDO'];

function isMainstreamAsset(coin) {
  const value = String(coin || '').toUpperCase().replace(/^K/, 'K');
  return MAIN_ASSETS.includes(value) || MAIN_ASSETS.includes(value.replace(/^K/, ''));
}

function parsePage(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 50));
  return { page, limit };
}

function uniqueAssets(trades) {
  const map = new Map();
  for (const item of trades) {
    if (!item.asset) continue;
    const exotic = Boolean(item.exotic) || isExoticAsset(item.asset);
    const current = map.get(item.asset);
    if (!current) {
      map.set(item.asset, {
        value: item.asset,
        label: item.assetLabel || item.asset,
        exotic,
      });
    }
  }
  return [...map.values()]
    .filter((item) => isMainstreamAsset(item.value) || item.exotic)
    .sort((a, b) => {
      if (a.exotic !== b.exotic) return a.exotic ? 1 : -1;
      const ia = MAIN_ASSETS.indexOf(String(a.value).toUpperCase());
      const ib = MAIN_ASSETS.indexOf(String(b.value).toUpperCase());
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return String(a.label).localeCompare(String(b.label));
    });
}

function filterByFlow(trades, flow) {
  if (flow !== 'in' && flow !== 'out') return trades;
  const whales = readConfig().whales;
  return trades.filter((trade) => {
    const whale = whales.find((item) => item.id === trade.whaleId);
    const addr = normalizeAddress(whale?.address);
    if (!addr) return false;
    if (flow === 'in') return (trade.to || '').toLowerCase() === addr;
    return (trade.from || '').toLowerCase() === addr;
  });
}

function paginate(list, page, limit) {
  const total = list.length;
  const start = (page - 1) * limit;
  return {
    trades: list.slice(start, start + limit),
    total,
    page,
    limit,
  };
}

function applyTradeQuery(trades, query = {}) {
  const { page, limit } = parsePage(query);
  let list = Array.isArray(trades) ? trades : [];
  if (query.whaleId) {
    list = list.filter((item) => item.whaleId === query.whaleId);
  }
  list = filterByFlow(list, query.flow);
  const assetOptions = uniqueAssets(list);
  const assets = assetOptions.map((item) => item.value);
  if (query.asset) {
    const wanted = String(query.asset).toUpperCase();
    list = list.filter((item) => String(item.asset).toUpperCase() === wanted);
  }
  const sinceMs = Number(query.sinceMs);
  if (sinceMs > 0) {
    list = list.filter((item) => Number(item.time) >= sinceMs);
  }
  return { ...paginate(list, page, limit), assets, assetOptions };
}

/** 全部巨鲸成交分页：缓存 + SQLite 合并，随补齐逐步变全 */
async function listTrades(query = {}) {
  const force = query.refresh === '1' || query.refresh === true;
  const sinceMs = Number(query.sinceMs) || Date.now() - FILL_LOOKBACK_MS;
  const map = new Map();

  const pushList = (list) => {
    for (const trade of list || []) {
      if (!trade || trade.source === 'onchain') continue;
      if (Number(trade.time || 0) < sinceMs) continue;
      const key = String(trade.id || trade.hash || '');
      if (!key || map.has(key)) continue;
      map.set(key, trade);
    }
  };

  if (!force) {
    const cached = readActiveWhaleCache();
    if (cached?.data) {
      pushList(cached.data.trades);
      if (cached.stale) {
        refreshWhalesShard().catch((err) => {
          console.warn('[trades] 后台分片刷新失败:', err.message);
        });
      }
    }
  } else {
    const data = await getWhales(true);
    pushList(data.trades);
  }

  try {
    const { loadRecentFills } = require('./sqliteStore');
    pushList(loadRecentFills({ sinceMs, limit: 5000 }));
  } catch (err) {
    console.warn('[trades] 读库成交失败:', err.message);
  }

  const trades = [...map.values()].sort((a, b) => Number(b.time || 0) - Number(a.time || 0));
  const cached = readActiveWhaleCache();
  return {
    ...applyTradeQuery(trades, query),
    updatedAt: cached?.updatedAt || Date.now(),
    minUsd: cached?.data?.minUsd ?? MIN_USD,
    stale: Boolean(cached?.stale),
    source: 'local',
  };
}

/** 查询单个巨鲸成交：只读本地缓存 / SQLite，不打上游 */
async function getWhaleTrades(id, query = {}) {
  const whale = findConfiguredWhale(id);
  if (!whale) {
    const error = new Error('未找到该巨鲸');
    error.status = 404;
    throw error;
  }

  const address = normalizeAddress(whale.address);
  const maxPerWhale = Math.max(100, Number(process.env.FILL_MAX_PER_WHALE) || 10000);
  const sinceMs = Number(query.sinceMs) || Date.now() - FILL_LOOKBACK_MS;

  const cached = readActiveWhaleCache();
  const fromCache = (cached?.data?.trades || []).filter((trade) => {
    if (!trade || trade.source === 'onchain') return false;
    if (trade.whaleId !== whale.id) return false;
    return Number(trade.time || 0) >= sinceMs;
  });

  let fromDb = [];
  try {
    const { loadFillsByWhale } = require('./sqliteStore');
    fromDb = loadFillsByWhale(whale.id, { sinceMs, limit: maxPerWhale });
  } catch (err) {
    console.warn('[whales] 读库成交失败:', err.message);
  }

  const map = new Map();
  for (const trade of [...fromDb, ...fromCache]) {
    const key = String(trade?.id || trade?.hash || '');
    if (!key || map.has(key)) continue;
    map.set(key, trade);
  }
  const trades = [...map.values()]
    .sort((a, b) => Number(b.time || 0) - Number(a.time || 0))
    .slice(0, maxPerWhale);

  return {
    whale: {
      id: whale.id,
      name: whale.name,
      address: address || whale.address || '',
    },
    source: 'local',
    ...applyTradeQuery(trades, query),
  };
}

const LEDGER_TYPE_LABEL = {
  deposit: '充值',
  withdraw: '提现',
  send: '转出',
  receive: '转入',
  internalTransfer: '内部转账',
  subAccountTransfer: '子账户划转',
  spotTransfer: '现货转账',
  accountClassTransfer: '账户划转',
  vaultDeposit: '金库存入',
  vaultWithdraw: '金库取出',
  vaultDistribution: '金库分配',
  vaultLeaderCommission: '金库佣金',
  liquidation: '清算',
  rewardsClaim: '奖励领取',
};

function ledgerAmountUsd(delta = {}) {
  const candidates = [
    delta.usdc,
    delta.netWithdrawnUsd,
    delta.requestedUsd,
    delta.amount,
    delta.usd,
    delta.value,
  ];
  for (const value of candidates) {
    const n = Math.abs(Number(value));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function ledgerDirection(type) {
  const t = String(type || '');
  if (/withdraw|out|send/i.test(t)) return 'out';
  if (/deposit|in|receive|claim|distribution/i.test(t)) return 'in';
  return 'transfer';
}

function mapLedgerToTransfer(entry, whale, address) {
  const delta = entry?.delta && typeof entry.delta === 'object' ? entry.delta : {};
  const type = String(delta.type || 'transfer');
  const time = Number(entry?.time) || 0;
  const hash = String(entry?.hash || '');
  const amountUsd = ledgerAmountUsd(delta);
  const asset = String(delta.token || delta.coin || 'USDC');
  const peer = String(delta.user || delta.destination || delta.source || delta.to || delta.from || '');
  const direction = ledgerDirection(type);
  return {
    id: hash || `${address}-${time}-${type}-${amountUsd}`,
    time,
    hash,
    type,
    typeLabel: LEDGER_TYPE_LABEL[type] || type,
    direction,
    amountUsd,
    asset,
    peer,
    whaleId: whale.id,
    whaleName: whale.name,
    address,
  };
}

/** GET 单个巨鲸转账记录（HL 非资金费账本） */
async function getWhaleTransfers(id, query = {}) {
  const whale = findConfiguredWhale(id);
  if (!whale) {
    const error = new Error('未找到该巨鲸');
    error.status = 404;
    throw error;
  }

  const address = normalizeAddress(whale.address);
  if (!address) {
    throw new Error('该巨鲸缺少完整 0x 地址');
  }

  const days = Math.min(90, Math.max(1, Number(query.days) || 30));
  const startTime = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = await fetchUserNonFundingLedgerUpdates(address, startTime);
  const transfers = rows
    .map((entry) => mapLedgerToTransfer(entry, whale, address))
    .filter((item) => item.time > 0)
    .sort((a, b) => b.time - a.time);

  const limit = Math.min(200, Math.max(1, Number(query.limit) || 100));
  return {
    whale: {
      id: whale.id,
      name: whale.name,
      address,
    },
    transfers: transfers.slice(0, limit),
    days,
    updatedAt: Date.now(),
  };
}

/** 点开持仓时实时查该币种：开仓价、杠杆、最新浮盈、爆仓价 */
function positionFromDiskCache(whale, coin) {
  const cached = readActiveWhaleCache();
  const snap = (cached?.data?.whales || []).find((item) => item.id === whale.id);
  const wanted = String(coin || '').toUpperCase();
  const pos = (snap?.positions || []).find((item) => {
    const name = String(item.coin || '').toUpperCase();
    const label = String(item.coinLabel || '').toUpperCase();
    return name === wanted || label === wanted || label.split('/')[0] === wanted;
  });
  if (!pos) return null;
  return {
    whale: { id: whale.id, name: whale.name, address: whale.address },
    updatedAt: cached.updatedAt || Date.now(),
    stale: true,
    position: {
      coin: pos.coin,
      coinLabel: pos.coinLabel || pos.coin,
      kind: 'perp',
      side: pos.side,
      size: pos.size,
      entryPx: pos.entryPx,
      markPx: null,
      positionValue: pos.positionValue,
      unrealizedPnl: pos.unrealizedPnl,
      liquidationPx: pos.liquidationPx == null || pos.liquidationPx === '' ? null : Number(pos.liquidationPx),
      leverage: pos.leverage,
      leverageLabel: pos.leverage ? `${pos.leverage}x` : '现货',
      marginUsed: pos.marginUsed ?? null,
      openTime: pos.openTime || pos.firstOpenTime || null,
      firstOpenTime: pos.firstOpenTime || pos.openTime || null,
      lastAddTime: pos.lastAddTime || null,
      openHistoryComplete: pos.openHistoryComplete,
      entryFills: pos.entryFills || [],
      entryFillsOmitted: pos.entryFillsOmitted || 0,
      explorerUrl: explorerUrl(whale.address),
    },
  };
}

function relatedFills(coin, fills, names = {}) {
  const wanted = String(coin || '').toUpperCase();
  const label = String(coinLabel(coin, names) || '').toUpperCase();
  return (fills || []).filter((fill) => {
    const name = String(fill.coin || '').toUpperCase();
    return name === wanted || name === label || name === label.split('/')[0];
  });
}

function newCycle(side, time) {
  return {
    side,
    openSz: 0,
    openNotional: 0,
    closeSz: 0,
    closeNotional: 0,
    pnl: 0,
    fee: 0,
    openTime: Number(time) || 0,
    closeTime: 0,
    partial: false,
  };
}

/**
 * 用 fills 还原「开仓 → 平仓」周期。
 * 依赖每条 fill 的 startPosition（成交前的带符号持仓），缺失时退化为累加。
 * 返回按时间升序的已完结周期，用于展示平均平仓价与已实现盈亏。
 */
function buildClosedCycles(related) {
  const sorted = [...(related || [])].sort((a, b) => Number(a.time) - Number(b.time));
  const cycles = [];
  let cur = null;
  let running = null;

  for (const fill of sorted) {
    const sz = Math.abs(Number(fill.sz) || 0);
    if (!sz) continue;
    const px = Number(fill.px) || 0;
    const time = Number(fill.time) || 0;
    const startRaw = Number(fill.startPosition);
    const start = Number.isFinite(startRaw) ? startRaw : running == null ? 0 : running;
    const delta = fill.side === 'B' ? sz : -sz;
    const end = start + delta;
    const tol = Math.max(sz * 1e-6, 1e-9);
    const flatBefore = Math.abs(start) <= tol;

    // fills 只保留最近若干条，可能从持仓中途开始：补一个不完整周期
    if (!cur && !flatBefore) {
      cur = newCycle(start > 0 ? 'long' : 'short', 0);
      cur.partial = true;
      cur.openSz = Math.abs(start);
    }
    if (flatBefore) cur = newCycle(delta > 0 ? 'long' : 'short', time);

    // 只有与现有持仓反向的成交才是平仓；同向成交是加仓
    const reducing = !flatBefore && Math.sign(delta) !== Math.sign(start);
    const closeSz = reducing ? Math.min(sz, Math.abs(start)) : 0;
    const openSz = sz - closeSz;

    if (closeSz > 0) {
      cur.closeSz += closeSz;
      cur.closeNotional += closeSz * px;
      cur.pnl += Number(fill.closedPnl) || 0;
      cur.closeTime = time || cur.closeTime;
    }
    cur.fee += Number(fill.fee) || 0;
    running = end;

    if (Math.abs(end) <= tol) {
      if (cur.closeSz > 0) cycles.push(cur);
      cur = null;
      // 完全平掉，openSz 归零后无剩余
      if (openSz > 0) {
        // 理论上不会同时发生，保底忽略
      }
    } else if (openSz > 0) {
      // 反手成交：先平旧仓，再按新方向开仓
      if (closeSz > 0 && Math.sign(end) !== Math.sign(start) && start !== 0) {
        if (cur && cur.closeSz > 0) cycles.push(cur);
        cur = newCycle(end > 0 ? 'long' : 'short', time);
      }
      cur.openSz += openSz;
      cur.openNotional += openSz * px;
      if (!cur.openTime) cur.openTime = time;
    }
  }

  return cycles;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 从 fills 还原各币种已完结周期，供前端时间加权胜率使用。
 * 注意：userFills 通常只有最近一段，样本可能不完整。
 */
function buildRiskHistoryFromFills(fills) {
  const byCoin = new Map();
  for (const fill of fills || []) {
    const coin = String(fill.coin || '');
    if (!coin || coin.startsWith('@')) continue;
    if (!byCoin.has(coin)) byCoin.set(coin, []);
    byCoin.get(coin).push(fill);
  }

  const closedTrades = [];
  for (const related of byCoin.values()) {
    const cycles = buildClosedCycles(related);
    for (const cycle of cycles) {
      if (cycle.partial) continue;
      const openTime = Number(cycle.openTime) || 0;
      const closeTime = Number(cycle.closeTime) || 0;
      if (!openTime || !closeTime || closeTime <= openTime) continue;
      closedTrades.push({
        openTime,
        closeTime,
        result: Number(cycle.pnl) || 0,
      });
    }
  }

  closedTrades.sort((a, b) => a.closeTime - b.closeTime);
  const sample = closedTrades.slice(-300);

  let weightedSum = 0;
  let totalWeight = 0;
  let holdSum = 0;
  let maxHold = 0;
  let monthlyPnL = 0;
  const monthAgo = Date.now() - 30 * DAY_MS;

  for (const trade of sample) {
    const holdingDays = (trade.closeTime - trade.openTime) / DAY_MS;
    holdSum += holdingDays;
    maxHold = Math.max(maxHold, holdingDays);
    let weight = 1;
    if (holdingDays > 14) weight = 0.3;
    else if (holdingDays > 7) weight = 0.5;
    else if (holdingDays > 3) weight = 0.7;
    weightedSum += (trade.result > 0 ? 1 : 0) * weight;
    totalWeight += weight;
    if (trade.closeTime >= monthAgo) monthlyPnL += trade.result;
  }

  const n = sample.length;
  return {
    closedTrades: sample.map((t) => ({
      openTime: t.openTime,
      closeTime: t.closeTime,
      result: t.result,
    })),
    avgHoldingDays: n ? holdSum / n : null,
    maxHoldingDays: n ? maxHold : null,
    adjustedWinRate: totalWeight > 0 ? (weightedSum / totalWeight) * 100 : null,
    monthlyPnL: n ? monthlyPnL : null,
    sampleSize: n,
  };
}

/** 已平仓详情：平均开仓价、平均平仓价、已实现盈亏、持仓时长 */
function closedPositionFromFills(whale, coin, fills, names = {}, side = '') {
  const related = relatedFills(coin, fills, names);
  if (!related.length) return null;
  const cycles = buildClosedCycles(related);
  if (!cycles.length) return null;
  const wantSide = side === 'long' || side === 'short' ? side : '';
  const cycle = wantSide
    ? [...cycles].reverse().find((item) => item.side === wantSide)
    : cycles[cycles.length - 1];
  if (!cycle) return null;

  const sample = related[0];
  const rawCoin = sample.coin || coin;
  const closePx = cycle.closeSz ? cycle.closeNotional / cycle.closeSz : null;
  const entryPx = cycle.openSz && cycle.openNotional ? cycle.openNotional / cycle.openSz : null;
  const notional = entryPx ? entryPx * cycle.closeSz : 0;

  return {
    whale: { id: whale.id, name: whale.name, address: whale.address },
    updatedAt: Date.now(),
    position: {
      coin: rawCoin,
      coinLabel: coinLabel(rawCoin, names) || rawCoin,
      kind: String(rawCoin || '').startsWith('@') ? 'spot' : 'perp',
      side: cycle.side,
      size: cycle.closeSz,
      entryPx,
      markPx: closePx,
      closePx,
      positionValue: closePx ? closePx * cycle.closeSz : null,
      unrealizedPnl: cycle.pnl,
      realizedPnl: cycle.pnl,
      realizedRoi: notional ? (cycle.pnl / notional) * 100 : null,
      fees: cycle.fee,
      liquidationPx: null,
      leverage: null,
      leverageLabel: String(rawCoin || '').startsWith('@') ? '现货' : '--',
      marginUsed: null,
      openTime: cycle.openTime || null,
      closeTime: cycle.closeTime || null,
      holdMs: cycle.openTime && cycle.closeTime ? cycle.closeTime - cycle.openTime : null,
      entryEstimated: cycle.partial || !entryPx,
      closed: true,
      explorerUrl: explorerUrl(whale.address),
    },
  };
}

function positionFromFills(whale, coin, fills, names = {}) {
  const related = relatedFills(coin, fills, names);
  if (!related.length) return null;
  const latest = [...related].sort((a, b) => Number(b.time) - Number(a.time))[0];
  const oldest = [...related].sort((a, b) => Number(a.time) - Number(b.time))[0];
  const px = Number(latest.px) || 0;
  const sz = Number(latest.sz) || 0;
  const side = latest.side === 'B' ? 'long' : 'short';
  const closed = Math.abs(Number(latest.closedPnl) || 0) > 1;
  return {
    whale: { id: whale.id, name: whale.name, address: whale.address },
    updatedAt: Date.now(),
    position: {
      coin: latest.coin,
      coinLabel: coinLabel(latest.coin, names) || latest.coin,
      kind: String(latest.coin || '').startsWith('@') ? 'spot' : 'perp',
      side,
      size: sz,
      entryPx: px,
      markPx: px,
      positionValue: Math.abs(px * sz),
      unrealizedPnl: Number(latest.closedPnl) || 0,
      liquidationPx: null,
      leverage: null,
      leverageLabel: String(latest.coin || '').startsWith('@') ? '现货' : '--',
      marginUsed: Math.abs(px * sz),
      openTime: Number(oldest.time) || Number(latest.time) || null,
      closed,
      explorerUrl: explorerUrl(whale.address),
    },
  };
}

/** 本地缓存 + SQLite 中该巨鲸该币种的成交，转成 HL fill 形状 */
function loadLocalFillsForCoin(whaleId, coin, names = {}) {
  const wanted = String(coin || '').toUpperCase();
  const label = String(coinLabel(coin, names) || '').toUpperCase();
  const matchCoin = (row) => {
    const name = String(row?.coin || row?.asset || row?.assetLabel || '').toUpperCase();
    return name === wanted || name === label || name === label.split('/')[0];
  };

  const map = new Map();
  const push = (row) => {
    const fill = normalizeToHlFill(row);
    if (!fill || !matchCoin(fill)) return;
    const key = `${fill.tid || ''}:${fill.hash || ''}:${fill.time}:${fill.coin}:${fill.sz}:${fill.px}`;
    if (map.has(key)) return;
    map.set(key, fill);
  };

  try {
    const cached = readActiveWhaleCache();
    for (const trade of cached?.data?.trades || []) {
      if (!trade || trade.source === 'onchain') continue;
      if (trade.whaleId !== whaleId) continue;
      push(trade);
    }
    const snap = (cached?.data?.whales || []).find((item) => item.id === whaleId);
    // 不把已裁剪的 entryFills 再逆向塞回 fills，避免方向推错
    void snap;
  } catch {
    // ignore cache
  }

  try {
    const { loadFillsByWhale } = require('./sqliteStore');
    const fromDb = loadFillsByWhale(whaleId, {
      sinceMs: Date.now() - Math.max(FILL_LOOKBACK_MS, 21 * 24 * 60 * 60 * 1000),
      limit: Number(process.env.FILL_MAX_PER_WHALE) || 10000,
    });
    for (const trade of fromDb || []) push(trade);
  } catch {
    // sqlite optional
  }

  return [...map.values()].sort((a, b) => Number(b.time) - Number(a.time));
}

function mergeFillLists(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const fill of list || []) {
      const norm = normalizeToHlFill(fill);
      if (!norm) continue;
      const key = `${norm.tid || ''}:${norm.hash || ''}:${norm.time}:${norm.coin}:${norm.sz}:${norm.px}`;
      if (map.has(key)) continue;
      map.set(key, norm);
    }
  }
  return [...map.values()].sort((a, b) => Number(b.time) - Number(a.time));
}

function entryFillsThin(pos) {
  const n = Array.isArray(pos?.entryFills) ? pos.entryFills.length : 0;
  return n <= 1;
}

/** 把补齐后的开仓明细写回磁盘缓存，供列表（合）复用 */
function patchCachedPositionFields(whaleId, coin, side, fields) {
  try {
    const mode = 'hf';
    const cached = readWhaleModeCache(mode);
    if (!cached?.data?.whales?.length) return;
    const wanted = String(coin || '').toUpperCase();
    const whales = cached.data.whales.map((whale) => {
      if (whale.id !== whaleId) return whale;
      const positions = (whale.positions || []).map((pos) => {
        const name = String(pos.coin || '').toUpperCase();
        const label = String(pos.coinLabel || '').toUpperCase();
        const match =
          name === wanted || label === wanted || label.split('/')[0] === wanted;
        if (!match) return pos;
        if (side && pos.side && pos.side !== side) return pos;
        return { ...pos, ...fields };
      });
      return { ...whale, positions };
    });
    writeWhaleModeCache(mode, { ...cached.data, whales });
  } catch (err) {
    console.warn('[whales] 回写 entryFills 失败:', err.message);
  }
}

async function getWhalePosition(id, coin, options = {}) {
  const wantSide = options.side === 'long' || options.side === 'short' ? options.side : '';
  const whale = findConfiguredWhale(id);
  if (!whale) {
    const error = new Error('未找到该巨鲸');
    error.status = 404;
    throw error;
  }
  const address = normalizeAddress(whale.address);
  const decoded = decodeURIComponent(String(coin || ''));
  let names = {};
  try {
    names = await fetchCoinNameMap();
  } catch {
    names = {};
  }

  const cached = readActiveWhaleCache();
  const snap = (cached?.data?.whales || []).find((item) => item.id === whale.id) || whale;
  const wanted = String(decoded || '').toUpperCase();
  let pos = (snap.positions || []).find((item) => {
    const name = String(item.coin || '').toUpperCase();
    const label = String(item.coinLabel || '').toUpperCase();
    const matchCoin = name === wanted || label === wanted || label.split('/')[0] === wanted;
    if (!matchCoin) return false;
    if (wantSide && item.side !== wantSide) return false;
    return true;
  });

  // 列表缓存缺仓时（常见：WS 尚未写入 / 轻量快照滞后），点开详情再拉一次实时仓位
  if (!pos && address) {
    try {
      const state = await fetchClearinghouseState(address);
      const live = findPerpPosition(state, decoded, names, []);
      if (live && (!wantSide || live.side === wantSide)) {
        pos = live;
      }
    } catch (err) {
      console.warn(`[whales] ${whale.name} 实时仓位失败:`, err.message);
    }
  }

  let fills = loadLocalFillsForCoin(whale.id, decoded, names);
  const needCoinFetch =
    Boolean(address) &&
    (!pos || entryFillsThin(pos) || pos.openHistoryComplete === false || !fillsExplainEnough(fills, pos));

  if (needCoinFetch && address) {
    try {
      const remote = await fetchUserFillsByCoin(address, pos?.coin || decoded, {
        lookbackMs: 21 * 24 * 60 * 60 * 1000,
        maxPages: 12,
        currentSize: pos?.size,
        side: pos?.side || wantSide || undefined,
      });
      fills = mergeFillLists(remote, fills);
      // 同步写入本地成交，资金动态才能看到减仓/平仓
      if (remote.length) {
        const trades = remote.map((fill) => mapFillToTrade(fill, { ...whale, address }, names));
        try {
          const { persistTradesIncremental } = require('./sqliteStore');
          persistTradesIncremental(trades);
        } catch {
          // optional
        }
        try {
          const mode = 'hf';
          const cachedTrades = readWhaleModeCache(mode);
          if (cachedTrades?.data) {
            const map = new Map();
            for (const trade of [...(cachedTrades.data.trades || []), ...trades]) {
              const key = String(trade?.id || trade?.hash || '');
              if (!key || map.has(key)) continue;
              map.set(key, trade);
            }
            const merged = [...map.values()]
              .sort((a, b) => Number(b.time || 0) - Number(a.time || 0))
              .slice(0, 4000);
            writeWhaleModeCache(mode, { ...cachedTrades.data, trades: merged });
          }
        } catch {
          // optional
        }
      }
    } catch (err) {
      console.warn(`[whales] ${whale.name} ${decoded} 成交补齐失败:`, err.message);
    }
  }

  if (pos) {
    const coinKey = pos.coin || decoded;
    const side = pos.side || wantSide || 'long';
    const size = pos.size;
    const timing = buildPositionOpenTiming(fills, coinKey, size, side);
    const entries = buildPositionEntryFills(fills, coinKey, size, side);
    const entryFills =
      Array.isArray(entries.entryFills) && entries.entryFills.length
        ? entries.entryFills
        : pos.entryFills || [];
    const entryFillsOmitted =
      entries.entryFillsOmitted != null
        ? entries.entryFillsOmitted
        : pos.entryFillsOmitted || 0;
    const enriched = {
      openTime: timing.openTime || pos.openTime || pos.firstOpenTime || null,
      firstOpenTime: timing.firstOpenTime || pos.firstOpenTime || pos.openTime || null,
      lastAddTime: timing.lastAddTime || pos.lastAddTime || null,
      openHistoryComplete:
        timing.openHistoryComplete != null
          ? timing.openHistoryComplete
          : pos.openHistoryComplete,
      entryFills,
      entryFillsOmitted,
    };

    if (entryFills.length > (pos.entryFills || []).length || entryFillsThin(pos)) {
      patchCachedPositionFields(whale.id, coinKey, side, enriched);
    }

    let markPx = pos.markPx ?? null;
    try {
      const mids = await fetchAllMids();
      const midMap = mids?.mids && typeof mids.mids === 'object' ? mids.mids : mids;
      const candidates = [
        pos.coin,
        pos.coinLabel,
        coinLabel(pos.coin, names),
        String(decoded || ''),
      ]
        .map((c) => String(c || '').trim())
        .filter(Boolean);
      for (const key of candidates) {
        const direct = Number(midMap?.[key] ?? midMap?.[key.toUpperCase()]);
        if (Number.isFinite(direct) && direct > 0) {
          markPx = direct;
          break;
        }
      }
    } catch {
      // keep cached/derived
    }

    return {
      whale: {
        id: whale.id,
        name: whale.name || snap.name,
        address: address || snap.address || '',
      },
      updatedAt: Date.now(),
      source: entryFills.length > 1 ? 'enriched' : 'local',
      stale: Boolean(cached?.stale),
      position: {
        coin: pos.coin,
        coinLabel: pos.coinLabel || coinLabel(pos.coin, names) || pos.coin,
        kind: pos.kind || 'perp',
        side: pos.side,
        size: pos.size,
        entryPx: pos.entryPx,
        markPx,
        positionValue: pos.positionValue,
        unrealizedPnl: pos.unrealizedPnl,
        liquidationPx:
          pos.liquidationPx == null || pos.liquidationPx === ''
            ? null
            : Number(pos.liquidationPx),
        leverage: pos.leverage,
        leverageLabel: pos.leverageLabel || (pos.leverage ? `${pos.leverage}x` : '现货'),
        marginUsed: pos.marginUsed ?? null,
        takeProfit: pos.takeProfit ?? null,
        stopLoss: pos.stopLoss ?? null,
        explorerUrl: explorerUrl(address || snap.address || ''),
        ...enriched,
      },
    };
  }

  // 已平仓：用成交还原最近一轮
  const closed = closedPositionFromFills(whale, decoded, fills, names, wantSide);
  if (closed?.position) {
    const cycleSide = closed.position.side;
    const cycleSize = closed.position.size;
    // 用平仓量近似反推该轮开/补仓明细
    const entries = buildPositionEntryFills(fills, decoded, cycleSize, cycleSide);
    closed.position.entryFills = entries.entryFills || [];
    closed.position.entryFillsOmitted = entries.entryFillsOmitted || 0;
    closed.position.firstOpenTime = closed.position.openTime;
    closed.position.lastAddTime = closed.position.openTime;
    closed.position.openHistoryComplete = false;
    return closed;
  }

  const error = new Error(`本地暂无 ${decoded} 持仓（等待服务器 WS 同步）`);
  error.status = 404;
  throw error;
}

function fillsExplainEnough(fills, pos) {
  if (!pos) return false;
  const meta = analyzePositionEntries(fills, pos.coin, pos.size, pos.side);
  return Boolean(meta.complete && meta.entries.length > 1);
}

async function getWhales(force = false) {
  const mode = 'hf';
  let cached = readWhaleModeCache(mode);

  // JSON 缓存为空时，回退读取 SQLite（重启后仍可秒开）
  if (!cached?.data?.whales?.length) {
    try {
      const { loadModePayload } = require('./sqliteStore');
      const fromDb = loadModePayload();
      if (fromDb?.data?.whales?.length) {
        cached = {
          data: fromDb.data,
          updatedAt: fromDb.updatedAt,
          stale: Date.now() - fromDb.updatedAt > 3 * 60 * 1000,
        };
        console.log(`[sqlite] 接口回退读库 whales=${fromDb.data.whales.length}`);
      }
    } catch (err) {
      console.warn('[sqlite] 读取失败:', err.message);
    }
  }

  // 请求路径：有缓存一律秒回，刷新全部丢给后台分片
  if (cached?.data?.whales?.length) {
    const pending = countPendingWhales(cached.data.whales);
    const incomplete = pending > 0;
    if (force || cached.stale || incomplete) {
      refreshWhalesShard().catch((err) => {
        console.warn('[whales] 后台分片刷新失败:', err.message);
      });
    }
    return {
      ...cached.data,
      activity: buildActivityFeed(cached.data.trades || []),
      stale: Boolean(force || cached.stale || incomplete),
      incomplete,
      pending,
      updatedAt: cached.updatedAt,
    };
  }

  // 无缓存时也不再同步阻塞打上游；后台分片 + WS 慢慢补
  if (force || !cached?.data?.whales?.length) {
    refreshWhalesShard().catch((err) => {
      console.warn('[whales] 后台分片预热失败:', err.message);
    });
  }

  return {
    mode,
    whales: [],
    trades: [],
    warnings: ['缓存预热中，请稍后刷新'],
    minUsd: MIN_USD,
    stale: true,
    incomplete: true,
    pending: 0,
    updatedAt: 0,
  };
}

function parseBatchQuery(query = {}) {
  const offset = Math.max(0, parseInt(query.offset, 10) || 0);
  const limit = Math.min(
    WHALE_BATCH_MAX,
    Math.max(1, parseInt(query.limit, 10) || WHALE_BATCH_DEFAULT),
  );
  return { offset, limit, refresh: query.refresh === '1' };
}

function buildTradesFromSnapshots(snapshots, onchain, enabledWhales) {
  const hlTrades = snapshots.flatMap((item) => item.trades || []);
  const alerts = onchain?.alerts || [];
  const watchedOnchain = alerts
    .map((trade) => attachWatchedWhale(trade, enabledWhales))
    .filter((trade) => trade.whaleId);
  const globalOnchain = alerts
    .map((trade) => attachWatchedWhale(trade, enabledWhales))
    .filter((trade) => !trade.whaleId)
    .slice(0, 30);
  return [...hlTrades, ...watchedOnchain, ...globalOnchain].sort((a, b) => b.time - a.time);
}

function formatBatchPayload({
  mode,
  roster,
  snapshots,
  onchain,
  loaded,
  total,
  offset,
  nextOffset,
  limit,
  done,
  updatedAt,
  stale,
}) {
  const whales = sortWhales(
    snapshots.map(({ trades: _t, ...rest }) => rest),
    mode,
  );
  const trades = buildTradesFromSnapshots(snapshots, onchain, roster);
  const warnings = snapshots
    .filter((item) => item.error)
    .map((item) => `${item.name}：${item.error}`);
  if (onchain?.warning) warnings.push(onchain.warning);
  return {
    mode,
    whales,
    trades,
    activity: buildActivityFeed(trades),
    warnings,
    minUsd: MIN_USD,
    progressive: true,
    loaded,
    total,
    offset,
    nextOffset: nextOffset != null ? nextOffset : loaded,
    limit,
    done,
    stale: Boolean(stale),
    updatedAt: updatedAt || Date.now(),
  };
}

/**
 * 单个巨鲸「刷新」：只回读本地缓存 / 库，不打上游。
 * 最新仓位与成交由服务器 WS 持续维护。
 */
async function refreshSingleWhale(id) {
  const whale = findConfiguredWhale(id);
  if (!whale) {
    const error = new Error('未找到该巨鲸');
    error.status = 404;
    throw error;
  }
  const mode = 'hf';
  const cached = readWhaleModeCache(mode);
  let profile = (cached?.data?.whales || []).find((item) => item.id === whale.id);
  if (!profile) {
    try {
      const { loadModePayload } = require('./sqliteStore');
      const fromDb = loadModePayload();
      profile = (fromDb?.data?.whales || []).find((item) => item.id === whale.id);
    } catch {
      // ignore
    }
  }
  if (!profile) {
    profile = {
      ...whale,
      direction: 'neutral',
      longUsd: 0,
      shortUsd: 0,
      netUsd: 0,
      positions: [],
      error: null,
    };
  }

  const tradeQuery = await getWhaleTrades(whale.id, { page: 1, limit: 200 });
  return {
    whale: {
      ...profile,
      name: whale.name,
      address: whale.address,
      enabled: whale.enabled,
    },
    trades: tradeQuery.trades || [],
    updatedAt: cached?.updatedAt || Date.now(),
    source: 'local',
  };
}

/**
 * 分段拉取巨鲸：默认每次 1 个。
 * 有完整磁盘缓存时直接返回全量；若仍含「等待刷新」占位，则种下会话并让前端从首个占位继续补齐。
 */
async function getWhalesBatch(query = {}) {
  const mode = 'hf';
  const { offset, limit, refresh } = parseBatchQuery(query);
  const roster = getActiveWhales();
  const total = roster.length;

  if (refresh && offset === 0) {
    // 不清空磁盘缓存：刷新期间 /trades、/whales 仍可读旧快照，完成后覆盖写入
    progressiveSession = null;
  }

  if (offset === 0 && !refresh) {
    let cached = readWhaleModeCache(mode);
    if (cached && !isWhaleCacheCompatible(cached)) {
      // 名单变更：仍返回旧缓存给前端，同时后台分片对齐，避免线上瞬间无数据
      refreshWhalesShard().catch((err) => {
        console.warn('[whales] 名单变更后分片对齐失败:', err.message);
      });
    }
    if (cached?.data?.whales?.length) {
      const pending = countPendingWhales(cached.data.whales);
      if (pending === 0) {
        if (cached.stale) {
          refreshWhalesShard().catch((err) => {
            console.warn('[whales] 过期缓存后台分片刷新失败:', err.message);
          });
        }
        return formatCachedBatchPayload(cached, mode);
      }
      // 不完整：种会话，返回 done=false，让前端从首个占位继续拉
      seedProgressiveFromCache(mode, roster, cached);
      console.log(`[whales] 缓存含 ${pending} 个等待刷新，继续分段补齐`);
      return formatCachedBatchPayload(cached, mode);
    }
  }

  const rosterIds = roster.map((item) => String(item.id || ''));
  const rosterKey = rosterIds.join('|');
  let needReset =
    !progressiveSession ||
    offset === 0 ||
    progressiveSession.mode !== mode ||
    progressiveSession.rosterKey !== rosterKey;

  if (needReset && offset !== 0) {
    // 会话被冲掉时：完整缓存直接收尾；不完整则重新种会话并继续本批
    const cached = readWhaleModeCache(mode);
    if (cached?.data?.whales?.length) {
      const pending = countPendingWhales(cached.data.whales);
      if (pending === 0) {
        console.warn(`[whales] 分段会话失效 offset=${offset}，改回完整缓存 ${cached.data.whales.length} 条`);
        return formatCachedBatchPayload(cached, mode);
      }
      console.warn(`[whales] 分段会话失效 offset=${offset}，从不完整缓存恢复并继续补齐`);
      seedProgressiveFromCache(mode, roster, cached);
      needReset = false;
    } else {
      console.warn(
        `[whales] 分段会话失效 offset=${offset} 原因=${
          !progressiveSession
            ? 'session-missing'
            : progressiveSession.mode !== mode
              ? 'mode-changed'
              : 'roster-changed'
        }，要求从 0 重来`,
      );
      const err = new Error('分段加载会话已失效，请从 offset=0 重新开始');
      err.code = 'WHALE_BATCH_RESET';
      err.status = 409;
      throw err;
    }
  }

  if (needReset) {
    progressiveSession = {
      mode,
      rosterKey,
      names: null,
      onchain: null,
      snapshots: new Array(total).fill(null),
      updatedAt: Date.now(),
      activeAt: Date.now(),
    };
    // 强制刷新时也尽量保留已有真实快照，少打 HL
    if (refresh) {
      const cached = readWhaleModeCache(mode);
      if (cached?.data?.whales?.length) {
        const byId = new Map(cached.data.whales.map((item) => [item.id, item]));
        progressiveSession.snapshots = roster.map((whale) => {
          const hit = byId.get(whale.id);
          if (!hit || isPendingPlaceholder(hit)) return null;
          return { ...hit, trades: [] };
        });
      }
    }
  } else if (progressiveSession) {
    progressiveSession.updatedAt = Date.now();
  }

  if (!progressiveSession.names) {
    progressiveSession.names = await fetchCoinNameMap().catch(() => ({}));
  }
  if (!progressiveSession.onchain) {
    progressiveSession.onchain = await fetchWhaleAlerts(MIN_USD, 50).catch(() => ({
      alerts: [],
      warning: null,
    }));
  }

  // await 期间会话可能被 refresh/重启清掉，后面一律用本地引用
  const session = progressiveSession;
  if (!session?.snapshots) {
    const err = new Error('分段加载会话已中断，请重试');
    err.code = 'WHALE_BATCH_RESET';
    err.status = 409;
    throw err;
  }

  const slice = roster.slice(offset, offset + limit);
  if (!slice.length) {
    const loadedSnapshots = session.snapshots.filter(Boolean);
    return formatBatchPayload({
      mode,
      roster,
      snapshots: loadedSnapshots,
      onchain: session.onchain,
      loaded: loadedSnapshots.length,
      total,
      offset,
      nextOffset: total,
      limit,
      done: true,
      updatedAt: session.updatedAt,
      stale: loadedSnapshots.length < total,
    });
  }

  session.activeAt = Date.now();
  session.updatedAt = Date.now();
  let batchSnapshots;
  try {
    // 已有真实快照则跳过 HL，只补占位/空位
    const needFetch = [];
    const fetchSlots = [];
    batchSnapshots = slice.map((whale, i) => {
      const prev = session.snapshots[offset + i];
      if (prev && !isPendingPlaceholder(prev)) return prev;
      needFetch.push(whale);
      fetchSlots.push(i);
      return null;
    });
    if (needFetch.length) {
      const diskWhales = Array.isArray(readWhaleModeCache(mode)?.data?.whales)
        ? readWhaleModeCache(mode).data.whales
        : [];
      const diskById = new Map(diskWhales.map((item) => [item.id, item]));
      const fallbackById = new Map();
      for (const whale of needFetch) {
        const idx = roster.findIndex((item) => item.id === whale.id);
        const sessionHit = idx >= 0 ? session.snapshots[idx] : null;
        const fallback =
          (sessionHit && !isPendingPlaceholder(sessionHit) ? sessionHit : null) ||
          diskById.get(whale.id) ||
          null;
        if (fallback) fallbackById.set(whale.id, fallback);
      }
      const fetched = await loadWhaleSnapshotsBatch(needFetch, session.names, fallbackById, {
        light: true,
      });
      fetched.forEach((snap, i) => {
        batchSnapshots[fetchSlots[i]] = snap;
      });
    }
  } finally {
    // 批次结束后仍保留 updatedAt，让分片在整轮分段完成前继续让路
    if (progressiveSession === session) {
      session.activeAt = 0;
      session.updatedAt = Date.now();
    }
  }

  if (progressiveSession !== session || !session.snapshots) {
    const cached = readWhaleModeCache(mode);
    if (cached?.data?.whales?.length && countPendingWhales(cached.data.whales) === 0) {
      console.warn('[whales] 分段批次中断，回退完整缓存');
      return formatCachedBatchPayload(cached, mode);
    }
    const err = new Error('分段加载会话已中断，请重试');
    err.code = 'WHALE_BATCH_RESET';
    err.status = 409;
    throw err;
  }

  for (let i = 0; i < batchSnapshots.length; i += 1) {
    if (batchSnapshots[i]) session.snapshots[offset + i] = batchSnapshots[i];
  }

  const nextOffset = Math.min(offset + batchSnapshots.length, total);
  const done = nextOffset >= total;
  const loadedSnapshots = session.snapshots.slice(0, nextOffset).filter(Boolean);
  const loaded = loadedSnapshots.length;
  session.updatedAt = Date.now();

  if (done) {
    try {
      // 异动完整性优先：尽量给有仓巨鲸补近 7 天成交 + openTime
      const withPos = loadedSnapshots.filter(
        (whale) => (whale?.positions || []).some((pos) => (Number(pos.positionValue) || 0) > 0),
      ).length;
      await enrichWhaleFillsAndTiming(loadedSnapshots, session.names || {}, {
        maxWhales: Math.min(80, Math.max(24, withPos)),
        concurrency: 4,
        force: true,
      });
    } catch (err) {
      console.warn('[whales] 分段完成时成交/开仓时间补齐失败:', err.message);
    }
    const diskTrades = Array.isArray(readWhaleModeCache(mode)?.data?.trades)
      ? readWhaleModeCache(mode).data.trades
      : [];
    const freshTrades = buildTradesFromSnapshots(loadedSnapshots, session.onchain, roster);
    const refreshedIds = new Set(
      loadedSnapshots.filter((s) => Array.isArray(s.trades) && s.trades.length).map((s) => s.id),
    );
    const keptDisk = diskTrades.filter((trade) => {
      if (trade?.source === 'onchain') return false; // onchain 以本次为准
      if (trade?.whaleId && refreshedIds.has(trade.whaleId)) return false;
      return true;
    });
    const seenTrade = new Set();
    const trades = [...freshTrades, ...keptDisk]
      .filter((trade) => {
        const id = String(trade?.id || '');
        if (!id || seenTrade.has(id)) return false;
        seenTrade.add(id);
        return true;
      })
      .sort((a, b) => Number(b.time || 0) - Number(a.time || 0));

    const payload = {
      mode,
      whales: sortWhales(
        loadedSnapshots.map(({ trades: _t, ...rest }) => rest),
        mode,
      ),
      trades,
      warnings: loadedSnapshots
        .filter((item) => item.error)
        .map((item) => `${item.name}：${item.error}`),
      minUsd: MIN_USD,
    };
    if (session.onchain?.warning) {
      payload.warnings.push(session.onchain.warning);
    }
    const saved = writeWhaleModeCache(mode, payload);
    if (progressiveSession === session) progressiveSession = null;
    persistOpenTimingEnrichment(mode).catch(() => null);
    return {
      ...payload,
      activity: buildActivityFeed(payload.trades),
      progressive: true,
      loaded,
      total,
      offset,
      nextOffset: total,
      limit,
      done: true,
      incomplete: false,
      pending: 0,
      stale: false,
      updatedAt: saved.updatedAt,
    };
  }

  return formatBatchPayload({
    mode,
    roster,
    snapshots: loadedSnapshots,
    onchain: session.onchain,
    loaded,
    total,
    offset,
    nextOffset,
    limit,
    done: false,
    updatedAt: session.updatedAt,
    stale: true,
  });
}

module.exports = {
  getWhales,
  getWhalesBatch,
  refreshSingleWhale,
  refreshAlertHistory,
  closedPositionFromFills,
  isProgressiveLoading,
  refreshWhales,
  refreshWhalesShard,
  refreshWhalesForMode,
  invalidateWhaleCache,
  readActiveWhaleCache,
  listTrades,
  getWhaleTrades,
  getWhaleTransfers,
  getWhalePosition,
  buildActivityFeed,
  getActivitySince,
  ACTIVITY_WINDOW_MS,
};
