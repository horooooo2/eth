/**
 * S9 Demo opening gates. Independent from DEMO_EXECUTE_V1 (S1 only).
 * live_allowed stays false. Tests must not place real OKX orders.
 */
const S9_SYMBOL = 'BTC-USDT-SWAP';
const S9_LEVERAGE_CAP = 3;
const S9_TTL_MS = 20_000;
const S9_MAX_DRIFT_BPS = 6;
const S9_MAX_SPREAD_BPS = 2.0;
const S9_MAX_SLIP_BPS = 2.0;

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

function assertS9PreSubmit(orderIntent, extras = {}) {
  const created = Date.parse(
    orderIntent.trade_intent_created_at || orderIntent.created_at || '',
  );
  if (!Number.isFinite(created)) {
    throw fail('S9_TRADE_INTENT_EXPIRED', 'trade intent created_at missing');
  }
  if (Date.now() - created > Number(orderIntent.ttl_seconds || 20) * 1000) {
    throw fail('S9_TRADE_INTENT_EXPIRED', 'trade intent TTL exceeded');
  }
  const bid = Number(extras.bid);
  const ask = Number(extras.ask);
  const spr = spreadBps(bid, ask);
  if (spr == null || spr > S9_MAX_SPREAD_BPS) {
    throw fail('S9_SPREAD_TOO_WIDE', 'spread too wide or invalid', { spread_bps: spr });
  }
  const side = String(orderIntent.side || orderIntent.position_side || '').toLowerCase();
  const exec = side === 'buy' || side === 'long' ? ask : bid;
  const trigger = Number(orderIntent.trigger_reference_price || orderIntent.entry_price);
  if (trigger > 0 && exec > 0) {
    const bps = ((exec - trigger) / trigger) * 10_000;
    const adverse = side === 'buy' || side === 'long' ? bps > S9_MAX_DRIFT_BPS : -bps > S9_MAX_DRIFT_BPS;
    if (adverse) throw fail('S9_ENTRY_PRICE_DRIFT_EXCEEDED', 'entry drift exceeded', { bps });
  }
  const levels = side === 'buy' || side === 'long' ? extras.asks : extras.bids;
  const sz = Number(extras.final_okx_sz || orderIntent.okx_sz || orderIntent.base_quantity);
  const vwap = expectedVwap(levels, sz);
  if (vwap == null) throw fail('S9_INSUFFICIENT_BOOK_DEPTH', 'top5 depth insufficient');
  const mid = (bid + ask) / 2;
  const slip = Math.abs(vwap - mid) / mid * 10_000;
  if (slip > S9_MAX_SLIP_BPS) {
    throw fail('S9_EXPECTED_SLIPPAGE_TOO_HIGH', 'expected slippage too high', { slip });
  }
  if (orderIntent.cancel_stop_before_exit === true) {
    throw fail('S9_NAKED_EXIT_FORBIDDEN', 'must not cancel protective stop before flatten');
  }
  return { spread_bps: spr, expected_slippage_bps: slip, expected_vwap: vwap };
}

module.exports = {
  S9_SYMBOL,
  S9_LEVERAGE_CAP,
  S9_TTL_MS,
  assertS9DemoOpening,
  assertS9PreSubmit,
  spreadBps,
  expectedVwap,
};
