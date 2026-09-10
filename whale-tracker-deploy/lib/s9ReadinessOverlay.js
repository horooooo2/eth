'use strict';

const startup = require('./v41StartupRecovery');

function overlayS9RuntimeReadiness(bundle, recovery) {
  if (!bundle || typeof bundle !== 'object') return bundle;
  const rec = recovery || startup.getExecutionRecoveryStatus() || {};
  const recReady = rec.status === 'READY' || rec.status === 'SHADOW_SKIPPED';
  const pre = bundle.preflight && typeof bundle.preflight === 'object' ? bundle.preflight : {};
  const checks = { ...(pre.checks || {}) };
  checks.recovery_ready = recReady;
  const blockers = Object.entries(checks)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  const ready = blockers.length === 0;
  bundle.preflight = {
    ...pre,
    checks,
    ready,
    status: ready ? 'READY' : 'NOT_READY',
    blockers,
  };
  bundle.S9_DEMO_PREFLIGHT_READINESS = bundle.preflight.status;
  bundle.recovery_status = rec.status || null;
  return bundle;
}

module.exports = { overlayS9RuntimeReadiness };
