const { hlPost, getHlInfoConfig, MAX_CONCURRENT, isRateLimited } = require('./hlInfoClient');

const cache = new Map();

/**
 * 内存缓存；上游失败时若有未过期太久的旧值则返回（抗 429）。
 * @param {string} key
 * @param {number} ttlMs 新鲜期
 * @param {() => Promise<any>} loader
 * @param {{ staleMs?: number }} [options] 失败时允许使用的过期窗口，默认 max(ttl*20, 10min)
 */
async function withCache(key, ttlMs, loader, options = {}) {
  const now = Date.now();
  const staleMs = Math.max(
    Number(options.staleMs) || 0,
    ttlMs * 20,
    10 * 60 * 1000,
  );
  const hit = cache.get(key);
  if (hit?.value !== undefined && now - hit.at < ttlMs) return hit.value;
  if (hit?.inflight) return hit.inflight;
  const inflight = loader()
    .then((value) => {
      cache.set(key, { at: Date.now(), value, inflight: null });
      return value;
    })
    .catch((err) => {
      const cur = cache.get(key);
      if (cur?.value !== undefined && Date.now() - (cur.at || 0) < staleMs) {
        console.warn(`[hl] ${key} 上游失败，使用过期缓存:`, err.message || err);
        return cur.value;
      }
      throw err;
    })
    .finally(() => {
      const cur = cache.get(key);
      if (cur) cur.inflight = null;
    });
  cache.set(key, { at: hit?.at || 0, value: hit?.value, inflight });
  return inflight;
}

/**
 * 查询 Hyperliquid 永续仓位。
 * 这是「当前方向：做多/做空/观望」的真实数据源。
 * 经 hlInfoClient：默认官方 Hyperliquid；仅 HL_USE_GOLDRUSH=1 时走 GoldRush。
 */
async function fetchClearinghouseState(address) {
  const user = address.toLowerCase();
  return withCache(`state:${user}`, 20000, () =>
    hlPost({ type: 'clearinghouseState', user: address }),
  );
}

/**
 * GoldRush 批量仓位（最多 50 个）；非 GoldRush 或不支持时逐个回退。
 */
async function fetchBatchClearinghouseStates(addresses = []) {
  const users = [...new Set((addresses || []).map((item) => String(item || '').trim()).filter(Boolean))].slice(
    0,
    50,
  );
  if (!users.length) return {};

  const cfg = getHlInfoConfig();
  if (cfg.usingGoldRush) {
    try {
      const data = await hlPost({ type: 'batchClearinghouseState', users });
      if (Array.isArray(data)) {
        const out = {};
        for (let i = 0; i < users.length; i += 1) {
          if (data[i] != null) out[users[i].toLowerCase()] = data[i];
        }
        return out;
      }
      if (data && typeof data === 'object') {
        const out = {};
        for (const user of users) {
          const key = user.toLowerCase();
          const hit = data[user] ?? data[key];
          if (hit != null) out[key] = hit;
        }
        if (Object.keys(out).length) return out;
      }
    } catch (err) {
      console.warn('[hl] batchClearinghouseState 失败，回退逐个查询:', err.message || err);
    }
  }

  const out = {};
  await Promise.all(
    users.map(async (user) => {
      try {
        out[user.toLowerCase()] = await fetchClearinghouseState(user);
      } catch {
        // 单个失败跳过
      }
    }),
  );
  return out;
}

/**
 * 最近成交（最多约 2000 条）。用作「巨鲸交易列表」主数据。
 * @deprecated 优先用 fetchUserFillsByTime；保留给兼容调用
 */
async function fetchUserFills(address) {
  return fetchUserFillsByTime(address, Date.now() - FILL_LOOKBACK_MS);
}

/** 近 1 天成交回看窗口（资金动态）；可用 FILL_RETENTION_DAYS 对齐 */
const FILL_LOOKBACK_MS = Math.max(
  60 * 60 * 1000,
  (Number(process.env.FILL_RETENTION_DAYS) || 1) * 24 * 60 * 60 * 1000,
);
const FILL_PAGE_SIZE = 2000;
const FILL_MAX_PAGES = 6;

/**
 * 按时间范围拉取成交（userFillsByTime）。
 * 官方单次最多 2000 条、升序返回；打满则用最后一条 time+1 继续翻页。
 * 仅最近约 10000 条可查。
 */
async function fetchUserFillsByTime(address, startTime, endTime = Date.now()) {
  const user = String(address || '').toLowerCase();
  const start = Math.max(0, Number(startTime) || 0);
  const end = Math.max(start, Number(endTime) || Date.now());
  const cacheKey = `fills-by-time:${user}:${start}:${Math.floor(end / 60_000)}`;

  return withCache(cacheKey, 60_000, async () => {
    const seen = new Set();
    const all = [];
    let cursorStart = start;
    let pages = 0;

    while (pages < FILL_MAX_PAGES && cursorStart <= end) {
      const data = await hlPost({
        type: 'userFillsByTime',
        user: address,
        startTime: cursorStart,
        endTime: end,
      });
      const page = Array.isArray(data) ? data : [];
      pages += 1;
      if (!page.length) break;

      for (const fill of page) {
        const key = `${fill.tid ?? ''}:${fill.hash ?? ''}:${fill.time}:${fill.coin}:${fill.sz}:${fill.px}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(fill);
      }

      if (page.length < FILL_PAGE_SIZE) break;
      const lastTime = Number(page[page.length - 1]?.time) || cursorStart;
      const nextStart = lastTime + 1;
      if (nextStart <= cursorStart) break;
      cursorStart = nextStart;
    }

    return all;
  });
}

/**
 * 非资金费账本：充值 / 提现 / 划转 / 金库等（不含 funding）。
 * @param {string} address
 * @param {number} [startTime]
 * @param {number} [endTime]
 */
async function fetchUserNonFundingLedgerUpdates(address, startTime, endTime = Date.now()) {
  const user = String(address || '').toLowerCase();
  const start = Math.max(0, Number(startTime) || Date.now() - 30 * 24 * 60 * 60 * 1000);
  const end = Math.max(start, Number(endTime) || Date.now());
  const cacheKey = `ledger:${user}:${start}:${Math.floor(end / 60_000)}`;

  return withCache(cacheKey, 45_000, async () => {
    const data = await hlPost({
      type: 'userNonFundingLedgerUpdates',
      user: address,
      startTime: start,
      endTime: end,
    });
    return Array.isArray(data) ? data : [];
  });
}

/**
 * 按币种收集成交。官方 userFillsByTime 不支持 coin 过滤，且按时间升序截断 2000 条：
 * 窗口过大时只会返回最旧的一批。这里从 now 往回切短窗口，打满则缩小窗口，
 * 空窗口则继续往过去走，直到能反推当前仓位或达到页数上限。
 */
async function fetchUserFillsByCoin(
  address,
  coin,
  {
    lookbackMs = 21 * 24 * 3600 * 1000,
    maxPages = 10,
    currentSize,
    side,
  } = {},
) {
  const symbol = String(coin || '').toUpperCase();
  if (!symbol) return [];
  const user = address.toLowerCase();
  const cacheKey = `fills-rev:${user}:${symbol}:${lookbackMs}:${maxPages}`;

  return withCache(cacheKey, 20000, async () => {
    const now = Date.now();
    const hardStart = now - lookbackMs;
    const seen = new Set();
    const all = [];
    let endTime = now;
    let windowMs = 30 * 60 * 1000;
    let pages = 0;
    let emptyStreak = 0;
    let shrinks = 0;
    let catchingNewest = true;

    while (pages < maxPages && endTime > hardStart && shrinks < 24) {
      const startTime = Math.max(hardStart, endTime - windowMs);
      if (startTime >= endTime) break;

      const data = await hlPost({
        type: 'userFillsByTime',
        user: address,
        startTime,
        endTime,
      });
      const pageFills = Array.isArray(data) ? data : [];

      if (catchingNewest && pageFills.length >= 2000 && windowMs > 60 * 1000) {
        windowMs = Math.max(60 * 1000, Math.floor(windowMs / 2));
        shrinks += 1;
        continue;
      }
      catchingNewest = false;

      pages += 1;
      if (!pageFills.length) {
        emptyStreak += 1;
        endTime = startTime - 1;
        windowMs = Math.min(windowMs * 2, 6 * 60 * 60 * 1000);
        if (emptyStreak >= 6) break;
        continue;
      }
      emptyStreak = 0;

      for (const fill of pageFills) {
        const key = `${fill.tid ?? ''}:${fill.hash ?? ''}:${fill.time}:${fill.coin}:${fill.sz}:${fill.px}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(fill);
      }

      const oldest = pageFills.reduce((min, fill) => {
        const t = Number(fill.time) || endTime;
        return t < min ? t : min;
      }, endTime);
      endTime = oldest - 1;
      if (pageFills.length < 400) {
        windowMs = Math.min(windowMs * 2, 6 * 60 * 60 * 1000);
      }

      if (
        currentSize != null &&
        side &&
        fillsExplainPosition(all, symbol, currentSize, side)
      ) {
        break;
      }
    }

    return fillsForCoin(all, symbol);
  });
}

/** 现有 fills 能否反推出当前持仓的开仓链 */
function fillsExplainPosition(fills, coin, currentSize, side) {
  const list = fillsForCoin(fills, coin);
  if (!list.length) return false;
  const sign = side === 'short' ? -1 : 1;
  let signed = Math.abs(Number(currentSize) || 0) * sign;
  for (const fill of list) {
    if (Math.abs(signed) < 1e-8) return true;
    const fillSign = fill.side === 'B' ? 1 : -1;
    signed -= fillSign * (Number(fill.sz) || 0);
  }
  return Math.abs(signed) < 1e-4;
}

/** 推断开仓/补仓时优先用能覆盖当前仓位的 coin 级历史 */
async function resolveFillsForPosition(address, coin, currentSize, side, allFills) {
  if (fillsExplainPosition(allFills, coin, currentSize, side)) return allFills;
  const coinFills = await fetchUserFillsByCoin(address, coin, { currentSize, side });
  if (!coinFills.length) return allFills;
  const merged = [...coinFills, ...(Array.isArray(allFills) ? allFills : [])];
  return fillsForCoin(merged, coin);
}

function isExoticAsset(coin) {
  const value = String(coin || '');
  return /^@\d+$/i.test(value) || value.includes(':');
}

function explorerUrl(address, coin = '') {
  const user = String(address || '').toLowerCase();
  if (!user) return 'https://app.hyperliquid.xyz/';
  const base = `https://app.hyperliquid.xyz/explorer/address/${user}`;
  return coin ? `${base}` : base;
}

function tradeUrl(coin) {
  const value = String(coin || '').trim();
  if (!value) return 'https://app.hyperliquid.xyz/trade';
  return `https://app.hyperliquid.xyz/trade/${encodeURIComponent(value)}`;
}

async function fetchCoinNameMap() {
  return withCache('coinNames', 30 * 60 * 1000, async () => {
    const map = {};
    try {
      const spot = await hlPost({ type: 'spotMeta' });
      const tokens = new Map((spot.tokens || []).map((item) => [item.index, item]));
      for (const row of spot.universe || []) {
        const base = tokens.get(row.tokens?.[0]);
        const quote = tokens.get(row.tokens?.[1]);
        let label = row.name;
        if (base?.name) {
          label = quote?.name && quote.name !== 'USDC' ? `${base.name}/${quote.name}` : base.name;
        }
        if (row.index != null) map[`@${row.index}`] = label;
        if (row.name) map[String(row.name).toUpperCase()] = label;
        if (base?.name) map[String(base.name).toUpperCase()] = label;
      }
    } catch (_err) {
      // 名称映射失败时仍展示原始 @index
    }
    try {
      const meta = await hlPost({ type: 'meta' });
      for (const row of meta.universe || []) {
        if (row?.name) map[String(row.name).toUpperCase()] = row.name;
      }
    } catch (_err) {
      // ignore
    }
    return map;
  });
}

async function fetchAllMids() {
  return withCache('allMids', 15000, async () => {
    const data = await hlPost({ type: 'allMids' });
    return data && typeof data === 'object' ? data : {};
  });
}

/**
 * 用户挂单（含止损/止盈条件单）。
 * 文档：POST { type: "frontendOpenOrders", user }
 */
async function fetchFrontendOpenOrders(address) {
  const user = address.toLowerCase();
  return withCache(`openOrders:${user}`, 20000, async () => {
    const data = await hlPost({ type: 'frontendOpenOrders', user: address });
    return Array.isArray(data) ? data : [];
  });
}

function isStopOrderType(orderType) {
  const type = String(orderType || '');
  return /stop/i.test(type) && !/take profit/i.test(type);
}

function isTakeProfitOrderType(orderType) {
  return /take profit/i.test(String(orderType || ''));
}

function extractTpslForCoin(orders, coin, side, names = {}) {
  const matched = (Array.isArray(orders) ? orders : []).filter((order) => {
    if (!coinMatches(order.coin, coin, names)) return false;
    if (!Number(order.triggerPx)) return false;
    return order.isTrigger || order.isPositionTpsl || isStopOrderType(order.orderType) || isTakeProfitOrderType(order.orderType);
  });
  if (!matched.length) {
    return {
      stopLossPx: null,
      takeProfitPx: null,
      stopLossType: null,
      takeProfitType: null,
    };
  }

  const closeSide = side === 'long' ? 'A' : 'B';
  const pool = matched.filter(
    (order) => order.isPositionTpsl || order.reduceOnly || order.side === closeSide,
  );
  const relevant = pool.length ? pool : matched;
  const stops = relevant.filter((order) => isStopOrderType(order.orderType));
  const tps = relevant.filter((order) => isTakeProfitOrderType(order.orderType));

  const stopNums = stops.map((order) => Number(order.triggerPx)).filter((px) => px > 0);
  const tpNums = tps.map((order) => Number(order.triggerPx)).filter((px) => px > 0);

  let stopLossPx = null;
  let takeProfitPx = null;
  if (side === 'long') {
    stopLossPx = stopNums.length ? Math.max(...stopNums) : null;
    takeProfitPx = tpNums.length ? Math.min(...tpNums) : null;
  } else {
    stopLossPx = stopNums.length ? Math.min(...stopNums) : null;
    takeProfitPx = tpNums.length ? Math.max(...tpNums) : null;
  }

  const stopOrder = stops.find((order) => Number(order.triggerPx) === stopLossPx) || null;
  const tpOrder = tps.find((order) => Number(order.triggerPx) === takeProfitPx) || null;

  return {
    stopLossPx,
    takeProfitPx,
    stopLossType: stopOrder?.orderType || null,
    takeProfitType: tpOrder?.orderType || null,
  };
}

function coinLabel(coin, names = {}) {
  const raw = String(coin || '');
  if (!raw) return '';
  return names[raw] || names[raw.toUpperCase()] || raw;
}

function fillsForCoin(fills, coin) {
  const target = String(coin || '').toUpperCase();
  return (Array.isArray(fills) ? fills : [])
    .filter((fill) => String(fill.coin || '').toUpperCase() === target)
    .sort((a, b) => Number(b.time) - Number(a.time));
}

/** 补仓记录合并窗口：10 秒内视为同一笔拆单 */
const ENTRY_FILL_MERGE_MS = 10_000;

/** 同一时间窗口内的同类成交合并为一笔（加权均价） */
function mergeEntriesByWindow(entries, windowMs = ENTRY_FILL_MERGE_MS) {
  const merged = [];
  for (const entry of entries) {
    const prev = merged[merged.length - 1];
    if (prev && prev.kind === entry.kind && entry.time - prev.time <= windowMs) {
      const size = prev.size + entry.size;
      const usd = prev.usd + entry.usd;
      prev.size = size;
      prev.usd = usd;
      prev.price = size > 0 ? usd / size : entry.price;
      prev.closedPnl = (prev.closedPnl || 0) + (entry.closedPnl || 0);
      continue;
    }
    merged.push({ ...entry });
  }
  return merged;
}

/** 仓位明细保留首尾各这么多条，中间省略 */
const ENTRY_FILL_EDGE = 1000;

/** 超过 2*EDGE 时只保留前 EDGE + 后 EDGE，并返回省略条数 */
function trimEntryFillsEdges(fills, edge = ENTRY_FILL_EDGE) {
  const list = Array.isArray(fills) ? fills : [];
  if (list.length <= edge * 2) {
    return { entryFills: list, entryFillsOmitted: 0 };
  }
  return {
    entryFills: list.slice(0, edge).concat(list.slice(-edge)),
    entryFillsOmitted: list.length - edge * 2,
  };
}

/** 推断并裁剪：开仓在前、最新在后；中间过多时省略 */
function buildPositionEntryFills(fills, coin, currentSize, side) {
  return trimEntryFillsEdges(analyzePositionEntries(fills, coin, currentSize, side).entries);
}

/**
 * 还原当前仓位周期的开仓/补仓/减仓，并判定历史是否完整。
 * complete=false：fills 无法覆盖到仓位从 0 建起，首次开仓时间不可靠。
 */
function analyzePositionEntries(fills, coin, currentSize, side) {
  const list = fillsForCoin(fills, coin);
  const empty = {
    entries: [],
    complete: false,
    firstOpenTime: null,
    lastAddTime: null,
    earliestVisibleTime: null,
  };
  if (!list.length) return empty;

  const sign = side === 'short' ? -1 : 1;
  const absSize = Math.abs(Number(currentSize) || 0);
  const tol = Math.max(1e-8, absSize * 1e-6);
  let signed = absSize * sign;
  const rawEntries = [];

  for (const fill of list) {
    if (Math.abs(signed) < tol) break;
    const fillSign = fill.side === 'B' ? 1 : -1;
    const sz = Number(fill.sz) || 0;
    const px = Number(fill.px) || 0;
    rawEntries.push({
      time: Number(fill.time) || 0,
      price: px,
      size: Math.abs(sz),
      usd: Math.abs(px * sz),
      // 与持仓同向为加仓，反向为减仓
      kind: fillSign === sign ? 'add' : 'reduce',
      closedPnl: Number(fill.closedPnl) || 0,
    });
    signed -= fillSign * sz;
  }

  const complete = Math.abs(signed) < tol;
  const ordered = mergeEntriesByWindow(rawEntries.reverse());
  // 当前仓位周期从第一笔同向成交（开仓）开始；更早的减仓属于上一轮已平仓，丢掉
  const firstAdd = ordered.findIndex((item) => item.kind === 'add');
  if (firstAdd < 0) {
    return { ...empty, complete };
  }
  const cycle = ordered.slice(firstAdd);
  cycle[0].kind = 'open';

  const earliestVisibleTime = Number(cycle[0].time) || null;
  // 完整追溯时 earliest = 真正首次建仓；不完整时仅作可见最早时间，评分侧应排除
  const firstOpenTime = earliestVisibleTime;
  let lastAddTime = null;
  for (let i = cycle.length - 1; i >= 0; i -= 1) {
    const kind = cycle[i].kind;
    if (kind === 'open' || kind === 'add') {
      lastAddTime = Number(cycle[i].time) || null;
      break;
    }
  }

  return {
    entries: cycle,
    complete,
    firstOpenTime,
    lastAddTime,
    earliestVisibleTime,
  };
}

/** 当前持仓对应的开仓/补仓/减仓成交（时间正序，10 秒内同类拆单合并） */
function inferPositionEntries(fills, coin, currentSize, side) {
  return analyzePositionEntries(fills, coin, currentSize, side).entries;
}

function inferOpenTime(fills, coin, currentSize, side) {
  const meta = analyzePositionEntries(fills, coin, currentSize, side);
  return meta.firstOpenTime;
}

/** 仓位快照上的开仓时间字段：首次建仓 + 最近加仓 + 历史是否完整 */
function buildPositionOpenTiming(fills, coin, currentSize, side) {
  const meta = analyzePositionEntries(fills, coin, currentSize, side);
  return {
    // openTime = 首次建仓（持仓天数口径）；不完整时仍给最早可见时间，靠 openHistoryComplete 标记
    openTime: meta.firstOpenTime,
    firstOpenTime: meta.firstOpenTime,
    lastAddTime: meta.lastAddTime,
    openHistoryComplete: meta.complete,
  };
}

function marginOf(pos, positionValue, leverage) {
  const used = Number(pos?.marginUsed);
  if (Number.isFinite(used) && used > 0) return used;
  const lev = Number(leverage);
  if (lev > 0 && positionValue > 0) return positionValue / lev;
  return positionValue || null;
}

async function fetchSpotClearinghouseState(address) {
  const user = address.toLowerCase();
  return withCache(`spot:${user}`, 30000, () =>
    hlPost({ type: 'spotClearinghouseState', user: address }),
  );
}

/**
 * 根据净名义价值判断整体方向（统计全部永续合约仓位）。
 * szi > 0 为多，szi < 0 为空。
 */
function deriveDirection(state) {
  const positions = Array.isArray(state?.assetPositions) ? state.assetPositions : [];
  let longUsd = 0;
  let shortUsd = 0;
  const details = [];

  for (const item of positions) {
    const pos = item?.position;
    if (!pos) continue;
    // clearinghouse 为永续；排除 @index 等现货索引符号
    if (isExoticAsset(pos.coin)) continue;
    const size = Number(pos.szi);
    if (!size) continue;
    const value = Math.abs(Number(pos.positionValue) || 0);
    const side = size > 0 ? 'long' : 'short';
    const parsed = parseLeverage(pos.leverage);
    if (side === 'long') longUsd += value;
    else shortUsd += value;
    details.push({
      coin: pos.coin,
      coinLabel: pos.coin,
      side,
      size,
      entryPx: Number(pos.entryPx) || 0,
      positionValue: value,
      unrealizedPnl: Number(pos.unrealizedPnl) || 0,
      leverage: parsed.leverage,
      liquidationPx: pos.liquidationPx || null,
      marginUsed: marginOf(pos, value, parsed.leverage),
      openTime: null,
    });
  }

  const net = longUsd - shortUsd;
  let direction = 'neutral';
  if (net > 1000) direction = 'long';
  else if (net < -1000) direction = 'short';

  return {
    direction,
    longUsd,
    shortUsd,
    netUsd: net,
    positions: details,
  };
}

function parseLeverage(leverage) {
  if (leverage == null || leverage === '') {
    return { leverage: null, leverageType: '', leverageLabel: '现货' };
  }
  if (typeof leverage === 'number' || typeof leverage === 'string') {
    const value = Number(leverage);
    return {
      leverage: value || null,
      leverageType: '',
      leverageLabel: value ? `${value}x` : '现货',
    };
  }
  const value = Number(leverage.value) || null;
  const type = leverage.type === 'isolated' ? 'isolated' : 'cross';
  const typeLabel = type === 'isolated' ? '逐仓' : '全仓';
  return {
    leverage: value,
    leverageType: type,
    leverageLabel: value ? `${value}x · ${typeLabel}` : '现货',
  };
}

function coinMatches(posCoin, wanted, names = {}) {
  const target = String(wanted || '').toUpperCase();
  const coin = String(posCoin || '').toUpperCase();
  if (!target || !coin) return false;
  if (coin === target) return true;
  const label = String(coinLabel(wanted, names) || '').toUpperCase();
  const posLabel = String(coinLabel(posCoin, names) || '').toUpperCase();
  if (label && (coin === label || posLabel === target || posLabel === label)) return true;
  const base = label.split('/')[0];
  return Boolean(base && (coin === base || posCoin === wanted));
}

function findPerpPosition(state, coin, names = {}, fills = []) {
  const positions = Array.isArray(state?.assetPositions) ? state.assetPositions : [];
  for (const item of positions) {
    const pos = item?.position;
    if (!pos || !coinMatches(pos.coin, coin, names)) continue;
    const size = Number(pos.szi);
    if (!size) continue;
    const parsed = parseLeverage(pos.leverage);
    const value = Math.abs(Number(pos.positionValue) || 0);
    const side = size > 0 ? 'long' : 'short';
    return {
      coin: pos.coin,
      coinLabel: coinLabel(pos.coin, names),
      kind: 'perp',
      side,
      size,
      entryPx: Number(pos.entryPx) || 0,
      positionValue: value,
      unrealizedPnl: Number(pos.unrealizedPnl) || 0,
      liquidationPx: pos.liquidationPx == null || pos.liquidationPx === '' ? null : Number(pos.liquidationPx),
      marginUsed: marginOf(pos, value, parsed.leverage),
      openTime: inferOpenTime(fills, pos.coin, size, side),
      ...buildPositionEntryFills(fills, pos.coin, size, side),
      ...parsed,
    };
  }
  return null;
}

function findSpotBalance(spotState, coin, names = {}, mids = {}) {
  const balances = Array.isArray(spotState?.balances) ? spotState.balances : [];
  const row = balances.find((item) => coinMatches(item.coin, coin, names));
  const total = Number(row?.total) || 0;
  if (!row || !total) return null;
  const midMap = mids.mids && typeof mids.mids === 'object' ? mids.mids : mids;
  const mark = Number(midMap[row.coin] ?? midMap[String(row.coin).toUpperCase()] ?? midMap[coin]) || 0;
  const value = mark ? Math.abs(total * mark) : null;
  return {
    coin: row.coin,
    coinLabel: coinLabel(row.coin, names) || coinLabel(coin, names),
    kind: 'spot',
    side: 'long',
    size: total,
    entryPx: mark || null,
    markPx: mark || null,
    positionValue: value,
    unrealizedPnl: null,
    liquidationPx: null,
    leverage: null,
    leverageType: 'spot',
    leverageLabel: '现货',
    marginUsed: value,
    openTime: null,
  };
}

function mapFillToTrade(fill, whale, names = {}) {
  const px = Number(fill.px) || 0;
  const sz = Number(fill.sz) || 0;
  const amountUsd = Math.abs(px * sz);
  // Hyperliquid: B = 买入(开多/平空)，A = 卖出(开空/平多)
  const side = fill.side === 'B' ? 'buy' : 'sell';
  const asset = fill.coin || '';
  const label = coinLabel(asset, names);
  const startRaw = Number(fill.startPosition);
  return {
    id: String(fill.tid || fill.hash || `${whale.id}-${fill.time}`),
    time: Number(fill.time) || Date.now(),
    from: side === 'sell' ? whale.address : 'Hyperliquid',
    to: side === 'buy' ? whale.address : 'Hyperliquid',
    amountUsd,
    amount: sz,
    asset,
    assetLabel: label || asset,
    exotic: isExoticAsset(asset),
    blockchain: 'Hyperliquid',
    whaleId: whale.id,
    whaleName: whale.name,
    side,
    closedPnl: Number(fill.closedPnl) || 0,
    hash: fill.hash || '',
    source: 'hyperliquid',
    price: px,
    dir: fill.dir ? String(fill.dir) : '',
    startPosition: Number.isFinite(startRaw) ? startRaw : null,
  };
}

/**
 * 把本地 trade / 原始 HL fill 统一成 analyzePositionEntries 可用的 fill 形状。
 * SQLite / 缓存里存的是 buy|sell + amount/price，开仓链反推需要 B|A + sz/px。
 */
function normalizeToHlFill(row) {
  if (!row || typeof row !== 'object') return null;
  const sideRaw = String(row.side || '');
  let side = '';
  if (sideRaw === 'B' || sideRaw === 'buy' || sideRaw === 'in') side = 'B';
  else if (sideRaw === 'A' || sideRaw === 'sell' || sideRaw === 'out') side = 'A';
  else return null;
  const sz = Math.abs(Number(row.sz != null ? row.sz : row.amount) || 0);
  const px = Number(row.px != null ? row.px : row.price) || 0;
  const coin = String(row.coin || row.asset || '').trim();
  if (!coin || !(sz > 0)) return null;
  const startRaw = Number(row.startPosition);
  return {
    coin,
    side,
    sz,
    px,
    time: Number(row.time) || 0,
    closedPnl: Number(row.closedPnl) || 0,
    startPosition: Number.isFinite(startRaw) ? startRaw : undefined,
    dir: row.dir ? String(row.dir) : '',
    tid: row.tid || row.id || undefined,
    hash: row.hash || undefined,
  };
}

/** 同巨鲸、同币种、同方向，在时间窗口内连续成交合并成一笔，再按金额门槛过滤 */
const FILL_AGGREGATE_WINDOW_MS = 5 * 60 * 1000;

function aggregateTradesByWindow(trades, windowMs = FILL_AGGREGATE_WINDOW_MS) {
  const list = [...(trades || [])].sort((a, b) => a.time - b.time || String(a.id).localeCompare(String(b.id)));
  const groups = [];

  for (const trade of list) {
    const last = groups[groups.length - 1];
    const sameBucket =
      last &&
      last.whaleId === trade.whaleId &&
      last.asset === trade.asset &&
      last.side === trade.side &&
      trade.time - last._startTime <= windowMs &&
      trade.time - last.time <= windowMs;

    if (!sameBucket) {
      groups.push({
        ...trade,
        amountUsd: Number(trade.amountUsd) || 0,
        amount: Number(trade.amount) || 0,
        closedPnl: Number(trade.closedPnl) || 0,
        _startTime: trade.time,
        _fillCount: 1,
        _notional: (Number(trade.price) || 0) * (Number(trade.amount) || 0),
      });
      continue;
    }

    last.amountUsd += Number(trade.amountUsd) || 0;
    last.amount += Number(trade.amount) || 0;
    last.closedPnl += Number(trade.closedPnl) || 0;
    last._notional += (Number(trade.price) || 0) * (Number(trade.amount) || 0);
    last._fillCount += 1;
    last.time = trade.time;
    last.hash = trade.hash || last.hash;
    last.id = `${last.id}+${trade.id}`;
    if (last.amount > 0) last.price = Math.abs(last._notional / last.amount);
  }

  return groups.map(({ _startTime, _fillCount, _notional, ...rest }) => ({
    ...rest,
    fillCount: _fillCount,
  }));
}

function mapAndFilterFills(fills, whale, names = {}, minUsd = 1000) {
  const trades = (fills || []).map((fill) => mapFillToTrade(fill, whale, names));
  return aggregateTradesByWindow(trades).filter((trade) => trade.amountUsd >= minUsd);
}

function closedFillSide(fill) {
  const closedPnl = Number(fill.closedPnl) || 0;
  if (Math.abs(closedPnl) <= 1) return null;
  return fill.side === 'A' ? 'long' : 'short';
}

function computeSideWinRates(fills) {
  const stats = { long: { wins: 0, total: 0 }, short: { wins: 0, total: 0 } };
  for (const fill of fills || []) {
    const side = closedFillSide(fill);
    if (!side) continue;
    const pnl = Number(fill.closedPnl) || 0;
    stats[side].total += 1;
    if (pnl > 0) stats[side].wins += 1;
  }
  const rate = (bucket) => (bucket.total >= 3 ? Math.round((bucket.wins / bucket.total) * 1000) / 10 : null);
  return {
    longWinRate: rate(stats.long),
    shortWinRate: rate(stats.short),
  };
}

function computeTopCoins(fills, names = {}, limit = 5) {
  const vol = new Map();
  for (const fill of fills || []) {
    const id = coinLabel(fill.coin, names);
    const usd = Math.abs((Number(fill.px) || 0) * (Number(fill.sz) || 0));
    if (!id || usd < 100) continue;
    vol.set(id, (vol.get(id) || 0) + usd);
  }
  return [...vol.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);
}

module.exports = {
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
  fetchFrontendOpenOrders,
  extractTpslForCoin,
  deriveDirection,
  mapFillToTrade,
  normalizeToHlFill,
  aggregateTradesByWindow,
  mapAndFilterFills,
  computeSideWinRates,
  computeTopCoins,
  FILL_AGGREGATE_WINDOW_MS,
  FILL_LOOKBACK_MS,
  findPerpPosition,
  findSpotBalance,
  inferOpenTime,
  inferPositionEntries,
  analyzePositionEntries,
  buildPositionOpenTiming,
  buildPositionEntryFills,
  trimEntryFillsEdges,
  ENTRY_FILL_EDGE,
  coinLabel,
  isExoticAsset,
  explorerUrl,
  tradeUrl,
  coinMatches,
  getHlInfoConfig,
  MAX_CONCURRENT,
};
