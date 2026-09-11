'use strict';

const { directionStateZh, eventZh, reasonZh, s9ReasonZh, statusZh, strategyNameZh } = require('./strategyDisplayZh');

const CATEGORY_POSITION = 'POSITION';
const CATEGORY_SYSTEM = 'SYSTEM';

const SYSTEM_EVENT_TYPES = new Set([
  'STRATEGY_NO_TRADE',
  'STRATEGY_CANDIDATE',
  'STRATEGY_SELECTED',
  'S9_NO_TRADE',
  'S9_CANDIDATE',
  'S9_DIRECTION',
  'TRADE_INTENT_CREATED',
  'ORDER_INTENT_CREATED',
  'S9_TRADE_INTENT_CREATED',
  'S9_ORDER_INTENT_CREATED',
  'ENGINE_START',
  'ENGINE_STARTED',
  'ENGINE_PAUSE',
  'ENGINE_PAUSED',
  'ENGINE_LOCK',
  'S5_RISK_CHANGED',
  'S6_BLOCK',
  'S6_LOCK',
  'STARTUP_RECOVERY_STARTED',
  'STARTUP_RECOVERY_READY',
  'STARTUP_RECOVERY_FAILED',
  'RECONCILIATION_MATCHED',
  'S9_MARKET_DATA_CONNECTED',
  'S9_MARKET_DATA_DISCONNECTED',
  'S9_MARKET_DATA_CONNECTING',
  'S9_MARKET_DATA_DEGRADED',
  'S9_MARKET_DATA_READY',
  'S9_FEE_READY',
  'S9_FEE_UNAVAILABLE',
  'S9_PRESUBMIT_REJECTED',
  'S9_PRESUBMIT_PASSED',
  'S9_ORDERBOOK_STALE',
  'S9_TRADES_STALE',
  'S9_IMPLEMENTATION_NOT_READY',
  'S9_DEMO_PREFLIGHT_NOT_READY',
  'SYMBOL_OWNERSHIP_CONFLICT',
  'CONFIG_INVALID',
  'CONFIG_LOADED',
  'MARKET_DATA_CONNECTED',
  'MARKET_DATA_DISCONNECTED',
  'TRADE_INTENT_EXPIRED',
  'S9_TRADE_INTENT_EXPIRED',
  'RECONCILIATION_NOT_MATCHED',
]);

const POSITION_EVENT_TYPES = new Set([
  'POSITION_OPENED',
  'POSITION_UPDATED',
  'POSITION_REDUCED',
  'POSITION_CLOSED',
  'OWNERSHIP_CREATED',
  'OWNERSHIP_UPDATED',
  'OWNERSHIP_RELEASED',
  'PROTECTIVE_STOP_CREATED',
  'PROTECTIVE_STOP_SUBMITTED',
  'PROTECTIVE_STOP_PLACED',
  'PROTECTIVE_STOP_ACTIVE',
  'PROTECTIVE_STOP_AMENDED',
  'PROTECTIVE_STOP_TRIGGERED',
  'PROTECTIVE_STOP_CANCEL_REQUESTED',
  'PROTECTIVE_STOP_CANCELLED',
  'PROTECTIVE_STOP_FAILED',
  'PROTECTIVE_STOP_CLEANUP_FAILED',
  'ORPHAN_PROTECTIVE_STOP',
  'ORPHAN_PROTECTIVE_STOP_CLEANUP_FAILED',
  'TAKE_PROFIT_TRIGGERED',
  'TIME_EXIT_TRIGGERED',
  'DIRECTION_FLIP_EXIT_TRIGGERED',
  'EXIT_SUBMITTED',
  'EXIT_PARTIALLY_FILLED',
  'EXIT_FILLED',
  'DUST_RESIDUAL_POSITION',
  'UNRESOLVED_DUST_POSITION',
  'POSITION_QTY_MISMATCH',
  'POSITION_SIDE_MISMATCH',
]);

const FILL_EVENT_TYPES = new Set([
  'ORDER_PARTIALLY_FILLED',
  'ORDER_FILLED',
  'PARTIAL_FILLED',
  'PARTIALLY_FILLED',
  'FILLED',
  'EXIT_PARTIALLY_FILLED',
  'EXIT_FILLED',
]);

const OPENING_NO_FILL_TYPES = new Set([
  'ORDER_SUBMITTED',
  'ORDER_REJECTED',
  'ORDER_CANCELLED',
  'ORDER_CANCEL_FAILED',
  'ORDER_CANCEL_REQUESTED',
  'ORDER_EXPIRED',
]);

const QTY_KEYS = [
  'filled_quantity',
  'accFillSz',
  'cumFillSz',
  'fill_sz',
  'lastFillSz',
  'filled_contracts',
  'cumulative_filled_qty',
  'owned_contracts',
  'owned_remaining_contracts',
  'owned_qty',
  'covered_contracts',
];
const TARGET_KEYS = [
  'target_sz',
  'requested_contracts',
  'final_okx_sz',
  'okx_sz',
  'origSz',
  'sz',
  'intended_contracts',
  'target_contracts',
];

function norm(value) {
  return String(value || '').trim();
}

function detailsOf(event) {
  return event && event.details && typeof event.details === 'object' ? event.details : {};
}

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fmtQty(value) {
  if (value == null) return '';
  if (Math.abs(value - Math.trunc(value)) < 1e-9) return String(Math.trunc(value));
  return String(value);
}

function pickQty(event, keys) {
  const details = detailsOf(event);
  for (const key of keys) {
    const direct = num(event[key]);
    if (direct != null) return direct;
    const nested = num(details[key]);
    if (nested != null) return nested;
  }
  return null;
}

function canonicalInstrumentId(symbol) {
  const raw = norm(symbol);
  if (!raw) return '';
  const compact = raw.toUpperCase().replace(/\s+/g, '');
  if (['BTC-USDT-SWAP', 'BTC/USDT:USDT', 'BTCUSDT', 'BTC-USDT', 'BTC/USDT'].includes(compact)) {
    return 'BTC-USDT-SWAP';
  }
  if (compact.endsWith('-SWAP')) return compact;
  if (compact.includes('/')) return `${compact.split('/')[0]}-USDT-SWAP`;
  return raw;
}

function displaySymbol(symbol) {
  return canonicalInstrumentId(symbol) || '—';
}

function hasRealPositionId(event) {
  const pid = norm(event.position_id || detailsOf(event).position_id);
  if (!pid) return false;
  return !['NONE', 'NULL', 'N/A', '0', '-'].includes(pid.toUpperCase());
}

function isReduceOnly(event) {
  const details = detailsOf(event);
  const flag = event.reduce_only != null ? event.reduce_only : details.reduce_only;
  if (flag === true || flag === 'true' || flag === 'TRUE' || flag === 1 || flag === '1') return true;
  const purpose = norm(event.purpose || details.purpose).toLowerCase();
  return ['exit', 'take_profit', 'time_exit', 'stop_loss', 'direction_flip'].includes(purpose);
}

function filledQty(event) {
  return pickQty(event, QTY_KEYS);
}

function classifyDisplayCategory(event) {
  const et = norm(event && event.event_type).toUpperCase();
  const fill = filledQty(event || {});
  const fillPos = fill != null && fill > 0;
  if (SYSTEM_EVENT_TYPES.has(et)) return CATEGORY_SYSTEM;
  if (OPENING_NO_FILL_TYPES.has(et)) {
    if (isReduceOnly(event || {})) return CATEGORY_POSITION;
    return fillPos ? CATEGORY_POSITION : CATEGORY_SYSTEM;
  }
  if (FILL_EVENT_TYPES.has(et)) {
    if (et === 'ORDER_FILLED' || et === 'FILLED' || et === 'EXIT_FILLED') return CATEGORY_POSITION;
    if (fill == null || fill > 0) return CATEGORY_POSITION;
    return CATEGORY_SYSTEM;
  }
  if (POSITION_EVENT_TYPES.has(et)) return CATEGORY_POSITION;
  if (et === 'RECONCILIATION_MISMATCH') {
    return hasRealPositionId(event) ? CATEGORY_POSITION : CATEGORY_SYSTEM;
  }
  if (hasRealPositionId(event) && fillPos) return CATEGORY_POSITION;
  return CATEGORY_SYSTEM;
}

function reasonCodes(event) {
  const raw = event.reason_codes;
  let codes = [];
  if (typeof raw === 'string') {
    codes = raw.split(/[|;]/).map((x) => x.trim()).filter(Boolean);
  } else if (Array.isArray(raw)) {
    codes = raw.map((x) => String(x).trim()).filter(Boolean);
  }
  if (!codes.length && event.reason_code) {
    codes = [String(event.reason_code).trim()].filter(Boolean);
  }
  return codes;
}

function qtyLine(filled, target) {
  const ftxt = fmtQty(filled);
  const ttxt = fmtQty(target);
  if (ftxt && ttxt && ftxt !== ttxt) return `已成交 ${ftxt} 张，目标 ${ttxt} 张`;
  if (ftxt) return `已成交 ${ftxt} 张`;
  if (ttxt) return `目标 ${ttxt} 张`;
  return '';
}

const SYSTEM_HARD_BLOCKERS = new Set([
  'ACCOUNT_CONTEXT_NOT_READY',
  'OWNER_NOT_READY',
  'CREDENTIAL_NOT_FOUND',
  'ACCOUNT_ENV_NOT_READY',
  'FEE_API_TIMEOUT',
  'FEE_API_ERROR',
  'FEE_RESPONSE_INVALID',
  'S9_COST_DATA_UNAVAILABLE',
  'S9_FEE_UNAVAILABLE',
  'S9_DATA_1M_STALE',
  'S9_DATA_5M_STALE',
  'S9_MARKET_DATA_DISCONNECTED',
  'S9_MARKET_DATA_CONNECTING',
  'S9_MARKET_DATA_DEGRADED',
  'MARKET_DATA_STALE',
  'MARKET_DATA_WARMING_UP',
  'S9_ORDERBOOK_STALE',
  'S9_TRADES_STALE',
  'S9_DATA_DEGRADED',
  'STARTUP_RECOVERY_FAILED',
  'EXECUTION_RECOVERY_FAILED',
  'EXECUTION_RECOVERY_PENDING',
  'RECONCILIATION_NOT_MATCHED',
  'RECONCILIATION_MISMATCH',
  'S9_IMPLEMENTATION_NOT_READY',
  'S9_DEMO_PREFLIGHT_NOT_READY',
  'ENGINE_OWNER_NOT_BOUND',
  'ALPHA_EXECUTION_USER_NOT_READY',
]);

function formatNoTradeMessage(name, sym, codes, extras) {
  const reasons = codes.map((c) => (String(c).startsWith('S9_') ? s9ReasonZh(c, extras) : reasonZh(c)));
  const reasonBlock = reasons.length ? `原因：\n${reasons.join('；\n')}` : '';
  if (codes.some((c) => SYSTEM_HARD_BLOCKERS.has(c))) {
    return reasonBlock ? `系统尚未具备交易条件\n${reasonBlock}` : '系统尚未具备交易条件';
  }
  const head = [name || '策略', sym, '本轮不交易'].filter(Boolean).join(' · ');
  return reasonBlock ? `${head}\n${reasonBlock}` : head;
}

function formatUserMessage(event) {
  const et = norm(event.event_type).toUpperCase();
  const name = strategyNameZh(event.strategy_id);
  const sym = displaySymbol(event.symbol);
  const codes = reasonCodes(event);
  const reasons = codes.map((c) => reasonZh(c));
  const reasonBlock = reasons.length ? `原因：\n${reasons.join('；\n')}` : '';
  const fill = filledQty(event);
  const target = pickQty(event, TARGET_KEYS);
  const qtyBit = qtyLine(fill, target);
  const reduce = isReduceOnly(event);
  const covered = pickQty(event, ['covered_contracts', 'sz', 'owned_contracts']);

  if (et === 'STRATEGY_NO_TRADE' || et === 'S9_NO_TRADE') {
    const details = detailsOf(event);
    return formatNoTradeMessage(name, sym, codes, {
      direction_state: event.s9_direction_state || details.s9_direction_state,
      adx_insufficient: Boolean(event.s9_adx_insufficient || details.s9_adx_insufficient),
      side: event.direction || details.direction,
    });
  }
  if (et === 'S9_DIRECTION') {
    const details = detailsOf(event);
    return directionStateZh(event.s9_direction_state || details.s9_direction_state);
  }
  if (et === 'ORDER_SUBMITTED') {
    return reduce ? '平仓订单已提交，等待成交' : '开仓订单已提交，等待成交';
  }
  if (et === 'ORDER_REJECTED' || et === 'ORDER_CANCELLED' || et === 'ORDER_EXPIRED') {
    if (reduce) {
      if (et === 'ORDER_REJECTED') return '平仓订单已拒绝';
      if (et === 'ORDER_EXPIRED') return '平仓订单已过期';
      return '平仓订单已取消';
    }
    if (et === 'ORDER_REJECTED') return '开仓订单已拒绝，未形成仓位';
    if (et === 'ORDER_EXPIRED') return '开仓订单已过期，未形成仓位';
    return '开仓订单已取消，未形成仓位';
  }
  if (['ORDER_PARTIALLY_FILLED', 'PARTIAL_FILLED', 'PARTIALLY_FILLED', 'EXIT_PARTIALLY_FILLED'].includes(et)) {
    const prefix = reduce || et.startsWith('EXIT') ? '平仓部分成交' : '开仓部分成交';
    return qtyBit ? `${prefix}：${qtyBit}` : prefix;
  }
  if (['ORDER_FILLED', 'FILLED', 'EXIT_FILLED'].includes(et)) {
    if (reduce || et.startsWith('EXIT')) {
      return fill != null ? `平仓完成：共成交 ${fmtQty(fill)} 张` : '平仓已成交';
    }
    return fill != null ? `仓位建立完成：共成交 ${fmtQty(fill)} 张` : '仓位建立完成';
  }
  if (et === 'POSITION_OPENED') return fill != null ? `仓位已建立：${fmtQty(fill)} 张` : '仓位已建立';
  if (et === 'POSITION_CLOSED') return '仓位已全部平仓';
  if (et === 'POSITION_REDUCED') return fill != null ? `仓位已减少：剩余 ${fmtQty(fill)} 张` : '仓位已减少';
  if (et === 'OWNERSHIP_RELEASED') return '仓位及关联订单已清理完成，交易对已释放';
  if (['PROTECTIVE_STOP_ACTIVE', 'PROTECTIVE_STOP_CREATED', 'PROTECTIVE_STOP_PLACED', 'PROTECTIVE_STOP_SUBMITTED'].includes(et)) {
    return covered != null ? `保护止损已生效：覆盖 ${fmtQty(covered)} 张仓位` : '保护止损已建立';
  }
  if (et === 'PROTECTIVE_STOP_AMENDED') {
    return covered != null ? `保护止损覆盖数量已调整：${fmtQty(covered)} 张` : '保护止损覆盖数量已调整';
  }
  if (et === 'PROTECTIVE_STOP_TRIGGERED') return '保护止损已触发';
  if (et === 'PROTECTIVE_STOP_CANCEL_REQUESTED') return '仓位已平，正在清理遗留保护止损';
  if (et === 'PROTECTIVE_STOP_CANCELLED') return '保护止损已取消';
  if (et === 'TAKE_PROFIT_TRIGGERED') return '达到 1.5R 止盈条件，正在执行平仓';
  if (et === 'TIME_EXIT_TRIGGERED') return '持仓已达到最长持有时间，正在执行平仓';
  if (et === 'DIRECTION_FLIP_EXIT_TRIGGERED') return '5分钟方向发生反转，正在执行平仓';
  if (et === 'RECONCILIATION_MISMATCH') {
    const local = pickQty(event, ['owned_contracts', 'local_qty', 'local_contracts']);
    const exch = pickQty(event, ['exchange_qty', 'exchange_contracts', 'exchange_net_position_contracts']);
    if (local != null && exch != null) {
      return `仓位数量与交易所不一致：本地 ${fmtQty(local)} 张，交易所 ${fmtQty(exch)} 张`;
    }
    return hasRealPositionId(event) ? '仓位数量与交易所不一致' : '当前交易状态对账未一致';
  }
  if (et === 'RECONCILIATION_MATCHED') return '交易状态对账一致';
  if (et === 'SYMBOL_OWNERSHIP_CONFLICT') return '当前交易对仍由其他策略持有，已阻止新的开仓';
  if (et === 'S9_ORDERBOOK_STALE') return '盘口数据已过期';

  const parts = [eventZh(et), name, sym !== '—' ? sym : ''].filter(Boolean);
  const head = parts.join(' · ');
  if (reasonBlock) return `${head}\n${reasonBlock}`;
  const decision = norm(event.decision);
  if (decision && decision.toUpperCase() !== 'NONE') {
    const zh = statusZh(decision);
    if (zh) return `${head} · ${zh}`;
  }
  return head;
}

function annotateEvent(event) {
  const row = Object.assign({}, event || {});
  row.symbol_display = displaySymbol(row.symbol);
  row.display_category = classifyDisplayCategory(row);
  row.display_message = formatUserMessage(row);
  return row;
}

function annotateEvents(events) {
  return (events || []).map((ev) => annotateEvent(ev));
}

module.exports = {
  CATEGORY_POSITION,
  CATEGORY_SYSTEM,
  classifyDisplayCategory,
  formatUserMessage,
  displaySymbol,
  canonicalInstrumentId,
  annotateEvent,
  annotateEvents,
  filledQty,
  isPositionEvent: (event) => classifyDisplayCategory(typeof event === 'string' ? { event_type: event } : event) === CATEGORY_POSITION,
};
