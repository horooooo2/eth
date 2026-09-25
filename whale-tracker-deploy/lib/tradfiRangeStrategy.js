const crypto = require('node:crypto');
const { getDb } = require('./db');
const { getBinanceCredentialsForUser } = require('./userExchangeKeys');
const { signedRequest, publicGet, symbolRules, stepped } = require('./binanceTradfiTrade');
const { recordBinanceAiOrder } = require('./binanceAiLedger');

const SYMBOLS = new Set(['XAUUSDT', 'XAGUSDT']);
const MARGIN = 10;
const LEVERAGE = 10;
const MAX_ADDITIONS = 20;
const POLL_MS = 15_000;
const ORDER_TTL_MS = 90_000;
const COOLDOWN_MS = 5 * 60_000;
let timer = null;
let busy = false;

function invalid(message, status = 400) { return Object.assign(new Error(message), { status }); }
function isPostOnlyReject(error) { return Number(error?.code) === -5022 || /Post Only|could not be executed as maker/i.test(error?.message || ''); }
function parseState(row) { try { return JSON.parse(row?.state_json || '{}'); } catch { return {}; } }
function cleanSymbol(value) {
  const symbol = String(value || '').trim().toUpperCase();
  if (!SYMBOLS.has(symbol)) throw invalid('震荡交易仅支持黄金和白银');
  return symbol;
}
function log(userId, symbol, message, level = 'info', details = {}) {
  getDb().prepare('INSERT INTO tradfi_range_events (user_id,symbol,level,message,details_json,created_at) VALUES (?,?,?,?,?,?)')
    .run(String(userId), symbol, level, message, JSON.stringify(details), Date.now());
}
function save(row, patch = {}, statePatch = null) {
  const state = statePatch == null ? parseState(row) : { ...parseState(row), ...statePatch };
  getDb().prepare(`UPDATE tradfi_range_strategies SET enabled=?,status=?,simulated=?,additions=?,state_json=?,last_error=?,started_at=?,updated_at=? WHERE user_id=? AND symbol=?`)
    .run(patch.enabled ?? row.enabled, patch.status ?? row.status, patch.simulated ?? row.simulated,
      patch.additions ?? row.additions, JSON.stringify(state), patch.last_error ?? row.last_error,
      patch.started_at ?? row.started_at, Date.now(), row.user_id, row.symbol);
}
function rowFor(userId, symbol) {
  return getDb().prepare('SELECT * FROM tradfi_range_strategies WHERE user_id=? AND symbol=?').get(String(userId), cleanSymbol(symbol));
}
function publicRow(row) {
  if (!row) return null;
  const s = parseState(row);
  return { symbol: row.symbol, enabled: Boolean(row.enabled), status: row.status, simulated: Boolean(row.simulated), additions: row.additions,
    maxAdditions: MAX_ADDITIONS, marginPerOrder: MARGIN, leverage: LEVERAGE, cycleId: s.cycleId || null,
    comboPnl: s.comboPnl ?? null, lastPrice: s.lastPrice ?? null, range: s.range || null,
    lastError: row.last_error || '', startedAt: row.started_at, updatedAt: row.updated_at };
}
function status(userId, symbol) {
  const sym = cleanSymbol(symbol);
  const row = rowFor(userId, sym);
  const events = getDb().prepare('SELECT id,level,message,details_json,created_at FROM tradfi_range_events WHERE user_id=? AND symbol=? ORDER BY created_at DESC LIMIT 80').all(String(userId), sym)
    .map((e) => ({ ...e, details: (() => { try { return JSON.parse(e.details_json); } catch { return {}; } })() }));
  return { strategy: publicRow(row) || { symbol: sym, enabled: false, status: 'stopped', simulated: null, additions: 0, maxAdditions: MAX_ADDITIONS, marginPerOrder: MARGIN, leverage: LEVERAGE }, events };
}
function enable(userId, symbol, simulated) {
  const sym = cleanSymbol(symbol);
  const now = Date.now();
  getDb().prepare(`INSERT INTO tradfi_range_strategies (user_id,symbol,enabled,status,simulated,additions,state_json,last_error,started_at,updated_at)
    VALUES (?,?,1,'waiting',?,0,'{}','',?,?) ON CONFLICT(user_id,symbol) DO UPDATE SET enabled=1,status='waiting',simulated=excluded.simulated,additions=0,state_json='{}',last_error='',started_at=excluded.started_at,updated_at=excluded.updated_at`)
    .run(String(userId), sym, simulated ? 1 : 0, now, now);
  log(userId, sym, '震荡交易已开启，服务器开始24小时监控');
  return status(userId, sym);
}
async function disable(userId, symbol) {
  const row = rowFor(userId, symbol);
  if (!row) return status(userId, symbol);
  const state = parseState(row);
  const creds = getBinanceCredentialsForUser(userId);
  if (creds) await cancelKnown(creds, row.symbol, state).catch(() => {});
  save(row, { enabled: 0, status: 'paused' }, { pending: null });
  log(userId, row.symbol, '震荡交易已暂停，已有持仓保留并交由人工处理', 'warn');
  return status(userId, row.symbol);
}
function ema(values, period) {
  const k = 2 / (period + 1); let out = values[0];
  for (let i = 1; i < values.length; i += 1) out = values[i] * k + out * (1 - k);
  return out;
}
function marketState(rows15, rows60) {
  const c15 = rows15.map((r) => Number(r[4])).filter(Number.isFinite);
  const h15 = rows15.map((r) => Number(r[2]));
  const l15 = rows15.map((r) => Number(r[3]));
  const c60 = rows60.map((r) => Number(r[4])).filter(Number.isFinite);
  if (c15.length < 30 || c60.length < 20) throw new Error('K线数据不足');
  const last = c15.at(-1); const atr = h15.slice(-20).reduce((sum, h, i) => sum + Math.abs(h - l15.slice(-20)[i]), 0) / 20;
  const fastNow = ema(c15.slice(-20), 10); const fastOld = ema(c15.slice(-24, -4), 10);
  const hourMove = Math.abs(c60.at(-1) / c60.at(-8) - 1);
  const slope = Math.abs(fastNow / fastOld - 1);
  const range = { low: Math.min(...l15.slice(-24)), high: Math.max(...h15.slice(-24)) };
  const rangeReady = hourMove <= 0.018 && slope <= 0.008 && atr / last >= 0.00045 && atr / last <= 0.012;
  return { last, atr, range, rangeReady, trend: !rangeReady && (hourMove > 0.025 || slope > 0.012) };
}
async function snapshot(symbol) {
  const [rows15, rows60, book] = await Promise.all([
    publicGet('/fapi/v1/klines', { symbol, interval: '15m', limit: 48 }),
    publicGet('/fapi/v1/klines', { symbol, interval: '1h', limit: 30 }),
    publicGet('/fapi/v1/ticker/bookTicker', { symbol }),
  ]);
  return { ...marketState(rows15, rows60), bid: Number(book.bidPrice), ask: Number(book.askPrice) };
}
function positionsOf(rows, symbol) {
  const list = Array.isArray(rows) ? rows : [];
  return {
    long: list.find((p) => p.symbol === symbol && p.positionSide === 'LONG'),
    short: list.find((p) => p.symbol === symbol && p.positionSide === 'SHORT'),
  };
}
function qty(row) { return Math.abs(Number(row?.positionAmt || 0)); }
function closeEnough(a, b) { return Math.abs(Number(a) - Number(b)) <= Math.max(1e-9, Number(b) * 0.00001); }
async function orderQty(symbol, price) {
  const rules = await symbolRules(symbol);
  const lot = new Map((rules?.filters || []).map((f) => [f.filterType, f])).get('LOT_SIZE');
  if (!lot) throw new Error('合约数量规则缺失');
  const quantity = stepped(MARGIN * LEVERAGE / price, lot.stepSize);
  if (!(Number(quantity) >= Number(lot.minQty || 0))) throw new Error('10U订单低于币安最小数量');
  return quantity;
}
async function cancelOrder(creds, symbol, order) {
  if (!order?.orderId) return;
  try {
    const current = await signedRequest(creds, 'GET', '/fapi/v1/order', { symbol, orderId: String(order.orderId) });
    if (!['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'].includes(String(current.status))) await signedRequest(creds, 'DELETE', '/fapi/v1/order', { symbol, orderId: String(order.orderId) });
  } catch (err) { if (Number(err.code) !== -2013) throw err; }
}
async function cancelKnown(creds, symbol, state) {
  await Promise.all([...(state.entries || []), state.pending].filter(Boolean).map((o) => cancelOrder(creds, symbol, o)));
}
function remember(userId, row, order, clientId, side, price, quantity) {
  try {
    recordBinanceAiOrder(userId, 'tradfi', { orderId: order.orderId, clientOrderId: clientId, symbol: row.symbol,
      side, positionSide: side === 'BUY' ? 'LONG' : 'SHORT', price, quantity, marginUsdt: MARGIN, leverage: LEVERAGE, simulated: Boolean(row.simulated) });
  } catch (err) { console.warn('[tradfi-range] ledger:', err.message); }
}
async function placeLimit(creds, row, side, price, suffix) {
  const rules = await symbolRules(row.symbol);
  const tick = Number(new Map((rules?.filters || []).map((f) => [f.filterType, f])).get('PRICE_FILTER')?.tickSize);
  if (!(tick > 0)) throw new Error('合约价格规则缺失');
  let order; let clientId; let makerPrice; let quantity;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const book = await publicGet('/fapi/v1/ticker/bookTicker', { symbol: row.symbol });
    const bid = Number(book.bidPrice); const ask = Number(book.askPrice);
    const cushion = tick * attempt;
    const raw = side === 'BUY' ? Math.min(Number(price), bid - cushion) : Math.max(Number(price), ask + cushion);
    makerPrice = stepped(raw, tick, side === 'BUY' ? 'floor' : 'ceil');
    quantity = await orderQty(row.symbol, Number(makerPrice));
    clientId = `wtf_rg_${parseState(row).cycleId}_${suffix}_${attempt}`.slice(0, 36);
    try {
      order = await signedRequest(creds, 'POST', '/fapi/v1/order', { symbol: row.symbol, side, positionSide: side === 'BUY' ? 'LONG' : 'SHORT', type: 'LIMIT', timeInForce: 'GTX', price: makerPrice, quantity, newClientOrderId: clientId });
      break;
    } catch (error) {
      const postOnlyRejected = isPostOnlyReject(error);
      if (postOnlyRejected && attempt < 2) continue;
      if (postOnlyRejected) throw invalid('盘口连续变化，Maker 挂单重试后仍被币安拒绝；本轮未创建订单，稍后自动重试', 503);
      try { order = await signedRequest(creds, 'GET', '/fapi/v1/order', { symbol: row.symbol, origClientOrderId: clientId }); break; }
      catch (queryError) {
        if (Number(queryError.code) === -2013) throw error;
        throw invalid(`订单状态无法确认，请立即在币安核对 ${clientId}`, 409);
      }
    }
  }
  if (!order?.orderId) throw invalid('币安未返回订单编号，本轮停止提交', 409);
  remember(row.user_id, row, order, clientId, side, Number(makerPrice), quantity);
  return { orderId: String(order.orderId), clientOrderId: clientId, side, price: Number(makerPrice), quantity, placedAt: Date.now() };
}
async function startCycle(row, creds, market) {
  const risk = await signedRequest(creds, 'GET', '/fapi/v2/positionRisk', { symbol: row.symbol });
  const pos = positionsOf(risk, row.symbol);
  if (qty(pos.long) || qty(pos.short)) throw invalid('检测到已有黄金或白银仓位，策略转人工接管', 409);
  const mode = await signedRequest(creds, 'GET', '/fapi/v1/positionSide/dual');
  if (!(mode.dualSidePosition === true || mode.dualSidePosition === 'true')) throw invalid('请先在币安开启双向持仓模式', 409);
  await signedRequest(creds, 'POST', '/fapi/v1/leverage', { symbol: row.symbol, leverage: String(LEVERAGE) });
  const cycleId = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  save(row, { status: 'entry_pending', additions: 0, last_error: '' }, { cycleId, entries: [], pending: null, expectedLong: 0, expectedShort: 0, lastAddPrice: market.last, range: market.range, lastPrice: market.last });
  const fresh = rowFor(row.user_id, row.symbol); const entries = [];
  try {
    entries.push(await placeLimit(creds, fresh, 'BUY', market.bid, 'base_l'));
    entries.push(await placeLimit(creds, fresh, 'SELL', market.ask, 'base_s'));
  } catch (err) {
    await Promise.all(entries.map((o) => cancelOrder(creds, row.symbol, o).catch(() => {})));
    const latest = rowFor(row.user_id, row.symbol);
    save(latest, { enabled: Number(err.status) === 409 ? 0 : latest.enabled, status: Number(err.status) === 409 ? 'manual' : 'waiting' }, { entries: [], pending: null, cooldownUntil: Date.now() + COOLDOWN_MS });
    throw err;
  }
  save(fresh, { status: 'entry_pending' }, { entries, pending: null, entryDeadline: Date.now() + ORDER_TTL_MS });
  log(row.user_id, row.symbol, '已提交双向底仓，每侧10U × 10倍', 'trade', { bid: market.bid, ask: market.ask });
}
async function orderState(creds, symbol, order) { return signedRequest(creds, 'GET', '/fapi/v1/order', { symbol, orderId: String(order.orderId) }); }
async function closePositions(row, creds, pos) {
  const orders = [];
  if (qty(pos.long)) orders.push(signedRequest(creds, 'POST', '/fapi/v1/order', { symbol: row.symbol, side: 'SELL', positionSide: 'LONG', type: 'MARKET', quantity: String(qty(pos.long)), newClientOrderId: `wtf_rg_${Date.now()}_cl`.slice(0, 36) }));
  if (qty(pos.short)) orders.push(signedRequest(creds, 'POST', '/fapi/v1/order', { symbol: row.symbol, side: 'BUY', positionSide: 'SHORT', type: 'MARKET', quantity: String(qty(pos.short)), newClientOrderId: `wtf_rg_${Date.now()}_cs`.slice(0, 36) }));
  await Promise.all(orders);
}
async function reconcileRow(row) {
  const creds = getBinanceCredentialsForUser(row.user_id);
  if (!creds || Number(creds.simulated) !== Number(row.simulated)) throw new Error('币安密钥缺失或交易环境已变化');
  const state = parseState(row); const market = await snapshot(row.symbol);
  save(row, {}, { lastPrice: market.last, range: market.range });
  if (row.status === 'waiting') {
    if (state.cooldownUntil && Date.now() < state.cooldownUntil) return;
    if (market.rangeReady) await startCycle(row, creds, market);
    return;
  }
  if (row.status === 'entry_pending') {
    const states = await Promise.all((state.entries || []).map((o) => orderState(creds, row.symbol, o)));
    if (states.every((o) => o.status === 'FILLED')) {
      const expectedLong = Number(states[0].executedQty); const expectedShort = Number(states[1].executedQty);
      save(row, { status: 'active' }, { expectedLong, expectedShort, entries: [], lastAddPrice: market.last });
      log(row.user_id, row.symbol, '双向底仓已成交，进入震荡管理', 'trade'); return;
    }
    if (Date.now() < Number(state.entryDeadline || 0)) return;
    await cancelKnown(creds, row.symbol, state);
    const risk = await signedRequest(creds, 'GET', '/fapi/v2/positionRisk', { symbol: row.symbol });
    const pos = positionsOf(risk, row.symbol); if (qty(pos.long) || qty(pos.short)) await closePositions(row, creds, pos);
    save(row, { status: 'waiting' }, { entries: [], cooldownUntil: Date.now() + COOLDOWN_MS });
    log(row.user_id, row.symbol, '双向底仓未能同时成交，已撤销并回到等待状态', 'warn'); return;
  }
  const risk = await signedRequest(creds, 'GET', '/fapi/v2/positionRisk', { symbol: row.symbol });
  const pos = positionsOf(risk, row.symbol);
  if (!qty(pos.long) || !qty(pos.short)) throw invalid('双向仓位不完整，策略转人工接管', 409);
  if (row.status === 'add_pending' && state.pending) {
    const current = await orderState(creds, row.symbol, state.pending);
    if (current.status === 'FILLED') {
      const filled = Number(current.executedQty); const isLong = state.pending.side === 'BUY';
      save(row, { status: 'active', additions: row.additions + 1 }, { pending: null, expectedLong: state.expectedLong + (isLong ? filled : 0), expectedShort: state.expectedShort + (isLong ? 0 : filled), lastAddPrice: Number(current.avgPrice || state.pending.price) });
      log(row.user_id, row.symbol, `第 ${row.additions + 1}/20 档补仓已成交`, 'trade', { side: state.pending.side, quantity: filled }); return;
    }
    if (Date.now() - state.pending.placedAt > ORDER_TTL_MS) {
      await cancelOrder(creds, row.symbol, state.pending);
      const latestOrder = await orderState(creds, row.symbol, state.pending);
      const filled = Number(latestOrder.executedQty || 0); const isLong = state.pending.side === 'BUY';
      save(row, { status: 'active', additions: row.additions + (filled > 0 ? 1 : 0) }, { pending: null,
        expectedLong: state.expectedLong + (isLong ? filled : 0), expectedShort: state.expectedShort + (isLong ? 0 : filled),
        lastAddPrice: filled > 0 ? Number(latestOrder.avgPrice || state.pending.price) : state.lastAddPrice });
      if (filled > 0) log(row.user_id, row.symbol, `第 ${row.additions + 1}/20 档补仓部分成交，剩余已撤销`, 'trade', { side: state.pending.side, quantity: filled });
    }
    return;
  }
  if (!closeEnough(qty(pos.long), state.expectedLong) || !closeEnough(qty(pos.short), state.expectedShort)) throw invalid('检测到手动修改仓位，策略转人工接管', 409);
  const comboPnl = Number(pos.long.unRealizedProfit || 0) + Number(pos.short.unRealizedProfit || 0);
  save(row, {}, { comboPnl });
  const totalNotional = Math.abs(Number(pos.long.notional || 0)) + Math.abs(Number(pos.short.notional || 0));
  const target = Math.max(1, totalNotional * 0.003);
  if (comboPnl >= target) {
    await cancelKnown(creds, row.symbol, state); await closePositions(row, creds, pos);
    save(row, { status: 'waiting', additions: 0 }, { entries: [], pending: null, expectedLong: 0, expectedShort: 0, comboPnl: 0, cooldownUntil: Date.now() + COOLDOWN_MS });
    log(row.user_id, row.symbol, `组合达到盈利目标，已提交双边平仓（浮盈 ${comboPnl.toFixed(2)}U）`, 'success'); return;
  }
  if (market.trend) throw invalid('震荡结构已转为明显趋势，策略转人工接管', 409);
  if (row.additions >= MAX_ADDITIONS) throw invalid('已达到20次自动补仓上限，策略转人工接管', 409);
  const step = Math.max(market.atr, market.last * 0.0025); const anchor = Number(state.lastAddPrice || market.last);
  const longLosing = Number(pos.long.unRealizedProfit || 0) < Number(pos.short.unRealizedProfit || 0);
  const trigger = longLosing ? market.last <= anchor - step : market.last >= anchor + step;
  if (!trigger) return;
  const side = longLosing ? 'BUY' : 'SELL'; const price = longLosing ? market.bid : market.ask;
  const pending = await placeLimit(creds, row, side, price, `a${row.additions + 1}`);
  save(row, { status: 'add_pending' }, { pending });
  log(row.user_id, row.symbol, `已提交第 ${row.additions + 1}/20 档${longLosing ? '多单' : '空单'}补仓`, 'trade', { price });
}
async function reconcile() {
  if (busy) return; busy = true;
  try {
    const rows = getDb().prepare('SELECT * FROM tradfi_range_strategies WHERE enabled=1').all();
    for (const row of rows) {
      try { await reconcileRow(row); }
      catch (err) {
        const latest = rowFor(row.user_id, row.symbol);
        const manual = Number(err.status) === 409;
        save(latest, { enabled: manual ? 0 : latest.enabled, status: manual ? 'manual' : latest.status, last_error: err.message });
        log(row.user_id, row.symbol, err.message, 'error');
      }
    }
  } finally { busy = false; }
}
function start() { if (timer) return; timer = setInterval(() => { void reconcile(); }, POLL_MS); timer.unref?.(); void reconcile(); }

module.exports = { start, reconcile, status, enable, disable, marketState, isPostOnlyReject, SYMBOLS, MAX_ADDITIONS, MARGIN, LEVERAGE };
