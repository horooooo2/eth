/**
 * Independent OKX protective stop (POST /api/v5/trade/order-algo).
 * Demo V1: net_mode, reduceOnly, sz = owned contracts (never closeFraction=1).
 */
require('./s9Capabilities');
const crypto = require('crypto');
const { getDb } = require('./db');

const STOP_TRIGGER_TYPE = 'last';
const ACTIVE = new Set(['ACTIVE', 'AMEND_PENDING', 'CANCEL_PENDING', 'UNKNOWN']);

function fail(code, message, details) {
  const err = new Error(message);
  err.status = 403;
  err.code = code;
  err.details = details || {};
  return err;
}

function algoClOrdIdFromPosition(positionId) {
  const digest = crypto.createHash('sha256').update(`ps|${positionId}`).digest('hex');
  return `ps${digest}`.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
}

function mapAlgoState(row) {
  const st = String((row && row.state) || '').toLowerCase();
  if (st === 'live' || st === 'pause' || st === 'partially_effective') return 'ACTIVE';
  if (st === 'effective') return 'TRIGGERED';
  if (st === 'canceled' || st === 'cancelled') return 'CANCELLED';
  if (st === 'order_failed') return 'FAILED';
  return 'UNKNOWN';
}

function ensureTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS v41_protective_stop_records (
      position_id TEXT PRIMARY KEY,
      origin_strategy_id TEXT,
      origin_trade_intent_id TEXT,
      origin_order_intent_id TEXT,
      inst_id TEXT,
      algo_id TEXT,
      algo_cl_ord_id TEXT,
      stop_price TEXT,
      trigger_type TEXT,
      covered_contracts TEXT,
      status TEXT NOT NULL,
      request_json TEXT,
      response_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

function upsertStop(row) {
  ensureTable();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO v41_protective_stop_records(
        position_id, origin_strategy_id, origin_trade_intent_id, origin_order_intent_id,
        inst_id, algo_id, algo_cl_ord_id, stop_price, trigger_type, covered_contracts,
        status, request_json, response_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(position_id) DO UPDATE SET
        origin_strategy_id=excluded.origin_strategy_id,
        origin_trade_intent_id=excluded.origin_trade_intent_id,
        origin_order_intent_id=excluded.origin_order_intent_id,
        inst_id=excluded.inst_id,
        algo_id=excluded.algo_id,
        algo_cl_ord_id=excluded.algo_cl_ord_id,
        stop_price=excluded.stop_price,
        trigger_type=excluded.trigger_type,
        covered_contracts=excluded.covered_contracts,
        status=excluded.status,
        request_json=excluded.request_json,
        response_json=excluded.response_json,
        updated_at=excluded.updated_at`,
    )
    .run(
      row.position_id,
      row.origin_strategy_id || 'S1',
      row.origin_trade_intent_id || '',
      row.origin_order_intent_id || '',
      row.inst_id || 'BTC-USDT-SWAP',
      row.algo_id || '',
      row.algo_cl_ord_id || '',
      row.stop_price == null ? '' : String(row.stop_price),
      row.trigger_type || STOP_TRIGGER_TYPE,
      row.covered_contracts == null ? '' : String(row.covered_contracts),
      row.status,
      row.request_json || '',
      row.response_json || '',
      row.created_at || now,
      now,
    );
}

function findByPositionId(positionId) {
  ensureTable();
  return getDb()
    .prepare('SELECT * FROM v41_protective_stop_records WHERE position_id = ?')
    .get(String(positionId || ''));
}

function listRecoverableStops() {
  ensureTable();
  return getDb()
    .prepare(
      `SELECT * FROM v41_protective_stop_records
       WHERE status IN ('ACTIVE','AMEND_PENDING','CANCEL_PENDING','UNKNOWN','PENDING_SUBMIT')`,
    )
    .all();
}

function coverageRatio(protectedContracts, ownedContracts) {
  const owned = Number(ownedContracts);
  const prot = Number(protectedContracts);
  if (!(owned > 0)) return { ratio: null, ok: true, undercovered: false };
  if (!(prot >= 0)) return { ratio: 0, ok: false, undercovered: true };
  const ratio = prot / owned;
  const undercovered = prot + 1e-12 < owned;
  return { ratio, ok: !undercovered && Math.abs(ratio - 1) <= 1e-8 + 1e-12, undercovered };
}

function buildAlgoBody({ instId, side, sz, stopPrice, algoClOrdId, tdMode = 'cross' }) {
  return {
    instId,
    tdMode,
    side,
    ordType: 'conditional',
    sz: String(sz),
    slTriggerPx: String(stopPrice),
    slOrdPx: '-1',
    slTriggerPxType: STOP_TRIGGER_TYPE,
    reduceOnly: true,
    algoClOrdId,
    stop_trigger_type: STOP_TRIGGER_TYPE,
  };
}

function oppositeSide(positionSide) {
  const s = String(positionSide || '').toLowerCase();
  if (s === 'short' || s === 'sell') return 'buy';
  return 'sell';
}

function resolvePositionId(orderIntent, fill) {
  return String(
    orderIntent.position_id ||
      (fill && fill.position_id) ||
      orderIntent.origin_trade_intent_id ||
      orderIntent.trade_intent_id ||
      orderIntent.order_intent_id ||
      '',
  );
}

async function queryAlgo(deps, { algoId, algoClOrdId }) {
  if (typeof deps.getAlgoOrder !== 'function') return null;
  return deps.getAlgoOrder({ algoId: algoId || undefined, algoClOrdId: algoClOrdId || undefined });
}

async function ensureProtectiveStop(orderIntent, fill, deps = {}) {
  const owned = Number(
    fill.owned_contracts != null
      ? fill.owned_contracts
      : fill.filled_contracts != null
        ? fill.filled_contracts
        : 0,
  );
  if (!(owned > 0)) {
    return { ok: true, skipped: true, reason: 'NO_OWNED_FILL' };
  }
  const positionId = resolvePositionId(orderIntent, fill);
  if (!positionId) {
    throw fail('PROTECTIVE_STOP_MISSING', 'protective stop requires position_id');
  }
  const instId = String(orderIntent.symbol || 'BTC-USDT-SWAP');
  const stopPrice = orderIntent.stop_price;
  if (!(Number(stopPrice) > 0)) {
    throw fail('PROTECTIVE_STOP_MISSING', 'stop_price required for protective algo');
  }
  const side = oppositeSide(orderIntent.position_side || orderIntent.side);
  const algoClOrdId = algoClOrdIdFromPosition(positionId);
  const existing = findByPositionId(positionId);
  const covered = existing ? Number(existing.covered_contracts || 0) : 0;

  if (existing && String(existing.status) === 'ACTIVE' && covered + 1e-12 >= owned) {
    return {
      ok: true,
      status: 'ACTIVE',
      algo_id: existing.algo_id,
      algo_cl_ord_id: existing.algo_cl_ord_id,
      covered_contracts: covered,
      position_id: positionId,
      stop_trigger_type: STOP_TRIGGER_TYPE,
    };
  }

  if (existing && existing.algo_id && covered + 1e-12 < owned) {
    upsertStop({
      ...existing,
      status: 'AMEND_PENDING',
      created_at: existing.created_at,
    });
    if (typeof deps.amendAlgoOrder !== 'function') {
      throw fail('PROTECTIVE_STOP_MISSING', 'amendAlgoOrder unavailable');
    }
    await deps.amendAlgoOrder({
      instId,
      algoId: existing.algo_id,
      algoClOrdId: existing.algo_cl_ord_id || algoClOrdId,
      newSz: String(owned),
    });
    const q = await queryAlgo(deps, { algoId: existing.algo_id, algoClOrdId });
    if (!q) {
      upsertStop({ ...existing, status: 'UNKNOWN', created_at: existing.created_at });
      throw fail('PROTECTIVE_STOP_UNCONFIRMED', 'amend ACK but algo query missing');
    }
    const st = mapAlgoState(q);
    const sz = Number(q.sz || owned);
    upsertStop({
      ...existing,
      status: st,
      covered_contracts: sz,
      algo_id: q.algoId || existing.algo_id,
      response_json: JSON.stringify(q),
      created_at: existing.created_at,
    });
    if (st !== 'ACTIVE') {
      throw fail('PROTECTIVE_STOP_UNCONFIRMED', 'amended algo not ACTIVE', { state: q.state });
    }
    const cov = coverageRatio(sz, owned);
    if (cov.undercovered) {
      const err = fail('PROTECTIVE_STOP_UNDERCOVERED', 'protected contracts < owned', cov);
      throw err;
    }
    return {
      ok: true,
      status: 'ACTIVE',
      amended: true,
      algo_id: q.algoId || existing.algo_id,
      algo_cl_ord_id: algoClOrdId,
      covered_contracts: sz,
      position_id: positionId,
      stop_trigger_type: STOP_TRIGGER_TYPE,
    };
  }

  const body = buildAlgoBody({
    instId,
    side,
    sz: owned,
    stopPrice,
    algoClOrdId,
    tdMode: 'cross',
  });
  upsertStop({
    position_id: positionId,
    origin_strategy_id: orderIntent.origin_strategy_id || 'S1',
    origin_trade_intent_id: orderIntent.origin_trade_intent_id || orderIntent.trade_intent_id,
    origin_order_intent_id: orderIntent.order_intent_id,
    inst_id: instId,
    algo_cl_ord_id: algoClOrdId,
    stop_price: stopPrice,
    trigger_type: STOP_TRIGGER_TYPE,
    covered_contracts: 0,
    status: 'PENDING_SUBMIT',
    request_json: JSON.stringify(body),
  });
  if (typeof deps.placeAlgoOrder !== 'function') {
    upsertStop({
      position_id: positionId,
      status: 'FAILED',
      algo_cl_ord_id: algoClOrdId,
      request_json: JSON.stringify(body),
    });
    throw fail('PROTECTIVE_STOP_MISSING', 'placeAlgoOrder unavailable');
  }
  let ack;
  try {
    ack = await deps.placeAlgoOrder(body);
  } catch (err) {
    upsertStop({
      position_id: positionId,
      status: 'FAILED',
      algo_cl_ord_id: algoClOrdId,
      request_json: JSON.stringify(body),
      response_json: JSON.stringify({ error: err.message }),
    });
    throw fail('PROTECTIVE_STOP_MISSING', err.message || 'algo submit failed');
  }
  const algoId = ack && (ack.algoId || ack.algo_id);
  const q = await queryAlgo(deps, { algoId, algoClOrdId });
  if (!q) {
    upsertStop({
      position_id: positionId,
      origin_strategy_id: orderIntent.origin_strategy_id || 'S1',
      origin_trade_intent_id: orderIntent.origin_trade_intent_id || orderIntent.trade_intent_id,
      origin_order_intent_id: orderIntent.order_intent_id,
      inst_id: instId,
      algo_id: algoId || '',
      algo_cl_ord_id: algoClOrdId,
      stop_price: stopPrice,
      trigger_type: STOP_TRIGGER_TYPE,
      covered_contracts: 0,
      status: 'UNKNOWN',
      request_json: JSON.stringify(body),
      response_json: JSON.stringify(ack || {}),
    });
    throw fail('PROTECTIVE_STOP_UNCONFIRMED', 'algo submit ACK but query missing');
  }
  const st = mapAlgoState(q);
  const sz = Number(q.sz || owned);
  upsertStop({
    position_id: positionId,
    origin_strategy_id: orderIntent.origin_strategy_id || 'S1',
    origin_trade_intent_id: orderIntent.origin_trade_intent_id || orderIntent.trade_intent_id,
    origin_order_intent_id: orderIntent.order_intent_id,
    inst_id: instId,
    algo_id: q.algoId || algoId || '',
    algo_cl_ord_id: algoClOrdId,
    stop_price: stopPrice,
    trigger_type: STOP_TRIGGER_TYPE,
    covered_contracts: sz,
    status: st,
    request_json: JSON.stringify(body),
    response_json: JSON.stringify(q),
  });
  if (st !== 'ACTIVE') {
    throw fail('PROTECTIVE_STOP_UNCONFIRMED', 'algo not ACTIVE after query', { state: q.state });
  }
  const cov = coverageRatio(sz, owned);
  if (cov.undercovered) {
    throw fail('PROTECTIVE_STOP_UNDERCOVERED', 'protected contracts < owned', cov);
  }
  return {
    ok: true,
    status: 'ACTIVE',
    algo_id: q.algoId || algoId,
    algo_cl_ord_id: algoClOrdId,
    covered_contracts: sz,
    position_id: positionId,
    stop_trigger_type: STOP_TRIGGER_TYPE,
    request: body,
  };
}

async function cancelProtectiveStop(positionId, deps = {}) {
  const rec = findByPositionId(positionId);
  if (!rec) return { ok: true, skipped: true };
  upsertStop({ ...rec, status: 'CANCEL_PENDING', created_at: rec.created_at });
  if (typeof deps.cancelAlgoOrders === 'function' && rec.algo_id) {
    try {
      await deps.cancelAlgoOrders([{ instId: rec.inst_id, algoId: rec.algo_id, algoClOrdId: rec.algo_cl_ord_id }]);
    } catch {
      // query decides
    }
  }
  const q = await queryAlgo(deps, { algoId: rec.algo_id, algoClOrdId: rec.algo_cl_ord_id });
  const st = q ? mapAlgoState(q) : 'UNKNOWN';
  const next = st === 'CANCELLED' || st === 'TRIGGERED' ? st : q ? st : 'CANCELLED';
  upsertStop({ ...rec, status: next === 'ACTIVE' ? 'ACTIVE' : next, created_at: rec.created_at, response_json: JSON.stringify(q || {}) });
  if (next === 'ACTIVE') {
    throw fail('ORPHAN_PROTECTIVE_STOP', 'position flat but protective stop still ACTIVE');
  }
  return { ok: true, status: next, position_id: positionId };
}

async function recoverProtectiveStops(deps = {}) {
  const rows = typeof deps.listRecoverable === 'function' ? deps.listRecoverable() : listRecoverableStops();
  const out = [];
  for (const rec of rows) {
    const q = await queryAlgo(deps, { algoId: rec.algo_id, algoClOrdId: rec.algo_cl_ord_id });
    if (!q) {
      const owned = Number(deps.ownedContractsByPosition && deps.ownedContractsByPosition[rec.position_id]);
      if (owned > 0) {
        upsertStop({ ...rec, status: 'UNKNOWN', created_at: rec.created_at });
        out.push({ position_id: rec.position_id, status: 'UNKNOWN', missing: true, code: 'PROTECTIVE_STOP_MISSING' });
        continue;
      }
      upsertStop({ ...rec, status: 'UNKNOWN', created_at: rec.created_at });
      out.push({ position_id: rec.position_id, status: 'UNKNOWN', missing: true });
      continue;
    }
    const st = mapAlgoState(q);
    upsertStop({
      ...rec,
      status: st,
      algo_id: q.algoId || rec.algo_id,
      covered_contracts: q.sz || rec.covered_contracts,
      response_json: JSON.stringify(q),
      created_at: rec.created_at,
    });
    out.push({ position_id: rec.position_id, status: st, resubmitted: false });
  }
  return out;
}

function assertNoOrphan({ ownedContracts, stopStatus }) {
  if (Number(ownedContracts) <= 0 && stopStatus === 'ACTIVE') {
    throw fail('ORPHAN_PROTECTIVE_STOP', 'flat position still has ACTIVE protective stop');
  }
}

module.exports = {
  STOP_TRIGGER_TYPE,
  ACTIVE,
  ensureTable,
  upsertStop,
  findByPositionId,
  listRecoverableStops,
  coverageRatio,
  buildAlgoBody,
  algoClOrdIdFromPosition,
  mapAlgoState,
  ensureProtectiveStop,
  cancelProtectiveStop,
  recoverProtectiveStops,
  assertNoOrphan,
};
