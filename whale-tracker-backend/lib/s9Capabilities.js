'use strict';

/**
 * Explicit S9 Node capability registration.
 * Implementation readiness must not inspect deployment directories.
 */
const CAPABILITIES = Object.create(null);

function registerCapability(name, ready, source) {
  const key = String(name || '').trim();
  if (!key) return;
  CAPABILITIES[key] = { ready: Boolean(ready), source: String(source || '') };
}

function getCapability(name) {
  const row = CAPABILITIES[String(name || '').trim()];
  return Boolean(row && row.ready);
}

function registeredCapabilities() {
  const out = {};
  for (const [key, row] of Object.entries(CAPABILITIES)) {
    out[key] = Boolean(row && row.ready);
  }
  return out;
}

registerCapability('fee_capability', true, 'v41S9Fee.fetchTrustedOwnerTradeFee');
registerCapability('node_presubmit_capability', true, 'v41S9Demo.assertS9PreSubmit');
registerCapability('protective_stop_capability', true, 'v41ProtectiveStop');
registerCapability('active_exit_capability', true, 'v41S9Demo+s9_exits');

module.exports = {
  registerCapability,
  getCapability,
  registeredCapabilities,
};
