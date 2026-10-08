const crypto = require('node:crypto');
const { getDb } = require('./db');
const { getBinanceCredentialsForUser } = require('./userExchangeKeys');
const { signedRequest, publicGet, symbolRules, stepped } = require('./binanceTradfiTrade');
const { recordBinanceAiOrder } = require('./binanceAiLedger');
const STRATEGY_CORE = require('./tradfiRangeCore.cjs');
const { MAX_LONG_ADDITIONS, MAX_SHORT_ADDITIONS, SYMBOL_DEFAULTS, MIN_STEP_PCT, MAX_STEP_PCT,
  SPARSE_MAX_STEP_PCT, ATR_MULTIPLIER, SPARSE_ATR_MULTIPLIER, SPARSE_NORMAL_STEP_MULTIPLIER,
  SPARSE_GROUP_SIZE, SPARSE_ENTER_ATR_DISTANCE, SPARSE_EXIT_ATR_DISTANCE, TREND_CONFIRM_BARS,
  SCALP_MIN_PROFIT, SCALP_NOTIONAL_RATE, clamp, atr, defaultConfig, ladderMargin, sideAdditions,
  additionDecision, countedAdditions, ladderStep, sparseLadderStep, sparseModeDecision, sparseGroupCount, sparseSinglePlan,
  sparseGroupMargin, sparseGroupTrigger, shortTrendProtectionDecision, overheatStateStep, overheatShortPlan, peakLargeMarginPlan,
  historicalSupportZone, deferredLongFill,
  deepLongZone, deepLongBudget, deepLongStageSignal,
  turningPointStep, turningPointOpportunity, turningPointEntryPlan, turningPointRiskDecision,
  shouldPlaceAddition, ordinaryAdditionDue, canManualAddPosition, marketState, scalpProfitTarget, recoveryExitState, longRecoveryExitState, shouldCancelTakeProfit } = STRATEGY_CORE;

const SYMBOLS = new Set(['XAUUSDT', 'XAGUSDT']);
// Legacy drain mode is unconditional: new emotion research must never restart a grid.
const LEGACY_DRAIN_ONLY = true;
const MARGIN = 10;
const LEVERAGE = 10;
const MAX_MARGIN = 20;
const MAX_GOLD_MARGIN = 100;
const MAX_LEVERAGE = 50;
// Kept as the largest per-side cap for older callers.
const MAX_ADDITIONS = MAX_LONG_ADDITIONS;
// 高频止盈检查与补仓触发；平仓后的下一轮仍由 COOLDOWN_MS 控制为 10 秒。
const POLL_MS = 3_000;
const ORDER_TTL_MS = 90_000;
const COOLDOWN_MS = 10_000;
const DEFAULT_MAKER_FEE = 0.0002;
const DEFAULT_TAKER_FEE = 0.0005;
const SLIPPAGE_RATE = 0.0001;
const UNCERTAIN_ORDER_WAIT_MS = 30_000;
const MAX_15M_CANDLE_AGE_MS = 30 * 60_000;
const MAX_1H_CANDLE_AGE_MS = 2 * 60 * 60_000;
const feeCache = new Map();
let timer = null;
let busy = false;
const activeRows = new Set();
const lockedRows = new Set();

function invalid(message, status = 400) { return Object.assign(new Error(message), { status }); }
function adoptionRequired(positions) {
  return Object.assign(new Error('检测到来源不明确的现有仓位，请确认是否交由策略接管'), { status: 409, adoptionRequired: true, positions });
}
function isPostOnlyReject(error) { return Number(error?.code) === -5022 || /Post Only|could not be executed as maker/i.test(error?.message || ''); }
function commissionRate(value, fallback) {
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 ? rate : fallback;
}
const isCommodityWeekendMode = STRATEGY_CORE.isCommodityWeekendMode;
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
  const defaults = defaultConfig(row?.symbol);
  return {
    marginUsdt: Number.isFinite(marginUsdt) && marginUsdt > 0 ? marginUsdt : defaults.marginUsdt,
    leverage: Number.isInteger(leverage) && leverage > 0 ? leverage : defaults.leverage,
  };
}
function requestedConfig(input = {}, symbol = input.symbol) {
  const defaults = defaultConfig(symbol);
  const maxMargin = String(symbol || '').toUpperCase() === 'XAUUSDT' ? MAX_GOLD_MARGIN : MAX_MARGIN;
  const marginUsdt = Number(input.marginUsdt ?? defaults.marginUsdt);
  const leverage = Number(input.leverage ?? defaults.leverage);
  if (!Number.isFinite(marginUsdt) || marginUsdt <= 0 || marginUsdt > maxMargin) throw invalid(`单边保证金需在 0–${maxMargin} USDT 之间`);
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > MAX_LEVERAGE) throw invalid(`杠杆需在 1–${MAX_LEVERAGE} 倍之间`);
  return { marginUsdt, leverage };
}
function resumedConfig(current, input = {}, symbol = input.symbol || 'XAGUSDT') {
  const saved = current || { marginUsdt: MARGIN, leverage: LEVERAGE };
  return requestedConfig({
    marginUsdt: input.marginUsdt ?? saved.marginUsdt,
    leverage: saved.leverage,
  }, symbol);
}
function log(userId, symbol, message, level = 'info', details = {}) {
  getDb().prepare('INSERT INTO tradfi_range_events (user_id,symbol,level,message,details_json,created_at) VALUES (?,?,?,?,?,?)')
    .run(String(userId), symbol, level, message, JSON.stringify(details), Date.now());
}
function save(row, patch = {}, statePatch = null, allowExplicitResume = false) {
  // An in-flight reconcile may finish after the user stops the strategy. Never
  // let its stale row snapshot write the strategy back to enabled=1.
  const current = rowFor(row.user_id, row.symbol);
  if (!allowExplicitResume && ignoreStaleStrategySave(current, patch)) return;
  const state = statePatch == null ? parseState(row) : { ...parseState(row), ...statePatch };
  getDb().prepare(`UPDATE tradfi_range_strategies SET enabled=?,status=?,simulated=?,additions=?,state_json=?,last_error=?,started_at=?,updated_at=? WHERE user_id=? AND symbol=?`)
    .run(patch.enabled ?? row.enabled, patch.status ?? row.status, patch.simulated ?? row.simulated,
      patch.additions ?? row.additions, JSON.stringify(state), patch.last_error ?? row.last_error,
      patch.started_at ?? row.started_at, Date.now(), row.user_id, row.symbol);
}
function ignoreStaleStrategySave(current, patch = {}) {
  return Boolean(current && !current.enabled && patch.enabled !== 0);
}
function rowFor(userId, symbol) {
  return getDb().prepare('SELECT * FROM tradfi_range_strategies WHERE user_id=? AND symbol=?').get(String(userId), cleanSymbol(symbol));
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
function pendingForSide(state, side) {
  const key = side === 'long' ? 'pendingLong' : 'pendingShort';
  const stored = state?.[key];
  if (stored) return stored;
  const legacy = state?.pending;
  if (!legacy || legacy.kind === 'manual') return null;
  const direction = legacy.direction || (legacy.side === 'BUY' ? 'long' : 'short');
  return direction === side ? legacy : null;
}
function autoPendingOrders(state) {
  const found = [pendingForSide(state, 'long'), pendingForSide(state, 'short')].filter(Boolean);
  return [...new Map(found.map((order) => [String(order.orderId || order.clientOrderId || order.clientId), order])).values()];
}
function hasAutoPending(state) { return autoPendingOrders(state).length > 0; }
function pendingStatePatch(state, side, order) {
  return { pending: null,
    pendingLong: side === 'long' ? (order || null) : pendingForSide(state, 'long'),
    pendingShort: side === 'short' ? (order || null) : pendingForSide(state, 'short') };
}
function availableAdditionDirection(state, preferred, longCanAdd, shortCanAdd, longPnl, shortPnl) {
  const other = preferred === 'long' ? 'short' : 'long';
  if (!pendingForSide(state, preferred)) return preferred;
  const otherCanAdd = other === 'long' ? longCanAdd : shortCanAdd;
  const otherPnl = other === 'long' ? Number(longPnl) : Number(shortPnl);
  if (!pendingForSide(state, other) && otherCanAdd && otherPnl < 0
    && additionDecision(state, other === 'long').action === 'add') return other;
  return null;
}
function legSnapshot(state, side) {
  const isLong = legName(side) === 'long';
  return {
    phase: legValue(state, side, 'Phase', 'active'),
    additions: Number(legValue(state, side, 'Additions', 0)) || 0,
    manualMarginUsdt: Number(legValue(state, side, 'ManualMarginUsdt', 0)) || 0,
    expectedQty: Number(legValue(state, side, 'ExpectedQty', isLong ? state?.expectedLong : state?.expectedShort)) || 0,
    lastAddPrice: Number(legValue(state, side, 'LastAddPrice', state?.lastAddPrice)) || 0,
    minPnl: Number(legValue(state, side, 'MinPnl', isLong ? state?.minLongPnl : state?.minShortPnl)) || 0,
    recovery: Boolean(legValue(state, side, 'Recovery', false)),
    recoveryArmed: Boolean(legValue(state, side, 'RecoveryArmed', false)),
    recoveryPeakNetPnl: Number(legValue(state, side, 'RecoveryPeakNetPnl', 0)) || 0,
    recoveryTrail: Number(legValue(state, side, 'RecoveryTrail', 0)) || 0,
    recoveryExitVersion: Number(legValue(state, side, 'RecoveryExitVersion', 0)) || 0,
    sparseMode: Boolean(legValue(state, side, 'SparseMode', false)),
    sparseSince: Number(legValue(state, side, 'SparseSince', 0)) || 0,
    sparseStep: Number(legValue(state, side, 'SparseStep', 0)) || 0,
    sparseDistanceAtr: Number(legValue(state, side, 'SparseDistanceAtr', 0)) || 0,
    sparseEntryPrice: Number(legValue(state, side, 'SparseEntryPrice', 0)) || 0,
    addBlockReason: String(legValue(state, side, 'AddBlockReason', '') || ''),
    addBlockDetails: legValue(state, side, 'AddBlockDetails', null),
    closeOrders: legValue(state, side, 'CloseOrders', []),
    closePlacedAt: Number(legValue(state, side, 'ClosePlacedAt', 0)) || 0,
    closeGuardPrice: Number(legValue(state, side, 'CloseGuardPrice', 0)) || 0,
    fundingStartedAt: Number(legValue(state, side, 'FundingStartedAt', state?.cycleStartedAt)) || 0,
    syncedManualQty: Number(legValue(state, side, 'SyncedManualQty', 0)) || 0,
    syncedManualMarginUsdt: Number(legValue(state, side, 'SyncedManualMarginUsdt', 0)) || 0,
    reentryAt: Number(legValue(state, side, 'ReentryAt', 0)) || 0,
    reentryOrder: legValue(state, side, 'ReentryOrder', null),
  };
}
function resetLeg(side, expectedQty, lastAddPrice) {
  return legPatch(side, { Phase: 'active', Additions: 0, ManualMarginUsdt: 0, ExpectedQty: expectedQty, LastAddPrice: lastAddPrice, MinPnl: 0,
    Recovery: false, RecoveryArmed: false, RecoveryPeakNetPnl: 0, RecoveryTrail: 0, RecoveryExitVersion: 1, SparseMode: false, SparseSince: 0, SparseStep: 0, CloseOrders: [], ClosePlacedAt: 0,
    CloseGuardPrice: 0, SyncedManualQty: 0, SyncedManualMarginUsdt: 0, FundingStartedAt: Date.now(), ReentryAt: 0, ReentryOrder: null });
}
function publicRow(row) {
  if (!row) return null;
  const s = parseState(row);
  const config = strategyConfig(row);
  const counts = sideAdditions(s);
  return { symbol: row.symbol, legacyRetired: LEGACY_DRAIN_ONLY, enabled: Boolean(row.enabled), status: row.status, simulated: Boolean(row.simulated),
    additions: counts.longAdditions + counts.shortAdditions, longAdditions: counts.longAdditions, shortAdditions: counts.shortAdditions,
    maxAdditions: MAX_ADDITIONS, maxLongAdditions: MAX_LONG_ADDITIONS, maxShortAdditions: MAX_SHORT_ADDITIONS,
    maxTotalAdditions: MAX_LONG_ADDITIONS + MAX_SHORT_ADDITIONS,
    manualAddPending: Boolean(s.manualPending) || s.pending?.kind === 'manual',
    pendingSparse: Boolean(s.pending?.sparse || pendingForSide(s, 'long')?.sparse || pendingForSide(s, 'short')?.sparse),
    pendingDirection: s.pending?.direction || (pendingForSide(s, 'long') ? 'long' : pendingForSide(s, 'short') ? 'short' : null),
    pendingTierStart: (s.pending || pendingForSide(s, 'long') || pendingForSide(s, 'short'))?.tierStart ?? null,
    pendingTierEnd: (s.pending || pendingForSide(s, 'long') || pendingForSide(s, 'short'))?.tierEnd ?? null,
    pendingTriggerPrice: (s.pending || pendingForSide(s, 'long') || pendingForSide(s, 'short'))?.triggerPrice ?? null,
    pendingLongSparse: Boolean(pendingForSide(s, 'long')?.sparse),
    pendingLongTierStart: pendingForSide(s, 'long')?.tierStart ?? null,
    pendingLongTierEnd: pendingForSide(s, 'long')?.tierEnd ?? null,
    pendingLongTriggerPrice: pendingForSide(s, 'long')?.triggerPrice ?? null,
    pendingShortSparse: Boolean(pendingForSide(s, 'short')?.sparse),
    pendingShortTierStart: pendingForSide(s, 'short')?.tierStart ?? null,
    pendingShortTierEnd: pendingForSide(s, 'short')?.tierEnd ?? null,
    pendingShortTriggerPrice: pendingForSide(s, 'short')?.triggerPrice ?? null,
    pendingLongOrder: Boolean(pendingForSide(s, 'long')),
    pendingShortOrder: Boolean(pendingForSide(s, 'short')),
    marginPerOrder: config.marginUsdt, leverage: config.leverage, cycleId: s.cycleId || null,
    comboPnl: s.comboPnl ?? null, netPnl: s.netPnl ?? null, closeTrigger: s.closeTrigger ?? null,
    costs: s.costs || null, addStep: s.addStep ?? null, atr1h: s.atr1h ?? null,
    trend: Boolean(s.trend), marketDataFresh: s.marketDataFresh == null ? null : Boolean(s.marketDataFresh),
    sparseEnterAtrDistance: SPARSE_ENTER_ATR_DISTANCE,
    trendDirection: s.trendDirection || 'neutral', trendBars: s.trendBars ?? 0,
    shortTrendProtected: Boolean(s.shortTrendProtected), overheat: s.overheat || null,
    lastPrice: s.lastPrice ?? null, range: s.range || null,
    cooldownUntil: s.cooldownUntil ?? null, cycleStartedAt: s.cycleStartedAt ?? null,
    startupProgress: s.startupProgress ?? null, startupStep: s.startupStep || '',
    resumeEligible: Boolean(s.resumeEligible), adoptionPositions: s.adoptionPositions || null,
    adoptedAt: s.adoptedAt ?? null, adoptedLongQty: Number(s.adoptedLongQty || 0), adoptedShortQty: Number(s.adoptedShortQty || 0),
    recovery: Boolean(s.recovery), recoveryArmed: Boolean(s.recoveryArmed),
    recoveryPeakNetPnl: s.recoveryPeakNetPnl ?? null, recoveryTrail: s.recoveryTrail ?? null,
    weekendMode: isCommodityWeekendMode(),
    long: { ...legSnapshot(s, 'long'), costs: s.longCosts || null },
    short: { ...legSnapshot(s, 'short'), costs: s.shortCosts || null },
    lastError: row.last_error || '', startedAt: row.started_at, updatedAt: row.updated_at };
}
function recordAddBlock(row, direction, reason, message, details = {}) {
  const latest = rowFor(row.user_id, row.symbol) || row;
  const state = parseState(latest);
  const leg = legSnapshot(state, direction);
  const serialized = JSON.stringify(details);
  const previousSerialized = JSON.stringify(leg.addBlockDetails || {});
  if (leg.addBlockReason === reason && previousSerialized === serialized) return;
  if (leg.addBlockReason !== reason && message) {
    log(row.user_id, row.symbol, message, reason ? 'warn' : 'info', { side: direction, reason, ...details });
  }
  save(latest, {}, legPatch(direction, { AddBlockReason: reason, AddBlockDetails: details }));
}
function status(userId, symbol) {
  const sym = cleanSymbol(symbol);
  const row = rowFor(userId, sym);
  const events = getDb().prepare('SELECT id,level,message,details_json,created_at FROM tradfi_range_events WHERE user_id=? AND symbol=? ORDER BY created_at DESC LIMIT 80').all(String(userId), sym)
    .map((e) => ({ ...e, details: (() => { try { return JSON.parse(e.details_json); } catch { return {}; } })() }));
  const defaults = defaultConfig(sym);
  return { strategy: publicRow(row) || { symbol: sym, legacyRetired: LEGACY_DRAIN_ONLY, enabled: false, status: 'stopped', simulated: null, additions: 0, longAdditions: 0, shortAdditions: 0,
    maxAdditions: MAX_ADDITIONS, maxLongAdditions: MAX_LONG_ADDITIONS, maxShortAdditions: MAX_SHORT_ADDITIONS,
    maxTotalAdditions: MAX_LONG_ADDITIONS + MAX_SHORT_ADDITIONS,
    marginPerOrder: defaults.marginUsdt, leverage: defaults.leverage, long: { manualMarginUsdt: 0 }, short: { manualMarginUsdt: 0 } }, events };
}
function hasSavedPosition(existing, existingState) {
  if (existing?.status !== 'paused') return false;
  if (existingState.pausedPositions) return hasPausedPosition(existingState);
  return Boolean(existingState.resumeEligible || Number(existingState.expectedLong || 0) > 0
    || Number(existingState.expectedShort || 0) > 0);
}
function hasPausedPosition(state) {
  return Number(state.pausedPositions?.long?.quantity || 0) > 0
    || Number(state.pausedPositions?.short?.quantity || 0) > 0;
}
function restartState(existing, existingState, config, input = {}) {
  const savedPosition = hasSavedPosition(existing, existingState);
  // A previous startup may have paused at the adoption prompt. A recorded
  // stopped-position snapshot still proves ownership across that retry.
  const keepLineage = savedPosition || (existing?.status === 'adoption_required' && hasPausedPosition(existingState));
  const initialState = keepLineage
    ? { ...existingState, config, resumeEligible: keepLineage, adoptExisting: Boolean(input.adoptExisting), startupProgress: 5, startupStep: '准备检查现有仓位' }
    : { config, resumeEligible: false, adoptExisting: Boolean(input.adoptExisting), longManualMarginUsdt: 0, shortManualMarginUsdt: 0, startupProgress: 5,
      startupStep: input.adoptExisting ? '准备检查现有仓位' : '准备启动检查' };
  return { savedPosition, initialState };
}
function enable(userId, symbol, simulated, input = {}) {
  throw invalid('旧震荡策略已退役；存量仓位仍可管理和平仓。', 410);
}
async function disable(userId, symbol) {
  const row = rowFor(userId, symbol);
  if (!row) return status(userId, symbol);
  const key = `${String(userId)}|${row.symbol}`;
  if (lockedRows.has(key) || activeRows.has(key)) throw invalid('策略正在检查或同步仓位，请稍后重试停止', 409);
  // Prevent a new reconcile pass from placing an order while stop is
  // canceling the orders that were visible at the start of this request.
  lockedRows.add(key);
  try {
    let latest = row;
    let state = parseState(latest);
    const creds = getBinanceCredentialsForUser(userId);
    let pausedPositions = null;
    if (creds) {
      if (state.manualPending) {
        const settled = await cancelAndVerifyOrder(creds, row.symbol, state.manualPending);
        if (!settled.resolved) throw invalid('手动补仓委托撤销结果未确认，暂不能停止策略，请核对币安委托', 409);
        await reconcileManualPending(latest, creds, state);
        latest = rowFor(userId, row.symbol);
        state = parseState(latest);
      }
      // A Maker add may fill while it is being canceled. Settle and count
      // that fill before persisting the paused state.
      for (const direction of ['long', 'short']) {
        if (!pendingForSide(state, direction)) continue;
        await cancelTrackedAutoPending(latest, creds, state, direction, '停止策略');
        latest = rowFor(userId, row.symbol);
        state = parseState(latest);
      }
      await cancelKnown(creds, row.symbol, state);
      const risk = await signedRequest(creds, 'GET', '/fapi/v2/positionRisk', { symbol: row.symbol });
      const pos = positionsOf(risk, row.symbol);
      pausedPositions = {
        long: { quantity: qty(pos.long), entryPrice: Number(pos.long?.entryPrice || 0), leverage: Number(pos.long?.leverage || 0) },
        short: { quantity: qty(pos.short), entryPrice: Number(pos.short?.entryPrice || 0), leverage: Number(pos.short?.leverage || 0) },
      };
    }
    const resumeEligible = Boolean((pausedPositions?.long.quantity || 0) > 0 || (pausedPositions?.short.quantity || 0) > 0);
    save(latest, { enabled: 0, status: 'paused' }, { pending: null, pendingLong: null, pendingShort: null, pausedPositions, resumeEligible, pausedAt: Date.now(), adoptionPositions: null });
    log(userId, row.symbol, resumeEligible ? '震荡交易已停止，仓位已保留；下次启动将按币安实际仓位恢复接管' : '震荡交易已停止，当前没有需要接管的策略仓位', 'warn');
    return status(userId, row.symbol);
  } finally { lockedRows.delete(key); }
}
function closedKlines(rows, now = Date.now()) {
  return (Array.isArray(rows) ? rows : []).filter((row) => !Number.isFinite(Number(row?.[6])) || Number(row[6]) <= now);
}
function marketDataFreshness(rows15, rows60, now = Date.now()) {
  const latestClose = (rows) => {
    const closed = closedKlines(rows, now);
    const timestamp = Number(closed.at(-1)?.[6]);
    return Number.isFinite(timestamp) ? timestamp : null;
  };
  const close15m = latestClose(rows15);
  const close1h = latestClose(rows60);
  const age15m = close15m == null ? Infinity : now - close15m;
  const age1h = close1h == null ? Infinity : now - close1h;
  const fresh15m = age15m >= 0 && age15m <= MAX_15M_CANDLE_AGE_MS;
  const fresh1h = age1h >= 0 && age1h <= MAX_1H_CANDLE_AGE_MS;
  return { fresh: fresh15m && fresh1h, fresh15m, fresh1h, age15m, age1h };
}
const dailySupportCache = new Map();
function recentDailyRows(symbol) {
  const saved = dailySupportCache.get(symbol);
  if (saved && Date.now() - saved.at < 60 * 60 * 1000) return saved.rows;
  dailySupportCache.set(symbol, { at: Date.now(), rows: saved?.rows || [] });
  publicGet('/fapi/v1/klines', { symbol, interval: '1d', limit: 32 })
    .then((rows) => dailySupportCache.set(symbol, { at: Date.now(), rows: closedKlines(rows) }))
    .catch(() => dailySupportCache.set(symbol, { at: Date.now() - 55 * 60 * 1000, rows: saved?.rows || [] }));
  return saved?.rows || [];
}
async function snapshot(symbol, fallback = {}) {
  const [fifteen, hourly, bookResult, daily] = await Promise.allSettled([
    publicGet('/fapi/v1/klines', { symbol, interval: '15m', limit: 48 }),
    publicGet('/fapi/v1/klines', { symbol, interval: '1h', limit: 130 }),
    publicGet('/fapi/v1/ticker/bookTicker', { symbol }),
    Promise.resolve(symbol === 'XAUUSDT' ? recentDailyRows(symbol) : []),
  ]);
  const book = bookResult.status === 'fulfilled' ? bookResult.value : null;
  const bid = Number(book?.bidPrice); const ask = Number(book?.askPrice);
  const hasBook = Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0 && ask >= bid;
  const mid = hasBook ? (bid + ask) / 2 : Number(fallback.lastPrice || 0);
  const base = { last: mid, bid: hasBook ? bid : 0, ask: hasBook ? ask : 0,
    atr: Number(fallback.atr || 0), atr1h: Number(fallback.atr1h || 0), addStep: Number(fallback.addStep || 0),
    range: fallback.range || null, rangeReady: false, trend: true, trendDirection: 'neutral',
    trendBars: 0, upWeakBars: 0, downWeakBars: 0, dataFresh: false };
  if (!hasBook || fifteen.status !== 'fulfilled' || hourly.status !== 'fulfilled') return base;
  try {
    const rows15 = closedKlines(fifteen.value);
    const rows60 = closedKlines(hourly.value);
    const dataState = marketState(rows15, rows60.slice(-60));
    const freshness = marketDataFreshness(fifteen.value, hourly.value);
    return { ...dataState, ...freshness, last: mid, bid, ask, dataFresh: freshness.fresh,
      hourlyRows: rows60, dailyRows: daily.status === 'fulfilled' ? daily.value : [] };
  } catch {
    return base;
  }
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
function isCanceledWithoutFill(current) {
  return Number(current?.executedQty || 0) <= 0 && ['CANCELED', 'EXPIRED', 'REJECTED'].includes(String(current?.status || ''));
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
async function orderQty(symbol, price, config, marginUsdt = config.marginUsdt) {
  const rules = await symbolRules(symbol);
  const lot = new Map((rules?.filters || []).map((f) => [f.filterType, f])).get('LOT_SIZE');
  if (!lot) throw new Error('合约数量规则缺失');
  const quantity = stepped(Number(marginUsdt) * config.leverage / price, lot.stepSize);
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
async function cancelAndVerifyOrder(creds, symbol, order) {
  let current = order?.orderId
    ? await orderState(creds, symbol, order)
    : await findOrderByClientId(creds, symbol, order?.clientOrderId, 6);
  if (!current) return { resolved: false, order };
  const resolvedOrder = { ...order, orderId: String(current.orderId), uncertain: false };
  if (!['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'].includes(String(current.status))) {
    await signedRequest(creds, 'DELETE', '/fapi/v1/order', { symbol, orderId: String(current.orderId) });
    current = await orderState(creds, symbol, resolvedOrder);
  }
  const terminal = ['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'].includes(String(current.status));
  return { resolved: terminal, order: resolvedOrder, current };
}
async function cancelLosingTakeProfit(row, creds, direction, leg, netPnl) {
  const orders = Array.isArray(leg.closeOrders) ? leg.closeOrders.filter(Boolean) : [];
  if (!orders.length) return false;
  const settled = [];
  for (const order of orders) {
    const result = await cancelAndVerifyOrder(creds, row.symbol, order);
    if (!result.resolved) {
      save(row, {}, { ...legPatch(direction, { CloseOrders: [...settled.map((item) => item.order), ...orders.slice(settled.length)] }) });
      return false;
    }
    settled.push(result);
  }

  // A close can fill while its cancellation is in flight. The exchange position
  // is the source of truth before returning this leg to normal management.
  let risk = await signedRequest(creds, 'GET', '/fapi/v2/positionRisk', { symbol: row.symbol });
  let positions = positionsOf(risk, row.symbol);
  let position = direction === 'long' ? positions.long : positions.short;
  let remainingQty = qty(position);
  const side = direction === 'long' ? 'LONG' : 'SHORT';
  const filledDuringCancel = settled.reduce((sum, item) => sum + Number(item.current?.executedQty || 0), 0);
  const expectedAfterClose = Math.max(0, Number(leg.expectedQty || 0) - filledDuringCancel);
  if (!closeEnough(remainingQty, expectedAfterClose)) {
    await waitMs(300);
    risk = await signedRequest(creds, 'GET', '/fapi/v2/positionRisk', { symbol: row.symbol });
    positions = positionsOf(risk, row.symbol);
    position = direction === 'long' ? positions.long : positions.short;
    remainingQty = qty(position);
  }
  if (!(remainingQty > 0)) {
    if (filledDuringCancel > 0 && closeEnough(filledDuringCancel, Number(leg.expectedQty || 0))) {
      save(row, {}, { ...legPatch(direction, { Phase: 'reentry_wait', ExpectedQty: 0, CloseOrders: [], ClosePlacedAt: 0, CloseGuardPrice: 0,
        ReentryAt: Date.now() + COOLDOWN_MS, RecoveryArmed: false, RecoveryPeakNetPnl: 0, RecoveryTrail: 0 }),
        ...(direction === 'long' ? { expectedLong: 0 } : { expectedShort: 0 }) });
      log(row.user_id, row.symbol, `${side === 'LONG' ? '多头' : '空头'}止盈委托撤销期间已全部成交，10 秒后重建底仓`, 'success');
      return true;
    }
    save(row, { enabled: 0, status: 'manual', last_error: '止盈撤单期间仓位与委托成交量不一致，请同步币安仓位' },
      { ...legPatch(direction, { Phase: 'active', ExpectedQty: expectedAfterClose, CloseOrders: [], ClosePlacedAt: 0, CloseGuardPrice: 0 }),
        ...(direction === 'long' ? { expectedLong: expectedAfterClose } : { expectedShort: expectedAfterClose }) });
    log(row.user_id, row.symbol, `${side === 'LONG' ? '多头' : '空头'}止盈撤单后交易所仓位为空，但委托成交量不足以确认自动止盈；策略转人工核对`, 'warn',
      { filledDuringCancel, expectedQty: leg.expectedQty });
    return true;
  }

  if (!closeEnough(remainingQty, expectedAfterClose)) {
    save(row, { enabled: 0, status: 'manual', last_error: '止盈撤单期间检测到额外仓位变化，请同步币安仓位' },
      { ...legPatch(direction, { Phase: 'active', ExpectedQty: expectedAfterClose, CloseOrders: [], ClosePlacedAt: 0, CloseGuardPrice: 0 }),
        ...(direction === 'long' ? { expectedLong: expectedAfterClose } : { expectedShort: expectedAfterClose }) });
    log(row.user_id, row.symbol, `${side === 'LONG' ? '多头' : '空头'}止盈撤单期间仓位变化超出已确认成交量，策略转人工核对`, 'warn',
      { filledDuringCancel, expectedQty: expectedAfterClose, actualQty: remainingQty });
    return true;
  }

  const latest = rowFor(row.user_id, row.symbol) || row;
  const latestState = parseState(latest);
  const latestLeg = legSnapshot(latestState, direction);
  save(latest, { status: 'active', last_error: '' }, { ...legPatch(direction, { Phase: 'active', ExpectedQty: remainingQty,
    CloseOrders: [], ClosePlacedAt: 0, CloseGuardPrice: 0, RecoveryArmed: false, RecoveryPeakNetPnl: 0, RecoveryTrail: 0 }),
    ...(direction === 'long' ? { expectedLong: remainingQty } : { expectedShort: remainingQty }) });
  log(row.user_id, row.symbol, `${side === 'LONG' ? '多头' : '空头'}止盈委托未成交且净盈亏转负，已撤销；按交易所剩余仓位恢复补仓管理`, 'warn',
    { netPnl, filledDuringCancel, remainingQty, additions: latestLeg.additions });
  return true;
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
    ...(state.entries || []), ...(state.closeOrders || []), ...autoPendingOrders(state), state.pending, state.manualPending,
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
function remember(userId, row, order, clientId, side, price, quantity, marginUsdt = null) {
  const config = strategyConfig(row);
  try {
    recordBinanceAiOrder(userId, 'tradfi', { orderId: order.orderId, clientOrderId: clientId, symbol: row.symbol,
      side, positionSide: side === 'BUY' ? 'LONG' : 'SHORT', price, quantity, marginUsdt: Number(marginUsdt) > 0 ? marginUsdt : config.marginUsdt, leverage: config.leverage, simulated: Boolean(row.simulated) });
  } catch (err) { console.warn('[tradfi-range] ledger:', err.message); }
}
async function placeLimit(creds, row, side, price, suffix, marginUsdt = null) {
  throw invalid('旧策略只管理存量，禁止新增仓位', 410);
}
async function manualAddPreview(userId, symbol, sideValue, marginValue) {
  throw invalid('旧策略补仓已停用', 410);
}
async function manualAdd(userId, symbol, side, marginUsdt, expected = {}) {
  throw invalid('旧策略补仓已停用', 410);
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
  save(row, { status: 'entry_pending', additions: 0, last_error: '' }, { cycleId, cycleStartedAt, fundingStartedAt: cycleStartedAt, entries: [], pending: null, pendingLong: null, pendingShort: null, deepLongSignal: null, longAdditions: 0, shortAdditions: 0, expectedLong: 0, expectedShort: 0, lastAddPrice: market.last, addStep: market.addStep, range: market.range, lastPrice: market.last, minLongPnl: 0, minShortPnl: 0, recovery: false, recoveryArmed: false, recoveryPeakNetPnl: 0, recoveryTrail: 0 });
  const fresh = rowFor(row.user_id, row.symbol); const entries = [];
  try {
    entries.push(await placeLimit(creds, fresh, 'BUY', market.bid, 'base_l'));
    save(rowFor(row.user_id, row.symbol), { status: 'entry_pending' }, { entries: [...entries], pending: null, entryDeadline: Date.now() + ORDER_TTL_MS });
    entries.push(await placeLimit(creds, fresh, 'SELL', market.ask, 'base_s'));
    save(rowFor(row.user_id, row.symbol), { status: 'entry_pending' }, { entries: [...entries], pending: null, entryDeadline: Date.now() + ORDER_TTL_MS });
  } catch (err) {
    const latest = rowFor(row.user_id, row.symbol);
    const currentState = parseState(latest);
    let tracked = [...entries, ...(err.uncertainOrder ? [err.uncertainOrder] : [])];
    let settled = [];
    let settleError = null;
    try {
      const recovered = await recoverBaseOrders(creds, latest, currentState);
      const byClientId = new Map();
      for (const order of [...tracked, ...recovered]) byClientId.set(String(order.clientOrderId || order.orderId), order);
      tracked = [...byClientId.values()];
      settled = await Promise.all(tracked.map((order) => cancelAndVerifyOrder(creds, row.symbol, order)));
    } catch (cancelErr) { settleError = cancelErr; }
    const unresolved = settleError || settled.some((item) => !item.resolved);
    if (unresolved) {
      const message = `底仓委托状态或撤销结果无法确认${settleError ? `：${settleError.message}` : ''}，策略已停止自动提交；请立即在币安核对这些委托`;
      save(latest, { enabled: 0, status: 'manual', last_error: message }, { entries: tracked, pending: null });
      log(row.user_id, row.symbol, message, 'error', { orders: tracked.map((order) => ({ clientOrderId: order.clientOrderId, orderId: order.orderId || null })) });
      return;
    }
    const riskAfterCancel = await signedRequest(creds, 'GET', '/fapi/v2/positionRisk', { symbol: row.symbol });
    const positionAfterCancel = positionsOf(riskAfterCancel, row.symbol);
    const hadFill = settled.some((item) => Number(item.current?.executedQty || 0) > 0);
    if (hadFill && !qty(positionAfterCancel.long) && !qty(positionAfterCancel.short)) {
      const message = '底仓委托已成交，但币安仓位暂未反映该成交；策略已停止自动提交，请核对账户';
      save(latest, { enabled: 0, status: 'manual', last_error: message }, { entries: tracked, pending: null });
      log(row.user_id, row.symbol, message, 'error');
      return;
    }
    if (qty(positionAfterCancel.long) || qty(positionAfterCancel.short)) {
      const closeOrders = await closePositions(latest, creds, positionAfterCancel);
      save(rowFor(row.user_id, row.symbol), { enabled: 1, status: 'close_pending', last_error: err.message }, {
        entries: [], pending: null, closeOrders, closePlacedAt: Date.now(), closeReason: '双向底仓提交未完成', stopAfterClose: false,
      });
      log(row.user_id, row.symbol, '双向底仓提交未完成，已按实际成交数量提交 Maker 平仓', 'warn');
      return;
    }
    const manual = Number(err.status) === 409 && !err.uncertainOrder;
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
      at: Date.now(), fallback: false,
    };
    feeCache.set(symbol, value);
    return value;
  } catch {
    return { maker: DEFAULT_MAKER_FEE, taker: DEFAULT_TAKER_FEE, at: Date.now(), fallback: true };
  }
}
function startupUpdate(row, progress, step, level = 'info', details = {}) {
  const latest = rowFor(row.user_id, row.symbol);
  if (!latest?.enabled || latest.status !== 'initializing') throw invalid('策略启动已取消', 409);
  save(latest, { last_error: '' }, { startupProgress: progress, startupStep: step });
  log(row.user_id, row.symbol, step, level, { ...details, phase: 'startup', progress });
}
function positionAdoptionSummary(pos) {
  return {
    long: { quantity: qty(pos.long), entryPrice: Number(pos.long?.entryPrice || 0), leverage: Number(pos.long?.leverage || 0), unrealizedPnl: Number(pos.long?.unRealizedProfit || 0) },
    short: { quantity: qty(pos.short), entryPrice: Number(pos.short?.entryPrice || 0), leverage: Number(pos.short?.leverage || 0), unrealizedPnl: Number(pos.short?.unRealizedProfit || 0) },
  };
}
function adoptedLegState(state, direction, position) {
  const previous = legSnapshot(state, direction); const quantity = qty(position);
  if (!(quantity > 0)) return legPatch(direction, {
    Phase: 'reentry_wait', ExpectedQty: 0, CloseOrders: [], ClosePlacedAt: 0, CloseGuardPrice: 0,
    ReentryAt: Date.now() + COOLDOWN_MS, ReentryOrder: null,
  });
  return legPatch(direction, {
    Phase: 'active', ExpectedQty: quantity, Additions: previous.additions,
    LastAddPrice: previous.lastAddPrice || Number(position.entryPrice || 0),
    MinPnl: Math.min(previous.minPnl, Number(position.unRealizedProfit || 0)),
    Recovery: previous.recovery, RecoveryArmed: previous.recoveryArmed,
    RecoveryPeakNetPnl: previous.recoveryPeakNetPnl, RecoveryTrail: previous.recoveryTrail,
    RecoveryExitVersion: previous.recoveryExitVersion,
    CloseOrders: [], ClosePlacedAt: 0, CloseGuardPrice: 0, FundingStartedAt: Date.now(), ReentryAt: 0, ReentryOrder: null,
  });
}
function syncLegState(state, direction, position, now = Date.now(), fallbackLeverage = LEVERAGE) {
  const previous = legSnapshot(state, direction);
  const quantity = qty(position);
  const entryPrice = Number(position?.entryPrice || 0);
  const leverage = Number(position?.leverage) || fallbackLeverage;
  const syncedManualQty = Math.max(0, previous.syncedManualQty + quantity - previous.expectedQty);
  if (!(quantity > 0)) return legPatch(direction, {
    Phase: 'reentry_wait', ExpectedQty: 0, SyncedManualQty: 0, SyncedManualMarginUsdt: 0,
    CloseOrders: [], ClosePlacedAt: 0, CloseGuardPrice: 0, ReentryAt: now + COOLDOWN_MS, ReentryOrder: null,
  });
  return legPatch(direction, {
    Phase: 'active', ExpectedQty: quantity, Additions: previous.additions, ManualMarginUsdt: previous.manualMarginUsdt,
    LastAddPrice: entryPrice || previous.lastAddPrice,
    MinPnl: Math.min(previous.minPnl, Number(position?.unRealizedProfit || 0)),
    Recovery: previous.recovery, RecoveryArmed: false,
    RecoveryPeakNetPnl: 0, RecoveryTrail: 0, RecoveryExitVersion: 1, SparseMode: previous.sparseMode,
    SyncedManualQty: syncedManualQty,
    SyncedManualMarginUsdt: syncedManualQty * (entryPrice || previous.lastAddPrice) / leverage,
    CloseOrders: [], ClosePlacedAt: 0, CloseGuardPrice: 0, ReentryAt: 0, ReentryOrder: null,
  });
}
function quantitySyncSummary(state, positions) {
  const sides = {};
  for (const side of ['long', 'short']) {
    const position = positions[side]; const expectedQty = legSnapshot(state, side).expectedQty;
    const actualQty = qty(position); const entryPrice = Number(position?.entryPrice || 0);
    const leverage = Number(position?.leverage || 0);
    sides[side] = { expectedQty, actualQty, delta: actualQty - expectedQty,
      entryPrice, leverage, unrealizedPnl: Number(position?.unRealizedProfit || 0),
      marginUsdt: leverage > 0 ? actualQty * entryPrice / leverage : null };
  }
  return { required: ['long', 'short'].some((side) => !closeEnough(sides[side].expectedQty, sides[side].actualQty)), sides };
}
function hasPendingStrategyOrder(row, state) {
  if (state.pending || hasAutoPending(state) || ['initializing', 'entry_pending', 'add_pending', 'close_pending'].includes(row.status)) return true;
  return ['long', 'short'].some((side) => ['close_pending', 'reentry_pending'].includes(legSnapshot(state, side).phase));
}
function canCancelPendingForPositionSync(row, state) {
  return row.status === 'add_pending' && autoPendingOrders(state).length > 0 && autoPendingOrders(state).every((order) => order.kind !== 'manual') && !state.manualPending
    && ['long', 'short'].every((side) => !['close_pending', 'reentry_pending'].includes(legSnapshot(state, side).phase));
}
async function positionSyncExpectedState(creds, row, state) {
  if (!canCancelPendingForPositionSync(row, state)) return state;
  let expected = { ...state };
  for (const pending of autoPendingOrders(state)) {
    const current = await orderState(creds, row.symbol, pending);
    const filled = Number(current.executedQty || 0);
    const direction = pending.direction || (pending.side === 'BUY' ? 'long' : 'short');
    const leg = legSnapshot(expected, direction);
    expected = { ...expected, ...legPatch(direction, { ExpectedQty: leg.expectedQty + filled }) };
  }
  return expected;
}
async function positionSyncStatus(userId, symbol) {
  const sym = cleanSymbol(symbol); const row = rowFor(userId, sym);
  if (!row) return { strategy: status(userId, sym).strategy, positionSync: { required: false, available: false, sides: null } };
  const state = parseState(row); const eligible = Boolean(row.enabled) || row.status === 'manual';
  if (!eligible) return { strategy: publicRow(row), positionSync: { required: false, available: false, sides: null } };
  const rowKey = `${String(userId)}|${sym}`;
  const pendingCancelable = canCancelPendingForPositionSync(row, state);
  const blocked = (hasPendingStrategyOrder(row, state) && !pendingCancelable) || Boolean(state.manualPending)
    || lockedRows.has(rowKey) || activeRows.has(rowKey);
  try {
    const creds = getBinanceCredentialsForUser(userId);
    if (!creds || Number(creds.simulated) !== Number(row.simulated)) throw invalid('币安密钥缺失或交易环境已变化', 409);
    const risk = await signedRequest(creds, 'GET', '/fapi/v2/positionRisk', { symbol: sym });
    const compareState = await positionSyncExpectedState(creds, row, state);
    const summary = quantitySyncSummary(compareState, positionsOf(risk, sym));
    return { strategy: publicRow(row), positionSync: { ...summary, available: summary.required && !blocked,
      cancelPendingOrder: Boolean(summary.required && pendingCancelable),
      blockedReason: blocked ? '请先等待策略委托或状态切换完成' : '' } };
  } catch (error) {
    return { strategy: publicRow(row), positionSync: { required: false, available: false, sides: null,
      blockedReason: error.message || '暂时无法读取币安仓位' } };
  }
}
async function syncPositions(userId, symbol) {
  const sym = cleanSymbol(symbol); const key = `${String(userId)}|${sym}`;
  if (lockedRows.has(key) || activeRows.has(key)) throw invalid('策略正在检查该标的，请稍后再同步', 409);
  lockedRows.add(key);
  try {
    let row = rowFor(userId, sym);
    if (!(row?.enabled || row?.status === 'manual')) throw invalid('仅运行中或因仓位不匹配转人工的策略可以同步', 409);
    let state = parseState(row);
    const creds = getBinanceCredentialsForUser(userId);
    if (!creds || Number(creds.simulated) !== Number(row.simulated)) throw invalid('币安密钥缺失或交易环境已变化', 409);
    const pendingCancelable = canCancelPendingForPositionSync(row, state);
    if ((hasPendingStrategyOrder(row, state) && !pendingCancelable) || state.manualPending) {
      throw invalid('策略正在开仓、平仓、重建或有手动补仓委托，请该操作完成后再同步', 409);
    }
    const riskBefore = await signedRequest(creds, 'GET', '/fapi/v2/positionRisk', { symbol: sym });
    const positionsBefore = positionsOf(riskBefore, sym);
    const compareState = await positionSyncExpectedState(creds, row, state);
    const summaryBefore = quantitySyncSummary(compareState, positionsBefore);
    if (!summaryBefore.required) throw invalid('策略记录与币安实际仓位已一致，无需同步', 409);

    if (pendingCancelable) {
      for (const pending of autoPendingOrders(state)) {
      const settled = await cancelAndVerifyOrder(creds, sym, pending);
      if (!settled.resolved) throw invalid('策略补仓委托撤销结果暂未确认，请在币安核对后再同步', 409);
      const direction = pending.direction || (pending.side === 'BUY' ? 'long' : 'short');
      const isLong = direction === 'long';
      const leg = legSnapshot(state, direction);
      const filled = Number(settled.current?.executedQty || 0);
      const fillPrice = Number(settled.current?.avgPrice || pending.price || 0);
      const slotCount = filled > 0 ? (pending.sparse ? Number(pending.slotCount) || SPARSE_GROUP_SIZE : 1) : 0;
      const counted = countedAdditions(state, isLong, slotCount);
      const qtyAfterFill = Number(leg.expectedQty || 0) + filled;
      const clearedPending = {
        ...pendingStatePatch(state, direction, null),
        longAdditions: counted.longAdditions,
        shortAdditions: counted.shortAdditions,
        expectedLong: Number(state.expectedLong || 0) + (isLong ? filled : 0),
        expectedShort: Number(state.expectedShort || 0) + (isLong ? 0 : filled),
        ...(filled > 0 ? { lastAddPrice: fillPrice, ...legPatch(direction, { Additions: counted.next, ExpectedQty: qtyAfterFill, LastAddPrice: fillPrice }) } : {}),
      };
      save(row, { status: hasAutoPending({ ...state, ...clearedPending }) ? 'add_pending' : 'active', additions: counted.total, last_error: '' }, clearedPending);
      log(userId, sym, `同步手动仓位前已撤销并核验策略补仓委托（${settled.current?.status || '状态已确认'}）`, 'warn',
        { phase: 'position_sync', orderId: settled.order?.orderId, status: settled.current?.status, filled, fillPrice });
      row = rowFor(userId, sym);
      state = parseState(row);
      }
    }

    const risk = await signedRequest(creds, 'GET', '/fapi/v2/positionRisk', { symbol: sym });
    const positions = positionsOf(risk, sym);
    const summary = quantitySyncSummary(state, positions);
    if (!summary.required) {
      if (pendingCancelable) save(row, { status: hasAutoPending(state) ? 'add_pending' : 'active', last_error: '' }, { pending: null, pendingLong: null, pendingShort: null });
      throw invalid('策略委托已处理，策略记录与币安实际仓位现已一致，无需同步', 409);
    }
    const now = Date.now(); const anyPosition = summary.sides.long.actualQty > 0 || summary.sides.short.actualQty > 0;
    let patch;
    if (anyPosition) {
      patch = { ...syncLegState(state, 'long', positions.long, now, strategyConfig(row).leverage),
        ...syncLegState(state, 'short', positions.short, now, strategyConfig(row).leverage),
        expectedLong: summary.sides.long.actualQty, expectedShort: summary.sides.short.actualQty,
        lastAddPrice: Number(positions.long?.entryPrice || positions.short?.entryPrice || state.lastAddPrice || 0),
        pending: null, resumeEligible: false, adoptExisting: false, adoptionPositions: null,
        syncedAt: now, cooldownUntil: 0 };
    } else {
      patch = { ...resetLeg('long', 0, Number(state.lastPrice || 0)), ...resetLeg('short', 0, Number(state.lastPrice || 0)),
        expectedLong: 0, expectedShort: 0, longAdditions: 0, shortAdditions: 0, additions: 0,
        pending: null, resumeEligible: false, adoptExisting: false, adoptionPositions: null,
        syncedAt: now, cooldownUntil: now + COOLDOWN_MS };
    }
    const nextCounts = sideAdditions({ ...state, ...patch });
    save(row, { enabled: 1, status: anyPosition ? 'active' : 'waiting', additions: nextCounts.longAdditions + nextCounts.shortAdditions, last_error: '' }, patch, true);
    log(userId, sym, anyPosition ? '用户确认同步币安实际仓位，策略开始管理同步后的总仓位' : '用户确认同步，币安仓位为空；策略进入行情等待状态',
      'success', { phase: 'position_sync', positions: summary.sides, additionsPreserved: anyPosition });
    return status(userId, sym);
  } finally { lockedRows.delete(key); }
}
async function initializeStrategy(row, creds) {
  const config = strategyConfig(row);
  startupUpdate(row, 12, '正在验证币安 API 与账户环境');
  const balances = await signedRequest(creds, 'GET', '/fapi/v2/balance');
  const usdt = (Array.isArray(balances) ? balances : []).find((item) => item.asset === 'USDT');
  if (!usdt) throw invalid('币安合约账户未找到 USDT 余额，请检查 API 权限', 409);
  startupUpdate(row, 28, `账户连接成功，可用余额 ${Number(usdt.availableBalance || 0).toFixed(2)} USDT`, 'success');

  startupUpdate(row, 40, '正在获取当前合约手续费率');
  const fees = await commissionRates(creds, row.symbol);
  startupUpdate(row, 52, fees.fallback
    ? `手续费接口暂不可用，采用保守费率：Maker ${(fees.maker * 100).toFixed(4)}% · Taker ${(fees.taker * 100).toFixed(4)}%`
    : `手续费率已获取：Maker ${(fees.maker * 100).toFixed(4)}% · Taker ${(fees.taker * 100).toFixed(4)}%`, fees.fallback ? 'warn' : 'success', { maker: fees.maker, taker: fees.taker, fallback: fees.fallback });

  startupUpdate(row, 62, '正在检查合约价格与数量规则');
  const rules = await symbolRules(row.symbol);
  if (!Array.isArray(rules?.filters) || !rules.filters.length) throw invalid('无法读取合约交易规则', 503);
  startupUpdate(row, 72, '合约交易规则检查完成', 'success');

  startupUpdate(row, 80, '正在检查现有仓位与双向持仓模式');
  const [risk, mode] = await Promise.all([
    signedRequest(creds, 'GET', '/fapi/v2/positionRisk', { symbol: row.symbol }),
    signedRequest(creds, 'GET', '/fapi/v1/positionSide/dual'),
  ]);
  const positions = positionsOf(risk, row.symbol);
  if (!(mode.dualSidePosition === true || mode.dualSidePosition === 'true')) throw invalid('请先在币安开启双向持仓模式', 409);
  startupUpdate(row, 90, '仓位与双向持仓模式检查完成', 'success');

  const hasPosition = qty(positions.long) > 0 || qty(positions.short) > 0;
  const state = parseState(rowFor(row.user_id, row.symbol));
  if (hasPosition) {
    const summary = positionAdoptionSummary(positions);
    if (!state.resumeEligible && !state.adoptExisting) throw adoptionRequired(summary);
    const actualLeverage = Number(positions.long?.leverage || positions.short?.leverage || config.leverage);
    const resumedConfig = state.resumeEligible ? config : { ...config, leverage: actualLeverage || config.leverage };
    const adoptedAt = Date.now();
    const patch = {
      config: resumedConfig, resumeEligible: false, adoptExisting: false, adoptionPositions: null, pausedPositions: null,
      startupProgress: 100, startupStep: '现有仓位已接管，策略恢复运行',
      cycleId: state.cycleId || crypto.randomUUID().replace(/-/g, '').slice(0, 10),
      cycleStartedAt: state.cycleStartedAt || adoptedAt, fundingStartedAt: adoptedAt, adoptedAt,
      adoptedLongQty: qty(positions.long), adoptedShortQty: qty(positions.short), entries: [], pending: null, pendingLong: null, pendingShort: null, closeOrders: [],
      expectedLong: qty(positions.long), expectedShort: qty(positions.short),
      ...adoptedLegState(state, 'long', positions.long), ...adoptedLegState(state, 'short', positions.short),
    };
    const counts = sideAdditions({ ...state, ...patch });
    const latest = rowFor(row.user_id, row.symbol);
    save(latest, { status: 'active', additions: counts.longAdditions + counts.shortAdditions, last_error: '' }, patch);
    log(row.user_id, row.symbol, state.resumeEligible ? '已按币安实际数量和均价恢复接管停止前仓位' : '已按用户确认接管现有仓位', 'success', { phase: 'startup', progress: 100, positions: summary });
    return;
  }

  startupUpdate(row, 95, `正在设置 ${config.leverage} 倍杠杆`);
  await signedRequest(creds, 'POST', '/fapi/v1/leverage', { symbol: row.symbol, leverage: String(config.leverage) });
  const latest = rowFor(row.user_id, row.symbol);
  save(latest, { status: 'waiting', last_error: '' }, { resumeEligible: false, adoptExisting: false, adoptionPositions: null, pausedPositions: null,
    startupProgress: 100, startupStep: '启动检查完成，进入行情监控' });
  log(row.user_id, row.symbol, '启动检查完成，服务器已进入行情监控', 'success', { phase: 'startup', progress: 100 });
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
  if (row.status === 'add_pending') {
    for (const pending of autoPendingOrders(state)) {
      const current = await read(pending); const filled = Number(current?.executedQty || 0);
      if (pending.side === 'BUY') long += filled; else short += filled;
    }
  }
  if (state.manualPending) {
    const current = await read(state.manualPending); const filled = Number(current?.executedQty || 0);
    if (state.manualPending.side === 'BUY') long += filled; else short += filled;
  }
  const longLeg = legSnapshot(state, 'long'); const shortLeg = legSnapshot(state, 'short');
  if (longLeg.phase === 'reentry_pending') long = Number((await read(longLeg.reentryOrder))?.executedQty || 0);
  if (shortLeg.phase === 'reentry_pending') short = Number((await read(shortLeg.reentryOrder))?.executedQty || 0);
  return { long, short };
}
async function closeAll(userId) {
  const creds = getBinanceCredentialsForUser(userId);
  if (!creds) throw invalid('请先在 API 设置中配置币安 API 密钥');
  const rows = getDb().prepare("SELECT * FROM tradfi_range_strategies WHERE user_id=? AND symbol IN ('XAUUSDT','XAGUSDT')").all(String(userId));
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
    save(row, { enabled: 1, status: 'close_pending', last_error: '' }, { pending: null, pendingLong: null, pendingShort: null, entries: [], closeOrders: [], closeRemaining, closePlacedAt: Date.now(), stopAfterClose: true }, true);
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
    entries: [], pending: null, pendingLong: null, pendingShort: null, closeOrders: [], closeRemaining: { LONG: 0, SHORT: 0 }, stopAfterClose: false, longAdditions: 0, shortAdditions: 0,
    expectedLong: 0, expectedShort: 0, comboPnl: 0, recovery: false, recoveryArmed: false,
    recoveryPeakNetPnl: 0, recoveryTrail: 0, cooldownUntil: Date.now() + COOLDOWN_MS,
  });
  log(row.user_id, row.symbol, stopped ? '一键平仓已全部成交，策略已停止' : 'Maker 平仓已成交，10 秒后检查下一轮开仓', 'success');
}
async function reconcileEntryPending(row, creds, state) {
  const entries = (state.entries || []).length < 2 ? await recoverBaseOrders(creds, row, state) : state.entries;
  if (entries.length !== (state.entries || []).length) save(row, {}, { entries });
  const states = await Promise.all(entries.map((order) => orderState(creds, row.symbol, order)));
  const longIndex = entries.findIndex((order) => order.side === 'BUY');
  const shortIndex = entries.findIndex((order) => order.side === 'SELL');
  if (states.length === 2 && states.every((order) => order.status === 'FILLED') && longIndex >= 0 && shortIndex >= 0) {
    const expectedLong = Number(states[longIndex].executedQty);
    const expectedShort = Number(states[shortIndex].executedQty);
    const longPrice = Number(states[longIndex].avgPrice || entries[longIndex].price);
    const shortPrice = Number(states[shortIndex].avgPrice || entries[shortIndex].price);
    save(row, { status: 'active' }, { expectedLong, expectedShort, entries: [], lastAddPrice: longPrice,
      ...resetLeg('long', expectedLong, longPrice), ...resetLeg('short', expectedShort, shortPrice) });
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
  save(row, { status: 'waiting' }, { entries: [], cooldownUntil: Date.now() + COOLDOWN_MS });
}
async function reconcileClosePending(row, creds, state) {
  const risk = await signedRequest(creds, 'GET', '/fapi/v2/positionRisk', { symbol: row.symbol });
  const pos = positionsOf(risk, row.symbol);
  const stopped = Boolean(state.stopAfterClose);
  const closeComplete = stopped
    ? (await closeOrderProgress(creds, row.symbol, state.closeOrders || [], state.closeRemaining || {})).complete
    : !qty(pos.long) && !qty(pos.short);
  if (closeComplete) { finishClose(row, stopped); return; }
  if (Date.now() - Number(state.closePlacedAt || 0) >= ORDER_TTL_MS) {
    const replacement = await replaceCloseOrders(row, creds, state.closeOrders || [], null, 0, state.closeRemaining || {});
    if (replacement.waiting) { save(row, {}, { closeOrders: replacement.orders }); return; }
    const closeOrders = replacement.orders;
    save(row, {}, { closeOrders, closeRemaining: closeTargetsFromOrders(closeOrders), closePlacedAt: Date.now() });
    log(row.user_id, row.symbol, 'Maker 平仓单未成交，已按最新盘口重新挂单', 'warn');
  }
}
async function reconcileManualPending(row, creds, state) {
  const pending = state.manualPending;
  if (!pending) return false;
  let current = await orderState(creds, row.symbol, pending);
  const terminalStatuses = ['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'];
  if (!terminalStatuses.includes(String(current.status)) && Date.now() - Number(pending.placedAt || 0) >= ORDER_TTL_MS) {
    await cancelOrder(creds, row.symbol, pending);
    current = await orderState(creds, row.symbol, pending);
  }
  if (!terminalStatuses.includes(String(current.status))) return false;

  const direction = pending.direction === 'short' ? 'short' : 'long';
  const isLong = direction === 'long';
  const leg = legSnapshot(state, direction);
  const filled = Number(current.executedQty || 0);
  const fillPrice = Number(current.avgPrice || pending.price || 0);
  const nextQty = Number(leg.expectedQty || 0) + filled;
  const marginUsdt = Number(leg.manualMarginUsdt || 0) + (filled > 0 && fillPrice > 0 ? filled * fillPrice / strategyConfig(row).leverage : 0);
  const hasStrategyPending = hasAutoPending(state);
  save(row, { status: hasStrategyPending ? 'add_pending' : 'active', last_error: '' }, {
    manualPending: null,
    expectedLong: Number(state.expectedLong || 0) + (isLong ? filled : 0),
    expectedShort: Number(state.expectedShort || 0) + (isLong ? 0 : filled),
    lastAddPrice: filled > 0 ? fillPrice : state.lastAddPrice,
    ...legPatch(direction, { ExpectedQty: nextQty, LastAddPrice: filled > 0 ? fillPrice : leg.lastAddPrice, ManualMarginUsdt: marginUsdt,
      ...(filled > 0 ? { RecoveryArmed: false, RecoveryPeakNetPnl: 0, RecoveryTrail: 0 } : {}) }),
  });
  if (filled > 0) log(row.user_id, row.symbol,
    `${direction === 'long' ? '多头' : '空头'}手动补仓${current.status === 'FILLED' ? '已成交' : '部分成交，剩余已结束'}；保证金累计 ${marginUsdt.toFixed(2)}U`,
    current.status === 'FILLED' ? 'success' : 'trade', { side: direction, quantity: filled, avgPrice: fillPrice, manualMarginUsdt: marginUsdt });
  else log(row.user_id, row.symbol, `手动补仓委托${current.status === 'REJECTED' ? '被拒绝' : '未成交并结束'}`, 'warn', { side: direction, status: current.status });
  return true;
}
async function reconcileAutoPendingOrder(row, creds, state, direction, pending) {
  let current = await orderState(creds, row.symbol, pending);
  const isLong = direction === 'long'; const leg = legSnapshot(state, direction);
  const updateFill = (filled, fillPrice, slotCount) => {
    const counted = countedAdditions(state, isLong, slotCount);
    const expectedQty = leg.expectedQty + filled;
    const patch = { ...pendingStatePatch(state, direction, null), longAdditions: counted.longAdditions, shortAdditions: counted.shortAdditions,
      expectedLong: Number(state.expectedLong || 0) + (isLong ? filled : 0), expectedShort: Number(state.expectedShort || 0) + (isLong ? 0 : filled),
      lastAddPrice: filled > 0 ? fillPrice : state.lastAddPrice,
      ...legPatch(direction, { ExpectedQty: expectedQty, Additions: counted.next, LastAddPrice: filled > 0 ? fillPrice : leg.lastAddPrice,
        ...(filled > 0 ? { RecoveryArmed: false, RecoveryPeakNetPnl: 0, RecoveryTrail: 0 } : {}) }) };
    if (isLong && pending.deferredStage && filled > 0) patch.overheat = deferredLongFill(state.overheat, pending,
      filled * fillPrice / strategyConfig(row).leverage, Date.now());
    if (isLong && pending.deepLongStage && filled > 0) patch.deepLongSignal = {
      ...state.deepLongSignal, stage: Number(pending.deepLongStage),
      lastLow: Number(pending.deepLow), lastFillHour: Date.now() };
    return { counted, patch };
  };
  const persist = (pendingOrder, statePatch = {}, additions = null) => {
    const nextState = { ...state, ...pendingStatePatch(state, direction, pendingOrder), ...statePatch };
    const remains = hasAutoPending(nextState);
    save(row, { status: remains ? 'add_pending' : 'active', ...(additions == null ? {} : { additions }), last_error: '' }, nextState);
  };
  if (String(current.status) === 'FILLED') {
    const filled = Number(current.executedQty || 0); const fillPrice = Number(current.avgPrice || pending.price || 0);
    const slotCount = Math.max(1, Number(pending.slotCount) || 1);
    const { counted, patch } = updateFill(filled, fillPrice, slotCount);
    persist(null, patch, counted.total);
    log(row.user_id, row.symbol, pending.sparse
      ? `${isLong ? '多头' : '空头'}稀疏补仓第 ${pending.tierStart}-${pending.tierEnd} 档整组合并委托已成交`
      : `${isLong ? '多头' : '空头'}第 ${counted.next}/${isLong ? MAX_LONG_ADDITIONS : MAX_SHORT_ADDITIONS} 档补仓已成交`, 'trade',
    { side: pending.side, quantity: filled, slotCount, longAdditions: counted.longAdditions, shortAdditions: counted.shortAdditions });
    return true;
  }
  if (Date.now() - Number(pending.placedAt || 0) <= ((pending.special || pending.bottom)
    ? Number(pending.ttlMs || ORDER_TTL_MS) : ORDER_TTL_MS)) return false;
  await cancelOrder(creds, row.symbol, pending);
  current = await orderState(creds, row.symbol, pending);
  if (!['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'].includes(String(current.status))) return false;
  const filled = Number(current.executedQty || 0); const fillPrice = Number(current.avgPrice || pending.price || 0);
  if (pending.sparse) {
    const marginConsumed = filled > 0 ? filled * fillPrice / strategyConfig(row).leverage : 0;
    const remainingMarginUsdt = Math.max(0, Number(pending.remainingMarginUsdt || pending.totalMarginUsdt || 0) - marginConsumed);
    if (remainingMarginUsdt > 0.000001) {
      const suffix = `s${isLong ? 'l' : 's'}${pending.tierStart}_${pending.tierEnd}_r${Date.now().toString(36)}`;
      try {
        const replacement = await placeLimit(creds, row, pending.side, pending.triggerPrice, suffix, remainingMarginUsdt);
        const patch = { expectedLong: Number(state.expectedLong || 0) + (isLong ? filled : 0), expectedShort: Number(state.expectedShort || 0) + (isLong ? 0 : filled),
          ...legPatch(direction, { ExpectedQty: leg.expectedQty + filled,
            ...(filled > 0 ? { RecoveryArmed: false, RecoveryPeakNetPnl: 0, RecoveryTrail: 0 } : {}) }) };
        persist({ ...pending, ...replacement, remainingMarginUsdt, totalMarginUsdt: pending.totalMarginUsdt }, patch);
        log(row.user_id, row.symbol, `${isLong ? '多头' : '空头'}稀疏组单部分成交 ${filled > 0 ? '，已按剩余金额继续挂同一组' : '未成交，已重挂同一组'}；仍为第 ${pending.tierStart}-${pending.tierEnd} 档`,
          filled > 0 ? 'warn' : 'info', { filled, marginConsumed, remainingMarginUsdt, tierStart: pending.tierStart, tierEnd: pending.tierEnd });
        return true;
      } catch (error) {
        if (!/最小下单数量/.test(error.message || '')) throw error;
      }
    }
    const slotCount = Math.max(1, Number(pending.slotCount) || SPARSE_GROUP_SIZE);
    const { counted, patch } = updateFill(filled, fillPrice, slotCount);
    persist(null, patch, counted.total);
    log(row.user_id, row.symbol, remainingMarginUsdt > 0.000001
      ? `稀疏组单剩余金额低于最小下单量，按实际成交结束第 ${pending.tierStart}-${pending.tierEnd} 档`
      : `稀疏组单第 ${pending.tierStart}-${pending.tierEnd} 档已完成（实际成交保证金 ${marginConsumed.toFixed(2)}U）`, 'trade',
    { filled, marginConsumed, slotCount, longAdditions: counted.longAdditions, shortAdditions: counted.shortAdditions });
    return true;
  }
  const { counted, patch } = updateFill(filled, fillPrice, filled > 0 ? 1 : 0);
  persist(null, patch, counted.total);
  if (filled > 0) log(row.user_id, row.symbol, `${isLong ? '多头' : '空头'}第 ${counted.next}/${isLong ? MAX_LONG_ADDITIONS : MAX_SHORT_ADDITIONS} 档补仓部分成交，剩余已撤销`, 'trade', { side: pending.side, quantity: filled });
  else log(row.user_id, row.symbol, `${isLong ? '多头' : '空头'}常规补仓委托超时未成交，已撤销`, 'warn', { side: pending.side });
  return true;
}
async function cancelTrackedAutoPending(row, creds, state, direction, reason) {
  const pending = pendingForSide(state, direction);
  if (!pending) return false;
  const settled = await cancelAndVerifyOrder(creds, row.symbol, pending);
  if (!settled.resolved) throw new Error(`${reason}期间${direction === 'long' ? '多头' : '空头'}补仓委托撤销结果未确认，请核对币安委托`);
  const filled = Number(settled.current.executedQty || 0);
  const fillPrice = Number(settled.current.avgPrice || pending.price || 0);
  const slots = filled > 0 ? Math.max(1, Number(pending.slotCount) || 1) : 0;
  const counted = countedAdditions(state, direction === 'long', slots);
  const leg = legSnapshot(state, direction);
  const expectedKey = direction === 'long' ? 'expectedLong' : 'expectedShort';
  const patch = { ...pendingStatePatch(state, direction, null),
    longAdditions: counted.longAdditions, shortAdditions: counted.shortAdditions,
    [expectedKey]: Number(state[expectedKey] || 0) + filled,
    ...(filled > 0 ? { lastAddPrice: fillPrice } : {}),
    ...legPatch(direction, { ExpectedQty: leg.expectedQty + filled, Additions: counted.next,
      LastAddPrice: filled > 0 ? fillPrice : leg.lastAddPrice,
      ...(filled > 0 ? { RecoveryArmed: false, RecoveryPeakNetPnl: 0, RecoveryTrail: 0 } : {}) }) };
  if (direction === 'long' && pending.deferredStage && filled > 0) patch.overheat = deferredLongFill(state.overheat, pending,
    filled * fillPrice / strategyConfig(row).leverage, Date.now());
  if (direction === 'long' && pending.deepLongStage && filled > 0) patch.deepLongSignal = {
    ...state.deepLongSignal, stage: Number(pending.deepLongStage),
    lastLow: Number(pending.deepLow), lastFillHour: Date.now() };
  save(row, { status: hasAutoPending({ ...state, ...patch }) ? 'add_pending' : 'active', additions: counted.total }, patch);
  log(row.user_id, row.symbol, filled > 0
    ? `${reason}：${direction === 'long' ? '多头' : '空头'}补仓委托已成交 ${filled} 张，剩余委托已核验`
    : `${reason}：未成交${direction === 'long' ? '多头' : '空头'}补仓委托已撤销并核验`, 'warn',
  { side: direction, filled, slots, status: settled.current.status });
  return true;
}
async function reconcileRow(row) {
  const creds = getBinanceCredentialsForUser(row.user_id);
  if (!creds || Number(creds.simulated) !== Number(row.simulated)) throw new Error('币安密钥缺失或交易环境已变化');
  let state = parseState(row);
  if (LEGACY_DRAIN_ONLY && ['initializing', 'waiting'].includes(row.status)) {
    save(row, { enabled: 0, status: 'paused' }, { legacyRetired: true,
      resumeEligible: hasSavedPosition(row, state) || Boolean(state.resumeEligible) });
    return;
  }
  if (LEGACY_DRAIN_ONLY && row.status === 'entry_pending') {
    const entries = (state.entries || []).length < 2 ? await recoverBaseOrders(creds, row, state) : state.entries;
    const patch = { entries: [], legacyRetired: true };
    for (const direction of ['long', 'short']) {
      let filled = 0; let value = 0;
      for (const order of entries.filter(x => x.side === (direction === 'long' ? 'BUY' : 'SELL'))) {
        const settled = await cancelAndVerifyOrder(creds, row.symbol, order);
        if (!settled.resolved) throw new Error('旧入场单撤销结果未确认');
        const amount = Number(settled.current.executedQty || 0);
        filled += amount; value += amount * Number(settled.current.avgPrice || order.price || 0);
      }
      Object.assign(patch, filled > 0 ? resetLeg(direction, filled, value / filled)
        : legPatch(direction, { Phase: 'reentry_wait', ExpectedQty: 0 }));
      patch[direction === 'long' ? 'expectedLong' : 'expectedShort'] = filled;
    }
    save(row, { status: 'active' }, patch);
    return;
  }
  if (!state.manualPending && state.pending?.kind === 'manual') {
    save(row, {}, { manualPending: state.pending, pending: null });
    row = rowFor(row.user_id, row.symbol); state = parseState(row);
  }
  if (row.status === 'initializing') {
    await initializeStrategy(row, creds);
    return;
  }
  const weekendMode = isCommodityWeekendMode();
  if (weekendMode !== Boolean(state.weekendMode)) {
    save(row, {}, { weekendMode });
    log(row.user_id, row.symbol, weekendMode
      ? '进入周末报价模式，暂停自动补仓并撤销未成交补仓委托；已有仓位继续管理'
      : '常规报价模式恢复，允许按条件自动补仓', 'info');
    row = rowFor(row.user_id, row.symbol);
    state = parseState(row);
  }
  // Existing exchange orders must continue to be reconciled even if market
  // candles are delayed or unavailable.
  if (row.status === 'entry_pending') { await reconcileEntryPending(row, creds, state); return; }
  if (row.status === 'close_pending') { await reconcileClosePending(row, creds, state); return; }
  if (state.manualPending) {
    if (LEGACY_DRAIN_ONLY) {
      const settled = await cancelAndVerifyOrder(creds, row.symbol, state.manualPending);
      if (!settled.resolved) throw new Error('旧手动补仓单撤销结果未确认');
    }
    await reconcileManualPending(row, creds, state);
    row = rowFor(row.user_id, row.symbol);
    state = parseState(row);
  }
  if (weekendMode || LEGACY_DRAIN_ONLY) {
    for (const direction of ['long', 'short']) {
      const pending = pendingForSide(state, direction);
      if (pending) {
        await cancelTrackedAutoPending(row, creds, state, direction, LEGACY_DRAIN_ONLY ? '旧策略退役，取消新增' : '周末暂停自动补仓');
        return;
      }
    }
  }
  for (const direction of ['long', 'short']) {
    const pending = pendingForSide(state, direction);
    if ((pending?.sparse && Number(pending.slotCount) > 1) || pending?.extremeLongStage) {
      await cancelTrackedAutoPending(row, creds, state, direction, '切换为稀疏单档补仓');
      return;
    }
  }
  const market = await snapshot(row.symbol, state);
  if (market.dataFresh !== Boolean(state.marketDataFresh)) {
    log(row.user_id, row.symbol, market.dataFresh
      ? 'K 线数据已恢复新鲜，自动开仓与补仓恢复'
      : `K 线数据过期或不可用（15m ${Number.isFinite(market.age15m) ? `${Math.round(market.age15m / 60_000)} 分钟` : '无数据'}；1h ${Number.isFinite(market.age1h) ? `${Math.round(market.age1h / 60_000)} 分钟` : '无数据'}），暂停新增委托并继续管理已有仓位`,
    market.dataFresh ? 'success' : 'warn');
  }
  save(row, {}, { lastPrice: market.last, addStep: market.addStep, atr: market.atr, atr1h: market.atr1h,
    trend: market.trend, trendDirection: market.trendDirection, trendBars: market.trendBars, range: market.range,
    marketDataFresh: market.dataFresh });
  row = rowFor(row.user_id, row.symbol);
  state = parseState(row);
  if (market.dataFresh && market.hourlyRows) {
    const turn = turningPointStep(state.turningPoint, market.hourlyRows);
    if (turn.lastHour !== state.turningPoint?.lastHour) {
      save(row, {}, { turningPoint: turn });
      if (turn.phase === 'watch' && turn.id !== state.turningPoint?.id) log(row.user_id, row.symbol,
        turn.side === 'short' ? '小时线急涨预警，等待补空确认' : '小时线急跌预警；多头大额补仓另按深跌分级条件判断', 'info', turn);
      if (turn.phase === 'candidate' && state.turningPoint?.phase !== 'candidate') log(row.user_id, row.symbol,
        `小时线首次回撤，等待${turn.side === 'short' ? '更低高点及跌破回调低点' : '更高低点及突破反弹高点'}确认`, 'info', turn);
      if (turn.phase === 'confirmed' && state.turningPoint?.phase !== 'confirmed') log(row.user_id, row.symbol,
        turn.side === 'short' ? '小时线回落确认，检查空头特殊补仓' : '小时线止跌确认；多头大额补仓另按深跌分级条件判断', 'info', turn);
      if (turn.phase === 'cooldown' && state.turningPoint?.phase !== 'cooldown') log(row.user_id, row.symbol,
        '本段趋势的特殊补仓机会已结束，等待市场重新进入震荡后重置', 'info', turn);
      row = rowFor(row.user_id, row.symbol); state = parseState(row);
    }
  }
  let heat = row.symbol === 'XAUUSDT'
    ? overheatStateStep(state.overheat, market.hourlyRows, market, state.turningPoint,
      sideAdditions(state).shortAdditions, sideAdditions(state).longAdditions,
      legSnapshot(state, 'long').expectedQty > 0)
    : (state.overheat || { phase: 'normal' });
  if (heat.deferredLong) heat = { ...heat, deferredLong: null };
  if (row.symbol === 'XAUUSDT' && heat.phase !== 'normal') heat = { ...heat,
    supportZone: historicalSupportZone(market.dailyRows, market.atr1h, market.last) || heat.supportZone || null };
  if (heat.lastHour !== state.overheat?.lastHour
    || heat.deferredLong?.virtualCount !== state.overheat?.deferredLong?.virtualCount) {
    save(row, {}, { overheat: heat });
    if (heat.phase === 'overheat' && state.overheat?.phase !== 'overheat') log(row.user_id, row.symbol,
      '连续上涨进入过热状态：暂停多头自动补仓与重建；空头等待回落确认后有限补仓', 'warn', heat);
    if (heat.phase === 'bottom_watch' && state.overheat?.phase === 'overheat') log(row.user_id, row.symbol,
      '黄金距阶段高点回落至少 5%，暂停多头阶梯补仓并观察底部结构', 'warn', heat);
    if (heat.phase === 'bottom_confirmed' && state.overheat?.phase === 'bottom_watch') log(row.user_id, row.symbol,
      '小时线更高低点与反弹突破确认，等待深跌分级补多条件', 'success', heat);
    if (heat.phase === 'normal' && state.overheat?.phase === 'bottom_confirmed') log(row.user_id, row.symbol,
      '底部观察结束，恢复常规策略', 'info', heat);
    if (heat.phase === 'overheat' && heat.shortReady && !state.overheat?.shortReady) log(row.user_id, row.symbol,
      '高位回落结构确认，允许有限的小额空头补仓', 'info', heat);
    row = rowFor(row.user_id, row.symbol); state = parseState(row);
  }
  const hotShortPlan = overheatShortPlan(heat, market.last, Number(legSnapshot(state, 'short').lastAddPrice || market.last),
    market.addStep, market.atr1h, sideAdditions(state).shortAdditions);
  if (market.dataFresh && pendingForSide(state, 'long') && ((heat.phase !== 'normal'
    && !(heat.phase === 'bottom_confirmed' && pendingForSide(state, 'long').bottom)
    && !(heat.phase !== 'overheat' && pendingForSide(state, 'long').deepLongStage))
    || (heat.phase === 'normal' && pendingForSide(state, 'long').bottom))) {
    await cancelTrackedAutoPending(row, creds, state, 'long', '高位或底部观察期间暂停原多头补仓');
    return;
  }
  const oldShortPending = pendingForSide(state, 'short');
  for (const direction of ['long', 'short']) {
    const pending = pendingForSide(state, direction);
    if (pending?.special && !pending.deepLongStage
      && (state.turningPoint?.phase !== 'confirmed' || state.turningPoint.id !== pending.signalId)) {
      await cancelTrackedAutoPending(row, creds, state, direction, '反转信号失效');
      return;
    }
  }
  if (oldShortPending) {
    const slots = Math.max(1, Number(oldShortPending.slotCount) || 1);
    const lastTier = Number(oldShortPending.tierEnd ?? (oldShortPending.tierStart != null
      ? Number(oldShortPending.tierStart) + slots - 1 : sideAdditions(state).shortAdditions + slots));
    if (lastTier > MAX_SHORT_ADDITIONS) {
      await cancelTrackedAutoPending(row, creds, state, 'short', `空头新上限 ${MAX_SHORT_ADDITIONS} 档`);
      return;
    }
  }
  const shortProtection = shortTrendProtectionDecision(state.shortTrendProtected, market);
  if (shortProtection.entered || shortProtection.exited) {
    save(row, {}, { shortTrendProtected: shortProtection.active });
    log(row.user_id, row.symbol, shortProtection.entered
      ? heat.phase === 'overheat'
        ? '小时线上涨确认；过热模式下仅允许回落确认后的有限高位轻空'
        : '小时线上涨确认，暂停空头常规新增并撤销未成交补仓委托；反转确认的特殊补仓仍需独立风险检查'
      : '小时线上涨保护解除，空头自动新增恢复', shortProtection.entered ? 'warn' : 'success');
    row = rowFor(row.user_id, row.symbol);
    state = parseState(row);
  }
  if (market.dataFresh && pendingForSide(state, 'short') && ((heat.phase !== 'overheat' && pendingForSide(state, 'short').overheat)
    || (heat.phase === 'overheat'
    && (!hotShortPlan.allowed || !pendingForSide(state, 'short').overheat))
    || (shortProtection.active && !hotShortPlan.allowed && !pendingForSide(state, 'short').special))) {
    await cancelTrackedAutoPending(row, creds, state, 'short', heat.phase === 'overheat' ? '高位空头条件失效' : '上涨保护或过热结束');
    return;
  }
  if (market.dataFresh && row.status === 'add_pending' && hasAutoPending(state)) {
    const risk = await signedRequest(creds, 'GET', '/fapi/v2/positionRisk', { symbol: row.symbol });
    const positions = positionsOf(risk, row.symbol);
    for (const pending of autoPendingOrders(state)) {
      if (pending.special || pending.bottom) continue;
      const direction = pending.direction || (pending.side === 'BUY' ? 'long' : 'short');
      const position = positions[direction]; const leg = legSnapshot(state, direction);
      const sparse = sparseModeDecision({ active: leg.sparseMode, side: direction, entryPrice: Number(position?.entryPrice || 0),
        price: market.last, atr1h: market.atr1h, trendDirection: market.trendDirection, trendBars: market.trendBars,
        trendWeakBars: direction === 'long' ? market.downWeakBars : market.upWeakBars });
      if (sparse.active === Boolean(pending.sparse)) continue;
      const current = await orderState(creds, row.symbol, pending);
      if (Number(current.executedQty || 0) > 0 || String(current.status || '') === 'FILLED') continue;
      await cancelOrder(creds, row.symbol, pending);
      const latest = await orderState(creds, row.symbol, pending);
      if (!isCanceledWithoutFill(latest)) continue;
      const step = sparse.active ? sparseLadderStep(market.last, market.addStep, market.atr1h) : 0;
      const stillPending = autoPendingOrders(state).some((item) => item !== pending && item.orderId !== pending.orderId);
      save(row, { status: stillPending ? 'add_pending' : 'active' }, { ...pendingStatePatch(state, direction, null), ...legPatch(direction, { SparseMode: sparse.active,
        SparseSince: sparse.active ? (leg.sparseSince || Date.now()) : 0, SparseStep: step, SparseDistanceAtr: sparse.distanceAtr,
        SparseEntryPrice: Number(position?.entryPrice || 0) }) });
      log(row.user_id, row.symbol, sparse.active
        ? `${direction === 'long' ? '多头' : '空头'}趋势风险确认，已撤销普通补仓单并切换稀疏补仓`
        : `${direction === 'long' ? '多头' : '空头'}稀疏条件解除，已撤销未成交组单并恢复常规档距`, 'warn',
      { distanceAtr: sparse.distanceAtr, trendDirection: market.trendDirection, trendBars: market.trendBars, trendWeakBars: direction === 'long' ? market.downWeakBars : market.upWeakBars });
      row = rowFor(row.user_id, row.symbol); state = parseState(row);
    }
  }
  if (row.status === 'waiting') {
    if (!market.dataFresh) return;
    if (heat.phase === 'overheat') return;
    if (state.cooldownUntil && Date.now() < state.cooldownUntil) return;
    if (market.rangeReady && !shortProtection.active) await startCycle(row, creds, market);
    return;
  }
  const risk = await signedRequest(creds, 'GET', '/fapi/v2/positionRisk', { symbol: row.symbol });
  const pos = positionsOf(risk, row.symbol);
  if (state.deepLongSignal && (!qty(pos.long)
    || ['close_pending', 'reentry_wait'].includes(legSnapshot(state, 'long').phase))) {
    save(row, {}, { deepLongSignal: null });
    row = rowFor(row.user_id, row.symbol);
    state = parseState(row);
  }
  let longLeg = legSnapshot(state, 'long'); let shortLeg = legSnapshot(state, 'short');
  // A winning leg is closed and rebuilt independently. During that short
  // transition, its zero quantity is expected and must not trigger manual mode.
  for (const [side, leg, position] of [['LONG', longLeg, pos.long], ['SHORT', shortLeg, pos.short]]) {
    row = rowFor(row.user_id, row.symbol); state = parseState(row);
    const direction = legName(side); const orderSide = side === 'LONG' ? 'BUY' : 'SELL';
    if (leg.phase === 'close_pending') {
      if (!qty(position)) {
        save(row, {}, { ...legPatch(direction, { Phase: 'reentry_wait', ExpectedQty: 0, CloseOrders: [], ClosePlacedAt: 0, CloseGuardPrice: 0, ReentryAt: Date.now() + COOLDOWN_MS }),
          ...(direction === 'long' ? { expectedLong: 0 } : { expectedShort: 0 }) });
        log(row.user_id, row.symbol, `${side === 'LONG' ? '多头' : '空头'}止盈已成交，旧策略不再重建同方向底仓`, 'success'); continue;
      }
      const fundingRaw = await fundingSince(creds, row, state.fundingStartedAt || state.cycleStartedAt);
      const fundingBySide = allocateFundingCharge(fundingRaw, pos.long.unRealizedProfit, pos.short.unRealizedProfit);
      const currentCosts = await legCostState(creds, row, leg, Math.abs(Number(position.notional || 0)),
        Number(position.unRealizedProfit || 0), direction === 'long' ? fundingBySide.long : fundingBySide.short);
      if (shouldCancelTakeProfit(currentCosts.netPnl)) {
        await cancelLosingTakeProfit(row, creds, direction, leg, currentCosts.netPnl);
        continue;
      }
      if (Date.now() - leg.closePlacedAt >= ORDER_TTL_MS) {
        const replacement = await replaceCloseOrders(row, creds, leg.closeOrders || [], side, leg.closeGuardPrice);
        if (replacement.waiting) { save(row, {}, { ...legPatch(direction, { CloseOrders: replacement.orders }) }); continue; }
        const closeOrders = replacement.orders;
        if (!closeOrders.length) {
          save(row, {}, { ...legPatch(direction, { Phase: 'reentry_wait', CloseOrders: [], ReentryAt: Date.now() + COOLDOWN_MS }) });
          log(row.user_id, row.symbol, `${side === 'LONG' ? '多头' : '空头'}止盈已成交，旧策略不再重建同方向底仓`, 'success'); continue;
        }
        save(row, {}, { ...legPatch(direction, { CloseOrders: closeOrders, ClosePlacedAt: Date.now() }) });
        log(row.user_id, row.symbol, `${side === 'LONG' ? '多头' : '空头'}止盈 Maker 单未成交，已重新挂单`, 'warn'); continue;
      }
      continue;
    }
    if (leg.phase === 'reentry_wait') {
      if (LEGACY_DRAIN_ONLY) continue;
      if (heat.phase === 'overheat' || (direction === 'long' && heat.phase !== 'normal')) continue;
      if (direction === 'short' && shortProtection.active) continue;
      // Older weekend-paused states can have ReentryAt=0; resume their normal cooldown once.
      if (!(Number(leg.reentryAt) > 0)) {
        save(row, {}, { ...legPatch(direction, { ReentryAt: Date.now() + COOLDOWN_MS }) });
        continue;
      }
      if (Date.now() < leg.reentryAt) continue;
      const order = await placeLimit(creds, row, orderSide, side === 'LONG' ? market.bid : market.ask, `roll_${direction}`);
      save(row, {}, { ...legPatch(direction, { Phase: 'reentry_pending', ReentryOrder: order }) });
      log(row.user_id, row.symbol, `已提交${side === 'LONG' ? '多头' : '空头'}滚动底仓`, 'trade'); continue;
    }
    if (leg.phase === 'reentry_pending') {
      if (LEGACY_DRAIN_ONLY || (market.dataFresh && (heat.phase === 'overheat' || (direction === 'long' && heat.phase !== 'normal')
        || (direction === 'short' && shortProtection.active)))) {
        const settled = await cancelAndVerifyOrder(creds, row.symbol, leg.reentryOrder);
        if (!settled.resolved) throw new Error('行情保护期间重建单撤销结果未确认，请核对币安委托');
        const filled = Number(settled.current.executedQty || 0);
        if (filled > 0 && !qty(position)) continue;
        if (filled <= 0 && qty(position)) throw invalid('重建委托与实际仓位不一致，请核对币安仓位', 409);
        const patch = filled > 0
          ? { ...resetLeg(direction, qty(position), Number(position.entryPrice || settled.current.avgPrice || leg.reentryOrder.price)),
            [direction === 'long' ? 'expectedLong' : 'expectedShort']: qty(position) }
          : legPatch(direction, { Phase: 'reentry_wait', ReentryOrder: null, ReentryAt: Date.now() + COOLDOWN_MS });
        save(row, {}, patch);
        log(row.user_id, row.symbol, filled > 0
          ? `${direction === 'long' ? '多头' : '空头'}重建单已有成交，按实际仓位接管并暂停后续新增`
          : `${direction === 'long' ? '上涨过热' : '上涨保护'}：已撤销未成交的${direction === 'long' ? '多头' : '空头'}重建单`,
        'warn', { filled, status: settled.current.status });
        continue;
      }
      const current = await orderState(creds, row.symbol, leg.reentryOrder);
      if (current.status === 'FILLED') {
        const filled = Number(current.executedQty || 0);
        const patch = { ...resetLeg(direction, filled, Number(current.avgPrice || leg.reentryOrder.price || market.last)),
          ...(side === 'LONG' ? { expectedLong: filled } : { expectedShort: filled }) };
        save(row, { additions: sideAdditions({ ...state, ...patch }).longAdditions + sideAdditions({ ...state, ...patch }).shortAdditions }, patch);
        log(row.user_id, row.symbol, `${side === 'LONG' ? '多头' : '空头'}新底仓已成交，开始新的单边周期`, 'trade'); continue;
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
      continue;
    }
  }
  row = rowFor(row.user_id, row.symbol); state = parseState(row);
  longLeg = legSnapshot(state, 'long'); shortLeg = legSnapshot(state, 'short');
  if (LEGACY_DRAIN_ONLY && !qty(pos.long) && !qty(pos.short)
    && longLeg.phase === 'reentry_wait' && shortLeg.phase === 'reentry_wait') {
    save(row, { enabled: 0, status: 'paused' }, { legacyRetired: true, resumeEligible: false });
    return;
  }
  const longManaged = !['reentry_wait', 'close_pending', 'reentry_pending'].includes(longLeg.phase);
  const shortManaged = !['reentry_wait', 'close_pending', 'reentry_pending'].includes(shortLeg.phase);
  if ((longManaged && !qty(pos.long)) || (shortManaged && !qty(pos.short))) throw invalid('检测到手动修改仓位，策略转人工接管', 409);
  if (row.status === 'add_pending' && hasAutoPending(state)) {
    let pendingUpdated = false;
    for (const direction of ['long', 'short']) {
      row = rowFor(row.user_id, row.symbol); state = parseState(row);
      const pending = pendingForSide(state, direction);
      if (pending) pendingUpdated = (await reconcileAutoPendingOrder(row, creds, state, direction, pending)) || pendingUpdated;
    }
    if (pendingUpdated) return;
    row = rowFor(row.user_id, row.symbol); state = parseState(row);
  }
  let pendingLongFill = 0; let pendingShortFill = 0;
  if (row.status === 'add_pending') {
    for (const direction of ['long', 'short']) {
      const pending = pendingForSide(state, direction);
      if (!pending) continue;
      const currentPending = await orderState(creds, row.symbol, pending);
      const filledPending = Number(currentPending.executedQty || 0);
      if (direction === 'long') pendingLongFill = filledPending; else pendingShortFill = filledPending;
    }
  }
  if ((longManaged && !closeEnough(qty(pos.long), longLeg.expectedQty + pendingLongFill))
    || (shortManaged && !closeEnough(qty(pos.short), shortLeg.expectedQty + pendingShortFill))) throw invalid('检测到手动修改仓位，策略转人工接管', 409);
  const comboPnl = Number(pos.long.unRealizedProfit || 0) + Number(pos.short.unRealizedProfit || 0);
  const longNotional = Math.abs(Number(pos.long.notional || 0)); const shortNotional = Math.abs(Number(pos.short.notional || 0));
  const nextLong = { ...longLeg, minPnl: Math.min(longLeg.minPnl, Number(pos.long.unRealizedProfit || 0)) };
  const nextShort = { ...shortLeg, minPnl: Math.min(shortLeg.minPnl, Number(pos.short.unRealizedProfit || 0)) };
  const longSparse = market.dataFresh ? sparseModeDecision({ active: longLeg.sparseMode, side: 'long', entryPrice: Number(pos.long.entryPrice || 0),
    price: market.last, atr1h: market.atr1h, trendDirection: market.trendDirection, trendBars: market.trendBars, trendWeakBars: market.downWeakBars })
    : { active: longLeg.sparseMode, distanceAtr: longLeg.sparseDistanceAtr };
  const shortSparse = market.dataFresh ? sparseModeDecision({ active: shortLeg.sparseMode, side: 'short', entryPrice: Number(pos.short.entryPrice || 0),
    price: market.last, atr1h: market.atr1h, trendDirection: market.trendDirection, trendBars: market.trendBars, trendWeakBars: market.upWeakBars })
    : { active: shortLeg.sparseMode, distanceAtr: shortLeg.sparseDistanceAtr };
  nextLong.sparseMode = longSparse.active; nextLong.sparseDistanceAtr = longSparse.distanceAtr;
  nextShort.sparseMode = shortSparse.active; nextShort.sparseDistanceAtr = shortSparse.distanceAtr;
  // Binance reports hedge-mode funding at symbol level, so charge it once to
  // the leg that is currently closest to being closed. A failed funding query
  // aborts this pass instead of incorrectly treating an unknown charge as zero.
  const fundingRaw = await fundingSince(creds, row, state.fundingStartedAt || state.cycleStartedAt);
  const funding = allocateFundingCharge(fundingRaw, pos.long.unRealizedProfit, pos.short.unRealizedProfit);
  const longCosts = await legCostState(creds, row, nextLong, longNotional, Number(pos.long.unRealizedProfit || 0), funding.long);
  const shortCosts = await legCostState(creds, row, nextShort, shortNotional, Number(pos.short.unRealizedProfit || 0), funding.short);
  const legUpdates = {};
  for (const [direction, leg, sparse, position] of [['long', nextLong, longSparse, pos.long], ['short', nextShort, shortSparse, pos.short]]) {
    const step = sparse.active ? sparseLadderStep(market.last, market.addStep, market.atr1h) : 0;
    Object.assign(legUpdates, legPatch(direction, { SparseMode: sparse.active,
      SparseSince: sparse.active ? (leg.sparseSince || (sparse.enter ? Date.now() : 0)) : 0, SparseStep: step,
      SparseDistanceAtr: sparse.distanceAtr, SparseEntryPrice: Number(position.entryPrice || 0) }));
  }
  for (const [side, leg, position, costs] of [['LONG', nextLong, pos.long, longCosts], ['SHORT', nextShort, pos.short, shortCosts]]) {
    if (LEGACY_DRAIN_ONLY && ['close_pending', 'reentry_pending', 'reentry_wait'].includes(leg.phase)) continue;
    if (!(qty(position) > 0)) continue;
    const direction = legName(side); const recovery = costs.recovery;
    // Existing running positions may carry a peak from the former ATR exit.
    // Arm the new profit trail from the first observation after the upgrade.
    const peak = recovery ? Math.max(direction === 'long' && leg.recoveryExitVersion !== 1 ? 0 : leg.recoveryPeakNetPnl, costs.netPnl) : 0;
    const armed = recovery && peak >= costs.profitTarget;
    const trail = recovery && direction === 'short' ? Math.max(1.5, qty(position) * Number(market.atr || 0) * 1.2) : 0;
    const exit = direction === 'long'
      ? longRecoveryExitState({ recovery, armed, netPnl: costs.netPnl, peakNetPnl: peak, target: costs.profitTarget })
      : recoveryExitState({ recovery, armed, netPnl: costs.netPnl, peakNetPnl: peak, trail, trend: market.trend, target: costs.profitTarget });
    const displayedTrail = recovery && direction === 'long' ? (armed ? Math.max(0, peak - exit.trigger) : 0) : trail;
    const shouldClose = recovery ? exit.shouldClose : costs.netPnl >= costs.profitTarget;
    const patch = { ...legPatch(direction, { MinPnl: leg.minPnl, Recovery: recovery, RecoveryArmed: armed, RecoveryPeakNetPnl: peak,
      RecoveryTrail: displayedTrail, ...(direction === 'long' ? { RecoveryExitVersion: 1 } : {}) }), [`${direction}Costs`]: costs };
    Object.assign(legUpdates, patch);
    if (shouldClose) {
      // A pending add can fill during cancellation. Reconcile it first, then
      // recalculate the position size, net profit and Maker exit price next poll.
      const pendingDirection = pendingForSide(state, 'long') ? 'long' : pendingForSide(state, 'short') ? 'short' : null;
      if (pendingDirection) {
        await cancelTrackedAutoPending(row, creds, state, pendingDirection, '止盈准备');
        return;
      }
      // A user-requested add must settle before an automatic close sizes the
      // position; otherwise the close order could use a stale quantity.
      if (state.manualPending) return;
      if (!LEGACY_DRAIN_ONLY) await cancelKnown(creds, row.symbol, state);
      // A Maker-only trailing exit is a soft trigger: a fixed target-price guard
      // would strand the sell order above the market after a sharp reversal.
      const guardPrice = recovery && direction === 'long' ? 0 : profitGuardPrice(position, side, costs);
      const order = await placeCloseMaker(creds, row, side, qty(position), guardPrice);
      const reason = recovery ? exit.reason : '单边净盈利达到目标';
      save(row, { status: 'active' }, { ...legUpdates, pending: null, pendingLong: null, pendingShort: null,
        ...legPatch(direction, { Phase: 'close_pending', CloseOrders: [order], ClosePlacedAt: Date.now(), CloseGuardPrice: guardPrice }), fundingStartedAt: Date.now(), comboPnl, netPnl: longCosts.netPnl + shortCosts.netPnl, costs: { long: longCosts, short: shortCosts } });
      log(row.user_id, row.symbol, `${side === 'LONG' ? '多头' : '空头'}${reason}，已提交 Maker 止盈单（预估净利 ${costs.netPnl.toFixed(2)}U）`, 'success',
        { ...costs, recoveryPeakNetPnl: peak, recoveryTrigger: direction === 'long' ? exit.trigger : null }); return;
    }
  }
  save(row, {}, { ...legUpdates, comboPnl, netPnl: longCosts.netPnl + shortCosts.netPnl, costs: { long: longCosts, short: shortCosts } });
  // Retired strategy only reconciles existing exposure and protective exits.
}

async function reconcile() {
  if (busy) return; busy = true;
  try {
    const rows = getDb().prepare('SELECT * FROM tradfi_range_strategies WHERE enabled=1').all();
    for (const row of rows) {
      const key = `${String(row.user_id)}|${row.symbol}`;
      if (lockedRows.has(key)) continue;
      activeRows.add(key);
      try {
        try { await reconcileRow(row); }
        catch (err) {
          const latest = rowFor(row.user_id, row.symbol);
          if (err.adoptionRequired) {
            save(latest, { enabled: 0, status: 'adoption_required', last_error: err.message }, { adoptionPositions: err.positions, adoptExisting: false, resumeEligible: false });
            log(row.user_id, row.symbol, err.message, 'warn', { positions: err.positions });
            continue;
          }
          const manual = Number(err.status) === 409;
          save(latest, { enabled: manual ? 0 : latest.enabled, status: manual ? 'manual' : latest.status, last_error: err.message });
          log(row.user_id, row.symbol, err.message, 'error');
        }
      } finally { activeRows.delete(key); }
    }
  } finally { busy = false; }
}
function start() { if (timer) return; timer = setInterval(() => { void reconcile(); }, POLL_MS); timer.unref?.(); void reconcile(); }

module.exports = { start, reconcile, status, enable, disable, closeAll, manualAddPreview, manualAdd, closeClientId, closeOrderRemaining, additionDecision, countedAdditions,
  marketState, closedKlines, atr, ladderStep, sparseLadderStep, sparseModeDecision, sparseGroupCount, sparseGroupMargin, sparseGroupTrigger,
  ladderMargin, defaultConfig, costState, scalpProfitTarget, commissionRate, isCommodityWeekendMode, orderFillState, marketDataFreshness,
  profitGuardPrice, allocateFundingCharge, positionAdoptionSummary, adoptedLegState, strategyConfig, requestedConfig, resumedConfig, restartState,
  isPostOnlyReject, isRequestTimeout, isCanceledWithoutFill, recoveryExitState, ignoreStaleStrategySave, SYMBOLS, MAX_ADDITIONS, MAX_LONG_ADDITIONS, MAX_SHORT_ADDITIONS,
  MARGIN, LEVERAGE, MAX_MARGIN, MAX_GOLD_MARGIN, MAX_LEVERAGE, positionSyncStatus, syncPositions, syncLegState,
  quantitySyncSummary, canCancelPendingForPositionSync, canManualAddPosition, pendingForSide, pendingStatePatch, autoPendingOrders, availableAdditionDirection };
