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
import { unlockAlertSound } from '@/utils/alertSound';
import type { WhaleAlert } from '@/utils/whaleAlerts';
import { normalizeStoredAlert } from '@/utils/whaleAlerts';
import type { WhaleProfile, WhaleTrade } from '@/types';

const whaleStore = useWhaleStore();
const newsStore = useNewsStore();
const { start: startRealtime, stop: stopRealtime } = useRealtime((msg) => {
  if (msg.type === 'fill' && msg.trade) {
    whaleStore.ingestRealtimeFill(msg.trade as unknown as WhaleTrade);
  } else if (msg.type === 'alert' && msg.alert) {
    whaleStore.ingestRealtimeAlert(msg.alert as unknown as WhaleAlert);
  } else if (msg.type === 'whalePatch' && msg.whaleId && msg.patch) {
    whaleStore.ingestRealtimeWhalePatch(msg.whaleId, msg.patch as Partial<WhaleProfile>);
  }
});

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
    bootProgress.value = 28;
    secondaryReady.value = true;

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
    bootProgress.value = 48;

    bootLabel.value = '新闻加载中…';
    await newsStore.load(refresh, silent).catch(() => null);
    bootProgress.value = 64;

    bootLabel.value = '行情加载中…';
    await loadQuotes();
    bootProgress.value = 76;

    bootLabel.value = '资金动态加载中…';
    await fetchPagedTrades({ page: 1, limit: 50 }).catch(() => null);
    bootProgress.value = 88;

    bootLabel.value = '宏观日历加载中…';
    await fetchCalendar().catch(() => null);
    bootProgress.value = 100;
    bootLabel.value = '完成';
  } finally {
    secondaryReady.value = true;
    await new Promise((r) => window.setTimeout(r, 180));
    bootBusy.value = false;
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
});
</script>

<template>
  <div class="layout" :class="{ busy: pageBusy }" @pointerdown="unlockAlertSound">
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

    <WhaleAlertDock @focus-whale="onFocusWhaleCard" />

    <header class="topbar">
      <LiquidationBanner />

      <WhaleResonanceBanner
        :whales="whaleStore.displayWhales"
        :activity="whaleStore.activity"
        :alerts="whaleStore.alertHistory"
        :quotes="quotes"
        :ready="whaleStore.displayWhales.length > 0"
        @focus-whale="onFocusWhaleCard"
      />

      <div class="topbar-actions">
        <FreshModeControl :reload-alerts="reloadNewsAlerts" />
        <el-button
          v-if="isLoggedIn"
          class="login-btn user-chip"
          :title="authUser?.username"
          @click="onLogout"
        >
          {{ authUser?.username }}
        </el-button>
        <el-button
          v-else
          type="primary"
          class="login-btn"
          :loading="authLoading"
          title="登录"
          @click="loginOpen = true"
        >
          登录
        </el-button>
        <CoinPreferences />
      </div>
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
      v-if="whaleStore.error || newsStore.error"
      class="warn"
      type="warning"
      :closable="false"
      :title="whaleStore.error || newsStore.error"
    />

    <div class="whales-shell">
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
  </div>
</template>

<style scoped>
.layout {
  height: 100vh;
  display: flex;
  flex-direction: column;
  max-width: 100%;
  width: 100%;
  overflow: hidden;
  padding: 16px 24px;
  background: var(--bg);
  box-sizing: border-box;
  position: relative;
}
.layout.busy {
  pointer-events: none;
  user-select: none;
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
  grid-template-columns: 6.5fr 13fr 6.5fr;
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
.topbar-actions {
  justify-self: end;
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}
.login-btn {
  min-width: 72px;
  height: 32px;
  padding: 0 16px;
  font-size: 13px;
  font-weight: 700;
  border-radius: 999px;
  border: 0;
}
.login-btn.user-chip {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: #1a222e !important;
  color: #b0c4de !important;
}
.topbar-actions :deep(.login-btn.el-button--primary) {
  background: #2a4a6a;
  border-color: #2a4a6a;
  color: #f0f4fa;
}
.topbar-actions :deep(.login-btn.el-button--primary:hover) {
  background: #345878;
  border-color: #345878;
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
  grid-template-columns: 6.5fr 13fr 6.5fr;
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
