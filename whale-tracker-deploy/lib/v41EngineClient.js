/**
 * V4.1 Python engine HTTP client (internal only).
 */
const axios = require('axios');

const DEFAULT_BASE = 'http://127.0.0.1:8711';
const DEFAULT_TIMEOUT = 3000;

function cfg() {
  const enabled = String(process.env.V41_ENGINE_ENABLED || 'true').toLowerCase() !== 'false';
  return {
    enabled,
    baseUrl: String(process.env.V41_ENGINE_BASE_URL || DEFAULT_BASE).replace(/\/$/, ''),
    timeoutMs: Math.max(500, Number(process.env.V41_ENGINE_TIMEOUT_MS) || DEFAULT_TIMEOUT),
    token: String(process.env.V41_ENGINE_INTERNAL_TOKEN || 'dev-internal-token'),
    staleMs: Math.max(3000, Number(process.env.V41_ENGINE_STALE_MS) || 10000),
    offlineMs: Math.max(5000, Number(process.env.V41_ENGINE_OFFLINE_MS) || 30000),
  };
}

let lastSuccessfulSnapshotAt = 0;
let lastError = '';
let lastLatencyMs = 0;

function bridgeStatus() {
  const c = cfg();
  const now = Date.now();
  const age = lastSuccessfulSnapshotAt ? now - lastSuccessfulSnapshotAt : null;
  let freshness = 'UNKNOWN';
  if (!c.enabled) freshness = 'DISABLED';
  else if (!lastSuccessfulSnapshotAt) freshness = 'NEVER';
  else if (age > c.offlineMs) freshness = 'OFFLINE';
  else if (age > c.staleMs) freshness = 'STALE';
  else freshness = 'LIVE';
  return {
    enabled: c.enabled,
    connected: freshness === 'LIVE' || freshness === 'STALE',
    engineUrl: c.baseUrl,
    lastSnapshotAt: lastSuccessfulSnapshotAt || 0,
    lastError: lastError || '',
    latencyMs: lastLatencyMs,
    freshness,
    staleMs: c.staleMs,
    offlineMs: c.offlineMs,
  };
}

function engineError(err, fallbackCode) {
  const data = err?.response?.data;
  const detail = data?.detail;
  const detailObj = detail && typeof detail === 'object' && !Array.isArray(detail) ? detail : null;
  const out = new Error(
    data?.error?.message ||
      detailObj?.message ||
      detailObj?.error?.message ||
      (typeof detail === 'string' ? detail : null) ||
      data?.message ||
      err?.message ||
      'Quant engine unavailable',
  );
  if (err?.code === 'ECONNABORTED' || /timeout/i.test(String(err?.message || ''))) {
    out.status = 504;
    out.code = 'V41_ENGINE_TIMEOUT';
  } else if (err?.response?.status) {
    out.status = err.response.status >= 500 ? 502 : err.response.status;
    out.code =
      data?.error?.code ||
      detailObj?.code ||
      detailObj?.error?.code ||
      fallbackCode;
  } else {
    out.status = 502;
    out.code = fallbackCode || 'V41_ENGINE_UNAVAILABLE';
  }
  out.details = data || undefined;
  return out;
}

async function request(method, path, data, timeoutOverrideMs) {
  const c = cfg();
  if (!c.enabled) {
    const err = new Error('V4.1 engine disabled');
    err.status = 503;
    err.code = 'V41_ENGINE_DISABLED';
    throw err;
  }
  const started = Date.now();
  try {
    const res = await axios({
      method,
      url: `${c.baseUrl}${path}`,
      data,
      timeout: Math.max(500, Number(timeoutOverrideMs) || c.timeoutMs),
      headers: {
        'X-Engine-Token': c.token,
        'Content-Type': 'application/json',
      },
      validateStatus: (s) => s >= 200 && s < 300,
    });
    lastLatencyMs = Date.now() - started;
    lastError = '';
    if (path.includes('/snapshot') || path.includes('/health')) {
      lastSuccessfulSnapshotAt = Date.now();
    }
    return res.data;
  } catch (err) {
    lastLatencyMs = Date.now() - started;
    lastError = err.message || 'engine request failed';
    console.error('[V41_SNAPSHOT_FAILED]', method, path, lastError);
    throw engineError(err, 'V41_ENGINE_UNAVAILABLE');
  }
}

async function health() {
  return request('GET', '/internal/v1/health');
}

async function getSnapshot() {
  const data = await request('GET', '/internal/v1/snapshot');
  lastSuccessfulSnapshotAt = Date.now();
  return data;
}

async function getRegime() {
  return request('GET', '/internal/v1/regime');
}

async function getRiskBudget() {
  return request('GET', '/internal/v1/risk-budget');
}

async function getStrategyHealth() {
  return request('GET', '/internal/v1/strategy-health');
}

async function getTradeIntents() {
  return request('GET', '/internal/v1/trade-intents');
}

async function getOrderIntents() {
  return request('GET', '/internal/v1/order-intents');
}

async function getPositions() {
  return request('GET', '/internal/v1/positions');
}

async function getIncidents() {
  return request('GET', '/internal/v1/incidents');
}

async function start() {
  return request('POST', '/internal/v1/control/start', {}, 15_000);
}

async function pause() {
  return request('POST', '/internal/v1/control/pause', {}, 15_000);
}

async function kill(body = {}) {
  console.log('[V41_KILL_SWITCH]', body?.reason || 'MANUAL_EMERGENCY_STOP');
  return request('POST', '/internal/v1/control/kill', body, 15_000);
}

async function resume(body) {
  console.log('[V41_MANUAL_RESUME]', body?.operator_id || '', body?.incident_id || '');
  return request('POST', '/internal/v1/control/resume', body);
}

async function setActiveStrategy(strategyId) {
  return switchStrategy({ strategy_id: strategyId, reason: 'manual_user_switch' });
}

async function getActiveStrategy() {
  return request('GET', '/internal/v1/strategy/active');
}

async function listStrategies() {
  return request('GET', '/internal/v1/strategy/list');
}

async function switchStrategy(body) {
  console.log('[V41_STRATEGY_SWITCH]', body?.strategy_id || '', body?.operator_id || '');
  return request('POST', '/internal/v1/strategy/switch', body);
}

async function sendExecutionReport(report) {
  console.log('[V41_EXECUTION_REPORT_SENT]', report?.order_intent_id || report?.client_order_id || '');
  return request('POST', '/internal/v1/execution-reports', report);
}

async function hftSimStart(body) {
  // Exchange QA can take many minutes (state-driven open/close + reconcile)
  const longMs = Math.max(600_000, Number(process.env.V41_QA_START_TIMEOUT_MS) || 900_000);
  return request('POST', '/internal/v1/test/hft-sim/start', body || {}, longMs);
}

async function hftSimStop() {
  const longMs = Math.max(120_000, Number(process.env.V41_QA_STOP_TIMEOUT_MS) || 180_000);
  return request('POST', '/internal/v1/test/hft-sim/stop', {}, longMs);
}

async function hftSimStatus() {
  return request('GET', '/internal/v1/test/hft-sim/status');
}

async function hftSimReport() {
  return request('GET', '/internal/v1/test/hft-sim/report');
}

async function whaleTelemetry() {
  return request('GET', '/internal/v1/data/whale-telemetry');
}

async function executionSelections() {
  return request('GET', '/internal/v1/execution/selections');
}

async function executionSelect(body) {
  return request('POST', '/internal/v1/execution/select', body || {});
}

module.exports = {
  cfg,
  bridgeStatus,
  health,
  getSnapshot,
  getRegime,
  getRiskBudget,
  getStrategyHealth,
  getTradeIntents,
  getOrderIntents,
  getPositions,
  getIncidents,
  start,
  pause,
  kill,
  resume,
  setActiveStrategy,
  getActiveStrategy,
  listStrategies,
  switchStrategy,
  sendExecutionReport,
  hftSimStart,
  hftSimStop,
  hftSimStatus,
  hftSimReport,
  whaleTelemetry,
  executionSelections,
  executionSelect,
};
