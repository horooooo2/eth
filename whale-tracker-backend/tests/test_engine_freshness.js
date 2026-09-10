'use strict';

require('./helpers/isolateSqlite');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeRuntimeStatuses, staleThresholdMs } = require('../lib/v41EngineClient');

test('stale threshold is 4x tick cadence, min 20s', () => {
  assert.equal(staleThresholdMs(5), 20_000);
  assert.equal(staleThresholdMs(10), 40_000);
  assert.equal(staleThresholdMs(1), 20_000);
});

test('PAUSED engine is PAUSED even when last_tick_at is fresh', () => {
  const now = Date.parse('2026-09-10T00:00:20.000Z');
  const out = computeRuntimeStatuses(
    now,
    {
      state: 'PAUSED',
      last_tick_at: '2026-09-10T00:00:18.000Z',
      last_evaluated_at: '2026-09-10T00:00:18.000Z',
      active_strategy: 'S1',
      tick_interval_sec: 5,
    },
    now,
    { enabled: true, offlineMs: 30_000 },
  );
  assert.equal(out.engine_runtime_status, 'PAUSED');
  assert.equal(out.freshness, 'PAUSED');
  assert.notEqual(out.engine_runtime_status, 'FRESH');
  assert.equal(out.strategy_runtime_status, 'NOT_RUNNING');
  assert.equal(out.transport_status, 'CONNECTED');
});

test('RUNNING + fresh last_tick_at is FRESH, not last HTTP poll time', () => {
  const now = Date.parse('2026-09-10T00:00:20.000Z');
  const staleHttpPoll = now - 60_000;
  const out = computeRuntimeStatuses(
    now,
    {
      state: 'RUNNING',
      last_tick_at: '2026-09-10T00:00:16.000Z',
      last_evaluated_at: '2026-09-10T00:00:16.000Z',
      active_strategy: 'S1',
      tick_interval_sec: 5,
    },
    staleHttpPoll,
    { enabled: true, offlineMs: 30_000 },
  );
  assert.equal(out.engine_runtime_status, 'FRESH');
  assert.equal(out.strategy_runtime_status, 'RUNNING');
  assert.equal(out.transport_status, 'DISCONNECTED');
});

test('RUNNING + last_tick_at older than 4x cadence is STALE', () => {
  const now = Date.parse('2026-09-10T00:01:00.000Z');
  const out = computeRuntimeStatuses(
    now,
    {
      state: 'RUNNING',
      last_tick_at: '2026-09-10T00:00:20.000Z',
      last_evaluated_at: '2026-09-10T00:00:20.000Z',
      active_strategy: 'S1',
      tick_interval_sec: 5,
    },
    now,
    { enabled: true, offlineMs: 30_000 },
  );
  assert.equal(out.last_tick_age_ms, 40_000);
  assert.equal(out.staleMs, 20_000);
  assert.equal(out.engine_runtime_status, 'STALE');
  assert.equal(out.strategy_runtime_status, 'STALE');
});

test('OFFLINE engine stays OFFLINE', () => {
  const now = Date.now();
  const out = computeRuntimeStatuses(
    now,
    { state: 'OFFLINE', last_tick_at: null, active_strategy: 'S1', tick_interval_sec: 5 },
    now,
    { enabled: true },
  );
  assert.equal(out.engine_runtime_status, 'OFFLINE');
  assert.equal(out.strategy_runtime_status, 'NOT_RUNNING');
});
