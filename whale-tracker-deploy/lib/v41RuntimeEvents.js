/**
 * Node-side structured runtime events (recovery / protective stop / local backup).
 * Observability only — never changes order routing.
 */
const crypto = require('crypto');
const { getDb } = require('./db');

const SECRET_KEYS = new Set([
  'api_secret',
  'apisecret',
  'secret',
  'passphrase',
  'api_passphrase',
  'authorization',
  'cookie',
  'jwt',
  'access_token',
  'refresh_token',
  'id_token',
  'session',
  'session_cookie',
  'apikey',
  'api_key',
  'password',
  'credential',
  'credentials',
  'private_key',
]);

const DEDUPE_TYPES = new Set(['STRATEGY_NO_TRADE']);

const ORDER_STATUS_TYPE = {
  SUBMITTED: 'ORDER_SUBMITTED',
  PARTIAL: 'ORDER_PARTIALLY_FILLED',
  PARTIALLY_FILLED: 'ORDER_PARTIALLY_FILLED',
  FILLED: 'ORDER_FILLED',
  SIM_FILLED: 'ORDER_FILLED',
  CANCEL_REQUESTED: 'ORDER_CANCEL_REQUESTED',
  CANCELLED: 'ORDER_CANCELLED',
  CANCELED: 'ORDER_CANCELLED',
  CANCEL_FAILED: 'ORDER_CANCEL_FAILED',
  REJECTED: 'ORDER_REJECTED',
  RISK_REJECTED: 'ORDER_REJECTED',
  GATEWAY_ERROR: 'ORDER_REJECTED',
};

const STOP_STATUS_TYPE = {
  SUBMITTED: 'PROTECTIVE_STOP_SUBMITTED',
  ACTIVE: 'PROTECTIVE_STOP_ACTIVE',
  AMENDED: 'PROTECTIVE_STOP_AMENDED',
  CANCELLED: 'PROTECTIVE_STOP_CANCELLED',
  CANCELED: 'PROTECTIVE_STOP_CANCELLED',
  FAILED: 'PROTECTIVE_STOP_FAILED',
};

function nowIso() {
  return new Date().toISOString();
}

function newEventId() {
  const raw = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  return `node_${raw}`;
}

function hasEventIdNamespace(eventId) {
  const raw = norm(eventId);
  return raw.startsWith('py_') || raw.startsWith('node_') || raw.startsWith('node:');
}

function resolveEventId(eventId, allowInjected) {
  const raw = norm(eventId);
  if (!raw) return newEventId();
  if (hasEventIdNamespace(raw)) return raw;
  if (allowInjected) return raw;
  return newEventId();
}

function canonQty(value) {
  if (value == null || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return norm(value);
  return Number.isInteger(n) ? String(n) : String(n);
}

const ORDER_EXEC_TYPES = new Set([
  'ORDER_SUBMITTED',
  'ORDER_PARTIALLY_FILLED',
  'ORDER_FILLED',
  'ORDER_CANCEL_REQUESTED',
  'ORDER_CANCELLED',
  'ORDER_CANCEL_FAILED',
  'ORDER_REJECTED',
]);

function pickDetails(event) {
  return event && event.details && typeof event.details === 'object' ? event.details : {};
}

function pickFillId(event) {
  const d = pickDetails(event);
  return norm(
    event.fill_id ||
      event.exchange_fill_id ||
      event.tradeId ||
      d.fill_id ||
      d.exchange_fill_id ||
      d.tradeId,
  );
}

function pickExchangeOrderId(event) {
  const d = pickDetails(event);
  return norm(event.exchange_order_id || d.exchange_order_id);
}

function pickFillQty(event) {
  const d = pickDetails(event);
  return canonQty(
    event.accFillSz ??
      event.filled_contracts ??
      event.cumulative_filled_qty ??
      event.filled_quantity ??
      d.accFillSz ??
      d.filled_contracts ??
      d.cumulative_filled_qty ??
      d.filled_quantity ??
      d.owned_contracts ??
      d.covered_contracts,
  );
}

function pickExecutionState(event) {
  const d = pickDetails(event);
  return norm(event.execution_state || event.status || d.status || d.execution_state).toUpperCase();
}

function norm(value) {
  return String(value || '').trim();
}

function normalizeReasonCodes(codes) {
  if (codes == null) return [];
  if (typeof codes === 'string') {
    return [...new Set(codes.split(/[|,;]/).map((x) => x.trim()).filter(Boolean))].sort();
  }
  if (Array.isArray(codes)) {
    return [...new Set(codes.map((x) => String(x).trim()).filter(Boolean))].sort();
  }
  return [];
}

function reasonSignature(codes) {
  return normalizeReasonCodes(codes).join('|');
}

function noTradeKey(row) {
  return [
    norm(row.strategy_id).toUpperCase(),
    norm(row.symbol).toUpperCase(),
    norm(row.source_closed_candle_timestamp),
    norm(row.decision || 'NO_TRADE').toUpperCase(),
    reasonSignature(row.reason_codes),
  ].join('|');
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const kn = String(key).trim().toLowerCase().replace(/-/g, '_');
    if (SECRET_KEYS.has(kn) || kn.endsWith('_secret') || kn.endsWith('_passphrase')) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = redactSecrets(item);
    }
  }
  return out;
}

function ensureTable(database) {
  const db = database || getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS v41_runtime_events (
      event_id TEXT PRIMARY KEY,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      strategy_id TEXT,
      symbol TEXT,
      direction TEXT,
      decision TEXT,
      reason_code TEXT,
      reason_codes_json TEXT,
      source_closed_candle_timestamp TEXT,
      trade_intent_id TEXT,
      order_intent_id TEXT,
      position_id TEXT,
      signal_key TEXT,
      message TEXT,
      details_json TEXT,
      reason_signature TEXT,
      no_trade_key TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_v41_runtime_events_occurred
      ON v41_runtime_events(occurred_at DESC, event_id DESC);
    CREATE INDEX IF NOT EXISTS idx_v41_runtime_events_type
      ON v41_runtime_events(event_type, occurred_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_v41_runtime_events_no_trade
      ON v41_runtime_events(no_trade_key)
      WHERE event_type = 'STRATEGY_NO_TRADE'
        AND no_trade_key IS NOT NULL
        AND no_trade_key != '';
  `);
  return db;
}

function rowFromDb(row) {
  if (!row) return null;
  let codes = [];
  try {
    const parsed = JSON.parse(row.reason_codes_json || '[]');
    if (Array.isArray(parsed)) codes = parsed;
  } catch {
    codes = [];
  }
  let details = {};
  try {
    const parsed = JSON.parse(row.details_json || '{}');
    if (parsed && typeof parsed === 'object') details = parsed;
  } catch {
    details = {};
  }
  return {
    event_id: row.event_id,
    occurred_at: row.occurred_at,
    created_at: row.created_at,
    event_type: row.event_type,
    severity: row.severity,
    strategy_id: row.strategy_id,
    symbol: row.symbol,
    direction: row.direction,
    decision: row.decision,
    reason_code: row.reason_code,
    reason_codes: codes,
    reason_codes_json: row.reason_codes_json,
    source_closed_candle_timestamp: row.source_closed_candle_timestamp,
    trade_intent_id: row.trade_intent_id,
    order_intent_id: row.order_intent_id,
    position_id: row.position_id,
    signal_key: row.signal_key,
    message: row.message,
    details,
    details_json: row.details_json,
    reason_signature: row.reason_signature,
    no_trade_key: row.no_trade_key,
    source: 'node',
  };
}

function normalizeRow(input, options = {}) {
  const codes = normalizeReasonCodes(input.reason_codes || input.reason_codes_json);
  const eventType = norm(input.event_type);
  const row = {
    event_id: resolveEventId(input.event_id, options.allowInjected || input.allow_injected_event_id),
    occurred_at: norm(input.occurred_at) || nowIso(),
    created_at: nowIso(),
    event_type: eventType,
    severity: norm(input.severity) || 'info',
    strategy_id: norm(input.strategy_id),
    symbol: norm(input.symbol),
    direction: norm(input.direction),
    decision: norm(input.decision),
    reason_code: codes[0] || norm(input.reason_code),
    reason_codes: codes,
    source_closed_candle_timestamp: norm(input.source_closed_candle_timestamp),
    trade_intent_id: norm(input.trade_intent_id),
    order_intent_id: norm(input.order_intent_id),
    position_id: norm(input.position_id),
    signal_key: norm(input.signal_key),
    message: norm(input.message) || `${eventType} · ${norm(input.strategy_id) || '—'} · ${norm(input.symbol) || '—'}`,
    details: redactSecrets(input.details && typeof input.details === 'object' ? input.details : {}),
    reason_signature: reasonSignature(codes),
    no_trade_key: '',
  };
  if (DEDUPE_TYPES.has(eventType)) {
    row.no_trade_key = noTradeKey(row);
  }
  return row;
}

function append(input, database, options = {}) {
  const db = ensureTable(database);
  const row = normalizeRow(input, options);
  try {
    db.prepare(
      `INSERT INTO v41_runtime_events(
        event_id, occurred_at, created_at, event_type, severity,
        strategy_id, symbol, direction, decision, reason_code,
        reason_codes_json, source_closed_candle_timestamp,
        trade_intent_id, order_intent_id, position_id, signal_key,
        message, details_json, reason_signature, no_trade_key
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      row.event_id,
      row.occurred_at,
      row.created_at,
      row.event_type,
      row.severity,
      row.strategy_id,
      row.symbol,
      row.direction,
      row.decision,
      row.reason_code,
      JSON.stringify(row.reason_codes),
      row.source_closed_candle_timestamp,
      row.trade_intent_id,
      row.order_intent_id,
      row.position_id,
      row.signal_key,
      row.message,
      JSON.stringify(row.details),
      row.reason_signature,
      row.no_trade_key,
    );
    return rowFromDb(db.prepare('SELECT * FROM v41_runtime_events WHERE event_id = ?').get(row.event_id));
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) return null;
    throw err;
  }
}

function list(filters = {}, database) {
  const db = ensureTable(database);
  const clauses = ['1=1'];
  const args = [];
  if (filters.before) {
    const beforeId = norm(filters.before_event_id);
    if (beforeId) {
      clauses.push('(occurred_at < ? OR (occurred_at = ? AND event_id < ?))');
      args.push(String(filters.before), String(filters.before), beforeId);
    } else {
      clauses.push('occurred_at < ?');
      args.push(String(filters.before));
    }
  }
  if (filters.after) {
    const afterId = norm(filters.after_event_id);
    if (afterId) {
      clauses.push('(occurred_at > ? OR (occurred_at = ? AND event_id > ?))');
      args.push(String(filters.after), String(filters.after), afterId);
    } else {
      clauses.push('occurred_at > ?');
      args.push(String(filters.after));
    }
  }
  if (filters.strategy_id) {
    clauses.push('UPPER(strategy_id) = UPPER(?)');
    args.push(String(filters.strategy_id));
  }
  if (filters.symbol) {
    clauses.push('UPPER(symbol) = UPPER(?)');
    args.push(String(filters.symbol));
  }
  if (filters.event_type) {
    clauses.push('event_type = ?');
    args.push(String(filters.event_type));
  }
  if (filters.severity) {
    clauses.push('severity = ?');
    args.push(String(filters.severity));
  }
  const limit = Math.max(1, Math.min(Number(filters.limit) || 200, 500));
  args.push(limit);
  const rows = db
    .prepare(
      `SELECT * FROM v41_runtime_events
       WHERE ${clauses.join(' AND ')}
       ORDER BY occurred_at DESC, event_id DESC
       LIMIT ?`,
    )
    .all(...args);
  return rows.map(rowFromDb);
}

function logicalKey(event) {
  const type = norm(event && event.event_type);
  const oid = norm(event && event.order_intent_id);
  // Semantic fingerprint for Python/Node dual-write of the SAME fill fact.
  // Never collapse PARTIAL 4 vs PARTIAL 7, or type+oid alone.
  if (!type || !oid || !ORDER_EXEC_TYPES.has(type)) {
    return '';
  }
  const fillId = pickFillId(event);
  if (fillId) {
    return `${type}|order|${oid}|fillid|${fillId}`;
  }
  return [
    type,
    'order',
    oid,
    pickExchangeOrderId(event),
    pickExecutionState(event),
    pickFillQty(event),
  ].join('|');
}

function compareEventDesc(a, b) {
  const ta = String((a && a.occurred_at) || '');
  const tb = String((b && b.occurred_at) || '');
  if (ta !== tb) return ta < tb ? 1 : -1;
  const ia = String((a && a.event_id) || '');
  const ib = String((b && b.event_id) || '');
  if (ia !== ib) return ia < ib ? 1 : -1;
  return 0;
}

function matchesCursor(event, filters = {}) {
  const before = norm(filters.before);
  const beforeId = norm(filters.before_event_id);
  const after = norm(filters.after);
  const afterId = norm(filters.after_event_id);
  const occurred = String((event && event.occurred_at) || '');
  const id = String((event && event.event_id) || '');
  if (before) {
    if (occurred > before) return false;
    if (occurred === before) {
      if (!beforeId || id >= beforeId) return false;
    }
  }
  if (after) {
    if (occurred < after) return false;
    if (occurred === after) {
      if (!afterId || id <= afterId) return false;
    }
  }
  return true;
}

function mergeEvents(pythonEvents, nodeEvents, filters = {}) {
  const seenId = new Set();
  const seenLogical = new Set();
  const out = [];
  const incoming = [...(pythonEvents || []), ...(nodeEvents || [])]
    .filter(Boolean)
    .filter((event) => matchesCursor(event, filters));
  incoming.sort(compareEventDesc);
  for (const event of incoming) {
    const id = norm(event.event_id);
    if (id && seenId.has(id)) continue;
    const lk = logicalKey(event);
    if (lk && seenLogical.has(lk)) continue;
    if (id) seenId.add(id);
    if (lk) seenLogical.add(lk);
    out.push(event);
  }
  const limit = Math.max(1, Math.min(Number(filters.limit) || 200, 500));
  return out.slice(0, limit);
}

function recordGatewayReport(report, database) {
  if (!report || typeof report !== 'object') return [];
  const saved = [];
  const status = norm(report.status).toUpperCase();
  const eventType = ORDER_STATUS_TYPE[status];
  if (eventType) {
    const fillQty = canonQty(report.accFillSz ?? report.filled_contracts ?? report.filled_quantity);
    const fillId = norm(report.fill_id || report.exchange_fill_id || report.tradeId);
    const row = append({
      event_id: `node:${eventType}:${norm(report.order_intent_id)}:${status}:${fillId || fillQty}`,
      occurred_at: report.completed_at || report.first_fill_at || report.submitted_at || nowIso(),
      event_type: eventType,
      severity: eventType === 'ORDER_REJECTED' ? 'error' : eventType === 'ORDER_FILLED' ? 'success' : 'info',
      strategy_id: report.origin_strategy_id,
      symbol: report.symbol || report.instId,
      trade_intent_id: report.trade_intent_id || report.origin_trade_intent_id,
      order_intent_id: report.order_intent_id,
      position_id: report.position_id,
      signal_key: report.signal_key,
      message: `${eventType} · ${report.order_intent_id || ''} · ${status}`,
      details: {
        status,
        execution_state: status,
        exchange_order_id: report.exchange_order_id,
        filled_contracts: report.filled_contracts,
        accFillSz: report.accFillSz ?? report.filled_contracts,
        cumulative_filled_qty: report.filled_contracts,
        fill_id: fillId || undefined,
        average_fill_price: report.average_fill_price,
      },
    }, database);
    if (row) saved.push(row);
  }
  const stop = report.protective_stop;
  if (stop && typeof stop === 'object') {
    const stopStatus = norm(stop.status || (stop.ok === false ? 'FAILED' : '')).toUpperCase();
    const stopType = STOP_STATUS_TYPE[stopStatus] || (stop.ok === false ? 'PROTECTIVE_STOP_FAILED' : '');
    if (stopType) {
      const covered = canonQty(stop.covered_contracts ?? stop.sz);
      const row = append({
        event_id: `node:${stopType}:${norm(stop.position_id || report.position_id || report.order_intent_id)}:${stopStatus || 'NA'}:${covered}`,
        occurred_at: stop.updated_at || nowIso(),
        event_type: stopType,
        severity: stopType === 'PROTECTIVE_STOP_FAILED' ? 'error' : 'info',
        strategy_id: report.origin_strategy_id,
        symbol: report.symbol || report.instId,
        order_intent_id: report.order_intent_id,
        position_id: stop.position_id || report.position_id,
        message: `${stopType} · ${stop.code || stopStatus || ''}`,
        details: {
          status: stopStatus,
          code: stop.code,
          ok: stop.ok,
          covered_contracts: stop.covered_contracts ?? stop.sz,
        },
      }, database);
      if (row) saved.push(row);
    }
  }
  return saved;
}

function recordRecovery(status, extra = {}, database) {
  const map = {
    STARTED: 'STARTUP_RECOVERY_STARTED',
    PENDING: 'STARTUP_RECOVERY_STARTED',
    READY: 'STARTUP_RECOVERY_READY',
    FAILED: 'STARTUP_RECOVERY_FAILED',
    SHADOW_SKIPPED: '',
  };
  const eventType = map[norm(status).toUpperCase()];
  if (!eventType) return null;
  return append({
    event_id: extra.event_id || `node:${eventType}:${norm(extra.at || nowIso())}`,
    occurred_at: extra.at || nowIso(),
    event_type: eventType,
    severity: eventType === 'STARTUP_RECOVERY_FAILED' ? 'error' : 'info',
    reason_code: extra.reason || extra.code,
    reason_codes: extra.reason ? [extra.reason] : [],
    message: `${eventType}${extra.reason ? ` · ${extra.reason}` : ''}`,
    details: redactSecrets(extra),
  }, database);
}

function recordReconciliation(matched, extra = {}, database) {
  const eventType = matched ? 'RECONCILIATION_MATCHED' : 'RECONCILIATION_MISMATCH';
  return append({
    event_id: extra.event_id || `node:${eventType}:${norm(extra.at || nowIso())}`,
    occurred_at: extra.at || nowIso(),
    event_type: eventType,
    severity: matched ? 'info' : 'warn',
    reason_code: extra.reason_code || extra.reason,
    message: `${eventType}${extra.reason_code ? ` · ${extra.reason_code}` : ''}`,
    details: redactSecrets(extra),
  }, database);
}

module.exports = {
  SECRET_KEYS,
  ensureTable,
  append,
  list,
  mergeEvents,
  logicalKey,
  compareEventDesc,
  newEventId,
  hasEventIdNamespace,
  resolveEventId,
  recordGatewayReport,
  recordRecovery,
  recordReconciliation,
  redactSecrets,
  normalizeReasonCodes,
  noTradeKey,
};
