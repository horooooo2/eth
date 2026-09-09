/**
 * Node-side hard-gate tests for QA-HFT-SIM (no OKX).
 * Run: node scripts/test-hft-sim-gateway-guards.js
 */
const assert = require('assert');
const { assertTestOrderSafe } = require('../lib/v41ExecutionGateway');

function expectThrow(fn, code) {
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
    assert.strictEqual(err.code, code, `expected ${code} got ${err.code}`);
  }
  assert.ok(threw, `expected throw ${code}`);
}

// test_mode without simulator and without qa_execution → blocked
expectThrow(
  () => assertTestOrderSafe({ test_mode: true, execution_target: 'okx' }),
  'TEST_ORDER_REAL_EXCHANGE_BLOCKED',
);
expectThrow(
  () => assertTestOrderSafe({ test_mode: true, execution_target: 'node_gateway' }),
  'TEST_ORDER_REAL_EXCHANGE_BLOCKED',
);
expectThrow(
  () => assertTestOrderSafe({ test_mode: true }),
  'TEST_ORDER_REAL_EXCHANGE_BLOCKED',
);

// Non-test orders pass
assertTestOrderSafe({ test_mode: false, execution_target: 'okx' });
assertTestOrderSafe({});

// Simulator OK
assertTestOrderSafe({ test_mode: true, execution_target: 'simulator' });

// QA exchange path allowed at assert layer (full gate checks env+keys later)
assertTestOrderSafe({
  test_mode: true,
  qa_execution: true,
  execution_target: 'node_gateway',
});

console.log('OK gateway guards');
