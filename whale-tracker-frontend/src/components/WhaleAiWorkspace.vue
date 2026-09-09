<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { isLoggedIn } from '@/stores/auth';
import {
  bindWhaleAiKey,
  bindWhaleAiTradeKeys,
  fetchEngineDashboard,
  pauseEngine,
  refreshWhaleAiKeyStatus,
  refreshWhaleAiTradeStatus,
  resumeEngine,
  startEngine,
  unbindWhaleAiKey,
  unbindWhaleAiTradeKeys,
  whaleAiActiveStrategy,
  whaleAiAlphaExecution,
  whaleAiEngineAvailable,
  whaleAiEngineBridge,
  whaleAiEngineError,
  whaleAiEngineSnapshot,
  whaleAiEngineState,
  whaleAiStrategyDiagnostics,
  whaleAiIncidents,
  whaleAiKeyHint,
  whaleAiKeyReady,
  whaleAiLastEngineUpdate,
  whaleAiMarketRisk,
  whaleAiRiskBudget,
  whaleAiS3,
  whaleAiSafety,
  whaleAiActiveStrategyHealth,
  whaleAiStrategyHealth,
  whaleAiTradeHint,
  whaleAiTradeIntents,
  whaleAiTradeReady,
  whaleAiTradeSimulated,
  whaleAiPortfolioRiskUsed,
} from '@/stores/whaleAi';
import {
  fetchWhaleAiTradeBalance,
  fetchWhaleAiTradeOrdersPending,
  fetchWhaleAiTradePositions,
  fetchWhaleAiRuntimeLogs,
  appendWhaleAiRuntimeLog,
  fetchV41HftSimStatus,
  fetchV41HftSimCapability,
  fetchExecutionSelections,
  selectExecution,
  startV41HftSim,
  stopV41HftSim,
  type ExecutionSelection,
} from '@/api';
import { useRealtimePrivate, type PrivateRealtimeMessage } from '@/composables/useRealtimePrivate';

const emit = defineEmits<{
  requestLogin: [];
}>();

const qaBusy = ref(false);
const qaCapability = ref<{
  enabled?: boolean;
  qa_exchange_enabled?: boolean;
  qa_live_enabled?: boolean;
  okx_ready?: boolean;
  account_mode?: string | null;
  exchange_environment?: string | null;
  live_money?: boolean;
  simulator_available?: boolean;
  exchange_available?: boolean;
} | null>(null);
const qaStatus = ref<{
  enabled?: boolean;
  running?: boolean;
  cycle_id?: number;
  target_cycles?: number | null;
  continuous?: boolean;
  state?: string;
  position_side?: string;
  position_notional_usdt?: number;
  max_position_notional_usdt?: number;
  actual_leverage?: number;
  target_leverage?: number;
  passed?: boolean | null;
  metrics?: Record<string, number>;
  env_resolved?: string | null;
  execution_mode?: string;
  exchange_environment?: string | null;
  live_money?: boolean;
} | null>(null);

const executionItems = ref<ExecutionSelection[]>([]);
const pendingExecutionId = ref('S1');
const selectedExecutionId = ref('S1');
const consoleMode = ref('ALPHA');
const alphaOpeningEnabled = ref(true);

const qaEnabled = computed(() => {
  if (qaStatus.value?.enabled === true) return true;
  const qa = executionItems.value.find((i) => i.id === 'QA-HFT-SIM');
  return Boolean(qa?.available);
});
const qaDisabledReason = computed(() => {
  if (qaEnabled.value) return '';
  const qa = executionItems.value.find((i) => i.id === 'QA-HFT-SIM');
  if (qa?.disabled_reason === 'HFT_SIM_DISABLED' || qaStatus.value?.enabled === false) {
    return 'QA 开平仓测试未启用：Python 引擎未打开 V41_HFT_SIM_ENABLED（需重启引擎进程）';
  }
  if (qaStatus.value == null) return '正在检测 QA 开平仓测试能力…';
  return 'QA 开平仓测试不可用';
});

const isQaConsole = computed(
  () => selectedExecutionId.value === 'QA-HFT-SIM' || consoleMode.value === 'QA_HFT_SIM',
);

const qaExchangeEnvLabel = computed(() => {
  // Prefer Node capability truth source; do not invent demo/live locally beyond fallback
  const env = qaCapability.value?.exchange_environment;
  if (env === 'live') return '⚠ OKX 实盘';
  if (env === 'demo') return 'OKX 模拟盘';
  if (qaCapability.value?.account_mode === 'OKX_LIVE') return '⚠ OKX 实盘';
  if (qaCapability.value?.account_mode === 'OKX_DEMO') return 'OKX 模拟盘';
  return '未解析';
});
const accountEnvironmentLabel = computed(() => {
  const snapEnv = String(whaleAiEngineSnapshot.value?.account_environment || '').toUpperCase();
  if (snapEnv === 'OKX_LIVE') return '⚠ OKX 实盘';
  if (snapEnv === 'OKX_DEMO') return 'OKX 模拟盘';
  if (accountLive.value) {
    return whaleAiTradeSimulated.value ? 'OKX 模拟盘' : '⚠ OKX 实盘';
  }
  return '未同步';
});
const qaIsLive = computed(
  () =>
    qaCapability.value?.exchange_environment === 'live' ||
    qaCapability.value?.account_mode === 'OKX_LIVE' ||
    qaCapability.value?.live_money === true,
);
const qaCanRunExchange = computed(() => Boolean(qaCapability.value?.exchange_available));
const qaRunDisabledReason = computed(() => {
  if (!qaEnabled.value) return qaDisabledReason.value;
  if (qaCanRunExchange.value) return '';
  if (qaIsLive.value && !qaCapability.value?.qa_live_enabled) {
    return '实盘 QA 测试未授权（需 V41_QA_LIVE_ENABLED=true）';
  }
  if (!qaCapability.value?.qa_exchange_enabled) {
    return '交易所 QA 未启用：需 V41_QA_EXCHANGE_ENABLED=true';
  }
  if (!qaCapability.value?.okx_ready) return '未绑定可用的 OKX 交易密钥';
  return '交易所仓不可用';
});

async function refreshQaStatus() {
  try {
    const st = await fetchV41HftSimStatus();
    const enabled =
      st?.enabled === true ||
      String(st?.enabled ?? '').toLowerCase() === 'true' ||
      String(st?.enabled ?? '') === '1';
    qaStatus.value = { ...st, enabled };
  } catch (err) {
    console.warn('[qa-hft] status failed', err);
    const qa = executionItems.value.find((i) => i.id === 'QA-HFT-SIM');
    if (qa?.available) {
      qaStatus.value = { ...(qaStatus.value || {}), enabled: true };
    } else if (!qaStatus.value) {
      qaStatus.value = { enabled: false };
    }
  }
  try {
    qaCapability.value = await fetchV41HftSimCapability();
  } catch {
    /* ignore */
  }
}

async function onQaStart() {
  if (qaBusy.value || !qaEnabled.value) return;
  if (!qaCanRunExchange.value) {
    ElMessage.error(qaRunDisabledReason.value || '交易所仓不可用');
    return;
  }
  qaBusy.value = true;
  try {
    const res = (await startV41HftSim({
      continuous: true,
      seed: 20260909,
      inject_failures: false,
      max_position_notional_usdt: 50,
      execution_mode: 'exchange',
    })) as { status?: typeof qaStatus.value; ok?: boolean; running?: boolean };
    qaStatus.value = res?.status || (await fetchV41HftSimStatus());
    selectedExecutionId.value = 'QA-HFT-SIM';
    pendingExecutionId.value = 'QA-HFT-SIM';
    consoleMode.value = 'QA_HFT_SIM';
    alphaOpeningEnabled.value = false;
    const where = qaExchangeEnvLabel.value;
    ElMessage.success(`QA 开平仓链路测试已启动 · ${where}`);
    pushLog('success', `QA 开平仓链路测试已启动 · ${where}`, {
      channel: 'SYSTEM',
    });
  } catch (err: unknown) {
    const anyErr = err as {
      code?: string;
      message?: string;
      details?: { code?: string; message?: string };
    };
    const code = String(anyErr?.details?.code || anyErr?.code || '');
    let msg = anyErr?.message || (err instanceof Error ? err.message : '启动失败');
    if (code === 'HFT_SIM_DISABLED') msg = 'QA 开平仓测试未启用：V41_HFT_SIM_ENABLED 未打开';
    if (code === 'QA_EXCHANGE_DISABLED') msg = '交易所仓未启用：V41_QA_EXCHANGE_ENABLED 未打开';
    if (code === 'QA_LIVE_TRADING_DISABLED') msg = '实盘 QA 测试未授权';
    if (code === 'QA_RUN_ALREADY_ACTIVE') msg = '已有 QA 测试在运行';
    ElMessage.error(msg);
    pushLog('error', msg);
    await refreshQaStatus();
  } finally {
    qaBusy.value = false;
  }
}

async function refreshExecutionSelections() {
  try {
    const data = await fetchExecutionSelections();
    executionItems.value = Array.isArray(data.items) ? data.items : [];
    if (data.selected_execution_id) {
      selectedExecutionId.value = data.selected_execution_id;
      pendingExecutionId.value = data.selected_execution_id;
    }
    if (data.console_mode) consoleMode.value = data.console_mode;
    if (typeof data.alpha_opening_enabled === 'boolean') {
      alphaOpeningEnabled.value = data.alpha_opening_enabled;
    }
  } catch {
    executionItems.value = [
      { id: 'S1', kind: 'alpha', name: '趋势跟踪 S1', available: true },
      { id: 'S2', kind: 'alpha', name: '极端情绪反转 S2', available: true },
      {
        id: 'S8',
        kind: 'alpha',
        name: '巨鲸行为共振',
        available: false,
        disabled_reason: 'WARMING_UP_OR_NOT_IMPLEMENTED',
      },
      {
        id: 'QA-HFT-SIM',
        kind: 'qa_test',
        name: 'QA 开平仓测试',
        available: false,
        disabled_reason: 'HFT_SIM_DISABLED',
      },
    ];
  }
}

async function onQaStop() {
  qaBusy.value = true;
  try {
    await stopV41HftSim();
    await refreshQaStatus();
    await refreshExecutionSelections();
    ElMessage.success('QA 开平仓链路测试已停止');
    pushLog('warn', 'QA 开平仓链路测试已停止 · Alpha 开仓未自动恢复', {
      channel: 'SYSTEM',
    });
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '停止失败');
  } finally {
    qaBusy.value = false;
  }
}

/* ===== 登录 / Key 门禁 ===== */
const reconfigKeys = ref(false);
const savingKeys = ref(false);
const clearingKeys = ref(false);
const apiKeyInput = ref('');

const reconfigTrade = ref(false);
const savingTrade = ref(false);
const clearingTrade = ref(false);
const tradeForm = ref({
  apiKey: '',
  apiSecret: '',
  apiPassphrase: '',
  simulated: true,
});

const showKeySetup = computed(() => !whaleAiKeyReady.value || reconfigKeys.value);
const showTradeSetup = computed(
  () => whaleAiKeyReady.value && (!whaleAiTradeReady.value || reconfigTrade.value),
);
const mainConsoleVisible = computed(
  () => isLoggedIn.value && !showKeySetup.value && !showTradeSetup.value,
);

/* ===== 账户 / 持仓（真实 OKX） ===== */
type PositionRow = {
  symbol: string;
  instId: string;
  side: 'LONG' | 'SHORT';
  risk: string;
  pnl: string;
  pnlPositive: boolean;
  uplUsd: number;
  notionalUsd: number;
};

type OrderRow = {
  symbol: string;
  status: string;
  slip: string;
  age: string;
};

type SignalRow = {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  status: string;
  age: string;
  drift: string;
  edge: string;
};

type LogChannel = 'SYSTEM' | 'POSITION';

type LogItem = {
  id?: number;
  ts?: number;
  t: string;
  lvl: 'info' | 'success' | 'warn' | 'error';
  msg: string;
  channel: LogChannel;
  event_type?: string;
  strategy_id?: string;
  symbol?: string;
  reason_code?: string;
};

const LOG_KEEP = 300;
const LOG_SHOW = 120;
const TICK_FRESH_SEC = 20;
const EVAL_FRESH_SEC = 20;

const equityText = ref('—');
const availableText = ref('—');
const frozenText = ref('—');
const dayPnlText = ref('—');
const dayPnlPctText = ref('未同步');
const dayPnlPositive = ref(true);
const drawdownText = ref('—');
const accountLive = ref(false);

const positions = ref<PositionRow[]>([]);
const pendingOrders = ref<OrderRow[]>([]);
const systemLogs = ref<LogItem[]>([]);
const positionLogs = ref<LogItem[]>([]);
const systemLogBox = ref<HTMLElement | null>(null);
const positionLogBox = ref<HTMLElement | null>(null);
const systemPinned = ref(true);
const positionPinned = ref(true);
let logScrollLock = 0;
const lastPositionEventKey = ref('');
const okxLastUpdate = ref('--');

const controlBusy = ref(false);
const showSwitchModal = ref(false);
const showResumeModal = ref(false);
const resumeReason = ref('');

const strategyCatalog: Record<string, { name: string; desc: string }> = {
  S1: {
    name: '趋势跟踪 S1',
    desc: '适合趋势行情，结合均线、趋势强度和波动率过滤寻找顺势机会。',
  },
  S2: {
    name: '极端情绪反转 S2',
    desc: '适合极端超买或超卖行情，在情绪、资金费率和持仓变化同时满足时寻找反转机会。',
  },
  S8: {
    name: '巨鲸行为共振',
    desc: '多巨鲸共识共振（尚未开放）。',
  },
  'QA-HFT-SIM': {
    name: 'QA 开平仓测试',
    desc: '开平仓链路测试（≤50U），不计入策略赚损 / S7 / Edge。账户环境由 Node 根据当前 OKX 密钥识别。',
  },
};

const engineOnline = computed(() => whaleAiEngineAvailable.value && whaleAiEngineState.value !== 'OFFLINE');

const activeStrategy = computed<'S1' | 'S2'>(() => {
  const id = String(whaleAiActiveStrategy.value || 'S1').toUpperCase();
  return id === 'S2' ? 'S2' : 'S1';
});

const currentStrategy = computed(() => {
  if (isQaConsole.value) return strategyCatalog['QA-HFT-SIM'];
  return strategyCatalog[activeStrategy.value] || strategyCatalog.S1;
});

const alphaItems = computed(() => executionItems.value.filter((i) => i.kind === 'alpha'));
const qaItems = computed(() => executionItems.value.filter((i) => i.kind === 'qa_test'));
const pendingSelection = computed(() =>
  executionItems.value.find((i) => i.id === pendingExecutionId.value),
);
const activeHealth = computed(() => {
  if (!engineOnline.value) return null;
  const preferred = whaleAiActiveStrategyHealth.value;
  if (preferred && preferred.strategy_id === activeStrategy.value) {
    return {
      strategy_id: preferred.strategy_id,
      health_score: preferred.health_score,
      state: preferred.state,
      expectancy_R: null as number | null,
    };
  }
  return whaleAiStrategyHealth.value.find((h) => h.strategy_id === activeStrategy.value) || null;
});

const activeRiskShare = computed(() => {
  if (!engineOnline.value) return null;
  const fromView = whaleAiActiveStrategyHealth.value;
  if (fromView?.risk_budget_pct_equity != null && fromView.strategy_id === activeStrategy.value) {
    return {
      risk_budget: fromView.risk_budget_pct_equity,
      raw_share: 0,
      final_share: 0,
      risk_used: 0,
    };
  }
  return whaleAiRiskBudget.value?.strategies?.[activeStrategy.value] || null;
});

const systemStateLabel = computed(() => {
  if (!engineOnline.value) return '引擎离线';
  const state = String(whaleAiEngineState.value || '').toUpperCase();
  const map: Record<string, string> = {
    RUNNING: '运行中',
    PAUSED: '已暂停',
    LOCKED: '紧急停止',
    RECOVERY: '恢复检查中',
    OFFLINE: '引擎离线',
    UNKNOWN: '未知',
  };
  return map[state] || state || '未知';
});

const systemDot = computed(() => {
  if (!engineOnline.value) return 'red';
  const state = String(whaleAiEngineState.value || '').toUpperCase();
  if (state === 'RUNNING') return 'green';
  if (state === 'PAUSED' || state === 'RECOVERY') return 'yellow';
  return 'red';
});

const emergencyLocked = computed(() => {
  if (!engineOnline.value) return false;
  const state = String(whaleAiEngineState.value || '').toUpperCase();
  const s6 = whaleAiSafety.value?.status;
  return state === 'LOCKED' || String(s6 || '').toUpperCase() === 'LOCKED';
});

function parseIsoMs(iso?: string | null) {
  if (!iso) return null;
  const ms = Date.parse(String(iso));
  return Number.isFinite(ms) ? ms : null;
}

function ageSeconds(iso?: string | null) {
  const ms = parseIsoMs(iso);
  if (ms == null) return null;
  return Math.max(0, Math.round((Date.now() - ms) / 1000));
}

function ageText(iso?: string | null) {
  const s = ageSeconds(iso);
  if (s == null) return '未知';
  if (s < 60) return `${s}秒前`;
  if (s < 3600) return `${Math.floor(s / 60)}分钟前`;
  return `${Math.floor(s / 3600)}小时前`;
}

function engineStateLabelZh(state: string) {
  const map: Record<string, string> = {
    RUNNING: '运行中',
    PAUSED: '已暂停',
    LOCKED: '紧急停止',
    RECOVERY: '恢复检查中',
    OFFLINE: '引擎离线',
    UNKNOWN: '未知',
  };
  return map[String(state || '').toUpperCase()] || state;
}

function decisionLabelZh(decision: string) {
  const map: Record<string, string> = {
    ALLOW: '允许开仓',
    NO_TRADE: '不开仓',
    BLOCK: '拦截',
    NONE: '无',
  };
  return map[String(decision || '').toUpperCase()] || decision;
}

function directionLabelZh(direction: string) {
  const map: Record<string, string> = {
    LONG: '做多',
    SHORT: '做空',
    NONE: '无方向',
  };
  return map[String(direction || '').toUpperCase()] || direction || '无方向';
}

function reasonLabelZh(code: string) {
  const map: Record<string, string> = {
    CLOSE_VS_EMA20: '收盘价未站上EMA20',
    EMA20_VS_EMA50: 'EMA20未上穿EMA50',
    TREND_SLOPE: '趋势斜率不足',
    TREND_QUALITY_BELOW_THRESHOLD: '趋势质量低于阈值',
    S3_DIRECTION_BLOCK: 'S3方向不允许',
    S3_REGIME_BLOCK: 'S3行情状态不允许',
    VOLATILITY_CONDITION: '波动率条件不满足',
    EXPECTED_EDGE_TOO_LOW: '预期优势不足',
    EDGE_UNAVAILABLE: '优势估计不可用',
    MARKET_DATA_WARMING_UP: '行情预热中',
    MARKET_DATA_STALE: '行情过期',
    ALPHA_OPENINGS_PAUSED: 'Alpha开仓已暂停',
    S6_ENTRIES_BLOCKED: 'S6安全门拦截开仓',
    MISSING_PRICE_OR_ATR: '缺少价格或ATR',
    S1_DISABLED: 'S1已关闭',
    S1_NO_DIRECTION: '无多空方向',
    S1_LONG_OK: '多头条件满足',
    S1_SHORT_OK: '空头条件满足',
    DUPLICATE_CLOSED_CANDLE: '同一根已收盘K线已发过信号',
    S5_BUDGET_BLOCK: 'S5风险预算拦截',
  };
  return map[code] || code;
}

function qaSideLabelZh(side: string) {
  const key = String(side || '').toUpperCase();
  const map: Record<string, string> = {
    FLAT: '空仓',
    LONG: '做多',
    SHORT: '做空',
    OPENING_LONG: '正在开多',
    OPENING_SHORT: '正在开空',
    CLOSING: '正在平仓',
    FLAT_CONFIRMED: '已确认空仓',
  };
  return map[key] || side;
}

const s1Diagnostics = computed(() => whaleAiStrategyDiagnostics.value);
const lastTickAt = computed(
  () => s1Diagnostics.value?.last_tick_at || whaleAiEngineSnapshot.value?.engine?.last_tick_at || null,
);
const lastEvaluatedAt = computed(
  () =>
    s1Diagnostics.value?.last_evaluated_at ||
    whaleAiEngineSnapshot.value?.engine?.last_evaluated_at ||
    null,
);
const tickFresh = computed(() => {
  const s = ageSeconds(lastTickAt.value);
  return s != null && s <= TICK_FRESH_SEC;
});
const evalFresh = computed(() => {
  const s = ageSeconds(lastEvaluatedAt.value);
  return s != null && s <= EVAL_FRESH_SEC;
});
const alphaOpeningsOn = computed(() => {
  if (typeof s1Diagnostics.value?.alpha_opening_enabled === 'boolean') {
    return s1Diagnostics.value.alpha_opening_enabled;
  }
  if (typeof whaleAiEngineSnapshot.value?.engine?.alpha_opening_enabled === 'boolean') {
    return whaleAiEngineSnapshot.value.engine.alpha_opening_enabled;
  }
  return alphaOpeningEnabled.value;
});
const marketDataState = computed(() =>
  String(s1Diagnostics.value?.market_data?.state || '').toUpperCase(),
);
const alphaFullyRunning = computed(() => {
  const state = String(whaleAiEngineState.value || '').toUpperCase();
  return (
    engineOnline.value &&
    !emergencyLocked.value &&
    state === 'RUNNING' &&
    Boolean(activeStrategy.value) &&
    alphaOpeningsOn.value &&
    tickFresh.value &&
    evalFresh.value &&
    marketDataState.value !== 'STALE' &&
    marketDataState.value !== 'WARMING_UP'
  );
});

const strategyStatusLabel = computed(() => {
  if (isQaConsole.value) {
    return qaStatus.value?.running ? 'QA 开平仓测试 · 运行中' : 'QA 开平仓测试 · 已停止';
  }
  const sid = activeStrategy.value;
  if (!engineOnline.value) return `${sid} · 引擎离线`;
  if (emergencyLocked.value) return `${sid} · 已锁定`;
  const state = String(whaleAiEngineState.value || '').toUpperCase();
  if (state === 'PAUSED') return `${sid} · 引擎暂停`;
  if (state === 'RECOVERY') return `${sid} · 恢复中`;
  if (marketDataState.value === 'STALE') return `${sid} · 行情异常`;
  if (marketDataState.value === 'WARMING_UP') return `${sid} · 行情预热`;
  if (!alphaOpeningsOn.value) return `${sid} · Alpha开仓暂停`;
  if (alphaFullyRunning.value) return `${sid} · 运行中`;
  return `${sid} · 已选择但未运行`;
});

const strategyStatusClass = computed(() => {
  if (isQaConsole.value) return qaStatus.value?.running ? 'tag-on' : 'tag-warn';
  if (!engineOnline.value || emergencyLocked.value || marketDataState.value === 'STALE') {
    return 'tag-off';
  }
  if (alphaFullyRunning.value) return 'tag-on';
  return 'tag-warn';
});

/** 启动按钮：Alpha 必须引擎循环 + 开仓开关都开；QA 看 runner */
const strategyIsRunning = computed(() => {
  if (isQaConsole.value) return Boolean(qaStatus.value?.running);
  return String(whaleAiEngineState.value || '').toUpperCase() === 'RUNNING' && alphaOpeningsOn.value;
});

const activePositionCount = computed(() => {
  if (positions.value.length) return positions.value.length;
  const enginePos = whaleAiEngineSnapshot.value?.open_positions;
  if (!Array.isArray(enginePos)) return 0;
  return enginePos.filter((p) => {
    const row = p as { legacy_mark?: string; metadata?: { source?: string; legacy_mark?: string } };
    return (
      row?.legacy_mark !== 'LEGACY_PAPER_POSITION' &&
      row?.metadata?.legacy_mark !== 'LEGACY_PAPER_POSITION' &&
      row?.metadata?.source !== 'paper_adapter'
    );
  }).length;
});

const healthScoreText = computed(() => {
  if (!engineOnline.value) return '—';
  const h = activeHealth.value?.health_score;
  return h == null || !Number.isFinite(h) ? '—' : String(Math.round(h));
});

const healthSubText = computed(() => {
  if (!engineOnline.value) return '引擎离线';
  const h = activeHealth.value?.health_score;
  if (h == null || !Number.isFinite(h)) return '预热中';
  return h >= 80 ? '状态良好' : '降低风险运行';
});

const healthTone = computed(() => {
  if (!engineOnline.value) return '';
  const h = activeHealth.value?.health_score;
  if (h == null || !Number.isFinite(h)) return '';
  return h >= 80 ? 'green' : 'yellow';
});

const strategyRiskBudgetText = computed(() => {
  if (!engineOnline.value) return '—';
  const budget = activeRiskShare.value?.risk_budget;
  return formatPct(budget);
});

const strategyExpectancyText = computed(() => {
  if (!engineOnline.value) return '—';
  const e = activeHealth.value?.expectancy_R;
  if (e == null || !Number.isFinite(e)) return '—';
  return `${e >= 0 ? '+' : ''}${e.toFixed(2)}R`;
});

const riskUsed = computed(() => {
  if (!engineOnline.value) return null;
  const fromView = whaleAiPortfolioRiskUsed.value;
  if (fromView != null && Number.isFinite(fromView)) return fromView;
  const n = whaleAiRiskBudget.value?.portfolio?.risk_used;
  return n != null && Number.isFinite(n) ? n : null;
});

const riskLimit = computed(() => {
  if (!engineOnline.value) return null;
  const mr = whaleAiMarketRisk.value;
  if (mr?.portfolio_risk_limit_pct_equity != null && Number.isFinite(mr.portfolio_risk_limit_pct_equity)) {
    return mr.portfolio_risk_limit_pct_equity;
  }
  const n = whaleAiRiskBudget.value?.portfolio?.effective_risk_budget;
  return n != null && Number.isFinite(n) ? n : null;
});

const riskUsedText = computed(() => formatPct(riskUsed.value));
const riskLimitText = computed(() => formatPct(riskLimit.value));
const riskBarPct = computed(() => {
  if (riskUsed.value == null || riskLimit.value == null || riskLimit.value <= 0) return 0;
  return Math.max(0, Math.min(100, (riskUsed.value / riskLimit.value) * 100));
});

const safetyLabel = computed(() => {
  if (!engineOnline.value) return '—';
  const status = String(whaleAiSafety.value?.status || '').toUpperCase();
  const map: Record<string, string> = {
    NORMAL: '正常',
    REDUCED: '降级',
    BLOCKED: '阻断',
    LOCKED: '已锁定',
  };
  if (String(whaleAiEngineState.value || '').toUpperCase() === 'RECOVERY') return '恢复中';
  return map[status] || status || '—';
});

const safetyTone = computed(() => {
  if (!engineOnline.value) return '';
  const status = String(whaleAiSafety.value?.status || '').toUpperCase();
  if (status === 'LOCKED' || status === 'BLOCKED') return 'red';
  if (status === 'REDUCED' || String(whaleAiEngineState.value || '').toUpperCase() === 'RECOVERY') {
    return 'yellow';
  }
  return 'green';
});

const overallRiskTag = computed(() => {
  if (!engineOnline.value) return { text: '引擎离线', cls: 'tag-off' };
  if (emergencyLocked.value) return { text: '已锁定', cls: 'tag-off' };
  if (String(whaleAiEngineState.value || '').toUpperCase() === 'PAUSED') {
    return { text: '已暂停', cls: 'tag-warn' };
  }
  const status = String(whaleAiSafety.value?.status || '').toUpperCase();
  if (status === 'REDUCED') return { text: '降级', cls: 'tag-warn' };
  if (status === 'BLOCKED') return { text: '阻断', cls: 'tag-off' };
  return { text: '正常', cls: 'tag-on' };
});

const marketRegime = computed(() => {
  if (!engineOnline.value || !whaleAiS3.value) return '—';
  return regimeLabel(whaleAiS3.value.regime);
});

const directionBias = computed(() => {
  if (!engineOnline.value || !whaleAiS3.value) return '—';
  const bias = Number(whaleAiS3.value.direction_bias);
  if (!Number.isFinite(bias)) return '—';
  if (bias > 0.15) return `偏多 ${bias.toFixed(2)}`;
  if (bias < -0.15) return `偏空 ${bias.toFixed(2)}`;
  return `中性 ${bias.toFixed(2)}`;
});

const marketLatency = computed(() => {
  if (!engineOnline.value || !whaleAiSafety.value) return '—';
  const ms = whaleAiSafety.value.market_data_latency_ms;
  if (ms == null || !Number.isFinite(ms)) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
});

const exchangeState = computed(() => {
  if (!engineOnline.value || !whaleAiSafety.value) {
    return whaleAiTradeReady.value ? accountEnvironmentLabel.value : '—';
  }
  if (!whaleAiSafety.value.exchange_connected) return '断开';
  return accountEnvironmentLabel.value;
});

const alphaExecutionLabel = computed(() => {
  const v = String(whaleAiAlphaExecution.value || '').toUpperCase();
  return v === 'EXECUTE' || v === 'SHADOW' ? v : 'SHADOW';
});

const reconcileState = computed(() => {
  if (!engineOnline.value || !whaleAiSafety.value) return '—';
  const pos = whaleAiSafety.value.positions_reconciled;
  const ord = whaleAiSafety.value.orders_reconciled;
  if (pos && ord) return '一致';
  if (!pos && !ord) return '仓位/订单不一致';
  if (!pos) return '仓位不一致';
  return '订单不一致';
});

const riskEngineState = computed(() => {
  if (!engineOnline.value || !whaleAiSafety.value) return '—';
  return whaleAiSafety.value.risk_engine_healthy ? '正常' : '异常';
});

const signals = computed<SignalRow[]>(() => {
  if (!engineOnline.value) return [];
  return whaleAiTradeIntents.value.map((intent) => {
    const dir = String(intent.direction || '').toLowerCase();
    const side: 'LONG' | 'SHORT' = dir === 'short' || dir === 'sell' ? 'SHORT' : 'LONG';
    const ageSec = Number(intent.signal_age_seconds);
    const drift = Number(intent.price_drift_bps);
    const edge = intent.expected_edge_R;
    return {
      id: intent.intent_id,
      symbol: coinFromInst(String(intent.symbol || '—')),
      side,
      status: signalStatusLabel(intent.status),
      age:
        Number.isFinite(ageSec) && ageSec >= 0
          ? ageSec < 60
            ? `${Math.floor(ageSec)} 秒前`
            : `${Math.floor(ageSec / 60)} 分钟前`
          : '—',
      drift: Number.isFinite(drift) ? `${drift >= 0 ? '+' : ''}${drift.toFixed(1)} bps` : '—',
      edge: edge != null && Number.isFinite(edge) ? `${edge >= 0 ? '+' : ''}${edge.toFixed(2)}R` : '—',
    };
  });
});

const lastUpdate = computed(() => {
  const ts = whaleAiLastEngineUpdate.value;
  if (ts > 0) {
    return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
  }
  return okxLastUpdate.value;
});

const bridgeHint = computed(() => {
  const b = whaleAiEngineBridge.value;
  if (!b) return '';
  const transport = String(b.transport_status || (b.connected ? 'CONNECTED' : 'DISCONNECTED'));
  const engineRt = String(b.engine_runtime_status || b.freshness || '').toUpperCase();
  const strategyRt = String(b.strategy_runtime_status || '').toUpperCase();
  const parts = [`transport ${transport}`];
  if (engineRt) parts.push(`engine ${engineRt}`);
  if (strategyRt) parts.push(`strategy ${strategyRt}`);
  return parts.join(' · ');
});

let enginePollTimer: number | undefined;
let okxPollTimer: number | undefined;
let statusLogTimer: number | undefined;
let qaPollTimer: number | undefined;
const privateWsConnected = ref(false);

function onPrivateRealtime(msg: PrivateRealtimeMessage) {
  if (msg.type !== 'v41Event') return;
  const et = String(msg.eventType || '');
  if (et === 'engine.sequence_gap' || msg.payload?.resnapshot) {
    pushLog('warn', '引擎事件序号缺口，正在重新拉取快照');
  }
  if (et === 'strategy.active.changed') {
    pushLog('info', `策略已切换为 ${String((msg.payload as { active_strategy_id?: string })?.active_strategy_id || '')}`, {
      channel: 'SYSTEM',
    });
  }
  if (et === 'strategy.decision') {
    applyPositionDecision(msg.payload as Record<string, unknown>);
  }
  if (et === 'trade_intent.created') {
    const p = (msg.payload || {}) as { strategy_id?: string; symbol?: string; direction?: string };
    pushLog(
      'success',
      `[信号] ${p.strategy_id || activeStrategy.value} · ${p.symbol || ''} · ${directionLabelZh(String(p.direction || ''))}`,
      {
        channel: 'POSITION',
        event_type: '信号',
        strategy_id: p.strategy_id,
        symbol: p.symbol,
      },
    );
  }
  if (mainConsoleVisible.value) void pollEngineDashboard();
}

const privateRealtime = useRealtimePrivate(onPrivateRealtime);
watch(
  () => privateRealtime.connected.value,
  (ok) => {
    privateWsConnected.value = ok;
    if (ok && mainConsoleVisible.value) {
      // WS 已连通时放慢 REST 轮询
      startPolling();
    }
  },
);

function nowTime(ts = Date.now()) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

function formatLogTime(ts?: number) {
  if (!ts || !Number.isFinite(ts)) return nowTime();
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  if (sameDay) return d.toLocaleTimeString('zh-CN', { hour12: false });
  return d.toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function logsFor(channel: LogChannel) {
  return channel === 'POSITION' ? positionLogs : systemLogs;
}

function onLogScroll(channel: LogChannel) {
  if (logScrollLock) return;
  const el = channel === 'POSITION' ? positionLogBox.value : systemLogBox.value;
  if (!el) return;
  const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 28;
  if (channel === 'POSITION') positionPinned.value = pinned;
  else systemPinned.value = pinned;
}

function pinLogChannel(channel: LogChannel, pinned: boolean) {
  if (channel === 'POSITION') positionPinned.value = pinned;
  else systemPinned.value = pinned;
}

function applyLogScroll(channel: LogChannel) {
  const el = channel === 'POSITION' ? positionLogBox.value : systemLogBox.value;
  if (!el) return false;
  logScrollLock += 1;
  el.scrollTop = el.scrollHeight;
  pinLogChannel(channel, true);
  requestAnimationFrame(() => {
    logScrollLock = Math.max(0, logScrollLock - 1);
  });
  return el.scrollHeight - el.scrollTop - el.clientHeight < 28;
}

function scrollLogToLatest(channel: LogChannel) {
  pinLogChannel(channel, true);
  void nextTick(() => {
    applyLogScroll(channel);
    requestAnimationFrame(() => {
      applyLogScroll(channel);
      requestAnimationFrame(() => applyLogScroll(channel));
    });
  });
}

function applyPositionDecision(payload?: Record<string, unknown> | null) {
  if (!payload) return;
  const strategyId = String(payload.strategy_id || activeStrategy.value || 'S1');
  const symbol = String(payload.symbol || s1Diagnostics.value?.market_data?.instrument || '');
  const direction = String(payload.direction || payload.direction_candidate || 'NONE');
  const decision = String(payload.decision || payload.result || 'NO_TRADE');
  const codes = Array.isArray(payload.reason_codes)
    ? payload.reason_codes.map((x) => String(x))
    : payload.reason_code
      ? [String(payload.reason_code)]
      : [];
  const eventType = String(payload.event_type || (decision === 'ALLOW' ? '信号' : decision === 'BLOCK' ? '拒绝' : '拒绝'));
  const key = `${strategyId}|${symbol}|${direction}|${codes.join(',')}`;
  if (key === lastPositionEventKey.value) return;
  lastPositionEventKey.value = key;
  const lvl: LogItem['lvl'] = decision === 'ALLOW' ? 'success' : decision === 'BLOCK' ? 'warn' : 'info';
  const reasonsZh = codes.length ? codes.map(reasonLabelZh).join('；') : '无明确原因';
  pushLog(
    lvl,
    `[${eventType}] ${strategyId} · ${symbol || '—'} · ${directionLabelZh(direction)} · ${decisionLabelZh(decision)} · ${reasonsZh}`,
    {
      channel: 'POSITION',
      event_type: eventType,
      strategy_id: strategyId,
      symbol,
      reason_code: codes[0] || '',
    },
  );
}

function pushLog(
  lvl: LogItem['lvl'],
  msg: string,
  opts?: {
    persist?: boolean;
    source?: string;
    channel?: LogChannel;
    event_type?: string;
    strategy_id?: string;
    symbol?: string;
    reason_code?: string;
  },
) {
  const text = String(msg || '').trim();
  if (!text) return;
  const ts = Date.now();
  const channel: LogChannel = opts?.channel === 'POSITION' ? 'POSITION' : 'SYSTEM';
  const bucket = logsFor(channel);
  bucket.value.push({
    ts,
    t: formatLogTime(ts),
    lvl,
    msg: text,
    channel,
    event_type: opts?.event_type,
    strategy_id: opts?.strategy_id,
    symbol: opts?.symbol,
    reason_code: opts?.reason_code,
  });
  if (bucket.value.length > LOG_KEEP) bucket.value = bucket.value.slice(-LOG_KEEP);
  const shouldPersist = opts?.persist !== false;
  if (shouldPersist && isLoggedIn.value) {
    void appendWhaleAiRuntimeLog({
      lvl,
      msg: text,
      source: opts?.source || 'ui',
      ts,
      channel,
      event_type: opts?.event_type,
      strategy_id: opts?.strategy_id,
      symbol: opts?.symbol,
      reason_code: opts?.reason_code,
    }).catch(() => {
      /* ignore persist errors — console still shows locally */
    });
  }
}

async function loadRuntimeLogs() {
  if (!isLoggedIn.value) return;
  try {
    const data = await fetchWhaleAiRuntimeLogs(LOG_KEEP * 2);
    const rows = Array.isArray(data.logs) ? data.logs : [];
    const mapped = rows.map((r) => {
      const channel: LogChannel = String(r.channel || 'SYSTEM').toUpperCase() === 'POSITION' ? 'POSITION' : 'SYSTEM';
      return {
        id: r.id,
        ts: Number(r.ts) || Date.now(),
        t: formatLogTime(Number(r.ts) || Date.now()),
        lvl: (['info', 'success', 'warn', 'error'].includes(String(r.lvl))
          ? r.lvl
          : 'info') as LogItem['lvl'],
        msg: String(r.msg || ''),
        channel,
        event_type: r.event_type,
        strategy_id: r.strategy_id,
        symbol: r.symbol,
        reason_code: r.reason_code,
      };
    });
    systemLogs.value = mapped.filter((r) => r.channel === 'SYSTEM').slice(-LOG_KEEP);
    positionLogs.value = mapped.filter((r) => r.channel === 'POSITION').slice(-LOG_KEEP);
    pinLogChannel('SYSTEM', true);
    pinLogChannel('POSITION', true);
    scrollLogToLatest('SYSTEM');
    scrollLogToLatest('POSITION');
  } catch {
    /* keep whatever is in memory */
  }
}

function logLevelLabel(lvl: LogItem['lvl']) {
  const map = { info: '信息', success: '成功', warn: '提醒', error: '错误' } as const;
  return map[lvl];
}

function formatPct(n: number | null | undefined, digits = 1) {
  if (n == null || !Number.isFinite(n)) return '—';
  const pct = Math.abs(n) <= 1.5 ? n * 100 : n;
  return `${pct.toFixed(digits)}%`;
}

function regimeLabel(regime: string) {
  const key = String(regime || '')
    .trim()
    .toLowerCase();
  const map: Record<string, string> = {
    strong_trend: '强趋势',
    weak_trend: '弱趋势',
    range: '震荡',
    panic: '恐慌',
    recovery: '修复',
  };
  return map[key] || regime || '—';
}

function signalStatusLabel(status: string) {
  const key = String(status || '')
    .trim()
    .toUpperCase();
  const map: Record<string, string> = {
    CREATED: '已创建',
    WAITING_EXECUTION_CONFIRMATION: '等待执行确认',
    CONFIRMED: '已确认',
    EXECUTED: '已执行',
    EXPIRED: '已失效',
    CANCELLED: '已取消',
    CANCELED: '已取消',
    S4_REJECTED: '执行拒绝',
    RISK_REJECTED: '风险拒绝',
    COST_REJECTED: '成本不足',
    SAFETY_REJECTED: '安全拒绝',
  };
  return map[key] || status || '—';
}

function sideLabel(side: string) {
  if (side === 'LONG' || side === '做多') return '做多';
  if (side === 'SHORT' || side === '做空') return '做空';
  return side || '—';
}

function orderStatusLabel(status: string) {
  const key = String(status || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  const map: Record<string, string> = {
    live: '挂单中',
    pending: '等待中',
    partially_filled: '部分成交',
    filled: '已成交',
    canceled: '已撤销',
    cancelled: '已撤销',
    mmp_canceled: '风控撤单',
    rejected: '已拒绝',
    expired: '已过期',
  };
  return map[key] || status || '—';
}

function signalStatusClass(status: string) {
  if (status.includes('等待') || status.includes('创建') || status.includes('确认')) return 'tag-info';
  if (
    status.includes('失效') ||
    status.includes('不足') ||
    status.includes('拒绝') ||
    status.includes('取消')
  ) {
    return 'tag-off';
  }
  if (status.includes('执行')) return 'tag-on';
  return 'tag-neutral';
}

function orderStatusClass(status: string) {
  const label = orderStatusLabel(status);
  if (label.includes('成交') && !label.includes('部分')) return 'tag-on';
  if (label.includes('等待') || label.includes('挂单') || label.includes('部分')) return 'tag-info';
  if (label.includes('拒绝') || label.includes('撤销') || label.includes('过期')) return 'tag-off';
  return 'tag-neutral';
}

function formatUsd(n: number | null | undefined, digits = 2) {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${n < 0 ? '-' : ''}$${abs}`;
}

function formatSignedUsd(n: number) {
  if (!Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function coinFromInst(instId: string) {
  return instId.split('-')[0] || instId;
}

function mapPosition(row: Record<string, unknown>): PositionRow | null {
  const instId = String(row.instId || '').trim();
  const pos = Number(row.pos || row.availPos || 0);
  if (!instId || !(Math.abs(pos) > 0)) return null;
  const posSide = String(row.posSide || '').toLowerCase();
  const side: 'LONG' | 'SHORT' = posSide === 'short' || pos < 0 ? 'SHORT' : 'LONG';
  const upl = Number(row.upl);
  const uplUsd = Number.isFinite(upl) ? upl : 0;
  const uplRatio = Number(row.uplRatio);
  const pnlPct = Number.isFinite(uplRatio)
    ? uplRatio * (Math.abs(uplRatio) <= 2 ? 100 : 1)
    : null;
  const markPx = Number(row.markPx);
  const notionalApi = Number(row.notionalUsd ?? row.notional);
  const notionalUsd = Number.isFinite(notionalApi)
    ? Math.abs(notionalApi)
    : Number.isFinite(markPx)
      ? Math.abs(pos) * markPx
      : 0;
  const margin = Number(row.margin || row.imr || row.notionalUsd);
  return {
    symbol: coinFromInst(instId),
    instId,
    side,
    risk: Number.isFinite(margin) && margin > 0 ? formatUsd(margin, 0) : '—',
    pnl: pnlPct != null ? `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%` : formatSignedUsd(uplUsd),
    pnlPositive: (pnlPct != null ? pnlPct : uplUsd) >= 0,
    uplUsd,
    notionalUsd,
  };
}

function mapOrder(row: Record<string, unknown>): OrderRow {
  const instId = String(row.instId || '').trim();
  const state = String(row.state || row.status || 'PENDING').toUpperCase();
  const cTime = Number(row.cTime || row.uTime || 0);
  const ageSec = cTime > 0 ? Math.max(0, Math.floor((Date.now() - cTime) / 1000)) : null;
  return {
    symbol: coinFromInst(instId) || '—',
    status: state || '—',
    slip: '—',
    age: ageSec == null ? '—' : ageSec < 60 ? `${ageSec} 秒前` : `${Math.floor(ageSec / 60)} 分钟前`,
  };
}

async function loadAccountSnapshot() {
  if (!whaleAiTradeReady.value) {
    accountLive.value = false;
    equityText.value = '—';
    availableText.value = '—';
    frozenText.value = '—';
    dayPnlText.value = '—';
    dayPnlPctText.value = '绑定 OKX 后显示';
    drawdownText.value = '—';
    positions.value = [];
    pendingOrders.value = [];
    return;
  }
  try {
    const [bal, posData, orderData] = await Promise.all([
      fetchWhaleAiTradeBalance(),
      fetchWhaleAiTradePositions('SWAP'),
      fetchWhaleAiTradeOrdersPending('SWAP').catch(() => ({
        orders: [] as Record<string, unknown>[],
      })),
    ]);
    const rows = (Array.isArray(posData.positions) ? posData.positions : [])
      .map((r) => mapPosition(r as Record<string, unknown>))
      .filter((x): x is PositionRow => Boolean(x));
    positions.value = rows;
    pendingOrders.value = (Array.isArray(orderData.orders) ? orderData.orders : []).map((r) =>
      mapOrder(r as Record<string, unknown>),
    );

    const details = bal.balance?.details || [];
    const usdt = details.find((d) => String(d.ccy).toUpperCase() === 'USDT') || details[0];
    const equity =
      bal.balance?.totalEq != null && Number.isFinite(bal.balance.totalEq)
        ? Number(bal.balance.totalEq)
        : usdt
          ? Number(usdt.eq)
          : null;
    const available = usdt ? Number(usdt.availBal) : null;
    const frozen = usdt
      ? Number(usdt.frozenBal)
      : details.reduce((s, d) => s + (Number(d.frozenBal) || 0), 0);
    const uplSum = rows.reduce((s, p) => s + p.uplUsd, 0);

    accountLive.value = equity != null && Number.isFinite(equity);
    equityText.value = formatUsd(equity);
    availableText.value = formatUsd(available);
    frozenText.value = formatUsd(frozen);
    dayPnlText.value = formatSignedUsd(uplSum);
    dayPnlPositive.value = uplSum >= 0;
    dayPnlPctText.value =
      equity && equity > 0
        ? `${uplSum >= 0 ? '+' : ''}${((uplSum / equity) * 100).toFixed(2)}% 未实现`
        : '未实现盈亏';
    drawdownText.value =
      equity && equity > 0 && uplSum < 0
        ? `${Math.min(99, (Math.abs(uplSum) / equity) * 100).toFixed(1)}%`
        : accountLive.value
          ? '0.0%'
          : '—';

    okxLastUpdate.value = nowTime();
  } catch (err) {
    accountLive.value = false;
    pushLog('error', err instanceof Error ? err.message : '拉取账户失败');
  }
}

async function pollEngineDashboard() {
  if (!mainConsoleVisible.value) return;
  try {
    await fetchEngineDashboard();
  } catch (err) {
    const msg = err instanceof Error ? err.message : whaleAiEngineError.value || '引擎离线';
    // Avoid flooding logs every 3s — only note once per consecutive failure burst via bridge freshness
    if (systemLogs.value[systemLogs.value.length - 1]?.msg !== `引擎拉取失败：${msg}`) {
      pushLog('warn', `引擎拉取失败：${msg}`, { channel: 'SYSTEM' });
    }
  }
}

/* ===== Key 操作 ===== */
async function submitKey() {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    ElMessage.warning('请填写 DeepSeek 密钥');
    return;
  }
  if (savingKeys.value) return;
  savingKeys.value = true;
  try {
    const data = await bindWhaleAiKey(apiKey);
    apiKeyInput.value = '';
    reconfigKeys.value = false;
    if (data.warn) ElMessage.warning(data.warn);
    else ElMessage.success('DeepSeek 密钥已保存');
    void refreshWhaleAiTradeStatus(true);
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '保存失败');
  } finally {
    savingKeys.value = false;
  }
}

function cancelReconfig() {
  if (!whaleAiKeyReady.value) return;
  reconfigKeys.value = false;
  apiKeyInput.value = '';
}

async function clearKey() {
  try {
    await ElMessageBox.confirm('将清除 DeepSeek 密钥。', '清除密钥', {
      type: 'warning',
      confirmButtonText: '确认清除',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  clearingKeys.value = true;
  try {
    await unbindWhaleAiKey();
    reconfigKeys.value = false;
    ElMessage.success('已清除 DeepSeek 密钥');
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '清除失败');
  } finally {
    clearingKeys.value = false;
  }
}

async function submitTradeKeys() {
  const { apiKey, apiSecret, apiPassphrase, simulated } = tradeForm.value;
  if (!apiKey.trim() || !apiSecret.trim() || !apiPassphrase.trim()) {
    ElMessage.warning('请填写 OKX 密钥 / 私钥 / 口令');
    return;
  }
  if (savingTrade.value) return;
  if (!simulated) {
    try {
      await ElMessageBox.confirm('即将绑定【实盘】API，请确认密钥属于实盘。', '实盘确认', {
        type: 'warning',
        confirmButtonText: '确认绑定实盘',
        cancelButtonText: '取消',
      });
    } catch {
      return;
    }
  }
  savingTrade.value = true;
  try {
    const data = await bindWhaleAiTradeKeys({
      apiKey: apiKey.trim(),
      apiSecret: apiSecret.trim(),
      apiPassphrase: apiPassphrase.trim(),
      simulated,
    });
    tradeForm.value = { apiKey: '', apiSecret: '', apiPassphrase: '', simulated: true };
    reconfigTrade.value = false;
    if (data.warn) ElMessage.warning(data.warn);
    else ElMessage.success(`OKX ${simulated ? '模拟盘' : '实盘'} 已绑定`);
    pushLog('success', `OKX 交易接口已绑定（${simulated ? '模拟盘' : '实盘'}）`);
    await loadAccountSnapshot();
    void pollEngineDashboard();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '绑定失败');
  } finally {
    savingTrade.value = false;
  }
}

function cancelTradeReconfig() {
  if (!whaleAiTradeReady.value) return;
  reconfigTrade.value = false;
  tradeForm.value = { apiKey: '', apiSecret: '', apiPassphrase: '', simulated: true };
}

async function clearTradeKeys() {
  try {
    await ElMessageBox.confirm('将清除 OKX 交易接口。', '清除交易密钥', {
      type: 'warning',
      confirmButtonText: '确认清除',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  clearingTrade.value = true;
  try {
    await unbindWhaleAiTradeKeys();
    reconfigTrade.value = false;
    positions.value = [];
    pendingOrders.value = [];
    accountLive.value = false;
    ElMessage.success('已清除 OKX 交易接口');
    pushLog('info', 'OKX 交易接口已清除');
    await loadAccountSnapshot();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '清除失败');
  } finally {
    clearingTrade.value = false;
  }
}

/* ===== 策略切换 / 引擎控制 ===== */
function onApplyStrategy() {
  const next = pendingExecutionId.value;
  const item = executionItems.value.find((i) => i.id === next);
  if (!item) {
    ElMessage.warning('请选择有效的执行策略');
    return;
  }
  if (!item.available) {
    ElMessage.warning(
      item.disabled_reason === 'HFT_SIM_DISABLED'
        ? 'QA 开平仓测试未启用：服务端未打开 V41_HFT_SIM_ENABLED'
        : item.disabled_reason === 'WARMING_UP_OR_NOT_IMPLEMENTED'
          ? '巨鲸行为共振尚未开放'
          : '当前选项不可用',
    );
    return;
  }
  if (next === selectedExecutionId.value) {
    ElMessage.info('当前已经在使用这个执行模式');
    return;
  }
  showSwitchModal.value = true;
}

async function confirmSwitch() {
  if (controlBusy.value) return;
  const next = pendingExecutionId.value;
  const item = executionItems.value.find((i) => i.id === next);
  if (!item?.available) return;
  controlBusy.value = true;
  try {
    const result = (await selectExecution({ id: next, reason: 'manual_user_switch' })) as {
      console_mode?: string;
      active_strategy_id?: string;
      alpha_opening_enabled?: boolean;
    };
    selectedExecutionId.value = next;
    if (result.console_mode) consoleMode.value = result.console_mode;
    if (typeof result.alpha_opening_enabled === 'boolean') {
      alphaOpeningEnabled.value = result.alpha_opening_enabled;
    }
    showSwitchModal.value = false;
    if (item.kind === 'qa_test') {
      await refreshQaStatus();
      pushLog('success', '已进入 QA 开平仓链路测试：应用后点「启动」开始开平仓（不计赚损）');
      ElMessage.success('已进入 QA 开平仓链路测试');
    } else {
      await fetchEngineDashboard();
      pushLog('success', `交易策略已切换为「${item.name}」`);
      ElMessage.success('策略已切换');
    }
    await refreshExecutionSelections();
  } catch (err: unknown) {
    const anyErr = err as { code?: string; message?: string; details?: { code?: string; message?: string } };
    const code = String(anyErr?.details?.code || anyErr?.code || '');
    let msg = anyErr?.message || (err instanceof Error ? err.message : '切换失败');
    if (code === 'STRATEGY_SWITCH_SAFETY_BLOCKED') msg = '当前安全状态不允许切换策略';
    else if (code === 'HFT_SIM_DISABLED') msg = 'QA 开平仓测试未启用';
    else if (code === 'WARMING_UP_OR_NOT_IMPLEMENTED') msg = '巨鲸行为共振尚未开放';
    else if (code === 'V41_ENGINE_UNAVAILABLE' || code === 'V41_ENGINE_TIMEOUT') msg = '引擎离线，无法切换';
    pendingExecutionId.value = selectedExecutionId.value;
    ElMessage.error(msg);
    pushLog('error', msg);
  } finally {
    controlBusy.value = false;
  }
}

async function onStart() {
  if (emergencyLocked.value) {
    showResumeModal.value = true;
    return;
  }
  if (controlBusy.value || qaBusy.value) return;
  if (isQaConsole.value) {
    await onQaStart();
    return;
  }
  controlBusy.value = true;
  try {
    await startEngine();
    pushLog('success', '交易系统已启动（引擎运行中 · Alpha开仓已启用）', { channel: 'SYSTEM' });
    ElMessage.success('引擎已启动');
  } catch (err) {
    const msg = err instanceof Error ? err.message : '启动失败';
    ElMessage.error(msg);
    pushLog('error', msg);
  } finally {
    controlBusy.value = false;
  }
}

async function onStop() {
  if (emergencyLocked.value) {
    showResumeModal.value = true;
    return;
  }
  if (controlBusy.value || qaBusy.value) return;
  if (isQaConsole.value) {
    await onQaStop();
    return;
  }
  controlBusy.value = true;
  try {
    await pauseEngine();
    pushLog('warn', '引擎已停止（决策循环已暂停 · Alpha 不再评价）', { channel: 'SYSTEM' });
    ElMessage.success('已停止');
  } catch (err) {
    const anyErr = err as { code?: string; message?: string };
    let msg = anyErr?.message || (err instanceof Error ? err.message : '停止失败');
    if (anyErr?.code === 'V41_ENGINE_TIMEOUT' || /TIMEOUT|timeout/i.test(msg)) {
      msg = '停止超时：引擎无响应，请确认 Python 引擎在运行后重试';
    }
    ElMessage.error(msg);
    pushLog('error', msg);
  } finally {
    controlBusy.value = false;
  }
}

async function confirmResume() {
  const reason = resumeReason.value.trim();
  if (!reason) {
    ElMessage.warning('请填写恢复原因');
    return;
  }
  if (controlBusy.value) return;
  controlBusy.value = true;
  try {
    const incidentId =
      whaleAiSafety.value?.active_incident_id || whaleAiIncidents.value[0]?.incident_id || undefined;
    await resumeEngine(reason, incidentId);
    showResumeModal.value = false;
    resumeReason.value = '';
    pushLog('success', `恢复请求已提交：${reason}`);
    ElMessage.success('恢复请求已提交');
  } catch (err) {
    const msg = err instanceof Error ? err.message : '恢复失败';
    ElMessage.error(msg);
    pushLog('error', msg);
  } finally {
    controlBusy.value = false;
  }
}

function syncPendingStrategy() {
  if (!isQaConsole.value) {
    pendingExecutionId.value = selectedExecutionId.value || activeStrategy.value;
  }
}

function logStrategyHeartbeat() {
  if (!mainConsoleVisible.value || !isLoggedIn.value) return;
  if (isQaConsole.value) {
    const st = qaStatus.value;
    const running = Boolean(st?.running);
    const cycle = Number(st?.cycle_id || 0);
    const pos = Number(st?.position_notional_usdt || 0).toFixed(2);
    const side = String(st?.position_side || st?.state || 'FLAT');
    pushLog(
      running ? 'info' : 'warn',
      `QA 开平仓测试 · ${running ? '运行中' : '已停止'} · ${qaExchangeEnvLabel.value} · 第${cycle}轮 · ${qaSideLabelZh(side)} ${pos}U`,
      { channel: 'SYSTEM' },
    );
    return;
  }
  const sid = activeStrategy.value;
  const engineState = String(whaleAiEngineState.value || 'UNKNOWN').toUpperCase();
  const md = s1Diagnostics.value?.market_data || {};
  const evals = Number(s1Diagnostics.value?.evaluation_count || 0);
  const signals = Number(s1Diagnostics.value?.raw_signal_count || 0);
  const intents = Number(s1Diagnostics.value?.trade_intent_created_count || 0);
  const mdState = String(md.state || '').toUpperCase();
  if (engineState === 'PAUSED' || !engineOnline.value) {
    pushLog(
      'warn',
      `${sid} · 已暂停 · 决策循环已停止 · 上次心跳 ${ageText(lastTickAt.value)}`,
      { channel: 'SYSTEM', strategy_id: sid },
    );
    return;
  }
  if (mdState === 'STALE') {
    pushLog(
      'error',
      `${sid} · 行情过期 · ${md.source || 'OKX'} ${md.instrument || ''} ${md.timeframe === '1h' ? '1小时线' : md.timeframe || '1小时线'}`,
      { channel: 'SYSTEM', strategy_id: sid, symbol: String(md.instrument || '') },
    );
    return;
  }
  if (mdState === 'WARMING_UP') {
    pushLog(
      'warn',
      `${sid} · 行情预热 · 已加载 ${Number(md.bars_loaded || 0)} 根K线 · 评估 ${evals} 次`,
      { channel: 'SYSTEM', strategy_id: sid },
    );
    return;
  }
  pushLog(
    'info',
    `${sid} · ${engineStateLabelZh(engineState)} · 最近计算 ${ageText(lastEvaluatedAt.value)} · 评估 ${evals} 次 · 信号 ${signals} · 意图 ${intents}`,
    { channel: 'SYSTEM', strategy_id: sid },
  );
}

function startPolling() {
  stopPolling();
  void pollEngineDashboard();
  void loadAccountSnapshot();
  if (isQaConsole.value) void refreshQaStatus();
  const engineMs = privateWsConnected.value ? 15000 : 3000;
  enginePollTimer = window.setInterval(() => {
    if (mainConsoleVisible.value) void pollEngineDashboard();
  }, engineMs);
  okxPollTimer = window.setInterval(() => {
    if (mainConsoleVisible.value && whaleAiTradeReady.value) void loadAccountSnapshot();
  }, 8000);
  qaPollTimer = window.setInterval(() => {
    if (mainConsoleVisible.value && isQaConsole.value) void refreshQaStatus();
  }, 3000);
  statusLogTimer = window.setInterval(() => {
    logStrategyHeartbeat();
  }, 60_000);
}

function stopPolling() {
  if (enginePollTimer) {
    window.clearInterval(enginePollTimer);
    enginePollTimer = undefined;
  }
  if (okxPollTimer) {
    window.clearInterval(okxPollTimer);
    okxPollTimer = undefined;
  }
  if (qaPollTimer) {
    window.clearInterval(qaPollTimer);
    qaPollTimer = undefined;
  }
  if (statusLogTimer) {
    window.clearInterval(statusLogTimer);
    statusLogTimer = undefined;
  }
}

function startPrivateWs() {
  if (!isLoggedIn.value) return;
  privateRealtime.start();
}

function stopPrivateWs() {
  privateRealtime.stop();
  privateWsConnected.value = false;
}

watch(isLoggedIn, (logged) => {
  if (logged) {
    void refreshWhaleAiKeyStatus(true);
    void refreshWhaleAiTradeStatus(true).then(() => loadAccountSnapshot());
    if (mainConsoleVisible.value) startPrivateWs();
  } else {
    stopPolling();
    stopPrivateWs();
  }
});

watch(isLoggedIn, (ok) => {
  if (ok) void loadRuntimeLogs();
  else {
    systemLogs.value = [];
    positionLogs.value = [];
  }
});

watch(whaleAiStrategyDiagnostics, (diag) => {
  if (!diag) return;
  if (typeof diag.alpha_opening_enabled === 'boolean') {
    alphaOpeningEnabled.value = diag.alpha_opening_enabled;
  }
  if (diag.pending_log_event) {
    applyPositionDecision(diag.pending_log_event as Record<string, unknown>);
  } else if (diag.last_decision) {
    applyPositionDecision({
      strategy_id: diag.strategy_id,
      symbol: diag.market_data?.instrument,
      direction: diag.decision?.direction_candidate || 'NONE',
      decision: diag.last_decision,
      reason_codes: diag.last_reason_codes || [],
      event_type: diag.last_decision === 'ALLOW' ? '信号' : '拒绝',
    });
  }
});

watch(
  systemLogs,
  () => {
    if (systemPinned.value) scrollLogToLatest('SYSTEM');
  },
  { deep: true, flush: 'post' },
);
watch(
  positionLogs,
  () => {
    if (positionPinned.value) scrollLogToLatest('POSITION');
  },
  { deep: true, flush: 'post' },
);

watch(whaleAiTradeReady, () => {
  void loadAccountSnapshot();
});

watch(mainConsoleVisible, (visible) => {
  if (visible) {
    startPolling();
    startPrivateWs();
  } else {
    stopPolling();
    stopPrivateWs();
  }
});

watch(activeStrategy, syncPendingStrategy, { immediate: true });

onMounted(() => {
  if (isLoggedIn.value) {
    void refreshWhaleAiKeyStatus(true);
    void refreshWhaleAiTradeStatus(true).then(() => loadAccountSnapshot());
    void loadRuntimeLogs().then(() => {
      if (!systemLogs.value.length) {
        pushLog('info', '个人交易舱已加载：账户/持仓接 OKX，策略与信号接 V4.1 引擎', {
          channel: 'SYSTEM',
        });
      }
      scrollLogToLatest('SYSTEM');
      scrollLogToLatest('POSITION');
    });
  } else {
    pushLog('info', '个人交易舱已加载：登录后可持久化策略运行日志', {
      persist: false,
      channel: 'SYSTEM',
    });
  }
  if (mainConsoleVisible.value) {
    startPolling();
    startPrivateWs();
  }
  void refreshExecutionSelections().then(() => refreshQaStatus());
});

onUnmounted(() => {
  stopPolling();
  stopPrivateWs();
});
</script>

<template>
  <div class="v41-shell">
    <div v-if="!isLoggedIn" class="gate">
      <h3>鲸鱼AI 需要登录</h3>
      <p>登录后绑定 DeepSeek 与 OKX，即可查看账户与持仓。</p>
      <button type="button" class="btn btn-primary" @click="emit('requestLogin')">去登录</button>
    </div>

    <div v-else-if="showKeySetup" class="gate">
      <h3>{{ whaleAiKeyReady ? '更换 DeepSeek 接口' : '配置鲸鱼AI' }}</h3>
      <p>先填写 DeepSeek 密钥，再绑定 OKX 交易密钥。</p>
      <div class="key-form">
        <label>
          <span>DeepSeek 密钥</span>
          <input v-model="apiKeyInput" type="password" autocomplete="new-password" placeholder="sk-…" />
        </label>
        <p v-if="whaleAiKeyHint" class="hint">当前密钥：{{ whaleAiKeyHint }}</p>
        <div class="buttons">
          <button v-if="whaleAiKeyReady" type="button" class="btn" :disabled="savingKeys" @click="cancelReconfig">
            取消
          </button>
          <button
            v-if="whaleAiKeyReady"
            type="button"
            class="btn btn-danger"
            :disabled="savingKeys || clearingKeys"
            @click="clearKey"
          >
            清除
          </button>
          <button type="button" class="btn btn-primary" :disabled="savingKeys" @click="submitKey">
            {{ savingKeys ? '校验中…' : '校验并保存' }}
          </button>
        </div>
      </div>
    </div>

    <div v-else-if="showTradeSetup" class="gate">
      <h3>{{ whaleAiTradeReady ? '更换 OKX 交易接口' : '绑定 OKX 交易' }}</h3>
      <p>交易密钥用于账户同步与开平仓。建议先用模拟盘。</p>
      <div class="key-form">
        <label><span>OKX 密钥</span><input v-model="tradeForm.apiKey" type="password" autocomplete="new-password" /></label>
        <label><span>OKX 私钥</span><input v-model="tradeForm.apiSecret" type="password" autocomplete="new-password" /></label>
        <label>
          <span>OKX 口令</span>
          <input v-model="tradeForm.apiPassphrase" type="password" autocomplete="new-password" />
        </label>
        <label class="check-row">
          <input v-model="tradeForm.simulated" type="checkbox" />
          <span>使用模拟盘（推荐）</span>
        </label>
        <p v-if="whaleAiTradeHint" class="hint">当前密钥：{{ whaleAiTradeHint }}</p>
        <div class="buttons">
          <button
            v-if="whaleAiTradeReady"
            type="button"
            class="btn"
            :disabled="savingTrade"
            @click="cancelTradeReconfig"
          >
            取消
          </button>
          <button
            v-if="whaleAiTradeReady"
            type="button"
            class="btn btn-danger"
            :disabled="savingTrade || clearingTrade"
            @click="clearTradeKeys"
          >
            清除
          </button>
          <button type="button" class="btn btn-primary" :disabled="savingTrade" @click="submitTradeKeys">
            {{ savingTrade ? '校验中…' : '校验并保存' }}
          </button>
        </div>
      </div>
    </div>

    <div v-else class="app">
      <header class="header">
        <div class="brand">
          鲸鱼AI · 个人交易舱
          <span class="badge">V4.1</span>
          <button type="button" class="link" @click="reconfigKeys = true">DeepSeek</button>
          <button type="button" class="link" @click="reconfigTrade = true">
            OKX {{ whaleAiTradeSimulated ? '模拟' : '实盘' }}
          </button>
        </div>
        <div class="header-right">
          <div class="pill">
            <span class="dot" :class="systemDot" />
            <strong>{{ systemStateLabel }}</strong>
          </div>
          <div class="pill">
            Alpha执行：
            <strong>{{ alphaExecutionLabel }}</strong>
          </div>
          <div class="pill">
            安全状态：
            <strong :class="safetyTone">{{ safetyLabel }}</strong>
          </div>
          <div class="pill muted">最后更新：{{ lastUpdate }}</div>
        </div>
      </header>

      <section class="metrics">
        <div class="card balance">
          <div class="card-title">账户总净值 <span>USDT</span></div>
          <div class="metric-value">{{ equityText }}</div>
          <div class="metric-sub">可用 {{ availableText }} · 冻结 {{ frozenText }}</div>
        </div>
        <div class="card">
          <div class="card-title">今日盈亏</div>
          <div class="metric-value" :class="dayPnlPositive ? 'green' : 'red'">{{ dayPnlText }}</div>
          <div class="metric-sub">{{ dayPnlPctText }}</div>
        </div>
        <div class="card">
          <div class="card-title">当前回撤</div>
          <div class="metric-value">{{ drawdownText }}</div>
          <div class="metric-sub">相对账户净值</div>
        </div>
        <div class="card">
          <div class="card-title">当前风险</div>
          <div class="metric-value blue">{{ riskUsedText }}</div>
          <div class="metric-sub">风险上限 {{ riskLimitText }}</div>
        </div>
        <div class="card">
          <div class="card-title">策略健康度</div>
          <div class="metric-value" :class="healthTone">{{ healthScoreText }}</div>
          <div class="metric-sub">{{ healthSubText }}</div>
        </div>
      </section>

      <section class="grid-2">
        <div class="card strategy-box">
          <div class="section-title">
            <span>当前执行策略</span>
            <span class="section-sub">{{ isQaConsole ? '高频开平仓 · 不计赚损' : '每次只运行一个 Alpha' }}</span>
          </div>

          <div class="strategy-current">
            <div class="strategy-current-top">
              <div>
                <div class="strategy-name">{{ currentStrategy.name }}</div>
                <div class="strategy-desc">{{ currentStrategy.desc }}</div>
              </div>
              <span class="status-tag" :class="strategyStatusClass">{{ strategyStatusLabel }}</span>
            </div>
            <div v-if="!isQaConsole" class="strategy-details">
              <div class="mini">
                <div class="k">策略编号</div>
                <div class="v">{{ activeStrategy }}</div>
              </div>
              <div class="mini">
                <div class="k">健康度</div>
                <div class="v" :class="healthTone">{{ healthScoreText }}</div>
              </div>
              <div class="mini">
                <div class="k">风险预算</div>
                <div class="v blue">{{ strategyRiskBudgetText }}</div>
              </div>
              <div class="mini">
                <div class="k">预期收益</div>
                <div class="v">{{ strategyExpectancyText }}</div>
              </div>
              <div class="mini">
                <div class="k">Alpha执行</div>
                <div class="v">{{ alphaExecutionLabel }}</div>
              </div>
            </div>
            <div v-else class="strategy-details">
              <div class="mini">
                <div class="k">执行环境</div>
                <div class="v">{{ qaExchangeEnvLabel }}</div>
              </div>
              <div class="mini">
                <div class="k">最大名义仓位</div>
                <div class="v">50 USDT</div>
              </div>
              <div class="mini">
                <div class="k">开平周期</div>
                <div class="v">{{ qaStatus?.cycle_id || 0 }}</div>
              </div>
              <div class="mini">
                <div class="k">策略统计</div>
                <div class="v">不计赚损</div>
              </div>
            </div>
          </div>

          <div class="strategy-select-row">
            <div class="field">
              <label>切换执行策略</label>
              <select v-model="pendingExecutionId">
                <optgroup label="Alpha 策略">
                  <option
                    v-for="item in alphaItems"
                    :key="item.id"
                    :value="item.id"
                    :disabled="!item.available"
                  >
                    {{ item.name }}{{ item.available ? '' : '（不可用）' }}
                  </option>
                </optgroup>
                <optgroup label="测试模式">
                  <option
                    v-for="item in qaItems"
                    :key="item.id"
                    :value="item.id"
                    :disabled="!item.available"
                  >
                    {{ item.name }}{{ item.available ? '' : ' · 未启用' }}
                  </option>
                </optgroup>
              </select>
            </div>
            <div class="buttons strategy-actions">
              <button type="button" class="btn btn-primary" :disabled="controlBusy || qaBusy" @click="onApplyStrategy">
                应用
              </button>
              <button
                v-if="!strategyIsRunning"
                type="button"
                class="btn btn-success"
                :disabled="controlBusy || qaBusy || (isQaConsole && (!qaEnabled || !qaCanRunExchange))"
                @click="onStart"
              >
                {{ isQaConsole ? '启动' : '启动交易系统' }}
              </button>
              <button
                v-else
                type="button"
                class="btn btn-danger"
                :disabled="controlBusy || qaBusy"
                @click="onStop"
              >
                停止
              </button>
            </div>
          </div>
          <div class="section-sub tip">
            <template v-if="isQaConsole">
              应用后点启动：持续高频开平仓；点停止结束。不改变 active_strategy，不计策略赚损。
              <span v-if="!qaEnabled || !qaCanRunExchange" style="color: var(--yellow)">
                · {{ qaRunDisabledReason }}
              </span>
            </template>
            <template v-else>
              切换后，旧策略停止产生新信号；现有持仓仍按原风险规则管理。
            </template>
          </div>
        </div>

        <div class="card">
          <div class="section-title">
            <span>市场与风控状态</span>
            <span class="status-tag" :class="overallRiskTag.cls">{{ overallRiskTag.text }}</span>
          </div>
          <div class="system-grid">
            <div class="system-item"><span>市场状态</span><strong>{{ marketRegime }}</strong></div>
            <div class="system-item"><span>方向偏向</span><strong>{{ directionBias }}</strong></div>
            <div class="system-item"><span>行情延迟</span><strong>{{ marketLatency }}</strong></div>
            <div class="system-item">
              <span>交易所连接</span>
              <strong :class="exchangeState === '—' || exchangeState === '断开' ? '' : 'green'">{{
                exchangeState
              }}</strong>
            </div>
            <div class="system-item"><span>仓位核对</span><strong>{{ reconcileState }}</strong></div>
            <div class="system-item"><span>风险引擎</span><strong>{{ riskEngineState }}</strong></div>
          </div>
          <div class="risk-bar">
            <div class="risk-line">
              <span>已使用风险</span>
              <strong>{{ riskUsedText }} / {{ riskLimitText }}</strong>
            </div>
            <div class="track"><div class="fill" :style="{ width: `${riskBarPct}%` }" /></div>
          </div>
        </div>
      </section>

      <section class="grid-3">
        <div class="card">
          <div class="section-title">
            <span>当前交易信号</span>
            <span class="section-sub">{{ engineOnline ? '交易意图' : '引擎离线' }}</span>
          </div>
          <div v-if="!signals.length" class="empty">暂无信号</div>
          <div v-else class="signal-list">
            <div v-for="s in signals" :key="s.id" class="signal">
              <div class="signal-head">
                <div class="signal-symbol">
                  <span>{{ s.symbol }}</span>
                  <span class="side" :class="s.side === 'LONG' ? 'long' : 'short'">{{ sideLabel(s.side) }}</span>
                </div>
                <span class="status-tag" :class="signalStatusClass(s.status)">{{ s.status }}</span>
              </div>
              <div class="signal-meta">
                <div class="signal-kv"><div class="k">信号时间</div><div class="v">{{ s.age }}</div></div>
                <div class="signal-kv"><div class="k">价格偏移</div><div class="v">{{ s.drift }}</div></div>
                <div class="signal-kv"><div class="k">预期收益</div><div class="v">{{ s.edge }}</div></div>
                <div class="signal-kv"><div class="k">当前策略</div><div class="v">{{ activeStrategy }}</div></div>
              </div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="section-title">
            <span>当前持仓</span>
            <span class="section-sub">{{ accountEnvironmentLabel }}</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>币种</th>
                <th>方向</th>
                <th>风险</th>
                <th>盈亏</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!positions.length">
                <td colspan="4" class="empty-cell">暂无持仓</td>
              </tr>
              <tr v-for="p in positions" :key="p.instId">
                <td><strong>{{ p.symbol }}</strong></td>
                <td>
                  <span class="side" :class="p.side === 'LONG' ? 'long' : 'short'">{{ sideLabel(p.side) }}</span>
                </td>
                <td>{{ p.risk }}</td>
                <td :class="p.pnlPositive ? 'green' : 'red'">{{ p.pnl }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="card">
          <div class="section-title">
            <span>最近订单</span>
            <span class="section-sub">执行情况</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>币种</th>
                <th>状态</th>
                <th>滑点</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!pendingOrders.length">
                <td colspan="4" class="empty-cell">暂无挂单</td>
              </tr>
              <tr v-for="(o, idx) in pendingOrders" :key="`${o.symbol}-${idx}`">
                <td>{{ o.symbol }}</td>
                <td>
                  <span class="status-tag" :class="orderStatusClass(o.status)">{{
                    orderStatusLabel(o.status)
                  }}</span>
                </td>
                <td>{{ o.slip }}</td>
                <td>{{ o.age }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="card log-panel">
        <div class="log-split">
          <div class="log-col log-col-system">
            <div class="section-title">
              <span>系统运行日志</span>
              <span class="section-sub">
                <span class="log-badge" :class="engineOnline ? 'on' : 'off'">
                  引擎{{ engineOnline ? '在线' : '离线' }}
                </span>
                {{ Math.min(systemLogs.length, LOG_SHOW) }}/{{ systemLogs.length }}
              </span>
            </div>
            <button
              v-if="!systemPinned && systemLogs.length"
              type="button"
              class="log-jump"
              @click="scrollLogToLatest('SYSTEM')"
            >
              回到最新
            </button>
            <div ref="systemLogBox" class="log-box" @scroll="onLogScroll('SYSTEM')">
              <div v-if="!systemLogs.length" class="log-entry">暂无系统运行日志</div>
              <div
                v-for="(l, idx) in systemLogs.slice(-LOG_SHOW)"
                :key="`sys-${l.id || l.ts || l.t}-${idx}`"
                class="log-entry"
              >
                <span class="log-time">{{ l.t }}</span>
                <span :class="`log-${l.lvl}`">[{{ logLevelLabel(l.lvl) }}]</span>
                {{ l.msg }}
              </div>
            </div>
          </div>
          <div class="log-col log-col-position">
            <div class="section-title">
              <span>仓位日志</span>
              <span class="section-sub">
                <span class="log-badge" :class="activePositionCount > 0 ? 'on' : 'off'">
                  当前持仓 {{ activePositionCount }}
                </span>
                {{ Math.min(positionLogs.length, LOG_SHOW) }}/{{ positionLogs.length }}
              </span>
            </div>
            <button
              v-if="!positionPinned && positionLogs.length"
              type="button"
              class="log-jump"
              @click="scrollLogToLatest('POSITION')"
            >
              回到最新
            </button>
            <div ref="positionLogBox" class="log-box" @scroll="onLogScroll('POSITION')">
              <div v-if="!positionLogs.length" class="log-entry">暂无仓位生命周期事件</div>
              <div
                v-for="(l, idx) in positionLogs.slice(-LOG_SHOW)"
                :key="`pos-${l.id || l.ts || l.t}-${idx}`"
                class="log-entry"
              >
                <span class="log-time">{{ l.t }}</span>
                <span :class="`log-${l.lvl}`">[{{ logLevelLabel(l.lvl) }}]</span>
                {{ l.msg }}
              </div>
            </div>
          </div>
        </div>
      </section>

      <div class="footer-note">
        账户 / 持仓 / 挂单：OKX 每 8s · 引擎仪表盘：V4.1 每 3s 轮询
        <template v-if="bridgeHint"> · bridge {{ bridgeHint }}</template>
        <template v-if="whaleAiEngineError && !engineOnline"> · {{ whaleAiEngineError }}</template>
      </div>
    </div>

    <div v-if="showSwitchModal" class="modal-backdrop" @click.self="showSwitchModal = false">
      <div class="modal">
        <h3>确认切换执行模式</h3>
        <p v-if="pendingSelection?.kind === 'qa_test'">
          将进入「QA 开平仓链路测试」。不会修改 active_strategy_id（当前注册 Alpha 仍为
          {{ activeStrategy }}），但会暂停新的 Alpha 开仓；账户环境由 Node 根据当前 OKX 密钥识别。
        </p>
        <p v-else>
          将切换到「{{ pendingSelection?.name || pendingExecutionId }}」。旧策略停止产生新信号，现有持仓继续按原风控规则管理。
        </p>
        <div class="modal-actions">
          <button type="button" class="btn" @click="showSwitchModal = false">取消</button>
          <button type="button" class="btn btn-primary" :disabled="controlBusy" @click="confirmSwitch">
            确认切换
          </button>
        </div>
      </div>
    </div>

    <div v-if="showResumeModal" class="modal-backdrop" @click.self="showResumeModal = false">
      <div class="modal">
        <h3>恢复交易</h3>
        <p>系统当前处于紧急停止状态。确认风险状态和交易所连接正常后，再执行恢复。</p>
        <textarea
          v-model="resumeReason"
          placeholder="填写恢复原因，例如：已确认仓位、挂单和交易所连接均正常"
        />
        <div class="modal-actions">
          <button type="button" class="btn" @click="showResumeModal = false">取消</button>
          <button type="button" class="btn btn-warning" :disabled="controlBusy" @click="confirmResume">
            确认恢复
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.v41-shell {
  --bg: #0b0e14;
  --panel: #151b23;
  --panel2: #0d1117;
  --border: #2d333b;
  --border2: #21262d;
  --text: #e6edf3;
  --muted: #8b949e;
  --blue: #1f6feb;
  --green: #2da44e;
  --yellow: #d29922;
  --red: #f85149;
  height: 100%;
  overflow: auto;
  background: var(--bg);
  color: var(--text);
  font-family:
    Inter,
    -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    Roboto,
    'PingFang SC',
    'Microsoft YaHei',
    Arial,
    sans-serif;
}
.app {
  max-width: none;
  width: 100%;
  margin: 0;
  padding: 12px 16px 16px;
  box-sizing: border-box;
  min-height: 100%;
}
.gate {
  max-width: 520px;
  margin: 48px auto;
  padding: 28px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 16px;
  text-align: center;
}
.gate h3 {
  margin: 0 0 8px;
}
.gate p {
  margin: 0 0 16px;
  color: var(--muted);
  font-size: 13px;
}
.key-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  text-align: left;
}
.key-form label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
}
.key-form input[type='password'] {
  height: 40px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--panel2);
  color: var(--text);
  font: inherit;
}
.check-row {
  flex-direction: row !important;
  align-items: center;
  gap: 8px !important;
  color: var(--text) !important;
}
.hint {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 14px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.brand {
  font-size: 26px;
  font-weight: 800;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.badge {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--blue);
  color: white;
  font-weight: 700;
}
.link {
  border: 0;
  background: transparent;
  color: #58a6ff;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}
.header-right {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--border);
  background: #1c2128;
  border-radius: 999px;
  padding: 8px 12px;
  font-size: 13px;
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
}
.dot.green {
  background: var(--green);
  box-shadow: 0 0 10px #2da44e77;
}
.dot.yellow {
  background: var(--yellow);
  box-shadow: 0 0 10px #d2992277;
}
.dot.red {
  background: var(--red);
  box-shadow: 0 0 10px #f8514977;
}

.metrics {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 16px;
}
.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 18px 20px;
  min-width: 0;
}
.balance {
  background: linear-gradient(145deg, #1a2332, #0f1729);
  border-color: var(--blue);
}
.card-title {
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
  margin-bottom: 9px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.metric-value {
  font-size: 32px;
  font-weight: 800;
  white-space: nowrap;
  letter-spacing: -0.5px;
}
.metric-sub {
  margin-top: 6px;
  color: var(--muted);
  font-size: 13px;
}
.green {
  color: var(--green);
}
.red {
  color: var(--red);
}
.yellow {
  color: var(--yellow);
}
.blue {
  color: #58a6ff;
}
.muted {
  color: var(--muted);
}

.grid-2 {
  display: grid;
  grid-template-columns: 1.25fr 1fr;
  gap: 16px;
  margin-bottom: 16px;
}
.grid-3 {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 16px;
  margin-bottom: 16px;
}
.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-weight: 800;
  font-size: 16px;
  margin-bottom: 12px;
}
.section-sub {
  color: var(--muted);
  font-size: 12px;
  font-weight: 500;
}
.tip {
  margin-top: 8px;
}
.mode {
  margin-left: 10px;
}

.strategy-box {
  border: 1px solid #30415f;
  background: linear-gradient(145deg, #151b23, #101722);
}
.strategy-current {
  background: var(--panel2);
  border: 1px solid var(--border2);
  border-radius: 12px;
  padding: 14px;
  margin-bottom: 12px;
}
.strategy-current-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
}
.strategy-name {
  font-size: 22px;
  font-weight: 850;
  margin-bottom: 5px;
}
.strategy-desc {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
}
.strategy-select-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  align-items: end;
}
.strategy-actions {
  flex-wrap: nowrap;
  white-space: nowrap;
}
.field label {
  display: block;
  color: var(--muted);
  font-size: 11px;
  margin-bottom: 5px;
}
select {
  width: 100%;
  background: var(--panel2);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 10px 11px;
  outline: none;
  font-size: 13px;
  font: inherit;
}
.strategy-details {
  display: grid;
  grid-template-columns: repeat(4, minmax(100px, 1fr));
  gap: 8px;
  margin-top: 12px;
}
.mini {
  background: #11161d;
  border: 1px solid #1c2128;
  border-radius: 9px;
  padding: 9px 10px;
}
.mini .k {
  color: var(--muted);
  font-size: 10px;
  margin-bottom: 4px;
}
.mini .v {
  font-size: 12px;
  font-weight: 750;
}

.status-tag {
  display: inline-flex;
  align-items: center;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 800;
}
.tag-on {
  background: #1a3a2a;
  color: var(--green);
}
.tag-warn {
  background: #3a2f16;
  color: var(--yellow);
}
.tag-off {
  background: #3d1a1a;
  color: var(--red);
}
.tag-info {
  background: #16213a;
  color: #58a6ff;
}
.tag-neutral {
  background: #1c2128;
  color: #c9d1d9;
}

.system-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 18px;
}
.system-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid var(--border2);
  padding: 8px 0;
  font-size: 12px;
}
.system-item span:first-child {
  color: var(--muted);
}
.risk-bar {
  margin-top: 10px;
}
.risk-line {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
  font-size: 12px;
}
.track {
  height: 9px;
  background: #21262d;
  border-radius: 999px;
  overflow: hidden;
}
.fill {
  height: 100%;
  background: var(--blue);
  border-radius: 999px;
  min-width: 0;
}

.signal-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.signal {
  background: var(--panel2);
  border: 1px solid var(--border2);
  border-radius: 10px;
  padding: 11px;
}
.signal-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.signal-symbol {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 800;
}
.side {
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 850;
}
.long {
  background: #1a3a2a;
  color: var(--green);
}
.short {
  background: #3d1a1a;
  color: var(--red);
}
.signal-meta {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 7px;
  margin-top: 9px;
}
.signal-kv {
  background: #11161d;
  border-radius: 8px;
  padding: 7px 8px;
}
.signal-kv .k {
  font-size: 10px;
  color: var(--muted);
  margin-bottom: 3px;
}
.signal-kv .v {
  font-size: 12px;
  font-weight: 700;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
th,
td {
  text-align: left;
  padding: 9px 7px;
  border-bottom: 1px solid var(--border2);
  vertical-align: middle;
}
th {
  color: var(--muted);
  font-weight: 650;
}
.empty,
.empty-cell {
  color: var(--muted);
  text-align: center;
  padding: 20px 0;
  font-size: 13px;
}
.empty-cell {
  padding: 18px !important;
}

.btn {
  appearance: none;
  border: 1px solid #30363d;
  color: #c9d1d9;
  background: #21262d;
  border-radius: 9px;
  padding: 9px 12px;
  font-weight: 750;
  font-size: 12px;
  cursor: pointer;
  font: inherit;
}
.btn:hover:not(:disabled) {
  filter: brightness(1.08);
}
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.btn-primary {
  background: var(--blue);
  border-color: var(--blue);
  color: #fff;
}
.btn-warning {
  background: #9e6a03;
  border-color: #9e6a03;
  color: #fff;
}
.btn-danger {
  background: #da3633;
  border-color: #da3633;
  color: #fff;
}
.btn-success {
  background: var(--green);
  border-color: var(--green);
  color: #fff;
}
.buttons {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.control-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.log-panel {
  position: relative;
}
.log-split {
  display: grid;
  grid-template-columns: 55% 45%;
  gap: 12px;
  align-items: stretch;
}
.log-col {
  min-width: 0;
  position: relative;
}
.log-col .section-title {
  margin-bottom: 8px;
}
.log-badge {
  display: inline-block;
  margin-right: 8px;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  border: 1px solid var(--border);
}
.log-badge.on {
  color: var(--green);
  border-color: #2da44e66;
}
.log-badge.off {
  color: var(--muted);
}
.log-jump {
  position: absolute;
  right: 10px;
  top: 42px;
  z-index: 2;
  border: 1px solid var(--border);
  background: #21262d;
  color: var(--text);
  border-radius: 8px;
  padding: 2px 8px;
  font-size: 12px;
  cursor: pointer;
}
.log-box {
  height: 280px;
  overflow: auto;
  overflow-anchor: none;
  background: var(--panel2);
  border: 1px solid var(--border2);
  border-radius: 10px;
  padding: 12px;
  font-family: Consolas, monospace;
  font-size: 13px;
  line-height: 1.65;
}
.log-entry {
  padding: 2px 0;
  border-bottom: 1px solid #161b22;
}
.log-time {
  color: var(--muted);
  margin-right: 8px;
}
.log-info {
  color: #58a6ff;
}
.log-success {
  color: var(--green);
}
.log-warn {
  color: var(--yellow);
}
.log-error {
  color: var(--red);
}

.footer-note {
  text-align: center;
  color: var(--muted);
  font-size: 11px;
  padding: 8px 0 4px;
}

.modal-backdrop {
  position: fixed;
  inset: 0;
  background: #0009;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 20px;
}
.modal {
  width: min(520px, 100%);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 17px;
}
.modal h3 {
  margin: 0 0 8px;
}
.modal p {
  margin: 0 0 13px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
textarea {
  width: 100%;
  min-height: 80px;
  resize: vertical;
  background: var(--panel2);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 9px;
  outline: none;
  font: inherit;
}

@media (max-width: 1200px) {
  .metrics {
    grid-template-columns: repeat(3, 1fr);
  }
  .grid-3 {
    grid-template-columns: 1fr 1fr;
  }
}
@media (max-width: 850px) {
  .grid-2,
  .grid-3,
  .log-split {
    grid-template-columns: 1fr;
  }
  .metrics {
    grid-template-columns: repeat(2, 1fr);
  }
  .strategy-details {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (max-width: 560px) {
  .app {
    padding: 10px 12px 14px;
  }
  .metrics {
    grid-template-columns: 1fr;
  }
  .strategy-select-row,
  .strategy-details,
  .system-grid,
  .signal-meta {
    grid-template-columns: 1fr;
  }
}
</style>
