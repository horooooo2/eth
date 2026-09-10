/**
 * V4.1 OrderIntent → OKX execution gateway (idempotent)
 */
const { getDb } = require('./db');
const keysMod = require('./userExchangeKeys');
const okxTrade = require('./okxTradeClient');
const executeReady = require('./v41ExecuteReadiness');
const demoV1 = require('./v41DemoExecuteV1');
const prot = require('./v41ProtectiveStop');
const startupRecovery = require('./v41StartupRecovery');
const {
  getOkxCredentialsForUser,
  isOkxReadyForUser,
  listExchangeKeys,
} = keysMod;
const { placeOrder, cancelOrder, withTradeCredentials } = okxTrade;

const executeDeps = {
  getOkxCredentialsForUser,
  isOkxReadyForUser,
  placeOrder,
  cancelOrder,
  withTradeCredentials,
  resolvePosMode: (...a) => okxTrade.resolvePosMode(...a),
  readiness: executeReady,
  getOrder: (...a) => okxTrade.getOrder(...a),
  getPublicInstrument: (...a) => okxTrade.getPublicInstrument(...a),
  getLeverageInfo: (...a) => okxTrade.getLeverageInfo(...a),
  getAccountPositions: (...a) => okxTrade.getAccountPositions(...a),
  getAlgoOrder: (...a) => okxTrade.getAlgoOrder(...a),
  placeAlgoOrder: (...a) => okxTrade.placeAlgoOrder(...a),
  amendAlgoOrder: (...a) => okxTrade.amendAlgoOrder(...a),
  cancelAlgoOrders: (...a) => okxTrade.cancelAlgoOrders(...a),
};

let openingSafetyLock = null;

function setOpeningSafetyLock(code) {
  openingSafetyLock = code || null;
}

function getOpeningSafetyLock() {
  return openingSafetyLock;
}

function _setExecuteDeps(partial) {
  Object.assign(executeDeps, partial || {});
}

async function resolveInstrumentSpec(instId) {
  let spec = null;
  try {
    spec = executeDeps.readiness.getCachedInstrument(instId);
  } catch (err) {
    throw err;
  }
  if (spec) return spec;
  if (typeof executeDeps.getPublicInstrument === 'function') {
    const raw = await executeDeps.getPublicInstrument(instId);
    spec = demoV1.mapPublicInstrument(raw);
    if (spec) executeDeps.readiness.rememberInstrument(instId, spec);
  }
  if (!spec) {
    const err = new Error('instrument metadata unavailable');
    err.code = 'INSTRUMENT_METADATA_UNAVAILABLE';
    err.status = 403;
    throw err;
  }
  return spec;
}
const v41 = require('./v41EngineClient');
const runtimeEvents = require('./v41RuntimeEvents');

function persistRuntimeEventSafe(report) {
  try {
    runtimeEvents.recordGatewayReport(report);
  } catch (err) {
    console.warn('[V41_RUNTIME_EVENT_PERSIST_FAILED]', err && err.message ? err.message : err);
  }
}
const axios = require('axios');
const qaEx = require('./v41QaExchange');
const alphaGate = require('./v41AlphaLiveGate');

function hftSimEnabled() {
  return qaEx.hftSimEnabled();
}

function assertTestOrderSafe(orderIntent) {
  const testMode = Boolean(orderIntent.test_mode);
  const target = String(orderIntent.execution_target || '').toLowerCase();
  if (!testMode) return;

  if (target === 'simulator') {
    return; // Python simulator path
  }

  if (target === 'node_gateway' && orderIntent.qa_execution) {
    // Allowed only through QA Exchange Gate (checked later with userId)
    return;
  }

  // Legacy / unsafe: test_mode without simulator and without qa_execution flag
  const err = new Error('test_mode orders must use simulator or qa_execution+node_gateway');
  err.status = 403;
  err.code = 'TEST_ORDER_REAL_EXCHANGE_BLOCKED';
  throw err;
}

async function submitToPythonSimulator(orderIntent) {
  const base = String(process.env.V41_ENGINE_BASE_URL || 'http://127.0.0.1:8711').replace(/\/$/, '');
  const token = String(process.env.V41_ENGINE_INTERNAL_TOKEN || 'dev-internal-token');
  const res = await axios.post(`${base}/internal/v1/test/simulator/submit`, orderIntent, {
    timeout: Math.max(3000, Number(process.env.V41_ENGINE_TIMEOUT_MS) || 3000),
    headers: {
      'X-Engine-Token': token,
      'Content-Type': 'application/json',
    },
    validateStatus: () => true,
  });
  if (res.status >= 300) {
    const err = new Error(res.data?.detail?.message || res.data?.detail?.code || res.data?.error || 'simulator submit failed');
    err.status = res.status;
    err.code = res.data?.detail?.code || res.data?.code || 'SIMULATOR_SUBMIT_FAILED';
    err.details = res.data;
    throw err;
  }
  return res.data;
}

function ensureTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS v41_execution_records (
      order_intent_id TEXT PRIMARY KEY,
      user_id TEXT,
      client_order_id TEXT,
      exchange_order_id TEXT,
      status TEXT NOT NULL,
      request_json TEXT,
      response_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_v41_exec_clord
      ON v41_execution_records(client_order_id)
      WHERE client_order_id IS NOT NULL AND client_order_id != '';
  `);
  const cols = getDb().prepare('PRAGMA table_info(v41_execution_records)').all();
  if (!cols.some((c) => c.name === 'signal_key')) {
    try {
      getDb().exec('ALTER TABLE v41_execution_records ADD COLUMN signal_key TEXT');
    } catch (err) {
      if (!String(err.message || err).includes('duplicate column')) throw err;
    }
  }
  getDb().exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_v41_exec_signal_open
      ON v41_execution_records(signal_key)
      WHERE signal_key IS NOT NULL AND signal_key != ''
        AND status IN ('CREATED','RECEIVED','SUBMITTED','PARTIALLY_FILLED','CANCEL_REQUESTED');
  `);
}

function findRecord(orderIntentId) {
  ensureTable();
  return getDb()
    .prepare('SELECT * FROM v41_execution_records WHERE order_intent_id = ?')
    .get(String(orderIntentId || ''));
}

function findByClientOrderId(clOrdId) {
  ensureTable();
  return getDb()
    .prepare('SELECT * FROM v41_execution_records WHERE client_order_id = ?')
    .get(String(clOrdId || ''));
}

function upsertRecord(row) {
  ensureTable();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO v41_execution_records(
        order_intent_id, user_id, client_order_id, exchange_order_id, status,
        request_json, response_json, created_at, updated_at, signal_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(order_intent_id) DO UPDATE SET
        user_id=excluded.user_id,
        client_order_id=excluded.client_order_id,
        exchange_order_id=excluded.exchange_order_id,
        status=excluded.status,
        request_json=excluded.request_json,
        response_json=excluded.response_json,
        updated_at=excluded.updated_at,
        signal_key=excluded.signal_key`,
    )
    .run(
      row.order_intent_id,
      row.user_id || '',
      row.client_order_id || '',
      row.exchange_order_id || '',
      row.status,
      row.request_json || '',
      row.response_json || '',
      row.created_at || now,
      now,
      row.signal_key || '',
    );
}

function findBySignalKey(signalKey) {
  ensureTable();
  const key = String(signalKey || '').trim();
  if (!key) return null;
  return getDb()
    .prepare(
      `SELECT * FROM v41_execution_records WHERE signal_key = ? ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(key);
}

function listNonterminalRecords() {
  ensureTable();
  return getDb()
    .prepare(
      `SELECT * FROM v41_execution_records
       WHERE status IN ('CREATED','RECEIVED','SUBMITTED','PARTIALLY_FILLED','CANCEL_REQUESTED')`,
    )
    .all();
}

const userBinding = require('./v41UserBinding');

function resolveUserId(orderIntent, auth = {}) {
  // Never trust OrderIntent / browser body.user_id.
  return userBinding.resolveTrustedUserId(auth);
}

function toOkxInstId(symbol) {
  const s = String(symbol || '').trim();
  if (!s) return '';
  if (s.includes('-')) return s;
  // BTCUSDT / BTC/USDT:USDT
  const base = s.split('/')[0].replace('USDT', '').replace(':USDT', '');
  return `${base}-USDT-SWAP`;
}

/**
 * Execute one OrderIntent exactly once.
 */
async function executeOrderIntent(orderIntent, auth = {}) {
  ensureTable();
  const incoming = alphaGate.normalizeIncomingAlpha(orderIntent || {});
  orderIntent = incoming.orderIntent;
  const forgedBodyUserId = String(orderIntent.user_id || '').trim();
  delete orderIntent.user_id;
  const orderIntentId = String(orderIntent.order_intent_id || '').trim();
  const clientOrderId = String(orderIntent.client_order_id || '').trim();
  if (!orderIntentId) {
    const err = new Error('missing order_intent_id');
    err.status = 400;
    throw err;
  }

  // Dual hard-gate: test orders never reach real OKX
  assertTestOrderSafe(orderIntent);

  const signalKey = String(orderIntent.signal_key || '').trim();
  const existing =
    findRecord(orderIntentId) ||
    (clientOrderId ? findByClientOrderId(clientOrderId) : null) ||
    (signalKey ? findBySignalKey(signalKey) : null);
  if (
    existing &&
    [
      'CREATED',
      'RECEIVED',
      'SUBMITTED',
      'PARTIALLY_FILLED',
      'PARTIAL',
      'FILLED',
      'WOULD_SUBMIT',
      'SIM_FILLED',
      'CANCEL_REQUESTED',
    ].includes(String(existing.status))
  ) {
    console.log('[V41_ORDER_INTENT_RECEIVED] idempotent hit', orderIntentId);
    return {
      ok: true,
      idempotent: true,
      shadow: String(existing.status) === 'WOULD_SUBMIT',
      simulator: String(existing.status) === 'SIM_FILLED',
      record: existing,
      report: existing.response_json ? JSON.parse(existing.response_json) : null,
    };
  }

  // Block openings when engine safety says so — still allow reduce_only
  // Skip S6 remote check for pure simulator QA traffic (runner enforces S6 itself)
  const reduceOnly = Boolean(orderIntent.reduce_only);
  const isSimTest =
    Boolean(orderIntent.test_mode) &&
    String(orderIntent.execution_target || '').toLowerCase() === 'simulator';
  const isQaExchange =
    Boolean(orderIntent.test_mode) &&
    Boolean(orderIntent.qa_execution) &&
    String(orderIntent.execution_target || '').toLowerCase() === 'node_gateway';

  if (!reduceOnly && !isSimTest) {
    try {
      const health = await v41.health();
      const state = String(health?.state || '').toUpperCase();
      if (state === 'LOCKED' || state === 'OFFLINE') {
        const err = new Error(`engine blocks new entries: ${state}`);
        err.status = 409;
        err.code = 'S6_BLOCKED';
        throw err;
      }
    } catch (err) {
      if (err.code === 'S6_BLOCKED') throw err;
      // if health unreachable, still refuse new risk
      if (!reduceOnly && err.code === 'V41_ENGINE_UNAVAILABLE') {
        const e = new Error('engine unavailable; refuse new OrderIntent');
        e.status = 503;
        e.code = 'V41_ENGINE_UNAVAILABLE';
        throw e;
      }
    }
  }

  const shadow = !isQaExchange && alphaGate.isAlphaShadow(orderIntent);

  const trustedUserId = resolveUserId(orderIntent, auth);
  if (!shadow && !isSimTest && !isQaExchange) {
    userBinding.assertExecuteUserReady(trustedUserId);
  }
  const userId = trustedUserId || (shadow || isSimTest ? 'shadow' : '');
  orderIntent.user_id = userId;
  if (forgedBodyUserId && trustedUserId && forgedBodyUserId !== trustedUserId) {
    console.log('[V41_USER_ID_BODY_IGNORED]', forgedBodyUserId, '→', trustedUserId);
  }
  if (!shadow && !isSimTest && (!userId || !executeDeps.isOkxReadyForUser(userId))) {
    const err = new Error('no OKX credentials for engine owner');
    err.status = 400;
    err.code = 'OKX_NOT_READY';
    throw err;
  }

  // QA Exchange Gate (after userId resolved)
  let qaGate = null;
  if (isQaExchange) {
    qaGate = qaEx.assertQaExchangeGate(orderIntent, userId);
  }

  const now = Date.now();

  upsertRecord({
    order_intent_id: orderIntentId,
    user_id: userId,
    client_order_id: clientOrderId,
    exchange_order_id: '',
    status: 'CREATED',
    request_json: JSON.stringify(orderIntent),
    response_json: '',
    created_at: now,
    signal_key: signalKey,
  });
  console.log(
    '[V41_ORDER_INTENT_RECEIVED]',
    orderIntentId,
    clientOrderId,
    isSimTest ? 'simulator' : isQaExchange ? `qa_exchange:${qaGate.accountMode}` : shadow ? 'shadow' : 'live',
  );

  if (isSimTest) {
    const simResult = await submitToPythonSimulator(orderIntent);
    const report = simResult?.report || {
      order_intent_id: orderIntentId,
      client_order_id: clientOrderId,
      status: simResult?.ok ? 'FILLED' : 'REJECTED',
      test_mode: true,
      execution_target: 'simulator',
      exclude_from_strategy_health: true,
      exclude_from_expected_edge: true,
      exclude_from_live_pnl_stats: true,
      error: simResult?.error || simResult?.code || null,
    };
    const status = report.status === 'PARTIAL' ? 'PARTIAL' : simResult?.ok || simResult?.idempotent ? 'SIM_FILLED' : 'REJECTED';
    upsertRecord({
      order_intent_id: orderIntentId,
      user_id: userId,
      client_order_id: clientOrderId,
      exchange_order_id: report.exchange_order_id || '',
      status,
      request_json: JSON.stringify(orderIntent),
      response_json: JSON.stringify(report),
      created_at: now,
    });
    console.log('[V41_ORDER_SIM_FILLED]', orderIntentId, status);
    return {
      ok: true,
      simulator: true,
      idempotent: Boolean(simResult?.idempotent),
      report,
      simResult,
      deprecated: incoming.deprecated || undefined,
      replacement: incoming.replacement || undefined,
    };
  }

  if (shadow) {
    const report = {
      order_intent_id: orderIntentId,
      trade_intent_id: orderIntent.trade_intent_id,
      client_order_id: clientOrderId,
      exchange_order_id: null,
      status: 'WOULD_SUBMIT',
      shadow: true,
      submitted_at: new Date().toISOString(),
      first_fill_at: null,
      completed_at: new Date().toISOString(),
      average_fill_price: null,
      filled_quantity: String(orderIntent.quantity || ''),
      fee: null,
      actual_slippage_bps: null,
      validated: {
        symbol: toOkxInstId(orderIntent.symbol),
        side: String(orderIntent.side || '').toLowerCase(),
        reduceOnly: Boolean(orderIntent.reduce_only),
        origin_strategy_id: orderIntent.origin_strategy_id || orderIntent.strategy_id || null,
      },
    };
    upsertRecord({
      order_intent_id: orderIntentId,
      user_id: userId,
      client_order_id: clientOrderId,
      exchange_order_id: '',
      status: 'WOULD_SUBMIT',
      request_json: JSON.stringify(orderIntent),
      response_json: JSON.stringify(report),
      created_at: now,
    });
    console.log('[V41_ORDER_WOULD_SUBMIT]', orderIntentId, clientOrderId);
    try {
      await v41.sendExecutionReport(report);
    } catch (err) {
      console.error('[V41_EXECUTION_REPORT_SENT] shadow failed', err.message || err);
    }
    return {
      ok: true,
      shadow: true,
      report,
      deprecated: incoming.deprecated || undefined,
      replacement: incoming.replacement || undefined,
    };
  }

  // ----- QA Exchange → real OKX (demo/live by user.simulated) -----
  if (isQaExchange) {
    const creds = qaGate.creds;
    const instId = qaGate.instId;
    const side = String(orderIntent.side || '').toLowerCase();
    const targetNotional = Number(orderIntent.target_notional_usdt || 0);
    const targetLev = Number(orderIntent.target_leverage || orderIntent.leverage || 0);

    // Position snapshot for mark price / reduce sizing
    let posSnap = await qaEx.fetchQaPosition(userId, instId);
    const mark = posSnap.mark_price || Number(orderIntent.mark_price) || 100000;
    let sz = String(orderIntent.quantity || '').trim();
    if (!sz || !(Number(sz) > 0)) {
      const converted = qaEx.notionalToSz(targetNotional || 50, mark);
      if (converted.estimatedNotional > qaEx.QA_MAX_NOTIONAL + 1) {
        const err = new Error(`estimated notional ${converted.estimatedNotional} > 50`);
        err.status = 400;
        err.code = 'QA_POSITION_CAP_EXCEEDED';
        throw err;
      }
      sz = converted.sz;
    }
    // Cap check on estimated
    const est = Number(sz) * 0.01 * mark;
    if (!reduceOnly && est > qaEx.QA_MAX_NOTIONAL + 1) {
      const err = new Error(`estimated notional ${est} exceeds 50U`);
      err.status = 400;
      err.code = 'QA_POSITION_CAP_EXCEEDED';
      throw err;
    }

    if (!reduceOnly && targetLev > 0) {
      await qaEx.ensureLeverage(userId, { instId, lever: targetLev, mgnMode: 'cross' });
    }

    const posSide = String(orderIntent.position_side || '').toLowerCase();
    // Hedge accounts: reduce-only must close the existing side (sell→long, buy→short)
    let resolvedPosSide = posSide === 'long' || posSide === 'short' ? posSide : undefined;
    if (reduceOnly && !resolvedPosSide) {
      if (posSnap.hedge_mode || Number(posSnap.long_qty) > 0 || Number(posSnap.short_qty) > 0) {
        resolvedPosSide = side === 'sell' ? 'long' : 'short';
      }
    } else if (!reduceOnly && !resolvedPosSide) {
      // open: buy→long / sell→short in hedge
      if (posSnap.hedge_mode) {
        resolvedPosSide = side === 'sell' ? 'short' : 'long';
      }
    }
    const submittedAt = new Date().toISOString();
    let orderResult = null;
    try {
      orderResult = await withTradeCredentials(creds, () =>
        placeOrder({
          instId,
          side,
          ordType: String(orderIntent.order_type || 'market'),
          sz,
          reduceOnly,
          posSide: resolvedPosSide,
          clOrdId: String(clientOrderId || '').slice(0, 32) || undefined,
          setLeverage: targetLev > 0 ? '1' : undefined,
          lever: targetLev > 0 ? targetLev : undefined,
          tag: 'QAHFT',
        }),
      );
    } catch (err) {
      const report = {
        order_intent_id: orderIntentId,
        client_order_id: clientOrderId,
        exchange_order_id: null,
        status: 'REJECTED',
        test_mode: true,
        qa_execution: true,
        execution_target: 'node_gateway',
        exchange_environment: qaGate.accountMode === 'OKX_LIVE' ? 'live' : 'demo',
        source: 'QA_HFT',
        exclude_from_strategy_health: true,
        exclude_from_expected_edge: true,
        exclude_from_live_pnl_stats: true,
        error: err.message || String(err),
        code: err.code,
        submitted_at: submittedAt,
        completed_at: new Date().toISOString(),
      };
      upsertRecord({
        order_intent_id: orderIntentId,
        user_id: userId,
        client_order_id: clientOrderId,
        exchange_order_id: '',
        status: 'REJECTED',
        request_json: JSON.stringify(orderIntent),
        response_json: JSON.stringify(report),
        created_at: now,
      });
      throw err;
    }

    // Brief settle then reconcile position
    await new Promise((r) => setTimeout(r, 800));
    posSnap = await qaEx.fetchQaPosition(userId, instId);
    const ord = orderResult?.order || orderResult || {};
    const exchangeOrderId = String(ord.ordId || ord.orderId || '');
    const report = {
      order_intent_id: orderIntentId,
      trade_intent_id: orderIntent.trade_intent_id,
      client_order_id: clientOrderId,
      exchange_order_id: exchangeOrderId || null,
      status: 'FILLED',
      submitted_at: submittedAt,
      first_fill_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      average_fill_price: Number(ord.avgPx || ord.px || mark) || null,
      filled_quantity: String(ord.sz || sz),
      fee: ord.fee || null,
      test_mode: true,
      qa_execution: true,
      execution_target: 'node_gateway',
      exchange_environment: qaGate.accountMode === 'OKX_LIVE' ? 'live' : 'demo',
      live_money: qaGate.accountMode === 'OKX_LIVE',
      source: 'QA_HFT',
      exclude_from_strategy_health: true,
      exclude_from_expected_edge: true,
      exclude_from_live_pnl_stats: true,
      position_reconciled: {
        position_notional_usdt: posSnap.position_notional_usdt,
        position_side: posSnap.position_side,
        qty: posSnap.qty,
        leverage: posSnap.leverage,
      },
    };
    upsertRecord({
      order_intent_id: orderIntentId,
      user_id: userId,
      client_order_id: clientOrderId,
      exchange_order_id: exchangeOrderId,
      status: 'FILLED',
      request_json: JSON.stringify(orderIntent),
      response_json: JSON.stringify(report),
      created_at: now,
    });
    console.log('[V41_ORDER_QA_EXCHANGE]', orderIntentId, exchangeOrderId, qaGate.accountMode);
    persistRuntimeEventSafe(report);
    try {
      await v41.sendExecutionReport(report);
    } catch (err) {
      console.error('[V41_EXECUTION_REPORT_SENT] qa failed', err.message || err);
    }
    return {
      ok: true,
      qa_exchange: true,
      account_mode: qaGate.accountMode,
      report,
      order: ord,
      position: posSnap,
    };
  }

  const creds = executeDeps.getOkxCredentialsForUser(userId);
  let liveGate;
  try {
    liveGate = alphaGate.assertAlphaLiveExecution(orderIntent, creds);
  } catch (err) {
    const report = {
      order_intent_id: orderIntentId,
      trade_intent_id: orderIntent.trade_intent_id,
      client_order_id: clientOrderId,
      exchange_order_id: null,
      status: 'REJECTED',
      reason_code: err.code || 'LIVE_EXECUTION_NOT_AUTHORIZED',
      error: err.message || String(err),
      account_environment: err.details?.account_environment || alphaGate.resolveAccountEnvironment(creds),
      submitted_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    };
    upsertRecord({
      order_intent_id: orderIntentId,
      user_id: userId,
      client_order_id: clientOrderId,
      exchange_order_id: '',
      status: 'REJECTED',
      request_json: JSON.stringify(orderIntent),
      response_json: JSON.stringify(report),
      created_at: now,
    });
    throw err;
  }
  const instId = toOkxInstId(orderIntent.symbol);
  const side = String(orderIntent.side || '').toLowerCase();
  const posSide = String(orderIntent.position_side || '').toLowerCase();
  const tdMode = String(orderIntent.td_mode || orderIntent.tdMode || 'cross').toLowerCase();
  const rejectExec = (err) => {
    const report = {
      order_intent_id: orderIntentId,
      trade_intent_id: orderIntent.trade_intent_id,
      client_order_id: clientOrderId,
      exchange_order_id: null,
      status: 'REJECTED',
      reason_code: err.code || 'EXECUTE_NOT_READY',
      error: err.message || String(err),
      submitted_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    };
    upsertRecord({
      order_intent_id: orderIntentId,
      user_id: userId,
      client_order_id: clientOrderId,
      exchange_order_id: '',
      status: 'REJECTED',
      request_json: JSON.stringify(orderIntent),
      response_json: JSON.stringify(report),
      created_at: now,
      signal_key: signalKey,
    });
    return err;
  };

  let ready;
  try {
    if (!reduceOnly && openingSafetyLock) {
      const err = new Error(`new openings blocked: ${openingSafetyLock}`);
      err.code = openingSafetyLock;
      err.status = 403;
      throw err;
    }
    if (!reduceOnly) {
      startupRecovery.assertRecoveryAllowsOpening();
    }
    const posMode = await executeDeps.resolvePosMode({ requireKnown: true, forceRefresh: true });
    const spec = await resolveInstrumentSpec(instId);
    if (reduceOnly) {
      executeDeps.readiness.assertTdMode(tdMode);
      executeDeps.readiness.assertReduceOnlyExit({ ...orderIntent, reduce_only: true, purpose: 'exit' });
      const ownedBase =
        executeDeps.ownedRemainingBaseQty != null
          ? Number(executeDeps.ownedRemainingBaseQty)
          : Number(orderIntent.owned_remaining_base_qty || orderIntent.base_quantity || 0);
      const capped = executeDeps.readiness.capExitToOwned(orderIntent, ownedBase);
      const converted = executeDeps.readiness.convertBaseToOkxSz(
        { ...orderIntent, base_quantity: capped.base_quantity },
        spec,
      );
      ready = { converted, posMode, tdMode, risk: null, exit: capped, spec };
    } else {
      const accountEnvironment = liveGate.accountEnvironment;
      let actualLeverage = executeDeps.actualLeverage;
      if (actualLeverage === undefined && typeof executeDeps.getLeverageInfo === 'function') {
        try {
          const rows = await executeDeps.withTradeCredentials(creds, () =>
            executeDeps.getLeverageInfo({ instId, mgnMode: 'cross' }),
          );
          actualLeverage = demoV1.parseActualLeverage(rows, instId);
        } catch {
          actualLeverage = null;
        }
      }
      let exchangeQty = executeDeps.exchangeQty;
      if (exchangeQty === undefined && typeof executeDeps.getAccountPositions === 'function') {
        try {
          const rows = await executeDeps.withTradeCredentials(creds, () =>
            executeDeps.getAccountPositions('SWAP', instId),
          );
          exchangeQty = demoV1.parseExchangeQty(rows, instId);
        } catch (posErr) {
          const err = new Error(posErr.message || 'OKX private API unavailable');
          err.code = 'OKX_PRIVATE_API_UNAVAILABLE';
          err.status = 503;
          throw err;
        }
      }
      const ownedOpen =
        executeDeps.ownedOpen !== undefined
          ? executeDeps.ownedOpen
          : listNonterminalRecords().some((r) => String(r.status) === 'PARTIALLY_FILLED') ||
            Boolean(
              findBySignalKey(signalKey) &&
                ['FILLED', 'PARTIALLY_FILLED'].includes(String(findBySignalKey(signalKey).status)),
            );
      const hasNonterminalOpening =
        executeDeps.hasNonterminalOpening !== undefined
          ? executeDeps.hasNonterminalOpening
          : listNonterminalRecords().some((r) => r.order_intent_id !== orderIntentId);
      await demoV1.assertDemoV1Opening(orderIntent, {
        instId,
        accountEnvironment,
        tdMode,
        posMode,
        actualLeverage,
        leverageCap: executeDeps.leverageCap || demoV1.S1_LEVERAGE_CAP,
        exchangeQty,
        ownedOpen,
        hasNonterminalOpening,
      });
      ready = executeDeps.readiness.assertBeforeAlphaSubmit(orderIntent, {
        instId,
        posMode,
        tdMode,
        instrument: spec,
      });
    }
  } catch (err) {
    throw rejectExec(err);
  }

  const submittedAt = new Date().toISOString();
  let orderResult = null;
  try {
    orderResult = await executeDeps.withTradeCredentials(creds, () =>
      executeDeps.placeOrder({
        instId,
        side,
        ordType: String(orderIntent.order_type || 'market'),
        sz: ready.converted.final_okx_sz,
        tdMode: ready.tdMode,
        reduceOnly,
        posSide: posSide === 'long' || posSide === 'short' ? posSide : undefined,
        clOrdId: clientOrderId || undefined,
        requireKnownPosMode: true,
      }),
    );
  } catch (err) {
    throw rejectExec(err);
  }

  const ord = orderResult?.order || orderResult || {};
  const exchangeOrderId = String(ord.ordId || ord.orderId || '');
  let status = 'SUBMITTED';
  let filledContracts = null;
  let avgPx = null;
  if (typeof executeDeps.getOrder === 'function') {
    const q = await executeDeps.getOrder({
      instId,
      ordId: exchangeOrderId || undefined,
      clOrdId: clientOrderId || undefined,
    });
    if (q) {
      status = demoV1.mapOkxOrderState(q);
      filledContracts = demoV1.filledContractsFromOrder(q);
      avgPx = Number(q.avgPx || q.fillPx) || null;
    }
  }

  const ownership =
    filledContracts != null
      ? demoV1.applyFillOwnership(
          { filled_contracts: filledContracts, average_fill_price: avgPx },
          ready.converted,
        )
      : null;

  let stopState = null;
  if ((status === 'FILLED' || status === 'PARTIALLY_FILLED') && !reduceOnly) {
    const stopIntent = {
      ...orderIntent,
      stop_price: (ready && ready.stop_price) || orderIntent.stop_price,
      position_id: orderIntent.position_id || orderIntent.origin_trade_intent_id || orderIntentId,
    };
    try {
      stopState = await demoV1.submitProtectiveStop(
        stopIntent,
        {
          status,
          ownership,
          exchangeOrderId,
          filled_contracts: filledContracts,
          owned_contracts: filledContracts,
          position_id: stopIntent.position_id,
        },
        executeDeps,
      );
    } catch (err) {
      stopState = { ok: false, code: err.code || 'PROTECTIVE_STOP_MISSING', error: err.message };
      setOpeningSafetyLock(err.code || 'PROTECTIVE_STOP_MISSING');
      if (typeof executeDeps.onProtectiveStopMissing === 'function') {
        executeDeps.onProtectiveStopMissing(err);
      }
      try {
        await demoV1.confirmCancel(
          {
            order_intent_id: orderIntentId,
            client_order_id: clientOrderId,
            exchange_order_id: exchangeOrderId,
            request_json: JSON.stringify(orderIntent),
            status: 'SUBMITTED',
          },
          {
            instId,
            cancelOrder: executeDeps.cancelOrder,
            getOrder: executeDeps.getOrder,
            upsert: upsertRecord,
          },
        );
      } catch {
        // keep lock
      }
      if (typeof executeDeps.emergencyReduceOnlyExit === 'function' && filledContracts > 0) {
        try {
          await executeDeps.emergencyReduceOnlyExit({
            reduce_only: true,
            purpose: 'exit',
            base_quantity: ownership ? ownership.filled_base_qty : null,
            owned_contracts: filledContracts,
            symbol: instId,
            side: side === 'buy' ? 'sell' : 'buy',
          });
        } catch {
          // stay LOCKED
        }
      }
    }
  } else if (reduceOnly && status === 'FILLED') {
    try {
      const pid = orderIntent.position_id || orderIntent.origin_trade_intent_id;
      if (pid) {
        stopState = await prot.cancelProtectiveStop(pid, executeDeps);
      }
    } catch (err) {
      setOpeningSafetyLock(err.code || 'ORPHAN_PROTECTIVE_STOP');
      stopState = { ok: false, code: err.code, error: err.message };
    }
  }

  const report = {
    order_intent_id: orderIntentId,
    trade_intent_id: orderIntent.trade_intent_id,
    origin_trade_intent_id: orderIntent.origin_trade_intent_id || orderIntent.trade_intent_id,
    origin_strategy_id: orderIntent.origin_strategy_id || 'S1',
    origin_order_intent_id: orderIntentId,
    client_order_id: clientOrderId,
    signal_key: signalKey,
    exchange_order_id: exchangeOrderId || null,
    status,
    submitted_at: submittedAt,
    first_fill_at: ownership ? new Date().toISOString() : null,
    completed_at: status === 'FILLED' ? new Date().toISOString() : null,
    average_fill_price: avgPx,
    filled_contracts: filledContracts,
    filled_quantity: ownership ? String(ownership.filled_base_qty) : null,
    filled_base_qty: ownership ? ownership.filled_base_qty : null,
    conversion: ready.converted,
    risk_sanity: ready.risk,
    protective_stop: stopState,
    account_environment: liveGate.accountEnvironment,
  };

  upsertRecord({
    order_intent_id: orderIntentId,
    user_id: userId,
    client_order_id: clientOrderId,
    exchange_order_id: exchangeOrderId,
    status,
    request_json: JSON.stringify(orderIntent),
    response_json: JSON.stringify(report),
    created_at: now,
    signal_key: signalKey,
  });

  console.log('[V41_ORDER_SUBMITTED]', orderIntentId, status, exchangeOrderId);
  persistRuntimeEventSafe(report);
  try {
    await v41.sendExecutionReport(report);
    console.log('[V41_EXECUTION_REPORT_SENT]', orderIntentId);
  } catch (err) {
    console.error('[V41_EXECUTION_REPORT_SENT] failed', err.message || err);
  }

  return {
    ok: true,
    idempotent: false,
    report,
    order: ord,
    account_environment: liveGate.accountEnvironment,
    deprecated: incoming.deprecated || undefined,
    replacement: incoming.replacement || undefined,
  };
}

/**
 * Cancel an opening OrderIntent on OKX (strategy switch / safety).
 * Never cancels reduce-only / exit protective orders.
 */
async function cancelOrderIntent(payload) {
  ensureTable();
  const orderIntentId = String(payload.order_intent_id || '').trim();
  const reduceOnly = Boolean(payload.reduce_only);
  if (reduceOnly) {
    return {
      ok: true,
      skipped: true,
      reason: 'PRESERVE_REDUCE_ONLY',
      order_intent_id: orderIntentId,
    };
  }

  const existing = orderIntentId ? findRecord(orderIntentId) : null;
  let request = payload;
  if (existing?.request_json) {
    try {
      request = { ...JSON.parse(existing.request_json), ...payload };
    } catch {
      // ignore
    }
  }
  if (Boolean(request.reduce_only)) {
    return {
      ok: true,
      skipped: true,
      reason: 'PRESERVE_REDUCE_ONLY',
      order_intent_id: orderIntentId,
    };
  }

  const userId = resolveUserId(request);
  if (!userId || !isOkxReadyForUser(userId)) {
    const err = new Error('no OKX credentials for cancel');
    err.status = 400;
    err.code = 'OKX_NOT_READY';
    throw err;
  }

  const instId = toOkxInstId(request.symbol || payload.symbol);
  const ordId = String(payload.exchange_order_id || existing?.exchange_order_id || '').trim();
  const clOrdId = String(payload.client_order_id || existing?.client_order_id || '').trim();
  if (!instId || (!ordId && !clOrdId)) {
    const err = new Error('missing instId/ordId/clOrdId for cancel');
    err.status = 400;
    err.code = 'INVALID_CANCEL';
    throw err;
  }

  const creds = executeDeps.getOkxCredentialsForUser(userId);
  console.log('[V41_ORDER_CANCEL_REQUESTED]', orderIntentId, ordId || clOrdId);
  const rec = existing || {
    order_intent_id: orderIntentId,
    client_order_id: clOrdId,
    exchange_order_id: ordId,
    request_json: JSON.stringify(request),
    status: 'SUBMITTED',
  };
  const sync = await demoV1.confirmCancel(rec, {
    instId,
    cancelOrder: (input) => executeDeps.withTradeCredentials(creds, () => executeDeps.cancelOrder(input)),
    getOrder: executeDeps.getOrder
      ? (q) => executeDeps.withTradeCredentials(creds, () => executeDeps.getOrder(q))
      : undefined,
    upsert: (row) =>
      upsertRecord({
        ...rec,
        ...row,
        user_id: userId,
        created_at: existing?.created_at || Date.now(),
      }),
  });

  const report = {
    order_intent_id: orderIntentId,
    client_order_id: clOrdId,
    exchange_order_id: sync.exchange_order_id || ordId || null,
    status: sync.status,
    reason: payload.reason || 'ACTIVE_STRATEGY_CHANGED',
    completed_at: new Date().toISOString(),
  };
  persistRuntimeEventSafe(report);
  try {
    await v41.sendExecutionReport(report);
  } catch {
    // ignore
  }
  console.log('[V41_ORDER_CANCEL_SYNC]', orderIntentId, report.status);
  return { ok: true, report, result: sync };
}

module.exports = {
  ensureTable,
  executeOrderIntent,
  cancelOrderIntent,
  findRecord,
  findBySignalKey,
  listNonterminalRecords,
  assertTestOrderSafe,
  hftSimEnabled,
  alphaGate,
  resolveUserId,
  recoverNonterminalRecords: (deps = {}) =>
    demoV1.recoverNonterminal({
      listNonterminal: deps.listNonterminal || listNonterminalRecords,
      getOrder: deps.getOrder || executeDeps.getOrder,
      upsert: deps.upsert || upsertRecord,
      ...deps,
    }),
  reconcileV1: demoV1.reconcileV1,
  killV1: demoV1.killV1,
  setOpeningSafetyLock,
  getOpeningSafetyLock,
  runStartupRecovery: (extra = {}) =>
    startupRecovery.runStartupRecovery({
      ensureExecTable: ensureTable,
      listNonterminal: listNonterminalRecords,
      getOrder: extra.getOrder || executeDeps.getOrder,
      upsertOrder: extra.upsertOrder || upsertRecord,
      getAlgoOrder: extra.getAlgoOrder || executeDeps.getAlgoOrder,
      getOkxCredentialsForUser: extra.getOkxCredentialsForUser || executeDeps.getOkxCredentialsForUser,
      listRecoverableStops: extra.listRecoverableStops,
      ownedContractsByPosition: extra.ownedContractsByPosition,
      reconcile: extra.reconcile,
      ownerUserId: extra.ownerUserId,
      ...extra,
    }),
  getExecutionRecoveryStatus: startupRecovery.getExecutionRecoveryStatus,
  setExecutionRecoveryStatus: startupRecovery.setExecutionRecoveryStatus,
  _setExecuteDeps,
};
