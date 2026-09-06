<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, shallowRef, watch } from 'vue';
import { ElMessage } from 'element-plus';
import PnlProgressBar from '@/components/PnlProgressBar.vue';
import PositionDetailDialog from '@/components/PositionDetailDialog.vue';
import type { WhaleDirection, WhalePosition, WhaleProfile } from '@/types';
import { directionLabel, formatPrice, formatRelativeAgo, formatTimeShort, formatUsd, isOpenTimeStale } from '@/utils/format';
import {
  formatWhaleAddressLine,
  formatWhaleMetricLines,
  isAddressLikeName,
  positionFirstOpenTime,
  positionLastAddTime,
  whaleCardTitle,
} from '@/utils/whaleReference';
import { WHALE_PAGE_SIZE, compareWhalesForDisplay, sortWhalesForDisplay } from '@/utils/topWhales';
import type { RecoQuotes } from '@/utils/recommend';
import {
  buildWhaleMarketSummary,
  buildWhaleRiskSummary,
  formatRiskPnlLine,
  formatScopePositionTitle,
} from '@/utils/whaleSummary';
import {
  displayEntryFillItems,
  entryFillKind,
  entryFillLabel,
  entryFillTotalCount,
  formatSideWinRate,
  positionPnlPct,
  positionsAggregatePnlPct,
  scopedWhaleDirection,
  visibleWhalePositions,
  whaleHasPositionCoin,
} from '@/utils/whaleCardUtils';
import { freshModeEnabled, whaleHasFreshActivity } from '@/utils/freshMode';
import { useWhaleStore } from '@/stores/whale';
import { preferredCoinsState } from '@/utils/watchedCoins';
import {
  isWhaleMonitored,
  monitoredCount,
  toggleWhaleMonitor,
} from '@/utils/monitoredWhales';

const props = defineProps<{
  whales: WhaleProfile[];
  loading: boolean;
  selectedId: string;
  quotes?: RecoQuotes;
}>();

const emit = defineEmits<{
  query: [whale: WhaleProfile];
  focusWhale: [payload: { id: string; name: string; coin?: string }];
  selectTransfers: [whale: WhaleProfile];
}>();

const whaleStore = useWhaleStore();

/** 展示名单与 store 同步；定位时可暂冻结为 frozenWhales */
const displayLoaded = ref(0);
const displayTotal = ref(0);
const progressVisible = ref(false);
const progressLeaving = ref(false);
let progressAnimRaf = 0;
let progressHideTimer: ReturnType<typeof setTimeout> | null = null;
let lastProgressTotal = 0;

function clearProgressTimers() {
  if (progressAnimRaf) {
    cancelAnimationFrame(progressAnimRaf);
    progressAnimRaf = 0;
  }
  if (progressHideTimer) {
    clearTimeout(progressHideTimer);
    progressHideTimer = null;
  }
}

function animateLoadedTo(target: number, onDone?: () => void) {
  if (progressAnimRaf) cancelAnimationFrame(progressAnimRaf);
  const start = displayLoaded.value;
  const end = Math.max(0, Math.round(target));
  if (end === start) {
    onDone?.();
    return;
  }
  const diff = end - start;
  // 确保目标在展示名单中
  const duration = Math.min(1100, Math.max(320, Math.abs(diff) * 36));
  const t0 = performance.now();
  const tick = (now: number) => {
    const t = Math.min(1, (now - t0) / duration);
    const eased = 1 - (1 - t) ** 2.2;
    displayLoaded.value = Math.round(start + diff * eased);
    if (t < 1) {
      progressAnimRaf = requestAnimationFrame(tick);
      return;
    }
    displayLoaded.value = end;
    progressAnimRaf = 0;
    onDone?.();
  };
  progressAnimRaf = requestAnimationFrame(tick);
}

function hideProgressSoon() {
  progressLeaving.value = true;
  progressHideTimer = setTimeout(() => {
    progressVisible.value = false;
    progressLeaving.value = false;
    displayLoaded.value = 0;
    progressHideTimer = null;
  }, 780);
}

watch(
  () => whaleStore.loadProgress,
  (progress) => {
    if (progress && progress.total > 0) {
      if (progressHideTimer) {
        clearTimeout(progressHideTimer);
        progressHideTimer = null;
      }
      progressLeaving.value = false;
      progressVisible.value = true;
      lastProgressTotal = progress.total;
      displayTotal.value = progress.total;
      animateLoadedTo(progress.loaded);
      return;
    }
    // store 已有数据时不再用 props 覆盖展示名单
    if (!progressVisible.value || !lastProgressTotal) return;
    displayTotal.value = lastProgressTotal;
    animateLoadedTo(lastProgressTotal, hideProgressSoon);
  },
);

const loadedDigits = computed(() => {
  const width = Math.max(2, String(displayTotal.value || 0).length);
  return String(displayLoaded.value).padStart(width, '0').split('');
});

const showLoadProgress = computed(() => progressVisible.value);

const directionFilter = ref<'all' | WhaleDirection | 'followed'>('all');
const sortMode = ref<'all' | 'positionValue' | 'positionPnl' | 'latest'>('all');
const page = ref(1);
const coinFilter = ref<'all' | string>('all');
const positionDialog = ref<{
  open: (
    whale: WhaleProfile,
    pos: WhalePosition | { coin: string; side?: 'long' | 'short' },
  ) => void;
} | null>(null);
const preferredCoins = preferredCoinsState;
const expandedEntryKeys = ref<Record<string, boolean>>({});
const HIGHLIGHT_MS = 2600;
const highlightedId = ref<string | null>(null);
const locatePinId = ref<string | null>(null);
let highlightTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 币种筛选：决定哪些巨鲸出现在列表中 */
const listHovered = ref(false);
const dialogOpen = ref(false);
// shallowRef：避免深层仓位变更触发不必要的重排序
const frozenWhales = shallowRef<WhaleProfile[]>(props.whales);
const updatePaused = computed(() => listHovered.value || dialogOpen.value);

watch(
  [() => props.whales, updatePaused],
  () => {
    if (updatePaused.value) return;
    frozenWhales.value = props.whales;
  },
  { immediate: true },
);

const sourceWhales = computed(() => frozenWhales.value);

const coinScopedWhales = computed(() => {
  let pool = sourceWhales.value;
  if (freshModeEnabled.value) {
    // 近时/闪电模式：以 openTime 与开仓证据为门槛
    pool = pool.filter((whale) => {
      if (!whaleHasFreshActivity(whale, Date.now())) return false;
      return (
        scopedWhaleDirection(whale, coinFilter.value === 'all' ? 'all' : coinFilter.value) !==
        'neutral'
      );
    });
  }
  // 若有定位 pin，确保其仍在 pool 中
  const pinned = locatePinId.value
    ? sourceWhales.value.find((item) => item.id === locatePinId.value) || null
    : null;

  if (coinFilter.value === 'all') {
    if (pinned && !pool.some((item) => item.id === pinned.id)) {
      return [pinned, ...pool];
    }
    return pool;
  }
  let list = pool.filter((whale) => {
    if (freshModeEnabled.value) {
      return visibleWhalePositions(whale, coinFilter.value).length > 0;
    }
    return whaleHasPositionCoin(whale, coinFilter.value);
  });
  if (pinned && !list.some((item) => item.id === pinned.id)) {
    list = [pinned, ...list];
  }
  return list;
});

const marketSummary = computed(() =>
  buildWhaleMarketSummary(coinScopedWhales.value, coinFilter.value),
);

const riskSummary = computed(() =>
  buildWhaleRiskSummary(coinScopedWhales.value, coinFilter.value),
);

const marketDonutStyle = computed(() => {
  const long = marketSummary.value.longPct;
  return {
    background: `conic-gradient(var(--bull) 0% ${long}%, var(--bear) ${long}% 100%)`,
  };
});

const showMarketDonut = computed(
  () => marketSummary.value.longUsd + marketSummary.value.shortUsd > 0,
);

const directionCounts = computed(() => {
  const counts = {
    all: coinScopedWhales.value.length,
    long: 0,
    short: 0,
    neutral: 0,
    followed: monitoredCount.value,
  };
  for (const whale of coinScopedWhales.value) {
    const direction = scopedWhaleDirection(whale, coinFilter.value);
    if (direction === 'long') counts.long += 1;
    else if (direction === 'short') counts.short += 1;
    else counts.neutral += 1;
  }
  return counts;
});

const DIRECTION_FILTERS = [
  { value: 'all' as const, label: '全部' },
  { value: 'long' as const, label: '做多' },
  { value: 'short' as const, label: '做空' },
  { value: 'followed' as const, label: '关注' },
];

const SORT_MODES = [
  { value: 'all' as const, label: '全部' },
  { value: 'positionValue' as const, label: '仓位价值' },
  { value: 'positionPnl' as const, label: '仓位盈亏' },
  { value: 'latest' as const, label: '最新开单' },
];

const isFollowTab = computed(() => directionFilter.value === 'followed');

const filteredWhales = computed(() => {
  let list = coinScopedWhales.value;
  if (isFollowTab.value) {
    list = list.filter((item) => isWhaleMonitored(item.id));
  } else if (directionFilter.value !== 'all') {
    list = list.filter(
      (item) =>
        scopedWhaleDirection(item, coinFilter.value) === directionFilter.value,
    );
  }
  return list;
});

/** 币种计数：仅统计当前筛选可见的巨鲸 */
function whaleLastAddTime(whale: WhaleProfile) {
  let latest = 0;
  for (const pos of whale.positions || []) {
    const ts = positionLastAddTime(pos) || 0;
    if (ts > latest) latest = ts;
  }
  return latest;
}

/** 币种筛选只决定哪些巨鲸入列，卡片内仍展示全部持仓 */
function hoistLocatePin(list: WhaleProfile[]) {
  const id = locatePinId.value;
  if (!id) return list;
  const index = list.findIndex((item) => item.id === id);
  if (index <= 0) return list;
  const next = list.slice();
  const [pinned] = next.splice(index, 1);
  next.unshift(pinned);
  return next;
}

/** 按仓位价值/盈亏/开单时间排序 */
function whalePositionValueUsd(whale: WhaleProfile) {
  return cardExposure(whale)?.positionUsd || 0;
}

/** 市场多空仓位价值汇总 */
function whalePositionPnlUsd(whale: WhaleProfile) {
  const positions = cardPositions(whale);
  if (positions.length) {
    return positions.reduce((sum, pos) => sum + (Number(pos.unrealizedPnl) || 0), 0);
  }
  return 0;
}

/** 风险控制：按当前筛选范围汇总未实现盈亏 */
function computeSortedIds(list: WhaleProfile[]) {
  const next = [...list];
  if (sortMode.value === 'positionValue') {
    next.sort(
      (a, b) => whalePositionValueUsd(b) - whalePositionValueUsd(a) || compareWhalesForDisplay(a, b),
    );
  } else if (sortMode.value === 'positionPnl') {
    next.sort(
      (a, b) => whalePositionPnlUsd(b) - whalePositionPnlUsd(a) || compareWhalesForDisplay(a, b),
    );
  } else if (sortMode.value === 'latest') {
    next.sort((a, b) => whaleLastAddTime(b) - whaleLastAddTime(a) || compareWhalesForDisplay(a, b));
  } else {
    return hoistLocatePin(sortWhalesForDisplay(next)).map((item) => item.id);
  }
  return hoistLocatePin(next).map((item) => item.id);
}

/**
 * 锁定排序：定位/手动操作时保持卡片顺序，避免刷新导致跳动 */
const lockedOrderIds = ref<string[]>([]);

function resortLockedOrder() {
  lockedOrderIds.value = computeSortedIds(filteredWhales.value);
}

watch([directionFilter, sortMode, coinFilter], () => {
  page.value = 1;
  resortLockedOrder();
});

watch(
  filteredWhales,
  (list) => {
    if (!list.length) {
      lockedOrderIds.value = [];
      return;
    }
    if (!lockedOrderIds.value.length) {
      resortLockedOrder();
      return;
    }
    // 异动定位不带币种：顶部币种筛选保持「全部」?
    const byId = new Map(list.map((item) => [item.id, item]));
    const kept = lockedOrderIds.value.filter((id) => byId.has(id));
    const known = new Set(kept);
    const appended = list.filter((item) => !known.has(item.id)).map((item) => item.id);
    lockedOrderIds.value = [...kept, ...appended];
  },
  { flush: 'post' },
);

watch(locatePinId, (id) => {
  if (!id || !lockedOrderIds.value.length) return;
  const idx = lockedOrderIds.value.indexOf(id);
  if (idx <= 0) return;
  const next = lockedOrderIds.value.slice();
  next.splice(idx, 1);
  next.unshift(id);
  lockedOrderIds.value = next;
  page.value = 1;
});

/** 格式化盈亏行（含百分比） */
const sortedWhales = computed(() => {
  const byId = new Map(filteredWhales.value.map((item) => [item.id, item]));
  const ids = lockedOrderIds.value.length
    ? lockedOrderIds.value
    : computeSortedIds(filteredWhales.value);
  const ordered: WhaleProfile[] = [];
  for (const id of ids) {
    const hit = byId.get(id);
    if (hit) ordered.push(hit);
  }
  return hoistLocatePin(ordered);
});

const pageCount = computed(() => Math.max(1, Math.ceil(sortedWhales.value.length / WHALE_PAGE_SIZE)));

watch(pageCount, (count) => {
  if (page.value > count) page.value = count;
});

function displayDirection(whale: WhaleProfile) {
  return scopedWhaleDirection(whale, coinFilter.value);
}

const coinCounts = computed(() => {
  let pool = sourceWhales.value;
  if (freshModeEnabled.value) {
    pool = pool.filter((whale) => {
      if (!whaleHasFreshActivity(whale, Date.now())) return false;
      return scopedWhaleDirection(whale, 'all') !== 'neutral';
    });
  }
  const counts: Record<string, number> = { all: pool.length };
  for (const coin of preferredCoins.value) {
    counts[coin] = pool.filter((whale) => {
      if (freshModeEnabled.value) {
        if (scopedWhaleDirection(whale, coin) === 'neutral') return false;
        return visibleWhalePositions(whale, coin).length > 0;
      }
      return whaleHasPositionCoin(whale, coin);
    }).length;
  }
  return counts;
});

function cardPositions(whale: WhaleProfile) {
  // 币种筛选只决定哪些巨鲸入列，卡片内仍展示全部（含近时）持仓
  return sortedPositions(visibleWhalePositions(whale, 'all'));
}

const displayedWhales = computed(() => {
  const start = (page.value - 1) * WHALE_PAGE_SIZE;
  return sortedWhales.value.slice(start, start + WHALE_PAGE_SIZE);
});

/** 开仓成交笔数；>1 标为多笔 */
function displayRank(index: number) {
  return (page.value - 1) * WHALE_PAGE_SIZE + index + 1;
}

function positionHoldLine(pos: WhalePosition) {
  if (pos.openHistoryComplete === false) {
    const last = positionLastAddTime(pos);
    return last
      ? `首次开仓：未知 | 最近加仓：${formatRelativeAgo(last)}`
      : '首次开仓：未知（成交历史不完整）';
  }
  const first = positionFirstOpenTime(pos);
  const last = positionLastAddTime(pos);
  if (!first && !last) return '';
  const firstPart = first ? `首次开仓：${formatRelativeAgo(first)}` : '首次开仓：未知';
  if (last && first && last !== first) {
    return `${firstPart} | 最近加仓：${formatRelativeAgo(last)}`;
  }
  return firstPart;
}

function positionIsStaleHold(pos: WhalePosition) {
  const first = positionFirstOpenTime(pos);
  return first != null && isOpenTimeStale(first);
}

const expandedIds = ref<Record<string, boolean>>({});

function sortedPositions(positions: WhalePosition[]) {
  return [...positions].sort((a, b) => (b.positionValue || 0) - (a.positionValue || 0));
}

function openPosition(whale: WhaleProfile, pos: WhalePosition) {
  dialogOpen.value = true;
  positionDialog.value?.open(whale, pos);
}

function sideWinTag(whale: WhaleProfile) {
  const long = formatSideWinRate(whale.longWinRate);
  const short = formatSideWinRate(whale.shortWinRate);
  if (long === '--' && short === '--') return '';
  return `多胜率 ${long} / 空胜率 ${short}`;
}

function cardTitle(whale: WhaleProfile) {
  return whaleCardTitle(whale);
}

/** 巨鲸卡片底部指标行（成交量/胜率/地址） */
function cardHeadInline(whale: WhaleProfile) {
  const titleIsMetric = isAddressLikeName(whale.name, whale.address);
  if (titleIsMetric) {
    const dd = whale.maxDrawdown;
    const trades = Number(whale.closedTrades) || 0;
    const parts: string[] = [];
    if (dd != null && Number.isFinite(Number(dd))) parts.push(`回撤 ${Number(dd)}%`);
    if (trades > 0) parts.push(`${trades}笔`);
    return parts.join(' · ');
  }
  const metrics = formatWhaleMetricLines(whale);
  const parts: string[] = [];
  if (metrics.volumeLine) parts.push(metrics.volumeLine);
  if (metrics.statsLine) parts.push(metrics.statsLine);
  const addr = formatWhaleAddressLine(whale.address);
  if (addr) parts.push(addr);
  return parts.join(' · ');
}

/** 仓位曝光 + 保证金摘要 */
function cardExposure(whale: WhaleProfile) {
  const positions = cardPositions(whale);
  if (positions.length) {
    const positionUsd = positions.reduce(
      (sum, pos) => sum + Math.abs(Number(pos.positionValue) || 0),
      0,
    );
    const marginUsd = positions.reduce(
      (sum, pos) => sum + Math.abs(Number(pos.marginUsed) || 0),
      0,
    );
    if (positionUsd <= 0 && marginUsd <= 0) return null;
    return {
      positionUsd: positionUsd > 0 ? positionUsd : null,
      marginUsd: marginUsd > 0 ? marginUsd : null,
    };
  }
  const longUsd = Math.abs(Number(whale.longUsd) || 0);
  const shortUsd = Math.abs(Number(whale.shortUsd) || 0);
  const positionUsd = longUsd + shortUsd;
  if (positionUsd <= 0) return null;
  return { positionUsd, marginUsd: null as number | null };
}

function cardExposureText(whale: WhaleProfile) {
  const exposure = cardExposure(whale);
  if (!exposure) return '';
  const parts: string[] = [];
  if (exposure.positionUsd != null) parts.push(`仓位 ${formatUsd(exposure.positionUsd)}`);
  if (exposure.marginUsd != null) parts.push(`保证金 ${formatUsd(exposure.marginUsd)}`);
  return parts.join(' · ');
}

/** 刷新单个巨鲸并提示 */
function useDetailedPositions(_whale?: WhaleProfile) {
  return isFollowTab.value;
}

function onToggleMonitor(whale: WhaleProfile) {
  toggleWhaleMonitor(whale.id);
}

function flashWhaleCard(id: string) {
  if (highlightTimer) clearTimeout(highlightTimer);
  highlightedId.value = id;
  highlightTimer = setTimeout(() => {
    if (highlightedId.value === id) highlightedId.value = null;
    if (locatePinId.value === id) locatePinId.value = null;
    highlightTimer = null;
  }, HIGHLIGHT_MS);
}

function entryFillKey(whaleId: string, pos: WhalePosition) {
  return `${whaleId}:${pos.coin}:${pos.side}`;
}

function entryFillCount(pos: WhalePosition) {
  return entryFillTotalCount(pos);
}

function entryFillDisplayItems(pos: WhalePosition) {
  return displayEntryFillItems(pos.entryFills || [], pos.entryFillsOmitted || 0);
}

function isEntryFillsExpanded(whaleId: string, pos: WhalePosition) {
  return Boolean(expandedEntryKeys.value[entryFillKey(whaleId, pos)]);
}

function toggleEntryFills(whaleId: string, pos: WhalePosition) {
  if (entryFillCount(pos) <= 1) return;
  const key = entryFillKey(whaleId, pos);
  expandedEntryKeys.value = { ...expandedEntryKeys.value, [key]: !expandedEntryKeys.value[key] };
}

function selectCoinFilter(value: 'all' | string) {
  locatePinId.value = null;
  coinFilter.value = value;
}

onUnmounted(() => {
  if (highlightTimer) clearTimeout(highlightTimer);
  clearProgressTimers();
});

async function onWhaleClick(whale: WhaleProfile) {
  // 点卡刷新：避免与定位/展开互相抢占
  if (whale.error && !whaleStore.refreshingWhaleIds[whale.id]) {
    try {
      const updated = await whaleStore.refreshWhale(whale.id);
      if (updated) {
        frozenWhales.value = frozenWhales.value.map((item) =>
          item.id === updated.id ? updated : item,
        );
        if (updated.error) {
          ElMessage.warning(`${whaleCardTitle(updated)}：${updated.error}`);
        }
      }
    } catch (err) {
      ElMessage.error(err instanceof Error ? err.message : '刷新失败');
    }
    return;
  }
  emit('query', whale);
}

function onWhaleNameClick(whale: WhaleProfile, event?: Event) {
  event?.stopPropagation();
  emit('selectTransfers', whale);
  emit('query', whale);
}

async function focusWhale(payload: { id: string; coin?: string }) {
  // 先定位滚到卡片，刷新放后台，避免 loading 期间整张卡不可点
  dialogOpen.value = false;
  directionFilter.value = 'all';
  page.value = 1;
  // 异动定位不带币种：顶部币种筛选保持「全部」
  coinFilter.value = 'all';

  // 确保目标在展示名单中
  let whale =
    whaleStore.whales.find((item) => item.id === payload.id) ||
    props.whales.find((item) => item.id === payload.id) ||
    null;

  if (!whale) {
    try {
      whale = (await whaleStore.refreshWhale(payload.id)) || null;
    } catch {
      whale = null;
    }
  }
  if (!whale) {
    ElMessage.warning('当前列表中找不到该巨鲸');
    return;
  }

  whaleStore.ensureWhaleInDisplay(whale.id);
  await nextTick();
  frozenWhales.value = props.whales.length ? props.whales : [whale];

  if (freshModeEnabled.value && !whaleHasFreshActivity(whale, Date.now())) {
    ElMessage.warning('该巨鲸最近无动作');
    return;
  }
  // 定位高亮
  locatePinId.value = payload.id;
  expandedIds.value = { ...expandedIds.value, [payload.id]: true };
  flashWhaleCard(payload.id);
  nextTick(() => {
    nextTick(() => {
      const el = document.getElementById(`whale-card-${payload.id}`);
      if (!el) {
        ElMessage.warning('未找到对应巨鲸卡片');
        return;
      }
      el.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    });
  });

  if (whaleStore.refreshingWhaleIds[payload.id]) return;
  void whaleStore
    .refreshWhale(payload.id)
    .then((updated) => {
      if (!updated) return;
      frozenWhales.value = frozenWhales.value.map((item) =>
        item.id === updated.id ? updated : item,
      );
    })
    .catch(() => {
      // 确保目标在展示名单中
    });
}

defineExpose({ focusWhale });
</script>

<template>
  <el-card class="panel" shadow="never">
    <template #header>
      <div
        v-if="showMarketDonut"
        class="ls-donut-float"
        :title="`仓位价值 多 ${marketSummary.longPct}% / 空 ${marketSummary.shortPct}%`"
      >
        <div class="ls-donut" :style="marketDonutStyle">
          <div class="ls-donut-core">
            <span class="up">{{ marketSummary.longPct }}%</span>
            <span class="down">{{ marketSummary.shortPct }}%</span>
          </div>
        </div>
      </div>
      <div class="head">
        <div class="coin-filter-row">
          <div class="coin-filter">
            <button
              type="button"
              class="coin-chip"
              :class="{ on: coinFilter === 'all' }"
              @click="selectCoinFilter('all')"
            >
              全部 {{ coinCounts.all }}
            </button>
            <button
              v-for="coin in preferredCoins"
              :key="coin"
              type="button"
              class="coin-chip"
              :class="{ on: coinFilter === coin }"
              @click="selectCoinFilter(coin)"
            >
              {{ coin }} {{ coinCounts[coin] ?? 0 }}
            </button>
          </div>
          <div class="head-toolbar">
            <span
              v-if="showLoadProgress"
              class="load-progress"
              :class="{ leaving: progressLeaving }"
              title="巨鲸加载进度"
            >
              <span class="load-dot spin" aria-hidden="true" />
              <span class="odometer" aria-label="已加载数量">
                <span
                  v-for="(digit, index) in loadedDigits"
                  :key="`d-${index}-${loadedDigits.length}`"
                  class="digit-slot"
                >
                  <span
                    class="digit-reel"
                    :style="{ transform: `translateY(-${Number(digit) * 10}%)` }"
                  >
                    <span v-for="n in 10" :key="n" class="digit-cell">{{ n - 1 }}</span>
                  </span>
                </span>
              </span>
              <span class="progress-slash">/</span>
              <span class="progress-total">{{ displayTotal }}</span>
            </span>
          </div>
        </div>
        <div v-if="whales.length" class="insight-strip market-summary">
          <div class="summary-line value-line">
            <span class="dim">{{ formatScopePositionTitle(marketSummary.scopeLabel) }}</span>
            <span class="up">多 {{ formatUsd(marketSummary.longUsd) }}</span>
            <span class="dim">/</span>
            <span class="down">空 {{ formatUsd(marketSummary.shortUsd) }}</span>
          </div>
          <span v-if="marketSummary.hint" class="summary-hint">{{ marketSummary.hint }}</span>
        </div>
        <div v-if="whales.length" class="insight-strip risk-banner" :class="riskSummary.tone">
          <span class="summary-line">
            <span class="dim">风险控制 · {{ riskSummary.label }}</span>
            <span class="up">多 {{ formatRiskPnlLine(riskSummary.longPnlUsd, riskSummary.longPnlPct) }}</span>
            <span class="dim">/</span>
            <span class="down">空 {{ formatRiskPnlLine(riskSummary.shortPnlUsd, riskSummary.shortPnlPct) }}</span>
            <span class="dim sep">|</span>
            <span class="risk-detail">{{ riskSummary.detail }}</span>
          </span>
        </div>
        <div class="filter-row">
          <div class="direction-chips">
            <button
              v-for="item in DIRECTION_FILTERS"
              :key="item.value"
              type="button"
              class="direction-chip"
              :class="{ on: directionFilter === item.value }"
              @click="directionFilter = item.value"
            >
              {{ item.label }} {{ directionCounts[item.value] }}
            </button>
          </div>
          <div class="sort-chips">
            <button
              v-for="item in SORT_MODES"
              :key="item.value"
              type="button"
              class="sort-chip"
              :class="{ on: sortMode === item.value }"
              @click="sortMode = item.value"
            >
              {{ item.label }}
            </button>
          </div>
        </div>
      </div>
    </template>
    <el-skeleton v-if="loading && !whales.length" :rows="6" animated />
    <el-empty
      v-else-if="isFollowTab && !displayedWhales.length"
      description="当前没有关注的巨鲸"
    />
    <el-empty v-else-if="!displayedWhales.length" description="当前筛选项下没有巨鲸" />
    <div
      v-else
      class="list"
      @mouseenter="listHovered = true"
      @mouseleave="listHovered = false"
    >
      <div
        v-for="(whale, index) in displayedWhales"
        :id="`whale-card-${whale.id}`"
        :key="whale.id"
        class="whale-item"
        :class="{
          active: selectedId === whale.id,
          monitored: isFollowTab && isWhaleMonitored(whale.id),
          'locate-flash': highlightedId === whale.id,
          'has-error': Boolean(whale.error),
          refreshing: Boolean(whaleStore.refreshingWhaleIds[whale.id]),
        }"
        @click="onWhaleClick(whale)"
      >
        <div class="card-head">
          <span class="rank">{{ displayRank(index) }}</span>
          <span class="dir-tag" :class="displayDirection(whale)">
            {{ directionLabel(displayDirection(whale)) }}
          </span>
          <div v-if="cardHeadInline(whale)" class="head-metrics" :title="cardHeadInline(whale)">
            {{ cardHeadInline(whale) }}
          </div>
          <button
            type="button"
            class="monitor-btn"
            :class="{ on: isWhaleMonitored(whale.id) }"
            :title="isWhaleMonitored(whale.id) ? '取消关注' : '关注巨鲸'"
            @click.stop="onToggleMonitor(whale)"
          >
            {{ isWhaleMonitored(whale.id) ? '已关注' : '关注' }}
          </button>
        </div>
        <div class="card-name-row">
          <button
            type="button"
            class="card-name"
            :title="`查看 ${cardTitle(whale)} 转账记录`"
            @click="onWhaleNameClick(whale, $event)"
          >
            {{ cardTitle(whale) }}
          </button>
          <span v-if="cardExposureText(whale)" class="name-totals">{{ cardExposureText(whale) }}</span>
        </div>
        <div v-if="sideWinTag(whale)" class="side-meta">{{ sideWinTag(whale) }}</div>
        <div v-if="cardPositions(whale).length" class="pnl-strip">
          <PnlProgressBar compact :pct="positionsAggregatePnlPct(cardPositions(whale))" />
        </div>
        <div
          v-if="cardPositions(whale).length && useDetailedPositions(whale)"
          class="positions detailed"
          @click.stop
        >
          <div
            v-for="pos in cardPositions(whale)"
            :key="`${pos.coin}-${pos.side}`"
            class="pos-detail"
            @click="openPosition(whale, pos)"
          >
            <div class="pos-top">
              <strong>{{ pos.coin }}</strong>
              <span :class="pos.side === 'long' ? 'pnl-up' : 'pnl-down'">
                {{ pos.side === 'long' ? '多' : '空' }}
              </span>
              <span v-if="pos.leverage" class="lev">{{ pos.leverage }}x</span>
              <span
                v-if="positionIsStaleHold(pos)"
                class="stale-hold-hint"
              >
                长期持仓
              </span>
              <span class="val">{{ formatUsd(pos.positionValue) }}</span>
            </div>
            <div class="pos-bot">
              <button
                type="button"
                class="entry"
                :class="{
                  multi: entryFillCount(pos) > 1,
                  open: isEntryFillsExpanded(whale.id, pos),
                }"
                @click.stop="toggleEntryFills(whale.id, pos)"
              >
                开 {{ formatPrice(pos.entryPx) }}
                <span v-if="entryFillCount(pos) > 1" class="multi-tag">多笔</span>
              </button>
              <PnlProgressBar compact :pct="positionPnlPct(pos)" />
            </div>
            <p
              v-if="positionHoldLine(pos)"
              class="pos-hold-line"
              :class="{ 'stale-open': positionIsStaleHold(pos) }"
            >
              {{ positionHoldLine(pos) }}
            </p>
            <ul
              v-if="isEntryFillsExpanded(whale.id, pos) && entryFillCount(pos) > 1"
              class="entry-fills"
              @click.stop
            >
              <template v-for="(row, rowIndex) in entryFillDisplayItems(pos)" :key="`${row.type}-${rowIndex}`">
                <li v-if="row.type === 'gap'" class="entry-fill-gap">...</li>
                <li v-else>
                  <span class="fill-kind" :class="entryFillKind(row.fill, row.index)">
                    {{ entryFillLabel(row.fill, row.index) }}
                  </span>
                  <span>{{ formatPrice(row.fill.price) }}</span>
                  <span class="dim">· {{ formatUsd(row.fill.usd) }}</span>
                  <span
                    class="dim"
                    :class="{ 'stale-open': entryFillKind(row.fill, row.index) === 'open' && isOpenTimeStale(row.fill.time) }"
                  >· {{ formatTimeShort(row.fill.time) }}</span>
                </li>
              </template>
            </ul>
          </div>
        </div>
        <div
          v-else-if="cardPositions(whale).length"
          class="positions"
          @click.stop
        >
          <button
            v-for="pos in cardPositions(whale)"
            :key="`${pos.coin}-${pos.side}`"
            type="button"
            class="pos"
            :class="pos.side"
            @click="openPosition(whale, pos)"
          >
            {{ pos.coin }} {{ pos.side === 'long' ? '多' : '空' }}
            <span v-if="pos.leverage" class="pos-lev">{{ pos.leverage }}x</span>
            {{ formatUsd(pos.positionValue) }}
          </button>
        </div>
        <el-alert
          v-if="whale.error"
          :title="whaleStore.refreshingWhaleIds[whale.id] ? '刷新中，请稍候' : whale.error"
          :type="whaleStore.refreshingWhaleIds[whale.id] ? 'info' : 'warning'"
          :closable="false"
          show-icon
        />
        <p v-if="whale.error && !whaleStore.refreshingWhaleIds[whale.id]" class="retry-hint">
          点击卡片可重试拉取
        </p>
      </div>
    </div>

    <div v-if="!(loading && !whales.length) && sortedWhales.length > WHALE_PAGE_SIZE" class="pager">
      <button
        type="button"
        class="pager-btn"
        :disabled="page <= 1"
        @click="page = 1"
      >
        首页
      </button>
      <button
        type="button"
        class="pager-btn"
        :disabled="page <= 1"
        @click="page -= 1"
      >
        上一页
      </button>
      <span class="pager-info">第 {{ page }}/{{ pageCount }} 页 · 共 {{ sortedWhales.length }} 条</span>
      <button
        type="button"
        class="pager-btn"
        :disabled="page >= pageCount"
        @click="page += 1"
      >
        下一页
      </button>
    </div>

    <PositionDetailDialog
      ref="positionDialog"
      :whales="whales"
      :quotes="quotes || {}"
      @focus-whale="emit('focusWhale', $event)"
      @closed="dialogOpen = false"
    />
  </el-card>
</template>

<style scoped>
.panel {
  position: relative;
  height: 100%;
  min-height: 0;
  background: var(--card);
  border: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}
.panel :deep(.el-card__header) {
  position: relative;
  padding-right: 110px;
}
.panel :deep(.el-card__body) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.head {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-weight: 600;
}
.head-toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex: 0 0 auto;
  margin-left: auto;
}
.load-progress {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--card) 80%, transparent);
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  transition:
    opacity 0.55s ease,
    transform 0.55s ease,
    border-color 0.3s ease;
}
.load-progress.leaving {
  opacity: 0;
  transform: translateY(-4px) scale(0.96);
  border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
}
.odometer {
  display: inline-flex;
  align-items: stretch;
  height: 1.15em;
  overflow: hidden;
  line-height: 1;
}
.digit-slot {
  position: relative;
  display: inline-block;
  width: 0.72em;
  height: 1.15em;
  overflow: hidden;
}
.digit-reel {
  display: flex;
  flex-direction: column;
  transition: transform 0.38s cubic-bezier(0.2, 0.8, 0.2, 1);
  will-change: transform;
}
.digit-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 1.15em;
  font-variant-numeric: tabular-nums;
}
.progress-slash {
  opacity: 0.55;
  margin: 0 1px;
}
.progress-total {
  font-variant-numeric: tabular-nums;
}
.load-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--accent) 35%, transparent);
  border-top-color: var(--accent);
  box-sizing: border-box;
}
.load-dot.spin {
  animation: whale-spin 0.8s linear infinite;
}
@keyframes whale-spin {
  to {
    transform: rotate(360deg);
  }
}
.insight-strip {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  min-height: 0;
  padding: 4px 2px;
  border: 0;
  border-radius: 0;
  background: transparent;
  font-size: 12px;
  line-height: 1.35;
  box-sizing: border-box;
}
.market-summary {
  gap: 4px;
  width: 100%;
  align-items: flex-start;
  text-align: left;
}
.market-summary .value-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-start;
  gap: 4px;
  width: 100%;
}
.market-summary .summary-hint {
  width: 100%;
  text-align: left;
}
.risk-banner.long_win {
  background: transparent;
}
.risk-banner.short_win {
  background: transparent;
}
.risk-banner.both_win {
  background: transparent;
}
.risk-banner.both_lose {
  background: transparent;
}
.risk-banner.mixed,
.risk-banner.flat {
  background: transparent;
}
.summary-hint {
  color: #e6a23c;
  font-size: 11px;
  font-weight: 600;
}
.risk-detail {
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  min-width: 0;
}
.summary-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  font-weight: 600;
}
.summary-line .sep {
  margin: 0 2px;
}
.ls-donut-float {
  position: absolute;
  top: 8px;
  right: 10px;
  z-index: 8;
  pointer-events: none;
}
.ls-donut {
  width: 86px;
  height: 86px;
  border-radius: 50%;
  position: relative;
  box-shadow: 0 8px 20px #00000066;
}
.ls-donut-core {
  position: absolute;
  inset: 14px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--card) 92%, #000 8%);
  border: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  font-size: 13px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.ls-donut-core .up {
  color: var(--bull);
}
.ls-donut-core .down {
  color: var(--bear);
}
.dim {
  color: var(--muted);
  font-weight: 500;
}
.stale-open,
.dim.stale-open {
  color: #e6a23c;
  font-weight: 700;
}
.up {
  color: var(--bull);
}
.down {
  color: var(--bear);
}
.coin-filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
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
.filter-row {
  display: flex;
  align-items: stretch;
  gap: 8px;
  width: 100%;
  min-width: 0;
}
.direction-chips {
  display: flex;
  flex: 1 1 52%;
  min-width: 0;
  flex-wrap: nowrap;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: color-mix(in srgb, var(--card) 70%, transparent);
}
.direction-chip {
  flex: 1 1 0;
  min-width: 0;
  height: 28px;
  margin: 0;
  padding: 0 4px;
  border: 0;
  border-radius: 0;
  border-left: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  text-align: center;
  cursor: pointer;
  transition: none;
  white-space: nowrap;
}
.direction-chip:first-child {
  border-left: 0;
}
.direction-chip.on {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}
.sort-chips {
  display: flex;
  flex: 1 1 48%;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: color-mix(in srgb, var(--card) 70%, transparent);
}
.sort-chip {
  flex: 1 1 0;
  min-width: 0;
  height: 28px;
  padding: 0 4px;
  border: 0;
  border-radius: 0;
  border-left: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: none;
  white-space: nowrap;
}
.sort-chip:first-child {
  border-left: 0;
}
.sort-chip.on {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}
.list {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: auto;
  scrollbar-gutter: stable;
  padding-right: 4px;
}
.whale-item {
  position: relative;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--card) 80%, #000 8%);
  cursor: pointer;
  box-shadow: inset 0 0 0 1px transparent;
}
.whale-item.active {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent);
}
.whale-item.locate-flash {
  border-color: var(--accent);
  animation: whale-locate-flash 2.6s ease-out;
}
@keyframes whale-locate-flash {
  0%,
  18% {
    box-shadow:
      0 0 0 2px color-mix(in srgb, var(--accent) 75%, transparent),
      0 0 20px color-mix(in srgb, var(--accent) 40%, transparent);
    background: color-mix(in srgb, var(--accent) 20%, var(--card));
  }
  45% {
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent);
    background: color-mix(in srgb, var(--accent) 10%, var(--card));
  }
  100% {
    box-shadow: inset 0 0 0 1px transparent;
    background: color-mix(in srgb, var(--card) 80%, #000 8%);
  }
}
.whale-item.monitored {
  border-color: color-mix(in srgb, #e6a23c 55%, var(--border));
}
.whale-item.has-error {
  border-color: color-mix(in srgb, #e6a23c 55%, var(--border));
  background: color-mix(in srgb, #e6a23c 8%, var(--card));
}
.whale-item.refreshing {
  opacity: 0.85;
}
@keyframes whale-refresh-pulse {
  0%,
  100% {
    opacity: 0.35;
    transform: scale(0.85);
  }
  50% {
    opacity: 1;
    transform: scale(1);
  }
}
.retry-hint {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--muted);
  font-weight: 500;
}
.pager {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding-top: 10px;
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
  font-weight: 600;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.stale-open {
  color: #e6a23c;
  font-weight: 700;
}
.monitor-btn {
  flex: 0 0 auto;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}
.monitor-btn:hover {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
}
.monitor-btn.on {
  color: #fff;
  border-color: #e6a23c;
  background: #e6a23c;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}
.head-metrics {
  flex: 1 1 12em;
  min-width: 0;
  font-size: 12px;
  line-height: 1.35;
  color: var(--muted);
  overflow-wrap: anywhere;
  word-break: break-word;
}
.card-name-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px 10px;
  margin-top: 8px;
  min-width: 0;
}
.card-name {
  display: inline;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  font: inherit;
  font-size: 16px;
  font-weight: 700;
  line-height: 1.3;
  color: var(--text);
  word-break: break-word;
  text-align: left;
  cursor: pointer;
}
.card-name:hover {
  color: var(--accent);
  text-decoration: underline;
}
.name-totals {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  line-height: 1.35;
}
.name-totals .sep {
  margin: 0 4px;
  opacity: 0.6;
}
.tier-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 700;
  line-height: 1.2;
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--muted);
  background: transparent;
}
.tier-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  flex: none;
}
.tier-badge.high {
  color: var(--bull);
  border-color: color-mix(in srgb, var(--bull) 40%, var(--border));
  background: color-mix(in srgb, var(--bull) 10%, transparent);
}
.tier-badge.mid {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
.tier-badge.watch {
  color: #c4a35a;
  border-color: color-mix(in srgb, #c4a35a 40%, var(--border));
  background: color-mix(in srgb, #c4a35a 10%, transparent);
}
.tier-badge.low {
  color: var(--bear);
  border-color: color-mix(in srgb, var(--bear) 40%, var(--border));
  background: color-mix(in srgb, var(--bear) 10%, transparent);
}
.dir-tag {
  flex: none;
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 7px;
  border-radius: 4px;
  border: 1px solid var(--border);
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
  transition: none;
  animation: none;
}
.dir-tag.long {
  color: var(--bull);
  border-color: color-mix(in srgb, var(--bull) 40%, var(--border));
  background: color-mix(in srgb, var(--bull) 12%, transparent);
}
.dir-tag.short {
  color: var(--bear);
  border-color: color-mix(in srgb, var(--bear) 40%, var(--border));
  background: color-mix(in srgb, var(--bear) 12%, transparent);
}
.dir-tag.neutral {
  color: var(--muted);
  border-color: var(--border);
  background: transparent;
}
.row strong {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fold-btn,
.pos-count {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 14px;
  padding: 0;
}
.card-head .monitor-btn {
  margin-left: auto;
}
.fold-btn {
  cursor: pointer;
}
.pos-count {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.rank {
  width: 20px;
  color: var(--muted);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #e6a23c;
}
.dot.long {
  background: var(--bull);
}
.dot.short {
  background: var(--bear);
}
.meta,
.addr {
  margin-top: 6px;
  color: var(--muted);
  font-size: 14px;
}
.side-meta {
  margin-top: 6px;
  font-size: 12px;
  color: var(--accent);
}
.pnl-strip {
  margin-top: 8px;
}
.positions {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.positions.detailed {
  flex-direction: column;
  flex-wrap: nowrap;
  gap: 8px;
}
.pos {
  border: 1px solid var(--border);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  padding: 3px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--text);
  cursor: pointer;
}
.pos.long {
  color: var(--bull);
  border-color: color-mix(in srgb, var(--bull) 35%, var(--border));
  background: color-mix(in srgb, var(--bull) 10%, transparent);
}
.pos.short {
  color: var(--bear);
  border-color: color-mix(in srgb, var(--bear) 35%, var(--border));
  background: color-mix(in srgb, var(--bear) 10%, transparent);
}
.pos-lev {
  margin: 0 2px;
  opacity: 0.8;
  font-weight: 700;
}
.pos:hover {
  outline: 1px solid var(--accent);
}
.pos-detail {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--card) 70%, transparent);
  cursor: pointer;
  min-width: 0;
}
.pos-detail:hover {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
}
.pos-top,
.pos-bot {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}
.pos-hold-line {
  margin: 2px 0 0;
  font-size: 11px;
  color: var(--muted);
  line-height: 1.35;
}
.pos-hold-line.stale-open {
  color: #e6a23c;
}
.pos-top strong {
  font-size: 14px;
  letter-spacing: 0.03em;
}
.pos-top .val {
  margin-left: auto;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--text);
}
.pos-top .lev {
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.stale-hold-hint {
  flex: 1 1 12em;
  font-size: 11px;
  font-weight: 700;
  line-height: 1.35;
  color: #e6a23c;
}
.pos-bot {
  margin-top: 6px;
  gap: 10px;
}
.pos-bot .entry {
  flex: 0 0 auto;
  border: 0;
  padding: 0;
  background: transparent;
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  cursor: default;
}
.pos-bot .entry.multi {
  color: var(--accent);
  cursor: pointer;
  font-weight: 600;
}
.pos-bot .entry.multi:hover {
  text-decoration: underline;
}
.multi-tag {
  margin-left: 1px;
  font-weight: 700;
}
.entry-fills {
  margin: 6px 0 0;
  padding: 8px 10px;
  list-style: none;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--card) 75%, transparent);
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 11px;
  max-height: 280px;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.entry-fills li {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}
.entry-fill-gap {
  justify-content: center;
  color: var(--muted);
  font-weight: 800;
  letter-spacing: 0.2em;
  opacity: 0.85;
  padding: 2px 0;
}
.fill-kind {
  min-width: 2.2em;
  font-weight: 800;
  color: var(--muted);
}
.fill-kind.add {
  color: var(--bull);
}
.fill-kind.reduce {
  color: var(--bear);
}
.entry-fills .dim {
  color: var(--muted);
}
.pos-bot :deep(.pnl-progress) {
  flex: 1 1 auto;
  min-width: 0;
}
.pnl-up {
  color: var(--bull);
}
.pnl-down {
  color: var(--bear);
}
@media (max-width: 768px) {
  .filter-row {
    flex-direction: column;
    gap: 6px;
  }
  .direction-chips,
  .sort-chips {
    flex: 1 1 auto;
    width: 100%;
  }
  .direction-chip,
  .sort-chip {
    height: 26px;
    font-size: 11px;
  }
  .risk-banner {
    display: none;
  }
  .market-summary {
    min-height: 0;
    padding: 4px 6px;
    gap: 4px;
    font-size: 11px;
  }
  .market-summary .value-line {
    width: 100%;
    flex-wrap: wrap;
    row-gap: 6px;
  }
  .market-summary .summary-hint {
    font-size: 11px;
  }
  .ls-donut-float {
    top: 4px;
    right: 6px;
  }
  .ls-donut {
    width: 70px;
    height: 70px;
  }
  .ls-donut-core {
    inset: 11px;
    font-size: 11px;
  }
  .insight-strip {
    min-height: 0;
    padding: 6px 8px;
  }
}
</style>
