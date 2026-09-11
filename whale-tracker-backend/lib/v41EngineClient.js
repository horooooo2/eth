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
let lastEngineHealth = null;
let probeTimer = null;

function parseIsoMs(iso) {
  if (!iso) return null;
  const t = Date.parse(String(iso));
  return Number.isFinite(t) ? t : null;
}

function staleThresholdMs(tickSec) {
  const tick = Math.max(1, Number(tickSec) || 5);
  return Math.max(tick * 4 * 1000, 20_000);
}

function rememberEnginePayload(data) {
  lastSuccessfulSnapshotAt = Date.now();
  if (!data || typeof data !== 'object') return;
  const engine = data.engine && typeof data.engine === 'object' ? data.engine : data;
  // Only /health and /snapshot carry engine truth. Payloads without `state`
  // (e.g. strategy diagnostics, which expose runtime_state) must not erase it,
  // otherwise the bridge reports OFFLINE/INACTIVE while Python keeps ticking.
  if (!String(engine.state || data.state || '')) return;
  lastEngineHealth = {
    state: String(engine.state || data.state || ''),
    last_tick_at: engine.last_tick_at || data.last_tick_at || null,
    last_evaluated_at: engine.last_evaluated_at || data.last_evaluated_at || null,
    active_strategy: engine.active_strategy || data.active_strategy || null,
    tick_interval_sec: Number(engine.tick_interval_sec || data.tick_interval_sec || 5),
    alpha_execution: engine.alpha_execution || data.alpha_execution || null,
    evaluation_count: engine.evaluation_count || data.evaluation_count || 0,
  };
}

function computeRuntimeStatuses(nowMs, cached, transportAt, options = {}) {
  const enabled = options.enabled !== false;
  const offlineMs = Math.max(5000, Number(options.offlineMs) || 30000);
  const now = Number(nowMs) || Date.now();
  const transportAge = transportAt ? now - transportAt : null;
  let transport_status = 'DISCONNECTED';
  if (!enabled) transport_status = 'DISABLED';
  else if (transportAt && transportAge != null && transportAge <= offlineMs) transport_status = 'CONNECTED';

  const h = cached || {};
  const state = String(h.state || '').toUpperCase();
  const tickMs = parseIsoMs(h.last_tick_at);
  const evalMs = parseIsoMs(h.last_evaluated_at);
  const thresh = staleThresholdMs(h.tick_interval_sec);
  const tickAge = tickMs != null ? now - tickMs : null;
  const evalAge = evalMs != null ? now - evalMs : null;

  let engine_runtime_status = 'OFFLINE';
  if (!enabled) engine_runtime_status = 'DISABLED';
  else if (!state || state === 'OFFLINE') engine_runtime_status = 'OFFLINE';
  else if (state === 'PAUSED') engine_runtime_status = 'PAUSED';
  else if (state === 'LOCKED') engine_runtime_status = 'LOCKED';
  else if (tickMs == null) engine_runtime_status = 'OFFLINE';
  else if (tickAge > thresh) engine_runtime_status = 'STALE';
  else engine_runtime_status = 'FRESH';

  const sid = String(h.active_strategy || '').toUpperCase();
  let strategy_runtime_status = 'NOT_EVALUATING';
  if (!sid) strategy_runtime_status = 'INACTIVE';
  else if (state !== 'RUNNING') strategy_runtime_status = 'NOT_RUNNING';
  else if (evalMs == null) strategy_runtime_status = 'NOT_EVALUATING';
  else if (evalAge > thresh) strategy_runtime_status = 'STALE';
  else strategy_runtime_status = 'RUNNING';

  return {
    transport_status,
    engine_runtime_status,
    strategy_runtime_status,
    freshness: engine_runtime_status,
    last_tick_age_ms: tickAge,
    last_eval_age_ms: evalAge,
    staleMs: thresh,
    last_tick_at: h.last_tick_at || null,
    last_evaluated_at: h.last_evaluated_at || null,
  };
}

function bridgeStatus() {
  const c = cfg();
  const runtime = computeRuntimeStatuses(Date.now(), lastEngineHealth, lastSuccessfulSnapshotAt, {
    enabled: c.enabled,
    offlineMs: c.offlineMs,
  });
  return {
    enabled: c.enabled,
    connected: runtime.transport_status === 'CONNECTED',
    engineUrl: c.baseUrl,
    lastSnapshotAt: lastSuccessfulSnapshotAt || 0,
    lastError: lastError || '',
    latencyMs: lastLatencyMs,
    freshness: runtime.freshness,
    transport_status: runtime.transport_status,
    engine_runtime_status: runtime.engine_runtime_status,
    strategy_runtime_status: runtime.strategy_runtime_status,
    last_tick_at: runtime.last_tick_at,
    last_evaluated_at: runtime.last_evaluated_at,
    last_tick_age_ms: runtime.last_tick_age_ms,
    last_eval_age_ms: runtime.last_eval_age_ms,
    staleMs: runtime.staleMs,
    offlineMs: c.offlineMs,
    alpha_execution: lastEngineHealth?.alpha_execution || null,
  };
}

function startEngineProbe() {
  if (probeTimer) return;
  const intervalMs = 5000;
  const run = () => {
    health().catch(() => {});
  };
  run();
  probeTimer = setInterval(run, intervalMs);
  if (typeof probeTimer.unref === 'function') probeTimer.unref();
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

async function request(method, path, data, timeoutOverrideMs, params) {
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
      params,
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
      rememberEnginePayload(res.data);
    } else {
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
  rememberEnginePayload(data);
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

async function bindUser(userId) {
  return request('POST', '/internal/v1/runtime/bind-user', { user_id: String(userId || '') });
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

async function getStrategyDiagnostics(strategyId) {
  const sid = encodeURIComponent(String(strategyId || 'S1').trim() || 'S1');
  return request('GET', `/internal/v1/strategy/${sid}/diagnostics`);
}

async function getActiveStrategy() {
  return request('GET', '/internal/v1/strategy/active');
}

async function getStrategyConfigList() {
  return request('GET', '/internal/v1/strategy-configs');
}

async function getStrategyConfig(configId) {
  const id = encodeURIComponent(String(configId || '').trim() || 'S1');
  return request('GET', `/internal/v1/strategy-configs/${id}`);
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

async function listRuntimeEvents(params = {}) {
  return request('GET', '/internal/v1/runtime-events', undefined, undefined, params);
}

async function ingestRuntimeEvent(body) {
  return request('POST', '/internal/v1/runtime-events', body || {});
}

module.exports = {
  cfg,
  bridgeStatus,
  computeRuntimeStatuses,
  rememberEnginePayload,
  staleThresholdMs,
  startEngineProbe,
  health,
  getSnapshot,
  getRegime,
  getRiskBudget,
  getStrategyHealth,
  getTradeIntents,
  getOrderIntents,
  getPositions,
  getIncidents,
  bindUser,
  start,
  pause,
  kill,
  resume,
  setActiveStrategy,
  getActiveStrategy,
  getStrategyConfigList,
  getStrategyConfig,
  getStrategyDiagnostics,
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
  listRuntimeEvents,
  ingestRuntimeEvent,
};
