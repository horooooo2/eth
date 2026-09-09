'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../lib/v41AlphaLiveGate');
const qaEx = require('../lib/v41QaExchange');

test('Case 1/2: SHADOW does not require live permission', () => {
  process.env.V41_ALPHA_EXECUTION = 'SHADOW';
  process.env.V41_LIVE_TRADING_ENABLED = 'false';
  assert.equal(gate.isAlphaShadow({ alpha_execution: 'SHADOW' }), true);
  assert.equal(gate.isAlphaShadow({ shadow: true }), true);
  assert.equal(gate.isAlphaShadow({ strategy_id: 'S1' }), true);
  const demo = gate.assertAlphaLiveExecution({ strategy_id: 'S1' }, { simulated: true });
  assert.equal(demo.accountEnvironment, 'OKX_DEMO');
  // SHADOW never calls this Live gate; LIVE + EXECUTE is Case 4.
});

test('Case 3 mock: EXECUTE + DEMO allowed (no OKX call)', () => {
  process.env.V41_ALPHA_EXECUTION = 'EXECUTE';
  process.env.V41_LIVE_TRADING_ENABLED = 'false';
  const out = gate.assertAlphaLiveExecution(
    { strategy_id: 'S1', live_allowed: true, shadow: false },
    { simulated: true },
  );
  assert.equal(out.allowed, true);
  assert.equal(out.accountEnvironment, 'OKX_DEMO');
  assert.equal(gate.resolveAccountEnvironment({ simulated: true }), 'OKX_DEMO');
});

test('Case 4: EXECUTE + LIVE + global false → LIVE_EXECUTION_NOT_AUTHORIZED', () => {
  process.env.V41_LIVE_TRADING_ENABLED = 'false';
  assert.throws(
    () =>
      gate.assertAlphaLiveExecution(
        { strategy_id: 'S1', live_allowed: true },
        { simulated: false },
      ),
    (err) => err.code === 'LIVE_EXECUTION_NOT_AUTHORIZED',
  );
});

test('Case 5: EXECUTE + LIVE + global true + strategy false → STRATEGY_LIVE_NOT_ALLOWED', () => {
  process.env.V41_LIVE_TRADING_ENABLED = 'true';
  assert.throws(
    () =>
      gate.assertAlphaLiveExecution(
        { strategy_id: 'S1', live_allowed: false },
        { simulated: false },
      ),
    (err) => err.code === 'STRATEGY_LIVE_NOT_ALLOWED',
  );
  assert.throws(
    () =>
      gate.assertAlphaLiveExecution(
        { strategy_id: 'S8', live_allowed: true },
        { simulated: false },
      ),
    (err) => err.code === 'STRATEGY_LIVE_NOT_ALLOWED',
  );
});

test('Case 6 mock: EXECUTE + LIVE + both permissions (no OKX call)', () => {
  process.env.V41_LIVE_TRADING_ENABLED = 'true';
  const out = gate.assertAlphaLiveExecution(
    { strategy_id: 'S1', live_allowed: true, origin_strategy_id: 'S1' },
    { simulated: false },
  );
  assert.equal(out.allowed, true);
  assert.equal(out.accountEnvironment, 'OKX_LIVE');
});

test('legacy paper incoming normalizes to SHADOW', () => {
  const out = gate.normalizeIncomingAlpha({ execution_mode: 'paper', order_intent_id: 'x' });
  assert.equal(out.deprecated, true);
  assert.equal(out.replacement, 'SHADOW');
  assert.equal(out.orderIntent.shadow, true);
  assert.equal(out.orderIntent.alpha_execution, 'SHADOW');
});

test('Case 11 mock: QA DEMO does not require QA live flag', () => {
  process.env.V41_QA_LIVE_ENABLED = 'false';
  assert.equal(qaEx.resolveAccountMode({ simulated: true }), 'OKX_DEMO');
});

test('Case 12: QA LIVE + V41_QA_LIVE_ENABLED=false → QA_LIVE_TRADING_DISABLED', () => {
  process.env.V41_HFT_SIM_ENABLED = 'true';
  process.env.V41_QA_EXCHANGE_ENABLED = 'true';
  process.env.V41_QA_LIVE_ENABLED = 'false';
  assert.equal(qaEx.resolveAccountMode({ simulated: false }), 'OKX_LIVE');
  assert.throws(
    () => qaEx.assertQaLivePermission('OKX_LIVE'),
    (err) => err.code === 'QA_LIVE_TRADING_DISABLED',
  );
  assert.doesNotThrow(() => qaEx.assertQaLivePermission('OKX_DEMO'));
});
