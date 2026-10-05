<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { fetchQuotes, fetchAlertFlowSummary } from '@/api';
import CoinPreferences from '@/components/CoinPreferences.vue';
import ApiSettings from '@/components/ApiSettings.vue';
import NewsList from '@/components/NewsList.vue';
import MarketBriefBanner from '@/components/MarketBriefBanner.vue';
import WhaleResonanceBanner from '@/components/WhaleResonanceBanner.vue';
import WhaleAlertDock from '@/components/WhaleAlertDock.vue';
import WhaleList from '@/components/WhaleList.vue';
import DataModule from '@/components/DataModule.vue';
import TradFiBoard from '@/components/TradFiBoard.vue';
import WhaleDetailDialog from '@/components/WhaleDetailDialog.vue';
import { createPageLoadScheduler } from '@/utils/pageLoadScheduler';
import { useWhaleStore } from '@/stores/whale';
import {
  authLoading,
  authUser,
  bootstrapAuth,
  isLoggedIn,
  login as authLogin,
  logout as authLogout,
} from '@/stores/auth';
import { useRealtime } from '@/composables/useRealtime';
import type { RecoQuotes } from '@/utils/recommend';
import { readFocusCoin } from '@/utils/recoPrefs';
import { preferredCoinsState } from '@/utils/watchedCoins';
import { coinIconCandidates } from '@/utils/coinIcons';
import { formatUsd } from '@/utils/format';
import { unlockAlertSound } from '@/utils/alertSound';
import { noteXTweets } from '@/stores/xFeed';
import type { XFeedTweet } from '@/api';
import type { WhaleProfile } from '@/types';

const whaleStore = useWhaleStore();

const brandIcons = coinIconCandidates('BTC');
const brandIconIdx = ref(0);
const brandIcon = computed(() => brandIcons[brandIconIdx.value] || '');

function onBrandIconError() {
  if (brandIconIdx.value < brandIcons.length - 1) brandIconIdx.value += 1;
}

const SIDE_TAB_STORAGE_KEY = 'whale-tracker:side-tab';
function readSideTab(): 'virtual' | 'tradfi' {
  try {
    return window.localStorage.getItem(SIDE_TAB_STORAGE_KEY) === 'tradfi' ? 'tradfi' : 'virtual';
  } catch { return 'virtual'; }
}
const sideTab = ref<'virtual' | 'tradfi'>(readSideTab());
watch(sideTab, (tab) => {
  try { window.localStorage.setItem(SIDE_TAB_STORAGE_KEY, tab); } catch { /* storage unavailable */ }
});
const radarRef = ref<InstanceType<typeof TradFiBoard> | null>(null);
const macroRef = ref<InstanceType<typeof DataModule> | null>(null);
const resonanceRef = ref<InstanceType<typeof WhaleResonanceBanner> | null>(null);
let pageLoader: ReturnType<typeof createPageLoadScheduler<'virtual' | 'tradfi'>> | null = null;
const whaleListRef = ref<InstanceType<typeof WhaleList> | null>(null);
const whaleDetailOpen = ref(false);
const whaleDetailId = ref('');
const whaleDetailProfile = computed(() => whaleStore.whalesById[whaleDetailId.value] || null);
const newsListRef = ref<InstanceType<typeof NewsList> | null>(null);
const quotes = ref<RecoQuotes>({});
const fundingRates = ref<Record<string, number>>({});
const flowCoin = ref<string>(readFocusCoin());
const flowWindow = ref<'15m' | '1h' | '4h' | '24h'>('1h');
const whaleSummary = computed(() => whaleStore.summary);
const whaleSnapshotVersion = computed(() => whaleStore.revision);
const whaleNetFlow = ref({ longUsd: 0, shortUsd: 0, netUsd: 0, events: 0, whales: 0 });
let flowRequestSeq = 0;
async function loadWhaleNetFlow() {
  const seq = ++flowRequestSeq;
  const data = await fetchAlertFlowSummary({
    window: flowWindow.value,
    coin: flowCoin.value === 'ALL' ? undefined : flowCoin.value,
  }).catch(() => null);
  if (seq !== flowRequestSeq || !data) return;
  whaleNetFlow.value = data;
}
watch([flowWindow, flowCoin], () => { if (pageLoader) void loadWhaleNetFlow(); });

const loginUser = ref('');
const loginPass = ref('');
const loginBusy = ref(false);
const authBootstrapped = ref(false);
let sessionStarted = false;

async function submitLogin() {
  if (loginBusy.value) return;
  loginBusy.value = true;
  try {
    await authLogin(loginUser.value.trim(), loginPass.value);
    ElMessage.success(`已登录：${authUser.value?.username || ''}`);
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

}

function onFocusWhaleCard(payload: { id: string; name: string; coin?: string }) {
  sideTab.value = 'virtual';
  nextTick(() => {
    void whaleListRef.value?.focusWhale({ id: payload.id, coin: payload.coin });
  });
}

function onSelectWhale(whale: WhaleProfile) {
  whaleStore.loadWhaleTrades(whale);
  whaleDetailId.value = whale.id;
  whaleDetailOpen.value = true;
}

function onSelectTransfers(whale: WhaleProfile) {
  whaleStore.loadWhaleTrades(whale);
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

let stateRetryTimer: ReturnType<typeof setTimeout> | undefined;
let flowRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let recoveringState = false;
let stateCatchupPending = false;
function scheduleFlowRefresh() {
  if (flowRefreshTimer) return;
  flowRefreshTimer = setTimeout(() => { flowRefreshTimer = undefined; if (sessionStarted) void loadWhaleNetFlow(); }, 1000);
}
const { status: transportStatus, start: startRealtime, stop: stopRealtime } = useRealtime((msg) => {
  if (msg.type === 'stateCommit') {
    if (stateCatchupPending) return;
    const outcome = whaleStore.applyCommit(msg);
    if (outcome === 'resync') void recoverState();
    else if (outcome === 'applied' && (msg.alerts?.length || msg.removedAlertIds?.length)) scheduleFlowRefresh();
  } else if (msg.type === 'resyncRequired') {
    void recoverState();
  } else if (msg.type === 'hello') {
    if (whaleStore.epoch && msg.epoch !== whaleStore.epoch) void recoverState();
  } else if (msg.type === 'caughtUp') {
    if (!stateCatchupPending && msg.epoch === whaleStore.epoch && msg.seq === whaleStore.revision) whaleStore.synced = true;
    else if (!stateCatchupPending) void recoverState();
  } else if (msg.type === 'xTweet' && Array.isArray(msg.tweets)) {
    noteXTweets(msg.tweets as unknown as XFeedTweet[]);
  }
}, () => whaleStore.cursor());
const realtimeStatus = computed(() => transportStatus.value === 'connected' && !whaleStore.synced ? 'connecting' : transportStatus.value);
watch(transportStatus, (status) => { if (status !== 'connected') whaleStore.synced = false; });

async function recoverState() {
  if (recoveringState || !sessionStarted) return;
  recoveringState = true;
  stateCatchupPending = true;
  stopRealtime();
  whaleStore.synced = false;
  const generation = sessionGeneration;
  try {
    await whaleStore.bootstrap();
    if (!sessionStarted || generation !== sessionGeneration) return;
    stateCatchupPending = false;
    startRealtime();
    void newsListRef.value?.initialize();
    scheduleFlowRefresh();
  } catch {
    if (sessionStarted && generation === sessionGeneration) stateRetryTimer = setTimeout(() => { stateRetryTimer = undefined; void recoverState(); }, 5000);
  } finally { if (generation === sessionGeneration) recoveringState = false; }
}

watch(
  preferredCoinsState,
  () => {
    if (flowCoin.value !== 'ALL' && !preferredCoinsState.value.includes(flowCoin.value)) {
      flowCoin.value = readFocusCoin();
    }
    if (pageLoader) { void loadQuotes(); void loadWhaleNetFlow(); }
  },
  { deep: true },
);

let sessionGeneration = 0;
async function startAppSession() {
  if (sessionStarted) return;
  sessionStarted = true;
  const generation = ++sessionGeneration;
  await nextTick();
  if (!sessionStarted || generation !== sessionGeneration) return;
  void recoverState();
  pageLoader = createPageLoadScheduler({
    virtual: async () => {
      await Promise.allSettled([
        whaleListRef.value?.initialize(),
        macroRef.value?.initialize(), resonanceRef.value?.initialize(),
        loadWhaleNetFlow(), loadQuotes(),
      ]);

    },
    tradfi: async () => { await radarRef.value?.initialize(); },
  });
  const primary = sideTab.value;
  await pageLoader.start(primary, primary === 'virtual' ? 'tradfi' : 'virtual',
    () => sessionStarted && generation === sessionGeneration);
  if (!sessionStarted || generation !== sessionGeneration) return;
}
watch(sideTab, (tab) => { if (sessionStarted && pageLoader) void pageLoader.load(tab); });

function stopAppSession() {
  sessionStarted = false;
  sessionGeneration += 1;
  recoveringState = false;
  stateCatchupPending = false;
  pageLoader = null;
  clearTimeout(stateRetryTimer); stateRetryTimer = undefined;
  clearTimeout(flowRefreshTimer); flowRefreshTimer = undefined;
  whaleStore.resetForHardRefresh();
  whaleDetailOpen.value = false;
  whaleDetailId.value = '';
  stopRealtime();
}

onMounted(async () => {
  document.documentElement.classList.add('dark');
  document.documentElement.classList.remove('light');
  unlockAlertSound();
  await bootstrapAuth();
  authBootstrapped.value = true;
  if (isLoggedIn.value) await startAppSession();
});

watch(isLoggedIn, (ok) => {
  if (!authBootstrapped.value) return;
  if (ok) void startAppSession();
  else stopAppSession();
});

onUnmounted(() => {
  stopAppSession();
});
</script>

<template>
  <div
    class="app-shell"
    :class="{
      'login-only': !authBootstrapped || !isLoggedIn,
    }"
    @pointerdown="unlockAlertSound"
  >
    <div v-if="!authBootstrapped" class="login-gate">
      <div class="login-gate-card">
        <p class="login-gate-title">Whale Tracker</p>
        <p class="login-gate-sub">正在验证登录状态…</p>
      </div>
    </div>

    <div v-else-if="!isLoggedIn" class="login-gate">
      <div class="login-gate-card">
        <p class="login-gate-title">Whale Tracker</p>
        <p class="login-gate-sub">请先登录后进入网站</p>
        <el-form class="login-form" label-position="top" @submit.prevent="submitLogin">
          <el-form-item label="用户名">
            <el-input
              v-model="loginUser"
              size="large"
              autocomplete="username"
              autofocus
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
          <el-button
            type="primary"
            size="large"
            class="login-gate-submit"
            :loading="loginBusy || authLoading"
            @click="submitLogin"
          >
            登录
          </el-button>
        </el-form>
      </div>
    </div>

    <template v-else>
    <WhaleAlertDock :dock-active="true" @focus-whale="onFocusWhaleCard" />

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
        :class="{ active: sideTab === 'virtual' }"
        title="Virtual"
        @click="sideTab = 'virtual'"
      >
        <span class="nav-mark brand" aria-hidden="true">
          <img class="brand-logo hl" :src="brandIcon" alt="" @error="onBrandIconError" />
        </span>
        <span>Virtual</span>
      </button>
      <button
        type="button"
        class="nav-item"
        :class="{ active: sideTab === 'tradfi' }"
        title="雷达"
        @click="sideTab = 'tradfi'"
      >
        <span class="nav-mark fi" aria-hidden="true">
          <svg class="fi-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 10 12 4l9 6" />
            <path d="M5 10.5V18M9.5 10.5V18M14.5 10.5V18M19 10.5V18" />
            <path d="M3 18.5h18" />
            <path d="M2 21h20" />
          </svg>
        </span>
        <span>雷达</span>
      </button>

      <div class="bottom-nav">
        <CoinPreferences variant="sidebar" :active-market="sideTab" />
        <ApiSettings variant="sidebar" />
        <button
          type="button"
          class="nav-item account"
          :title="authUser?.username || '账户'"
          @click="onLogout"
        >
          <span class="nav-mark user">{{ (authUser?.username || 'U').slice(0, 1).toUpperCase() }}</span>
          <span class="account-name">{{ authUser?.username || '账户' }}</span>
        </button>
      </div>
    </aside>

    <div class="layout" :class="{ 'is-tradfi': sideTab === 'tradfi' }">
      <div v-show="sideTab === 'virtual'" class="virtual-view">
      <header class="topbar">
        <div class="net-position-banner" :title="`所选时段内巨鲸开仓/加仓名义金额：多头 +${formatUsd(whaleNetFlow.longUsd)}，空头 −${formatUsd(whaleNetFlow.shortUsd)}；不含减仓和平仓`">
          <div class="net-flow-filters">
            <select v-model="flowWindow" aria-label="净流入统计时段">
              <option value="15m">15分钟</option>
              <option value="1h">1小时</option>
              <option value="4h">4小时</option>
              <option value="24h">24小时</option>
            </select>
            <select v-model="flowCoin" aria-label="净流入统计币种">
              <option value="ALL">全部</option>
              <option v-for="coin in preferredCoinsState" :key="coin" :value="coin">{{ coin }}</option>
            </select>
          </div>
          <div class="net-flow-value" :class="whaleNetFlow.netUsd >= 0 ? 'net-long' : 'net-short'">
            <strong>{{ whaleNetFlow.netUsd < 0 ? '−' : '+' }}{{ formatUsd(Math.abs(whaleNetFlow.netUsd)) }}</strong>
            <span>{{ whaleNetFlow.netUsd >= 0 ? '净流入' : '净流出' }}</span>
            <small>{{ whaleNetFlow.whales }} 巨鲸 · {{ whaleNetFlow.events }} 笔</small>
          </div>
        </div>
        <WhaleResonanceBanner
          ref="resonanceRef"
          :whales="whaleStore.displayWhales"
          :activity="whaleStore.activity"
          :alerts="whaleStore.alertHistory"
          :quotes="quotes"
          :ready="true"
          @focus-whale="onFocusWhaleCard"
        />
        <div class="topbar-right">
          <MarketBriefBanner />
        </div>
      </header>

      <el-alert
        v-if="whaleStore.error"
        class="warn"
        type="warning"
        :closable="false"
        :title="whaleStore.error"
      />

      <div class="whales-shell">
        <div class="grid">
          <DataModule
            ref="macroRef"
            :whales="whaleStore.displayWhales"
            :loading="whaleStore.loading"
            :selected-id="whaleStore.selectedWhaleId"
            :selected-name="whaleStore.selectedWhaleName"
            :updated-at="whaleStore.updatedAt"
            :quotes="quotes"
            :boot-ready="true"
            @focus-whale="onFocusWhaleCard"
          />

          <WhaleList
            ref="whaleListRef"
            :whales="whaleStore.displayWhales"
            :loading="whaleStore.loading"
            :selected-id="whaleStore.selectedWhaleId"
            :quotes="quotes"
            :server-summary="whaleSummary"
            :snapshot-version="whaleSnapshotVersion"
            @detail="onSelectWhale"
            @select-transfers="onSelectTransfers"
            @focus-whale="onFocusWhaleCard"
          />

          <NewsList
            ref="newsListRef"
            :alerts="whaleStore.alertHistory"
            :whales="whaleStore.enabledWhales"
            :funding-rates="fundingRates"
            :filter-whale-id="whaleStore.selectedWhaleId"
            :boot-ready="true"
            :realtime-connected="realtimeStatus === 'connected'"
            @locate-whale="onFocusWhaleCard"
            @focus-whale="onFocusWhale"
          />
        </div>
      </div>
      </div>
      <TradFiBoard ref="radarRef" v-show="sideTab === 'tradfi'" class="tradfi-host" />
    </div>
    <WhaleDetailDialog v-model="whaleDetailOpen" :whale="whaleDetailProfile" :snapshot-updated-at="whaleStore.updatedAt" />
    </template>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  height: 100vh;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
}
.app-shell.login-only {
  display: block;
}
.login-gate {
  width: 100%;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 24px;
  background:
    radial-gradient(ellipse 80% 50% at 50% -20%, rgba(61, 125, 255, 0.22), transparent),
    var(--bg);
}
.login-gate-card {
  width: min(400px, 100%);
  padding: 32px 28px 28px;
  border-radius: 16px;
  border: 1px solid var(--border);
  background: var(--card);
  box-shadow: 0 24px 48px rgba(0, 0, 0, 0.35);
}
.login-gate-title {
  margin: 0;
  font-size: 22px;
  font-weight: 800;
  letter-spacing: 0.02em;
  color: var(--text);
}
.login-gate-sub {
  margin: 8px 0 24px;
  font-size: 14px;
  color: var(--muted);
}
.login-gate-submit {
  width: 100%;
  margin-top: 4px;
  min-height: 44px;
  border-radius: 12px !important;
}

.sidebar {
  width: 72px;
  background: var(--bg-2);
  border-right: 1px solid var(--border);
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
  background: var(--soft);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--soft) 22%, transparent);
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
  background: var(--green);
  box-shadow: 0 0 6px color-mix(in srgb, var(--green) 55%, transparent);
}
.sidebar .socket-dot.connected {
  color: var(--green);
}
.sidebar .socket-dot.connected::before,
.sidebar .socket-dot.connected::after {
  animation: socket-ripple 2.8s ease-out infinite;
}
.sidebar .socket-dot.connected::after {
  animation-delay: 1.4s;
}
.sidebar .socket-dot.connecting .socket-core {
  background: var(--orange);
  box-shadow: 0 0 6px color-mix(in srgb, var(--orange) 55%, transparent);
}
.sidebar .socket-dot.connecting {
  color: var(--orange);
}
.sidebar .socket-dot.connecting::before,
.sidebar .socket-dot.connecting::after {
  animation: socket-ripple 1.8s ease-out infinite;
}
.sidebar .socket-dot.connecting::after {
  animation-delay: 0.9s;
}
.sidebar .socket-dot.disconnected .socket-core {
  background: var(--soft);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--soft) 22%, transparent);
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
  min-height: 56px;
  height: auto;
  padding: 6px 2px;
  border-radius: 14px;
  color: var(--muted);
  font-size: 8px;
  font-weight: 600;
  font-family: inherit;
  line-height: 1.15;
  letter-spacing: -0.02em;
  text-align: center;
  word-break: break-word;
  gap: 2px;
  margin-bottom: 4px;
  cursor: pointer;
  background: transparent;
  border: none;
  transition: background 0.15s, color 0.15s;
  box-sizing: border-box;
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
  background: var(--panel-2);
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
  background: var(--red);
  color: #fff;
  font-size: 9px;
  font-weight: 800;
  line-height: 14px;
  text-align: center;
  box-sizing: border-box;
  pointer-events: none;
  box-shadow: 0 0 0 1px var(--bg-2);
}
.sidebar .nav-item .nav-mark .brand-logo {
  width: 22px;
  height: 22px;
  display: block;
}
.sidebar .nav-item .nav-mark .brand-logo.hl {
  border-radius: 50%;
  object-fit: cover;
}
.sidebar .nav-item .nav-mark.fi {
  background: transparent;
  color: inherit;
}
.sidebar .nav-item .fi-icon {
  width: 22px;
  height: 22px;
  display: block;
}
.sidebar .nav-item .nav-mark.user {
  background: var(--panel-3);
  border-radius: 50%;
  font-size: 11px;
}
.sidebar .nav-item.active {
  background: var(--panel-3);
  color: var(--yellow);
}
.sidebar .nav-item.active .nav-mark.user {
  background: color-mix(in srgb, var(--yellow) 18%, var(--panel-3));
  color: var(--yellow);
}
.sidebar .nav-item:hover {
  background: var(--panel-2);
  color: var(--text);
}
.sidebar .bottom-nav {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  border-top: 1px solid var(--border);
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
  padding: 0;
  background: var(--bg);
  box-sizing: border-box;
  position: relative;
}
.virtual-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 16px 24px;
  box-sizing: border-box;
}
.tradfi-host {
  flex: 1;
  width: 100%;
  min-height: 0;
  min-width: 0;
  overflow-x: hidden;
  overflow-y: auto;
}
.topbar {
  /* 与下方 .grid 三列对齐：共振信号落在巨鲸列正上方 */
  display: grid;
  grid-template-columns:
    minmax(120px, calc((100% - 24px) * 0.25 - 80px))
    minmax(0, calc((100% - 24px) * 0.5))
    minmax(200px, calc((100% - 24px) * 0.25 + 80px));
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  min-width: 0;
  min-height: 44px;
}
.net-position-banner { display: flex; align-items: center; justify-content: space-between; gap: 7px; min-width: 0; height: 44px; padding: 0 8px 0 10px; border: 1px solid var(--border); border-radius: 10px; background: color-mix(in srgb, var(--panel-2) 82%, transparent); box-sizing: border-box; }
.net-flow-filters,.net-flow-value { display: flex; align-items: center; min-width: 0; }
.net-flow-filters { gap: 4px; }
.net-flow-title { flex: none; color: var(--muted); font-size: 12px; font-weight: 700; white-space: nowrap; }
.net-flow-filters select { max-width: 68px; height: 28px; padding: 0 4px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel-2); color: var(--text); font-size: 11px; cursor: pointer; }
.net-flow-value { justify-content: flex-end; gap: 5px; overflow: hidden; white-space: nowrap; }
.net-flow-value strong { overflow: hidden; color: var(--green); font: 700 14px ui-monospace, SFMono-Regular, Consolas, monospace; text-overflow: ellipsis; }
.net-flow-value.net-short strong,.net-flow-value.net-short span { color: var(--red); }
.net-flow-value span { color: var(--green); font-size: 10px; font-weight: 700; }
.net-flow-value small { color: var(--muted); font-size: 9px; }
.topbar-right {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  min-width: 0;
}
.topbar :deep(.resonance-wrap) {
  width: 100%;
  max-width: 100%;
  min-width: 0;
}
.topbar :deep(.notice-wrap),
.topbar :deep(.liq-wrap) {
  width: 100%;
  max-width: 100%;
  min-width: 0;
}
.topbar :deep(.ai-launcher) {
  position: static;
  flex: none;
}
.login-form :deep(.el-form-item) {
  margin-bottom: 18px;
}
.login-form :deep(.el-form-item__label) {
  font-weight: 700;
  color: var(--muted);
}
.login-form :deep(.el-input__wrapper) {
  min-height: 44px;
  padding: 4px 14px;
  border-radius: 12px;
  background: var(--bg-2);
  box-shadow: 0 0 0 1px var(--border) inset;
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
</style>
