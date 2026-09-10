require('./s9Capabilities');

/**
 * S9 Demo opening + Node final pre-submit gates.
 * Independent from DEMO_EXECUTE_V1 (S1 only). live_allowed stays false.
 * Tests must not place real OKX orders.
 */
const S9_SYMBOL = 'BTC-USDT-SWAP';
const S9_LEVERAGE_CAP = 3;
const S9_TTL_MS = 20_000;
const S9_MAX_DRIFT_BPS = 6;
const S9_MAX_SPREAD_BPS = 2.0;
const S9_MAX_SLIP_BPS = 2.0;
const S9_BOOK_MAX_AGE_SEC = 2;
const S9_RISK_MULT = 1.05;

function fail(code, message, details) {
  const err = new Error(message);
  err.status = 403;
  err.code = code;
  err.details = details || {};
  return err;
}

function assertS9DemoOpening(orderIntent, extras = {}) {
  const sid = String(orderIntent.origin_strategy_id || orderIntent.strategy_id || '').toUpperCase();
  if (sid !== 'S9') {
    throw fail('S9_STRATEGY_BLOCKED', 'S9 demo gate only allows S9', { strategy_id: sid });
  }
  if (orderIntent.live_allowed === true) {
    throw fail('STRATEGY_LIVE_NOT_ALLOWED', 'S9 live_allowed is false', { strategy_id: sid });
  }
  const instId = String(extras.instId || orderIntent.symbol || '').trim();
  if (instId !== S9_SYMBOL) {
    throw fail('S9_SYMBOL_BLOCKED', 'S9 V1 only allows BTC-USDT-SWAP', { instId });
  }
  const env = extras.accountEnvironment;
  if (!env) throw fail('ACCOUNT_ENVIRONMENT_UNKNOWN', 'account environment unknown');
  if (env !== 'OKX_DEMO') {
    throw fail('S9_ENV_BLOCKED', 'S9 V1 requires OKX_DEMO', { env });
  }
  if (env === 'OKX_LIVE') {
    throw fail('STRATEGY_LIVE_NOT_ALLOWED', 'S9 is not allowed on OKX Live');
  }
  const lever = extras.actualLeverage;
  if (lever != null && Number(lever) > (extras.leverageCap || S9_LEVERAGE_CAP) + 1e-9) {
    throw fail('LEVERAGE_CAP_EXCEEDED', 'S9 leverage cap is 3', { actual: lever, cap: S9_LEVERAGE_CAP });
  }
  return true;
}

function assertS9ExecutionGate(extras = {}) {
  const impl = String(extras.implementationReadiness || 'NOT_READY').toUpperCase();
  const pre = String(extras.preflightReadiness || 'NOT_READY').toUpperCase();
  if (impl !== 'READY') {
    throw fail('S9_IMPLEMENTATION_NOT_READY', 'S9 implementation is not READY', { impl });
  }
  if (pre !== 'READY') {
    throw fail('S9_DEMO_PREFLIGHT_NOT_READY', 'S9 demo preflight is not READY', { pre });
  }
  return true;
}

function spreadBps(bid, ask) {
  const b = Number(bid);
  const a = Number(ask);
  if (!(b > 0) || !(a > 0) || a < b) return null;
  const mid = (a + b) / 2;
  return ((a - b) / mid) * 10_000;
}

function expectedVwap(levels, qty) {
  let remaining = Number(qty);
  if (!(remaining > 0)) return null;
  let notional = 0;
  let filled = 0;
  for (const level of levels || []) {
    const px = Number(level && level[0]);
    const sz = Number(level && level[1]);
    if (!(px > 0) || !(sz > 0)) continue;
    const take = Math.min(remaining, sz);
    notional += take * px;
    filled += take;
    remaining -= take;
    if (remaining <= 1e-12) break;
  }
  if (remaining > 1e-12 || filled <= 0) return null;
  return notional / filled;
}

function bookAgeSec(extras, nowMs) {
  if (extras.book_age_sec != null) return Number(extras.book_age_sec);
  const ts = Number(extras.book_ts || extras.timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const tsMs = ts > 1e12 ? ts : ts * 1000;
  return Math.max(0, (nowMs - tsMs) / 1000);
}

function isLong(orderIntent) {
  const side = String(orderIntent.side || orderIntent.position_side || '').toLowerCase();
  return side === 'buy' || side === 'long';
}

/**
 * Node final pre-submit. Must use converted final_okx_sz, never requested base qty.
 * Absolute spread only. Python keeps the P80 rolling gate.
 */
function assertS9PreSubmit(orderIntent, extras = {}) {
  const now = Number(extras.now_ms) || Date.now();
  const created = Date.parse(orderIntent.trade_intent_created_at || orderIntent.created_at || '');
  if (!Number.isFinite(created)) {
    throw fail('S9_TRADE_INTENT_EXPIRED', 'trade intent created_at missing');
  }
  const ttlMs = Number(orderIntent.ttl_seconds || 20) * 1000;
  if (now - created > ttlMs) {
    throw fail('S9_TRADE_INTENT_EXPIRED', 'trade intent TTL exceeded');
  }

  const sz = Number(extras.final_okx_sz);
  if (!(sz > 0)) {
    throw fail('S9_INSUFFICIENT_BOOK_DEPTH', 'final_okx_sz missing; refuse requested base qty');
  }

  const age = bookAgeSec(extras, now);
  if (age == null || age > S9_BOOK_MAX_AGE_SEC) {
    throw fail('S9_ORDERBOOK_STALE', 'orderbook stale or missing', { book_age_sec: age });
  }

  const bid = Number(extras.bid);
  const ask = Number(extras.ask);
  const spr = spreadBps(bid, ask);
  if (spr == null || spr > S9_MAX_SPREAD_BPS) {
    throw fail('S9_SPREAD_TOO_WIDE', 'spread too wide or invalid', { spread_bps: spr });
  }

  const longSide = isLong(orderIntent);
  const exec = longSide ? ask : bid;
  const trigger = Number(orderIntent.trigger_reference_price || orderIntent.entry_price);
  if (trigger > 0 && exec > 0) {
    const bps = ((exec - trigger) / trigger) * 10_000;
    const adverse = longSide ? bps > S9_MAX_DRIFT_BPS : -bps > S9_MAX_DRIFT_BPS;
    if (adverse) throw fail('S9_ENTRY_PRICE_DRIFT_EXCEEDED', 'entry drift exceeded', { bps });
  }

  const levels = longSide ? extras.asks : extras.bids;
  const vwap = expectedVwap(levels, sz);
  if (vwap == null) throw fail('S9_INSUFFICIENT_BOOK_DEPTH', 'top5 depth insufficient for final_okx_sz');
  const mid = (bid + ask) / 2;
  const slip = (Math.abs(vwap - mid) / mid) * 10_000;
  if (slip > S9_MAX_SLIP_BPS) {
    throw fail('S9_EXPECTED_SLIPPAGE_TOO_HIGH', 'expected slippage too high', { slip });
  }

  const planned = Number(
    extras.planned_risk || orderIntent.risk_amount_quote || orderIntent.risk_snapshot?.risk_amount_quote || 0,
  );
  const ctVal = Number(extras.ctVal || extras.ct_val || 0);
  const stop = Number(extras.stop_price || orderIntent.stop_price || 0);
  if (planned > 0 && ctVal > 0 && stop > 0 && exec > 0) {
    const actualBase = sz * ctVal;
    const actualRisk = Math.abs(exec - stop) * actualBase;
    if (actualRisk > planned * S9_RISK_MULT + 1e-12) {
      throw fail('RISK_SANITY_FAILED', 'actual risk exceeds planned risk_amount_quote × 1.05', {
        actual_risk: actualRisk,
        planned_risk: planned,
      });
    }
  }

  if (orderIntent.cancel_stop_before_exit === true) {
    throw fail('S9_NAKED_EXIT_FORBIDDEN', 'must not cancel protective stop before flatten');
  }
  return {
    spread_bps: spr,
    expected_slippage_bps: slip,
    expected_vwap: vwap,
    final_okx_sz: sz,
    book_age_sec: age,
  };
}

module.exports = {
  S9_SYMBOL,
  S9_LEVERAGE_CAP,
  S9_TTL_MS,
  S9_BOOK_MAX_AGE_SEC,
  assertS9DemoOpening,
  assertS9ExecutionGate,
  assertS9PreSubmit,
  spreadBps,
  expectedVwap,
};
