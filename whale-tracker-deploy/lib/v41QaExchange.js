/**
 * QA-HFT exchange routing helpers.
 * Account mode truth source: user exchange_keys.simulated (OKX_DEMO vs OKX_LIVE).
 */
const {
  getOkxCredentialsForUser,
  isOkxReadyForUser,
} = require('./userExchangeKeys');
const {
  placeOrder,
  cancelOrder,
  setLeverage,
  getAccountPositions,
  withTradeCredentials,
  isSimulated,
} = require('./okxTradeClient');

const QA_MAX_NOTIONAL = 50;
const QA_ALLOWED_SYMBOLS = new Set(['BTC-USDT-SWAP']);

function truthy(v) {
  return ['1', 'true', 'yes', 'on'].includes(String(v || '').trim().toLowerCase());
}

function hftSimEnabled() {
  return truthy(process.env.V41_HFT_SIM_ENABLED);
}

function qaExchangeEnabled() {
  return truthy(process.env.V41_QA_EXCHANGE_ENABLED);
}

function qaLiveEnabled() {
  return truthy(process.env.V41_QA_LIVE_ENABLED);
}

function resolveAccountMode(creds) {
  const simulated = creds ? Boolean(creds.simulated) : isSimulated(creds);
  return simulated ? 'OKX_DEMO' : 'OKX_LIVE';
}

function assertQaLivePermission(accountMode) {
  if (accountMode === 'OKX_LIVE' && !qaLiveEnabled()) {
    const err = new Error('QA live trading disabled');
    err.status = 403;
    err.code = 'QA_LIVE_TRADING_DISABLED';
    err.details = { account_mode: accountMode, env_key: 'V41_QA_LIVE_ENABLED' };
    throw err;
  }
  return { accountMode, allowed: true };
}

function resolveQaCapability(userId) {
  const hft = hftSimEnabled();
  const exchangeOn = qaExchangeEnabled();
  const liveOn = qaLiveEnabled();
  let accountMode = null;
  let okxReady = false;
  if (userId && isOkxReadyForUser(userId)) {
    okxReady = true;
    const creds = getOkxCredentialsForUser(userId);
    accountMode = resolveAccountMode(creds);
  }
  return {
    hft_sim_enabled: hft,
    qa_exchange_enabled: exchangeOn,
    qa_live_enabled: liveOn,
    okx_ready: okxReady,
    account_mode: accountMode, // OKX_DEMO | OKX_LIVE | null
    exchange_environment: accountMode === 'OKX_LIVE' ? 'live' : accountMode === 'OKX_DEMO' ? 'demo' : null,
    live_money: accountMode === 'OKX_LIVE',
    max_position_notional_usdt: QA_MAX_NOTIONAL,
    allowed_symbols: [...QA_ALLOWED_SYMBOLS],
    simulator_available: hft,
    exchange_available:
      hft &&
      exchangeOn &&
      okxReady &&
      (accountMode === 'OKX_DEMO' || (accountMode === 'OKX_LIVE' && liveOn)),
  };
}

/**
 * Hard gate for QA orders going through Node → OKX.
 */
function assertQaExchangeGate(orderIntent, userId) {
  if (!hftSimEnabled()) {
    const err = new Error('QA-HFT-SIM disabled');
    err.status = 403;
    err.code = 'HFT_SIM_DISABLED';
    throw err;
  }
  if (!qaExchangeEnabled()) {
    const err = new Error('QA exchange path disabled');
    err.status = 403;
    err.code = 'QA_EXCHANGE_DISABLED';
    throw err;
  }
  if (!orderIntent.test_mode || !orderIntent.qa_execution) {
    const err = new Error('QA exchange requires test_mode and qa_execution');
    err.status = 403;
    err.code = 'QA_EXECUTION_FLAG_REQUIRED';
    throw err;
  }
  if (String(orderIntent.execution_target || '').toLowerCase() !== 'node_gateway') {
    const err = new Error('QA exchange requires execution_target=node_gateway');
    err.status = 400;
    err.code = 'INVALID_EXECUTION_TARGET';
    throw err;
  }
  if (!userId || !isOkxReadyForUser(userId)) {
    const err = new Error('OKX credentials not ready for QA owner');
    err.status = 400;
    err.code = 'OKX_NOT_READY';
    throw err;
  }
  const creds = getOkxCredentialsForUser(userId);
  const mode = resolveAccountMode(creds);
  assertQaLivePermission(mode);
  const instId = String(orderIntent.symbol || orderIntent.instId || '').toUpperCase();
  const normalized = instId.includes('-') ? instId : `${instId.replace('USDT', '')}-USDT-SWAP`;
  if (!QA_ALLOWED_SYMBOLS.has(normalized) && !QA_ALLOWED_SYMBOLS.has(instId)) {
    const err = new Error(`symbol not allowed for QA: ${instId}`);
    err.status = 400;
    err.code = 'QA_SYMBOL_NOT_ALLOWED';
    throw err;
  }
  const notional = Number(orderIntent.target_notional_usdt || 0);
  if (notional > QA_MAX_NOTIONAL + 1e-6) {
    const err = new Error(`QA notional ${notional} exceeds ${QA_MAX_NOTIONAL}U`);
    err.status = 400;
    err.code = 'QA_POSITION_CAP_EXCEEDED';
    throw err;
  }
  return { creds, accountMode: mode, instId: normalized || 'BTC-USDT-SWAP' };
}

/**
 * Rough SWAP sz from notional. BTC-USDT-SWAP ctVal≈0.01 BTC.
 */
function notionalToSz(notionalUsdt, markPrice, ctVal = 0.01) {
  const px = Number(markPrice) || 100000;
  const cv = Number(ctVal) || 0.01;
  const coin = Math.abs(Number(notionalUsdt)) / px;
  const raw = coin / cv;
  // OKX lot often 0.01 contracts for BTC swap — round down to 0.01
  const lot = 0.01;
  const steps = Math.max(1, Math.floor(raw / lot + 1e-12));
  const sz = steps * lot;
  const estNotional = sz * cv * px;
  return { sz: String(sz), estimatedNotional: estNotional, markPrice: px, ctVal: cv };
}

async function fetchQaPosition(userId, instId = 'BTC-USDT-SWAP') {
  const creds = getOkxCredentialsForUser(userId);
  return withTradeCredentials(creds, async () => {
    const rows = await getAccountPositions('SWAP', instId);
    const list = (rows || []).filter((r) => String(r.instId || instId) === instId);
    if (!list.length) {
      return {
        instId,
        position_notional_usdt: 0,
        position_side: 'FLAT',
        qty: 0,
        long_qty: 0,
        short_qty: 0,
        leverage: null,
        mark_price: null,
        raw: null,
        hedge_mode: false,
      };
    }

    let longQty = 0;
    let shortQty = 0;
    let mark = null;
    let lever = null;
    let notionalLong = 0;
    let notionalShort = 0;
    let hedgeMode = false;

    for (const row of list) {
      const ps = String(row.posSide || '').toLowerCase();
      const pos = Number(row.pos || 0);
      const n = Number(row.notionalUsd);
      const m = Number(row.markPx || row.last || 0);
      if (Number.isFinite(m) && m > 0) mark = m;
      const lv = Number(row.lever || row.leverage || 0);
      if (lv > 0) lever = lv;
      if (ps === 'long' || ps === 'short') hedgeMode = true;
      if (ps === 'long') {
        longQty += Math.abs(pos);
        notionalLong += Number.isFinite(n) ? Math.abs(n) : Math.abs(pos) * 0.01 * (mark || 0);
      } else if (ps === 'short') {
        shortQty += Math.abs(pos);
        notionalShort += Number.isFinite(n) ? Math.abs(n) : Math.abs(pos) * 0.01 * (mark || 0);
      } else {
        // net mode single row: signed pos
        if (pos >= 0) {
          longQty += pos;
          notionalLong += Number.isFinite(n) ? Math.abs(n) : Math.abs(pos) * 0.01 * (mark || 0);
        } else {
          shortQty += Math.abs(pos);
          notionalShort += Number.isFinite(n) ? Math.abs(n) : Math.abs(pos) * 0.01 * (mark || 0);
        }
      }
    }

    const netQty = longQty - shortQty;
    const notionalUsdt = Math.abs(notionalLong - notionalShort);
    const side = netQty > 1e-12 ? 'LONG' : netQty < -1e-12 ? 'SHORT' : 'FLAT';
    return {
      instId,
      position_notional_usdt: notionalUsdt,
      position_side: side,
      qty: netQty,
      long_qty: longQty,
      short_qty: shortQty,
      leverage: lever,
      mark_price: mark,
      raw: list,
      hedge_mode: hedgeMode,
    };
  });
}

async function ensureLeverage(userId, { instId, lever, mgnMode = 'cross' }) {
  const creds = getOkxCredentialsForUser(userId);
  const target = Number(lever);
  if (!(target > 0)) {
    const err = new Error('invalid leverage');
    err.status = 400;
    err.code = 'INVALID_LEVERAGE';
    throw err;
  }
  return withTradeCredentials(creds, async () => {
    try {
      await setLeverage({ instId, lever: target, mgnMode });
    } catch (err) {
      const e = new Error(err.message || 'set leverage failed');
      e.status = 502;
      e.code = 'LEVERAGE_SET_FAILED';
      e.cause = err;
      throw e;
    }
    // Re-read from positions (OKX may not expose lever elsewhere immediately)
    const snap = await fetchQaPosition(userId, instId);
    const actual = Number(snap.leverage);
    if (Number.isFinite(actual) && Math.abs(actual - target) > 1e-6) {
      // Some accounts report lever only after position exists — accept set success if no position
      if (Math.abs(snap.qty) > 1e-12) {
        const e = new Error(`leverage mismatch actual=${actual} target=${target}`);
        e.status = 409;
        e.code = 'LEVERAGE_RECONCILIATION_FAILED';
        e.details = { actual, target };
        throw e;
      }
    }
    return { ok: true, target_leverage: target, actual_leverage: actual || target, position: snap };
  });
}

module.exports = {
  QA_MAX_NOTIONAL,
  QA_ALLOWED_SYMBOLS,
  hftSimEnabled,
  qaExchangeEnabled,
  qaLiveEnabled,
  resolveAccountMode,
  assertQaLivePermission,
  resolveQaCapability,
  assertQaExchangeGate,
  notionalToSz,
  fetchQaPosition,
  ensureLeverage,
  placeOrder,
  cancelOrder,
  withTradeCredentials,
  getOkxCredentialsForUser,
};
