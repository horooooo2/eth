/**
 * Node startup recovery. SHADOW never mutates OKX.
 * EXECUTE: query-only recover of orders + protective algos, then reconcile.
 */
const alphaGate = require('./v41AlphaLiveGate');
const demoV1 = require('./v41DemoExecuteV1');
const prot = require('./v41ProtectiveStop');
const userBinding = require('./v41UserBinding');
const runtimeEvents = require('./v41RuntimeEvents');

function persistRecoverySafe(status, extra) {
  try {
    runtimeEvents.recordRecovery(status, extra);
  } catch (err) {
    console.warn('[V41_RUNTIME_EVENT_PERSIST_FAILED]', err && err.message ? err.message : err);
  }
}

let recovery = {
  status: 'PENDING',
  reason: null,
  private_queries: 0,
  mutations: 0,
  at: null,
};

function getExecutionRecoveryStatus() {
  return { ...recovery };
}

function setExecutionRecoveryStatus(partial) {
  recovery = { ...recovery, ...partial, at: new Date().toISOString() };
}

function isShadowRuntime() {
  const alpha = String(process.env.V41_ALPHA_EXECUTION || '').trim().toUpperCase();
  if (alpha === 'EXECUTE') return false;
  if (alpha === 'SHADOW') return true;
  const legacy = String(process.env.V41_ENGINE_EXECUTION_MODE || '').trim().toLowerCase();
  if (legacy === 'node_gateway') return false;
  return true;
}

function failStatus(code, message, details) {
  setExecutionRecoveryStatus({
    status: 'FAILED',
    reason: code,
    error: message,
    details: details || undefined,
  });
  persistRecoverySafe('FAILED', {
    reason: code,
    error: message,
    details: details || undefined,
    at: recovery.at,
  });
  return getExecutionRecoveryStatus();
}

async function runStartupRecovery(deps = {}) {
  prot.ensureTable();
  if (typeof deps.ensureExecTable === 'function') deps.ensureExecTable();

  if (isShadowRuntime()) {
    setExecutionRecoveryStatus({
      status: 'SHADOW_SKIPPED',
      reason: 'SHADOW_NO_PRIVATE_TRADE',
      private_queries: 0,
      mutations: 0,
    });
    return getExecutionRecoveryStatus();
  }

  const owner =
    deps.ownerUserId ||
    userBinding.getBoundEngineOwner() ||
    String(process.env.V41_ENGINE_OWNER_USER_ID || '').trim();
  persistRecoverySafe('STARTED', { reason: 'EXECUTE_RECOVERY' });
  if (!owner) {
    return failStatus('ACCOUNT_CONTEXT_NOT_READY', 'trusted owner missing', {
      missing: 'trusted_owner',
      bound_engine_owner: userBinding.getBoundEngineOwner() || null,
      owner_env_user_id: String(process.env.V41_ENGINE_OWNER_USER_ID || '').trim() || null,
      user_exchange_keys: null,
      simulated: null,
      account_environment: null,
    });
  }
  const getCreds = deps.getOkxCredentialsForUser;
  const creds = typeof getCreds === 'function' ? getCreds(owner) : null;
  if (!creds || !creds.apiKey) {
    return failStatus('ACCOUNT_CONTEXT_NOT_READY', 'OKX credentials not ready', {
      missing: 'user_exchange_keys',
      trusted_owner: owner,
      user_exchange_keys: creds ? 'incomplete' : null,
      simulated: creds && creds.simulated != null ? Boolean(creds.simulated) : null,
      account_environment: null,
    });
  }
  const env = alphaGate.resolveAccountEnvironment(creds);
  if (env !== 'OKX_DEMO') {
    return failStatus('DEMO_EXECUTE_V1_ENV_BLOCKED', `recovery env ${env}`);
  }

  try {
    const orders = await demoV1.recoverNonterminal({
      listNonterminal: deps.listNonterminal,
      getOrder: deps.getOrder,
      upsert: deps.upsertOrder,
    });
    recovery.private_queries += 1;
    const stops = await prot.recoverProtectiveStops({
      getAlgoOrder: deps.getAlgoOrder,
      listRecoverable: deps.listRecoverableStops,
      ownedContractsByPosition: deps.ownedContractsByPosition || {},
    });
    recovery.private_queries += 1;
    const missingStop = stops.find((s) => s.code === 'PROTECTIVE_STOP_MISSING');
    if (missingStop) {
      return failStatus('PROTECTIVE_STOP_MISSING', 'owned position has no active protective stop');
    }
    if (typeof deps.reconcile === 'function') {
      const recon = await deps.reconcile();
      recovery.private_queries += 1;
      try {
        runtimeEvents.recordReconciliation(!(recon && recon.block), {
          reason_code: recon && (recon.reason_code || recon.status),
          status: recon && recon.status,
        });
      } catch {
        // observability only
      }
      if (recon && recon.block) {
        return failStatus(recon.reason_code || 'RECONCILIATION_MISMATCH', recon.status);
      }
    }
    setExecutionRecoveryStatus({
      status: 'READY',
      reason: null,
      orders: orders.length,
      stops: stops.length,
      mutations: 0,
    });
    persistRecoverySafe('READY', { orders: orders.length, stops: stops.length, at: recovery.at });
    return getExecutionRecoveryStatus();
  } catch (err) {
    return failStatus(err.code || 'EXECUTION_RECOVERY_FAILED', err.message || String(err));
  }
}

function assertRecoveryAllowsOpening() {
  const st = recovery.status;
  if (st === 'SHADOW_SKIPPED') return { ok: true, status: st };
  if (st === 'READY') return { ok: true, status: st };
  const err = new Error(`execution recovery not ready: ${st}`);
  err.status = 403;
  err.code = st === 'FAILED' ? recovery.reason || 'EXECUTION_RECOVERY_FAILED' : 'EXECUTION_RECOVERY_PENDING';
  throw err;
}

module.exports = {
  getExecutionRecoveryStatus,
  setExecutionRecoveryStatus,
  isShadowRuntime,
  runStartupRecovery,
  assertRecoveryAllowsOpening,
};
