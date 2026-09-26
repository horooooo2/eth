const crypto = require('node:crypto');
const { getDb } = require('./db');
const { getBinanceCredentialsForUser } = require('./userExchangeKeys');
const { signedRequest, publicGet, symbolRules, stepped } = require('./binanceTradfiTrade');
const { recordBinanceAiOrder } = require('./binanceAiLedger');

const SYMBOLS = new Set(['XAUUSDT', 'XAGUSDT']);
const MARGIN = 10;
const LEVERAGE = 10;
const MAX_MARGIN = 20;
const MAX_LEVERAGE = 50;
const MAX_ADDITIONS = 20;
// 高频止盈检查与补仓触发；平仓后的下一轮仍由 COOLDOWN_MS 控制为 10 秒。
const POLL_MS = 3_000;
const ORDER_TTL_MS = 90_000;
const COOLDOWN_MS = 10_000;
const MIN_STEP_PCT = 0.0008;
const MAX_STEP_PCT = 0.0035;
const ATR_MULTIPLIER = 0.6;
const DEFAULT_MAKER_FEE = 0.0002;
const DEFAULT_TAKER_FEE = 0.0005;
const SLIPPAGE_RATE = 0.0001;
const SCALP_MIN_PROFIT = 0.4;
const SCALP_NOTIONAL_RATE = 0.0002;
const UNCERTAIN_ORDER_WAIT_MS = 30_000;
const feeCache = new Map();
const NEW_YORK_TIME = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', hourCycle: 'h23' });
let timer = null;
let busy = false;

function invalid(message, status = 400) { return Object.assign(new Error(message), { status }); }
function isPostOnlyReject(error) { return Number(error?.code) === -5022 || /Post Only|could not be executed as maker/i.test(error?.message || ''); }
function scalpProfitTarget(notional) { return Math.max(SCALP_MIN_PROFIT, Number(notional || 0) * SCALP_NOTIONAL_RATE); }
function commissionRate(value, fallback) {
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 ? rate : fallback;
}
function isCommodityWeekendMode(date = new Date()) {
  const parts = Object.fromEntries(NEW_YORK_TIME.formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  const hour = Number(parts.hour);
  return parts.weekday === 'Sat' || (parts.weekday === 'Fri' && hour >= 17) || (parts.weekday === 'Sun' && hour < 18);
}
function recoveryExitState({ recovery, armed, netPnl, peakNetPnl, trail, trend, target }) {
  if (!recovery || !armed) return { shouldClose: false, reason: '' };
  if (netPnl <= peakNetPnl - trail) return { shouldClose: true, reason: '恢复模式利润回撤触发' };
  if (!trend && netPnl >= target) return { shouldClose: true, reason: '恢复模式目标达成' };
  return { shouldClose: false, reason: '' };
}
function parseState(row) { try { return JSON.parse(row?.state_json || '{}'); } catch { return {}; } }
function cleanSymbol(value) {
  const symbol = String(value || '').trim().toUpperCase();
  if (!SYMBOLS.has(symbol)) throw invalid('震荡交易仅支持黄金和白银');
  return symbol;
}
function strategyConfig(row) {
  const raw = parseState(row).config || {};
  const marginUsdt = Number(raw.marginUsdt);
  const leverage = Number(raw.leverage);
  return {
    marginUsdt: Number.isFinite(marginUsdt) && marginUsdt > 0 ? marginUsdt : MARGIN,
    leverage: Number.isInteger(leverage) && leverage > 0 ? leverage : LEVERAGE,
  };
}
function requestedConfig(input = {}) {
  const marginUsdt = Number(input.marginUsdt ?? MARGIN);
  const leverage = Number(input.leverage ?? LEVERAGE);
  if (!Number.isFinite(marginUsdt) || marginUsdt <= 0 || marginUsdt > MAX_MARGIN) throw invalid(`单边保证金需在 0–${MAX_MARGIN} USDT 之间`);
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > MAX_LEVERAGE) throw invalid(`杠杆需在 1–${MAX_LEVERAGE} 倍之间`);
  return { marginUsdt, leverage };
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
function sideAdditions(state) {
  const longAdditions = Number(state?.longAdditions);
  const shortAdditions = Number(state?.shortAdditions);
  return {
    longAdditions: Number.isFinite(longAdditions) && longAdditions > 0 ? longAdditions : 0,
    shortAdditions: Number.isFinite(shortAdditions) && shortAdditions > 0 ? shortAdditions : 0,
  };
}
function additionDecision(state, longLosing) {
  const counts = sideAdditions(state);
  const sideCount = longLosing ? counts.longAdditions : counts.shortAdditions;
  const otherCount = longLosing ? counts.shortAdditions : counts.longAdditions;
  if (sideCount >= MAX_ADDITIONS && otherCount >= MAX_ADDITIONS) return { action: 'manual', ...counts };
  if (sideCount >= MAX_ADDITIONS) return { action: 'wait', ...counts };
  return { action: 'add', side: longLosing ? 'long' : 'short', next: sideCount + 1, ...counts };
}
function countedAdditions(state, isLong, increment) {
  const counts = sideAdditions(state);
  const longAdditions = counts.longAdditions + (isLong && increment ? 1 : 0);
  const shortAdditions = counts.shortAdditions + (!isLong && increment ? 1 : 0);
  return { longAdditions, shortAdditions, total: longAdditions + shortAdditions, next: isLong ? longAdditions : shortAdditions };
}
function legName(side) { return side === 'LONG' || side === 'long' ? 'long' : 'short'; }
function legValue(state, side, key, fallback) {
  const prefix = legName(side);
  const value = state?.[`${prefix}${key}`];
  return value == null ? fallback : value;
}
function legPatch(side, patch) {
  const prefix = legName(side);
  return Object.fromEntries(Object.entries(patch).map(([key, value]) => [`${prefix}${key}`, value]));
}
function legSnapshot(state, side) {
  const isLong = legName(side) === 'long';
  return {
    phase: legValue(state, side, 'Phase', 'active'),
    additions: Number(legValue(state, side, 'Additions', 0)) || 0,
    expectedQty: Number(legValue(state, side, 'ExpectedQty', isLong ? state?.expectedLong : state?.expectedShort)) || 0,
    lastAddPrice: Number(legValue(state, side, 'LastAddPrice', state?.lastAddPrice)) || 0,
    minPnl: Number(legValue(state, side, 'MinPnl', isLong ? state?.minLongPnl : state?.minShortPnl)) || 0,
    recovery: Boolean(legValue(state, side, 'Recovery', false)),
    recoveryArmed: Boolean(legValue(state, side, 'RecoveryArmed', false)),
    recoveryPeakNetPnl: Number(legValue(state, side, 'RecoveryPeakNetPnl', 0)) || 0,
    recoveryTrail: Number(legValue(state, side, 'RecoveryTrail', 0)) || 0,
    closeOrders: legValue(state, side, 'CloseOrders', []),
    closePlacedAt: Number(legValue(state, side, 'ClosePlacedAt', 0)) || 0,
    closeGuardPrice: Number(legValue(state, side, 'CloseGuardPrice', 0)) || 0,
    fundingStartedAt: Number(legValue(state, side, 'FundingStartedAt', state?.cycleStartedAt)) || 0,
    reentryAt: Number(legValue(state, side, 'ReentryAt', 0)) || 0,
    reentryOrder: legValue(state, side, 'ReentryOrder', null),
  };
}
function resetLeg(side, expectedQty, lastAddPrice) {
  return legPatch(side, { Phase: 'active', Additions: 0, ExpectedQty: expectedQty, LastAddPrice: lastAddPrice, MinPnl: 0,
    Recovery: false, RecoveryArmed: false, RecoveryPeakNetPnl: 0, RecoveryTrail: 0, CloseOrders: [], ClosePlacedAt: 0,
    CloseGuardPrice: 0, FundingStartedAt: Date.now(), ReentryAt: 0, ReentryOrder: null });
}
function publicRow(row) {
  if (!row) return null;
  const s = parseState(row);
  const config = strategyConfig(row);
  const counts = sideAdditions(s);
  return { symbol: row.symbol, enabled: Boolean(row.enabled), status: row.status, simulated: Boolean(row.simulated),
    additions: counts.longAdditions + counts.shortAdditions, longAdditions: counts.longAdditions, shortAdditions: counts.shortAdditions,
    maxAdditions: MAX_ADDITIONS, maxTotalAdditions: MAX_ADDITIONS * 2, marginPerOrder: config.marginUsdt, leverage: config.leverage, cycleId: s.cycleId || null,
    comboPnl: s.comboPnl ?? null, netPnl: s.netPnl ?? null, closeTrigger: s.closeTrigger ?? null,
    costs: s.costs || null, addStep: s.addStep ?? null, lastPrice: s.lastPrice ?? null, range: s.range || null,
    cooldownUntil: s.cooldownUntil ?? null, cycleStartedAt: s.cycleStartedAt ?? null,
    recovery: Boolean(s.recovery), recoveryArmed: Boolean(s.recoveryArmed),
    recoveryPeakNetPnl: s.recoveryPeakNetPnl ?? null, recoveryTrail: s.recoveryTrail ?? null,
    weekendMode: isCommodityWeekendMode(),
    long: { ...legSnapshot(s, 'long'), costs: s.longCosts || null },
    short: { ...legSnapshot(s, 'short'), costs: s.shortCosts || null },
    lastError: row.last_error || '', startedAt: row.started_at, updatedAt: row.updated_at };
}
function status(userId, symbol) {
  const sym = cleanSymbol(symbol);
  const row = rowFor(userId, sym);
  const events = getDb().prepare('SELECT id,level,message,details_json,created_at FROM tradfi_range_events WHERE user_id=? AND symbol=? ORDER BY created_at DESC LIMIT 80').all(String(userId), sym)
    .map((e) => ({ ...e, details: (() => { try { return JSON.parse(e.details_json); } catch { return {}; } })() }));
  return { strategy: publicRow(row) || { symbol: sym, enabled: false, status: 'stopped', simulated: null, additions: 0, longAdditions: 0, shortAdditions: 0, maxAdditions: MAX_ADDITIONS, maxTotalAdditions: MAX_ADDITIONS * 2, marginPerOrder: MARGIN, leverage: LEVERAGE }, events };
}
function enable(userId, symbol, simulated, input = {}) {
  const sym = cleanSymbol(symbol);
  const existing = rowFor(userId, sym);
  if (existing?.enabled) throw invalid('策略运行中，暂停后才能修改金额或杠杆');
  const config = requestedConfig(input);
  const now = Date.now();
  getDb().prepare(`INSERT INTO tradfi_range_strategies (user_id,symbol,enabled,status,simulated,additions,state_json,last_error,started_at,updated_at)
    VALUES (?,?,1,'waiting',?,0,?,'',?,?) ON CONFLICT(user_id,symbol) DO UPDATE SET enabled=1,status='waiting',simulated=excluded.simulated,additions=0,state_json=excluded.state_json,last_error='',started_at=excluded.started_at,updated_at=excluded.updated_at`)
    .run(String(userId), sym, simulated ? 1 : 0, JSON.stringify({ config }), now, now);
  log(userId, sym, `震荡交易已开启：单边 ${config.marginUsdt}U × ${config.leverage}倍，服务器开始24小时监控`);
  return status(userId, sym);
}
async function disable(userId, symbol) {
  const row = rowFor(userId, symbol);
  if (!row) return status(userId, symbol);
  const state = parseState(row);
  const creds = getBinanceCredentialsForUser(userId);
  if (creds) await cancelKnown(creds, row.symbol, state);
  save(row, { enabled: 0, status: 'paused' }, { pending: null });
  log(userId, row.symbol, '震荡交易已暂停，已有持仓保留并交由人工处理', 'warn');
  return status(userId, row.symbol);
}
function ema(values, period) {
  const k = 2 / (period + 1); let out = values[0];
  for (let i = 1; i < values.length; i += 1) out = values[i] * k + out * (1 - k);
  return out;
}
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function atr(rows, period = 20) {
  const window = rows.slice(-(period + 1));
  if (window.length < period + 1) throw new Error('K线数据不足');
  let total = 0;
  for (let i = 1; i < window.length; i += 1) {
    const high = Number(window[i][2]); const low = Number(window[i][3]); const previousClose = Number(window[i - 1][4]);
    total += Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
  }
  return total / period;
}
function ladderStep(last, atrValue) { return clamp(atrValue * ATR_MULTIPLIER, last * MIN_STEP_PCT, last * MAX_STEP_PCT); }
function marketState(rows15, rows60) {
  const c15 = rows15.map((r) => Number(r[4])).filter(Number.isFinite);
  const h15 = rows15.map((r) => Number(r[2]));
  const l15 = rows15.map((r) => Number(r[3]));
  const c60 = rows60.map((r) => Number(r[4])).filter(Number.isFinite);
  if (c15.length < 30 || c60.length < 20) throw new Error('K线数据不足');
  const last = c15.at(-1); const atrValue = atr(rows15, 20);
  const fastNow = ema(c15.slice(-20), 10); const fastOld = ema(c15.slice(-24, -4), 10);
  const hourMove = Math.abs(c60.at(-1) / c60.at(-8) - 1);
  const slope = Math.abs(fastNow / fastOld - 1);
  const range = { low: Math.min(...l15.slice(-24)), high: Math.max(...h15.slice(-24)) };
  const rangeReady = hourMove <= 0.018 && slope <= 0.008 && atrValue / last >= 0.00045 && atrValue / last <= 0.012;
  return { last, atr: atrValue, addStep: ladderStep(last, atrValue), range, rangeReady, trend: !rangeReady && (hourMove > 0.025 || slope > 0.012) };
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
function orderFillState(current, fallbackQuantity = 0) {
  if (!current) return 'unknown';
  const executed = Number(current.executedQty || 0);
  const original = Number(current.origQty || fallbackQuantity || 0);
  if (String(current.status || '') === 'FILLED' || (original > 0 && closeEnough(executed, original))) return 'filled';
  if (executed > 0) return 'partial';
  return ['CANCELED', 'EXPIRED', 'REJECTED'].includes(String(current.status || '')) ? 'unfilled' : 'open';
}
function isRequestTimeout(err) { return /timeout of \d+ms exceeded|timeout/i.test(String(err?.message || err || '')); }
function waitMs(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function findOrderByClientId(creds, symbol, clientId, attempts = 4) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await signedRequest(creds, 'GET', '/fapi/v1/order', { symbol, origClientOrderId: clientId }); }
    catch (err) {
      if (Number(err.code) !== -2013) throw err;
      if (attempt + 1 < attempts) await waitMs(250 * (attempt + 1));
    }
  }
  return null;
}
async function orderQty(symbol, price, config) {
  const rules = await symbolRules(symbol);
  const lot = new Map((rules?.filters || []).map((f) => [f.filterType, f])).get('LOT_SIZE');
  if (!lot) throw new Error('合约数量规则缺失');
  const quantity = stepped(config.marginUsdt * config.leverage / price, lot.stepSize);
  if (!(Number(quantity) >= Number(lot.minQty || 0))) throw new Error('当前保证金和杠杆低于币安最小下单数量');
  return quantity;
}
async function cancelOrder(creds, symbol, order) {
  if (!order?.orderId) return;
  try {
    const current = await signedRequest(creds, 'GET', '/fapi/v1/order', { symbol, orderId: String(order.orderId) });
    if (!['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'].includes(String(current.status))) await signedRequest(creds, 'DELETE', '/fapi/v1/order', { symbol, orderId: String(order.orderId) });
  } catch (err) { if (Number(err.code) !== -2013) throw err; }
}
function closeClientId(cycleId, positionSide) {
  const side = positionSide === 'LONG' ? 'L' : 'S';
  const cycle = String(cycleId || 'na').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'na';
  return `wtf_c_${cycle}_${side}${crypto.randomBytes(4).toString('hex')}`.slice(0, 36);
}
function isCloseClientId(value) {
  const id = String(value || '');
  return id.startsWith('wtf_c_') || /_close_/.test(id);
}
async function cancelKnown(creds, symbol, state) {
  const long = legSnapshot(state, 'long'); const short = legSnapshot(state, 'short');
  const orders = [
    ...(state.entries || []), ...(state.closeOrders || []), state.pending,
    ...(long.closeOrders || []), ...(short.closeOrders || []), long.reentryOrder, short.reentryOrder,
  ].filter(Boolean);
  const unique = [...new Map(orders.map((order) => [String(order.orderId || order.clientOrderId), order])).values()];
  await Promise.all(unique.map((order) => cancelOrder(creds, symbol, order)));
}
async function cancelOpenCloses(creds, symbol) {
  const open = await signedRequest(creds, 'GET', '/fapi/v1/openOrders', { symbol });
  const closes = (Array.isArray(open) ? open : []).filter((order) => isCloseClientId(order.clientOrderId));
  await Promise.all(closes.map((order) => cancelOrder(creds, symbol, order)));
}
async function pauseWeekendNewOrders(row, creds, state) {
  const long = legSnapshot(state, 'long'); const short = legSnapshot(state, 'short');
  const groups = [
    ...(state.entries || []).map((order, index) => ({ kind: 'entry', index, order })),
    ...(state.pending ? [{ kind: 'addition', order: state.pending }] : []),
    ...(long.reentryOrder ? [{ kind: 'reentry', direction: 'long', order: long.reentryOrder }] : []),
    ...(short.reentryOrder ? [{ kind: 'reentry', direction: 'short', order: short.reentryOrder }] : []),
  ];
  const orders = groups.map((item) => item.order);
  if (!orders.length) {
    save(row, {}, { weekendMode: true });
    log(row.user_id, row.symbol, '周末流动性模式已开启：暂停新开仓、补仓与止盈后的重建；已有 Maker 平仓单保持原价', 'info');
    return true;
  }
  await Promise.all(orders.map((order) => cancelOrder(creds, row.symbol, order)));
  const settled = await Promise.all(groups.map(async (item) => ({ ...item, current: await orderState(creds, row.symbol, item.order).catch(() => null) })));
  const filledQty = (item) => Number(item.current?.executedQty || 0);
  const fillState = (item) => orderFillState(item.current, item.order?.quantity);
  const fullyFilled = (item) => fillState(item) === 'filled';
  const uncertainOrPartial = settled.some((item) => ['unknown', 'partial', 'open'].includes(fillState(item)));
  const entries = settled.filter((item) => item.kind === 'entry');
  const entryPairFullyFilled = entries.length === 2 && entries.every(fullyFilled);
  const entryMismatch = entries.length > 0 && !(entryPairFullyFilled || entries.every((item) => filledQty(item) === 0));
  if (uncertainOrPartial || entryMismatch) {
    save(row, { enabled: 0, status: 'manual', last_error: '周末切换时订单部分成交或状态无法确认，请人工核对仓位后再启动策略' }, { weekendMode: true, entries: [], pending: null });
    log(row.user_id, row.symbol, '周末切换时检测到开仓类委托部分成交或状态不确定，策略已转人工接管', 'warn');
    return true;
  }
  const statePatch = {
    weekendMode: true, entries: [], pending: null,
    ...legPatch('long', long.phase === 'reentry_pending' ? { Phase: 'reentry_wait', ReentryOrder: null, ReentryAt: 0 } : {}),
    ...legPatch('short', short.phase === 'reentry_pending' ? { Phase: 'reentry_wait', ReentryOrder: null, ReentryAt: 0 } : {}),
  };
  let status = row.status === 'entry_pending' ? 'waiting' : row.status === 'add_pending' ? 'active' : row.status;
  if (entryPairFullyFilled) {
    const expectedLong = filledQty(entries[0]); const expectedShort = filledQty(entries[1]);
    Object.assign(statePatch, { expectedLong, expectedShort,
      ...resetLeg('long', expectedLong, Number(entries[0].current.avgPrice || entries[0].order.price)),
      ...resetLeg('short', expectedShort, Number(entries[1].current.avgPrice || entries[1].order.price)) });
    status = 'active';
  }
  const addition = settled.find((item) => item.kind === 'addition');
  if (addition && fullyFilled(addition)) {
    const isLong = addition.order.side === 'BUY'; const direction = isLong ? 'long' : 'short';
    const counted = countedAdditions(state, isLong, true); const filled = filledQty(addition);
    const leg = isLong ? long : short;
    Object.assign(statePatch, {
      longAdditions: counted.longAdditions, shortAdditions: counted.shortAdditions,
      expectedLong: Number(state.expectedLong || 0) + (isLong ? filled : 0),
      expectedShort: Number(state.expectedShort || 0) + (isLong ? 0 : filled),
      ...legPatch(direction, { ExpectedQty: leg.expectedQty + filled, Additions: counted.next,
        LastAddPrice: Number(addition.current.avgPrice || addition.order.price) }),
    });
  }
  for (const item of settled.filter((candidate) => candidate.kind === 'reentry' && fullyFilled(candidate))) {
    const filled = filledQty(item); const side = item.direction === 'long' ? 'LONG' : 'SHORT';
    Object.assign(statePatch, resetLeg(item.direction, filled, Number(item.current.avgPrice || item.order.price)),
      side === 'LONG' ? { expectedLong: filled } : { expectedShort: filled });
  }
  save(row, { status }, statePatch);
  log(row.user_id, row.symbol, '周末流动性模式已开启：已撤销未成交的开仓类委托；已有 Maker 平仓单保持原价', 'info');
  return true;
}
function remember(userId, row, order, clientId, side, price, quantity) {
  const config = strategyConfig(row);
  try {
    recordBinanceAiOrder(userId, 'tradfi', { orderId: order.orderId, clientOrderId: clientId, symbol: row.symbol,
      side, positionSide: side === 'BUY' ? 'LONG' : 'SHORT', price, quantity, marginUsdt: config.marginUsdt, leverage: config.leverage, simulated: Boolean(row.simulated) });
  } catch (err) { console.warn('[tradfi-range] ledger:', err.message); }
}
async function placeLimit(creds, row, side, price, suffix) {
  const config = strategyConfig(row);
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
    quantity = await orderQty(row.symbol, Number(makerPrice), config);
    clientId = `wtf_rg_${parseState(row).cycleId}_${suffix}_${attempt}`.slice(0, 36);
    try {
      order = await signedRequest(creds, 'POST', '/fapi/v1/order', { symbol: row.symbol, side, positionSide: side === 'BUY' ? 'LONG' : 'SHORT', type: 'LIMIT', timeInForce: 'GTX', price: makerPrice, quantity, newClientOrderId: clientId });
      break;
    } catch (error) {
      const postOnlyRejected = isPostOnlyReject(error);
      if (postOnlyRejected && attempt < 2) continue;
      if (postOnlyRejected) throw invalid('盘口连续变化，Maker 挂单重试后仍被币安拒绝；本轮未创建订单，稍后自动重试', 503);
      order = await findOrderByClientId(creds, row.symbol, clientId);
      if (order) break;
      throw invalid(`订单提交结果无法确认，请立即在币安核对 ${clientId}；策略不会重复提交`, 409);
    }
  }
  if (!order?.orderId) throw invalid('币安未返回订单编号，本轮停止提交', 409);
  remember(row.user_id, row, order, clientId, side, Number(makerPrice), quantity);
  return { orderId: String(order.orderId), clientOrderId: clientId, side, price: Number(makerPrice), quantity, placedAt: Date.now() };
}
async function startCycle(row, creds, market) {
  const config = strategyConfig(row);
  const risk = await signedRequest(creds, 'GET', '/fapi/v2/positionRisk', { symbol: row.symbol });
  const pos = positionsOf(risk, row.symbol);
  if (qty(pos.long) || qty(pos.short)) throw invalid('检测到已有黄金或白银仓位，策略转人工接管', 409);
  const mode = await signedRequest(creds, 'GET', '/fapi/v1/positionSide/dual');
  if (!(mode.dualSidePosition === true || mode.dualSidePosition === 'true')) throw invalid('请先在币安开启双向持仓模式', 409);
  await signedRequest(creds, 'POST', '/fapi/v1/leverage', { symbol: row.symbol, leverage: String(config.leverage) });
  const cycleId = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  const cycleStartedAt = Date.now();
  save(row, { status: 'entry_pending', additions: 0, last_error: '' }, { cycleId, cycleStartedAt, fundingStartedAt: cycleStartedAt, entries: [], pending: null, longAdditions: 0, shortAdditions: 0, expectedLong: 0, expectedShort: 0, lastAddPrice: market.last, addStep: market.addStep, range: market.range, lastPrice: market.last, minLongPnl: 0, minShortPnl: 0, recovery: false, recoveryArmed: false, recoveryPeakNetPnl: 0, recoveryTrail: 0 });
  const fresh = rowFor(row.user_id, row.symbol); const entries = [];
  try {
    entries.push(await placeLimit(creds, fresh, 'BUY', market.bid, 'base_l'));
    save(rowFor(row.user_id, row.symbol), { status: 'entry_pending' }, { entries: [...entries], pending: null, entryDeadline: Date.now() + ORDER_TTL_MS });
    entries.push(await placeLimit(creds, fresh, 'SELL', market.ask, 'base_s'));
    save(rowFor(row.user_id, row.symbol), { status: 'entry_pending' }, { entries: [...entries], pending: null, entryDeadline: Date.now() + ORDER_TTL_MS });
  } catch (err) {
    try { await Promise.all(entries.map((order) => cancelOrder(creds, row.symbol, order))); }
    catch (cancelErr) {
      const latest = rowFor(row.user_id, row.symbol);
      save(latest, { enabled: 0, status: 'manual', last_error: `底仓撤单失败：${cancelErr.message}` }, { entries: [...entries], pending: null });
      throw cancelErr;
    }
    const latest = rowFor(row.user_id, row.symbol);
    const riskAfterCancel = await signedRequest(creds, 'GET', '/fapi/v2/positionRisk', { symbol: row.symbol });
    const positionAfterCancel = positionsOf(riskAfterCancel, row.symbol);
    if (qty(positionAfterCancel.long) || qty(positionAfterCancel.short)) {
      const closeOrders = await closePositions(latest, creds, positionAfterCancel);
      save(rowFor(row.user_id, row.symbol), { enabled: 1, status: 'close_pending', last_error: err.message }, {
        entries: [], pending: null, closeOrders, closePlacedAt: Date.now(), closeReason: '双向底仓提交未完成', stopAfterClose: false,
      });
      log(row.user_id, row.symbol, '双向底仓提交未完成，已按实际成交数量提交 Maker 平仓', 'warn');
      return;
    }
    const manual = Number(err.status) === 409;
    save(latest, { enabled: manual ? 0 : latest.enabled, status: manual ? 'manual' : 'waiting', last_error: err.message }, { entries: [], pending: null, cooldownUntil: Date.now() + COOLDOWN_MS });
    if (manual) throw err;
    log(row.user_id, row.symbol, `双向底仓提交失败，本轮已安全撤销：${err.message}`, 'warn');
    return;
  }
  log(row.user_id, row.symbol, `已提交双向底仓，每侧${config.marginUsdt}U × ${config.leverage}倍`, 'trade', { bid: market.bid, ask: market.ask, config });
}
async function orderState(creds, symbol, order) { return signedRequest(creds, 'GET', '/fapi/v1/order', { symbol, orderId: String(order.orderId) }); }
async function recoverBaseOrders(creds, row, state) {
  const known = [...(state.entries || [])];
  const ids = new Set(known.map((order) => String(order.orderId)));
  for (const suffix of ['base_l', 'base_s']) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const clientId = `wtf_rg_${state.cycleId}_${suffix}_${attempt}`.slice(0, 36);
      try {
        const current = await signedRequest(creds, 'GET', '/fapi/v1/order', { symbol: row.symbol, origClientOrderId: clientId });
        if (!ids.has(String(current.orderId))) {
          known.push({ orderId: String(current.orderId), clientOrderId: clientId, side: current.side,
            price: Number(current.price), quantity: String(current.origQty), placedAt: Number(current.time || row.updated_at || Date.now()) });
          ids.add(String(current.orderId));
        }
        break;
      } catch (err) { if (Number(err.code) !== -2013) throw err; }
    }
  }
  return known;
}
async function commissionRates(creds, symbol) {
  const cached = feeCache.get(symbol);
  if (cached && Date.now() - cached.at < 15 * 60_000) return cached;
  try {
    const row = await signedRequest(creds, 'GET', '/fapi/v1/commissionRate', { symbol });
    // Zero is a valid rate for selected TradFi contracts. Do not replace it with
    // the conservative fallback, otherwise the strategy delays take profit.
    const value = {
      maker: commissionRate(row.makerCommissionRate, DEFAULT_MAKER_FEE),
      taker: commissionRate(row.takerCommissionRate, DEFAULT_TAKER_FEE),
      at: Date.now(),
    };
    feeCache.set(symbol, value);
    return value;
  } catch {
    return { maker: DEFAULT_MAKER_FEE, taker: DEFAULT_TAKER_FEE, at: Date.now() };
  }
}
async function costState(creds, row, state, totalNotional, comboPnl) {
  const rates = await commissionRates(creds, row.symbol);
  let fundingNet = 0;
  try {
    const income = await signedRequest(creds, 'GET', '/fapi/v1/income', {
      symbol: row.symbol, incomeType: 'FUNDING_FEE', startTime: String(state.cycleStartedAt || row.started_at || Date.now()), limit: '1000',
    });
    fundingNet = (Array.isArray(income) ? income : []).reduce((sum, item) => sum + Number(item.income || 0), 0);
  } catch { /* Funding history may be unavailable; fee buffer remains conservative. */ }
  const entryFee = totalNotional * rates.maker;
  const exitFee = totalNotional * rates.maker;
  const slippage = 0;
  const scalpTarget = scalpProfitTarget(totalNotional);
  const worstLeg = Math.abs(Math.min(0, Number(state.minLongPnl || 0), Number(state.minShortPnl || 0)));
  const recovery = Boolean(state.recovery) || worstLeg >= Math.max(5, totalNotional * 0.002);
  // In recovery, this is the point at which trailing begins, rather than an
  // immediate take-profit. It lets a strong reversal run while protecting it.
  const profitTarget = recovery ? Math.max(scalpTarget * 3, worstLeg * 0.25) : scalpTarget;
  const estimatedCosts = entryFee + exitFee + slippage - fundingNet;
  const netPnl = comboPnl - estimatedCosts;
  return { entryFee, exitFee, slippage, fundingNet, estimatedCosts, profitTarget, closeTrigger: profitTarget + estimatedCosts, netPnl, makerRate: rates.maker, takerRate: rates.taker, recovery };
}
async function fundingSince(creds, row, startedAt) {
  let cursor = Number(startedAt || row.started_at || Date.now());
  let total = 0;
  for (let page = 0; page < 50; page += 1) {
    const income = await signedRequest(creds, 'GET', '/fapi/v1/income', {
      symbol: row.symbol, incomeType: 'FUNDING_FEE', startTime: String(cursor), limit: '1000',
    });
    const batch = Array.isArray(income) ? income : [];
    total += batch.reduce((sum, item) => sum + Number(item.income || 0), 0);
    if (batch.length < 1000) break;
    const next = Math.max(...batch.map((item) => Number(item.time || 0))) + 1;
    if (!(next > cursor)) break;
    cursor = next;
  }
  return total;
}
function allocateFundingCharge(fundingNet, longPnl, shortPnl) {
  const charge = Math.min(0, Number(fundingNet) || 0);
  if (!charge) return { long: 0, short: 0 };
  return Number(longPnl || 0) >= Number(shortPnl || 0) ? { long: charge, short: 0 } : { long: 0, short: charge };
}
async function legCostState(creds, row, leg, notional, pnl, fundingNet) {
  const rates = await commissionRates(creds, row.symbol);
  const entryFee = notional * rates.maker;
  const exitFee = notional * rates.maker;
  const estimatedCosts = entryFee + exitFee - fundingNet;
  const scalpTarget = scalpProfitTarget(notional);
  const worstLoss = Math.abs(Math.min(0, Number(leg.minPnl || 0)));
  const recovery = leg.recovery || worstLoss >= Math.max(5, notional * 0.002);
  const profitTarget = recovery ? Math.max(scalpTarget * 3, worstLoss * 0.25) : scalpTarget;
  const netPnl = pnl - estimatedCosts;
  return { entryFee, exitFee, slippage: 0, fundingNet, estimatedCosts, scalpTarget, profitTarget, closeTrigger: profitTarget + estimatedCosts, netPnl, recovery };
}
function profitGuardPrice(position, positionSide, costs) {
  const quantity = qty(position); const entryPrice = Number(position?.entryPrice || 0);
  if (!(quantity > 0) || !(entryPrice > 0)) return 0;
  const requiredGross = Math.max(0, Number(costs?.profitTarget || 0) + Number(costs?.estimatedCosts || 0));
  return positionSide === 'LONG' ? entryPrice + requiredGross / quantity : entryPrice - requiredGross / quantity;
}
async function closePositions(row, creds, pos) {
  const orders = [];
  try {
    if (qty(pos.long)) orders.push(await placeCloseMaker(creds, row, 'LONG', qty(pos.long)));
    if (qty(pos.short)) orders.push(await placeCloseMaker(creds, row, 'SHORT', qty(pos.short)));
    return orders;
  } catch (err) {
    if (orders.length) save(rowFor(row.user_id, row.symbol), { status: 'close_pending' }, { closeOrders: orders, closePlacedAt: Date.now() });
    throw err;
  }
}
async function placeCloseMaker(creds, row, positionSide, quantity, guardPrice = 0) {
  const rules = await symbolRules(row.symbol);
  const tick = Number(new Map((rules?.filters || []).map((f) => [f.filterType, f])).get('PRICE_FILTER')?.tickSize);
  if (!(tick > 0)) throw new Error('合约价格规则缺失');
  const side = positionSide === 'LONG' ? 'SELL' : 'BUY';
  const state = parseState(row);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const book = await publicGet('/fapi/v1/ticker/bookTicker', { symbol: row.symbol });
    const bid = Number(book.bidPrice); const ask = Number(book.askPrice);
    const offset = Math.max(tick * 2, (side === 'SELL' ? ask : bid) * SLIPPAGE_RATE) + tick * attempt;
    const marketPrice = side === 'SELL' ? ask + offset : bid - offset;
    const raw = guardPrice > 0 ? (side === 'SELL' ? Math.max(marketPrice, guardPrice) : Math.min(marketPrice, guardPrice)) : marketPrice;
    const price = stepped(raw, tick, side === 'SELL' ? 'ceil' : 'floor');
    const clientId = closeClientId(state.cycleId, positionSide);
    try {
      const order = await signedRequest(creds, 'POST', '/fapi/v1/order', {
        symbol: row.symbol, side, positionSide, type: 'LIMIT', timeInForce: 'GTX', price, quantity: String(quantity), newClientOrderId: clientId,
      });
      return { orderId: String(order.orderId), symbol: row.symbol, positionSide, side, price: Number(price), quantity: String(quantity), placedAt: Date.now(), guardPrice: Number(guardPrice) || 0 };
    } catch (err) {
      if (isPostOnlyReject(err) && attempt < 2) continue;
      if (!isPostOnlyReject(err)) {
        const order = await findOrderByClientId(creds, row.symbol, clientId);
        if (order) return { orderId: String(order.orderId), symbol: row.symbol, positionSide, side, price: Number(price), quantity: String(quantity), placedAt: Date.now(), guardPrice: Number(guardPrice) || 0 };
        return { orderId: null, clientOrderId: clientId, symbol: row.symbol, positionSide, side, price: Number(price), quantity: String(quantity),
          placedAt: Date.now(), guardPrice: Number(guardPrice) || 0, uncertain: true };
      }
      throw err;
    }
  }
  throw invalid('平仓 Maker 挂单连续被拒绝，请稍后重试', 503);
}
function closeOrderRemaining(order, current) {
  return Math.max(0, Number(order?.quantity || current?.origQty || 0) - Number(current?.executedQty || 0));
}
async function closeOrderProgress(creds, symbol, orders, fallbackBySide = {}) {
  let unresolved = false;
  const states = await Promise.all((orders || []).filter(Boolean).map(async (order) => {
    if (!order.uncertain) return { order, current: await orderState(creds, symbol, order) };
    const current = await findOrderByClientId(creds, symbol, order.clientOrderId, 1);
    if (current) return { order: { ...order, orderId: String(current.orderId), uncertain: false }, current };
    if (Date.now() - Number(order.placedAt || 0) < UNCERTAIN_ORDER_WAIT_MS) unresolved = true;
    return { order, current: { status: 'NOT_FOUND', executedQty: '0', origQty: order.quantity, positionSide: order.positionSide } };
  }));
  const rows = states.map(({ order, current }) => ({
    positionSide: String(order.positionSide || current.positionSide || ''),
    remaining: closeOrderRemaining(order, current),
  }));
  const remainingBySide = rows.reduce((map, item) => map.set(item.positionSide, (map.get(item.positionSide) || 0) + item.remaining), new Map());
  for (const side of ['LONG', 'SHORT']) if (!remainingBySide.has(side)) remainingBySide.set(side, Number(fallbackBySide?.[side] || 0));
  return { complete: !unresolved && [...remainingBySide.values()].every((remaining) => closeEnough(remaining, 0)), remainingBySide,
    unresolved, orders: states.map(({ order }) => order) };
}
function closeTargetsFromOrders(orders) {
  return (orders || []).reduce((targets, order) => {
    const side = String(order.positionSide || '');
    targets[side] = (targets[side] || 0) + Number(order.quantity || 0);
    return targets;
  }, { LONG: 0, SHORT: 0 });
}
async function replaceCloseOrders(row, creds, orders, positionSide = null, guardPrice = 0, fallbackBySide = {}) {
  const prior = (orders || []).filter(Boolean);
  const beforeCancel = await closeOrderProgress(creds, row.symbol, prior, fallbackBySide);
  if (beforeCancel.unresolved) return { orders: beforeCancel.orders, waiting: true };
  for (const order of prior) await cancelOrder(creds, row.symbol, order);
  const open = await signedRequest(creds, 'GET', '/fapi/v1/openOrders', { symbol: row.symbol });
  const priorIds = new Set(prior.map((order) => String(order.orderId)));
  if ((Array.isArray(open) ? open : []).some((order) => priorIds.has(String(order.orderId)))) {
    throw new Error('旧平仓单尚未确认撤销，本轮不提交新平仓单');
  }
  const progress = await closeOrderProgress(creds, row.symbol, prior, fallbackBySide);
  const risk = await signedRequest(creds, 'GET', '/fapi/v2/positionRisk', { symbol: row.symbol });
  const pos = positionsOf(risk, row.symbol);
  if (positionSide) {
    const position = positionSide === 'LONG' ? pos.long : pos.short;
    const remaining = Math.min(qty(position), Number(progress.remainingBySide.get(positionSide) || 0));
    if (!(remaining > 0)) return { orders: [], waiting: false };
    return { orders: [await placeCloseMaker(creds, row, positionSide, remaining, guardPrice)], waiting: false };
  }
  const replacements = [];
  for (const [side, position] of [['LONG', pos.long], ['SHORT', pos.short]]) {
    const remaining = Math.min(qty(position), Number(progress.remainingBySide.get(side) || 0));
    if (remaining > 0) replacements.push(await placeCloseMaker(creds, row, side, remaining));
  }
  return { orders: replacements, waiting: false };
}
async function strategyQuantitiesForClose(creds, row, state) {
  let long = Number(state.expectedLong || 0); let short = Number(state.expectedShort || 0);
  const read = async (order) => {
    if (!order) return null;
    try { return order.orderId ? await orderState(creds, row.symbol, order) : await findOrderByClientId(creds, row.symbol, order.clientOrderId, 1); }
    catch { return null; }
  };
  if (row.status === 'entry_pending') {
    long = 0; short = 0;
    const entries = (state.entries || []).length < 2 ? await recoverBaseOrders(creds, row, state) : state.entries;
    for (const order of entries) {
      const current = await read(order); const filled = Number(current?.executedQty || 0);
      if (String(current?.side || order.side) === 'BUY') long += filled;
      if (String(current?.side || order.side) === 'SELL') short += filled;
    }
  }
  if (row.status === 'add_pending' && state.pending) {
    const current = await read(state.pending); const filled = Number(current?.executedQty || 0);
    if (state.pending.side === 'BUY') long += filled; else short += filled;
  }
  const longLeg = legSnapshot(state, 'long'); const shortLeg = legSnapshot(state, 'short');
  if (longLeg.phase === 'reentry_pending') long = Number((await read(longLeg.reentryOrder))?.executedQty || 0);
  if (shortLeg.phase === 'reentry_pending') short = Number((await read(shortLeg.reentryOrder))?.executedQty || 0);
  return { long, short };
}
async function closeAll(userId) {
  const creds = getBinanceCredentialsForUser(userId);
  if (!creds) throw invalid('请先在 API 设置中配置币安 API 密钥');
  const rows = getDb().prepare("SELECT * FROM tradfi_range_strategies WHERE user_id=? AND enabled=1 AND symbol IN ('XAUUSDT','XAGUSDT')").all(String(userId));
  const submitted = [];
  for (const row of rows) {
    if (row.status === 'close_pending') continue;
    const state = parseState(row);
    await cancelKnown(creds, row.symbol, state);
    await cancelOpenCloses(creds, row.symbol);
    const risk = await signedRequest(creds, 'GET', '/fapi/v2/positionRisk', { symbol: row.symbol });
    const pos = positionsOf(risk, row.symbol);
    const strategyQty = await strategyQuantitiesForClose(creds, row, state);
    const longQty = Math.min(qty(pos.long), strategyQty.long);
    const shortQty = Math.min(qty(pos.short), strategyQty.short);
    const closeRemaining = { LONG: longQty, SHORT: shortQty };
    save(row, { enabled: 1, status: 'close_pending', last_error: '' }, { pending: null, entries: [], closeOrders: [], closeRemaining, closePlacedAt: Date.now(), stopAfterClose: true });
    const orders = []; let submissionError = null;
    for (const [side, quantity] of [['LONG', longQty], ['SHORT', shortQty]]) {
      if (!(quantity > 0)) continue;
      try {
        orders.push(await placeCloseMaker(creds, row, side, quantity));
        save(rowFor(row.user_id, row.symbol), { enabled: 1, status: 'close_pending', last_error: '' }, { closeOrders: [...orders], closeRemaining, closePlacedAt: Date.now(), stopAfterClose: true });
      } catch (err) {
        submissionError = submissionError || err;
        save(rowFor(row.user_id, row.symbol), { enabled: 1, status: 'close_pending', last_error: err.message }, { closeOrders: [...orders], closeRemaining, closePlacedAt: 0, stopAfterClose: true });
        log(userId, row.symbol, `${side === 'LONG' ? '多头' : '空头'}一键平仓提交失败：${err.message}`, 'error');
      }
    }
    if (orders.length) {
      submitted.push(...orders);
      log(userId, row.symbol, `一键平仓已提交 ${orders.length} 笔 Maker 限价单`, 'trade', { orders, offsetRate: SLIPPAGE_RATE });
    }
    if (submissionError) {
      save(rowFor(row.user_id, row.symbol), { enabled: 1, status: 'close_pending', last_error: submissionError.message }, { closeOrders: [...orders], closeRemaining, closePlacedAt: 0, stopAfterClose: true });
      throw submissionError;
    }
  }
  return { submitted };
}
function finishClose(row, stopped) {
  save(row, { enabled: stopped ? 0 : row.enabled, status: stopped ? 'paused' : 'waiting', additions: 0 }, {
    entries: [], pending: null, closeOrders: [], closeRemaining: { LONG: 0, SHORT: 0 }, stopAfterClose: false, longAdditions: 0, shortAdditions: 0,
    expectedLong: 0, expectedShort: 0, comboPnl: 0, recovery: false, recoveryArmed: false,
    recoveryPeakNetPnl: 0, recoveryTrail: 0, cooldownUntil: Date.now() + COOLDOWN_MS,
  });
  log(row.user_id, row.symbol, stopped ? '一键平仓已全部成交，策略已停止' : 'Maker 平仓已成交，10 秒后检查下一轮开仓', 'success');
}
async function reconcileRow(row) {
  const creds = getBinanceCredentialsForUser(row.user_id);
  if (!creds || Number(creds.simulated) !== Number(row.simulated)) throw new Error('币安密钥缺失或交易环境已变化');
  let state = parseState(row);
  if (isCommodityWeekendMode()) {
    if (row.status === 'close_pending' && state.stopAfterClose) {
      const progress = await closeOrderProgress(creds, row.symbol, state.closeOrders || [], state.closeRemaining || {});
      if (progress.complete) finishClose(row, true);
      else if (!state.weekendMode) save(row, {}, { weekendMode: true });
      return;
    }
    if (!state.weekendMode) {
      await pauseWeekendNewOrders(row, creds, state);
    }
    return;
  }
  if (state.weekendMode) {
    save(row, {}, { weekendMode: false });
    log(row.user_id, row.symbol, '常规交易时段已恢复，震荡策略继续执行', 'success');
    row = rowFor(row.user_id, row.symbol);
    state = parseState(row);
  }
  const market = await snapshot(row.symbol);
  save(row, {}, { lastPrice: market.last, addStep: market.addStep, range: market.range });
  if (row.status === 'waiting') {
    if (state.cooldownUntil && Date.now() < state.cooldownUntil) return;
    if (market.rangeReady) await startCycle(row, creds, market);
    return;
  }
  if (row.status === 'entry_pending') {
    const entries = (state.entries || []).length < 2 ? await recoverBaseOrders(creds, row, state) : state.entries;
    if (entries.length !== (state.entries || []).length) save(row, {}, { entries });
    const states = await Promise.all(entries.map((o) => orderState(creds, row.symbol, o)));
    if (states.length === 2 && states.every((o) => o.status === 'FILLED')) {
      const expectedLong = Number(states[0].executedQty); const expectedShort = Number(states[1].executedQty);
      save(row, { status: 'active' }, { expectedLong, expectedShort, entries: [], lastAddPrice: market.last,
        ...resetLeg('long', expectedLong, market.last), ...resetLeg('short', expectedShort, market.last) });
      log(row.user_id, row.symbol, '双向底仓已成交，进入震荡管理', 'trade'); return;
    }
    if (Date.now() < Number(state.entryDeadline || 0)) return;
    await cancelKnown(creds, row.symbol, { ...state, entries });
    const risk = await signedRequest(creds, 'GET', '/fapi/v2/positionRisk', { symbol: row.symbol });
    const pos = positionsOf(risk, row.symbol);
    if (qty(pos.long) || qty(pos.short)) {
      const closeOrders = await closePositions(row, creds, pos);
      save(row, { status: 'close_pending' }, { entries: [], closeOrders, closeReason: '底仓未同时成交', closePlacedAt: Date.now() });
      log(row.user_id, row.symbol, '双向底仓未能同时成交，已提交 Maker 平仓单', 'warn'); return;
    }
    save(row, { status: 'waiting' }, { entries: [], cooldownUntil: Date.now() + COOLDOWN_MS }); return;
  }
  if (row.status === 'close_pending') {
    const risk = await signedRequest(creds, 'GET', '/fapi/v2/positionRisk', { symbol: row.symbol });
    const pos = positionsOf(risk, row.symbol);
    const stopped = Boolean(state.stopAfterClose);
    const closeComplete = stopped ? (await closeOrderProgress(creds, row.symbol, state.closeOrders || [], state.closeRemaining || {})).complete : !qty(pos.long) && !qty(pos.short);
    if (closeComplete) { finishClose(row, stopped); return; }
    if (Date.now() - Number(state.closePlacedAt || 0) >= ORDER_TTL_MS) {
      const replacement = await replaceCloseOrders(row, creds, state.closeOrders || [], null, 0, state.closeRemaining || {});
      if (replacement.waiting) { save(row, {}, { closeOrders: replacement.orders }); return; }
      const closeOrders = replacement.orders;
      save(row, {}, { closeOrders, closeRemaining: closeTargetsFromOrders(closeOrders), closePlacedAt: Date.now() });
      log(row.user_id, row.symbol, 'Maker 平仓单未成交，已按最新盘口重新挂单', 'warn');
    }
    return;
  }
  const risk = await signedRequest(creds, 'GET', '/fapi/v2/positionRisk', { symbol: row.symbol });
  const pos = positionsOf(risk, row.symbol);
  const longLeg = legSnapshot(state, 'long'); const shortLeg = legSnapshot(state, 'short');
  // A winning leg is closed and rebuilt independently. During that short
  // transition, its zero quantity is expected and must not trigger manual mode.
  for (const [side, leg, position] of [['LONG', longLeg, pos.long], ['SHORT', shortLeg, pos.short]]) {
    const direction = legName(side); const orderSide = side === 'LONG' ? 'BUY' : 'SELL';
    if (leg.phase === 'close_pending') {
      if (!qty(position)) {
        save(row, {}, { ...legPatch(direction, { Phase: 'reentry_wait', CloseOrders: [], ReentryAt: Date.now() + COOLDOWN_MS }) });
        log(row.user_id, row.symbol, `${side === 'LONG' ? '多头' : '空头'}止盈已成交，10 秒后重建同方向底仓`, 'success'); return;
      }
      if (Date.now() - leg.closePlacedAt >= ORDER_TTL_MS) {
        const replacement = await replaceCloseOrders(row, creds, leg.closeOrders || [], side, leg.closeGuardPrice);
        if (replacement.waiting) { save(row, {}, { ...legPatch(direction, { CloseOrders: replacement.orders }) }); return; }
        const closeOrders = replacement.orders;
        if (!closeOrders.length) {
          save(row, {}, { ...legPatch(direction, { Phase: 'reentry_wait', CloseOrders: [], ReentryAt: Date.now() + COOLDOWN_MS }) });
          log(row.user_id, row.symbol, `${side === 'LONG' ? '多头' : '空头'}止盈已成交，10 秒后重建同方向底仓`, 'success'); return;
        }
        save(row, {}, { ...legPatch(direction, { CloseOrders: closeOrders, ClosePlacedAt: Date.now() }) });
        log(row.user_id, row.symbol, `${side === 'LONG' ? '多头' : '空头'}止盈 Maker 单未成交，已重新挂单`, 'warn'); return;
      }
      return;
    }
    if (leg.phase === 'reentry_wait') {
      if (Date.now() < leg.reentryAt) return;
      const order = await placeLimit(creds, row, orderSide, side === 'LONG' ? market.bid : market.ask, `roll_${direction}`);
      save(row, {}, { ...legPatch(direction, { Phase: 'reentry_pending', ReentryOrder: order }) });
      log(row.user_id, row.symbol, `已提交${side === 'LONG' ? '多头' : '空头'}滚动底仓`, 'trade'); return;
    }
    if (leg.phase === 'reentry_pending') {
      const current = await orderState(creds, row.symbol, leg.reentryOrder);
      if (current.status === 'FILLED') {
        const filled = Number(current.executedQty || 0);
        const patch = { ...resetLeg(direction, filled, Number(current.avgPrice || leg.reentryOrder.price || market.last)),
          ...(side === 'LONG' ? { expectedLong: filled } : { expectedShort: filled }) };
        save(row, { additions: sideAdditions({ ...state, ...patch }).longAdditions + sideAdditions({ ...state, ...patch }).shortAdditions }, patch);
        log(row.user_id, row.symbol, `${side === 'LONG' ? '多头' : '空头'}新底仓已成交，开始新的单边周期`, 'trade'); return;
      }
      if (Date.now() - Number(leg.reentryOrder?.placedAt || 0) >= ORDER_TTL_MS) {
        await cancelOrder(creds, row.symbol, leg.reentryOrder);
        const latest = await orderState(creds, row.symbol, leg.reentryOrder);
        const filled = Number(latest.executedQty || 0);
        if (filled > 0) {
          const patch = { ...resetLeg(direction, filled, Number(latest.avgPrice || leg.reentryOrder.price || market.last)),
            ...(side === 'LONG' ? { expectedLong: filled } : { expectedShort: filled }) };
          save(row, { additions: sideAdditions({ ...state, ...patch }).longAdditions + sideAdditions({ ...state, ...patch }).shortAdditions }, patch);
          log(row.user_id, row.symbol, `${side === 'LONG' ? '多头' : '空头'}滚动底仓${latest.status === 'FILLED' ? '已成交' : '部分成交，剩余已撤销'}，按实际数量进入新周期`, 'trade');
        } else {
          save(row, {}, { ...legPatch(direction, { Phase: 'reentry_wait', ReentryOrder: null, ReentryAt: Date.now() + COOLDOWN_MS }) });
        }
      }
      return;
    }
  }
  if (!qty(pos.long) || !qty(pos.short)) throw invalid('检测到手动修改仓位，策略转人工接管', 409);
  if (row.status === 'add_pending' && state.pending) {
    const current = await orderState(creds, row.symbol, state.pending);
    if (current.status === 'FILLED') {
      const filled = Number(current.executedQty); const isLong = state.pending.side === 'BUY';
      const counted = countedAdditions(state, isLong, true);
      const direction = isLong ? 'long' : 'short'; const nextQty = (isLong ? longLeg.expectedQty : shortLeg.expectedQty) + filled;
      save(row, { status: 'active', additions: counted.total }, { pending: null, longAdditions: counted.longAdditions, shortAdditions: counted.shortAdditions, expectedLong: state.expectedLong + (isLong ? filled : 0), expectedShort: state.expectedShort + (isLong ? 0 : filled), lastAddPrice: Number(current.avgPrice || state.pending.price), ...legPatch(direction, { ExpectedQty: nextQty, Additions: counted.next, LastAddPrice: Number(current.avgPrice || state.pending.price) }) });
      log(row.user_id, row.symbol, `${isLong ? '多头' : '空头'}第 ${counted.next}/${MAX_ADDITIONS} 档补仓已成交`, 'trade', { side: state.pending.side, quantity: filled, longAdditions: counted.longAdditions, shortAdditions: counted.shortAdditions }); return;
    }
    if (Date.now() - state.pending.placedAt > ORDER_TTL_MS) {
      await cancelOrder(creds, row.symbol, state.pending);
      const latestOrder = await orderState(creds, row.symbol, state.pending);
      const filled = Number(latestOrder.executedQty || 0); const isLong = state.pending.side === 'BUY';
      const counted = countedAdditions(state, isLong, filled > 0);
      const direction = isLong ? 'long' : 'short'; const nextQty = (isLong ? longLeg.expectedQty : shortLeg.expectedQty) + filled;
      save(row, { status: 'active', additions: counted.total }, { pending: null, longAdditions: counted.longAdditions, shortAdditions: counted.shortAdditions,
        expectedLong: state.expectedLong + (isLong ? filled : 0), expectedShort: state.expectedShort + (isLong ? 0 : filled),
        lastAddPrice: filled > 0 ? Number(latestOrder.avgPrice || state.pending.price) : state.lastAddPrice, ...legPatch(direction, { ExpectedQty: nextQty, Additions: counted.next, LastAddPrice: filled > 0 ? Number(latestOrder.avgPrice || state.pending.price) : (isLong ? longLeg.lastAddPrice : shortLeg.lastAddPrice) }) });
      if (filled > 0) log(row.user_id, row.symbol, `${isLong ? '多头' : '空头'}第 ${counted.next}/${MAX_ADDITIONS} 档补仓部分成交，剩余已撤销`, 'trade', { side: state.pending.side, quantity: filled });
    }
    return;
  }
  if (!closeEnough(qty(pos.long), longLeg.expectedQty) || !closeEnough(qty(pos.short), shortLeg.expectedQty)) throw invalid('检测到手动修改仓位，策略转人工接管', 409);
  const comboPnl = Number(pos.long.unRealizedProfit || 0) + Number(pos.short.unRealizedProfit || 0);
  const longNotional = Math.abs(Number(pos.long.notional || 0)); const shortNotional = Math.abs(Number(pos.short.notional || 0));
  const nextLong = { ...longLeg, minPnl: Math.min(longLeg.minPnl, Number(pos.long.unRealizedProfit || 0)) };
  const nextShort = { ...shortLeg, minPnl: Math.min(shortLeg.minPnl, Number(pos.short.unRealizedProfit || 0)) };
  // Binance reports hedge-mode funding at symbol level, so charge it once to
  // the leg that is currently closest to being closed. A failed funding query
  // aborts this pass instead of incorrectly treating an unknown charge as zero.
  const fundingRaw = await fundingSince(creds, row, state.fundingStartedAt || state.cycleStartedAt);
  const funding = allocateFundingCharge(fundingRaw, pos.long.unRealizedProfit, pos.short.unRealizedProfit);
  const longCosts = await legCostState(creds, row, nextLong, longNotional, Number(pos.long.unRealizedProfit || 0), funding.long);
  const shortCosts = await legCostState(creds, row, nextShort, shortNotional, Number(pos.short.unRealizedProfit || 0), funding.short);
  const legUpdates = {};
  for (const [side, leg, position, costs] of [['LONG', nextLong, pos.long, longCosts], ['SHORT', nextShort, pos.short, shortCosts]]) {
    const direction = legName(side); const recovery = costs.recovery;
    const peak = recovery ? Math.max(leg.recoveryPeakNetPnl, costs.netPnl) : 0;
    const armed = recovery && peak >= costs.profitTarget;
    const trail = recovery ? Math.max(1.5, qty(position) * Number(market.atr || 0) * 1.2) : 0;
    const exit = recoveryExitState({ recovery, armed, netPnl: costs.netPnl, peakNetPnl: peak, trail, trend: market.trend, target: costs.profitTarget });
    const shouldClose = recovery ? exit.shouldClose : costs.netPnl >= costs.profitTarget;
    const patch = { ...legPatch(direction, { MinPnl: leg.minPnl, Recovery: recovery, RecoveryArmed: armed, RecoveryPeakNetPnl: peak, RecoveryTrail: trail }), [`${direction}Costs`]: costs };
    Object.assign(legUpdates, patch);
    if (shouldClose) {
      await cancelKnown(creds, row.symbol, state);
      const guardPrice = profitGuardPrice(position, side, costs);
      const order = await placeCloseMaker(creds, row, side, qty(position), guardPrice);
      const reason = recovery ? exit.reason : '单边净盈利达到目标';
      save(row, {}, { ...legUpdates, ...legPatch(direction, { Phase: 'close_pending', CloseOrders: [order], ClosePlacedAt: Date.now(), CloseGuardPrice: guardPrice }), fundingStartedAt: Date.now(), comboPnl, netPnl: longCosts.netPnl + shortCosts.netPnl, costs: { long: longCosts, short: shortCosts } });
      log(row.user_id, row.symbol, `${side === 'LONG' ? '多头' : '空头'}${reason}，已提交 Maker 止盈单（预估净利 ${costs.netPnl.toFixed(2)}U）`, 'success', costs); return;
    }
  }
  save(row, {}, { ...legUpdates, comboPnl, netPnl: longCosts.netPnl + shortCosts.netPnl, costs: { long: longCosts, short: shortCosts } });
  if (nextLong.recovery && market.trend || nextShort.recovery && market.trend) return;
  if (market.trend) throw invalid('震荡结构已转为明显趋势，策略转人工接管', 409);
  const step = market.addStep;
  const longLosing = Number(pos.long.unRealizedProfit || 0) < Number(pos.short.unRealizedProfit || 0);
  const anchor = Number((longLosing ? longLeg.lastAddPrice : shortLeg.lastAddPrice) || market.last);
  const decision = additionDecision(state, longLosing);
  const trigger = longLosing ? market.last <= anchor - step : market.last >= anchor + step;
  if (!trigger) return;
  if (decision.action === 'manual') throw invalid('多空两侧都已达到20次自动补仓上限，策略转人工接管', 409);
  if (decision.action === 'wait') return;
  const side = longLosing ? 'BUY' : 'SELL'; const price = longLosing ? market.bid : market.ask;
  const pending = await placeLimit(creds, row, side, price, `${longLosing ? 'l' : 's'}${decision.next}`);
  save(row, { status: 'add_pending' }, { pending });
  log(row.user_id, row.symbol, `已提交${longLosing ? '多头' : '空头'}第 ${decision.next}/${MAX_ADDITIONS} 档补仓`, 'trade', { price, step, longAdditions: decision.longAdditions, shortAdditions: decision.shortAdditions });
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

module.exports = { start, reconcile, status, enable, disable, closeAll, closeClientId, closeOrderRemaining, additionDecision, marketState, atr, ladderStep, costState, scalpProfitTarget, commissionRate, isCommodityWeekendMode, orderFillState, profitGuardPrice, allocateFundingCharge, strategyConfig, requestedConfig, isPostOnlyReject, isRequestTimeout, recoveryExitState, SYMBOLS, MAX_ADDITIONS, MARGIN, LEVERAGE, MAX_MARGIN, MAX_LEVERAGE };
