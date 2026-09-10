import type { WhaleAiEngineEvent } from '@/api';

const BUS_TO_TYPE: Record<string, string> = {
  'engine.status:RUNNING': 'ENGINE_START',
  'engine.status:PAUSED': 'ENGINE_PAUSE',
  'engine.status:LOCKED': 'ENGINE_LOCK',
  'strategy.active.changed': 'STRATEGY_SELECTED',
  'strategy.switch': 'STRATEGY_SELECTED',
  'trade_intent.created': 'TRADE_INTENT_CREATED',
  'order_intent.created': 'ORDER_INTENT_CREATED',
  'position.opened': 'POSITION_OPENED',
  'position.reduced': 'POSITION_REDUCED',
  'position.closed': 'POSITION_CLOSED',
  'risk.budget.updated': 'S5_RISK_CHANGED',
  'reconciliation.matched': 'RECONCILIATION_MATCHED',
  'reconciliation.mismatch': 'RECONCILIATION_MISMATCH',
  'protective_stop.submitted': 'PROTECTIVE_STOP_SUBMITTED',
  'protective_stop.active': 'PROTECTIVE_STOP_ACTIVE',
  'protective_stop.amended': 'PROTECTIVE_STOP_AMENDED',
  'protective_stop.cancelled': 'PROTECTIVE_STOP_CANCELLED',
  'protective_stop.failed': 'PROTECTIVE_STOP_FAILED',
  'startup_recovery.started': 'STARTUP_RECOVERY_STARTED',
  'startup_recovery.ready': 'STARTUP_RECOVERY_READY',
  'startup_recovery.failed': 'STARTUP_RECOVERY_FAILED',
};

const ORDER_STATUS: Record<string, string> = {
  SUBMITTED: 'ORDER_SUBMITTED',
  PARTIAL: 'ORDER_PARTIALLY_FILLED',
  PARTIALLY_FILLED: 'ORDER_PARTIALLY_FILLED',
  FILLED: 'ORDER_FILLED',
  CANCEL_REQUESTED: 'ORDER_CANCEL_REQUESTED',
  CANCELLED: 'ORDER_CANCELLED',
  CANCELED: 'ORDER_CANCELLED',
  CANCEL_FAILED: 'ORDER_CANCEL_FAILED',
  REJECTED: 'ORDER_REJECTED',
  RISK_REJECTED: 'ORDER_REJECTED',
  GATEWAY_ERROR: 'ORDER_REJECTED',
};

export { isPositionEvent } from '@/utils/eventLogDisplay';

export function severityToLvl(severity?: string): 'info' | 'success' | 'warn' | 'error' {
  const s = String(severity || 'info').toLowerCase();
  if (s === 'success' || s === 'warn' || s === 'error' || s === 'info') return s;
  return 'info';
}

export function mapBusToEngineEvent(msg: {
  eventId?: string;
  eventType?: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
}): WhaleAiEngineEvent | null {
  const payload = (msg.payload || {}) as Record<string, unknown>;
  const busType = String(msg.eventType || '');
  const decision = String(payload.decision || payload.result || payload.last_decision || '');
  const status = String(payload.status || '').toUpperCase();
  let eventType = '';
  if (busType === 'engine.status') {
    eventType = BUS_TO_TYPE[`engine.status:${String(payload.state || '').toUpperCase()}`] || '';
  } else if (busType === 'strategy.decision') {
    eventType = decision === 'ALLOW' ? 'STRATEGY_CANDIDATE' : 'STRATEGY_NO_TRADE';
  } else if (busType === 'order_intent.updated') {
    eventType = ORDER_STATUS[status] || '';
  } else if (busType === 'system.safety.updated') {
    const level = Number(payload.level || 0);
    if (level >= 3) eventType = 'S6_LOCK';
    else if (level >= 2) eventType = 'S6_BLOCK';
  } else {
    eventType = BUS_TO_TYPE[busType] || '';
  }
  if (!eventType) return null;
  const codes = Array.isArray(payload.reason_codes)
    ? payload.reason_codes.map((x) => String(x))
    : payload.reason_code
      ? [String(payload.reason_code)]
      : [];
  return {
    event_id: String(msg.eventId || ''),
    occurred_at: String(msg.timestamp || payload.ts || new Date().toISOString()),
    event_type: eventType,
    severity:
      eventType === 'ORDER_FILLED' || eventType === 'POSITION_OPENED'
        ? 'success'
        : eventType.includes('FAIL') || eventType === 'S6_LOCK' || eventType === 'ORDER_REJECTED'
          ? 'error'
          : eventType === 'STRATEGY_NO_TRADE' || eventType === 'S6_BLOCK'
            ? 'warn'
            : 'info',
    strategy_id: String(
      payload.strategy_id || payload.origin_strategy_id || payload.active_strategy_id || '',
    ),
    symbol: String(payload.symbol || payload.instId || ''),
    direction: String(payload.direction || payload.direction_candidate || payload.side || ''),
    decision,
    reason_code: codes[0] || '',
    reason_codes: codes,
    source_closed_candle_timestamp: String(payload.source_closed_candle_timestamp || ''),
    trade_intent_id: String(payload.trade_intent_id || payload.intent_id || ''),
    order_intent_id: String(payload.order_intent_id || ''),
    position_id: String(payload.position_id || ''),
    signal_key: String(payload.signal_key || ''),
    message: String(payload.message || ''),
    details: payload,
    source: 'SERVER',
  };
}
