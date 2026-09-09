import { computed, ref, watch } from 'vue';
import {
  deleteWhaleAiKey,
  deleteWhaleAiTradeKeys,
  fetchWhaleAiEngineDashboard,
  fetchWhaleAiEngineHealth,
  fetchWhaleAiStrategyDiagnostics,
  fetchWhaleAiKeyStatus,
  fetchWhaleAiTradeStatus,
  killWhaleAiEngine,
  pauseWhaleAiEngine,
  resumeWhaleAiEngine,
  saveWhaleAiKey,
  saveWhaleAiTradeKeys,
  setWhaleAiActiveStrategy,
  startWhaleAiEngine,
  type V41BridgeStatus,
  type V41EngineSnapshot,
  type V41Incident,
  type V41PersonalView,
  type V41Regime,
  type V41RiskBudget,
  type V41Safety,
  type V41StrategyDiagnostics,
  type V41StrategyHealth,
  type V41TradeIntent,
  type WhaleAiKeyStatus,
  type WhaleAiTradeStatus,
} from '@/api';
import { isLoggedIn } from '@/stores/auth';

const status = ref<WhaleAiKeyStatus | null>(null);
const tradeStatus = ref<WhaleAiTradeStatus | null>(null);
const loading = ref(false);
const tradeLoading = ref(false);
let inflight: Promise<WhaleAiKeyStatus | null> | null = null;
let tradeInflight: Promise<WhaleAiTradeStatus | null> | null = null;

export const whaleAiKeyStatus = computed(() => status.value);
export const whaleAiKeyReady = computed(() => Boolean(status.value?.ready || status.value?.configured));
export const whaleAiKeyHint = computed(() => status.value?.apiKeyHint || '');
export const whaleAiKeyLoading = computed(() => loading.value);

export const whaleAiTradeStatus = computed(() => tradeStatus.value);
export const whaleAiTradeReady = computed(() => Boolean(tradeStatus.value?.ready));
export const whaleAiTradeHint = computed(() => tradeStatus.value?.apiKeyHint || '');
export const whaleAiTradeSimulated = computed(() => tradeStatus.value?.simulated !== false);
export const whaleAiTradeLoading = computed(() => tradeLoading.value);

/* ===== V4.1 Engine ===== */
const engineSnapshot = ref<V41EngineSnapshot | null>(null);
const engineView = ref<V41PersonalView | null>(null);
const engineAvailable = ref(false);
const engineBridge = ref<V41BridgeStatus | null>(null);
const engineLoading = ref(false);
const lastEngineUpdate = ref(0);
const engineError = ref('');
const strategyDiagnostics = ref<V41StrategyDiagnostics | null>(null);

export const whaleAiEngineSnapshot = computed(() => engineSnapshot.value);
export const whaleAiEngineView = computed(() => engineView.value);
export const whaleAiEngineAvailable = computed(() => engineAvailable.value);
export const whaleAiEngineBridge = computed(() => engineBridge.value);
export const whaleAiEngineLoading = computed(() => engineLoading.value);
export const whaleAiLastEngineUpdate = computed(() => lastEngineUpdate.value);
export const whaleAiEngineError = computed(() => engineError.value);
export const whaleAiStrategyDiagnostics = computed(() => strategyDiagnostics.value);

export const whaleAiEngineState = computed(
  () =>
    engineView.value?.engine?.state ||
    engineSnapshot.value?.engine?.state ||
    (engineAvailable.value ? 'UNKNOWN' : 'OFFLINE'),
);
export const whaleAiAlphaExecution = computed(() => {
  const fromSnap = String(engineSnapshot.value?.alpha_execution || '').toUpperCase();
  const fromView = String(engineView.value?.engine?.alpha_execution || '').toUpperCase();
  const value = fromSnap || fromView;
  return value === 'EXECUTE' ? 'EXECUTE' : value === 'SHADOW' ? 'SHADOW' : '—';
});
/** Alpha 执行态只读 alpha_execution，不再用 legacy engine.mode。 */
export const whaleAiEngineMode = computed(() => whaleAiAlphaExecution.value);
export const whaleAiEngineVersion = computed(
  () => engineView.value?.engine?.version || engineSnapshot.value?.engine?.version || '4.1',
);
export const whaleAiS3 = computed<V41Regime | null>(() => {
  const mr = engineView.value?.market_risk;
  if (mr) {
    return {
      regime: mr.regime,
      direction_bias: mr.direction_bias,
      confidence: 0,
      risk_multiplier: 1,
      trend_strength: 0,
      breadth_24h: 0,
      rv5m_ratio_30d: 1,
      updated_at: engineView.value?.last_update || '',
    };
  }
  return engineSnapshot.value?.s3 || null;
});
export const whaleAiRiskBudget = computed<V41RiskBudget | null>(() => engineSnapshot.value?.s5 || null);
export const whaleAiSafety = computed<V41Safety | null>(() => {
  const mr = engineView.value?.market_risk;
  if (mr) {
    return {
      level: mr.safety_level,
      status: mr.safety_status,
      reason: null,
      exchange_connected: mr.exchange_connected,
      market_data_latency_ms: mr.market_data_latency_ms ?? null,
      sequence_valid: true,
      positions_reconciled: mr.positions_reconciled,
      orders_reconciled: mr.orders_reconciled,
      risk_engine_healthy: mr.risk_engine_healthy,
      new_entries_enabled: mr.new_entries_enabled,
      active_incident_id: null,
      recovery: { manual_resume_required: false, stable_since: null },
      updated_at: engineView.value?.last_update || '',
    };
  }
  return engineSnapshot.value?.s6 || null;
});
export const whaleAiStrategyHealth = computed<V41StrategyHealth[]>(
  () => engineSnapshot.value?.s7 || [],
);
export const whaleAiActiveStrategyHealth = computed(() => {
  const a = engineView.value?.active_strategy;
  if (a) {
    return {
      strategy_id: a.id,
      health_score: a.health_score,
      state: a.health_state,
      risk_budget_pct_equity: a.risk_budget_pct_equity,
      strategy_risk_used_pct_equity: a.strategy_risk_used_pct_equity,
      strategy_risk_limit_pct_equity: a.strategy_risk_limit_pct_equity,
    };
  }
  const sid = whaleAiActiveStrategy.value;
  const row = (engineSnapshot.value?.s7 || []).find((x) => x.strategy_id === sid);
  return row
    ? {
        strategy_id: sid,
        health_score: row.health_score,
        state: row.state,
        risk_budget_pct_equity: null as number | null,
        strategy_risk_used_pct_equity: null as number | null,
        strategy_risk_limit_pct_equity: null as number | null,
      }
    : null;
});
export const whaleAiTradeIntents = computed<V41TradeIntent[]>(
  () => engineView.value?.signals || engineSnapshot.value?.trade_intents || [],
);
export const whaleAiIncidents = computed<V41Incident[]>(() => engineSnapshot.value?.incidents || []);
export const whaleAiActiveStrategy = computed(
  () =>
    engineView.value?.active_strategy?.id ||
    engineSnapshot.value?.engine?.active_strategy ||
    'S1',
);
export const whaleAiMarketRisk = computed(() => engineView.value?.market_risk || null);
export const whaleAiPortfolioRiskUsed = computed(() => {
  const mr = engineView.value?.market_risk;
  if (mr) return mr.portfolio_risk_used_pct_equity;
  return engineSnapshot.value?.s5?.portfolio?.risk_used ?? null;
});

export function clearWhaleAiKeyStatus() {
  status.value = null;
}

export function clearWhaleAiTradeStatus() {
  tradeStatus.value = null;
}

export function clearWhaleAiEngine() {
  engineSnapshot.value = null;
  engineView.value = null;
  engineAvailable.value = false;
  engineBridge.value = null;
  lastEngineUpdate.value = 0;
  engineError.value = '';
  strategyDiagnostics.value = null;
}

export async function refreshWhaleAiKeyStatus(force = false) {
  if (!isLoggedIn.value) {
    status.value = null;
    return null;
  }
  if (inflight && !force) return inflight;
  loading.value = true;
  inflight = (async () => {
    try {
      const data = await fetchWhaleAiKeyStatus();
      status.value = data;
      return data;
    } catch {
      return status.value;
    } finally {
      loading.value = false;
      inflight = null;
    }
  })();
  return inflight;
}

export async function refreshWhaleAiTradeStatus(force = false) {
  if (!isLoggedIn.value) {
    tradeStatus.value = null;
    return null;
  }
  if (tradeInflight && !force) return tradeInflight;
  tradeLoading.value = true;
  tradeInflight = (async () => {
    try {
      const data = await fetchWhaleAiTradeStatus();
      tradeStatus.value = data;
      return data;
    } catch {
      return tradeStatus.value;
    } finally {
      tradeLoading.value = false;
      tradeInflight = null;
    }
  })();
  return tradeInflight;
}

export async function fetchEngineHealth() {
  if (!isLoggedIn.value) return null;
  try {
    const data = await fetchWhaleAiEngineHealth();
    engineAvailable.value = Boolean(data.engineAvailable && data.ok);
    engineBridge.value = data.bridge || null;
    if (!data.ok) {
      engineError.value = data.message || data.code || 'ENGINE OFFLINE';
    }
    return data;
  } catch (err) {
    engineAvailable.value = false;
    engineError.value = err instanceof Error ? err.message : 'ENGINE OFFLINE';
    return null;
  }
}

export async function fetchEngineDashboard() {
  if (!isLoggedIn.value) {
    clearWhaleAiEngine();
    return null;
  }
  engineLoading.value = true;
  try {
    const data = await fetchWhaleAiEngineDashboard();
    engineBridge.value = data.bridge || null;
    if (!data.snapshot || data.ok === false) {
      engineSnapshot.value = null;
      engineView.value = null;
      engineAvailable.value = false;
      engineError.value = data.message || data.code || 'ENGINE OFFLINE';
      return null;
    }
    engineSnapshot.value = data.snapshot;
    engineView.value = data.view || data.snapshot.view || null;
    if (!engineView.value && data.active_strategy) {
      engineView.value = {
        engine: data.engine || {
          available: Boolean(data.engineAvailable),
          state: data.snapshot.engine?.state || 'OFFLINE',
          alpha_execution: data.snapshot.alpha_execution || data.snapshot.engine?.alpha_execution || 'SHADOW',
          version: data.snapshot.engine?.version || '4.1',
          updated_at: data.snapshot.engine?.updated_at || '',
        },
        active_strategy: data.active_strategy,
        market_risk: data.market_risk || null,
        signals: data.signals || [],
        recent_order_intents: data.recent_order_intents || [],
        last_update: data.last_update || '',
      };
    }
    engineAvailable.value = Boolean(data.engineAvailable);
    lastEngineUpdate.value = Date.now();
    engineError.value = '';
    const sid =
      engineView.value?.active_strategy?.id ||
      engineSnapshot.value?.engine?.active_strategy ||
      'S1';
    try {
      strategyDiagnostics.value = await fetchWhaleAiStrategyDiagnostics(sid);
    } catch {
      strategyDiagnostics.value = data.snapshot.strategy_diagnostics || strategyDiagnostics.value;
    }
    return data.snapshot;
  } catch (err) {
    engineAvailable.value = false;
    engineError.value = err instanceof Error ? err.message : 'ENGINE OFFLINE';
    // Spec: do not keep pretending live — clear snapshot on hard failure
    engineSnapshot.value = null;
    engineView.value = null;
    // Still refresh bridge freshness (NEVER/OFFLINE) so footer is truthful
    try {
      const health = await fetchWhaleAiEngineHealth();
      engineBridge.value = health.bridge || {
        enabled: true,
        connected: false,
        freshness: 'OFFLINE',
        lastSnapshotAt: 0,
        lastError: engineError.value,
        latencyMs: 0,
        engineUrl: '',
        staleMs: 10000,
        offlineMs: 30000,
      };
      engineAvailable.value = Boolean(health.engineAvailable && health.ok);
    } catch {
      engineBridge.value = {
        enabled: true,
        connected: false,
        freshness: 'OFFLINE',
        lastSnapshotAt: engineBridge.value?.lastSnapshotAt || 0,
        lastError: engineError.value,
        latencyMs: 0,
        engineUrl: engineBridge.value?.engineUrl || '',
        staleMs: engineBridge.value?.staleMs || 10000,
        offlineMs: engineBridge.value?.offlineMs || 30000,
      };
    }
    throw err;
  } finally {
    engineLoading.value = false;
  }
}

export async function startEngine() {
  const data = await startWhaleAiEngine();
  await fetchEngineDashboard().catch(() => null);
  return data;
}

export async function pauseEngine() {
  const data = await pauseWhaleAiEngine();
  await fetchEngineDashboard().catch(() => null);
  return data;
}

export async function killEngine(reason?: string) {
  const data = await killWhaleAiEngine(reason ? { reason } : undefined);
  await fetchEngineDashboard().catch(() => null);
  return data;
}

export async function resumeEngine(reason: string, incidentId?: string) {
  const data = await resumeWhaleAiEngine({
    reason,
    incident_id: incidentId,
  });
  await fetchEngineDashboard().catch(() => null);
  return data;
}

export async function applyActiveStrategy(strategyId: string) {
  const data = await setWhaleAiActiveStrategy(strategyId);
  await fetchEngineDashboard().catch(() => null);
  return data;
}

export async function bindWhaleAiKey(apiKey: string) {
  const data = await saveWhaleAiKey(apiKey);
  status.value = {
    provider: data.provider,
    configured: data.configured,
    apiKeyHint: data.apiKeyHint,
    updatedAt: data.updatedAt,
    ready: data.ready,
  };
  return data;
}

export async function unbindWhaleAiKey() {
  const data = await deleteWhaleAiKey();
  status.value = {
    provider: data.provider,
    configured: data.configured,
    apiKeyHint: data.apiKeyHint,
    updatedAt: data.updatedAt,
    ready: data.ready,
  };
  return data;
}

export async function bindWhaleAiTradeKeys(input: {
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
  simulated?: boolean;
}) {
  const data = await saveWhaleAiTradeKeys(input);
  tradeStatus.value =
    data.trade ||
    ({
      ready: Boolean(data.okx?.ready),
      exchange: 'okx',
      configured: Boolean(data.okx?.configured),
      simulated: data.okx?.simulated !== false,
      apiKeyHint: data.okx?.apiKeyHint || '',
      updatedAt: data.okx?.updatedAt || 0,
      status: data.okx?.status || 'missing',
    } satisfies WhaleAiTradeStatus);
  return data;
}

export async function unbindWhaleAiTradeKeys() {
  const data = await deleteWhaleAiTradeKeys();
  tradeStatus.value =
    data.trade ||
    ({
      ready: false,
      exchange: 'okx',
      configured: false,
      simulated: true,
      apiKeyHint: '',
      updatedAt: 0,
      status: 'missing',
    } satisfies WhaleAiTradeStatus);
  return data;
}

watch(
  isLoggedIn,
  (logged) => {
    if (logged) {
      void refreshWhaleAiKeyStatus(true);
      void refreshWhaleAiTradeStatus(true);
    } else {
      clearWhaleAiKeyStatus();
      clearWhaleAiTradeStatus();
      clearWhaleAiEngine();
    }
  },
  { immediate: true },
);
