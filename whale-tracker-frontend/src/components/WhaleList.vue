<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { CopyDocument, View } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import PnlProgressBar from '@/components/PnlProgressBar.vue';
import PositionDetailDialog from '@/components/PositionDetailDialog.vue';
import type { WhaleDirection, WhalePosition, WhaleProfile } from '@/types';
import { directionLabel, formatPrice, formatRelativeAgo, formatTimeShort, formatUsd, isOpenTimeStale } from '@/utils/format';
import {
  formatWhaleMetricLines,
  whaleCardIdentityLine,
  positionFirstOpenTime,
  positionLastAddTime,
} from '@/utils/whaleReference';
import { compareWhalesForDisplay } from '@/utils/topWhales';
import { stabilizeIds } from '@/utils/whaleState';
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
  positionPnlPct,
  positionsAggregatePnlPct,
  scopedWhaleDirection,
  visibleWhalePositions,
  whaleHasPositionCoin,
} from '@/utils/whaleCardUtils';
import { useWhaleStore } from '@/stores/whale';
import { preferredCoinsState } from '@/utils/watchedCoins';
import {
  isWhaleMonitored,
  toggleWhaleMonitor,
} from '@/utils/monitoredWhales';
import { fetchWhalePosition } from '@/api';
import type { WhaleServerSummary } from '@/api';

const props = defineProps<{
  whales: WhaleProfile[];
  loading: boolean;
  selectedId: string;
  quotes?: RecoQuotes;
  serverSummary?: WhaleServerSummary | null;
  snapshotVersion?: number;
}>();

const emit = defineEmits<{
  detail: [whale: WhaleProfile];
  focusWhale: [payload: { id: string; name: string; coin?: string }];
  selectTransfers: [whale: WhaleProfile];
}>();

const whaleStore = useWhaleStore();
const entryFillLoading = ref<Record<string, boolean>>({});

/** Keep only view state here; entity values always come from the shared store. */

const directionFilter = ref<'all' | WhaleDirection | 'followed'>('all');
const sortMode = ref<'all' | 'positionValue' | 'positionPnl' | 'latest'>('all');
const coinFilter = ref<'all' | string>('all');
const positionDialog = ref<{
  open: (
    whale: WhaleProfile,
    pos: WhalePosition | { coin: string; side?: 'long' | 'short' },
  ) => void;
} | null>(null);
const preferredCoins = preferredCoinsState;
const expandedEntryKeys = ref<Record<string, boolean>>({});
const HIGHLIGHT_MS = 5000;
const highlightedId = ref<string | null>(null);
let focusSeq = 0;
let highlightTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 币种筛选：决定哪些巨鲸出现在列表中 */
const listHovered = ref(false);
const dialogOpen = ref(false);
// Freeze only ordering while interacting; position values remain live.
const updatePaused = computed(() => listHovered.value || dialogOpen.value || Boolean(highlightedId.value));
const sourceWhales = computed(() => whaleStore.displayWhales);

const coinScopedWhales = computed(() => {
  const pool = sourceWhales.value;
  return coinFilter.value === 'all' ? pool : pool.filter(whale => whaleHasPositionCoin(whale, coinFilter.value));
});

const marketSummary = computed(() => buildWhaleMarketSummary(whaleStore.enabledWhales, coinFilter.value));
const riskSummary = computed(() => buildWhaleRiskSummary(whaleStore.enabledWhales, coinFilter.value));

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
    followed: coinScopedWhales.value.filter(whale => isWhaleMonitored(whale.id)).length,
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

function initialize() { return Promise.resolve(); }

function displayDirection(whale: WhaleProfile) {
  return scopedWhaleDirection(whale, coinFilter.value);
}

const coinCounts = computed(() => {
  let pool = sourceWhales.value;
  const counts: Record<string, number> = { all: pool.length };
  for (const coin of preferredCoins.value) {
    counts[coin] = pool.filter((whale) => whaleHasPositionCoin(whale, coin)).length;
  }
  return counts;
});

function cardPositions(whale: WhaleProfile) {
  // 币种筛选只决定哪些巨鲸入列，卡片内仍展示全部持仓
  return sortedPositions(visibleWhalePositions(whale, 'all'));
}

const rankedWhales = computed(() => {
  const rows = coinScopedWhales.value.filter(whale => directionFilter.value === 'followed'
    ? isWhaleMonitored(whale.id)
    : directionFilter.value === 'all' || scopedWhaleDirection(whale, coinFilter.value) === directionFilter.value);
  const metric = (whale: WhaleProfile) => {
    const positions = visibleWhalePositions(whale, 'all');
    if (sortMode.value === 'positionValue') return positions.reduce((sum, pos) => sum + Math.abs(Number(pos.positionValue) || 0), 0);
    if (sortMode.value === 'positionPnl') return positions.reduce((sum, pos) => sum + (Number(pos.unrealizedPnl) || 0), 0);
    if (sortMode.value === 'latest') return positions.reduce((max, pos) => Math.max(max, Number(pos.lastAddTime || pos.openTime) || 0), 0);
    return 0;
  };
  return rows.sort((a, b) => metric(b) - metric(a) || compareWhalesForDisplay(a, b) || a.id.localeCompare(b.id));
});
const orderedIds = ref<string[]>([]);
watch([rankedWhales, updatePaused], () => {
  orderedIds.value = stabilizeIds(orderedIds.value, rankedWhales.value.map(whale => whale.id), updatePaused.value);
}, { immediate: true });
const displayedWhales = computed(() => orderedIds.value.map(id => whaleStore.whalesById[id]).filter((whale): whale is WhaleProfile => Boolean(whale)));

/** 开仓成交笔数；>1 标为多笔 */
function displayRank(index: number) {
  return index + 1;
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

function isCardExpanded(id: string) {
  return Boolean(expandedIds.value[id]);
}

function toggleCardExpand(id: string) {
  expandedIds.value = { ...expandedIds.value, [id]: !expandedIds.value[id] };
}

function sortedPositions(positions: WhalePosition[]) {
  return [...positions].sort((a, b) => (b.positionValue || 0) - (a.positionValue || 0));
}

function openPosition(whale: WhaleProfile, pos: WhalePosition) {
  dialogOpen.value = true;
  positionDialog.value?.open(whale, pos);
}

/** 第一行：月盈亏（%）· 累计（%）· 胜率 · 笔数 */
function cardHeadInline(whale: WhaleProfile) {
  const metrics = formatWhaleMetricLines(whale);
  return metrics.statsLine || metrics.volumeLine || '';
}

function cardIdentityLine(whale: WhaleProfile) {
  return whaleCardIdentityLine(whale);
}

/** 关注页：展开后才显示详细仓位；默认收起为简洁条 */
function useDetailedPositions(whale?: WhaleProfile) {
  if (!isFollowTab.value || !whale) return false;
  return isCardExpanded(whale.id);
}

function onToggleMonitor(whale: WhaleProfile) {
  toggleWhaleMonitor(whale.id);
}

function flashWhaleCard(id: string) {
  if (highlightTimer) clearTimeout(highlightTimer);
  highlightedId.value = id;
  highlightTimer = setTimeout(() => {
    if (highlightedId.value === id) highlightedId.value = null;
    // Highlight expiry must not change the server page query or remove the located whale.
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

async function toggleEntryFills(whaleId: string, pos: WhalePosition) {
  if (entryFillCount(pos) <= 1) return;
  const key = entryFillKey(whaleId, pos);
  const expanding = !expandedEntryKeys.value[key];
  expandedEntryKeys.value = { ...expandedEntryKeys.value, [key]: expanding };
  if (!expanding || (pos.entryFills?.length && pos.entryFillsOmitted === 0) || entryFillLoading.value[key]) return;

  entryFillLoading.value = { ...entryFillLoading.value, [key]: true };
  try {
    const requested = whaleStore.whalesById[whaleId];
    const { position } = await fetchWhalePosition(whaleId, pos.coin, pos.side);
    whaleStore.patchWhalePosition(whaleId, pos.coin, pos.side, {
      entryFills: position.entryFills || [],
      entryFillsOmitted: position.entryFillsOmitted || 0,
      openTime: position.openTime ?? undefined,
      firstOpenTime: position.firstOpenTime ?? undefined,
      lastAddTime: position.lastAddTime ?? undefined,
      openHistoryComplete: position.openHistoryComplete,
    }, requested);
  } catch (error) {
    ElMessage.warning(error instanceof Error ? `成交明细加载失败：${error.message}` : '成交明细加载失败');
  } finally {
    const next = { ...entryFillLoading.value };
    delete next[key];
    entryFillLoading.value = next;
  }
}

function isEntryFillLoading(whaleId: string, pos: WhalePosition) {
  return Boolean(entryFillLoading.value[entryFillKey(whaleId, pos)]);
}

function clearLocatedWhale() {
  focusSeq += 1;
  if (highlightTimer) clearTimeout(highlightTimer);
  highlightTimer = null;
  highlightedId.value = null;
}

function selectCoinFilter(value: 'all' | string) {
  clearLocatedWhale();
  coinFilter.value = value;
}

function selectDirectionFilter(value: typeof directionFilter.value) {
  clearLocatedWhale();
  directionFilter.value = value;
}

function selectSortMode(value: typeof sortMode.value) {
  clearLocatedWhale();
  sortMode.value = value;
}

onUnmounted(() => {
  if (highlightTimer) clearTimeout(highlightTimer);
});

function onWhaleNameClick(whale: WhaleProfile, event?: Event) {
  event?.stopPropagation();
  emit('selectTransfers', whale);
}

function openWhaleDetail(whale: WhaleProfile) {
  emit('detail', whale);
}

async function copyWhaleAddress(whale: WhaleProfile, event?: Event) {
  event?.stopPropagation();
  const address = String(whale.address || '').trim();
  if (!address) {
    ElMessage.warning('该巨鲸没有可复制的地址');
    return;
  }
  try {
    await navigator.clipboard.writeText(address);
    ElMessage.success('地址已复制');
  } catch {
    try {
      const input = document.createElement('input');
      input.value = address;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      ElMessage.success('地址已复制');
    } catch {
      ElMessage.error('复制失败，请手动复制');
    }
  }
}

async function focusWhale(payload: { id: string; coin?: string }) {
  clearLocatedWhale();
  const seq = ++focusSeq;
  const whale = whaleStore.whalesById[payload.id];
  if (!whale) { ElMessage.warning('该巨鲸已不在当前监控快照中，可查看异动详情'); return; }
  if (!whaleStore.displayWhales.some(item => item.id === payload.id)) {
    emit('detail', whale);
    return;
  }
  dialogOpen.value = false;
  directionFilter.value = 'all';
  coinFilter.value = 'all';
  expandedIds.value = { ...expandedIds.value, [payload.id]: true };
  // Freeze ordering and materialize card heights before measuring the target.
  // content-visibility's estimated heights otherwise shift during a long scroll.
  highlightedId.value = payload.id;
  await nextTick();
  if (seq !== focusSeq) return;
  const el = document.getElementById('whale-card-' + payload.id);
  if (!el) { clearLocatedWhale(); ElMessage.warning('未找到对应巨鲸卡片'); return; }
  el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
  flashWhaleCard(payload.id);
}

defineExpose({ focusWhale, initialize, setCoinFilter: (coin: string) => { clearLocatedWhale(); coinFilter.value = coin === 'ALL' ? 'all' : coin; } });
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
              @click="selectDirectionFilter(item.value)"
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
              @click="selectSortMode(item.value)"
            >
              {{ item.label }}
            </button>
          </div>
        </div>
      </div>
    </template>
    <el-skeleton v-if="loading && !displayedWhales.length" :rows="6" animated />
    <el-empty
      v-else-if="isFollowTab && !displayedWhales.length"
      description="当前没有关注的巨鲸"
    />
    <el-empty v-else-if="!displayedWhales.length" description="当前筛选项下没有巨鲸" />
    <div
      v-else
      class="list"
      :class="{ locating: highlightedId !== null }"
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
      >
        <div class="card-head">
          <span class="rank">{{ displayRank(index) }}</span>
          <span class="dir-tag" :class="displayDirection(whale)">
            {{ directionLabel(displayDirection(whale)) }}
          </span>
          <div v-if="cardHeadInline(whale)" class="head-metrics" :title="cardHeadInline(whale)">
            {{ cardHeadInline(whale) }}
          </div>
          <div class="card-head-actions">
            <button
              type="button"
              class="detail-btn"
              title="查看巨鲸详情"
              aria-label="查看巨鲸详情"
              @click.stop="openWhaleDetail(whale)"
            >
              <el-icon :size="15"><View /></el-icon>
            </button>
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
        </div>
        <div class="card-name-row">
          <button
            type="button"
            class="card-name"
            :title="whale.address || cardIdentityLine(whale)"
            @click="onWhaleNameClick(whale, $event)"
          >
            {{ cardIdentityLine(whale) }}
          </button>
          <button
            v-if="whale.address"
            type="button"
            class="copy-addr-btn"
            title="复制地址"
            @click="copyWhaleAddress(whale, $event)"
          >
            <el-icon :size="14"><CopyDocument /></el-icon>
          </button>
          <button
            v-if="isFollowTab && cardPositions(whale).length"
            type="button"
            class="pos-expand-btn"
            :title="isCardExpanded(whale.id) ? '收起仓位' : '展开仓位'"
            @click.stop="toggleCardExpand(whale.id)"
          >
            {{ isCardExpanded(whale.id) ? '收起' : '展开' }}
          </button>
        </div>
        <div
          v-if="cardPositions(whale).length"
          class="pnl-strip"
        >
          <PnlProgressBar :pct="positionsAggregatePnlPct(cardPositions(whale))" />
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
              <li v-if="isEntryFillLoading(whale.id, pos)" class="entry-fill-gap">成交明细加载中…</li>
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
          v-else-if="cardPositions(whale).length && !isFollowTab"
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

    <PositionDetailDialog
      ref="positionDialog"
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
  content-visibility: auto;
  contain-intrinsic-size: auto 180px;
  position: relative;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--card) 80%, #000 8%);
  box-shadow: inset 0 0 0 1px transparent;
}
.whale-item.active {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent);
}
.whale-item.locate-flash {
  content-visibility: visible;
  border-color: var(--accent);
  animation: whale-locate-flash 5s ease-out;
}
.list.locating .whale-item {
  content-visibility: visible;
}
@media (max-width: 1280px) {
  /* In the stacked layout these cards precede the alerts in the same page.
     Estimated heights would move alert links while the user scrolls/clicks. */
  .whale-item {
    content-visibility: visible;
    contain-intrinsic-size: none;
  }
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
.card-head-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}
.detail-btn {
  display: grid;
  width: 26px;
  height: 24px;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.detail-btn:hover {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
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
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 8px;
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
.copy-addr-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: color-mix(in srgb, var(--card) 80%, transparent);
  color: var(--muted);
  cursor: pointer;
}
.copy-addr-btn:hover {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
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
  margin-left: 0;
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
  width: 100%;
}
.pnl-strip :deep(.pnl-progress) {
  width: 100%;
}
.pos-expand-btn {
  flex-shrink: 0;
  margin-left: auto;
  border: 1px solid color-mix(in srgb, var(--border, #2a3344) 80%, transparent);
  border-radius: 4px;
  padding: 2px 8px;
  font: inherit;
  font-size: 11px;
  font-weight: 700;
  color: var(--muted, #8b93a7);
  background: transparent;
  cursor: pointer;
}
.pos-expand-btn:hover {
  color: var(--text, #e8edf5);
  border-color: color-mix(in srgb, var(--accent, #f15a24) 50%, transparent);
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
</style>
