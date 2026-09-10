'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const s9 = require('../lib/v41S9Demo');

function intent(extra = {}) {
  return {
    origin_strategy_id: 'S9',
    strategy_id: 'S9',
    symbol: 'BTC-USDT-SWAP',
    live_allowed: false,
    side: 'buy',
    created_at: new Date().toISOString(),
    ttl_seconds: 20,
    entry_price: 100,
    trigger_reference_price: 100,
    base_quantity: 1,
    cancel_stop_before_exit: false,
    ...extra,
  };
}

test('S9 demo opening requires S9 / BTC / OKX_DEMO / live false', () => {
  assert.equal(s9.assertS9DemoOpening(intent(), { instId: 'BTC-USDT-SWAP', accountEnvironment: 'OKX_DEMO' }), true);
  assert.throws(
    () => s9.assertS9DemoOpening(intent({ origin_strategy_id: 'S1' }), { instId: 'BTC-USDT-SWAP', accountEnvironment: 'OKX_DEMO' }),
    (e) => e.code === 'S9_STRATEGY_BLOCKED',
  );
  assert.throws(
    () => s9.assertS9DemoOpening(intent({ live_allowed: true }), { instId: 'BTC-USDT-SWAP', accountEnvironment: 'OKX_DEMO' }),
    (e) => e.code === 'STRATEGY_LIVE_NOT_ALLOWED',
  );
  assert.throws(
    () => s9.assertS9DemoOpening(intent(), { instId: 'BTC-USDT-SWAP', accountEnvironment: 'OKX_LIVE' }),
    (e) => e.code === 'S9_ENV_BLOCKED' || e.code === 'STRATEGY_LIVE_NOT_ALLOWED',
  );
});

test('S9 pre-submit TTL / spread / drift / depth without placing orders', () => {
  const book = {
    bid: 100,
    ask: 100.01,
    bids: [[100, 2], [99.9, 2], [99.8, 2], [99.7, 2], [99.6, 2]],
    asks: [[100.01, 2], [100.02, 2], [100.03, 2], [100.04, 2], [100.05, 2]],
    final_okx_sz: 1,
    book_age_sec: 0.2,
  };
  const ok = s9.assertS9PreSubmit(intent(), book);
  assert.ok(ok.spread_bps <= 2);
  assert.throws(
    () => s9.assertS9PreSubmit(intent({ created_at: new Date(Date.now() - 21_000).toISOString() }), book),
    (e) => e.code === 'S9_TRADE_INTENT_EXPIRED',
  );
  assert.throws(
    () => s9.assertS9PreSubmit(intent(), { ...book, ask: 100.1 }),
    (e) => e.code === 'S9_SPREAD_TOO_WIDE',
  );
  assert.throws(
    () => s9.assertS9PreSubmit(intent({ trigger_reference_price: 100, entry_price: 100 }), { ...book, ask: 100.07, bid: 100.06 }),
    (e) => e.code === 'S9_ENTRY_PRICE_DRIFT_EXCEEDED' || e.code === 'S9_SPREAD_TOO_WIDE',
  );
  assert.throws(
    () => s9.assertS9PreSubmit(intent({ cancel_stop_before_exit: true }), book),
    (e) => e.code === 'S9_NAKED_EXIT_FORBIDDEN',
  );
});
