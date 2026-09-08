<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Refresh } from '@element-plus/icons-vue';
import type { WhaleProfile } from '@/types';
import {
  normalizeStoredAlert,
  scopeAlertToCoin,
  scopeAlertToSide,
  alertEventTime,
  type AlertLayer,
  type WhaleAlert,
} from '@/utils/whaleAlerts';
import { preferredCoinsState, coinMatchesWatch } from '@/utils/watchedCoins';
import { isExoticAsset } from '@/utils/assets';
import {
  alertPassesFreshListGate,
  freshModeEnabled,
  freshWindowHours,
  freshWindowMs,
} from '@/utils/freshMode';
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
import WhaleLocateLink from '@/components/WhaleLocateLink.vue';
import { useWhaleStore } from '@/stores/whale';
import { getAuthUiSettings, patchAuthUiSettings } from '@/stores/auth';
import { fetchPagedAlertHistory } from '@/api';

const props = defineProps<{
  /** @deprecated 列表已改服务端分页，保留仅兼容旧调用 */
  alerts?: WhaleAlert[];
  whales?: WhaleProfile[];
  fundingRates?: Record<string, number>;
  bottomPanel?: boolean;
  filterWhaleId?: string;
  /** 巨鲸首屏就绪后再拉异动 */
  bootReady?: boolean;
}>();

const emit = defineEmits<{
  focusWhale: [whale: { id: string; name: string }];
  locateWhale: [payload: { id: string; name: string; coin?: string }];
  clearWhaleFilter: [];
}>();

const preferredCoins = preferredCoinsState;
const DEFAULT_ALERT_MIN_USD = 0;

const alertSideFilter = ref<'all' | 'long' | 'short'>('all');
const openOnly = ref(false);
const alertCoinFilter = ref<'all' | string>('all');
const alertMinUsd = ref(readAlertMinUsd());
const ALERT_PAGE_SIZE = 50;
const alertPage = ref(1);
const activeAlert = ref<WhaleAlert | null>(null);
const alertVisible = ref(false);
const pageAlerts = ref<WhaleAlert[]>([]);
const alertTotal = ref(0);
const alertLoading = ref(false);
const facets = ref<{ all: number; byCoin: Record<string, number>; long: number; short: number }>({
  all: 0,
  byCoin: {},
  long: 0,
  short: 0,
});
let alertReqSeq = 0;

/** 驱动「N分钟前」相对时间每分钟重算（computed 不会因 Date.now 自动刷新） */
const nowTick = ref(Date.now());
let nowTickTimer: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  const s = getAuthUiSettings();
  if (s.alertSideFilter === 'long' || s.alertSideFilter === 'short') {
    alertSideFilter.value = s.alertSideFilter;
  }
  if (typeof s.openOnly === 'boolean') {
    openOnly.value = s.openOnly;
  }
  if (typeof s.alertCoinFilter === 'string' && s.alertCoinFilter) {
    alertCoinFilter.value = s.alertCoinFilter;
  }
  if (typeof s.alertMinUsd === 'number') {
    alertMinUsd.value = s.alertMinUsd;
  }
  nowTickTimer = setInterval(() => {
    nowTick.value = Date.now();
  }, 30_000);
});

onUnmounted(() => {
  if (nowTickTimer) clearInterval(nowTickTimer);
});

watch(
  () => props.bootReady,
  (ready) => {
    if (!ready) return;
    void loadAlertPage();
  },
);

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
    const baseQuery = {
      whaleId: props.filterWhaleId || undefined,
      kind: (openOnly.value ? 'open' : 'all') as 'open' | 'all',
      // 多空计数要两边都有：请求时不带 side，展示时再筛
      minUsd: alertMinUsd.value || undefined,
      sinceMs: freshModeEnabled.value ? Date.now() - freshWindowMs() : undefined,
    };

    const coinTargets =
      alertCoinFilter.value === 'all'
        ? preferredCoins.value.length
          ? [...preferredCoins.value]
          : []
        : [alertCoinFilter.value];

    const map = new Map<string, WhaleAlert>();
    const byCoinRaw: Record<string, number> = {};
    let serverLong = 0;
    let serverShort = 0;

    if (!coinTargets.length) {
      const data = await fetchPagedAlertHistory({
        ...baseQuery,
        page: 1,
        limit: Math.min(100, alertPage.value * ALERT_PAGE_SIZE),
      });
      if (seq !== alertReqSeq) return;
      for (const raw of data.alerts || []) {
        const item = normalizeStoredAlert(raw as WhaleAlert);
        if (item?.id) map.set(item.id, item);
      }
      serverLong = Number(data.facets?.long) || 0;
      serverShort = Number(data.facets?.short) || 0;
      Object.assign(byCoinRaw, data.facets?.byCoin || {});
    } else {
      const need = Math.min(100, Math.max(ALERT_PAGE_SIZE, alertPage.value * ALERT_PAGE_SIZE));
      const pages = await Promise.all(
        coinTargets.map((coin) =>
          fetchPagedAlertHistory({
            ...baseQuery,
            page: 1,
            limit: need,
            coin,
          }),
        ),
      );
      if (seq !== alertReqSeq) return;
      for (let i = 0; i < coinTargets.length; i += 1) {
        const coin = coinTargets[i];
        const data = pages[i];
        byCoinRaw[coin] = Number(data.total) || 0;
        for (const raw of data.alerts || []) {
          const item = normalizeStoredAlert(raw as WhaleAlert);
          if (item?.id) map.set(item.id, item);
        }
        // 单币请求时 facets 已按该币收窄
        if (coinTargets.length === 1 && data.facets) {
          serverLong = Number(data.facets.long) || 0;
          serverShort = Number(data.facets.short) || 0;
          Object.assign(byCoinRaw, data.facets.byCoin || {});
        } else if (data.facets) {
          // 多币合并时用各币 total 近似；多空改由客户端闸门后重算
          Object.assign(byCoinRaw, data.facets.byCoin || {});
        }
      }
    }

    const pool = [...map.values()]
      .filter((alert) => {
        const coin = alert.items?.[0]?.coin;
        if (isExoticAsset(String(coin || ''))) return false;
        if (alertCoinFilter.value === 'all' && preferredCoins.value.length) {
          if (!coinMatchesWatch(coin, preferredCoins.value)) return false;
        }
        return alertPassesFreshListGate(alert, whaleOf(alert));
      })
      .sort((a, b) => alertEventTime(b) - alertEventTime(a));

    // 与列表同一套闸门后的多空 / 币种计数
    const byCoin: Record<string, number> = {};
    let long = 0;
    let short = 0;
    for (const alert of pool) {
      const side = alert.items?.[0]?.side;
      if (side === 'long') long += 1;
      else if (side === 'short') short += 1;
      const coin = String(alert.items?.[0]?.coin || '')
        .trim()
        .toUpperCase();
      if (coin) byCoin[coin] = (byCoin[coin] || 0) + 1;
    }

    // 非闪电模式且样本可能被 limit 截断时，优先用服务端按币种 facet
    const truncated =
      !freshModeEnabled.value &&
      coinTargets.length === 1 &&
      (byCoinRaw[coinTargets[0]] || 0) > pool.length;
    if (truncated) {
      long = serverLong;
      short = serverShort;
      for (const [k, v] of Object.entries(byCoinRaw)) {
        byCoin[k] = v;
      }
    }

    const side = alertSideFilter.value;
    const sided = side === 'all' ? pool : pool.filter((a) => a.items?.[0]?.side === side);
    const start = (alertPage.value - 1) * ALERT_PAGE_SIZE;
    const list = sided.slice(start, start + ALERT_PAGE_SIZE);

    pageAlerts.value = list;
    alertTotal.value = sided.length;
    whaleStore.absorbAlertPage(list);
    facets.value = {
      all: pool.length,
      byCoin: truncated ? { ...byCoinRaw, ...byCoin } : byCoin,
      long,
      short,
    };
  } catch (err) {
    if (seq !== alertReqSeq) return;
    if (!silent) {
      pageAlerts.value = [];
      alertTotal.value = 0;
      ElMessage.error(err instanceof Error ? err.message : '异动加载失败');
    }
  } finally {
    if (seq === alertReqSeq) alertLoading.value = false;
  }
}
function openAlert(item: WhaleAlert) {
  activeAlert.value = item;
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

const alertCoinCounts = computed(() => {
  const counts: Record<string, number> = { all: 0 };
  for (const coin of preferredCoins.value) {
    const n = facets.value.byCoin[coin] || 0;
    counts[coin] = n;
    counts.all += n;
  }
  return counts;
});

const alertSideCounts = computed(() => ({
  long: facets.value.long,
  short: facets.value.short,
}));

function toggleSideFilter(side: 'long' | 'short') {
  alertSideFilter.value = alertSideFilter.value === side ? 'all' : side;
}

function resetAlertFilters() {
  alertCoinFilter.value = 'all';
  alertSideFilter.value = 'all';
  openOnly.value = false;
  alertMinUsd.value = DEFAULT_ALERT_MIN_USD;
  writeAlertMinUsd(DEFAULT_ALERT_MIN_USD);
  emit('clearWhaleFilter');
}

const whaleStore = useWhaleStore();
const alertRefreshing = ref(false);

/** 重置筛选，并重拉仓位做 diff（不再补成交反推） */
async function onRefreshAlerts() {
  resetAlertFilters();
  if (alertRefreshing.value) return;
  alertRefreshing.value = true;
  try {
    await whaleStore.refreshAlertHistory();
    alertPage.value = 1;
    await loadAlertPage();
    ElMessage.success('异动已按最新仓位刷新');
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '异动刷新失败');
  } finally {
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
      let scoped = alert;
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

const alertPageCount = computed(() =>
  Math.max(1, Math.ceil(alertTotal.value / ALERT_PAGE_SIZE)),
);

const pagedAlerts = computed(() => filteredAlerts.value);

watch(
  [
    alertSideFilter,
    openOnly,
    alertCoinFilter,
    alertMinUsd,
    () => props.filterWhaleId,
    freshModeEnabled,
    freshWindowHours,
    preferredCoins,
  ],
  () => {
    if (!props.bootReady) return;
    if (alertPage.value !== 1) {
      alertPage.value = 1;
      return;
    }
    void loadAlertPage();
  },
);

watch(alertPage, () => {
  if (!props.bootReady) return;
  void loadAlertPage();
});

watch(alertPageCount, (count) => {
  if (alertPage.value > count) alertPage.value = count;
});

watch(alertMinUsd, (value) => {
  writeAlertMinUsd(value);
});

watch(preferredCoinsState, (coins) => {
  if (alertCoinFilter.value === 'all') return;
  if (!coins.includes(alertCoinFilter.value)) alertCoinFilter.value = 'all';
});

/** 实时新异动：在第 1 页时静默刷新 */
watch(
  () => whaleStore.alertHistory[0]?.id,
  (id, prev) => {
    if (!props.bootReady) return;
    if (!id || id === prev) return;
    if (alertPage.value === 1) void loadAlertPage(true);
  },
);

defineExpose({
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
  const base = '近 7 天暂无开仓 / 补仓记录';
  const parts: string[] = [];
  if (props.filterWhaleId && filterWhaleName.value) parts.push(filterWhaleName.value);
  if (alertMinUsd.value > 0) parts.push(`≥${formatUsd(alertMinUsd.value)}`);
  if (alertSideFilter.value === 'long') parts.push('做多');
  if (alertSideFilter.value === 'short') parts.push('做空');
  if (openOnly.value) parts.push('开仓');
  if (alertCoinFilter.value !== 'all') parts.push(alertCoinFilter.value);
  if (!parts.length) return base;
  return `近 7 天暂无${parts.join(' · ')}的开仓 / 补仓记录`;
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
</script>

<template>
  <el-card class="panel" :class="{ 'news-bottom-panel': bottomPanel }" shadow="never">
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
              全部 {{ alertCoinCounts.all }}
            </button>
            <button
              v-for="coin in preferredCoins"
              :key="coin"
              type="button"
              class="coin-chip"
              :class="{ on: alertCoinFilter === coin }"
              @click="alertCoinFilter = coin"
            >
              {{ coin }} {{ alertCoinCounts[coin] ?? 0 }}
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
        <div class="side-filter">
          <button
            type="button"
            class="side-chip long"
            :class="{ on: alertSideFilter === 'long' }"
            @click="toggleSideFilter('long')"
          >
            <span class="chip-text">多</span>
            <span class="chip-count">{{ alertSideCounts.long }}</span>
          </button>
          <button
            type="button"
            class="open-text-toggle"
            :class="{ on: openOnly }"
            title="只看开仓"
            @click="openOnly = !openOnly"
          >
            开
          </button>
          <button
            type="button"
            class="side-chip short"
            :class="{ on: alertSideFilter === 'short' }"
            @click="toggleSideFilter('short')"
          >
            <span class="chip-text">空</span>
            <span class="chip-count">{{ alertSideCounts.short }}</span>
          </button>
        </div>
        <div v-if="filterWhaleName" class="whale-link-chip" :title="filterWhaleName">
          <span class="chip-label">联动</span>
          <span class="chip-name">{{ filterWhaleName }}</span>
        </div>
      </div>
      <el-empty v-if="!alertLoading && !filteredAlerts.length" :description="alertEmptyText()" />
      <div v-else class="news" v-loading="alertLoading">
        <button
          v-for="row in pagedAlerts"
          :key="row.alert.id"
          type="button"
          class="news-item alert-item"
          :class="[row.view.amountClass, `layer-${row.view.layer}`]"
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
            <span class="abs-time">{{ formatTimeShort(row.view.eventTime) }}</span>
          </div>
        </button>
      </div>
      <div v-if="alertTotal > 0" class="alert-pager">
        <button
          type="button"
          class="pager-btn"
          :disabled="alertPage <= 1 || alertLoading"
          @click="alertPage = 1"
        >
          首页
        </button>
        <button
          type="button"
          class="pager-btn"
          :disabled="alertPage <= 1 || alertLoading"
          @click="alertPage = Math.max(1, alertPage - 1)"
        >
          上一页
        </button>
        <span class="pager-info">
          第 {{ alertPage }}/{{ alertPageCount }} 页 · 共 {{ alertTotal }} 条
        </span>
        <button
          type="button"
          class="pager-btn"
          :disabled="alertPage >= alertPageCount || alertLoading"
          @click="alertPage = Math.min(alertPageCount, alertPage + 1)"
        >
          下一页
        </button>
      </div>
    </div>

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
  </el-card>
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
.alert-pager {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}
.pager-btn {
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  padding: 4px 12px;
  cursor: pointer;
}
.pager-btn:hover:not(:disabled) {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
}
.pager-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.pager-info {
  font-size: 12px;
  font-weight: 700;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
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
@media (max-width: 768px) {
  .panel :deep(.el-card__header) {
    padding: 10px 12px;
  }
  .news-item {
    padding: 10px;
  }
}
</style>
