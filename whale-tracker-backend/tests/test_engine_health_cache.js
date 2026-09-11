'use strict';

require('./helpers/isolateSqlite');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bridgeStatus, rememberEnginePayload } = require('../lib/v41EngineClient');

function healthPayload() {
  const now = new Date().toISOString();
  return {
    ok: true,
    state: 'RUNNING',
    active_strategy: 'S9',
    last_tick_at: now,
    last_evaluated_at: now,
    tick_interval_sec: 5,
    alpha_execution: 'EXECUTE',
    evaluation_count: 233,
  };
}

/** Shape returned by /internal/v1/strategy/{id}/diagnostics: runtime_state, no state. */
function diagnosticsPayload() {
  return {
    strategy_id: 'S9',
    active: true,
    runtime_state: 'RUNNING',
    evaluation_count: 233,
    last_evaluated_at: new Date().toISOString(),
    last_tick_at: new Date().toISOString(),
  };
}

test('health payload populates the engine health cache', () => {
  rememberEnginePayload(healthPayload());
  const bridge = bridgeStatus();
  assert.equal(bridge.engine_runtime_status, 'FRESH');
  assert.equal(bridge.strategy_runtime_status, 'RUNNING');
  assert.equal(bridge.alpha_execution, 'EXECUTE');
});

test('diagnostics payload must not erase engine truth', () => {
  rememberEnginePayload(healthPayload());
  rememberEnginePayload(diagnosticsPayload());
  const bridge = bridgeStatus();
  assert.equal(bridge.engine_runtime_status, 'FRESH');
  assert.notEqual(bridge.engine_runtime_status, 'OFFLINE');
  assert.equal(bridge.strategy_runtime_status, 'RUNNING');
  assert.notEqual(bridge.strategy_runtime_status, 'INACTIVE');
  assert.equal(bridge.alpha_execution, 'EXECUTE');
});

test('an explicit OFFLINE state is still honoured', () => {
  rememberEnginePayload(healthPayload());
  rememberEnginePayload({ ok: false, state: 'OFFLINE', last_tick_at: null, tick_interval_sec: 5 });
  const bridge = bridgeStatus();
  assert.equal(bridge.engine_runtime_status, 'OFFLINE');
});
