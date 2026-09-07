<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  closeCopyPosition,
  deleteCopyTask,
  fetchCopyTradeSnapshot,
  saveCopyTask,
  saveOkxExchangeKeys,
  syncCopyTasks,
  type CopyExchange,
  type CopyPositionDto,
  type CopyRecordDto,
  type CopyTaskDto,
  type ExchangeKeysDto,
} from '@/api';
import { isLoggedIn, authUser } from '@/stores/auth';

const emit = defineEmits<{
  'request-login': [];
}>();

export type CopyTask = CopyTaskDto;
export type FollowedPosition = CopyPositionDto;
export type CopyTradeRecord = CopyRecordDto;

const STORAGE_KEY = 'whale-copytrade-tasks-v1';

const exchangeKeys = ref<ExchangeKeysDto | null>(null);
const keysReady = computed(() => Boolean(exchangeKeys.value?.okx?.ready));
const setupExchange = ref<'okx' | 'binance'>('okx');
const keyForm = ref({
  apiKey: '',
  apiSecret: '',
  apiPassphrase: '',
  simulated: true,
});
const savingKeys = ref(false);
const closingPosId = ref('');

async function onManualClose(p: FollowedPosition) {
  if (!p?.id || closingPosId.value) return;
  try {
    await ElMessageBox.confirm(
      `确认市价平仓 ${p.coin}-USDT ${p.side === 'short' ? '空' : '多'}？\n持仓量 ${p.size || '—'}，将按 reduceOnly 全平。`,
      '手动平仓',
      {
        confirmButtonText: '确认平仓',
        cancelButtonText: '取消',
        type: 'warning',
      },
    );
  } catch {
    return;
  }
  closingPosId.value = p.id;
  try {
    const result = await closeCopyPosition(p.id);
    if (result.snapshot) applySnapshot(result.snapshot);
    else await refreshSnapshot(true);
    ElMessage.success('已提交平仓');
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '平仓失败');
    void refreshSnapshot(true);
  } finally {
    closingPosId.value = '';
  }
}

function loadLocalTasks(): CopyTask[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveLocalTasks(list: CopyTask[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

function normAddr(addr: string) {
  return String(addr || '')
    .trim()
    .toLowerCase();
}

function shortAddr(addr: string) {
  const a = (addr || '').trim();
  if (a.length < 12) return a || '未填地址';
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function formatUsd(n: number, signed = false) {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const body =
    abs >= 1000 ? abs.toLocaleString('en-US', { maximumFractionDigits: 2 }) : abs.toFixed(2);
  if (!signed) return body;
  return `${n >= 0 ? '+' : '-'}${body}`;
}

function formatPct(n: number) {
  if (!Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${(n * 100).toFixed(2)}%`;
}

function formatPx(n: number) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(4);
  return n.toPrecision(4);
}

function formatTime(ts: number) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function kindLabel(kind: CopyTradeRecord['kind'], item?: CopyTradeRecord) {
  if (item?.status === 'fail' || (item?.note && item.note.startsWith('开仓失败'))) {
    return '开仓失败';
  }
  if (item?.note && (item.note.includes('减仓失败') || item.note.includes('平仓失败'))) {
    return item.note.includes('减仓') ? '减仓失败' : '平仓失败';
  }
  if (kind === 'open') return '开单';
  if (kind === 'add') return '加仓';
  if (kind === 'close') {
    if (item?.note && item.note.includes('减仓')) return '减仓';
    return '平仓';
  }
  return '加保证金';
}

const tasks = ref<CopyTask[]>([]);
const selectedId = ref('');
const settingsOpen = ref(false);
const isCreating = ref(false);
const exchangeTab = ref<CopyExchange>('okx');
const saving = ref(false);
const engineHint = ref('');

const selected = computed(() => tasks.value.find((t) => t.id === selectedId.value) || null);
const dialogReady = computed(() => isCreating.value || Boolean(selected.value));

const followedPositions = ref<FollowedPosition[]>([]);
const tradeRecords = ref<CopyTradeRecord[]>([]);

/** 默认展示全部跟随持仓 / 全部跟单记录 */
const visiblePositions = computed(() =>
  followedPositions.value.filter((p) => p.status === 'open'),
);

const visibleRecords = computed(() =>
  [...tradeRecords.value].sort((a, b) => b.at - a.at),
);

const draft = ref({
  name: '',
  whaleAddress: '',
  followCapitalUsd: 1000,
  maxLeverage: 0,
  maxNotionalUsd: 0,
  note: '',
  enabled: true,
});

function resetDraft(exchange: CopyExchange = 'okx') {
  draft.value = {
    name: exchange === 'okx' ? 'OKX 跟单' : '币安跟单',
    whaleAddress: '',
    followCapitalUsd: 1000,
    maxLeverage: 0,
    maxNotionalUsd: 0,
    note: '',
    enabled: exchange === 'okx',
  };
  exchangeTab.value = exchange;
}

function syncDraftFromSelected() {
  const t = selected.value;
  if (!t) {
    resetDraft(exchangeTab.value);
    return;
  }
  draft.value = {
    name: t.name,
    whaleAddress: t.whaleAddress,
    followCapitalUsd: t.followCapitalUsd,
    maxLeverage: t.maxLeverage,
    maxNotionalUsd: t.maxNotionalUsd,
    note: t.note,
    enabled: t.enabled,
  };
  exchangeTab.value = t.exchange;
}

function findDuplicate(address: string, excludeId = '', exchange?: CopyExchange) {
  const key = normAddr(address);
  if (!key) return null;
  return (
    tasks.value.find((t) => {
      if (t.id === excludeId) return false;
      if (normAddr(t.whaleAddress) !== key) return false;
      if (exchange && t.exchange !== exchange) return false;
      return true;
    }) || null
  );
}

function dedupeById<T extends { id?: string }>(list: T[] | undefined | null): T[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of list) {
    const id = String(item?.id || '');
    if (!id) {
      out.push(item);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

function applySnapshot(data: {
  tasks?: CopyTask[];
  positions?: FollowedPosition[];
  records?: CopyTradeRecord[];
  trade?: { configured?: boolean; simulated?: boolean; keyHint?: string };
  exchangeKeys?: ExchangeKeysDto;
  exchangeKeysReady?: boolean;
  userId?: string;
}) {
  // 忽略其他用户的 WS 推送
  const myId = authUser.value?.id;
  if (data.userId && myId && data.userId !== myId) return;

  if (Array.isArray(data.tasks)) {
    tasks.value = dedupeById(data.tasks);
    saveLocalTasks(tasks.value);
  }
  if (Array.isArray(data.positions)) followedPositions.value = dedupeById(data.positions);
  if (Array.isArray(data.records)) tradeRecords.value = dedupeById(data.records);
  if (data.exchangeKeys) exchangeKeys.value = data.exchangeKeys;
  if (data.trade) {
    const ready = data.exchangeKeysReady ?? data.trade.configured;
    engineHint.value = !ready
      ? '未绑定 OKX API'
      : data.trade.simulated
        ? '模拟盘执行中'
        : '实盘执行中';
  }
  if (!selectedId.value && tasks.value[0]) selectedId.value = tasks.value[0].id;
  // 选中项若不在列表中则纠正
  if (selectedId.value && !tasks.value.some((t) => t.id === selectedId.value)) {
    selectedId.value = tasks.value[0]?.id || '';
  }
}

async function refreshSnapshot(silent = true) {
  if (!isLoggedIn.value) {
    tasks.value = [];
    followedPositions.value = [];
    tradeRecords.value = [];
    exchangeKeys.value = null;
    return;
  }
  try {
    const data = await fetchCopyTradeSnapshot();
    applySnapshot(data);
  } catch (err) {
    if (!silent) {
      ElMessage.error(err instanceof Error ? err.message : '跟单数据加载失败');
    }
  }
}

async function submitOkxKeys() {
  if (setupExchange.value === 'binance') {
    ElMessage.info('币安跟单对接中');
    return;
  }
  const apiKey = keyForm.value.apiKey.trim();
  const apiSecret = keyForm.value.apiSecret.trim();
  const apiPassphrase = keyForm.value.apiPassphrase.trim();
  if (!apiKey || !apiSecret || !apiPassphrase) {
    ElMessage.warning('请填写 OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE');
    return;
  }
  if (savingKeys.value) return;
  savingKeys.value = true;
  try {
    const data = await saveOkxExchangeKeys({
      apiKey,
      apiSecret,
      apiPassphrase,
      simulated: keyForm.value.simulated,
      enabled: true,
    });
    exchangeKeys.value = data;
    keyForm.value.apiSecret = '';
    keyForm.value.apiPassphrase = '';
    ElMessage.success('OKX API 已保存，可以开启跟单');
    await refreshSnapshot(true);
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '保存失败');
  } finally {
    savingKeys.value = false;
  }
}

function onBinancePick() {
  ElMessage.info('币安跟单对接中');
  setupExchange.value = 'okx';
}

watch(isLoggedIn, (ok) => {
  if (ok) void refreshSnapshot(true);
  else {
    tasks.value = [];
    followedPositions.value = [];
    tradeRecords.value = [];
    exchangeKeys.value = null;
  }
});

function openSettings(task?: CopyTask) {
  if (task) selectedId.value = task.id;
  if (!selected.value) {
    ElMessage.warning('请先选择或新建跟单任务');
    return;
  }
  isCreating.value = false;
  syncDraftFromSelected();
  settingsOpen.value = true;
}

function addTask(exchange: CopyExchange = 'okx') {
  isCreating.value = true;
  resetDraft(exchange);
  settingsOpen.value = true;
}

function closeSettings() {
  settingsOpen.value = false;
  isCreating.value = false;
}

async function removeSelected() {
  if (isCreating.value) {
    closeSettings();
    return;
  }
  if (!selected.value) return;
  const id = selected.value.id;
  try {
    if (isLoggedIn.value) await deleteCopyTask(id);
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '删除失败');
    return;
  }
  tasks.value = tasks.value.filter((t) => t.id !== id);
  saveLocalTasks(tasks.value);
  selectedId.value = tasks.value[0]?.id || '';
  closeSettings();
  void refreshSnapshot();
}

function validateDraft() {
  const addr = draft.value.whaleAddress.trim();
  const wantEnable = exchangeTab.value === 'okx' && Boolean(draft.value.enabled);
  if (wantEnable && !addr) {
    ElMessage.warning('开启跟单前请填写巨鲸地址');
    return null;
  }
  const capital = Number(draft.value.followCapitalUsd);
  if (!Number.isFinite(capital) || capital <= 0) {
    ElMessage.warning('跟单本金需大于 0');
    return null;
  }
  const excludeId = isCreating.value ? '' : selected.value?.id || '';
  const dup = findDuplicate(addr, excludeId, exchangeTab.value);
  if (dup) {
    ElMessage.warning(`该地址已存在跟单（${dup.name || shortAddr(dup.whaleAddress)}）`);
    return null;
  }
  return {
    addr,
    wantEnable,
    capital,
    name:
      draft.value.name.trim() ||
      (exchangeTab.value === 'okx' ? 'OKX 跟单' : '币安跟单'),
  };
}

async function saveSettings() {
  const parsed = validateDraft();
  if (!parsed) return;
  if (saving.value) return;
  saving.value = true;
  try {
    const payload = {
      name: parsed.name,
      exchange: exchangeTab.value,
      enabled: parsed.wantEnable,
      whaleAddress: parsed.addr,
      followCapitalUsd: parsed.capital,
      maxLeverage: Math.max(0, Number(draft.value.maxLeverage) || 0),
      maxNotionalUsd: Math.max(0, Number(draft.value.maxNotionalUsd) || 0),
      note: draft.value.note.trim(),
    };

    if (!isLoggedIn.value) {
      ElMessage.warning('请先登录后再保存跟单（需同步到服务端引擎）');
      return;
    }

    if (isCreating.value) {
      const { task } = await saveCopyTask(payload);
      tasks.value = [task, ...tasks.value.filter((t) => t.id !== task.id)];
      selectedId.value = task.id;
      saveLocalTasks(tasks.value);
      closeSettings();
      ElMessage.success(
        task.exchange === 'binance'
          ? '币安跟单已创建（执行待接入）'
          : task.enabled
            ? '已创建并开启自动跟单'
            : '已创建跟单',
      );
      void refreshSnapshot();
      return;
    }

    const t = selected.value;
    if (!t) {
      ElMessage.warning('请先选择或新建跟单任务');
      return;
    }
    const { task } = await saveCopyTask({ ...payload, id: t.id });
    const idx = tasks.value.findIndex((x) => x.id === task.id);
    if (idx >= 0) tasks.value[idx] = task;
    else tasks.value.unshift(task);
    saveLocalTasks(tasks.value);
    closeSettings();
    ElMessage.success(
      task.exchange === 'binance'
        ? '币安草稿已保存'
        : task.enabled
          ? '已保存并开启自动跟单'
          : '已保存设置',
    );
    void refreshSnapshot();
  } catch (err) {
    const msg = err instanceof Error ? err.message : '保存失败';
    if (/已存在跟单/.test(msg)) ElMessage.warning(msg);
    else ElMessage.error(msg);
  } finally {
    saving.value = false;
  }
}

function selectTask(task: CopyTask) {
  selectedId.value = task.id;
}

function onExchangeTab(tab: CopyExchange) {
  if (tab === 'binance') {
    ElMessage.info('币安跟单对接中');
    exchangeTab.value = 'okx';
    return;
  }
  exchangeTab.value = tab;
  if (isCreating.value) {
    draft.value.enabled = true;
    if (!draft.value.name.trim()) draft.value.name = 'OKX 跟单';
  }
}

let pollTimer: number | undefined;

let copyRefreshTimer: number | undefined;

function onCopyUpdateEvent(ev: Event) {
  const detail = (ev as CustomEvent).detail || {};
  const myId = authUser.value?.id;
  if (detail.userId && myId && detail.userId !== myId) return;
  if (!isLoggedIn.value) return;
  // 防抖：跟单成功 HTTP 快照 + WS copyUpdate 常连续到达，合并成一次拉取，避免列表闪重复
  if (copyRefreshTimer) window.clearTimeout(copyRefreshTimer);
  copyRefreshTimer = window.setTimeout(() => {
    copyRefreshTimer = undefined;
    void refreshSnapshot(true);
  }, 120);
}

onMounted(async () => {
  // 不再先灌本地缓存，避免与服务端列表叠加闪一下重复
  if (isLoggedIn.value) {
    await refreshSnapshot(true);
  }

  window.addEventListener('whale-copy-update', onCopyUpdateEvent);
  pollTimer = window.setInterval(() => {
    if (isLoggedIn.value) void refreshSnapshot(true);
  }, 12_000);
});

onUnmounted(() => {
  window.removeEventListener('whale-copy-update', onCopyUpdateEvent);
  if (pollTimer) window.clearInterval(pollTimer);
  if (copyRefreshTimer) window.clearTimeout(copyRefreshTimer);
});
</script>

<template>
  <div class="copy-shell">
    <div v-if="!isLoggedIn" class="gate-panel">
      <h3>跟单需要登录</h3>
      <p>登录后选择交易所并绑定 API Key，才能开启跟单。</p>
      <button type="button" class="primary-btn" @click="emit('request-login')">去登录</button>
    </div>

    <div v-else-if="!keysReady" class="gate-panel setup-panel">
      <h3>配置跟单交易所</h3>
      <p class="setup-desc">选择交易所并填写 API 密钥（保存在服务端数据库，仅你的账户可用）。</p>
      <div class="ex-pick">
        <button
          type="button"
          class="ex-card"
          :class="{ active: setupExchange === 'okx' }"
          @click="setupExchange = 'okx'"
        >
          OKX
        </button>
        <button type="button" class="ex-card" @click="onBinancePick">币安</button>
      </div>
      <div v-if="setupExchange === 'okx'" class="key-form">
        <label>
          <span>OKX_API_KEY</span>
          <input v-model="keyForm.apiKey" autocomplete="off" placeholder="API Key" />
        </label>
        <label>
          <span>OKX_API_SECRET</span>
          <input
            v-model="keyForm.apiSecret"
            type="password"
            autocomplete="new-password"
            placeholder="Secret Key"
          />
        </label>
        <label>
          <span>OKX_API_PASSPHRASE</span>
          <input
            v-model="keyForm.apiPassphrase"
            type="password"
            autocomplete="new-password"
            placeholder="Passphrase"
          />
        </label>
        <label class="check-row">
          <input v-model="keyForm.simulated" type="checkbox" />
          <span>模拟盘（推荐先勾选测试）</span>
        </label>
        <button type="button" class="primary-btn" :disabled="savingKeys" @click="submitOkxKeys">
          {{ savingKeys ? '保存中…' : '保存并开启 OKX 跟单' }}
        </button>
      </div>
    </div>

    <div v-else class="copy-grid">
      <!-- 左：跟单列表 -->
      <section class="panel list-panel">
        <header class="panel-head">
          <div>
            <h3>跟单列表</h3>
            <p class="sub">
              点击选中 · 设置弹窗编辑
              <template v-if="exchangeKeys?.okx?.apiKeyHint">
                · Key {{ exchangeKeys.okx.apiKeyHint }}
              </template>
            </p>
          </div>
          <button type="button" class="ghost" @click="addTask()">新建</button>
        </header>
        <div v-if="!tasks.length" class="empty">暂无跟单任务，点击「新建」开始</div>
        <div v-else class="task-list">
          <div
            v-for="task in tasks"
            :key="task.id"
            class="task-card"
            :class="{
              active: task.id === selectedId,
              on: task.enabled,
              off: !task.enabled,
            }"
            role="button"
            tabindex="0"
            @click="selectTask(task)"
            @keydown.enter="selectTask(task)"
          >
            <div class="task-row">
              <strong class="task-name">{{ task.name }}</strong>
              <span class="status-pill">{{ task.enabled ? '开' : '关' }}</span>
            </div>
            <div class="task-addr" :title="task.whaleAddress || ''">
              {{ shortAddr(task.whaleAddress) }}
            </div>
            <div class="task-row bottom">
              <span class="task-cap">本金 ${{ task.followCapitalUsd }}</span>
              <span class="ex-tag">{{ task.exchange === 'okx' ? 'OKX' : '币安' }}</span>
              <button
                type="button"
                class="settings-btn"
                title="跟单设置"
                @click.stop="openSettings(task)"
              >
                设置
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- 中：跟随持仓 -->
      <section class="panel mid-panel">
        <header class="panel-head">
          <div>
            <h3>跟随持仓</h3>
            <p class="sub">
              全部任务 · {{ visiblePositions.length }} 个
              <template v-if="engineHint"> · {{ engineHint }}</template>
            </p>
          </div>
          <button
            v-if="selected"
            type="button"
            class="ghost"
            @click="openSettings(selected)"
          >
            设置
          </button>
        </header>

        <div v-if="!selected && !tasks.length" class="empty">请先新建跟单任务</div>
        <div v-else-if="!visiblePositions.length" class="empty">
          暂无跟随仓位
          <span class="hint-dim">开启自动跟单后，开/加仓会显示在这里</span>
        </div>
        <div v-else class="pos-grid">
          <article
            v-for="p in visiblePositions"
            :key="p.id"
            class="pos-card"
            :class="p.side"
          >
            <div class="pos-head">
              <span class="coin-icon">{{ (p.coin || '?').slice(0, 1).toUpperCase() }}</span>
              <div class="pos-title">
                <div class="pair-row">
                  <span class="pair">{{ p.coin }}-USDT 永续</span>
                </div>
                <div class="badge-row">
                  <span class="side-badge" :class="p.side">
                    {{ p.side === 'short' ? '空' : '多' }}
                    <template v-if="p.lever"> {{ p.lever }}x</template>
                  </span>
                  <span v-if="p.mgnMode" class="mode-badge">{{ p.mgnMode }}</span>
                </div>
              </div>
            </div>

            <div class="pos-pnl">
              <div class="pnl-col">
                <span class="pnl-k">收益额</span>
                <span class="pnl-v" :class="p.uPnl >= 0 ? 'up' : 'down'">
                  {{ formatUsd(p.uPnl, true) }} USDT
                </span>
              </div>
              <div class="pnl-col right">
                <span class="pnl-k">收益率</span>
                <span class="pnl-v" :class="p.pnlRatio >= 0 ? 'up' : 'down'">
                  {{ formatPct(p.pnlRatio) }}
                </span>
              </div>
            </div>

            <div class="pos-metrics">
              <div class="metric">
                <span class="mk">持仓量</span>
                <span class="mv">{{ p.size || '—' }}</span>
              </div>
              <div class="metric">
                <span class="mk">保证金</span>
                <span class="mv">{{ formatUsd(Math.abs(p.marginUsd)) }} USDT</span>
              </div>
              <div class="metric">
                <span class="mk">开仓均价</span>
                <span class="mv">{{ formatPx(p.entryPx) }}</span>
              </div>
              <div class="metric">
                <span class="mk">标记价格</span>
                <span class="mv">{{ formatPx(p.markPx) }}</span>
              </div>
              <div class="metric">
                <span class="mk">预估强平价</span>
                <span class="mv">{{ formatPx(p.liqPx) }}</span>
              </div>
              <div class="metric">
                <span class="mk">维持保证金率</span>
                <span class="mv">{{
                  Number.isFinite(p.mgnRatio) && p.mgnRatio > 0
                    ? `${(p.mgnRatio * 100).toFixed(2)}%`
                    : '—'
                }}</span>
              </div>
            </div>

            <div class="pos-actions">
              <button
                type="button"
                class="close-btn"
                :disabled="closingPosId === p.id"
                @click.stop="onManualClose(p)"
              >
                {{ closingPosId === p.id ? '平仓中…' : '平仓' }}
              </button>
            </div>
          </article>
        </div>
      </section>

      <!-- 右：跟单记录 -->
      <section class="panel side-panel">
        <header class="panel-head">
          <div>
            <h3>跟单记录</h3>
            <p class="sub">开 / 加 / 减 / 平</p>
          </div>
        </header>
        <div v-if="!visibleRecords.length" class="empty">
          暂无跟单记录
          <span class="hint-dim">巨鲸开/加/减/平都会跟随；无本地仓的加仓按开仓处理</span>
        </div>
        <div v-else class="feed">
          <article
            v-for="item in visibleRecords"
            :key="item.id"
            class="event"
            :class="[item.kind, item.side]"
          >
            <div class="event-top">
              <span class="time">{{ formatTime(item.at) }}</span>
              <span class="tag" :class="[item.kind, { fail: item.status === 'fail' || (item.note || '').startsWith('开仓失败') }]">{{
                kindLabel(item.kind, item)
              }}</span>
              <span class="side" :class="item.side">{{ item.side === 'short' ? '空' : '多' }}</span>
              <span class="coin">{{ item.coin }}</span>
            </div>
            <div class="event-mid">
              <span v-if="item.lever" class="lever">{{ item.lever }}x</span>
              <span v-if="item.marginUsd">保证金 {{ formatUsd(Math.abs(item.marginUsd)) }}</span>
              <span v-if="item.px">价 {{ formatPx(item.px) }}</span>
              <span v-if="item.note">{{ item.note }}</span>
            </div>
          </article>
        </div>
      </section>
    </div>

    <el-dialog
      v-model="settingsOpen"
      :title="isCreating ? '新建跟单' : '跟单设置'"
      width="520px"
      append-to-body
      destroy-on-close
      align-center
      class="copy-settings-dialog"
      @closed="isCreating = false"
    >
      <div v-if="!dialogReady" class="empty">请先选择任务</div>
      <template v-else>
        <div class="ex-tabs">
          <button
            type="button"
            class="ex-tab"
            :class="{ on: exchangeTab === 'okx' }"
            @click="onExchangeTab('okx')"
          >
            OKX
          </button>
          <button type="button" class="ex-tab" @click="onExchangeTab('binance')">
            币安
          </button>
        </div>

        <div v-if="exchangeTab === 'binance'" class="binance-banner">
          <b>币安跟单 · 对接中</b>
          <span>暂不可用，请使用 OKX。</span>
        </div>

        <label class="field">
          <span>任务名称</span>
          <input v-model="draft.name" placeholder="例如：跟单巨鲸 A" />
        </label>
        <label class="field">
          <span>跟单地址（HL 巨鲸钱包）</span>
          <input v-model="draft.whaleAddress" placeholder="0x…" spellcheck="false" />
        </label>
        <label class="field">
          <span>跟单本金（USDT）</span>
          <input v-model.number="draft.followCapitalUsd" type="number" min="1" step="1" />
        </label>
        <p class="hint">
          按比例跟单：巨鲸用本金占其权益的比例 × 你的跟单本金；杠杆默认跟随，可用上限截断。
        </p>
        <div class="grid2">
          <label class="field">
            <span>杠杆上限（0=跟随）</span>
            <input v-model.number="draft.maxLeverage" type="number" min="0" max="125" />
          </label>
          <label class="field">
            <span>单笔名义上限（0=不限）</span>
            <input v-model.number="draft.maxNotionalUsd" type="number" min="0" />
          </label>
        </div>
        <label class="field">
          <span>备注</span>
          <input v-model="draft.note" placeholder="可选" />
        </label>
        <p class="hint dim">
          <template v-if="exchangeTab === 'okx'">
            使用你在跟单页绑定的 OKX API（数据库存储）。开仓失败不会加入跟单列表。
          </template>
          <template v-else>币安跟单对接中。</template>
        </p>
        <label class="field switch-row switch-bottom">
          <span>自动跟单</span>
          <input v-model="draft.enabled" type="checkbox" :disabled="exchangeTab === 'binance'" />
        </label>
      </template>

      <template #footer>
        <button
          v-if="!isCreating"
          type="button"
          class="danger"
          :disabled="!selected"
          @click="removeSelected"
        >
          删除任务
        </button>
        <div class="footer-spacer" />
        <button type="button" class="ghost" @click="closeSettings">取消</button>
        <button type="button" class="primary" :disabled="!dialogReady || saving" @click="saveSettings">
          {{ isCreating ? '确认创建' : exchangeTab === 'binance' ? '保存草稿' : '保存' }}
        </button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.copy-shell {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.gate-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin: 0;
  padding: 32px 20px;
  background: #121821;
  border: 1px solid #1e2630;
  border-radius: 12px;
  color: #e0e3eb;
  text-align: center;
}
.gate-panel h3 {
  margin: 0;
  font-size: 20px;
}
.gate-panel p,
.setup-desc {
  margin: 0;
  max-width: 420px;
  color: #8b93a7;
  font-size: 13px;
  line-height: 1.5;
}
.ex-pick {
  display: flex;
  gap: 12px;
  margin-top: 8px;
}
.ex-card {
  min-width: 120px;
  padding: 14px 18px;
  border-radius: 10px;
  border: 1px solid #2a3444;
  background: #0d1219;
  color: #e0e3eb;
  font-weight: 700;
  cursor: pointer;
}
.ex-card.active {
  border-color: #3d8bfd;
  box-shadow: 0 0 0 1px #3d8bfd55;
}
.key-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(420px, 100%);
  margin-top: 8px;
  text-align: left;
}
.key-form label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: #9aa3b5;
}
.key-form input[type='text'],
.key-form input[type='password'],
.key-form input:not([type]) {
  height: 38px;
  border-radius: 8px;
  border: 1px solid #2a3444;
  background: #0d1219;
  color: #e0e3eb;
  padding: 0 12px;
}
.check-row {
  flex-direction: row !important;
  align-items: center;
  gap: 8px !important;
}
.primary-btn {
  margin-top: 6px;
  height: 40px;
  border: none;
  border-radius: 8px;
  background: #3d8bfd;
  color: #fff;
  font-weight: 700;
  cursor: pointer;
}
.primary-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.copy-grid {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns:
    minmax(200px, 0.26fr)
    minmax(300px, 0.48fr)
    minmax(220px, 0.26fr);
  gap: 12px;
}
.panel {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #121821;
  border: 1px solid #1e2630;
  border-radius: 12px;
  overflow: hidden;
  color: #e0e3eb;
}
.panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid #1e2630;
  flex-shrink: 0;
}
.panel-head h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
}
.sub {
  margin: 4px 0 0;
  font-size: 12px;
  color: #6a7282;
}
.task-list,
.feed {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 10px 12px 14px;
}
.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #6a7282;
  font-size: 13px;
  text-align: center;
  padding: 24px 12px;
}
.hint-dim {
  font-size: 12px;
  color: #4a5262;
}
.task-card {
  width: 100%;
  box-sizing: border-box;
  text-align: left;
  margin-bottom: 8px;
  padding: 10px 12px;
  border: 1px solid transparent;
  border-radius: 8px;
  font: inherit;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 6px;
  transition: box-shadow 0.15s, border-color 0.15s;
}
.task-card.on {
  background: color-mix(in srgb, #58bd7d 22%, #0a0e14);
  border-color: color-mix(in srgb, #58bd7d 55%, #1e2630);
  color: #d8f5e4;
}
.task-card.off {
  background: color-mix(in srgb, #ea5a5a 22%, #0a0e14);
  border-color: color-mix(in srgb, #ea5a5a 55%, #1e2630);
  color: #f8d4d4;
}
.task-card.active {
  box-shadow: 0 0 0 2px color-mix(in srgb, #f15a24 70%, transparent);
}
.task-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.task-row.bottom {
  margin-top: 2px;
}
.task-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status-pill {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 800;
  padding: 1px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, #ffffff 16%, transparent);
  letter-spacing: 0.02em;
}
.task-addr {
  font-size: 11px;
  opacity: 0.85;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-cap {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  opacity: 0.9;
}
.ex-tag {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  opacity: 0.9;
}
.settings-btn {
  flex-shrink: 0;
  margin-left: auto;
  border: 0;
  border-radius: 4px;
  padding: 3px 8px;
  font: inherit;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
  background: color-mix(in srgb, #ffffff 14%, transparent);
  color: inherit;
}
.settings-btn:hover {
  background: color-mix(in srgb, #ffffff 24%, transparent);
}

/* 持仓：对齐 OKX 带单仓位卡片 */
.pos-grid {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 10px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  align-content: start;
}
.pos-card {
  border: 1px solid #1e2630;
  border-radius: 10px;
  background: #0a0e14;
  padding: 12px;
  min-width: 0;
}
.pos-head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 10px;
}
.coin-icon {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 800;
  color: #0a0e14;
  background: #f0b90b;
}
.pos-title {
  min-width: 0;
  flex: 1;
}
.pair-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.pair {
  font-size: 13px;
  font-weight: 700;
  color: #e0e3eb;
  white-space: nowrap;
}
.badge-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.side-badge {
  font-size: 11px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 3px;
  line-height: 1.4;
}
.side-badge.long {
  color: #58bd7d;
  background: color-mix(in srgb, #58bd7d 16%, transparent);
}
.side-badge.short {
  color: #ea5a5a;
  background: color-mix(in srgb, #ea5a5a 16%, transparent);
}
.mode-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
  color: #a0a8b8;
  background: #1a222c;
}
.pos-pnl {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
.pnl-col {
  min-width: 0;
}
.pnl-col.right {
  text-align: right;
}
.pnl-k {
  display: block;
  font-size: 11px;
  color: #6a7282;
  margin-bottom: 2px;
}
.pnl-v {
  font-size: 15px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.pnl-v.up,
.up {
  color: #58bd7d;
}
.pnl-v.down,
.down {
  color: #ea5a5a;
}
.pos-metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 10px;
}
.metric {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.mk {
  font-size: 11px;
  color: #6a7282;
}
.mv {
  font-size: 12px;
  font-weight: 600;
  color: #a0a8b8;
  font-variant-numeric: tabular-nums;
}
.pos-actions {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid #1e2630;
  display: flex;
  justify-content: flex-end;
}
.close-btn {
  height: 30px;
  padding: 0 14px;
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, #ea5a5a 45%, #2a3444);
  background: color-mix(in srgb, #ea5a5a 14%, #121821);
  color: #ff8e8e;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}
.close-btn:hover:not(:disabled) {
  background: color-mix(in srgb, #ea5a5a 24%, #121821);
}
.close-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

/* 跟单记录 */
.event {
  border: 1px solid #1e2630;
  border-radius: 8px;
  background: #0a0e14;
  padding: 10px 12px;
  margin-bottom: 6px;
}
.event-top,
.event-mid {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  min-width: 0;
}
.event-top {
  margin-bottom: 6px;
}
.time {
  font-size: 12px;
  color: #6a7282;
  font-variant-numeric: tabular-nums;
}
.tag {
  font-size: 11px;
  font-weight: 700;
  padding: 1px 8px;
  border-radius: 4px;
  background: #1a222c;
  color: #a0a8b8;
}
.tag.open,
.tag.add {
  background: color-mix(in srgb, #58bd7d 16%, transparent);
  color: #58bd7d;
}
.tag.close {
  background: color-mix(in srgb, #ea5a5a 16%, transparent);
  color: #ea5a5a;
}
.tag.fail {
  background: color-mix(in srgb, #ea5a5a 18%, transparent);
  color: #f87171;
}
.tag.margin {
  background: color-mix(in srgb, #e6b84c 16%, transparent);
  color: #e6b84c;
}
.side {
  font-size: 12px;
  font-weight: 700;
}
.side.long {
  color: #58bd7d;
}
.side.short {
  color: #ea5a5a;
}
.coin {
  font-size: 13px;
  font-weight: 700;
}
.event-mid {
  font-size: 12px;
  color: #a0a8b8;
}
.lever {
  color: #f0b90b;
  font-weight: 700;
}

.ghost,
.primary,
.danger {
  border: 0;
  border-radius: 6px;
  padding: 8px 14px;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}
.ghost {
  background: #1a222e;
  color: #b0c4de;
}
.primary {
  background: color-mix(in srgb, #f15a24 35%, #1a222e);
  color: #ffe8de;
}
.danger {
  background: #1a222e;
  color: #f87171;
}
.ghost:disabled,
.primary:disabled,
.danger:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.ex-tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
}
.ex-tab {
  height: 28px;
  padding: 0 12px;
  border: 1px solid #1e2630;
  border-radius: 6px;
  background: transparent;
  color: #a0a8b8;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.ex-tab.on {
  color: #f15a24;
  border-color: color-mix(in srgb, #f15a24 45%, #1e2630);
  background: color-mix(in srgb, #f15a24 12%, transparent);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
  font-size: 12px;
  color: #6a7282;
}
.field input {
  height: 32px;
  border: 1px solid #1e2630;
  border-radius: 6px;
  background: #0a0e14;
  color: #e0e3eb;
  font: inherit;
  font-size: 13px;
  padding: 0 10px;
}
.switch-row {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}
.switch-bottom {
  margin-top: 14px;
  margin-bottom: 0;
  padding-top: 12px;
  border-top: 1px solid #1e2630;
}
.switch-row input {
  width: 18px;
  height: 18px;
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.hint {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.45;
  color: #a0a8b8;
}
.hint.dim {
  color: #6a7282;
}
.binance-banner {
  margin: 0 0 12px;
  padding: 10px 12px;
  border: 1px dashed color-mix(in srgb, #f0b90b 40%, #1e2630);
  border-radius: 8px;
  background: color-mix(in srgb, #f0b90b 6%, transparent);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.binance-banner b {
  font-size: 13px;
  color: #f0b90b;
}
.binance-banner span {
  font-size: 12px;
  color: #a0a8b8;
  line-height: 1.4;
}
.footer-spacer {
  flex: 1;
}

@media (max-width: 1280px) {
  .copy-grid {
    grid-template-columns: 1fr;
    overflow: auto;
  }
  .pos-grid {
    grid-template-columns: 1fr;
  }
}
</style>

<style>
/* append-to-body 弹窗 */
.copy-settings-dialog.el-dialog {
  background: #121821;
  border: 1px solid #1e2630;
  border-radius: 12px;
}
.copy-settings-dialog .el-dialog__header {
  margin-right: 0;
  padding: 16px 20px 8px;
}
.copy-settings-dialog .el-dialog__title {
  color: #e0e3eb;
  font-weight: 700;
}
.copy-settings-dialog .el-dialog__headerbtn .el-dialog__close {
  color: #a0a8b8;
}
.copy-settings-dialog .el-dialog__body {
  padding: 8px 20px 4px;
  color: #e0e3eb;
}
.copy-settings-dialog .el-dialog__footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 20px 18px;
}
</style>
