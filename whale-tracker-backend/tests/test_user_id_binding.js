'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const binding = require('../lib/v41UserBinding');
const gateway = require('../lib/v41ExecutionGateway');
const v41 = require('../lib/v41EngineClient');

test('trusted user_id ignores forgeable body', () => {
  binding.clearBoundEngineOwner();
  delete process.env.V41_ENGINE_OWNER_USER_ID;
  assert.equal(binding.resolveTrustedUserId({}), '');
  assert.equal(gateway.resolveUserId({ user_id: 'forged-from-browser' }), '');
  binding.bindEngineOwner('user_session_abc');
  assert.equal(gateway.resolveUserId({ user_id: 'forged-from-browser' }), 'user_session_abc');
  assert.equal(
    binding.resolveTrustedUserId({ sessionUserId: 'user_login_1' }),
    'user_login_1',
  );
  binding.clearBoundEngineOwner();
});

test('EXECUTE without trusted user_id fail-closes', () => {
  binding.clearBoundEngineOwner();
  delete process.env.V41_ENGINE_OWNER_USER_ID;
  assert.throws(
    () => binding.assertExecuteUserReady(''),
    (err) => err.code === 'ALPHA_EXECUTION_USER_NOT_READY',
  );
});

test('SHADOW mock gateway stamps authenticated user_id, ignores body, no OKX', async () => {
  process.env.V41_ALPHA_EXECUTION = 'SHADOW';
  process.env.V41_LIVE_TRADING_ENABLED = 'false';
  binding.clearBoundEngineOwner();
  binding.bindEngineOwner('user_c7a142367823645f');
  const origHealth = v41.health;
  v41.health = async () => ({ state: 'RUNNING', ok: true });
  try {
    const out = await gateway.executeOrderIntent(
      {
        order_intent_id: `oi-uid-mock-${Date.now()}`,
        client_order_id: `cl-uid-mock-${Date.now()}`,
        trade_intent_id: 'ti-uid-mock',
        origin_strategy_id: 'S1',
        strategy_id: 'S1',
        symbol: 'BTC-USDT-SWAP',
        side: 'buy',
        quantity: '0.01',
        user_id: 'forged-browser-user',
        alpha_execution: 'SHADOW',
        shadow: true,
      },
      { sessionUserId: 'user_c7a142367823645f' },
    );
    assert.equal(out.ok, true);
    assert.equal(out.shadow, true);
    assert.equal(out.report.status, 'WOULD_SUBMIT');
    assert.equal(out.report.exchange_order_id, null);
    const rec = gateway.findRecord(out.report.order_intent_id);
    assert.equal(rec.user_id, 'user_c7a142367823645f');
    assert.notEqual(rec.user_id, 'forged-browser-user');
  } finally {
    v41.health = origHealth;
    binding.clearBoundEngineOwner();
  }
});

test('EXECUTE mock without bind fails before any OKX call', async () => {
  process.env.V41_ALPHA_EXECUTION = 'EXECUTE';
  process.env.V41_LIVE_TRADING_ENABLED = 'false';
  binding.clearBoundEngineOwner();
  delete process.env.V41_ENGINE_OWNER_USER_ID;
  const origHealth = v41.health;
  v41.health = async () => ({ state: 'RUNNING', ok: true });
  try {
    await assert.rejects(
      () =>
        gateway.executeOrderIntent({
          order_intent_id: `oi-exec-nouser-${Date.now()}`,
          client_order_id: `cl-exec-nouser-${Date.now()}`,
          origin_strategy_id: 'S1',
          symbol: 'BTC-USDT-SWAP',
          side: 'buy',
          quantity: '0.01',
          user_id: 'forged-browser-user',
          alpha_execution: 'EXECUTE',
        }),
      (err) => err.code === 'ALPHA_EXECUTION_USER_NOT_READY',
    );
  } finally {
    v41.health = origHealth;
    process.env.V41_ALPHA_EXECUTION = 'SHADOW';
  }
});
