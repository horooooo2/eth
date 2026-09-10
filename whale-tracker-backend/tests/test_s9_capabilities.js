'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const caps = require('../lib/s9Capabilities');
const { overlayS9RuntimeReadiness } = require('../lib/s9ReadinessOverlay');

test('node capabilities are registered without deploy paths', () => {
  const registered = caps.registeredCapabilities();
  assert.equal(registered.fee_capability, true);
  assert.equal(registered.node_presubmit_capability, true);
  assert.equal(registered.protective_stop_capability, true);
  assert.equal(registered.active_exit_capability, true);
  const readinessSrc = fs.readFileSync(path.join(__dirname, '../../ai-trading-system-v41/src/runtime/s9_readiness.py'), 'utf8');
  assert.doesNotMatch(readinessSrc, /\/root\/whale-tracker-backend/);
  assert.doesNotMatch(readinessSrc, /\/root\/whale-tracker-deploy/);
  assert.doesNotMatch(readinessSrc, /_backend_file/);
});

test('sync-deploy pack list includes S9 capability modules', () => {
  const src = fs.readFileSync(path.join(__dirname, '../scripts/sync-deploy.js'), 'utf8');
  assert.match(src, /lib\/s9Capabilities\.js/);
  assert.match(src, /lib\/s9ReadinessOverlay\.js/);
});

test('recovery overlay flips preflight without touching implementation', () => {
  const bundle = overlayS9RuntimeReadiness(
    {
      S9_IMPLEMENTATION_READINESS: 'READY',
      S9_DEMO_PREFLIGHT_READINESS: 'READY',
      S9_DEMO_VALIDATION_STATUS: 'UNVERIFIED',
      preflight: {
        ready: true,
        status: 'READY',
        checks: { implementation: true, fee_ready: true, market_data_ready: true },
        blockers: [],
      },
    },
    { status: 'FAILED', reason: 'ACCOUNT_CONTEXT_NOT_READY' },
  );
  assert.equal(bundle.S9_IMPLEMENTATION_READINESS, 'READY');
  assert.equal(bundle.S9_DEMO_PREFLIGHT_READINESS, 'NOT_READY');
  assert.equal(bundle.S9_DEMO_VALIDATION_STATUS, 'UNVERIFIED');
  assert.equal(bundle.preflight.checks.recovery_ready, false);
  assert.ok(bundle.preflight.blockers.includes('recovery_ready'));
});
