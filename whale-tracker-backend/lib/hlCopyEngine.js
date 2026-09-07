/**
 * HL 巨鲸 → OKX 自动跟单引擎
 * - 任务持久化到 data/copy-trade.json
 * - 巨鲸 open/increase 信号驱动下单
 * - 规则：巨鲸加仓但本地无同币同向仓 → 视为开仓
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const {
  isTradeConfigured,
  placeOrder,
  getTradeStatus,
  getAccountPositions,
  withTradeCredentials,
} = require('./okxTradeClient');
const { getOkxCredentialsForUser } = require('./userExchangeKeys');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'copy-trade.json');

const processedAlertIds = new Set();
const instrumentCache = new Map(); // instId -> { ctVal, lotSz, minSz }
let store = {
  tasks: [],
  positions: [],
  records: [],
  updatedAt: 0,
};
let handling = false;
const queue = [];

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadStore() {
  try {
    ensureDir();
    if (!fs.existsSync(STORE_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    store = {
      tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
      positions: Array.isArray(raw.positions) ? raw.positions : [],
      records: Array.isArray(raw.records) ? raw.records : [],
      updatedAt: Number(raw.updatedAt) || 0,
    };
  } catch (err) {
    console.warn('[copy-engine] load failed:', err.message);
  }
}

function saveStore() {
  try {
    ensureDir();
    store.updatedAt = Date.now();
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
  } catch (err) {
    console.warn('[copy-engine] save failed:', err.message);
  }
}

function normAddr(addr) {
  return String(addr || '')
    .trim()
    .toLowerCase();
}

function broadcastSafe(msg) {
  try {
    require('./realtimeHub').broadcast(msg);
  } catch {
    /* hub 可能未就绪 */
  }
}

function getSnapshot(userId = null) {
  const uid = userId ? String(userId) : null;
  const tasks = uid
    ? store.tasks.filter((t) => String(t.userId || '') === uid)
    : store.tasks;
  const taskIds = new Set(tasks.map((t) => t.id));
  const positions = store.positions.filter(
    (p) => p.status === 'open' && (!uid || taskIds.has(p.taskId)),
  );
  const records = store.records
    .filter((r) => !uid || taskIds.has(r.taskId) || String(r.userId || '') === uid)
    .slice(0, 200);
  const trade = uid
    ? (() => {
        const creds = getOkxCredentialsForUser(uid);
        return getTradeStatus(creds || undefined);
      })()
    : getTradeStatus();
  return {
    tasks,
    positions,
    records,
    updatedAt: store.updatedAt,
    trade,
    exchangeKeysReady: uid ? Boolean(getOkxCredentialsForUser(uid)) : trade.configured,
  };
}

function resolveTaskCreds(task) {
  const uid = String(task?.userId || '').trim();
  if (uid) {
    const creds = getOkxCredentialsForUser(uid);
    if (creds) return creds;
  }
  // 兼容旧任务：回退到进程环境变量
  if (isTradeConfigured()) return null; // null = use env via ALS empty
  return undefined; // undefined = not configured
}

async function runWithTaskCreds(task, fn) {
  const creds = resolveTaskCreds(task);
  if (creds === undefined) {
    const err = new Error('未配置 OKX API（请在跟单页绑定密钥）');
    err.status = 503;
    throw err;
  }
  if (creds) return withTradeCredentials(creds, fn);
  return fn();
}

function listTasks(userId = null) {
  const uid = userId ? String(userId) : null;
  const list = store.tasks.slice();
  if (!uid) return list;
  return list.filter((t) => String(t.userId || '') === uid);
}

function findDuplicateAddress(address, excludeId = '', exchange = null, userId = null) {
  const key = normAddr(address);
  if (!key) return null;
  return (
    store.tasks.find((t) => {
      if (t.id === excludeId) return false;
      if (normAddr(t.whaleAddress) !== key) return false;
      if (exchange && t.exchange !== exchange) return false;
      if (userId && String(t.userId || '') !== String(userId)) return false;
      return true;
    }) || null
  );
}

function upsertTask(task) {
  const idx = store.tasks.findIndex((t) => t.id === task.id);
  if (idx >= 0) store.tasks[idx] = task;
  else store.tasks.unshift(task);
  saveStore();
  broadcastSafe({ type: 'copyUpdate', ...getSnapshot(task.userId || null) });
  return task;
}

function removeTask(id, userId = null) {
  const uid = userId ? String(userId) : null;
  const target = store.tasks.find((t) => t.id === id);
  if (!target) return;
  if (uid && String(target.userId || '') !== uid) {
    const err = new Error('无权删除该跟单任务');
    err.status = 403;
    throw err;
  }
  store.tasks = store.tasks.filter((t) => t.id !== id);
  store.positions = store.positions.filter((p) => p.taskId !== id);
  saveStore();
  broadcastSafe({ type: 'copyUpdate', ...getSnapshot(uid || target.userId || null) });
}

function replaceTasks(tasks, userId = null) {
  const uid = userId ? String(userId) : null;
  const incoming = Array.isArray(tasks) ? tasks : [];
  if (uid) {
    const others = store.tasks.filter((t) => String(t.userId || '') !== uid);
    store.tasks = [...incoming.map((t) => ({ ...t, userId: uid })), ...others];
  } else {
    store.tasks = incoming;
  }
  saveStore();
  broadcastSafe({ type: 'copyUpdate', ...getSnapshot(uid) });
  return listTasks(uid);
}

function coinToInstId(coin) {
  let c = String(coin || '')
    .trim()
    .toUpperCase()
    .replace(/^K(?=[A-Z])/, '');
  if (!c) return '';
  return `${c}-USDT-SWAP`;
}

async function getInstrument(instId) {
  if (instrumentCache.has(instId)) return instrumentCache.get(instId);
  const base = String(process.env.OKX_TRADE_BASE || process.env.OKX_BASE || 'https://www.okx.com').replace(
    /\/$/,
    '',
  );
  const url = `${base}/api/v5/public/instruments?instType=SWAP&instId=${encodeURIComponent(instId)}`;
  const res = await axios.get(url, { timeout: 12_000, validateStatus: () => true });
  const row = res.data?.data?.[0];
  if (!row) throw new Error(`找不到合约 ${instId}`);
  const info = {
    ctVal: Number(row.ctVal) || 1,
    lotSz: Number(row.lotSz) || 1,
    minSz: Number(row.minSz) || Number(row.lotSz) || 1,
  };
  instrumentCache.set(instId, info);
  return info;
}

function roundLot(sz, lotSz) {
  const lot = lotSz > 0 ? lotSz : 1;
  const n = Math.floor(Number(sz) / lot) * lot;
  // 避免浮点误差
  const decimals = String(lot).includes('.') ? String(lot).split('.')[1].length : 0;
  return Number(n.toFixed(Math.min(8, decimals || 0)));
}

function findLocalPos(taskId, coin, side) {
  const c = String(coin || '').toUpperCase();
  return (
    store.positions.find(
      (p) =>
        p.status === 'open' &&
        p.taskId === taskId &&
        String(p.coin || '').toUpperCase() === c &&
        p.side === side,
    ) || null
  );
}

function pushRecord(rec) {
  store.records.unshift(rec);
  if (store.records.length > 500) store.records.length = 500;
}

/**
 * 按比例开仓：
 * 用户保证金 = 跟单本金 × (巨鲸该仓保证金 / 巨鲸账户权益)
 * 名义金额 = 用户保证金 × 杠杆
 *
 * opts: { leverage, marginUsed, positionValue, whaleAccountValue, whaleTotalPositionUsd, addUsd, action }
 */
function calcProportionalSize(task, opts = {}) {
  // 跟单杠杆：任务上限优先，否则用巨鲸杠杆
  const whaleLever = Math.max(1, Number(opts.leverage) || 0);
  const maxLever = Number(task.maxLeverage) || 0;
  const lever = Math.min(125, Math.max(1, maxLever > 0 ? maxLever : whaleLever || 5));
  const capital = Math.max(1, Number(task.followCapitalUsd) || 1000);

  const posValue = Math.abs(Number(opts.positionValue) || 0);
  let posMargin = Math.abs(Number(opts.marginUsed) || 0);
  // 估算巨鲸该仓保证金时必须用巨鲸杠杆，不能用用户杠杆
  if (!(posMargin > 0) && posValue > 0 && whaleLever > 0) {
    posMargin = posValue / whaleLever;
  }
  const whaleEquity = Math.abs(Number(opts.whaleAccountValue) || 0);
  const whaleTotalPos = Math.abs(Number(opts.whaleTotalPositionUsd) || 0);

  let ratio = 0;
  if (whaleEquity > 0 && posMargin > 0) {
    // 核心：该仓保证金占巨鲸权益比例
    ratio = posMargin / whaleEquity;
  } else if (whaleEquity > 0 && posValue > 0) {
    // 无保证金字段：名义/权益/巨鲸杠杆 ≈ 保证金占比
    ratio = posValue / whaleEquity / whaleLever;
  } else if (whaleTotalPos > 0 && posValue > 0) {
    // 无权益时退化为名义占巨鲸总仓位比例
    ratio = posValue / whaleTotalPos;
  } else {
    // 缺数据时保守 5%，避免打满跟单本金
    ratio = 0.05;
  }
  ratio = Math.min(1, Math.max(0, ratio));

  let userMargin = capital * ratio;
  let notional = userMargin * lever;

  // 加仓：按本次加仓保证金占巨鲸权益比例（勿用本地持仓名义当巨鲸仓位）
  if (opts.action === 'add') {
    const addUsd = Math.abs(Number(opts.addUsd) || 0);
    if (addUsd > 0 && whaleEquity > 0 && whaleLever > 0) {
      const addMargin = addUsd / whaleLever;
      userMargin = capital * Math.min(1, addMargin / whaleEquity);
      notional = userMargin * lever;
    } else if (addUsd > 0 && posValue > 0) {
      notional = notional * Math.min(1, addUsd / posValue);
      userMargin = notional / lever;
    }
  }

  const maxN = Number(task.maxNotionalUsd) || 0;
  if (maxN > 0 && notional > maxN) {
    notional = maxN;
    userMargin = notional / lever;
  }

  return { notional, lever, userMargin, ratio };
}

function resolveWhaleMeta(address) {
  try {
    const whale = require('./realtimeBridge').getWhaleByAddress(address);
    if (!whale) return { whaleAccountValue: 0, whaleTotalPositionUsd: 0 };
    const accountValue = Number(whale.accountValue) || 0;
    const longUsd = Math.abs(Number(whale.longUsd) || 0);
    const shortUsd = Math.abs(Number(whale.shortUsd) || 0);
    let totalPos = longUsd + shortUsd;
    if (!(totalPos > 0) && Array.isArray(whale.positions)) {
      totalPos = whale.positions.reduce((s, p) => {
        const v = Math.abs(Number(p.positionValue) || 0);
        if (v > 0) return s + v;
        return s + Math.abs((Number(p.size) || 0) * (Number(p.entryPx) || 0));
      }, 0);
    }
    return { whaleAccountValue: accountValue, whaleTotalPositionUsd: totalPos, whale };
  } catch {
    return { whaleAccountValue: 0, whaleTotalPositionUsd: 0 };
  }
}

const recentReduceAt = new Map(); // `${taskId}|coin|side` -> ts
const recentOpenAddAt = new Map(); // `${taskId}|coin|side` -> ts

function markReduce(taskId, coin, side) {
  recentReduceAt.set(`${taskId}|${String(coin).toUpperCase()}|${side}`, Date.now());
  if (recentReduceAt.size > 2000) {
    const cutoff = Date.now() - 60_000;
    for (const [k, t] of recentReduceAt) {
      if (t < cutoff) recentReduceAt.delete(k);
    }
  }
}

function wasRecentlyReduced(taskId, coin, side, windowMs = 12_000) {
  const t = recentReduceAt.get(`${taskId}|${String(coin).toUpperCase()}|${side}`);
  return Boolean(t && Date.now() - t < windowMs);
}

function markOpenAdd(taskId, coin, side) {
  recentOpenAddAt.set(`${taskId}|${String(coin).toUpperCase()}|${side}`, Date.now());
  if (recentOpenAddAt.size > 2000) {
    const cutoff = Date.now() - 60_000;
    for (const [k, t] of recentOpenAddAt) {
      if (t < cutoff) recentOpenAddAt.delete(k);
    }
  }
}

function wasRecentlyOpenAdd(taskId, coin, side, windowMs = 12_000) {
  const t = recentOpenAddAt.get(`${taskId}|${String(coin).toUpperCase()}|${side}`);
  return Boolean(t && Date.now() - t < windowMs);
}

/** 平/减仓：与开仓相反方向，reduceOnly */
function closeOrderSide(positionSide) {
  return positionSide === 'short' ? 'buy' : 'sell';
}

function resolveReduceFraction(alert, item, local) {
  const kind = alert.kind;
  if (kind === 'close') return 1;

  const reduceUsd = Math.abs(Number(item.usd) || 0);
  const prevUsd = Math.abs(Number(item.prevUsd) || 0);
  const remainingUsd = Math.abs(Number(item.remainingUsd) || 0);

  if (prevUsd > 0 && reduceUsd > 0) {
    return Math.min(1, reduceUsd / prevUsd);
  }
  if (prevUsd > 0 && remainingUsd >= 0 && remainingUsd < prevUsd) {
    return Math.min(1, (prevUsd - remainingUsd) / prevUsd);
  }
  if (reduceUsd > 0 && remainingUsd > 0) {
    return Math.min(1, reduceUsd / (reduceUsd + remainingUsd));
  }
  const localNotional = Math.abs(Number(local?.notionalUsd) || 0);
  if (reduceUsd > 0 && localNotional > 0) {
    return Math.min(1, reduceUsd / Math.max(localNotional, reduceUsd));
  }
  return 1;
}

async function executeReduceForTask(task, alert) {
  const item = (alert.items && alert.items[0]) || {};
  const coin = String(item.coin || '').trim();
  const side = item.side === 'short' ? 'short' : 'long';
  if (!coin) return;

  // fill 与仓位 diff 可能连续报同一笔减/平，短窗去重
  if (wasRecentlyReduced(task.id, coin, side)) {
    console.log(`[copy-engine] skip duplicate reduce ${task.name} ${coin} ${side}`);
    return;
  }

  const local = findLocalPos(task.id, coin, side);
  const signalKind = alert.kind === 'decrease' ? 'decrease' : 'close';
  const price = Number(item.price) || Number(local?.markPx) || Number(local?.entryPx) || 0;
  const instId = String(local?.instId || coinToInstId(coin));
  const fraction = local ? resolveReduceFraction(alert, item, local) : 0;

  const recordBase = {
    id: `cr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    taskId: task.id,
    at: Date.now(),
    kind: 'close',
    coin,
    side,
    lever: local?.lever,
    marginUsd: local?.marginUsd,
    px: price || undefined,
    note: '',
    alertId: alert.id,
    whaleName: alert.whaleName || '',
    signalKind,
    fraction,
  };

  if (!local || !(Number(local.size) > 0)) {
    pushRecord({
      ...recordBase,
      status: 'ok',
      note: `巨鲸${signalKind === 'decrease' ? '减仓' : '平仓'}：本地无对应持仓，跳过`,
    });
    saveStore();
    return;
  }

  let rawSz = Number(local.size) * fraction;
  if (signalKind === 'close' || fraction >= 0.98 || rawSz >= Number(local.size) * 0.98) {
    rawSz = Number(local.size);
  }

  if (resolveTaskCreds(task) === undefined) {
    if (rawSz >= Number(local.size) * 0.98) {
      local.status = 'closed';
      local.size = 0;
      local.notionalUsd = 0;
      local.closedAt = Date.now();
      local.closeSource = 'whale-signal';
      pushRecord({
        ...recordBase,
        note: `巨鲸平仓信号（未配置 OKX API，仅本地标记平仓）`,
      });
    } else {
      const remainRatio = Math.max(0, 1 - rawSz / Number(local.size));
      local.size = Number(local.size) - rawSz;
      local.notionalUsd = (Number(local.notionalUsd) || 0) * remainRatio;
      local.marginUsd = (Number(local.marginUsd) || 0) * remainRatio;
      pushRecord({
        ...recordBase,
        note: `巨鲸减仓信号（未配置 OKX API，仅本地按 ${(fraction * 100).toFixed(1)}% 减）`,
      });
    }
    local.updatedAt = Date.now();
    markReduce(task.id, coin, side);
    saveStore();
    return;
  }

  try {
    const info = await getInstrument(instId);
    let sz = roundLot(rawSz, info.lotSz);
    let fullClose = sz >= Number(local.size) * 0.98 || sz >= Number(local.size) - info.lotSz / 2;
    if (fullClose) {
      sz = roundLot(Number(local.size), info.lotSz) || Number(local.size);
    }
    if (!(sz >= info.minSz) && !fullClose) {
      throw new Error(`减仓张数过小 sz=${rawSz.toFixed(4)} min=${info.minSz}`);
    }
    if (!fullClose && Number(local.size) - sz < info.minSz) {
      sz = roundLot(Number(local.size), info.lotSz) || Number(local.size);
      fullClose = true;
    }

    const okxSide = closeOrderSide(side);
    const { order } = await runWithTaskCreds(task, () =>
      placeOrder({
        instId,
        side: okxSide,
        posSide: side,
        tdMode: local.mgnMode === 'isolated' ? 'isolated' : 'cross',
        ordType: 'market',
        sz: String(sz),
        reduceOnly: true,
        setLeverage: '0',
        clOrdId: `x${Date.now().toString(36)}`.slice(0, 32),
        tag: 'hlcopy',
      }),
    );

    const closedAll = fullClose || sz >= Number(local.size) * 0.98;
    if (closedAll) {
      local.status = 'closed';
      local.size = 0;
      local.notionalUsd = 0;
      local.uPnl = 0;
      local.pnlRatio = 0;
      local.closedAt = Date.now();
      local.closeSource = 'whale-signal';
      local.updatedAt = Date.now();
      pushRecord({
        ...recordBase,
        status: 'ok',
        note: `跟随巨鲸平仓 ${instId} ${side === 'long' ? '多' : '空'} ${sz} 张 · ordId=${order?.ordId || '—'}`,
      });
    } else {
      const remainRatio = Math.max(0, 1 - sz / Number(local.size));
      local.size = Math.max(0, Number(local.size) - sz);
      local.notionalUsd = (Number(local.notionalUsd) || 0) * remainRatio;
      local.marginUsd = (Number(local.marginUsd) || 0) * remainRatio;
      if (price > 0) local.markPx = price;
      local.updatedAt = Date.now();
      pushRecord({
        ...recordBase,
        status: 'ok',
        note: `跟随巨鲸减仓 ${instId} ${side === 'long' ? '多' : '空'} ${sz} 张（${(fraction * 100).toFixed(1)}%） · ordId=${order?.ordId || '—'}`,
        marginUsd: Number(local.marginUsd) || 0,
      });
    }
    markReduce(task.id, coin, side);
    saveStore();
    console.log(
      `[copy-engine] ${closedAll ? 'close' : 'decrease'} ${task.name} ${coin} ${side} sz=${sz} frac=${fraction.toFixed(3)}`,
    );
  } catch (err) {
    pushRecord({
      ...recordBase,
      status: 'fail',
      note: `${signalKind === 'decrease' ? '减仓' : '平仓'}失败: ${err.message || err}`,
    });
    saveStore();
    console.warn('[copy-engine] reduce failed:', err.message || err);
  }
}

async function executeForTask(task, alert) {
  const kind = alert.kind;
  if (kind === 'close' || kind === 'decrease') {
    return executeReduceForTask(task, alert);
  }

  const item = (alert.items && alert.items[0]) || {};
  const coin = String(item.coin || '').trim();
  const side = item.side === 'short' ? 'short' : 'long';
  if (!coin) return;

  // fill 与仓位 diff 可能连续报同一笔开/加，短窗去重
  if (wasRecentlyOpenAdd(task.id, coin, side)) {
    console.log(`[copy-engine] skip duplicate open/add ${task.name} ${coin} ${side}`);
    return;
  }

  const local = findLocalPos(task.id, coin, side);
  let signalKind = alert.kind === 'open' ? 'open' : 'add';
  /** 巨鲸加仓但本地无仓 → 按开仓 */
  if (signalKind === 'add' && !local) {
    signalKind = 'open';
  }

  const instId = coinToInstId(coin);
  const price = Number(item.price) || 0;
  const meta = resolveWhaleMeta(alert.address || task.whaleAddress);
  const fillUsd = Math.abs(Number(item.usd) || 0);
  const remainingUsd = Math.abs(Number(item.remainingUsd) || 0);
  const prevUsd = Math.abs(Number(item.prevUsd) || 0);
  const leverHint = Number(item.leverage) || Number(task.maxLeverage) || 5;

  // 开仓/加仓：优先用巨鲸仓位名义（remaining / prev+fill / 实时仓），勿用本地 OKX 名义
  let whalePosValue = 0;
  if (remainingUsd > 0) {
    whalePosValue = remainingUsd;
  } else if (prevUsd > 0) {
    whalePosValue = prevUsd + fillUsd;
  } else if (meta.whale?.positions) {
    const c = coin.toUpperCase();
    const pos = meta.whale.positions.find(
      (p) => String(p.coin || '').toUpperCase() === c && p.side === side,
    );
    if (pos) {
      whalePosValue =
        Math.abs(Number(pos.positionValue) || 0) ||
        Math.abs((Number(pos.size) || 0) * (Number(pos.entryPx) || 0));
    }
  }
  if (!(whalePosValue > 0)) whalePosValue = fillUsd;

  const marginUsed = leverHint > 0 ? whalePosValue / leverHint : whalePosValue;

  const { notional, lever, userMargin, ratio } = calcProportionalSize(task, {
    action: signalKind,
    leverage: leverHint,
    marginUsed: signalKind === 'open' ? marginUsed : undefined,
    positionValue: whalePosValue,
    whaleAccountValue: meta.whaleAccountValue,
    whaleTotalPositionUsd: meta.whaleTotalPositionUsd,
    addUsd: signalKind === 'add' ? fillUsd : 0,
  });
  const recordBase = {
    id: `cr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    taskId: task.id,
    at: Date.now(),
    kind: signalKind,
    coin,
    side,
    lever,
    marginUsd: userMargin,
    px: price || undefined,
    note: '',
    alertId: alert.id,
    whaleName: alert.whaleName || '',
    ratio,
  };

  if (resolveTaskCreds(task) === undefined) {
    pushRecord({
      ...recordBase,
      note: `${signalKind === 'open' ? '开仓' : '加仓'}信号（未配置 OKX API，仅记录）`,
    });
    saveStore();
    return;
  }

  try {
    const info = await getInstrument(instId);
    if (!(price > 0)) throw new Error('缺少成交价，无法换算张数');
    const rawSz = notional / (price * info.ctVal);
    let sz = roundLot(rawSz, info.lotSz);
    if (!(sz >= info.minSz)) {
      throw new Error(`计算张数过小 sz=${rawSz.toFixed(4)} min=${info.minSz}`);
    }

    const okxSide = side === 'short' ? 'sell' : 'buy';
    const { order } = await runWithTaskCreds(task, () =>
      placeOrder({
        instId,
        side: okxSide,
        posSide: side,
        tdMode: 'cross',
        ordType: 'market',
        sz: String(sz),
        lever: String(lever),
        setLeverage: process.env.OKX_TRADE_SET_LEVERAGE || '0',
        clOrdId: `c${Date.now().toString(36)}`.slice(0, 32),
        tag: 'hlcopy',
      }),
    );

    const posId = local?.id || `cp_${task.id}_${coin}_${side}`.toLowerCase();
    const nextPos = {
      id: posId,
      taskId: task.id,
      coin,
      side,
      lever,
      mgnMode: 'cross',
      marginUsd: (local?.marginUsd || 0) + userMargin,
      size: (local?.size || 0) + sz,
      notionalUsd: (local?.notionalUsd || 0) + notional,
      entryPx: price,
      markPx: price,
      liqPx: 0,
      mgnRatio: 0,
      uPnl: 0,
      pnlRatio: 0,
      status: 'open',
      instId,
      updatedAt: Date.now(),
    };
    if (local) {
      Object.assign(local, nextPos);
    } else {
      store.positions.unshift(nextPos);
    }

    markOpenAdd(task.id, coin, side);
    pushRecord({
      ...recordBase,
      note: `已下单 ${instId} ${sz} 张 · 比例${(ratio * 100).toFixed(2)}% · 保证金≈${userMargin.toFixed(2)} · ordId=${order?.ordId || '—'}`,
      marginUsd: userMargin,
    });
    saveStore();
    console.log(
      `[copy-engine] ${signalKind} ${task.name} ${coin} ${side} sz=${sz} (alert=${alert.kind})`,
    );
  } catch (err) {
    pushRecord({
      ...recordBase,
      note: `下单失败: ${err.message || err}`,
    });
    saveStore();
    console.warn('[copy-engine] order failed:', err.message || err);
  }
}

async function processAlerts(alerts) {
  const list = Array.isArray(alerts) ? alerts : [];
  const affectedUsers = new Set();
  for (const alert of list) {
    if (!alert?.id || processedAlertIds.has(alert.id)) continue;
    processedAlertIds.add(alert.id);
    if (processedAlertIds.size > 5000) {
      const keep = [...processedAlertIds].slice(-2000);
      processedAlertIds.clear();
      keep.forEach((id) => processedAlertIds.add(id));
    }

    const kind = alert.kind;
    if (kind !== 'open' && kind !== 'increase' && kind !== 'decrease' && kind !== 'close') continue;

    const addr = normAddr(alert.address);
    if (!addr) continue;

    const tasks = store.tasks.filter(
      (t) => t.enabled && t.exchange === 'okx' && normAddr(t.whaleAddress) === addr,
    );
    if (!tasks.length) continue;

    for (const task of tasks) {
      await executeForTask(task, alert);
      const uid = String(task.userId || '').trim();
      if (uid) affectedUsers.add(uid);
      else affectedUsers.add('');
    }
  }
  // 按用户推送快照，避免把全部用户任务广播出去造成前端闪重复
  if (affectedUsers.size === 0) return;
  if (affectedUsers.has('') && affectedUsers.size === 1) {
    broadcastSafe({ type: 'copyUpdate', ...getSnapshot(null) });
    return;
  }
  for (const uid of affectedUsers) {
    if (!uid) continue;
    broadcastSafe({ type: 'copyUpdate', userId: uid, ...getSnapshot(uid) });
  }
}

function onWhaleAlerts(alerts) {
  queue.push(alerts);
  void drainQueue();
}

async function drainQueue() {
  if (handling) return;
  handling = true;
  try {
    while (queue.length) {
      const batch = queue.shift();
      await processAlerts(batch);
    }
  } finally {
    handling = false;
  }
}

let lastPosSyncAt = 0;
let posSyncTimer = null;
let posSyncing = false;
const POS_SYNC_MIN_MS = 5_000;
const POS_SYNC_INTERVAL_MS = 10_000;

/** 解析 OKX 持仓方向：net 模式看 pos 正负 */
function resolveOkxSide(row) {
  const pos = Number(row?.pos) || 0;
  let side = String(row?.posSide || '')
    .trim()
    .toLowerCase();
  if (side === 'long' || side === 'short') return side;
  if (pos < 0) return 'short';
  if (pos > 0) return 'long';
  return '';
}

function okxPosMap(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const instId = String(row.instId || '').trim();
    const posAbs = Math.abs(Number(row.pos) || 0);
    if (!instId || !(posAbs > 0)) continue;
    const side = resolveOkxSide(row);
    if (!side) continue;
    const key = `${instId}|${side}`;
    const prev = map.get(key);
    if (prev) {
      prev.posAbs += posAbs;
      prev.upl += Number(row.upl) || 0;
      prev.margin += Math.abs(Number(row.margin) || Number(row.imr) || 0);
    } else {
      map.set(key, {
        instId,
        side,
        posAbs,
        avgPx: Number(row.avgPx) || 0,
        markPx: Number(row.markPx) || 0,
        liqPx: Number(row.liqPx) || 0,
        upl: Number(row.upl) || 0,
        uplRatio: Number(row.uplRatio) || 0,
        margin: Math.abs(Number(row.margin) || Number(row.imr) || 0),
        mgnRatio: Number(row.mgnRatio) || Number(row.marginRatio) || 0,
        lever: Number(row.lever) || 0,
        notionalUsd: Math.abs(Number(row.notionalUsd) || 0),
        mgnMode: String(row.mgnMode || 'cross').toLowerCase() === 'isolated' ? 'isolated' : 'cross',
      });
    }
  }
  return map;
}

/**
 * 用 OKX 真实持仓校正本地镜像。
 * @param {boolean} force
 * @param {string|null} userId 指定用户时只用其密钥，并只校正其任务仓位
 */
async function syncPositionsFromExchange(force = false, userId = null) {
  const now = Date.now();
  if (!force && now - lastPosSyncAt < POS_SYNC_MIN_MS) {
    return { synced: false, reason: 'throttled' };
  }
  if (posSyncing) return { synced: false, reason: 'busy' };
  posSyncing = true;
  lastPosSyncAt = now;

  const uid = userId ? String(userId) : null;
  const openLocalsAll = store.positions.filter((p) => p.status === 'open');
  const taskById = new Map(store.tasks.map((t) => [t.id, t]));

  // 按用户分组同步（多用户各用各的 Key）
  const groupsByUser = new Map();
  for (const p of openLocalsAll) {
    const task = taskById.get(p.taskId);
    const owner = String(task?.userId || '');
    if (uid && owner !== uid) continue;
    if (!groupsByUser.has(owner)) groupsByUser.set(owner, []);
    groupsByUser.get(owner).push(p);
  }
  // 即使本地无仓，指定用户也可拉一次确认
  if (uid && !groupsByUser.has(uid)) groupsByUser.set(uid, []);

  if (!groupsByUser.size) {
    // 无用户仓时尝试 env
    if (!isTradeConfigured()) {
      posSyncing = false;
      return { synced: false, reason: 'not_configured' };
    }
    groupsByUser.set('', openLocalsAll);
  }

  let closed = 0;
  let updated = 0;
  let changed = false;
  let openExchange = 0;

  try {
    for (const [owner, openLocals] of groupsByUser) {
      const creds = owner ? getOkxCredentialsForUser(owner) : null;
      if (owner && !creds) continue;
      if (!owner && !isTradeConfigured()) continue;

      let rows;
      try {
        rows = creds
          ? await withTradeCredentials(creds, () => getAccountPositions('SWAP'))
          : await getAccountPositions('SWAP');
      } catch (err) {
        console.warn(`[copy-engine] sync positions user=${owner || 'env'}:`, err.message || err);
        continue;
      }
      const exch = okxPosMap(rows);
      openExchange += exch.size;

      const groups = new Map();
      for (const p of openLocals) {
        const instId = String(p.instId || coinToInstId(p.coin) || '').trim();
        const side = p.side === 'short' ? 'short' : 'long';
        if (!instId) continue;
        const key = `${instId}|${side}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
      }

      for (const [key, locals] of groups) {
        const remote = exch.get(key);
        if (!remote) {
          for (const local of locals) {
            local.status = 'closed';
            local.size = 0;
            local.notionalUsd = 0;
            local.uPnl = 0;
            local.pnlRatio = 0;
            local.closedAt = Date.now();
            local.updatedAt = Date.now();
            local.closeSource = 'exchange-sync';
            pushRecord({
              id: `cr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
              taskId: local.taskId,
              userId: owner || undefined,
              at: Date.now(),
              kind: 'close',
              coin: local.coin,
              side: local.side,
              lever: local.lever,
              marginUsd: local.marginUsd,
              px: local.markPx || local.entryPx,
              status: 'ok',
              note: `交易所已平仓（同步） ${local.instId || local.coin}`,
            });
            closed += 1;
            changed = true;
          }
          continue;
        }

        const totalMargin = locals.reduce((s, p) => s + Math.abs(Number(p.marginUsd) || 0), 0);
        const totalSize = locals.reduce((s, p) => s + Math.abs(Number(p.size) || 0), 0);

        for (const local of locals) {
          const share =
            locals.length === 1
              ? 1
              : totalMargin > 0
                ? Math.abs(Number(local.marginUsd) || 0) / totalMargin
                : totalSize > 0
                  ? Math.abs(Number(local.size) || 0) / totalSize
                  : 1 / locals.length;

          const nextSize =
            locals.length === 1
              ? remote.posAbs
              : Math.abs(Number(local.size) || 0) || remote.posAbs * share;
          const nextMargin =
            locals.length === 1
              ? remote.margin || Number(local.marginUsd) || 0
              : remote.margin > 0
                ? remote.margin * share
                : Number(local.marginUsd) || 0;
          const nextUpl = remote.upl * share;
          const nextNotional =
            locals.length === 1
              ? remote.notionalUsd || Number(local.notionalUsd) || 0
              : remote.notionalUsd > 0
                ? remote.notionalUsd * share
                : Number(local.notionalUsd) || 0;

          const next = {
            markPx: remote.markPx || local.markPx,
            entryPx: remote.avgPx || local.entryPx,
            liqPx: remote.liqPx || local.liqPx || 0,
            mgnRatio: remote.mgnRatio || local.mgnRatio || 0,
            uPnl: nextUpl,
            pnlRatio:
              remote.uplRatio ||
              (nextMargin > 0 ? nextUpl / nextMargin : local.pnlRatio || 0),
            marginUsd: nextMargin || local.marginUsd,
            size: nextSize,
            notionalUsd: nextNotional || local.notionalUsd,
            lever: remote.lever || local.lever,
            mgnMode: remote.mgnMode || local.mgnMode || 'cross',
            instId: remote.instId || local.instId,
            updatedAt: Date.now(),
          };

          const dirty =
            Math.abs((Number(local.markPx) || 0) - (Number(next.markPx) || 0)) > 1e-8 ||
            Math.abs((Number(local.uPnl) || 0) - (Number(next.uPnl) || 0)) > 1e-6 ||
            Math.abs((Number(local.size) || 0) - (Number(next.size) || 0)) > 1e-8 ||
            Math.abs((Number(local.marginUsd) || 0) - (Number(next.marginUsd) || 0)) > 1e-4;
          if (dirty) {
            Object.assign(local, next);
            updated += 1;
            changed = true;
          } else {
            local.updatedAt = Date.now();
          }
        }
      }
    }

    if (changed) {
      saveStore();
      broadcastSafe({ type: 'copyUpdate', ...getSnapshot(uid) });
    }
    console.log(
      `[copy-engine] sync okx positions: exchange≈${openExchange} closed=${closed} updated=${updated} user=${uid || 'all'}`,
    );
    return {
      synced: true,
      openExchange,
      openLocal: store.positions.filter((p) => p.status === 'open').length,
      closed,
      updated,
    };
  } catch (err) {
    console.warn('[copy-engine] sync positions:', err.message || err);
    return { synced: false, reason: err.message || String(err) };
  } finally {
    posSyncing = false;
  }
}

function startCopyEngine() {
  loadStore();
  void syncPositionsFromExchange(true);
  if (posSyncTimer) clearInterval(posSyncTimer);
  posSyncTimer = setInterval(() => {
    void syncPositionsFromExchange(false);
  }, POS_SYNC_INTERVAL_MS);
  console.log(
    `[copy-engine] ready tasks=${store.tasks.length} enabled=${store.tasks.filter((t) => t.enabled).length}`,
  );
}

function newTaskId() {
  return `ct_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 从巨鲸持仓详情一键跟单：开仓成功后才写入跟单列表
 * @param {{ exchanges: Array<'okx'|'binance'>, userId?: string, whaleAddress: string, whaleName?: string, position: object }} input
 */
async function followFromPosition(input = {}) {
  const exchanges = Array.isArray(input.exchanges) ? input.exchanges : [];
  const list = exchanges.filter((e) => e === 'okx' || e === 'binance');
  if (!list.length) {
    const err = new Error('请选择跟单交易所');
    err.status = 400;
    throw err;
  }
  const userId = String(input.userId || '').trim();
  if (!userId) {
    const err = new Error('未登录');
    err.status = 401;
    throw err;
  }
  const whaleAddress = String(input.whaleAddress || '').trim();
  if (!whaleAddress) {
    const err = new Error('缺少巨鲸地址');
    err.status = 400;
    throw err;
  }
  const whaleName = String(input.whaleName || '').trim();
  const pos = input.position || {};
  const coin = String(pos.coin || pos.coinLabel || '')
    .trim()
    .replace(/\/.*/, '');
  const side = pos.side === 'short' ? 'short' : 'long';
  if (!coin) {
    const err = new Error('缺少币种');
    err.status = 400;
    throw err;
  }

  const entryPx = Number(pos.entryPx) || 0;
  const markPx = Number(pos.markPx) || entryPx;
  const price = markPx > 0 ? markPx : entryPx;
  const whaleLever = Math.max(0, Number(pos.leverage) || 0);
  const posValue = Math.abs(Number(pos.positionValue) || 0);
  const posMargin =
    Math.abs(Number(pos.marginUsed) || 0) ||
    (whaleLever > 0 && posValue > 0 ? posValue / whaleLever : 0);
  const whaleAccountValue = Math.abs(Number(input.whaleAccountValue) || 0);
  const whaleTotalPositionUsd = Math.abs(Number(input.whaleTotalPositionUsd) || 0);
  const meta =
    whaleAccountValue > 0 || whaleTotalPositionUsd > 0
      ? { whaleAccountValue, whaleTotalPositionUsd }
      : resolveWhaleMeta(whaleAddress);

  const created = [];
  const reused = [];
  const positionsAdded = [];
  const orders = [];
  const failures = [];

  for (const exchange of list) {
    if (exchange === 'binance') {
      failures.push('币安跟单对接中，暂不可用');
      continue;
    }

    const creds = getOkxCredentialsForUser(userId);
    if (!creds) {
      failures.push('开仓失败: 请先在跟单页绑定 OKX API Key');
      continue;
    }

    let task = store.tasks.find(
      (t) =>
        t.exchange === exchange &&
        String(t.userId || '') === userId &&
        normAddr(t.whaleAddress) === normAddr(whaleAddress),
    );
    const isNew = !task;
    if (!task) {
      task = {
        id: newTaskId(),
        userId,
        name: whaleName
          ? `${whaleName} · ${exchange === 'okx' ? 'OKX' : '币安'}`
          : exchange === 'okx'
            ? 'OKX 跟单'
            : '币安跟单',
        exchange,
        enabled: true,
        whaleAddress,
        followCapitalUsd: 1000,
        maxLeverage: whaleLever > 0 ? whaleLever : 0,
        maxNotionalUsd: 0,
        note: coin ? `来自持仓 ${coin} ${side === 'long' ? '多' : '空'}` : '',
        updatedAt: Date.now(),
      };
    }

    const { notional, lever, userMargin, ratio } = calcProportionalSize(task, {
      action: 'open',
      leverage: whaleLever || Number(task.maxLeverage) || 5,
      marginUsed: posMargin,
      positionValue: posValue,
      whaleAccountValue: meta.whaleAccountValue || whaleAccountValue,
      whaleTotalPositionUsd: meta.whaleTotalPositionUsd || whaleTotalPositionUsd,
    });

    const recordBase = {
      id: `cr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      taskId: task.id,
      userId,
      at: Date.now(),
      kind: 'open',
      coin,
      side,
      lever,
      marginUsd: userMargin,
      px: price || undefined,
      note: '',
      whaleName,
      ratio,
    };

    if (!(price > 0)) {
      const failNote = '开仓失败: 缺少当前币价，无法换算张数';
      // 失败不写入跟单列表（新任务不落盘）
      pushRecord({ ...recordBase, status: 'fail', note: failNote });
      failures.push(failNote);
      saveStore();
      continue;
    }

    try {
      const instId = coinToInstId(coin);
      const info = await getInstrument(instId);
      const rawSz = notional / (price * info.ctVal);
      const sz = roundLot(rawSz, info.lotSz);
      if (!(sz >= info.minSz)) {
        throw new Error(`计算张数过小 sz=${rawSz.toFixed(4)} min=${info.minSz}`);
      }

      const okxSide = side === 'short' ? 'sell' : 'buy';
      const { order } = await withTradeCredentials(creds, () =>
        placeOrder({
          instId,
          side: okxSide,
          posSide: side,
          tdMode: 'cross',
          ordType: 'market',
          sz: String(sz),
          lever: String(lever),
          setLeverage: process.env.OKX_TRADE_SET_LEVERAGE || '0',
          clOrdId: `f${Date.now().toString(36)}`.slice(0, 32),
          tag: 'hlcopy',
        }),
      );

      // 开仓成功后才加入/更新跟单列表
      if (isNew) {
        store.tasks.unshift(task);
        created.push(task);
      } else {
        task.updatedAt = Date.now();
        if (!task.enabled) task.enabled = true;
        if (!task.note && coin) task.note = `来自持仓 ${coin} ${side === 'long' ? '多' : '空'}`;
        reused.push(task);
      }

      const local = findLocalPos(task.id, coin, side);
      const nextPos = {
        id: local?.id || `cp_${task.id}_${coin}_${side}`.toLowerCase(),
        taskId: task.id,
        coin,
        side,
        lever,
        mgnMode: 'cross',
        marginUsd: (local?.marginUsd || 0) + userMargin,
        size: (local?.size || 0) + sz,
        notionalUsd: (local?.notionalUsd || 0) + notional,
        entryPx: price,
        markPx: price,
        liqPx: 0,
        mgnRatio: 0,
        uPnl: 0,
        pnlRatio: 0,
        status: 'open',
        instId,
        updatedAt: Date.now(),
        source: 'manual-follow-open',
      };
      if (local) Object.assign(local, nextPos);
      else store.positions.unshift(nextPos);
      positionsAdded.push(nextPos);
      orders.push({
        exchange,
        instId,
        sz,
        ordId: order?.ordId || null,
        side,
        lever,
        notional,
        userMargin,
        ratio,
      });

      pushRecord({
        ...recordBase,
        status: 'ok',
        note: `手动跟单开仓 ${instId} ${side === 'long' ? '多' : '空'} ${sz} 张 · ${lever}x · 比例${(ratio * 100).toFixed(2)}% · 保证金≈${userMargin.toFixed(2)}U · 市价≈${price} · ordId=${order?.ordId || '—'}`,
        marginUsd: userMargin,
      });
      saveStore();
      console.log(
        `[copy-engine] follow-open ${task.name} ${coin} ${side} sz=${sz} ${lever}x ratio=${(ratio * 100).toFixed(2)}% margin=${userMargin.toFixed(2)}`,
      );
    } catch (err) {
      const failNote = `开仓失败: ${err.message || err}`;
      // 失败：新任务不入库；已有任务保留，只记失败记录
      pushRecord({
        ...recordBase,
        status: 'fail',
        note: failNote,
      });
      failures.push(failNote);
      saveStore();
      console.warn('[copy-engine] follow-open failed:', err.message || err);
    }
  }

  broadcastSafe({ type: 'copyUpdate', ...getSnapshot(userId) });
  return {
    ok: failures.length === 0 && orders.length > 0,
    created,
    reused,
    positions: positionsAdded,
    orders,
    failures,
    error: failures[0] || undefined,
    snapshot: getSnapshot(userId),
  };
}

/**
 * 用户手动平仓：市价全平本地跟单仓（OKX reduceOnly）
 */
async function closePositionManual(positionId, userId) {
  const uid = String(userId || '').trim();
  const pid = String(positionId || '').trim();
  if (!uid) {
    const err = new Error('未登录');
    err.status = 401;
    throw err;
  }
  if (!pid) {
    const err = new Error('缺少仓位 id');
    err.status = 400;
    throw err;
  }

  const local = store.positions.find((p) => p.id === pid && p.status === 'open');
  if (!local) {
    const err = new Error('仓位不存在或已平仓');
    err.status = 404;
    throw err;
  }

  const task = store.tasks.find((t) => t.id === local.taskId);
  if (!task || String(task.userId || '') !== uid) {
    const err = new Error('无权平仓该仓位');
    err.status = 403;
    throw err;
  }
  if (task.exchange === 'binance') {
    const err = new Error('币安跟单对接中，暂不可平仓');
    err.status = 400;
    throw err;
  }

  const coin = String(local.coin || '').trim();
  const side = local.side === 'short' ? 'short' : 'long';
  const instId = String(local.instId || coinToInstId(coin));
  const size = Number(local.size) || 0;
  if (!(size > 0)) {
    local.status = 'closed';
    local.closedAt = Date.now();
    local.updatedAt = Date.now();
    saveStore();
    return { ok: true, snapshot: getSnapshot(uid) };
  }

  const creds = getOkxCredentialsForUser(uid);
  if (!creds) {
    const err = new Error('请先绑定 OKX API Key');
    err.status = 400;
    throw err;
  }

  const recordBase = {
    id: `cr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    taskId: task.id,
    userId: uid,
    at: Date.now(),
    kind: 'close',
    coin,
    side,
    lever: local.lever,
    marginUsd: local.marginUsd,
    px: local.markPx || local.entryPx,
    note: '',
  };

  try {
    const info = await getInstrument(instId);
    let sz = roundLot(size, info.lotSz) || size;
    if (!(sz >= info.minSz) && sz < size) {
      sz = size;
    }

    const okxSide = closeOrderSide(side);
    const { order } = await withTradeCredentials(creds, () =>
      placeOrder({
        instId,
        side: okxSide,
        posSide: side,
        tdMode: local.mgnMode === 'isolated' ? 'isolated' : 'cross',
        ordType: 'market',
        sz: String(sz),
        reduceOnly: true,
        setLeverage: '0',
        clOrdId: `m${Date.now().toString(36)}`.slice(0, 32),
        tag: 'hlcopy',
      }),
    );

    local.status = 'closed';
    local.size = 0;
    local.notionalUsd = 0;
    local.uPnl = 0;
    local.pnlRatio = 0;
    local.closedAt = Date.now();
    local.closeSource = 'manual';
    local.updatedAt = Date.now();

    pushRecord({
      ...recordBase,
      status: 'ok',
      note: `手动平仓 ${instId} ${side === 'long' ? '多' : '空'} ${sz} 张 · ordId=${order?.ordId || '—'}`,
    });
    markReduce(task.id, coin, side);
    saveStore();
    broadcastSafe({ type: 'copyUpdate', ...getSnapshot(uid) });
    console.log(`[copy-engine] manual-close ${task.name} ${coin} ${side} sz=${sz}`);
    return {
      ok: true,
      order: { instId, sz, ordId: order?.ordId || null, side },
      snapshot: getSnapshot(uid),
    };
  } catch (err) {
    pushRecord({
      ...recordBase,
      status: 'fail',
      note: `手动平仓失败: ${err.message || err}`,
    });
    saveStore();
    broadcastSafe({ type: 'copyUpdate', ...getSnapshot(uid) });
    const e = new Error(err.message || '手动平仓失败');
    e.status = Number(err.status) || 400;
    throw e;
  }
}

module.exports = {
  startCopyEngine,
  onWhaleAlerts,
  getSnapshot,
  listTasks,
  findDuplicateAddress,
  upsertTask,
  removeTask,
  replaceTasks,
  followFromPosition,
  closePositionManual,
  syncPositionsFromExchange,
  normAddr,
};
