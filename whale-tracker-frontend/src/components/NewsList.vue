<script setup lang="ts">
import { reactive, computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Refresh } from '@element-plus/icons-vue';
import type { WhaleProfile } from '@/types';
import {
  normalizeStoredAlert,
  alertEventTime,
  alertItemSide,
  scopeAlertToCoin,
  scopeAlertToSide,
  type AlertLayer,
  type WhaleAlert,
} from '@/utils/whaleAlerts';
import { preferredCoinsState, coinMatchesWatch } from '@/utils/watchedCoins';
import { isExoticAsset } from '@/utils/assets';
import {
  ALERT_MIN_USD_OPTIONS,
  enrichAlertView,
  readAlertMinUsd,
  writeAlertMinUsd,
} from '@/utils/alertView';
import {
  directionLabel,
  formatLeverage,
  formatPnl,
  formatPrice,
  formatTime,
  formatTimeShort,
  formatUsd,
} from '@/utils/format';
import { resolveWhaleTitle } from '@/utils/whaleReference';
import { fundingFollowWarning, fundingOf } from '@/utils/fundingAlert';
import MobileAlerts from './mobile/MobileAlerts.vue';
import WhaleLocateLink from '@/components/WhaleLocateLink.vue';
import { useWhaleStore } from '@/stores/whale';
import { getAuthUiSettings, patchAuthUiSettings } from '@/stores/auth';
import { fetchPagedAlertHistory } from '@/api';

const whaleStore = useWhaleStore();

const props = defineProps<{
  mobile?:boolean;
  /** @deprecated 列表已改服务端分页，保留仅兼容旧调用 */
  alerts?: WhaleAlert[];
  whales?: WhaleProfile[];
  fundingRates?: Record<string, number>;
  bottomPanel?: boolean;
  linkedCoin?: string;
  windowMs?: number;
  filterWhaleId?: string;
  /** 巨鲸首屏就绪后再拉异动 */
  bootReady?: boolean;
  /** WebSocket 正常时不再用固定轮询重复请求异动分页 */
  realtimeConnected?: boolean;
}>();

const emit = defineEmits<{
  focusWhale: [whale: { id: string; name: string }];
  locateWhale: [payload: { id: string; name: string; coin?: string }];
}>();

const preferredCoins = preferredCoinsState;

const alertSideFilter = ref<'all' | 'long' | 'short'>('all');
const openOnly = ref(false);
const alertCoinFilter = ref<'all' | string>('all');
watch(() => props.linkedCoin, coin => { if (coin) alertCoinFilter.value = coin === 'ALL' ? 'all' : coin; }, { immediate: true });
const alertMinUsd = ref(readAlertMinUsd());
const ALERT_DISPLAY_LIMIT = 50;
const alertWindowLabel = computed(() => {
  const ms = props.windowMs;
  if (!ms) return '历史';
  if (ms > 86400000 && ms % 86400000 === 0) return `近 ${ms / 86400000} 天`;
  if (ms >= 3600000 && ms % 3600000 === 0) return `近 ${ms / 3600000} 小时`;
  return `近 ${Math.ceil(ms / 60000)} 分钟`;
});
const activeAlertId = ref('');
const activeAlert = computed(() => whaleStore.alertsById[activeAlertId.value] || null);
const alertVisible = ref(false);
const pageAlertIds = ref<string[]>([]);
const pageAlerts = computed(() => [...new Set([...pageAlertIds.value, ...whaleStore.alertHistory.map(alert => alert.id)])]
  .map(id => whaleStore.alertsById[id]).filter((alert): alert is WhaleAlert => Boolean(alert && alertMatchesListFilters(alert)))
  .sort((a, b) => alertEventTime(b) - alertEventTime(a)).slice(0, ALERT_DISPLAY_LIMIT));
const alertLoading = ref(false);
const liveAnimations = ref<Record<string, 'new' | 'update'>>({});
const animationTimers = new Map<string, ReturnType<typeof setTimeout>>();
function animateLiveAlerts(rows: Array<{ id: string; isNew: boolean }>) {
  if (document.hidden || alertLoading.value || !started) return;
  const visibleIds = new Set(pagedAlerts.value.map(row => row.alert.id));
  for (const row of rows) {
    if (!visibleIds.has(row.id) || animationTimers.has(row.id)) continue;
    liveAnimations.value[row.id] = row.isNew ? 'new' : 'update';
    animationTimers.set(row.id, setTimeout(() => {
      delete liveAnimations.value[row.id];
      animationTimers.delete(row.id);
    }, 1600));
  }
}
const alertFiltersReady = ref(false);
let alertReqSeq = 0;
let suppressAutoAlertReload = false;

/** 驱动「N分钟前」相对时间每分钟重算（computed 不会因 Date.now 自动刷新） */
const nowTick = ref(Date.now());
let nowTickTimer: ReturnType<typeof setInterval> | undefined;

onMounted(async () => {
  const s = getAuthUiSettings();
  // Removed controls must not leave invisible persisted filters active.
  alertSideFilter.value = 'all';
  openOnly.value = false;
  if (typeof s.alertCoinFilter === 'string' && s.alertCoinFilter) {
    alertCoinFilter.value = s.alertCoinFilter;
  }
  if (typeof s.alertMinUsd === 'number') {
    alertMinUsd.value = s.alertMinUsd;
  }
  await nextTick();
  alertFiltersReady.value = true;
  // Only initialize filters here; the page scheduler starts the first request.

  nowTickTimer = setInterval(() => {
    nowTick.value = Date.now();
  }, 30_000);
});

onUnmounted(() => {
  if (nowTickTimer) clearInterval(nowTickTimer);
  for (const timer of animationTimers.values()) clearTimeout(timer);
  animationTimers.clear();
  alertReqSeq += 1; pendingPage = null;

});

let initialLoad: Promise<void> | null = null;
let started = false;
function initialize() {
  return initialLoad ||= (async () => { await nextTick(); started = true; await loadAlertPage(); })();
}

watch([alertSideFilter, openOnly, alertCoinFilter, alertMinUsd], () => {
  patchAuthUiSettings({
    alertSideFilter: alertSideFilter.value,
    openOnly: openOnly.value,
    alertCoinFilter: alertCoinFilter.value,
    alertMinUsd: alertMinUsd.value,
  });
});

async function loadAlertPage(silent = false) {
  const seq = ++alertReqSeq;
  if (!silent) alertLoading.value = true;
  try {
    const selectedCoin = alertCoinFilter.value === 'all' ? '' : alertCoinFilter.value.toUpperCase();
    const normalizedCoin = selectedCoin.replace(/^[UK]/, '');
    const data = await fetchPagedAlertHistory({
      whaleId: props.filterWhaleId || undefined,
      kind: (openOnly.value ? 'open' : 'all') as 'open' | 'all',
      minUsd: alertMinUsd.value || undefined,
      page: 1,
      limit: ALERT_DISPLAY_LIMIT,
      side: alertSideFilter.value,
      coins: selectedCoin ? [...new Set([selectedCoin, `K${normalizedCoin}`, `U${normalizedCoin}`])] : undefined,
      excludeExotic: true,
      sinceMs: props.windowMs ? Date.now() - props.windowMs : undefined,
    });
    if (seq !== alertReqSeq) return;
    const list = (data.alerts || [])
      .map((raw) => normalizeStoredAlert(raw as WhaleAlert))
      .filter((item): item is WhaleAlert => Boolean(item?.id && hasListEligibleItem(item)));
    pendingPage = { data, list, request: seq };
    installPendingPage();
    return true;
  } catch (err) {
    if (seq !== alertReqSeq) return;
    if (!silent) {

      ElMessage.error(err instanceof Error ? err.message : '异动加载失败');
    }
    return false;
  } finally {
    if (seq === alertReqSeq) alertLoading.value = false;
  }
}
type AlertPage = Awaited<ReturnType<typeof fetchPagedAlertHistory>>;
let pendingPage: { data: AlertPage; list: WhaleAlert[]; request: number } | null = null;
function installPendingPage() {
  const pending = pendingPage;
  if (!pending || pending.request !== alertReqSeq) return;
  const { data, list } = pending;
  if (data.epoch !== whaleStore.epoch) { pendingPage = null; return; }
  if (data.seq > whaleStore.revision) return; // WS replay must catch up first.
  if (data.seq < whaleStore.minimumAlertQuerySeq) { pendingPage = null; void loadAlertPage(true); return; }
  if (!whaleStore.acceptAlertPage(list, { epoch: data.epoch, seq: data.seq })) return;
  pendingPage = null;
  pageAlertIds.value = list.map(alert => alert.id);

}
watch(() => [whaleStore.epoch, whaleStore.revision], installPendingPage);
watch(() => whaleStore.epoch, () => {
  pageAlertIds.value = []; pendingPage = null;
  if (started && whaleStore.epoch) void loadAlertPage(true);
});
function openAlert(item: WhaleAlert) {
  activeAlertId.value = item.id;
  alertVisible.value = true;
}

function viewAlertTrades() {
  if (!activeAlert.value) return;
  emit('focusWhale', { id: activeAlert.value.whaleId, name: activeAlert.value.whaleName });
  alertVisible.value = false;
}

function locateFromAlert(alert: WhaleAlert) {
  emit('locateWhale', {
    id: alert.whaleId,
    name: alert.whaleName,
  });
}

const filterWhaleName = computed(() => {
  if (!props.filterWhaleId) return '';
  const whale = props.whales?.find((item) => item.id === props.filterWhaleId);
  if (whale) return resolveWhaleTitle(props.whales, { id: whale.id, name: whale.name, address: whale.address });
  return resolveWhaleTitle(props.whales, { id: props.filterWhaleId });
});

/** 开仓/加仓记录：当前已无同币同向仓位 → 已平仓或已换向 */
function isOpenPositionClosed(alert: WhaleAlert): boolean {
  const kind = alertItemKind(alert);
  if (kind !== 'open' && kind !== 'increase') return false;
  const view = enrichAlertView(alert, whaleOf(alert));
  const coin = view.coin;
  const side = view.side;
  if (!coin || coin === '--' || !side) return false;
  const whale = whaleOf(alert);
  if (!whale) return false;
  const stillOpen = (whale.positions || []).some(
    (pos) =>
      (coinMatchesWatch(pos.coin, [coin]) || coinMatchesWatch(pos.coinLabel || '', [coin])) &&
      pos.side === side &&
      Math.abs(Number(pos.positionValue) || 0) >= 100,
  );
  return !stillOpen;
}

const alertRefreshing = ref(false);

/** 只重新请求异动列表当前页；不触发巨鲸仓位刷新或批次加载。 */
async function onRefreshAlerts() {
  if (alertRefreshing.value) return;
  alertRefreshing.value = true;
  suppressAutoAlertReload = true;
  try {
    // 刷新入口回到初始「全部异动」视图，不沿用当前巨鲸/币种/方向筛选。
    whaleStore.clearWhaleFilter();
    alertSideFilter.value = 'all';
    openOnly.value = false;
    alertCoinFilter.value = 'all';
    alertMinUsd.value = 0;
    await nextTick();
    const loaded = await loadAlertPage();
    if (loaded) ElMessage.success('异动记录已刷新');
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '异动刷新失败');
  } finally {
    suppressAutoAlertReload = false;
    alertRefreshing.value = false;
  }
}

function alertItemKind(alert: WhaleAlert) {
  return alert.items?.[0]?.kind || alert.kind;
}

const filteredAlerts = computed(() => {
  const side = alertSideFilter.value;
    return pageAlerts.value
    .map((alert) => {
      let scoped = { ...alert, items: eligibleItems(alert) };
      if (alertCoinFilter.value !== 'all') {
        scoped = scopeAlertToCoin(scoped, alertCoinFilter.value);
      }
      if (side !== 'all') {
        scoped = scopeAlertToSide(scoped, side);
      }
      const view = enrichAlertView(scoped, whaleOf(scoped), nowTick.value);
      return {
        alert: scoped,
        view,
        closedOpen: isOpenPositionClosed(scoped),
      };
    })
    .filter((row) => Boolean(row.alert?.items?.length));
});

const pagedAlerts = computed(() => filteredAlerts.value);

watch(
  [
    alertSideFilter,
    openOnly,
    alertCoinFilter,
    alertMinUsd,
    () => props.filterWhaleId,
    () => props.windowMs,
    preferredCoins,
  ],
  () => {
    if (!started || !alertFiltersReady.value || suppressAutoAlertReload) return;
    void loadAlertPage();
  },
);

watch(alertMinUsd, (value) => {
  writeAlertMinUsd(value);
});

watch(preferredCoinsState, (coins) => {
  if (alertCoinFilter.value === 'all') return;
  if (!coins.includes(alertCoinFilter.value)) alertCoinFilter.value = 'all';
});

function alertMatchesListFilters(alert: WhaleAlert) {
  if (props.filterWhaleId && alert.whaleId !== props.filterWhaleId) return false;
  const items = eligibleItems(alert);
  if (!items.length) return false;
  if (
    alertSideFilter.value !== 'all' &&
    !items.some((item) => alertItemSide(alert, item) === alertSideFilter.value)
  ) return false;
  return true;
}

function eligibleItems(alert: WhaleAlert) {
  return (alert.items || []).filter((item) => {
    if (props.windowMs && (Number(item.time) || Number(alert.at)) < nowTick.value - props.windowMs) return false;
    if (isExoticAsset(String(item.coin || ''))) return false;
    if (alertCoinFilter.value !== 'all' && !coinMatchesWatch(item.coin, [alertCoinFilter.value])) return false;
    if (openOnly.value && item.kind !== 'open') return false;
    if (alertMinUsd.value > 0 && Math.abs(Number(item.usd) || 0) < alertMinUsd.value) return false;
    return true;
  });
}

function hasListEligibleItem(alert: WhaleAlert) {
  return eligibleItems(alert).length > 0;
}

defineExpose({
  setCoinFilter: (coin: string) => { alertCoinFilter.value = coin === 'ALL' ? 'all' : coin; },
  showLatest: () => { document.querySelector('.news-scroll')?.scrollTo({ top: 0, behavior: 'smooth' }); },
  initialize,
  animateLiveAlerts,
  reloadAlerts: (silent = true) => loadAlertPage(silent),
});

function whaleOf(alert: WhaleAlert) {
  return props.whales?.find((item) => item.id === alert.whaleId) || null;
}

const activeView = computed(() =>
  activeAlert.value ? enrichAlertView(activeAlert.value, whaleOf(activeAlert.value), nowTick.value) : null,
);
const activeClosedOpen = computed(() => (activeAlert.value ? isOpenPositionClosed(activeAlert.value) : false));

function pnlClass(value: number | null | undefined) {
  if (value == null || value === 0) return '';
  return value > 0 ? 'up' : 'down';
}

function alertEmptyText() {
  const base = `${alertWindowLabel.value}暂无开仓 / 补仓记录`;
  const parts: string[] = [];
  if (props.filterWhaleId && filterWhaleName.value) parts.push(filterWhaleName.value);
  if (alertMinUsd.value > 0) parts.push(`≥${formatUsd(alertMinUsd.value)}`);
  if (alertSideFilter.value === 'long') parts.push('做多');
  if (alertSideFilter.value === 'short') parts.push('做空');
  if (openOnly.value) parts.push('开仓');
  if (alertCoinFilter.value !== 'all') parts.push(alertCoinFilter.value);
  if (!parts.length) return base;
  return `${alertWindowLabel.value}暂无${parts.join(' · ')}的开仓 / 补仓记录`;
}

function sideBadgeClass(view: { layer: AlertLayer; side: 'long' | 'short' | null; actionLabel: string }) {
  if (view.layer === 'fill') {
    return view.actionLabel === '卖出' ? 'short' : 'long';
  }
  if (view.layer === 'transfer') {
    return view.actionLabel.includes('转出') ? 'short' : 'long';
  }
  return view.side || '';
}

function closedOpenClass(side: 'long' | 'short' | null) {
  return side === 'short' ? 'closed-short' : 'closed-long';
}

function timeBucketClass(bucket: string) {
  if (bucket === 'fresh') return 'time-fresh';
  if (bucket === 'mid') return 'time-mid';
  return 'time-stale';
}

function actionTypeClass(type: string) {
  if (type === 'open') return 'action-open';
  if (type === 'close') return 'action-close';
  return 'action-other';
}

function alertFundingWarn(row: {
  view: { side: 'long' | 'short' | null; coin: string; actionType: string; layer: AlertLayer };
}) {
  if (row.view.layer !== 'position') return null;
  if (row.view.actionType === 'close') return null;
  return fundingFollowWarning(row.view.side, fundingOf(props.fundingRates, row.view.coin));
}
// Shared controller, independent PC and H5 views.
async function refreshMobile(){if(alertLoading.value)return;if(!await loadAlertPage(true))throw new Error('刷新失败，保留原异动记录');}
const mobileModel = reactive({ refreshMobile, alertCoinFilter, alertMinUsd, alertSideFilter, openOnly, preferredCoins, ALERT_MIN_USD_OPTIONS, pagedAlerts, alertLoading, alertRefreshing, alertWindowLabel, alertEmptyText, openAlert, formatUsd, formatPrice, alertFundingWarn, onRefreshAlerts });
export type AlertsModel = typeof mobileModel;
</script>

<template>
  <MobileAlerts v-if="mobile" :model="mobileModel" />
  <el-card v-else class="panel" :class="{ 'news-bottom-panel': bottomPanel }" shadow="never">
    <template #header>
      <div class="head">
        <div class="coin-filter-row">
          <div class="coin-filter">
            <button
              type="button"
              class="coin-chip"
              :class="{ on: alertCoinFilter === 'all' }"
              @click="alertCoinFilter = 'all'"
            >
              全部
            </button>
            <button
              v-for="coin in preferredCoins"
              :key="coin"
              type="button"
              class="coin-chip"
              :class="{ on: alertCoinFilter === coin }"
              @click="alertCoinFilter = coin"
            >
              {{ coin }}
            </button>
          </div>
          <div class="head-actions">
            <el-select v-model="alertMinUsd" size="small" class="alert-filter wide" placeholder="金额">
              <el-option
                v-for="opt in ALERT_MIN_USD_OPTIONS"
                :key="opt.value"
                :label="opt.label"
                :value="opt.value"
              />
            </el-select>
            <el-button
              circle
              size="small"
              :icon="Refresh"
              :loading="alertRefreshing"
              title="刷新异动记录"
              @click="onRefreshAlerts"
            />
          </div>
        </div>
      </div>
    </template>

    <div class="tab-panel">
      <div class="alert-toolbar">
        <span class="alert-scope">{{ alertWindowLabel }} · 最新 {{ ALERT_DISPLAY_LIMIT }} 条开仓 / 加仓记录</span>
        <div v-if="filterWhaleName" class="whale-link-chip" :title="filterWhaleName">
          <span class="chip-label">联动</span>
          <span class="chip-name">{{ filterWhaleName }}</span>
        </div>
      </div>
      <el-empty v-if="!alertLoading && !filteredAlerts.length" :description="alertEmptyText()" />
      <div v-else class="news-scroll" v-loading="alertLoading">
        <div class="news">
        <button
          v-for="row in pagedAlerts"
          :key="row.alert.id"
          type="button"
          class="news-item alert-item"
          :class="[row.view.amountClass, `layer-${row.view.layer}`, liveAnimations[row.alert.id] && `live-${liveAnimations[row.alert.id]}`]"
          @click="openAlert(row.alert)"
        >
          <div class="alert-head">
            <span
              v-if="row.view.sideBadgeLabel"
              class="side-badge"
              :class="sideBadgeClass(row.view)"
            >
              {{ row.view.sideBadgeLabel }}
            </span>
            <span
              v-if="alertFundingWarn(row)"
              class="funding-warn"
              :title="alertFundingWarn(row)?.text"
            >高费率</span>
            <span class="action-badge" :class="actionTypeClass(row.view.actionType)">
              {{ row.view.actionLabel }}
            </span>
            <span
              v-if="row.closedOpen"
              class="closed-tag"
              :class="closedOpenClass(row.view.side)"
            >（已平仓）</span>
            <span class="rel-time" :class="timeBucketClass(row.view.timeBucket)">
              {{ row.view.relativeTime }}
            </span>
          </div>
          <div class="alert-main">
            <strong class="coin">{{ row.view.coin }}</strong>
            <strong class="notional" :class="row.view.amountClass">
              名义 {{ row.view.notionalUsd != null ? formatUsd(row.view.notionalUsd) : '--' }}
            </strong>
          </div>
          <div class="alert-specs">
            <span>成交价 {{ formatPrice(row.view.price) }}</span>
            <span v-if="row.view.showLeverage">杠杆 {{ formatLeverage(row.view.leverage) }}</span>
            <span v-if="row.view.showMargin">
              保证金 {{ formatUsd(row.view.marginUsd!) }}
            </span>
            <span
              v-if="row.view.pnl != null && row.view.pnl !== 0"
              :class="pnlClass(row.view.pnl)"
            >
              {{ row.view.actionType === 'close' ? '已实现' : '浮盈' }}
              {{ formatPnl(row.view.pnl) }}
            </span>
          </div>
          <div v-if="row.view.verifyText" class="alert-verify">{{ row.view.verifyText }}</div>
          <div class="alert-foot">
            <WhaleLocateLink
              :id="row.alert.whaleId"
              :name="row.alert.whaleName"
              :address="row.alert.address"
              :whales="whales"
              class="whale-name"
              @locate="emit('locateWhale', $event)"
            />
            <span
              v-if="row.alert.items?.[0]?.timeSource === 'observed'"
              class="abs-time"
              title="这是快照发现时间，不代表实际成交时间"
            >
              发现 ·
            </span>
            <span class="abs-time">{{ formatTimeShort(row.view.eventTime) }}</span>
          </div>
        </button>
        </div>
      </div>
    </div>

  </el-card>
    <el-dialog
      v-model="alertVisible"
      width="560px"
      append-to-body
      class="pos-dialog"
    >
      <template #header>
        <div v-if="activeAlert" class="alert-dialog-head">
          <WhaleLocateLink
            :id="activeAlert.whaleId"
            :name="activeAlert.whaleName"
            :address="activeAlert.address"
            :whales="whales"
            @locate="locateFromAlert(activeAlert); alertVisible = false"
          />
          <span class="dim">· {{ activeAlert.kindLabel }}</span>
        </div>
        <span v-else>异动记录</span>
      </template>
      <template v-if="activeAlert && activeView">
        <div class="detail">
          <p v-if="activeAlert.qualityNote" class="dim">{{ activeAlert.qualityNote }}</p>
          <div class="detail-row">
            <span>类型</span>
            <strong>
              {{ activeView.actionLabel }}
              <span
                v-if="activeClosedOpen"
                class="closed-tag"
                :class="closedOpenClass(activeView.side)"
              >（已平仓）</span>
            </strong>
          </div>
          <div class="detail-row">
            <span>方向</span>
            <strong :class="activeView.side === 'long' ? 'up' : activeView.side === 'short' ? 'down' : ''">
              {{ activeView.side ? directionLabel(activeView.side) : '--' }}
            </strong>
          </div>
          <div class="detail-row">
            <span>成交价</span>
            <strong>{{ formatPrice(activeView.price) }}</strong>
          </div>
          <div class="detail-row">
            <span>时间</span>
            <strong>
              {{ activeView.relativeTime }}
              <span class="dim">（{{ formatTime(activeView.eventTime) }}）</span>
            </strong>
          </div>
          <div v-if="activeView.showLeverage" class="detail-row">
            <span>杠杆</span>
            <strong>{{ formatLeverage(activeView.leverage) }}</strong>
          </div>
          <div class="detail-row">
            <span>名义仓位</span>
            <strong :class="activeView.amountClass">
              {{ activeView.notionalUsd != null ? formatUsd(activeView.notionalUsd) : '--' }}
            </strong>
          </div>
          <div v-if="activeView.showMargin" class="detail-row">
            <span>保证金</span>
            <strong>{{ formatUsd(activeView.marginUsd!) }}</strong>
          </div>
          <div class="detail-row">
            <span>{{ activeView.actionType === 'close' ? '已实现盈亏' : '浮盈' }}</span>
            <strong :class="pnlClass(activeView.pnl)">
              {{ formatPnl(activeView.pnl) }}
            </strong>
          </div>
          <div v-if="activeView.verifyText" class="detail-row verify-row">
            <span>成交验证</span>
            <strong class="verify-text">{{ activeView.verifyText }}</strong>
          </div>
        </div>
      </template>
      <template #footer>
        <div class="actions">
          <el-button type="primary" @click="viewAlertTrades">定位该巨鲸</el-button>
        </div>
      </template>
    </el-dialog>
</template>

<style scoped>
.panel {
  height: 100%;
  min-height: 0;
  min-width: 0;
  background: var(--card);
  border: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}
.panel :deep(.el-card__header) {
  padding: 10px 14px 4px;
  border-bottom: none;
}
.panel :deep(.el-card__body) {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  padding-top: 2px;
}
.tab-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  gap: 2px;
}
.head {
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
}
.coin-filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  margin-left: auto;
}
.alert-scope { color: var(--muted); font-size: 11px; line-height: 1.5; }
.alert-toolbar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 0;
  margin-bottom: 4px;
  padding: 0;
  border: none;
}
.side-filter {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
}
.side-chip {
  box-sizing: border-box;
  flex: 1 1 0;
  width: auto;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  padding: 4px 8px;
  cursor: pointer;
}
.side-chip.long.on {
  color: var(--bull);
  border-color: color-mix(in srgb, var(--bull) 45%, var(--border));
  background: color-mix(in srgb, var(--bull) 12%, transparent);
}
.side-chip.short.on {
  color: var(--bear);
  border-color: color-mix(in srgb, var(--bear) 45%, var(--border));
  background: color-mix(in srgb, var(--bear) 12%, transparent);
}
.open-text-toggle {
  flex: 0 0 auto;
  appearance: none;
  border: 0;
  background: transparent;
  padding: 4px 6px;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  color: #6b7785;
  cursor: pointer;
  line-height: 1;
}
.open-text-toggle.on {
  color: #409eff;
  font-weight: 800;
}
.chip-text {
  flex: 0 0 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip-count {
  flex: 0 0 2.75ch;
  width: 2.75ch;
  min-width: 2.75ch;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  line-height: 1.1;
  text-align: right;
  color: var(--muted);
}
.layer-chip.on .chip-count,
.coin-chip.on .chip-count,
.side-chip.on .chip-count {
  color: inherit;
  opacity: 0.85;
}
.closed-tag {
  font-size: 12px;
  font-weight: 800;
  white-space: nowrap;
}
.closed-tag.closed-long {
  color: var(--bear);
}
.closed-tag.closed-short {
  color: var(--bull);
}
.layer-filter {
  display: flex;
  flex-wrap: nowrap;
  gap: 6px;
  width: 100%;
}
.layer-chip {
  box-sizing: border-box;
  flex: 1 1 0;
  width: 0;
  min-width: 0;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--card) 70%, transparent);
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.layer-chip .chip-text {
  font-size: 12px;
  font-weight: 700;
  line-height: 1.2;
}
.layer-chip .chip-count {
  flex: 0 0 auto;
  width: 2.75ch;
  min-width: 2.75ch;
  font-size: 11px;
  text-align: center;
}
.layer-chip.on {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.coin-filter {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  flex: 1 1 auto;
  min-width: 0;
}
.coin-chip {
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  padding: 4px 10px;
  cursor: pointer;
}
.coin-chip.on {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.alert-filter {
  width: 108px;
  min-width: 108px;
}
.alert-filter.wide {
  width: 108px;
  min-width: 108px;
}
.alert-verify {
  margin-top: 6px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.4;
}
.verify-row strong.verify-text {
  font-size: 13px;
  font-weight: 600;
  text-align: right;
  color: var(--muted);
}
.alert-item.layer-fill,
.alert-item.layer-transfer {
  border-style: dashed;
}
.alert-toolbar-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  max-width: 100%;
  margin-left: auto;
}
.whale-link-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  padding: 6px 10px;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  font-size: 12px;
  line-height: 1.3;
  box-sizing: border-box;
}
.whale-link-chip .chip-label {
  flex: 0 0 auto;
  color: var(--muted);
  font-weight: 600;
}
.whale-link-chip .chip-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--accent);
  font-weight: 700;
}
.alert-dialog-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 16px;
  font-weight: 700;
}
.alert-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.side-badge {
  padding: 3px 10px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 800;
  line-height: 1.2;
}
.side-badge.long {
  color: #fff;
  background: var(--bull);
}
.side-badge.short {
  color: #fff;
  background: var(--bear);
}
.funding-warn {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 800;
  color: #f0a020;
  background: color-mix(in srgb, #e6a23c 18%, transparent);
  white-space: nowrap;
}
.action-badge {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  border: 1px solid var(--border);
}
.action-badge.action-open {
  color: var(--bull);
  border-color: color-mix(in srgb, var(--bull) 40%, var(--border));
}
.action-badge.action-close {
  color: var(--bear);
  border-color: color-mix(in srgb, var(--bear) 40%, var(--border));
}
.action-badge.action-other {
  color: #e6a23c;
}
.rel-time {
  margin-left: auto;
  font-size: 12px;
  font-weight: 700;
}
.time-fresh {
  color: var(--bull);
}
.time-mid {
  color: #e6a23c;
}
.time-stale {
  color: var(--muted);
}
.alert-main {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.alert-main .coin {
  font-size: 16px;
}
.alert-main .notional {
  font-size: 15px;
}
.amount-lg .notional,
.alert-item.amount-lg {
  border-color: color-mix(in srgb, #e6a23c 45%, var(--border));
}
.amount-lg .notional {
  color: #e6a23c;
}
.amount-xl .notional,
.alert-item.amount-xl {
  border-color: color-mix(in srgb, var(--bear) 45%, var(--border));
}
.amount-xl .notional {
  color: #ff6b6b;
}
.alert-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 12px;
}
.abs-time {
  color: var(--muted);
  white-space: nowrap;
}
.dim {
  color: var(--muted);
  font-size: 12px;
  font-weight: 400;
}
.alert-pos {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}
.alert-specs {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  color: var(--muted);
  font-size: 13px;
}
.up {
  color: var(--bull);
  font-weight: 700;
}
.down {
  color: var(--bear);
  font-weight: 700;
}
.detail {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.detail-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  font-size: 16px;
}
.detail-row span {
  color: var(--muted);
}
.actions {
  display: flex;
  flex-wrap: nowrap;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
  width: 100%;
}
.actions :deep(.el-button) {
  margin: 0;
  flex: 0 0 auto;
  white-space: nowrap;
}
.news-scroll {
  position: relative;
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.news-scroll :deep(.el-loading-mask) {
  position: absolute;
  inset: 0;
  z-index: 10 !important;
}
.news {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  overflow-x: hidden;
  overflow-y: auto;
}
.news-bottom-panel .news {
  max-height: 240px;
}
.news-bottom-panel :deep(.el-card__body) {
  max-height: 300px;
  overflow-y: auto;
}
.news-item {
  display: block;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--border);
  color: inherit;
  background: transparent;
  text-align: left;
  cursor: pointer;
  font: inherit;
  white-space: normal;
}
.news-item:hover {
  border-color: var(--accent);
}
.event-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  cursor: default;
}
.event-item.today {
  border-color: var(--accent);
}
.event-date {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  font-size: 14px;
  color: var(--muted);
}
.event-date strong {
  color: var(--text);
  font-size: 15px;
}
.event-date em {
  font-style: normal;
  color: var(--accent);
}
.event-body {
  min-width: 0;
  max-width: 100%;
}
.title-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.topic-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.topic-tags :deep(.topic-tag.el-tag) {
  height: 20px;
  padding: 0 6px;
  font-size: 12px;
  line-height: 18px;
}
.title {
  font-size: 15px;
  line-height: 1.5;
  overflow-wrap: break-word;
  word-break: break-word;
}
.note {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 14px;
  line-height: 1.5;
  overflow-wrap: break-word;
  word-break: break-word;
}
.meta {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  color: var(--muted);
  font-size: 14px;
  gap: 8px;
}
.tags {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-width: 100%;
}
.tags :deep(.el-tag) {
  max-width: 100%;
}
.tags :deep(.kw-tag.el-tag) {
  height: 20px;
  padding: 0 6px;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  cursor: help;
}
.alert-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.addr-link {
  color: var(--accent);
  font-weight: 700;
  cursor: help;
}
.items {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.item {
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--bg);
  border: 1px solid var(--border);
}
.item-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}
.item p,
.muted {
  margin: 0;
  font-size: 14px;
}
.muted {
  margin-top: 6px;
  color: var(--muted);
  font-size: 12px;
}
.head :deep(.el-radio-button__inner) {
  padding: 7px 10px;
}
.dialog-alert {
  margin-bottom: 10px;
}
.dialog-title {
  margin: 0;
  font-size: 18px;
  line-height: 1.5;
}
.dialog-meta {
  margin-top: 8px;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  color: var(--muted);
  font-size: 14px;
}
.dialog-body {
  margin-top: 14px;
  white-space: pre-wrap;
  font-size: 16px;
  line-height: 1.7;
}
.alert-toolbar{flex-direction:column;align-items:stretch}
</style>

<style scoped>
.alert-item.live-new {
  animation: alert-slide-in 280ms ease-out, alert-live-highlight 1.5s ease-out;
}
.alert-item.live-update {
  animation: alert-live-highlight 1.5s ease-out;
}
@keyframes alert-slide-in {
  from { opacity: .35; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes alert-live-highlight {
  0%, 25% { box-shadow: inset 0 0 0 1px rgba(96, 165, 250, .6), inset 0 0 28px rgba(96, 165, 250, .16); }
  100% { box-shadow: inset 0 0 0 1px transparent, inset 0 0 28px transparent; }
}
@media (prefers-reduced-motion: reduce) {
  .alert-item.live-new, .alert-item.live-update { animation: none; outline: 1px solid rgba(96, 165, 250, .55); outline-offset: -1px; }
}
.alert-toolbar{flex-direction:column;align-items:stretch}
</style>
