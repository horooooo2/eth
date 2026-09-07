<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { fetchQuotes, fetchPagedAlertHistory, fetchPagedTrades, fetchCalendar } from '@/api';
import CoinPreferences from '@/components/CoinPreferences.vue';
import FreshModeControl from '@/components/FreshModeControl.vue';
import NewsList from '@/components/NewsList.vue';
import LiquidationBanner from '@/components/LiquidationBanner.vue';
import WhaleResonanceBanner from '@/components/WhaleResonanceBanner.vue';
import WhaleAlertDock from '@/components/WhaleAlertDock.vue';
import WhaleList from '@/components/WhaleList.vue';
import DataModule from '@/components/DataModule.vue';
import CopyTradeWorkspace from '@/components/CopyTradeWorkspace.vue';
import { useNewsStore } from '@/stores/news';
import { useWhaleStore } from '@/stores/whale';
import {
  authLoading,
  authUser,
  bootstrapAuth,
  isLoggedIn,
  login as authLogin,
  logout as authLogout,
  getAuthUiSettings,
} from '@/stores/auth';
import { useRealtime } from '@/composables/useRealtime';
import type { RecoQuotes } from '@/utils/recommend';
import { readFocusCoin } from '@/utils/recoPrefs';
import { preferredCoinsState } from '@/utils/watchedCoins';
import { unlockAlertSound, playAlertDing } from '@/utils/alertSound';
import type { WhaleAlert } from '@/utils/whaleAlerts';
import { normalizeStoredAlert } from '@/utils/whaleAlerts';
import { noteXTweets } from '@/stores/xFeed';
import type { XFeedTweet } from '@/api';
import { isWhaleMonitored } from '@/utils/monitoredWhales';
import {
  clearHlWorkspaceBadge,
  formatWorkspaceBadge,
  hlWorkspaceBadge,
  noteHlWorkspacePending,
} from '@/utils/workspaceBadges';
import type { WhaleProfile, WhaleTrade } from '@/types';

const whaleStore = useWhaleStore();
const newsStore = useNewsStore();

const whaleListRef = ref<InstanceType<typeof WhaleList> | null>(null);
const newsListRef = ref<InstanceType<typeof NewsList> | null>(null);
const whalePanel = ref<'list' | 'data' | 'news'>('list');
const quotes = ref<RecoQuotes>({});
const fundingRates = ref<Record<string, number>>({});
const focusCoin = ref<string>(readFocusCoin());

function reloadNewsAlerts() {
  return Promise.resolve(newsListRef.value?.reloadAlerts?.(false));
}

const loginOpen = ref(false);
const loginUser = ref('');
const loginPass = ref('');
const loginBusy = ref(false);

async function submitLogin() {
  if (loginBusy.value) return;
  loginBusy.value = true;
  try {
    await authLogin(loginUser.value.trim(), loginPass.value);
    ElMessage.success(`已登录：${authUser.value?.username || ''}`);
    loginOpen.value = false;
    loginPass.value = '';
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '登录失败');
  } finally {
    loginBusy.value = false;
  }
}

function openCopyWorkspace() {
  workspace.value = 'copy';
  if (!isLoggedIn.value) {
    loginOpen.value = true;
  }
}

function onOpenCopyWorkspace() {
  workspace.value = 'copy';
}

function onLogout() {
  void ElMessageBox.confirm('确认退出登录？', '退出', {
    confirmButtonText: '退出',
    cancelButtonText: '取消',
    type: 'warning',
  })
    .then(() => authLogout())
    .then(() => ElMessage.success('已退出登录'))
    .catch(() => undefined);
}

function onFocusWhale(whale: { id: string; name: string }) {
  onFocusWhaleCard({ id: whale.id, name: whale.name });
  void whaleStore.refreshWhale(whale.id);
}

function onFocusWhaleCard(payload: { id: string; name: string; coin?: string }) {
  whalePanel.value = 'list';
  nextTick(() => {
    void whaleListRef.value?.focusWhale({ id: payload.id, coin: payload.coin });
  });
}

function onSelectWhale(whale: { id: string; name: string }) {
  whaleStore.loadWhaleTrades(whale);
  if (window.matchMedia('(max-width: 768px)').matches) {
    whalePanel.value = 'news';
  }
}

function onSelectTransfers(whale: { id: string; name: string }) {
  onSelectWhale(whale);
}

async function loadQuotes() {
  const next = await fetchQuotes(preferredCoinsState.value).catch(() => null);
  if (!next) return;
  const { funding, updatedAt: _updatedAt, ...prices } = next;
  const nextQuotes: RecoQuotes = {};
  for (const [key, value] of Object.entries(prices)) {
    if (typeof value === 'number' && Number.isFinite(value)) nextQuotes[key] = value;
  }
  quotes.value = nextQuotes;
  if (funding && typeof funding === 'object') fundingRates.value = funding;
}

async function loadAll(refresh = false, silent = false) {
  bootBusy.value = true;
  bootProgress.value = 4;
  bootLabel.value = '巨鲸加载中…';
  secondaryReady.value = false;
  try {
    await whaleStore.load(refresh, silent);
    bootProgress.value = 50;

    bootLabel.value = '异动记录加载中…';
    try {
      const data = await fetchPagedAlertHistory({ page: 1, limit: 50 });
      const list = (data.alerts || [])
        .map((item) => normalizeStoredAlert(item as WhaleAlert))
        .filter((item): item is WhaleAlert => Boolean(item));
      whaleStore.absorbAlertPage(list);
    } catch {
      // 子组件会再拉
    }
    bootProgress.value = 100;
    bootLabel.value = '完成';
  } finally {
    secondaryReady.value = true;
    await new Promise((r) => window.setTimeout(r, 120));
    bootBusy.value = false;
    // 新闻 / 行情 / 资金动态 / 日历：遮罩关闭后静默加载
    void Promise.all([
      newsStore.load(refresh, true).catch(() => null),
      loadQuotes().catch(() => null),
      fetchPagedTrades({ page: 1, limit: 50 }).catch(() => null),
      fetchCalendar().catch(() => null),
    ]);
  }
}

/** 新闻 / 日历 / 行情：定时刷新；巨鲸等仅首屏 loadAll */
async function pollNewsAndQuotes() {
  await Promise.all([newsStore.load(false, true), loadQuotes()]);
}

const secondaryReady = ref(false);
const bootBusy = ref(true);
const bootLabel = ref('巨鲸加载中…');
const bootProgress = ref(0);
/** 工作区：HL 监控 / 跟单 */
const workspace = ref<'hyperliquid' | 'copy'>('hyperliquid');

const {
  status: realtimeStatus,
  start: startRealtime,
  stop: stopRealtime,
} = useRealtime((msg) => {
  if (msg.type === 'fill' && msg.trade) {
    whaleStore.ingestRealtimeFill(msg.trade as unknown as WhaleTrade);
  } else if (msg.type === 'alert' && msg.alert) {
    const alert = msg.alert as unknown as WhaleAlert;
    whaleStore.ingestRealtimeAlert(alert);
    if (
      workspace.value !== 'hyperliquid' &&
      alert.whaleId &&
      isWhaleMonitored(alert.whaleId)
    ) {
      noteHlWorkspacePending(alert.whaleId);
    }
  } else if (msg.type === 'whalePatch' && msg.whaleId && msg.patch) {
    whaleStore.ingestRealtimeWhalePatch(msg.whaleId, msg.patch as Partial<WhaleProfile>);
  } else if (msg.type === 'xTweet' && Array.isArray(msg.tweets)) {
    noteXTweets(msg.tweets as unknown as XFeedTweet[]);
  } else if (msg.type === 'copyUpdate') {
    window.dispatchEvent(new CustomEvent('whale-copy-update', { detail: msg }));
  }
});

watch(workspace, (next) => {
  if (next === 'hyperliquid') {
    clearHlWorkspaceBadge();
  }
});

/** HL 非实时路径（轮询 diff）在异工作区时也记红点 */
watch(
  () => whaleStore.alerts.map((item) => item.id),
  (ids, prev) => {
    void ids;
    if (workspace.value === 'hyperliquid') return;
    const prevSet = new Set(prev || []);
    let added = false;
    for (const alert of whaleStore.alerts) {
      if (prevSet.has(alert.id)) continue;
      if (!isWhaleMonitored(alert.whaleId)) continue;
      noteHlWorkspacePending(alert.whaleId);
      added = true;
    }
    if (added) playAlertDing();
  },
);

const pageBusy = computed(() => bootBusy.value);
const loadProgressText = computed(() => {
  const progress = whaleStore.loadProgress;
  if (!progress || !progress.total) return '';
  return `${progress.loaded}/${progress.total}`;
});

watch(
  preferredCoinsState,
  () => {
    focusCoin.value = readFocusCoin();
    void loadQuotes();
  },
  { deep: true },
);

function syncMobilePanel() {
  if (window.matchMedia('(max-width: 768px)').matches && whalePanel.value === 'data') {
    whalePanel.value = 'list';
  }
}

watch(whalePanel, (panel) => {
  if (panel === 'data' && window.matchMedia('(max-width: 768px)').matches) {
    whalePanel.value = 'list';
  }
});

let timer: number | undefined;

onMounted(async () => {
  document.documentElement.classList.add('dark');
  document.documentElement.classList.remove('light');
  syncMobilePanel();
  window.addEventListener('resize', syncMobilePanel);
  window.addEventListener('whale-open-copy-workspace', onOpenCopyWorkspace);
  unlockAlertSound();
  await bootstrapAuth();
  void getAuthUiSettings();
  await loadAll(false);
  whaleStore.startActivityPolling();
  startRealtime();
  timer = window.setInterval(() => {
    void pollNewsAndQuotes();
  }, 60 * 1000);
});

onUnmounted(() => {
  if (timer) window.clearInterval(timer);
  whaleStore.stopActivityPolling();
  stopRealtime();
  window.removeEventListener('resize', syncMobilePanel);
  window.removeEventListener('whale-open-copy-workspace', onOpenCopyWorkspace);
});
</script>

<template>
  <div
    class="app-shell"
    :class="{ busy: pageBusy, 'theme-copy': workspace === 'copy' }"
    @pointerdown="unlockAlertSound"
  >
    <div v-if="pageBusy" class="page-mask">
      <div class="page-mask-card">
        <p class="mask-title">正在加载首页</p>
        <p class="mask-label">{{ bootLabel }}</p>
        <div class="bar-track">
          <div class="bar-fill" :style="{ width: `${bootProgress}%` }" />
        </div>
        <p class="mask-pct">{{ bootProgress }}%</p>
        <p v-if="bootLabel.startsWith('巨鲸') && loadProgressText" class="dim">
          {{ loadProgressText }}
        </p>
      </div>
    </div>

    <WhaleAlertDock
      :dock-active="workspace === 'hyperliquid'"
      @focus-whale="onFocusWhaleCard"
    />

    <aside class="sidebar" aria-label="主导航">
      <div
        class="socket-dot"
        :class="realtimeStatus"
        :title="
          realtimeStatus === 'connected'
            ? '实时连接正常'
            : realtimeStatus === 'connecting'
              ? '实时连接中…'
              : '实时连接已断开'
        "
        aria-label="实时连接状态"
      >
        <span class="socket-core" />
      </div>
      <button
        type="button"
        class="nav-item"
        :class="{ active: workspace === 'hyperliquid' }"
        @click="workspace = 'hyperliquid'"
      >
        <span class="nav-mark brand" aria-hidden="true">
          <svg class="brand-logo hl" viewBox="0 0 32 32" fill="none">
            <circle cx="16" cy="16" r="16" fill="#97FCE4" />
            <path
              fill="#0B0E14"
              d="M10 9h3.2v5.2H18.8V9H22v14h-3.2v-5.6H13.2V23H10V9z"
            />
          </svg>
          <span v-if="hlWorkspaceBadge > 0" class="nav-badge">{{
            formatWorkspaceBadge(hlWorkspaceBadge)
          }}</span>
        </span>
        <span>Hyperliquid</span>
      </button>
      <button
        type="button"
        class="nav-item"
        :class="{ active: workspace === 'copy' }"
        @click="openCopyWorkspace"
      >
        <span class="nav-mark brand" aria-hidden="true">
          <svg class="brand-logo copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M7 7h10v10H7zM4.5 4.5H9M15 19.5h4.5M4.5 15V9M19.5 9v6"
            />
          </svg>
        </span>
        <span>跟单</span>
      </button>

      <div class="bottom-nav">
        <FreshModeControl variant="sidebar" :reload-alerts="reloadNewsAlerts" />
        <CoinPreferences variant="sidebar" @reset-copy-api="openCopyWorkspace" />
        <button
          v-if="isLoggedIn"
          type="button"
          class="nav-item account"
          :title="authUser?.username || '账户'"
          @click="onLogout"
        >
          <span class="nav-mark user">{{ (authUser?.username || 'U').slice(0, 1).toUpperCase() }}</span>
          <span class="account-name">{{ authUser?.username || '账户' }}</span>
        </button>
        <button
          v-else
          type="button"
          class="nav-item account"
          title="登录"
          :disabled="authLoading"
          @click="loginOpen = true"
        >
          <span class="nav-mark user">登</span>
          <span>登录</span>
        </button>
      </div>
    </aside>

    <div class="layout">
      <header v-show="workspace === 'hyperliquid'" class="topbar">
        <LiquidationBanner />
        <WhaleResonanceBanner
          :whales="whaleStore.displayWhales"
          :activity="whaleStore.activity"
          :alerts="whaleStore.alertHistory"
          :quotes="quotes"
          :ready="whaleStore.displayWhales.length > 0"
          @focus-whale="onFocusWhaleCard"
        />
      </header>

      <el-dialog
        v-model="loginOpen"
        title="登录"
        width="420px"
        destroy-on-close
        class="login-dialog"
      >
        <el-form class="login-form" label-position="top" @submit.prevent="submitLogin">
          <el-form-item label="用户名">
            <el-input
              v-model="loginUser"
              size="large"
              autocomplete="username"
              @keyup.enter="submitLogin"
            />
          </el-form-item>
          <el-form-item label="密码">
            <el-input
              v-model="loginPass"
              type="password"
              size="large"
              show-password
              autocomplete="current-password"
              @keyup.enter="submitLogin"
            />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button size="large" @click="loginOpen = false">取消</el-button>
          <el-button type="primary" size="large" :loading="loginBusy" @click="submitLogin">
            登录
          </el-button>
        </template>
      </el-dialog>

      <el-alert
        v-if="workspace === 'hyperliquid' && (whaleStore.error || newsStore.error)"
        class="warn"
        type="warning"
        :closable="false"
        :title="whaleStore.error || newsStore.error"
      />

      <div v-show="workspace === 'hyperliquid'" class="whales-shell">
        <div class="mobile-panel-tabs">
          <el-radio-group v-model="whalePanel" size="small">
            <el-radio-button label="list">巨鲸</el-radio-button>
            <el-radio-button label="news">异动</el-radio-button>
          </el-radio-group>
        </div>
        <div class="grid" :class="`panel-${whalePanel}`">
          <DataModule
            :whales="whaleStore.displayWhales"
            :loading="whaleStore.loading"
            :selected-id="whaleStore.selectedWhaleId"
            :selected-name="whaleStore.selectedWhaleName"
            :updated-at="whaleStore.updatedAt"
            :quotes="quotes"
            :boot-ready="secondaryReady"
            @focus-whale="onFocusWhaleCard"
          />

          <WhaleList
            ref="whaleListRef"
            :whales="whaleStore.enabledWhales"
            :loading="whaleStore.loading"
            :selected-id="whaleStore.selectedWhaleId"
            :quotes="quotes"
            @query="onSelectWhale"
            @select-transfers="onSelectTransfers"
            @focus-whale="onFocusWhaleCard"
          />

          <NewsList
            ref="newsListRef"
            :alerts="whaleStore.alertHistory"
            :whales="whaleStore.enabledWhales"
            :funding-rates="fundingRates"
            :filter-whale-id="whaleStore.selectedWhaleId"
            :boot-ready="secondaryReady"
            @locate-whale="onFocusWhaleCard"
            @focus-whale="onFocusWhale"
            @clear-whale-filter="whaleStore.clearWhaleFilter"
          />
        </div>
      </div>

      <CopyTradeWorkspace v-show="workspace === 'copy'" @request-login="loginOpen = true" />
    </div>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  height: 100vh;
  overflow: hidden;
  background: #0b0e14;
  color: #e8edf5;
}
.app-shell.busy {
  pointer-events: none;
  user-select: none;
}

/* ===== 跟单模块主题（含侧栏） ===== */
.app-shell.theme-copy {
  --copy-black: #000000;
  --copy-accent: #f15a24;
  --copy-bg: #0a0e14;
  --copy-bg-3: #1a222c;
  --copy-border: #1e2630;
  --copy-text: #e0e3eb;
  --copy-text-3: #6a7282;
  background: var(--copy-bg);
  color: var(--copy-text);
}
.app-shell.theme-copy .sidebar {
  background: var(--copy-black);
  border-right-color: var(--copy-border);
}
.app-shell.theme-copy .sidebar .nav-item {
  color: var(--copy-text-3);
}
.app-shell.theme-copy .sidebar .nav-item.active {
  background: var(--copy-bg-3);
  color: var(--copy-accent);
}
.app-shell.theme-copy .sidebar .nav-item:hover {
  background: var(--copy-bg-3);
  color: var(--copy-text);
}
.app-shell.theme-copy .sidebar .nav-item.active .nav-mark .brand-logo.copy {
  color: var(--copy-accent);
}
.app-shell.theme-copy .sidebar .bottom-nav {
  border-top-color: var(--copy-border);
}
.app-shell.theme-copy .layout {
  background: var(--copy-bg);
}
.app-shell.theme-copy .sidebar :deep(.fresh-btn.sidebar),
.app-shell.theme-copy .sidebar :deep(.prefs-trigger.sidebar) {
  color: var(--copy-text-3);
}
.app-shell.theme-copy .sidebar :deep(.fresh-btn.sidebar:hover:not(:disabled)),
.app-shell.theme-copy .sidebar :deep(.prefs-trigger.sidebar:hover) {
  background: var(--copy-bg-3);
  color: var(--copy-text);
}
.app-shell.theme-copy .sidebar :deep(.fresh-btn.sidebar.on) {
  background: var(--copy-bg-3);
  color: var(--copy-accent);
}

.sidebar {
  width: 72px;
  background: #0f141c;
  border-right: 1px solid #1a1f2a;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 20px 0 16px;
  flex-shrink: 0;
  z-index: 10;
  overflow: hidden;
}
.sidebar .socket-dot {
  position: relative;
  width: 28px;
  height: 28px;
  margin-bottom: 28px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.sidebar .socket-core {
  position: relative;
  z-index: 1;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #6a7282;
  box-shadow: 0 0 0 2px color-mix(in srgb, #6a7282 22%, transparent);
  transition: background 0.2s, box-shadow 0.2s;
}
.sidebar .socket-dot::before,
.sidebar .socket-dot::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1.5px solid currentColor;
  transform: translate(-50%, -50%) scale(1);
  opacity: 0;
  pointer-events: none;
}
.sidebar .socket-dot.connected .socket-core {
  background: #58bd7d;
  box-shadow: 0 0 6px color-mix(in srgb, #58bd7d 55%, transparent);
}
.sidebar .socket-dot.connected {
  color: #58bd7d;
}
.sidebar .socket-dot.connected::before,
.sidebar .socket-dot.connected::after {
  animation: socket-ripple 2.8s ease-out infinite;
}
.sidebar .socket-dot.connected::after {
  animation-delay: 1.4s;
}
.sidebar .socket-dot.connecting .socket-core {
  background: #f15a24;
  box-shadow: 0 0 6px color-mix(in srgb, #f15a24 55%, transparent);
}
.sidebar .socket-dot.connecting {
  color: #f15a24;
}
.sidebar .socket-dot.connecting::before,
.sidebar .socket-dot.connecting::after {
  animation: socket-ripple 1.8s ease-out infinite;
}
.sidebar .socket-dot.connecting::after {
  animation-delay: 0.9s;
}
.sidebar .socket-dot.disconnected .socket-core {
  background: #6a7282;
  box-shadow: 0 0 0 2px color-mix(in srgb, #6a7282 22%, transparent);
}
@keyframes socket-ripple {
  0% {
    transform: translate(-50%, -50%) scale(1);
    opacity: 0.55;
  }
  70% {
    opacity: 0.12;
  }
  100% {
    transform: translate(-50%, -50%) scale(3.4);
    opacity: 0;
  }
}
.sidebar .nav-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 14px;
  color: #6a7e9c;
  font-size: 10px;
  font-weight: 600;
  font-family: inherit;
  gap: 2px;
  margin-bottom: 4px;
  cursor: pointer;
  background: transparent;
  border: none;
  transition: background 0.15s, color 0.15s;
  padding: 0;
}
.sidebar .nav-item .nav-mark {
  width: 24px;
  height: 24px;
  border-radius: 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: -0.02em;
  background: #1a222e;
  color: inherit;
  overflow: hidden;
}
.sidebar .nav-item .nav-mark.brand {
  background: transparent;
  border-radius: 0;
  position: relative;
}
.sidebar .nav-badge {
  position: absolute;
  top: -5px;
  right: -6px;
  z-index: 2;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 999px;
  background: #ea5a5a;
  color: #fff;
  font-size: 9px;
  font-weight: 800;
  line-height: 14px;
  text-align: center;
  box-sizing: border-box;
  pointer-events: none;
  box-shadow: 0 0 0 1px #0f141c;
}
.sidebar .nav-item .nav-mark .brand-logo {
  width: 22px;
  height: 22px;
  display: block;
}
.sidebar .nav-item .nav-mark .brand-logo.hl {
  border-radius: 50%;
}
.sidebar .nav-item .nav-mark .brand-logo.copy {
  width: 20px;
  height: 20px;
  color: #e8edf5;
}
.sidebar .nav-item .nav-mark.user {
  background: #1f2a3a;
  border-radius: 50%;
  font-size: 11px;
}
.sidebar .nav-item.active {
  background: #1f2a3a;
  color: #fbbf24;
}
.sidebar .nav-item.active .nav-mark.user {
  background: color-mix(in srgb, #fbbf24 18%, #1f2a3a);
  color: #fbbf24;
}
.sidebar .nav-item:hover {
  background: #1a222e;
  color: #e8edf5;
}
.sidebar .bottom-nav {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  border-top: 1px solid #1a1f2a;
  padding-top: 16px;
  width: 100%;
}
.sidebar .bottom-nav .nav-item {
  width: 56px;
  height: 48px;
  font-size: 10px;
}
.sidebar .bottom-nav .account-name {
  max-width: 52px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.layout {
  flex: 1;
  height: 100vh;
  display: flex;
  flex-direction: column;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  padding: 16px 24px;
  background: var(--bg, #0b0e14);
  box-sizing: border-box;
  position: relative;
}
.page-mask {
  position: fixed;
  inset: 0;
  z-index: 4000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, #0b0e14 72%, transparent);
  backdrop-filter: blur(3px);
  pointer-events: all;
}
.page-mask-card {
  width: min(360px, calc(100vw - 40px));
  min-width: 220px;
  padding: 22px 24px;
  border-radius: 14px;
  border: 1px solid #2a3544;
  background: #141a24;
  color: #e8edf5;
  text-align: center;
  box-shadow: 0 16px 48px #00000066;
}
.page-mask-card .mask-title {
  margin: 0;
  font-size: 16px;
  font-weight: 800;
}
.page-mask-card .mask-label {
  margin: 8px 0 16px;
  font-size: 13px;
  color: #8b9bb5;
  min-height: 1.2em;
}
.page-mask-card .bar-track {
  height: 8px;
  border-radius: 999px;
  background: #1a222e;
  overflow: hidden;
}
.page-mask-card .bar-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #2563eb, #60a5fa);
  transition: width 0.18s ease;
}
.page-mask-card .mask-pct {
  margin: 10px 0 0;
  font-size: 13px;
  font-weight: 700;
  color: #b0c4de;
  font-variant-numeric: tabular-nums;
}
.page-mask-card .dim {
  margin-top: 8px;
  font-size: 12px;
  font-weight: 500;
  color: #6a7e9c;
}
.topbar {
  display: grid;
  grid-template-columns: 1fr 2fr;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  min-width: 0;
  min-height: 44px;
}
.topbar .liq-wrap,
.topbar .notice-wrap {
  justify-self: stretch;
  width: 100%;
  max-width: 100%;
  min-width: 0;
}
.login-form :deep(.el-form-item) {
  margin-bottom: 18px;
}
.login-form :deep(.el-form-item__label) {
  font-weight: 700;
  color: #8b9bb5;
}
.login-form :deep(.el-input__wrapper) {
  min-height: 44px;
  padding: 4px 14px;
  border-radius: 12px;
  background: #10171f;
  box-shadow: 0 0 0 1px #1f2937 inset;
}
.warn {
  margin-bottom: 8px;
}
.whales-shell {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mobile-panel-tabs {
  display: none;
}
.grid {
  flex: 1;
  display: grid;
  /* 左栏 -80px，右栏 +80px（相对原先等宽左右） */
  grid-template-columns:
    minmax(120px, calc((100% - 24px) * 0.25 - 80px))
    minmax(0, calc((100% - 24px) * 0.5))
    minmax(200px, calc((100% - 24px) * 0.25 + 80px));
  gap: 12px;
  width: 100%;
  min-width: 0;
  min-height: 0;
}
.grid > * {
  height: 100%;
  min-width: 0;
  max-width: 100%;
  min-height: 0;
  overflow: hidden;
}
@media (max-width: 1280px) {
  .app-shell {
    height: auto;
    min-height: 100vh;
  }
  .layout {
    height: auto;
    min-height: 100vh;
    overflow-x: hidden;
    overflow-y: auto;
  }
  .grid {
    flex: none;
    grid-template-columns: 1fr;
    min-height: 0;
  }
  .grid > * {
    height: auto;
    overflow: visible;
  }
}
@media (max-width: 768px) {
  .sidebar {
    display: none;
  }
  .layout {
    padding: 6px 6px calc(12px + env(safe-area-inset-bottom));
    height: 100dvh;
  }
  .topbar {
    display: none !important;
  }
  .mobile-panel-tabs {
    display: block;
    flex: 0 0 auto;
  }
  .mobile-panel-tabs :deep(.el-radio-group) {
    display: flex;
    width: 100%;
  }
  .mobile-panel-tabs :deep(.el-radio-button) {
    flex: 1;
  }
  .mobile-panel-tabs :deep(.el-radio-button__inner) {
    width: 100%;
    padding: 6px 4px;
    font-size: 12px;
  }
  .whales-shell {
    flex: 1;
    min-height: 0;
  }
  .grid {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .grid > * {
    display: none;
    flex: 1;
    min-height: 0;
    height: auto;
    overflow: hidden;
  }
  .grid.panel-list > :nth-child(2),
  .grid.panel-news > :nth-child(3) {
    display: flex;
    flex-direction: column;
  }
  .grid.panel-data > :nth-child(1) {
    display: none !important;
  }
  .grid.panel-data > :nth-child(2) {
    display: flex;
    flex-direction: column;
  }
}
</style>

<style>
.login-dialog.el-dialog {
  background: #141a24 !important;
  border: 1px solid #1f2937;
  border-radius: 16px;
  overflow: hidden;
}
.login-dialog .el-dialog__header {
  padding: 16px 24px 8px;
  margin: 0;
}
.login-dialog .el-dialog__title {
  color: #e8edf5;
  font-weight: 700;
}
.login-dialog .el-dialog__body {
  padding: 8px 24px 4px;
}
.login-dialog .el-dialog__footer {
  padding: 12px 24px 20px;
}
.login-dialog .el-button {
  border-radius: 12px;
  font-weight: 700;
}
.login-dialog .el-button--primary {
  background: #2a4a6a;
  border-color: #2a4a6a;
}
.login-dialog .el-button--primary:hover {
  background: #345878;
  border-color: #345878;
}
</style>
