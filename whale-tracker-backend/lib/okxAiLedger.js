/**
 * AI 开单账本。只记录本系统仓位建议挂出的 OKX 订单。
 * 交易所里手动开的仓不入库，也不计入盈亏。
 */
const { getDb } = require('./db');
const {
  getBalance,
  getAccountPositions,
  getPendingOrders,
  summarizeBalance,
  getOrder,
  getFillsHistory,
  getPositionsHistory,
} = require('./okxTradeClient');

function placedRow(result) {
  return result?.order || result?.result || null;
}

function recordAiOrder(userId, body, result) {
  const placed = placedRow(result);
  const ordId = String(placed?.ordId || '').trim();
  const plan = result?.plan || {};
  if (!userId || !ordId || !plan.instId) return null;
  getDb()
    .prepare(
      `INSERT INTO okx_ai_orders (
         user_id, ord_id, cl_ord_id, inst_id, coin, side, pos_side,
         px, sz, amount_usd, leverage, simulated, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, ord_id) DO NOTHING`,
    )
    .run(
      String(userId),
      ordId,
      String(plan.clOrdId || placed?.clOrdId || ''),
      String(plan.instId),
      String(body?.coin || '').toUpperCase(),
      String(plan.side || ''),
      String(plan.posSide || ''),
      Number(plan.entry) || null,
      String(plan.sz || ''),
      Number(plan.amountUsd) || Number(body?.amountUsd) || null,
      Number(plan.leverage) || null,
      result?.simulated ? 1 : 0,
      Date.now(),
    );
  return ordId;
}

function listAiOrders(userId, limit = 80) {
  return getDb()
    .prepare(
      `SELECT id, user_id, ord_id, cl_ord_id, inst_id, coin, side, pos_side,
              px, sz, amount_usd, leverage, simulated, created_at
       FROM okx_ai_orders
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(String(userId), Math.max(1, Math.min(200, Number(limit) || 80)));
}

function orderDir(order) {
  const ps = String(order.pos_side || '').toLowerCase();
  if (ps === 'long' || ps === 'short') return ps;
  return String(order.side || '').toLowerCase() === 'sell' ? 'short' : 'long';
}

function positionDir(pos) {
  const ps = String(pos.posSide || '').toLowerCase();
  if (ps === 'long' || ps === 'short') return ps;
  return Number(pos.pos) < 0 ? 'short' : 'long';
}

function priceClose(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!(x > 0) || !(y > 0)) return false;
  return Math.abs(x - y) / y <= 0.008;
}

function closedMatches(order, live, row) {
  if (String(row.instId || '') !== String(order.inst_id || '')) return false;
  const dir = String(row.direction || row.posSide || '').toLowerCase();
  if (dir && dir !== 'net' && dir !== orderDir(order)) return false;
  const openTs = Number(row.cTime) || 0;
  const created = Number(order.created_at) || 0;
  if (!(openTs > 0) || !(created > 0)) return false;
  if (openTs + 2 * 60 * 1000 < created) return false;
  if (openTs - created > 6 * 60 * 60 * 1000) return false;
  const avg = row.openAvgPx;
  return priceClose(avg, live?.avgPx) || priceClose(avg, order.px);
}

async function buildAiBook(userId) {
  const orders = listAiOrders(userId);
  const ordIds = new Set(orders.map((row) => row.ord_id).filter(Boolean));
  const clIds = new Set(orders.map((row) => row.cl_ord_id).filter(Boolean));

  const [balanceRows, positions, fills, closed] = await Promise.all([
    getBalance('USDT').catch(() => []),
    getAccountPositions('SWAP').catch(() => []),
    orders.length ? getFillsHistory('SWAP', 100).catch(() => []) : Promise.resolve([]),
    orders.length ? getPositionsHistory('SWAP', 100).catch(() => []) : Promise.resolve([]),
  ]);

  const balance = summarizeBalance(balanceRows);
  const usdt = (balance.details || []).find((row) => row.ccy === 'USDT') || null;

  const liveByOrd = new Map();
  await Promise.all(
    orders.slice(0, 30).map(async (row) => {
      try {
        const live = await getOrder({ instId: row.inst_id, ordId: row.ord_id });
        if (live) liveByOrd.set(row.ord_id, live);
      } catch {
        /* 单笔查询失败不挡住整页 */
      }
    }),
  );

  const usedPos = new Set();
  const realizedByOrd = new Map();
  let historyPnl = 0;
  const ranked = [...orders].sort((a, b) => Number(b.created_at) - Number(a.created_at));
  for (const row of closed || []) {
    const posId = String(row.posId || `${row.instId}:${row.cTime}:${row.uTime}`);
    if (!posId || usedPos.has(posId)) continue;
    const hit = ranked.find((order) => closedMatches(order, liveByOrd.get(order.ord_id), row));
    if (!hit) continue;
    const pnl = Number(row.realizedPnl);
    if (!Number.isFinite(pnl)) continue;
    const live = liveByOrd.get(hit.ord_id);
    const ourSz = Number(live?.accFillSz || hit.sz) || 0;
    const posSz = Math.max(Number(row.openMaxPos) || 0, Number(row.closeTotalPos) || 0, ourSz);
    const share = posSz > 0 ? Math.min(1, ourSz > 0 ? ourSz / posSz : 1) : 1;
    const part = pnl * share;
    usedPos.add(posId);
    historyPnl += part;
    realizedByOrd.set(hit.ord_id, (realizedByOrd.get(hit.ord_id) || 0) + part);
  }

  if (!usedPos.size) {
    for (const fill of fills || []) {
      const ordId = String(fill.ordId || '');
      const cl = String(fill.clOrdId || '');
      if (!ordIds.has(ordId) && !clIds.has(cl)) continue;
      const pnl = Number(fill.fillPnl);
      if (!Number.isFinite(pnl) || pnl === 0) continue;
      historyPnl += pnl;
      if (ordId && ordIds.has(ordId)) {
        realizedByOrd.set(ordId, (realizedByOrd.get(ordId) || 0) + pnl);
      }
    }
  }

  const aiSzByPos = new Map();
  for (const order of orders) {
    if (realizedByOrd.has(order.ord_id)) continue;
    const live = liveByOrd.get(order.ord_id);
    const state = String(live?.state || '');
    if (state !== 'filled' && state !== 'partially_filled') continue;
    const sz = Number(live?.accFillSz) || 0;
    if (!(sz > 0)) continue;
    const key = `${order.inst_id}|${orderDir(order)}`;
    aiSzByPos.set(key, (aiSzByPos.get(key) || 0) + sz);
  }

  let openPnl = 0;
  const openByKey = new Map();
  for (const pos of positions || []) {
    const key = `${pos.instId}|${positionDir(pos)}`;
    const aiSz = aiSzByPos.get(key) || 0;
    const posSz = Math.abs(Number(pos.pos) || 0);
    if (!(aiSz > 0) || !(posSz > 0)) continue;
    const share = Math.min(1, aiSz / posSz);
    const upl = (Number(pos.upl) || 0) * share;
    openPnl += upl;
    openByKey.set(key, { upl, aiSz, avgPx: Number(pos.avgPx) || null, lever: pos.lever || null });
  }

  const records = orders.map((order) => {
    const live = liveByOrd.get(order.ord_id);
    const key = `${order.inst_id}|${orderDir(order)}`;
    const open = openByKey.get(key);
    const filledSz = Number(live?.accFillSz) || 0;
    const openUpl =
      open && !realizedByOrd.has(order.ord_id) && filledSz > 0 && open.aiSz > 0
        ? open.upl * (filledSz / open.aiSz)
        : null;
    return {
      ordId: order.ord_id,
      clOrdId: order.cl_ord_id,
      instId: order.inst_id,
      coin: order.coin || String(order.inst_id || '').split('-')[0],
      side: order.side,
      posSide: order.pos_side || orderDir(order),
      px: order.px,
      avgPx: live?.avgPx ? Number(live.avgPx) : null,
      sz: order.sz,
      amountUsd: order.amount_usd,
      leverage: order.leverage,
      state: live?.state || 'recorded',
      createdAt: order.created_at,
      simulated: Boolean(order.simulated),
      source: 'ai',
      realizedPnl: realizedByOrd.has(order.ord_id) ? realizedByOrd.get(order.ord_id) : null,
      openUpl,
    };
  });

  return {
    scope: 'ai-only',
    balance: {
      totalEq: balance.totalEq,
      usdtEq: usdt ? usdt.eq : null,
      availBal: usdt ? usdt.availBal : null,
    },
    openPnl,
    historyPnl,
    records,
  };
}

function coinOf(instId) {
  return String(instId || '').split('-')[0] || instId;
}

function dirOf(posSide, side, pos) {
  const ps = String(posSide || '').toLowerCase();
  if (ps === 'long' || ps === 'short') return ps;
  if (Number(pos) < 0) return 'short';
  return String(side || '').toLowerCase() === 'sell' ? 'short' : 'long';
}

function isAiOrder(order, ordIds, clIds) {
  const ordId = String(order?.ordId || order?.ord_id || '');
  const cl = String(order?.clOrdId || order?.cl_ord_id || '');
  return ordIds.has(ordId) || (cl && clIds.has(cl)) || cl.startsWith('wtai');
}

/** 交易账户：只列出本系统 AI 挂出的单。手动仓位和手动挂单不进入列表。 */
async function buildAccountPreview(userId) {
  const orders = listAiOrders(userId);
  const ordIds = new Set(orders.map((row) => row.ord_id).filter(Boolean));
  const clIds = new Set(orders.map((row) => row.cl_ord_id).filter(Boolean));

  const [balanceRows, positions, pending, closed] = await Promise.all([
    getBalance('USDT').catch(() => []),
    getAccountPositions('SWAP').catch(() => []),
    getPendingOrders('SWAP').catch(() => []),
    orders.length ? getPositionsHistory('SWAP', 100).catch(() => []) : Promise.resolve([]),
  ]);

  const balance = summarizeBalance(balanceRows);
  const usdt = (balance.details || []).find((row) => row.ccy === 'USDT') || null;

  const liveByOrd = new Map();
  await Promise.all(
    orders.slice(0, 30).map(async (row) => {
      try {
        const live = await getOrder({ instId: row.inst_id, ordId: row.ord_id });
        if (live) liveByOrd.set(row.ord_id, live);
      } catch {
        /* 单笔查询失败不挡住整页 */
      }
    }),
  );

  const pendingRecords = (pending || [])
    .filter((order) => isAiOrder(order, ordIds, clIds))
    .map((order) => {
      const ledger = orders.find((row) => row.ord_id === String(order.ordId || '') || (order.clOrdId && row.cl_ord_id === String(order.clOrdId)));
      return ({
      kind: 'pending',
      ordId: String(order.ordId || ''),
      clOrdId: String(order.clOrdId || ''),
      instId: order.instId,
      coin: coinOf(order.instId),
      side: order.side,
      posSide: dirOf(order.posSide, order.side, 0),
      px: Number(order.px) || null,
      avgPx: null,
      sz: String(order.sz || ''),
      amountUsd: Number(ledger?.amount_usd) || null,
      leverage: Number(order.lever || ledger?.leverage) || null,
      state: order.state || 'live',
      createdAt: Number(order.cTime) || 0,
      simulated: false,
      source: 'ai',
      realizedPnl: null,
      openUpl: null,
      });
    });

  const pendingIds = new Set(pendingRecords.map((row) => row.ordId));
  const aiSzByPos = new Map();
  for (const order of orders) {
    if (pendingIds.has(order.ord_id)) continue;
    const live = liveByOrd.get(order.ord_id);
    const state = String(live?.state || '');
    if (state && state !== 'filled' && state !== 'partially_filled') continue;
    const sz = Number(live?.accFillSz || (!state ? order.sz : 0)) || 0;
    if (!(sz > 0)) continue;
    const key = `${order.inst_id}|${orderDir(order)}`;
    aiSzByPos.set(key, (aiSzByPos.get(key) || 0) + sz);
  }

  const positionRecords = [];
  let openPnl = 0;
  for (const pos of positions || []) {
    const key = `${pos.instId}|${positionDir(pos)}`;
    const aiSz = aiSzByPos.get(key) || 0;
    const posSz = Math.abs(Number(pos.pos) || 0);
    if (!(aiSz > 0) || !(posSz > 0)) continue;
    const share = Math.min(1, aiSz / posSz);
    const upl = (Number(pos.upl) || 0) * share;
    openPnl += upl;
    positionRecords.push({
      kind: 'position',
      ordId: `pos:${pos.posId || pos.instId}:${positionDir(pos)}`,
      clOrdId: '',
      instId: pos.instId,
      coin: coinOf(pos.instId),
      side: Number(pos.pos) < 0 ? 'sell' : 'buy',
      posSide: positionDir(pos),
      px: Number(pos.avgPx) || null,
      avgPx: Number(pos.avgPx) || null,
      sz: String(posSz * share),
      amountUsd: Number(pos.notionalUsd) ? Number(pos.notionalUsd) * share : null,
      leverage: Number(pos.lever) || null,
      state: 'filled',
      createdAt: Number(pos.cTime) || Number(pos.uTime) || 0,
      simulated: false,
      source: 'ai',
      realizedPnl: null,
      openUpl: upl,
    });
  }

  const usedPos = new Set();
  let historyPnl = 0;
  const ranked = [...orders].sort((a, b) => Number(b.created_at) - Number(a.created_at));
  for (const row of closed || []) {
    const posId = String(row.posId || `${row.instId}:${row.cTime}:${row.uTime}`);
    if (!posId || usedPos.has(posId)) continue;
    const hit = ranked.find((order) => closedMatches(order, liveByOrd.get(order.ord_id), row));
    if (!hit) continue;
    const pnl = Number(row.realizedPnl);
    if (!Number.isFinite(pnl)) continue;
    const live = liveByOrd.get(hit.ord_id);
    const ourSz = Number(live?.accFillSz || hit.sz) || 0;
    const posSz = Math.max(Number(row.openMaxPos) || 0, Number(row.closeTotalPos) || 0, ourSz);
    const share = posSz > 0 ? Math.min(1, ourSz > 0 ? ourSz / posSz : 1) : 1;
    usedPos.add(posId);
    historyPnl += pnl * share;
  }

  return {
    scope: 'ai-only',
    balance: {
      totalEq: balance.totalEq,
      usdtEq: usdt ? usdt.eq : null,
      availBal: usdt ? usdt.availBal : null,
    },
    openPnl,
    historyPnl,
    records: [...positionRecords, ...pendingRecords],
  };
}

module.exports = {
  recordAiOrder,
  listAiOrders,
  buildAiBook,
  buildAccountPreview,
};
