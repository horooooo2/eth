<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { authUser } from '@/stores/auth';

const API_BASE = (import.meta.env.VITE_AI_TRADER_API as string | undefined) || '/ai-api';

function ownerKey(): string {
  const u = authUser.value;
  return (u?.id || u?.username || '').trim();
}

function ownerHeaders(): Record<string, string> {
  const id = ownerKey();
  return id ? { 'X-AI-Trader-Owner': id } : {};
}
type Account = {
  equity: number;
  available: number;
  today_pnl: number;
  today_pnl_pct: number;
  position_count: number;
  risk_exposure_pct: number;
  risk_cap_pct: number;
  last_sync?: string | null;
  source?: string;
};

type State = {
  mood: string;
  mood_label: string;
  risk_appetite: number;
  patience: number;
  focus: number;
  self_doubt: number;
  stubbornness: number;
  stress: number;
  sleep_debt: number;
  primary_mode: string;
  modifiers: string[];
  mode_label: string;
  last_updated: string;
};

type Character = {
  available?: boolean;
  id?: string | null;
  name: string;
  age: number | null;
  occupation: string;
  location: string;
  tags: string[];
  traits: { name: string; value: number; change_7d: number }[];
  emotion_arc: string;
  recent_events: { time: string; icon: string; text: string }[];
};

type CurrentPos = {
  position_id: string;
  symbol: string;
  side: string;
  leverage: number;
  margin: number;
  entry_price: number;
  current_price: number;
  stop_loss?: number | null;
  take_profit?: number | null;
  pnl: number;
  pnl_pct: number;
  holding_minutes: number;
  psychology_mood: string;
  decision_id?: string | null;
};

type HistoryPos = {
  position_id: string;
  symbol: string;
  side: string;
  entry_price: number;
  exit_price?: number | null;
  realized_pnl: number;
  pnl_pct: number;
  exit_reason?: string | null;
  entry_time?: string | null;
  exit_time?: string | null;
  narrative_reason: string;
};

type Positions = {
  current: CurrentPos[];
  history: HistoryPos[];
  summary: { total_margin: number; total_pnl: number; total_risk_pct: number };
};

type TimelineEntry = {
  timestamp: string;
  type: string;
  mood?: string | null;
  mood_label?: string | null;
  text?: string | null;
  mode?: string | null;
  prompt_version?: string | null;
  location?: string | null;
  activity?: string | null;
  decision?: string | null;
  symbol?: string | null;
  leverage?: number | null;
  margin?: number | null;
  signal_score?: number | null;
  threshold?: number | null;
  position_multiplier?: number | null;
  narrative_thought?: string | null;
};

const account = ref<Account | null>(null);
const state = ref<State | null>(null);
const character = ref<Character | null>(null);
const positions = ref<Positions | null>(null);
const timeline = ref<TimelineEntry[]>([]);
const timelineTotal = ref(0);
const apiOk = ref(false);
const aiReady = ref(false);
const aiReadyDetail = ref<{
  character_ok: boolean;
  okx_ok: boolean;
  deepseek_ok: boolean;
  missing: string[];
} | null>(null);
const systemHealth = ref<{
  key_ready: boolean;
  scheduler_running: boolean;
  narrator_mode: string;
  db_path: string;
  db_writable: boolean;
  last_scheduler_heartbeat?: string | null;
  details?: Record<string, unknown>;
} | null>(null);
const showHealthDetail = ref(false);
const lastRefresh = ref('');
const activePosId = ref<string | null>(null);
const errors = ref<Record<string, string>>({});

const showApiModal = ref(false);
const showCharModal = ref(false);
const showChatModal = ref(false);
const chatMessages = ref<{ role: string; content: string; impact_applied?: Record<string, number> }[]>([]);
const chatBodyRef = ref<HTMLElement | null>(null);

function scrollChatToBottom() {
  void nextTick(() => {
    const el = chatBodyRef.value;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  });
}

watch(
  () => chatMessages.value.length,
  () => {
    if (showChatModal.value) scrollChatToBottom();
  },
);
const chatInput = ref('');
const chatBusy = ref(false);
const chatStatus = ref('在线');
const cfgStatus = ref('');
const cfgOk = ref<boolean | null>(null);
const cfgForm = ref({
  okx_api_key: '',
  okx_secret_key: '',
  okx_passphrase: '',
  deepseek_api_key: '',
  okx_demo: false,
});
const cfgMasked = ref({
  okx_api_key: '',
  okx_secret_key: '',
  okx_passphrase: '',
  deepseek_api_key: '',
});
const charList = ref<{ active: string; characters: { id: string; name: string; tags: string[] }[] } | null>(
  null
);
const charStatus = ref('');
const killBusy = ref(false);

const traumaBanner = ref('');
let traumaSince = new Date(Date.now() - 86400000).toISOString();
let traumaTimer: number | undefined;
let timer: number | undefined;

async function pollTrauma() {
  try {
    const data = await fetchJson<{ events: { timestamp: string; description?: string; event_type: string; baseline_impact?: { impacts?: Record<string, number> } }[] }>(
      `/character/trauma-events?since=${encodeURIComponent(traumaSince)}`
    );
    const events = data.events || [];
    if (!events.length) return;
    const latest = events[events.length - 1];
    traumaSince = latest.timestamp || traumaSince;
    const impacts = latest.baseline_impact?.impacts || {};
    const impactText = Object.entries(impacts)
      .map(([k, v]) => `${k} ${Number(v) >= 0 ? '+' : ''}${v}`)
      .join('，');
    traumaBanner.value = `⚠️ 创伤事件：${latest.description || latest.event_type} · 基线变化：${impactText || '—'}`;
    if (traumaTimer) window.clearTimeout(traumaTimer);
    traumaTimer = window.setTimeout(() => {
      traumaBanner.value = '';
    }, 5000);
  } catch {
    /* ignore */
  }
}

async function fetchJson<T>(path: string): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, { headers: { ...ownerHeaders() } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify(body ?? {}),
  });
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      detail = (j as { detail?: string }).detail || detail;
    } catch {
      /* ignore */
    }
    if (resp.status === 405) {
      detail =
        'Method Not Allowed：/ai-api 未代理到 AI Trader。请确认生产 Node 已挂载 aiTraderProxy，且 FastAPI 在 AI_TRADER_URL 运行。';
    }
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return resp.json() as Promise<T>;
}

function fmt(n: unknown, d = 2) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(d);
}

function fmtMoney(n: unknown) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$—';
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pctSign(n: unknown) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return v >= 0 ? '+' : '';
}

function shortTime(ts?: string | null) {
  if (!ts) return '—';
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts.slice(11, 16) || ts;
    return d.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return ts;
  }
}

function clock(ts?: string | null) {
  if (!ts) return '—';
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts).slice(11, 16);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return '—';
  }
}

function sideClass(side?: string | null) {
  const s = String(side || '').toUpperCase();
  return s.includes('SHORT') || s === 'SELL' ? 'short' : 'long';
}

function sideLabel(side?: string | null) {
  return sideClass(side) === 'short' ? '空' : '多';
}

function traitColor(name: string) {
  if (name.includes('风险')) return '#f85149';
  if (name.includes('耐心') || name.includes('纪律')) return '#d29922';
  if (name.includes('固执')) return '#f0883e';
  return '#58a6ff';
}

function barTone(v: number, invert = false) {
  const x = invert ? 1 - v : v;
  if (x >= 0.65) return 'red';
  if (x >= 0.4) return 'yellow';
  return 'green';
}

function moodClass(mood?: string | null) {
  const m = String(mood || '').toLowerCase();
  if (['calm', 'anxious', 'angry', 'tired', 'confident'].includes(m)) return m;
  return 'anxious';
}

function changeClass(ch: number) {
  if (ch > 0.001) return 'up';
  if (ch < -0.001) return 'down';
  return 'flat';
}

function changeText(ch: number) {
  if (Math.abs(ch) < 0.001) return '→ 0.00';
  const arrow = ch > 0 ? '↑' : '↓';
  const sign = ch > 0 ? '+' : '';
  return `${arrow} ${sign}${ch.toFixed(2)} (7天)`;
}

const confidence = computed(() => {
  const s = state.value;
  if (!s) return 0.5;
  return Math.max(0, Math.min(1, 1 - Number(s.self_doubt || 0.5)));
});

const activePos = computed(() => {
  const list = positions.value?.current || [];
  if (!list.length) return null;
  return list.find((p) => p.position_id === activePosId.value) || list[0];
});

const histPreview = computed(() => (positions.value?.history || []).slice(0, 8));

const hasCharacter = computed(() => !!(character.value && character.value.available !== false && character.value.name));

const EMPTY_TRAIT_LABELS = ['风险偏好', '耐心', '固执', '自省', '纪律'];

function dash(v: unknown) {
  if (v === null || v === undefined || v === '') return '--';
  return String(v);
}

watch(
  () => positions.value?.current,
  (list) => {
    if (!list?.length) {
      activePosId.value = null;
      return;
    }
    if (!activePosId.value || !list.some((p) => p.position_id === activePosId.value)) {
      activePosId.value = list[0].position_id;
    }
  },
  { deep: true }
);

// 角色设定跟随登录账号：切换账号后重新拉取
watch(
  () => ownerKey(),
  () => {
    charList.value = null;
    charStatus.value = '';
    void refreshAll();
  }
);

async function load(key: string, fn: () => Promise<void>) {
  try {
    await fn();
    delete errors.value[key];
  } catch {
    errors.value[key] = '数据不可用';
  }
}

async function refreshAll() {
  await Promise.all([
    load('account', async () => {
      account.value = await fetchJson('/account');
    }),
    load('state', async () => {
      state.value = await fetchJson('/state');
    }),
    load('character', async () => {
      character.value = await fetchJson('/character');
    }),
    load('positions', async () => {
      positions.value = await fetchJson('/positions');
    }),
    load('timeline', async () => {
      const data = await fetchJson<{ entries: TimelineEntry[]; total: number }>('/timeline?limit=50');
      timeline.value = data.entries || [];
      timelineTotal.value = data.total || 0;
    }),
    load('ready', async () => {
      const r = await fetchJson<{
        ready: boolean;
        character_ok: boolean;
        okx_ok: boolean;
        deepseek_ok: boolean;
        missing: string[];
      }>('/runtime/ready');
      aiReady.value = !!r.ready;
      aiReadyDetail.value = {
        character_ok: !!r.character_ok,
        okx_ok: !!r.okx_ok,
        deepseek_ok: !!r.deepseek_ok,
        missing: r.missing || [],
      };
    }),
    load('health', async () => {
      systemHealth.value = await fetchJson('/system/health');
    }),
  ]);
  apiOk.value = !errors.value.account && !errors.value.state;
  lastRefresh.value = new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function selectPos(id: string) {
  activePosId.value = id;
}

async function openApiModal() {
  showApiModal.value = true;
  cfgStatus.value = '';
  cfgOk.value = null;
  cfgForm.value = {
    okx_api_key: '',
    okx_secret_key: '',
    okx_passphrase: '',
    deepseek_api_key: '',
    okx_demo: false,
  };
  try {
    const cfg = await fetchJson<{
      okx_api_key: string;
      okx_secret_key: string;
      okx_passphrase: string;
      deepseek_api_key: string;
      okx_demo: boolean;
      note?: string;
    }>('/exchange/config');
    cfgMasked.value = {
      okx_api_key: cfg.okx_api_key,
      okx_secret_key: cfg.okx_secret_key,
      okx_passphrase: cfg.okx_passphrase,
      deepseek_api_key: cfg.deepseek_api_key,
    };
    cfgForm.value.okx_demo = !!cfg.okx_demo;
    cfgStatus.value = cfg.note || '';
  } catch (e) {
    cfgStatus.value = e instanceof Error ? e.message : '加载失败';
    cfgOk.value = false;
  }
}

async function testExchange() {
  cfgStatus.value = '测试中…';
  cfgOk.value = null;
  try {
    const r = await postJson<{ ok: boolean; message?: string }>('/exchange/test', {});
    cfgStatus.value = r.ok ? '连接成功' : `失败: ${r.message || ''}`;
    cfgOk.value = !!r.ok;
    await refreshAll();
  } catch (e) {
    cfgStatus.value = e instanceof Error ? e.message : '测试失败';
    cfgOk.value = false;
  }
}

async function saveExchange() {
  const body: Record<string, unknown> = { okx_demo: cfgForm.value.okx_demo };
  if (cfgForm.value.okx_api_key.trim()) body.okx_api_key = cfgForm.value.okx_api_key.trim();
  if (cfgForm.value.okx_secret_key.trim()) body.okx_secret_key = cfgForm.value.okx_secret_key.trim();
  if (cfgForm.value.okx_passphrase.trim()) body.okx_passphrase = cfgForm.value.okx_passphrase.trim();
  if (cfgForm.value.deepseek_api_key.trim()) body.deepseek_api_key = cfgForm.value.deepseek_api_key.trim();
  cfgStatus.value = '保存中…';
  try {
    const cfg = await postJson<{ okx_api_key: string }>('/exchange/config', body);
    cfgStatus.value = `已保存（需重启服务）。脱敏: ${cfg.okx_api_key || ''}`;
    cfgOk.value = true;
    await postJson('/runtime/ready/refresh', {});
    await refreshAll();
  } catch (e) {
    cfgStatus.value = e instanceof Error ? e.message : '保存失败';
    cfgOk.value = false;
  }
}

async function openCharModal() {
  showCharModal.value = true;
  charStatus.value = '';
  try {
    charList.value = await fetchJson('/character/list');
  } catch (e) {
    charStatus.value = e instanceof Error ? e.message : '加载失败';
  }
}

async function openChatModal() {
  showChatModal.value = true;
  try {
    const data = await fetchJson<{ messages: { role: string; content: string; impact_applied?: Record<string, number> }[] }>(
      '/conversation/history?limit=40',
    );
    chatMessages.value = data.messages || [];
  } catch {
    chatMessages.value = [];
  }
  scrollChatToBottom();
}

async function sendChat() {
  const text = chatInput.value.trim();
  if (!text || chatBusy.value) return;
  chatBusy.value = true;
  chatInput.value = '';
  chatMessages.value.push({ role: 'user', content: text });
  try {
    const resp = await postJson<{
      reply: string;
      silence: boolean;
      impact_applied?: Record<string, number>;
      mood_label?: string;
      llm_backend?: string;
    }>('/conversation/send', { message: text });
    if (resp.llm_backend === 'mock') {
      chatStatus.value = '占位回复（未走 DeepSeek）· 请配置并保存 API Key';
    } else if (resp.mood_label) {
      chatStatus.value = resp.llm_backend === 'deepseek' ? `${resp.mood_label} · DeepSeek` : resp.mood_label;
    }
    if (resp.silence) {
      chatMessages.value.push({ role: 'system', content: '张明没有回复' });
    } else {
      chatMessages.value.push({
        role: 'zhangming',
        content: resp.reply || '',
        impact_applied: resp.impact_applied,
      });
    }
  } catch (e) {
    chatMessages.value.push({
      role: 'system',
      content: e instanceof Error ? e.message : '发送失败',
    });
  } finally {
    chatBusy.value = false;
  }
}

async function exportCharacter() {
  try {
    const list = charList.value || (await fetchJson<{ active: string; characters: unknown[] }>('/character/list'));
    if (!list.active || !(list.characters || []).length) {
      charStatus.value = '暂无角色可导出，请先导入';
      return;
    }
    const cid = list.active;
    const resp = await fetch(`${API_BASE}/character/export?character_id=${encodeURIComponent(cid)}`, {
      headers: { ...ownerHeaders() },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${cid}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    charStatus.value = `已导出 ${cid}.json`;
  } catch (e) {
    charStatus.value = e instanceof Error ? e.message : '导出失败';
  }
}

async function importCharacter(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    if (!ownerKey()) {
      charStatus.value = '请先登录后再导入角色（角色跟随账号）';
      return;
    }
    const text = await file.text();
    const card = JSON.parse(text);
    // 每人仅保留一个角色：导入即覆盖
    await postJson('/character/import', { card, force: true });
    charStatus.value = '导入成功（已替换为当前唯一角色）';
    charList.value = await fetchJson('/character/list');
    await refreshAll();
  } catch (e) {
    charStatus.value = e instanceof Error ? e.message : '导入失败';
  }
  input.value = '';
}

async function runKillSwitch() {
  if (!window.confirm('确认一键平仓？将市价平掉 OKX 全部持仓并暂停新开仓。')) return;
  killBusy.value = true;
  try {
    const r = await postJson<{ ok: boolean; closed: unknown[]; errors: string[] }>('/safety/kill-switch', {});
    alert(r.ok ? `平仓完成 ${(r.closed || []).length} 笔` : `部分失败: ${(r.errors || []).join('; ')}`);
    await refreshAll();
  } catch (e) {
    alert(e instanceof Error ? e.message : 'Kill Switch 失败');
  } finally {
    killBusy.value = false;
  }
}

function tlTag(type: string) {
  if (type === 'psych') return '💬 心理活动';
  if (type === 'body') return '🏃 身体活动';
  return '📊 交易行为';
}

function tlText(e: TimelineEntry) {
  if (e.type === 'trade') {
    const parts = [e.decision, e.symbol].filter(Boolean).join(' ');
    const extra = e.narrative_thought ? ` · ${e.narrative_thought}` : '';
    return `${parts}${extra}`;
  }
  return e.text || '';
}

onMounted(() => {
  void refreshAll();
  timer = window.setInterval(() => void refreshAll(), 5000);
  void pollTrauma();
  window.setInterval(() => void pollTrauma(), 5000);
});

onUnmounted(() => {
  if (timer) window.clearInterval(timer);
  if (traumaTimer) window.clearTimeout(traumaTimer);
});
</script>

<template>
  <div class="ai-page">
    <div v-if="traumaBanner" class="trauma-banner">{{ traumaBanner }}</div>
    <div class="container">
      <!-- Header -->
      <div class="header">
        <div class="header-left">
          <span class="logo">🐋 AI Trader</span>
          <span class="version">v0.5 · 心理与行为</span>
          <div class="header-actions inline">
            <button type="button" class="hdr-btn" @click="openApiModal">🔑 API</button>
            <button type="button" class="hdr-btn" @click="openCharModal">👤 角色</button>
          </div>
        </div>
        <div class="header-right">
          <div class="header-actions">
            <button type="button" class="hdr-btn" @click="openChatModal">💬 对话</button>
            <button type="button" class="hdr-btn danger" :disabled="killBusy" @click="runKillSwitch">
              ⛔ 平仓
            </button>
          </div>
          <div class="status-item">
            <span class="dot" :class="apiOk ? 'green' : 'yellow'" />
            <span class="label">API</span>
            <span class="value">{{ apiOk ? 'OK' : '等待' }}</span>
          </div>
          <div class="health-cluster" @click="showHealthDetail = true" title="点击查看系统健康详情">
            <div class="health-pill">
              <span class="dot" :class="systemHealth?.key_ready ? 'green' : 'red'" />
              <span class="label">🔑</span>
            </div>
            <div class="health-pill">
              <span class="dot" :class="systemHealth?.scheduler_running ? 'green' : 'red'" />
              <span class="label">⚙️</span>
            </div>
            <div class="health-pill">
              <span
                class="dot"
                :class="
                  systemHealth?.narrator_mode === 'real'
                    ? 'green'
                    : systemHealth?.narrator_mode === 'mock'
                      ? 'yellow'
                      : 'red'
                "
              />
              <span class="label">🎭</span>
              <span class="mode">{{
                systemHealth?.narrator_mode === 'real'
                  ? 'REAL'
                  : systemHealth?.narrator_mode === 'mock'
                    ? 'MOCK'
                    : 'OFF'
              }}</span>
            </div>
          </div>
          <div class="status-item">
            <span class="label">刷新</span>
            <span class="value">{{ lastRefresh || '—' }}</span>
          </div>
        </div>
      </div>

      <div v-if="showHealthDetail" class="modal-backdrop" @click.self="showHealthDetail = false">
        <div class="modal">
          <div class="modal-head">
            <h3>系统健康</h3>
            <button type="button" class="modal-x" @click="showHealthDetail = false">×</button>
          </div>
          <div class="health-detail">
            <div>🔑 DeepSeek Key：{{ systemHealth?.key_ready ? '已配置' : '缺失' }}</div>
            <div>OKX Key：{{ systemHealth?.details?.okx_key_present ? '已配置' : '缺失' }}</div>
            <div>⚙️ 调度器：{{ systemHealth?.scheduler_running ? '运行中' : '未启动' }}</div>
            <div>PID：{{ systemHealth?.details?.scheduler_pid ?? '—' }}</div>
            <div>启动：{{ systemHealth?.details?.scheduler_started_at || '—' }}</div>
            <div>心跳：{{ systemHealth?.last_scheduler_heartbeat || '—' }}</div>
            <div>🎭 叙事：{{ systemHealth?.narrator_mode || '—' }}</div>
            <div>今日 LLM 调用：{{ systemHealth?.details?.llm_calls_today ?? 0 }}</div>
            <div class="mono">DB：{{ systemHealth?.db_path || '—' }}</div>
            <div>DB 可写：{{ systemHealth?.db_writable ? '是' : '否' }}</div>
          </div>
          <div class="modal-actions">
            <button type="button" class="modal-btn" @click="showHealthDetail = false">关闭</button>
          </div>
        </div>
      </div>

      <!-- Top row -->
      <div class="top-row">
        <div class="panel">
          <div class="panel-title">
            账户
            <span class="badge">{{ account?.source === 'okx' ? 'OKX 实盘' : '模拟盘' }}</span>
          </div>
          <div v-if="account" class="account-row">
            <div class="account-item">
              <div class="k">净值</div>
              <div class="v">{{ fmtMoney(account.equity) }}</div>
              <div class="s">可用 {{ fmtMoney(account.available) }}</div>
            </div>
            <div class="account-item">
              <div class="k">今日盈亏</div>
              <div class="v" :class="account.today_pnl >= 0 ? 'green' : 'red'">
                {{ account.today_pnl >= 0 ? '+' : '' }}{{ fmtMoney(account.today_pnl) }}
              </div>
              <div class="s">{{ pctSign(account.today_pnl_pct) }}{{ fmt(account.today_pnl_pct) }}%</div>
            </div>
            <div class="account-item">
              <div class="k">持仓</div>
              <div class="v">{{ account.position_count }}</div>
              <div class="s">同步 {{ shortTime(account.last_sync) }}</div>
            </div>
            <div class="account-item">
              <div class="k">风险敞口</div>
              <div
                class="v"
                :class="
                  account.risk_exposure_pct > account.risk_cap_pct
                    ? 'red'
                    : account.risk_exposure_pct > account.risk_cap_pct * 0.7
                      ? 'yellow'
                      : 'green'
                "
              >
                {{ fmt(account.risk_exposure_pct * 100) }}%
              </div>
              <div class="s">上限 {{ fmt(account.risk_cap_pct * 100) }}%</div>
            </div>
          </div>
          <div v-else class="empty">{{ errors.account || '加载账户…' }}</div>

          <div v-if="state" class="state-strip">
            <div class="state-strip-item">
              <div class="k">心情</div>
              <div class="v" :style="{ color: '#d29922' }">{{ state.mood_label }}</div>
              <div class="bar"><div class="fill yellow" :style="{ width: `${Math.round(state.stress * 100)}%` }" /></div>
            </div>
            <div class="state-strip-item">
              <div class="k">信心</div>
              <div class="v" :style="{ color: '#58a6ff' }">{{ fmt(confidence) }}</div>
              <div class="bar"><div class="fill blue" :style="{ width: `${Math.round(confidence * 100)}%` }" /></div>
            </div>
            <div class="state-strip-item">
              <div class="k">风险偏好</div>
              <div class="v" :style="{ color: '#f85149' }">{{ fmt(state.risk_appetite) }}</div>
              <div class="bar">
                <div class="fill" :class="barTone(state.risk_appetite)" :style="{ width: `${Math.round(state.risk_appetite * 100)}%` }" />
              </div>
            </div>
            <div class="state-strip-item">
              <div class="k">耐心</div>
              <div class="v" :style="{ color: '#d29922' }">{{ fmt(state.patience) }}</div>
              <div class="bar">
                <div class="fill yellow" :style="{ width: `${Math.round(state.patience * 100)}%` }" />
              </div>
            </div>
            <div class="state-strip-item">
              <div class="k">专注度</div>
              <div class="v" :style="{ color: '#2da44e' }">{{ fmt(state.focus) }}</div>
              <div class="bar"><div class="fill green" :style="{ width: `${Math.round(state.focus * 100)}%` }" /></div>
            </div>
            <div class="state-strip-item">
              <div class="k">睡眠债</div>
              <div class="v" :style="{ color: '#bc8cff' }">{{ fmt(state.sleep_debt, 1) }}h</div>
              <div class="bar">
                <div class="fill purple" :style="{ width: `${Math.min(100, Math.round((state.sleep_debt / 8) * 100))}%` }" />
              </div>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-title">
            AI 性格
            <span class="badge">{{ hasCharacter ? (state?.mode_label || '30天画像') : '--' }}</span>
          </div>

          <template v-if="hasCharacter && character">
            <div class="persona-header">
              <div class="persona-avatar">👨‍💻</div>
              <div class="persona-info">
                <div class="name">{{ character.name }} · {{ character.age }}岁</div>
                <div class="meta">{{ character.occupation }} · {{ character.location }}</div>
                <div class="tags">
                  <span v-for="t in character.tags" :key="t" class="persona-tag"># {{ t }}</span>
                </div>
              </div>
            </div>

            <div class="traits-list">
              <div v-for="t in character.traits" :key="t.name" class="trait-item">
                <span class="name">{{ t.name }}</span>
                <div class="bar-track">
                  <div
                    class="bar-fill"
                    :style="{ width: `${Math.round(t.value * 100)}%`, background: traitColor(t.name) }"
                  />
                </div>
                <span class="change" :class="changeClass(t.change_7d)">{{ changeText(t.change_7d) }}</span>
              </div>
            </div>

            <div class="emotion-arc">
              <span class="arc-label">最近情绪弧线</span>
              {{ character.emotion_arc || '--' }}
            </div>

            <div class="recent-events">
              <span class="evt-label">最近触发的事件</span>
              <div v-for="(e, i) in character.recent_events" :key="i" class="evt-item">
                <span class="time">{{ e.time }}</span>
                <span class="icon">{{ e.icon }}</span>
                <span class="text">{{ e.text }}</span>
              </div>
              <div v-if="!character.recent_events.length" class="empty">暂无事件</div>
            </div>
          </template>

          <template v-else-if="!errors.character">
            <div class="persona-header">
              <div class="persona-avatar empty-avatar">--</div>
              <div class="persona-info">
                <div class="name">--</div>
                <div class="meta">--</div>
                <div class="tags"><span class="persona-tag">--</span></div>
              </div>
            </div>
            <div class="traits-list">
              <div v-for="label in EMPTY_TRAIT_LABELS" :key="label" class="trait-item">
                <span class="name">{{ label }}</span>
                <div class="bar-track" />
                <span class="change flat">--</span>
              </div>
            </div>
            <div class="emotion-arc">
              <span class="arc-label">最近情绪弧线</span>
              --
            </div>
            <div class="recent-events">
              <span class="evt-label">最近触发的事件</span>
              <div class="empty">--</div>
            </div>
          </template>
          <div v-else class="empty">{{ errors.character }}</div>
        </div>
      </div>

      <!-- Positions -->
      <div class="positions-row">
        <div class="panel module-h">
          <div class="panel-title">
            当前持仓
            <span class="badge">{{ positions?.current.length || 0 }} 仓</span>
          </div>

          <div class="panel-body-scroll">
          <div v-if="positions?.current.length" class="position-summary">
            <div class="summary-item">
              <span class="k">总保证金</span>
              <span class="v">{{ fmtMoney(positions.summary.total_margin) }}</span>
            </div>
            <div class="summary-item">
              <span class="k">总浮盈</span>
              <span class="v" :class="positions.summary.total_pnl >= 0 ? 'green' : 'red'">
                {{ positions.summary.total_pnl >= 0 ? '+' : '' }}{{ fmtMoney(positions.summary.total_pnl) }}
              </span>
            </div>
            <div class="summary-item">
              <span class="k">总风险</span>
              <span class="v">{{ fmt(positions.summary.total_risk_pct * 100) }}%</span>
            </div>
          </div>

          <div v-if="positions?.current.length" class="position-tabs">
            <button
              v-for="p in positions.current"
              :key="p.position_id"
              type="button"
              class="position-tab"
              :class="{ active: activePosId === p.position_id }"
              @click="selectPos(p.position_id)"
            >
              <span class="side-dot" :class="sideClass(p.side)" />
              <span>{{ String(p.symbol).split('-')[0] }}</span>
              <span class="pnl-mini" :class="p.pnl >= 0 ? 'pos' : 'neg'">
                {{ p.pnl >= 0 ? '+' : '' }}${{ Math.abs(p.pnl).toFixed(2) }}
              </span>
            </button>
          </div>

          <div class="position-detail">
            <div v-if="!activePos" class="position-empty">{{ errors.positions || '暂无持仓' }}</div>
            <div v-else class="position-card">
              <div class="position-header">
                <span class="symbol">{{ activePos.symbol }}</span>
                <span class="direction" :class="sideClass(activePos.side)">
                  {{ sideLabel(activePos.side) }} · {{ fmt(activePos.leverage, 0) }}x
                </span>
              </div>
              <div class="position-grid">
                <div>
                  <span class="k">入场</span>
                  <span class="v">{{ Number(activePos.entry_price).toLocaleString() }}</span>
                </div>
                <div>
                  <span class="k">当前</span>
                  <span class="v">{{ Number(activePos.current_price).toLocaleString() }}</span>
                </div>
                <div>
                  <span class="k">保证金</span>
                  <span class="v">{{ fmtMoney(activePos.margin) }}</span>
                </div>
                <div>
                  <span class="k">止损</span>
                  <span class="v">{{ activePos.stop_loss != null ? Number(activePos.stop_loss).toLocaleString() : '—' }}</span>
                </div>
                <div>
                  <span class="k">止盈</span>
                  <span class="v">{{ activePos.take_profit != null ? Number(activePos.take_profit).toLocaleString() : '—' }}</span>
                </div>
                <div>
                  <span class="k">时长</span>
                  <span class="v">{{ activePos.holding_minutes }}min</span>
                </div>
                <div>
                  <span class="k">浮盈</span>
                  <span class="v" :class="activePos.pnl >= 0 ? 'green' : 'red'">
                    {{ activePos.pnl >= 0 ? '+' : '' }}{{ fmtMoney(activePos.pnl) }}
                  </span>
                </div>
                <div>
                  <span class="k">盈亏%</span>
                  <span class="v" :class="activePos.pnl_pct >= 0 ? 'green' : 'red'">
                    {{ pctSign(activePos.pnl_pct) }}{{ fmt(activePos.pnl_pct) }}%
                  </span>
                </div>
                <div>
                  <span class="k">模式</span>
                  <span class="v">{{ state?.primary_mode || '—' }}</span>
                </div>
              </div>
              <div class="position-mood">
                <span class="icon">💬</span>
                <span>{{ activePos.psychology_mood }}</span>
              </div>
            </div>
          </div>
          </div>
        </div>

        <div class="panel module-h">
          <div class="panel-title">
            历史仓位
            <span class="badge">最近 {{ histPreview.length }} 笔</span>
          </div>
          <div class="history-scroll panel-body-scroll">
            <table class="history-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>方向</th>
                  <th>入场</th>
                  <th>出场</th>
                  <th>盈亏</th>
                  <th>当时的想法</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="!histPreview.length">
                  <td colspan="6" class="empty-cell">{{ errors.positions || '暂无历史仓位' }}</td>
                </tr>
                <tr v-for="h in histPreview" :key="h.position_id">
                  <td class="time-cell">{{ shortTime(h.exit_time || h.entry_time) }}</td>
                  <td :class="sideClass(h.side) === 'long' ? 'side-long' : 'side-short'">
                    {{ sideLabel(h.side) }}
                  </td>
                  <td>{{ Number(h.entry_price).toLocaleString() }}</td>
                  <td>{{ h.exit_price != null ? Number(h.exit_price).toLocaleString() : '—' }}</td>
                  <td :class="h.realized_pnl >= 0 ? 'pnl-pos' : 'pnl-neg'">
                    {{ h.realized_pnl >= 0 ? '+' : '' }}{{ fmtMoney(h.realized_pnl) }}
                  </td>
                  <td class="reason" :title="h.narrative_reason">{{ h.narrative_reason || h.exit_reason || '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- Timeline -->
      <div class="timeline-panel module-h">
        <div class="timeline-header">
          <div>
            <div class="title">心理与行为时间线</div>
            <div class="subtitle">共 {{ timelineTotal }} 条记录 · 展示最近 {{ timeline.length }} 条</div>
          </div>
          <span class="badge live">实时</span>
        </div>
        <div class="timeline-body">
          <div v-if="!timeline.length" class="empty pad">{{ errors.timeline || '暂无时间线' }}</div>
          <div v-for="(e, i) in timeline" :key="i" class="tl-entry" :class="e.type">
            <div class="tl-time">{{ clock(e.timestamp) }}</div>
            <div class="tl-content">
              <div class="tl-tag">
                {{ tlTag(e.type) }}
                <span v-if="e.mood_label || e.mood" class="mood-tag" :class="moodClass(e.mood)">
                  {{ e.mood_label || e.mood }}
                </span>
              </div>
              <div class="tl-text">{{ tlText(e) }}</div>
              <div v-if="e.type === 'trade'" class="tl-meta">
                <span v-if="e.signal_score != null" class="item"><span class="k">score</span><span class="v">{{ fmt(e.signal_score) }}</span></span>
                <span v-if="e.threshold != null" class="item"><span class="k">thr</span><span class="v">{{ fmt(e.threshold) }}</span></span>
                <span v-if="e.mode" class="item"><span class="k">mode</span><span class="v">{{ e.mode }}</span></span>
              </div>
              <div v-else-if="e.type === 'body'" class="tl-meta">
                <span v-if="e.location" class="item"><span class="k">location</span><span class="v">{{ e.location }}</span></span>
                <span v-if="e.activity" class="item"><span class="k">activity</span><span class="v">{{ e.activity }}</span></span>
              </div>
              <div v-else class="tl-meta">
                <span v-if="e.mode" class="item"><span class="k">mode</span><span class="v">{{ e.mode }}</span></span>
                <span v-if="e.prompt_version" class="item"><span class="k">prompt</span><span class="v">{{ e.prompt_version }}</span></span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- API config modal -->
    <div v-if="showApiModal" class="modal-backdrop" @click.self="showApiModal = false">
      <div class="modal">
        <div class="modal-head">
          <h3>API 配置</h3>
          <button type="button" class="modal-x" @click="showApiModal = false">×</button>
        </div>
        <p class="modal-hint">密钥只写入后端 .env，页面仅显示脱敏值。</p>
        <label>OKX API Key<input v-model="cfgForm.okx_api_key" type="password" :placeholder="cfgMasked.okx_api_key || '未配置'" /></label>
        <label>OKX Secret<input v-model="cfgForm.okx_secret_key" type="password" :placeholder="cfgMasked.okx_secret_key || '未配置'" /></label>
        <label>Passphrase<input v-model="cfgForm.okx_passphrase" type="password" :placeholder="cfgMasked.okx_passphrase || '未配置'" /></label>
        <label>DeepSeek Key<input v-model="cfgForm.deepseek_api_key" type="password" :placeholder="cfgMasked.deepseek_api_key || '未配置'" /></label>
        <label class="check"><input v-model="cfgForm.okx_demo" type="checkbox" /> Demo 模拟盘</label>
        <div class="modal-status" :class="{ ok: cfgOk === true, err: cfgOk === false }">{{ cfgStatus }}</div>
        <div class="modal-actions">
          <button type="button" @click="testExchange">测试连接</button>
          <button type="button" class="primary" @click="saveExchange">保存</button>
        </div>
      </div>
    </div>

    <!-- Character modal -->
    <div v-if="showCharModal" class="modal-backdrop" @click.self="showCharModal = false">
      <div class="modal wide">
        <div class="modal-head">
          <h3>角色管理</h3>
          <button type="button" class="modal-x" @click="showCharModal = false">×</button>
        </div>
        <div v-if="(charList?.characters || []).length" class="char-card">
          <div><strong>{{ character?.name || '--' }}</strong> <span class="muted">#{{ charList?.active }}</span></div>
          <div class="muted">{{ dash(character?.occupation) }} · {{ dash(character?.location) }} · {{ character?.age != null ? character.age + '岁' : '--' }}</div>
          <div class="tags">
            <span v-for="t in character?.tags || []" :key="t" class="tag">{{ t }}</span>
          </div>
        </div>
        <ul v-if="(charList?.characters || []).length" class="char-list">
          <li v-for="c in charList?.characters || []" :key="c.id" :class="{ active: c.id === charList?.active }">
            <span>{{ c.name }} ({{ c.id }})</span>
            <span class="muted">{{ (c.tags || []).join(' · ') }}</span>
          </li>
        </ul>
        <div v-else class="char-empty muted">暂无角色，请先导入角色卡</div>
        <div class="modal-status">{{ charStatus }}</div>
        <div class="modal-actions">
          <button type="button" class="modal-btn" @click="exportCharacter">导出当前角色</button>
          <label class="modal-btn file-btn">
            导入角色文件
            <input type="file" accept="application/json,.json" hidden @change="importCharacter" />
          </label>
        </div>
      </div>
    </div>

    <!-- Chat modal -->
    <div v-if="showChatModal" class="chat-dock">
      <div class="chat-head">
        <div class="chat-title">
          <span class="chat-avatar">张</span>
          <div>
            <div class="chat-name">张明</div>
            <div class="chat-sub">{{ chatStatus }}</div>
          </div>
        </div>
        <button type="button" class="modal-x" @click="showChatModal = false">×</button>
      </div>
      <div ref="chatBodyRef" class="chat-body">
        <div v-for="(m, i) in chatMessages" :key="i" :class="['chat-bubble', m.role]">
          <template v-if="m.role === 'system'">{{ m.content }}</template>
          <template v-else>
            <div>{{ m.content }}</div>
            <div v-if="m.impact_applied && Object.keys(m.impact_applied).length" class="chat-impact">
              （张明的状态发生了细微变化）
            </div>
          </template>
        </div>
      </div>
      <div class="chat-foot">
        <input v-model="chatInput" type="text" placeholder="说点什么..." @keydown.enter="sendChat" />
        <button type="button" :disabled="chatBusy" @click="sendChat">发送</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-page {
  flex: 1;
  min-width: 0;
  min-height: 0;
  height: 100%;
  width: 100%;
  overflow: auto;
  background: #0a0e17;
  color: #e6edf3;
  font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 16px;
  line-height: 1.5;
}
.trauma-banner {
  background: #3d2e00;
  color: #f0d78c;
  padding: 12px 20px;
  font-size: 14px;
  border-bottom: 1px solid #6b5420;
  flex-shrink: 0;
}
.container {
  width: 100%;
  max-width: none;
  min-height: 100%;
  margin: 0;
  padding: 22px 28px 32px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 14px;
  margin-bottom: 18px;
  padding-bottom: 16px;
  border-bottom: 1px solid #1c2333;
  flex-shrink: 0;
}
.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}
.logo {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: 0.01em;
}
.version {
  font-size: 13px;
  color: #8b949e;
  background: #161b22;
  padding: 4px 12px;
  border-radius: 20px;
  border: 1px solid #21262d;
}
.header-right {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
}
.header-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.header-actions.inline {
  margin-left: 4px;
  flex-wrap: nowrap;
}
.hdr-btn {
  border: 1px solid #30363d;
  background: #161b22;
  color: #e6edf3;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
}
.hdr-btn.danger {
  background: #8b1e1e;
  border-color: #a52a2a;
}
.hdr-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
  padding: 20px;
}
.modal {
  width: min(440px, 100%);
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 10px;
  padding: 16px 18px 18px;
}
.modal.wide {
  width: min(560px, 100%);
}
.modal-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.modal-head h3 {
  margin: 0;
  font-size: 18px;
}
.modal-x {
  border: none;
  background: transparent;
  color: #8b949e;
  font-size: 22px;
  cursor: pointer;
}
.modal-hint {
  color: #8b949e;
  font-size: 13px;
  margin: 0 0 10px;
}
.modal label {
  display: grid;
  gap: 4px;
  margin: 10px 0;
  font-size: 13px;
  color: #c9d1d9;
}
.modal label.file-btn {
  display: inline-flex !important;
  margin: 0 !important;
  gap: 0;
  width: auto;
  color: #e6edf3;
}
.modal label input[type='password'],
.modal label input[type='text'] {
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid #30363d;
  background: #161b22;
  color: #e6edf3;
  font: inherit;
}
.modal label.check {
  display: flex;
  align-items: center;
  gap: 8px;
}
.modal-actions {
  display: flex;
  flex-direction: row;
  flex-wrap: nowrap;
  gap: 8px;
  justify-content: flex-end;
  align-items: center;
  margin-top: 14px;
}
.modal-actions button,
.modal-actions .modal-btn,
.modal-actions label.file-btn {
  border: 1px solid #30363d;
  background: #21262d;
  color: #e6edf3;
  padding: 0 14px;
  border-radius: 6px;
  font-size: 13px;
  font-family: inherit;
  font-weight: 500;
  cursor: pointer;
  display: inline-flex !important;
  align-items: center;
  justify-content: center;
  line-height: 1.2;
  box-sizing: border-box;
  margin: 0 !important;
  min-width: 128px;
  width: auto;
  height: 34px;
  min-height: 34px;
  gap: 0;
  flex: 0 0 auto;
  vertical-align: middle;
}
.modal-actions label.file-btn {
  position: relative;
}
.modal-actions .primary {
  background: #238636;
  border-color: #2ea043;
}
.modal-status {
  min-height: 18px;
  font-size: 13px;
  color: #8b949e;
  margin-top: 8px;
}
.modal-status.ok {
  color: #3fb950;
}
.modal-status.err {
  color: #f85149;
}
.char-card {
  border: 1px solid #30363d;
  border-radius: 8px;
  padding: 12px;
  background: #161b22;
  margin-bottom: 12px;
}
.char-empty {
  padding: 16px 4px 8px;
  font-size: 13px;
}
.char-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 220px;
  overflow: auto;
}
.char-list li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 0;
  border-top: 1px solid #21262d;
  font-size: 13px;
}
.char-list li.active {
  color: #58a6ff;
  font-weight: 600;
}
.file-btn {
  display: inline-flex;
}
.muted {
  color: #8b949e;
}
.status-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}
.status-item .label {
  color: #8b949e;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}
.status-item .value {
  font-weight: 600;
  font-size: 14px;
}
.health-cluster {
  display: flex;
  gap: 6px;
  align-items: center;
  cursor: pointer;
}
.health-pill {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  background: #161b22;
  border: 1px solid #21262d;
  border-radius: 20px;
  font-size: 12px;
  transition: 0.15s;
}
.health-pill:hover {
  background: #1c2128;
}
.health-pill .mode {
  font-size: 10px;
  color: #8b949e;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.health-detail {
  display: grid;
  gap: 8px;
  font-size: 13px;
  color: #c9d1d9;
  padding: 4px 0 8px;
}
.health-detail .mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  word-break: break-all;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
}
.dot.green {
  background: #2da44e;
  box-shadow: 0 0 8px #2da44e66;
}
.dot.yellow {
  background: #d29922;
  box-shadow: 0 0 8px #d2992266;
}
.dot.red {
  background: #f85149;
  box-shadow: 0 0 8px #f8514966;
}

.top-row,
.positions-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
  margin-bottom: 18px;
  flex-shrink: 0;
}
.panel {
  background: #111827;
  border: 1px solid #1c2333;
  border-radius: 12px;
  padding: 18px 20px;
}
.module-h {
  height: 460px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-sizing: border-box;
}
.panel-body-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.panel-title {
  font-size: 13px;
  font-weight: 600;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 14px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0;
}
.badge {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 20px;
  background: #161b22;
  border: 1px solid #21262d;
  color: #8b949e;
  font-weight: 400;
  text-transform: none;
}
.badge.live {
  align-self: center;
}

.account-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: 16px;
}
.account-item .k {
  font-size: 12px;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.35px;
  margin-bottom: 4px;
}
.account-item .v {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.3px;
}
.account-item .s {
  font-size: 13px;
  color: #484f58;
  margin-top: 3px;
}
.v.green { color: #2da44e; }
.v.red { color: #f85149; }
.v.yellow { color: #d29922; }

.state-strip {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 12px;
  padding-top: 16px;
  border-top: 1px solid #1c2333;
}
.state-strip-item { text-align: center; }
.state-strip-item .k {
  font-size: 11px;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.35px;
  margin-bottom: 4px;
}
.state-strip-item .v {
  font-size: 16px;
  font-weight: 700;
}
.state-strip-item .bar {
  margin-top: 6px;
  height: 3px;
  background: #161b22;
  border-radius: 10px;
  overflow: hidden;
}
.state-strip-item .bar .fill {
  height: 100%;
  border-radius: 10px;
  transition: width 0.6s;
}
.fill.green { background: #2da44e; }
.fill.yellow { background: #d29922; }
.fill.red { background: #f85149; }
.fill.blue { background: #58a6ff; }
.fill.purple { background: #bc8cff; }

.persona-header {
  display: flex;
  align-items: center;
  gap: 14px;
  padding-bottom: 14px;
  border-bottom: 1px solid #1c2333;
  margin-bottom: 14px;
}
.persona-avatar {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: linear-gradient(135deg, #1f6feb, #bc8cff);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  flex-shrink: 0;
}
.persona-avatar.empty-avatar {
  background: #161b22;
  border: 1px solid #30363d;
  color: #8b949e;
  font-size: 14px;
  font-weight: 600;
}
.persona-info { flex: 1; }
.persona-info .name {
  font-size: 18px;
  font-weight: 700;
  margin-bottom: 4px;
}
.persona-info .meta {
  font-size: 13px;
  color: #8b949e;
}
.persona-info .tags {
  display: flex;
  gap: 6px;
  margin-top: 6px;
  flex-wrap: wrap;
}
.persona-tag {
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 20px;
  background: #161b22;
  border: 1px solid #21262d;
  color: #8b949e;
}

.traits-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 14px;
}
.trait-item {
  display: grid;
  grid-template-columns: 72px 1fr 110px;
  align-items: center;
  gap: 12px;
  font-size: 14px;
}
.trait-item .name {
  color: #8b949e;
  font-size: 13px;
}
.trait-item .bar-track {
  height: 7px;
  background: #161b22;
  border-radius: 10px;
  overflow: hidden;
}
.trait-item .bar-fill {
  height: 100%;
  border-radius: 10px;
  transition: width 0.6s;
}
.trait-item .change {
  font-size: 12px;
  text-align: right;
  font-family: 'Fira Code', ui-monospace, monospace;
}
.change.up { color: #2da44e; }
.change.down { color: #f85149; }
.change.flat { color: #484f58; }

.emotion-arc {
  padding: 14px 16px;
  background: #0a0e17;
  border: 1px solid #21262d;
  border-radius: 8px;
  margin-bottom: 14px;
  font-size: 15px;
  font-style: italic;
  color: #b8c4d4;
  line-height: 1.7;
  position: relative;
}
.emotion-arc::before {
  content: '"';
  position: absolute;
  top: -2px;
  left: 10px;
  font-size: 28px;
  color: #30363d;
  font-family: Georgia, serif;
}
.emotion-arc .arc-label {
  font-size: 11px;
  font-style: normal;
  text-transform: uppercase;
  letter-spacing: 0.45px;
  color: #484f58;
  display: block;
  margin-bottom: 6px;
  padding-left: 14px;
}

.recent-events {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid #1c2333;
}
.recent-events .evt-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.45px;
  color: #484f58;
  margin-bottom: 2px;
}
.evt-item {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
  color: #8b949e;
}
.evt-item .time {
  color: #484f58;
  font-family: 'Fira Code', ui-monospace, monospace;
  font-size: 12px;
  min-width: 64px;
}
.evt-item .icon { font-size: 14px; }
.evt-item .text { color: #b8c4d4; }

.position-summary {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  padding: 14px 16px;
  background: #0a0e17;
  border: 1px solid #21262d;
  border-radius: 8px;
  margin-bottom: 12px;
}
.position-summary .summary-item { text-align: center; }
.position-summary .k {
  display: block;
  font-size: 12px;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.35px;
  margin-bottom: 4px;
}
.position-summary .v {
  font-size: 18px;
  font-weight: 700;
}
.position-summary .v.green { color: #2da44e; }
.position-summary .v.red { color: #f85149; }

.position-tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid #1c2333;
  overflow-x: auto;
}
.position-tab {
  padding: 8px 16px;
  border-radius: 8px;
  background: transparent;
  border: 1px solid transparent;
  color: #8b949e;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: 0.15s;
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: inherit;
}
.position-tab:hover {
  background: #161b22;
  color: #c9d1d9;
}
.position-tab.active {
  background: #1a2332;
  border-color: #1f6feb44;
  color: #e6edf3;
  font-weight: 600;
}
.side-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.side-dot.long { background: #2da44e; }
.side-dot.short { background: #f85149; }
.pnl-mini { font-size: 12px; font-weight: 600; }
.pnl-mini.pos { color: #2da44e; }
.pnl-mini.neg { color: #f85149; }

.position-detail {
  max-height: none;
  min-height: 220px;
  overflow-y: auto;
}
.position-empty,
.empty {
  color: #484f58;
  text-align: center;
  padding: 28px 0;
  font-size: 15px;
}
.empty.pad { padding: 36px 0; }
.empty-cell {
  text-align: center;
  color: #484f58;
  padding: 28px !important;
  font-size: 14px;
}

.position-card {
  background: #0a0e17;
  border: 1px solid #21262d;
  border-radius: 8px;
  padding: 16px 18px;
}
.position-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
  padding-bottom: 12px;
  border-bottom: 1px solid #161b22;
}
.position-header .symbol {
  font-weight: 700;
  font-size: 17px;
}
.direction {
  font-size: 13px;
  font-weight: 600;
  padding: 3px 12px;
  border-radius: 20px;
}
.direction.long { background: #1a3a2a; color: #2da44e; }
.direction.short { background: #3d1a1a; color: #f85149; }
.position-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px 14px;
  font-size: 14px;
}
.position-grid .k {
  color: #8b949e;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.35px;
  display: block;
  margin-bottom: 3px;
}
.position-grid .v {
  font-weight: 600;
  font-size: 16px;
}
.position-mood {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid #161b22;
  font-size: 14px;
  font-style: italic;
  color: #8b949e;
  display: flex;
  align-items: center;
  gap: 8px;
  line-height: 1.5;
}
.position-mood .icon {
  font-style: normal;
  font-size: 16px;
}

.history-scroll {
  flex: 1;
  min-height: 0;
  max-height: none;
  overflow-y: auto;
}
.history-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
.history-table th {
  text-align: left;
  padding: 10px 6px;
  color: #8b949e;
  font-weight: 500;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.35px;
  border-bottom: 1px solid #1c2333;
  position: sticky;
  top: 0;
  background: #111827;
  z-index: 1;
}
.history-table td {
  padding: 12px 6px;
  border-bottom: 1px solid #161b22;
}
.history-table tr:last-child td { border-bottom: none; }
.time-cell { color: #8b949e; font-size: 13px; }
.side-long { color: #2da44e; font-weight: 600; }
.side-short { color: #f85149; font-weight: 600; }
.pnl-pos { color: #2da44e; font-weight: 600; }
.pnl-neg { color: #f85149; font-weight: 600; }
.reason {
  font-size: 13px;
  color: #8b949e;
  font-style: italic;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.timeline-panel {
  background: #111827;
  border: 1px solid #1c2333;
  border-radius: 12px;
  padding: 0;
  overflow: hidden;
  flex: 0 0 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.timeline-panel.module-h {
  height: 460px;
}
.timeline-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 22px;
  border-bottom: 1px solid #1c2333;
  flex-shrink: 0;
}
.timeline-header .title {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.3px;
}
.timeline-header .subtitle {
  font-size: 13px;
  color: #8b949e;
  margin-top: 2px;
}
.timeline-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.tl-entry {
  display: grid;
  grid-template-columns: 96px 1fr;
  border-bottom: 1px solid #161b22;
  min-height: 68px;
}
.tl-entry:last-child { border-bottom: none; }
.tl-time {
  padding: 18px 14px 18px 22px;
  font-family: 'Fira Code', ui-monospace, monospace;
  font-size: 14px;
  color: #484f58;
  border-right: 1px solid #161b22;
  position: relative;
}
.tl-time::after {
  content: '';
  position: absolute;
  right: -5px;
  top: 26px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #21262d;
  border: 2px solid #0a0e17;
}
.tl-entry.psych .tl-time::after {
  background: #bc8cff;
  box-shadow: 0 0 8px #bc8cff66;
}
.tl-entry.body .tl-time::after {
  background: #58a6ff;
  box-shadow: 0 0 8px #58a6ff66;
}
.tl-entry.trade .tl-time::after {
  background: #f0b90b;
  box-shadow: 0 0 8px #f0b90b66;
}
.tl-content {
  padding: 16px 24px 16px 22px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tl-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 2px;
}
.tl-entry.psych .tl-tag { color: #bc8cff; }
.tl-entry.body .tl-tag { color: #58a6ff; }
.tl-entry.trade .tl-tag { color: #f0b90b; }
.tl-text {
  font-size: 16px;
  line-height: 1.65;
}
.tl-entry.psych .tl-text {
  font-style: italic;
  color: #b8c4d4;
}
.tl-entry.body .tl-text { color: #e6edf3; }
.tl-entry.trade .tl-text {
  color: #f0b90b;
  font-weight: 500;
}
.tl-meta {
  display: flex;
  gap: 16px;
  margin-top: 4px;
  font-size: 13px;
  color: #484f58;
  flex-wrap: wrap;
}
.tl-meta .item {
  display: flex;
  align-items: center;
  gap: 5px;
}
.tl-meta .k { color: #484f58; }
.tl-meta .v {
  color: #8b949e;
  font-weight: 500;
}
.mood-tag {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 500;
  margin-left: 6px;
  text-transform: none;
  letter-spacing: 0;
}
.mood-tag.calm { background: #1a3a2a; color: #2da44e; }
.mood-tag.anxious { background: #3d2a0a; color: #d29922; }
.mood-tag.angry { background: #3d1a1a; color: #f85149; }
.mood-tag.tired { background: #2a1a3a; color: #bc8cff; }
.mood-tag.confident { background: #1a2a3a; color: #58a6ff; }

.ai-page :deep(*)::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
.ai-page :deep(*)::-webkit-scrollbar-track { background: transparent; }
.ai-page :deep(*)::-webkit-scrollbar-thumb {
  background: #30363d;
  border-radius: 10px;
}

@media (max-width: 1100px) {
  .container { padding: 16px 18px 24px; }
  .top-row,
  .positions-row { grid-template-columns: 1fr; }
  .account-row { grid-template-columns: repeat(2, 1fr); }
  .state-strip { grid-template-columns: repeat(3, 1fr); }
}
@media (max-width: 600px) {
  .logo { font-size: 22px; }
  .account-item .v { font-size: 20px; }
  .state-strip { grid-template-columns: repeat(2, 1fr); }
  .tl-entry { grid-template-columns: 72px 1fr; }
  .tl-text { font-size: 15px; }
  .position-grid { grid-template-columns: repeat(2, 1fr); }
}

.chat-dock {
  position: fixed;
  right: 20px;
  bottom: 20px;
  width: 400px;
  height: 500px;
  z-index: 60;
  background: #111827;
  border: 1px solid #30363d;
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45);
}
.chat-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 14px;
  border-bottom: 1px solid #30363d;
}
.chat-title { display: flex; gap: 10px; align-items: center; }
.chat-avatar {
  width: 34px; height: 34px; border-radius: 8px;
  background: #3d5a80; display: grid; place-items: center; font-weight: 700;
}
.chat-name { font-weight: 600; }
.chat-sub { font-size: 12px; color: #8b949e; }
.chat-body {
  flex: 1; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px;
  background: #0d1117;
}
.chat-bubble {
  max-width: 80%; padding: 8px 10px; border-radius: 10px; font-size: 14px; line-height: 1.45;
}
.chat-bubble.user { align-self: flex-end; background: #1f6feb; color: #fff; }
.chat-bubble.zhangming { align-self: flex-start; background: #21262d; color: #e6edf3; }
.chat-bubble.system { align-self: center; background: transparent; color: #8b949e; font-size: 12px; }
.chat-impact { font-size: 11px; opacity: 0.75; margin-top: 4px; }
.chat-foot {
  display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid #30363d;
}
.chat-foot input {
  flex: 1; background: #0d1117; border: 1px solid #30363d; color: #e6edf3;
  border-radius: 8px; padding: 8px 10px;
}
.chat-foot button {
  border: 1px solid #30363d; background: #21262d; color: #e6edf3;
  border-radius: 8px; padding: 8px 12px; cursor: pointer;
}
</style>
