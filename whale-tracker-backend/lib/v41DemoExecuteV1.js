/**
 * Demo Execute V1: S1 / BTC-USDT-SWAP / OKX_DEMO / FLAT start / one position.
 * Real OKX calls go through injected trade client (tests use mocks).
 */

const ready = require('./v41ExecuteReadiness');
const crypto = require('crypto');

const V1_SYMBOL = 'BTC-USDT-SWAP';
const S1_LEVERAGE_CAP = 6;
const NONTERMINAL = new Set([
  'CREATED',
  'RECEIVED',
  'SUBMITTED',
  'PARTIALLY_FILLED',
  'CANCEL_REQUESTED',
]);

function fail(code, message, details) {
  const err = new Error(message);
  err.status = 403;
  err.code = code;
  err.details = details || {};
  return err;
}

function clOrdIdFromSignal(signalKey, suffix = 'op') {
  const digest = crypto.createHash('sha256').update(`${signalKey}|${suffix}`).digest('hex');
  return `s1${digest}`.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
}

function mapOkxOrderState(row) {
  const st = String((row && (row.state || row.status)) || '').toLowerCase();
  if (st === 'filled') return 'FILLED';
  if (st === 'partially_filled' || st === 'partial') return 'PARTIALLY_FILLED';
  if (st === 'canceled' || st === 'cancelled') return 'CANCELLED';
  if (st === 'live' || st === 'submitted' || st === 'mmp_canceled') return 'SUBMITTED';
  return 'UNKNOWN';
}

function filledContractsFromOrder(row) {
  const acc = Number(row && (row.accFillSz || row.fillSz || row.filled_sz));
  if (Number.isFinite(acc) && acc >= 0) return acc;
  return null;
}

async function assertDemoV1Opening(orderIntent, extras = {}) {
  const sid = String(orderIntent.origin_strategy_id || orderIntent.strategy_id || '').toUpperCase();
  if (sid !== 'S1' || orderIntent.demo_execute_v1_allowed === false) {
    throw fail('DEMO_EXECUTE_V1_STRATEGY_BLOCKED', 'Demo Execute V1 only allows S1', { strategy_id: sid });
  }
  const instId = String(extras.instId || orderIntent.symbol || '').trim();
  if (instId !== V1_SYMBOL) {
    throw fail('DEMO_EXECUTE_V1_SYMBOL_BLOCKED', 'Demo Execute V1 only allows BTC-USDT-SWAP', { instId });
  }
  const env = extras.accountEnvironment;
  if (!env) throw fail('ACCOUNT_ENVIRONMENT_UNKNOWN', 'account environment unknown');
  if (env !== 'OKX_DEMO') {
    throw fail('DEMO_EXECUTE_V1_ENV_BLOCKED', 'Demo Execute V1 requires OKX_DEMO', { env });
  }
  ready.assertTdMode(extras.tdMode || orderIntent.td_mode || 'cross');
  if (extras.posMode !== undefined) {
    ready.assertNetPosMode(extras.posMode);
  }
  if (extras.ownedOpen) {
    throw fail('S1_POSITION_ALREADY_OPEN', 'S1 BTC owned position already open');
  }
  if (extras.hasNonterminalOpening) {
    throw fail('S1_POSITION_ALREADY_OPEN', 'S1 BTC opening already SUBMITTED/PARTIAL');
  }
  const exchQty = Number(extras.exchangeQty || 0);
  if (Math.abs(exchQty) > 1e-12 && !extras.ownedOpen) {
    throw fail('EXTERNAL_POSITION_PRESENT', 'exchange BTC position exists and is not S1-owned', {
      exchange_qty: exchQty,
    });
  }
  const lever = extras.actualLeverage;
  if (lever == null || !Number.isFinite(Number(lever))) {
    throw fail('LEVERAGE_UNKNOWN', 'actual OKX leverage unknown');
  }
  if (Number(lever) > Number(extras.leverageCap || S1_LEVERAGE_CAP) + 1e-9) {
    throw fail('LEVERAGE_ABOVE_STRATEGY_CAP', 'actual leverage exceeds S1 cap', {
      actual: lever,
      cap: extras.leverageCap || S1_LEVERAGE_CAP,
    });
  }
}

async function submitProtectiveStop(orderIntent, fill, deps) {
  if (typeof deps.submitProtectiveStop === 'function') {
    return deps.submitProtectiveStop(orderIntent, fill);
  }
  const prot = require('./v41ProtectiveStop');
  return prot.ensureProtectiveStop(orderIntent, fill, deps);
}

function applyFillOwnership(report, converted) {
  const filledContracts = Number(report.filled_contracts);
  const ctVal = Number(converted.ctVal);
  if (!(filledContracts > 0) || !(ctVal > 0)) return null;
  return {
    filled_contracts: filledContracts,
    filled_base_qty: filledContracts * ctVal,
    avg_fill_price: report.average_fill_price || null,
  };
}

function mapPublicInstrument(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ctVal = Number(raw.ctVal);
  if (!(ctVal > 0)) return null;
  return {
    instId: String(raw.instId || V1_SYMBOL),
    ctVal,
    ctValCcy: raw.ctValCcy || 'BTC',
    lotSz: Number(raw.lotSz),
    minSz: Number(raw.minSz),
    tickSz: Number(raw.tickSz),
    state: raw.state || 'live',
    source: raw.source || 'okx_public',
  };
}

function parseActualLeverage(rows, instId) {
  const list = Array.isArray(rows) ? rows : [];
  const want = String(instId || '').trim();
  const hit = list.find((r) => String(r.instId || '') === want) || list[0];
  const lever = Number(hit && (hit.lever || hit.leverage));
  return Number.isFinite(lever) ? lever : null;
}

function parseExchangeQty(rows, instId) {
  const list = Array.isArray(rows) ? rows : [];
  const want = String(instId || '').trim();
  let qty = 0;
  for (const r of list) {
    if (want && String(r.instId || '') !== want) continue;
    const n = Number(r.pos || r.availPos || 0);
    if (Number.isFinite(n)) qty += n;
  }
  return qty;
}

function reconcileV1({
  ownedBaseQty = 0,
  exchangeBaseQty = 0,
  ownedSide = '',
  exchangeSide = '',
  unknownOpenOrder = false,
} = {}) {
  if (unknownOpenOrder) {
    return { status: 'OPEN_ORDER_UNKNOWN', block: true, reason_code: 'OPEN_ORDER_UNKNOWN' };
  }
  const owned = Number(ownedBaseQty) || 0;
  const exch = Number(exchangeBaseQty) || 0;
  if (Math.abs(owned) < 1e-12 && Math.abs(exch) > 1e-12) {
    return { status: 'MISSING_LOCAL', block: true, reason_code: 'RECONCILIATION_MISMATCH' };
  }
  if (Math.abs(owned) > 1e-12 && Math.abs(exch) < 1e-12) {
    return { status: 'MISSING_REMOTE', block: true, reason_code: 'RECONCILIATION_MISMATCH' };
  }
  const os = String(ownedSide || '').toLowerCase();
  const es = String(exchangeSide || '').toLowerCase();
  if (Math.abs(owned) > 1e-12 && Math.abs(exch) > 1e-12 && os && es && os !== es) {
    return { status: 'SIDE_MISMATCH', block: true, reason_code: 'RECONCILIATION_MISMATCH' };
  }
  if (Math.abs(owned - exch) > 1e-8) {
    return { status: 'QTY_MISMATCH', block: true, reason_code: 'RECONCILIATION_MISMATCH' };
  }
  return { status: 'MATCHED', block: false, reason_code: null };
}

async function killV1(deps = {}) {
  if (typeof deps.lockEngine === 'function') await deps.lockEngine();
  const cancelled = [];
  const openings = typeof deps.listOwnedPendingOpenings === 'function' ? deps.listOwnedPendingOpenings() : [];
  for (const rec of openings) {
    cancelled.push(await confirmCancel(rec, deps));
  }
  let exit = null;
  const ownedQty = Number(deps.ownedRemainingBaseQty || 0);
  if (deps.ownershipClear === true && ownedQty > 0 && typeof deps.submitReduceOnlyExit === 'function') {
    exit = await deps.submitReduceOnlyExit({
      reduce_only: true,
      purpose: 'exit',
      base_quantity: ownedQty,
      origin_strategy_id: 'S1',
    });
  }
  return {
    locked: true,
    alpha_opening: false,
    cancelled,
    exit,
    flatten_account: false,
    touch_external: false,
  };
}

async function syncFromExchange(record, deps) {
  if (typeof deps.getOrder !== 'function') {
    return { status: 'UNKNOWN', reason: 'ORDER_QUERY_UNAVAILABLE' };
  }
  const parsed = record.request_json ? JSON.parse(record.request_json || '{}') : {};
  const instId = deps.instId || parsed.symbol || V1_SYMBOL;
  const row = await deps.getOrder({
    instId,
    ordId: record.exchange_order_id || undefined,
    clOrdId: record.client_order_id || parsed.client_order_id || undefined,
  });
  if (!row) return { status: 'UNKNOWN', reason: 'ORDER_NOT_FOUND' };
  const status = mapOkxOrderState(row);
  const filled = filledContractsFromOrder(row);
  return {
    status,
    filled_contracts: filled,
    average_fill_price: Number(row.avgPx || row.fillPx) || null,
    exchange_order_id: row.ordId || record.exchange_order_id,
    raw: row,
  };
}

async function recoverNonterminal(deps) {
  const rows = typeof deps.listNonterminal === 'function' ? deps.listNonterminal() : [];
  const out = [];
  for (const rec of rows) {
    const sync = await syncFromExchange(rec, deps);
    out.push({ order_intent_id: rec.order_intent_id, ...sync, resubmitted: false });
    if (typeof deps.upsert === 'function') {
      deps.upsert({
        ...rec,
        status: sync.status,
        exchange_order_id: sync.exchange_order_id || rec.exchange_order_id,
        response_json: JSON.stringify(sync),
      });
    }
  }
  return out;
}

async function confirmCancel(record, deps) {
  if (typeof deps.cancelOrder !== 'function') {
    throw fail('CANCEL_FAILED', 'cancel client missing');
  }
  if (typeof deps.upsert === 'function') {
    deps.upsert({ ...record, status: 'CANCEL_REQUESTED' });
  }
  try {
    const parsed = record.request_json ? JSON.parse(record.request_json || '{}') : {};
    await deps.cancelOrder({
      instId: deps.instId || parsed.symbol || V1_SYMBOL,
      ordId: record.exchange_order_id || undefined,
      clOrdId: record.client_order_id || undefined,
    });
  } catch (err) {
    const sync = await syncFromExchange(record, deps);
    if (sync.status === 'FILLED' || sync.status === 'PARTIALLY_FILLED') return sync;
    if (typeof deps.upsert === 'function') {
      deps.upsert({ ...record, status: 'CANCEL_FAILED', response_json: JSON.stringify({ error: err.message }) });
    }
    throw fail('CANCEL_FAILED', err.message || 'cancel failed');
  }
  const sync = await syncFromExchange(record, deps);
  if (sync.status === 'FILLED' || sync.status === 'PARTIALLY_FILLED') return sync;
  if (sync.status === 'CANCELLED') {
    if (typeof deps.upsert === 'function') deps.upsert({ ...record, status: 'CANCELLED', response_json: JSON.stringify(sync) });
    return sync;
  }
  if (typeof deps.upsert === 'function') {
    deps.upsert({ ...record, status: 'CANCEL_REQUESTED', response_json: JSON.stringify(sync) });
  }
  return { ...sync, status: sync.status === 'SUBMITTED' ? 'CANCEL_REQUESTED' : sync.status };
}

module.exports = {
  V1_SYMBOL,
  S1_LEVERAGE_CAP,
  NONTERMINAL,
  clOrdIdFromSignal,
  mapOkxOrderState,
  filledContractsFromOrder,
  assertDemoV1Opening,
  submitProtectiveStop,
  applyFillOwnership,
  syncFromExchange,
  recoverNonterminal,
  confirmCancel,
  mapPublicInstrument,
  parseActualLeverage,
  parseExchangeQty,
  reconcileV1,
  killV1,
};
