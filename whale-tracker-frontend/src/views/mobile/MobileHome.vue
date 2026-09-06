<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { fetchQuotes } from '@/api';
import { useWhaleStore } from '@/stores/whale';
import { preferredCoinsState } from '@/utils/watchedCoins';
import { formatPrice, formatUsd, formatRelativeAgo } from '@/utils/format';
import { resolveWhaleTitle, whaleCardTitle, positionLastAddTime } from '@/utils/whaleReference';
import {
  positionPnlPct,
  scopedWhaleDirection,
  visibleWhalePositions,
  whaleHasPositionCoin,
} from '@/utils/whaleCardUtils';
import PositionDetailDialog from '@/components/PositionDetailDialog.vue';
import { freshModeEnabled, whaleHasFreshActivity } from '@/utils/freshMode';
import { WHALE_PAGE_SIZE, compareWhalesForDisplay, sortWhalesForDisplay } from '@/utils/topWhales';
import { isWhaleMonitored, monitoredCount } from '@/utils/monitoredWhales';
import type { RecoQuotes } from '@/utils/recommend';
import type { WhaleDirection, WhaleProfile, WhalePosition } from '@/types';

const whaleStore = useWhaleStore();
const route = useRoute();
const router = useRouter();

const quotes = ref<RecoQuotes>({});
const activeId = ref('');
const detailOpen = ref(false);
const positionDialog = ref<InstanceType<typeof PositionDetailDialog> | null>(null);

const coinFilter = ref<'all' | string>('all');
const directionFilter = ref<'all' | WhaleDirection | 'followed'>('all');
const sortMode = ref<'all' | 'positionValue' | 'positionPnl' | 'latest'>('all');
const page = ref(1);

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

const sourceWhales = computed(() => whaleStore.displayWhales || []);

const coinScopedWhales = computed(() => {
  let pool = sourceWhales.value;
  if (freshModeEnabled.value) {
    pool = pool.filter((whale) => {
      if (!whaleHasFreshActivity(whale)) return false;
      return scopedWhaleDirection(whale, coinFilter.value === 'all' ? 'all' : coinFilter.value) !== 'neutral';
    });
  }
  if (coinFilter.value === 'all') return pool;
  return pool.filter((whale) => {
    if (freshModeEnabled.value) {
      return visibleWhalePositions(whale, coinFilter.value).length > 0;
    }
    return whaleHasPositionCoin(whale, coinFilter.value);
  });
});

const coinCounts = computed(() => {
  let pool = sourceWhales.value;
  if (freshModeEnabled.value) {
    pool = pool.filter((whale) => {
      if (!whaleHasFreshActivity(whale)) return false;
      return scopedWhaleDirection(whale, 'all') !== 'neutral';
    });
  }
  const counts: Record<string, number> = { all: pool.length };
  for (const coin of preferredCoinsState.value) {
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

const directionCounts = computed(() => {
  const counts = {
    all: coinScopedWhales.value.length,
    long: 0,
    short: 0,
    followed: monitoredCount.value,
  };
  for (const whale of coinScopedWhales.value) {
    const direction = scopedWhaleDirection(whale, coinFilter.value);
    if (direction === 'long') counts.long += 1;
    else if (direction === 'short') counts.short += 1;
  }
  return counts;
});

const filteredWhales = computed(() => {
  let list = coinScopedWhales.value;
  if (directionFilter.value === 'followed') {
    list = list.filter((item) => isWhaleMonitored(item.id));
  } else if (directionFilter.value !== 'all') {
    list = list.filter(
      (item) => scopedWhaleDirection(item, coinFilter.value) === directionFilter.value,
    );
  }
  return list;
});

function cardPositions(whale: WhaleProfile) {
  // 币种筛选只决定哪些巨鲸入列，卡片内仍展示全部持仓
  return visibleWhalePositions(whale, 'all');
}

function whalePositionValueUsd(whale: WhaleProfile) {
  return cardPositions(whale).reduce((sum, pos) => sum + (Number(pos.positionValue) || 0), 0);
}

function whalePositionPnlUsd(whale: WhaleProfile) {
  return cardPositions(whale).reduce((sum, pos) => sum + (Number(pos.unrealizedPnl) || 0), 0);
}

function whaleLastAddTime(whale: WhaleProfile) {
  let latest = 0;
  for (const pos of whale.positions || []) {
    const ts = positionLastAddTime(pos) || 0;
    if (ts > latest) latest = ts;
  }
  return latest;
}

const sortedWhales = computed(() => {
  const next = [...filteredWhales.value];
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
    return sortWhalesForDisplay(next);
  }
  return next;
});

const pageCount = computed(() => Math.max(1, Math.ceil(sortedWhales.value.length / WHALE_PAGE_SIZE)));

const displayedWhales = computed(() => {
  const start = (page.value - 1) * WHALE_PAGE_SIZE;
  return sortedWhales.value.slice(start, start + WHALE_PAGE_SIZE);
});

const activeWhale = computed(() => {
  const id = activeId.value;
  if (!id) return null;
  return (
    sourceWhales.value.find((w) => w.id === id) ||
    whaleStore.enabledWhales.find((w) => w.id === id) ||
    null
  );
});

watch([coinFilter, directionFilter, sortMode], () => {
  page.value = 1;
});

watch(pageCount, (count) => {
  if (page.value > count) page.value = count;
});

function titleOf(whale: WhaleProfile) {
  return whaleCardTitle(whale);
}

function displayDirection(whale: WhaleProfile) {
  return scopedWhaleDirection(whale, coinFilter.value);
}

function dirLabel(dir: ReturnType<typeof scopedWhaleDirection>) {
  if (dir === 'long') return '偏多';
  if (dir === 'short') return '偏空';
  return '中性';
}

/** refresh 仅用户点击时触发一次，避免列表更新反复打 /refresh */
function openWhale(whale: WhaleProfile, refresh = false) {
  activeId.value = whale.id;
  detailOpen.value = true;
  whaleStore.loadWhaleTrades({ id: whale.id, name: whale.name });
  if (refresh) void whaleStore.refreshWhale(whale.id);
}

function posLine(pos: WhalePosition) {
  const pct = positionPnlPct(pos);
  const pctText = pct == null ? '' : ` ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
  return `${pos.side === 'short' ? '空' : '多'} ${formatUsd(pos.positionValue)}${pctText}`;
}

function openPosition(pos: WhalePosition) {
  if (!activeWhale.value) return;
  positionDialog.value?.open(activeWhale.value, pos);
}

function clearQueryId() {
  if (!route.query.id) return;
  const next = { ...route.query };
  delete next.id;
  void router.replace({ name: 'm-home', query: next });
}

watch(detailOpen, (open) => {
  if (!open) clearQueryId();
});

watch(
  () => String(route.query.id || ''),
  (id) => {
    if (!id) return;
    if (activeId.value === id && detailOpen.value) return;
    const hit =
      sourceWhales.value.find((w) => w.id === id) ||
      whaleStore.enabledWhales.find((w) => w.id === id);
    if (hit) openWhale(hit, false);
  },
  { immediate: true },
);

watch(
  () => sourceWhales.value.length + whaleStore.enabledWhales.length,
  () => {
    const id = String(route.query.id || '');
    if (!id || (activeId.value === id && detailOpen.value)) return;
    const hit =
      sourceWhales.value.find((w) => w.id === id) ||
      whaleStore.enabledWhales.find((w) => w.id === id);
    if (hit) openWhale(hit, false);
  },
);

async function loadQuotes() {
  const next = await fetchQuotes(preferredCoinsState.value).catch(() => null);
  if (!next) return;
  const { funding: _f, updatedAt: _u, ...prices } = next;
  const map: RecoQuotes = {};
  for (const [k, v] of Object.entries(prices)) {
    if (typeof v === 'number' && Number.isFinite(v)) map[k] = v;
  }
  quotes.value = map;
}

onMounted(() => {
  void loadQuotes();
});
</script>

<template>
  <div class="m-home">
    <section class="quote-card">
      <div class="quote-chips">
        <div v-for="coin in preferredCoinsState" :key="coin" class="quote-chip">
          <span class="q-coin">{{ coin }}</span>
          <span class="q-px">{{ quotes[coin] ? formatPrice(quotes[coin], coin) : '--' }}</span>
        </div>
      </div>
    </section>

    <section class="m-card">
      <div class="m-card-title">活跃巨鲸 · {{ sortedWhales.length }}</div>

      <div class="filters">
        <div class="chip-row">
          <button
            type="button"
            class="chip"
            :class="{ on: coinFilter === 'all' }"
            @click="coinFilter = 'all'"
          >
            全部 {{ coinCounts.all }}
          </button>
          <button
            v-for="coin in preferredCoinsState"
            :key="coin"
            type="button"
            class="chip"
            :class="{ on: coinFilter === coin }"
            @click="coinFilter = coin"
          >
            {{ coin }} {{ coinCounts[coin] ?? 0 }}
          </button>
        </div>
        <div class="chip-row">
          <button
            v-for="item in DIRECTION_FILTERS"
            :key="item.value"
            type="button"
            class="chip"
            :class="{ on: directionFilter === item.value, [item.value]: item.value !== 'all' && item.value !== 'followed' }"
            @click="directionFilter = item.value"
          >
            {{ item.label }}
            {{
              item.value === 'followed'
                ? directionCounts.followed
                : item.value === 'all'
                  ? directionCounts.all
                  : directionCounts[item.value]
            }}
          </button>
        </div>
        <div class="chip-row">
          <button
            v-for="item in SORT_MODES"
            :key="item.value"
            type="button"
            class="chip sort"
            :class="{ on: sortMode === item.value }"
            @click="sortMode = item.value"
          >
            {{ item.label }}
          </button>
        </div>
      </div>

      <div v-if="whaleStore.loading && !sourceWhales.length" class="m-empty">加载中…</div>
      <div v-else-if="!displayedWhales.length" class="m-empty">
        {{ directionFilter === 'followed' ? '当前没有关注的巨鲸' : '当前筛选项下没有巨鲸' }}
      </div>
      <div v-else class="whale-list">
        <button
          v-for="whale in displayedWhales"
          :key="whale.id"
          type="button"
          class="whale-item"
          @click="openWhale(whale, true)"
        >
          <div class="w-top">
            <span class="w-name">{{ titleOf(whale) }}</span>
            <span class="w-dir" :class="displayDirection(whale) || ''">
              {{ dirLabel(displayDirection(whale)) }}
            </span>
          </div>
          <div class="w-bot">
            <span>仓位 {{ cardPositions(whale).length }}</span>
            <span>名义 {{ formatUsd(whalePositionValueUsd(whale)) }}</span>
          </div>
        </button>
      </div>

      <div v-if="sortedWhales.length > WHALE_PAGE_SIZE" class="m-pager">
        <button type="button" class="pg" :disabled="page <= 1" @click="page = 1">首页</button>
        <button type="button" class="pg" :disabled="page <= 1" @click="page -= 1">上一页</button>
        <span class="pg-info">{{ page }}/{{ pageCount }} · {{ sortedWhales.length }}</span>
        <button type="button" class="pg" :disabled="page >= pageCount" @click="page += 1">下一页</button>
      </div>
    </section>

    <el-drawer
      v-model="detailOpen"
      direction="btt"
      size="78%"
      :title="activeWhale ? titleOf(activeWhale) : '巨鲸详情'"
      class="m-drawer"
    >
      <div v-if="activeWhale" class="detail">
        <p class="dim">
          {{
            resolveWhaleTitle([activeWhale], {
              id: activeWhale.id,
              name: activeWhale.name,
              address: activeWhale.address,
            })
          }}
        </p>
        <div v-if="!(activeWhale.positions || []).length" class="m-empty">当前无持仓</div>
        <button
          v-for="(pos, idx) in activeWhale.positions || []"
          :key="`${pos.coin}-${pos.side}-${idx}`"
          type="button"
          class="pos-card"
          @click="openPosition(pos)"
        >
          <div class="p-top">
            <strong>{{ pos.coinLabel || pos.coin }}</strong>
            <span :class="pos.side">{{ pos.side === 'short' ? '做空' : '做多' }}</span>
          </div>
          <div class="p-grid">
            <span>名义 {{ formatUsd(pos.positionValue) }}</span>
            <span>开 {{ formatPrice(pos.entryPx) }}</span>
            <span>{{ posLine(pos) }}</span>
            <span v-if="pos.openTime || pos.firstOpenTime">
              开仓 {{ formatRelativeAgo(Number(pos.lastAddTime || pos.openTime || pos.firstOpenTime) || 0) }}
            </span>
          </div>
          <span class="pos-hint">点击查看详情</span>
        </button>
      </div>
    </el-drawer>

    <PositionDetailDialog
      ref="positionDialog"
      :whales="sourceWhales"
      :quotes="quotes"
    />
  </div>
</template>

<style scoped>
.m-card {
  background: #141a24;
  border: 1px solid #1f2937;
  border-radius: 16px;
  padding: 14px;
  margin-bottom: 12px;
}
.m-card-title {
  font-size: 13px;
  font-weight: 700;
  color: #8b9bb5;
  margin-bottom: 10px;
}
.filters {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}
.chip-row {
  display: flex;
  flex-wrap: nowrap;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: none;
  padding-bottom: 1px;
}
.chip-row::-webkit-scrollbar {
  display: none;
}
.chip {
  flex: 0 0 auto;
  border: 0;
  border-radius: 999px;
  padding: 4px 12px;
  background: #1a222e;
  color: #8b9bb5;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}
.chip.on {
  background: #2a3a52;
  color: #f0f4fa;
}
.chip.long.on {
  color: #4ade80;
}
.chip.short.on {
  color: #f87171;
}
.chip.sort.on {
  color: #fbbf24;
}
.quote-card {
  margin-bottom: 12px;
}
.quote-chips {
  display: flex;
  flex-wrap: nowrap;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 2px;
  scrollbar-width: none;
}
.quote-chips::-webkit-scrollbar {
  display: none;
}
.quote-chip {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 999px;
  background: #141a24;
  border: 1px solid #1f2937;
  font-size: 11px;
  line-height: 1.2;
  white-space: nowrap;
}
.q-coin {
  color: #6a7e9c;
  font-weight: 700;
}
.q-px {
  color: #e8edf5;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}
.whale-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.whale-item {
  text-align: left;
  width: 100%;
  border: 1px solid #1a222e;
  background: #10171f;
  border-radius: 14px;
  padding: 12px 14px;
  color: inherit;
  font: inherit;
}
.w-top,
.w-bot {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.w-bot {
  margin-top: 6px;
  font-size: 12px;
  color: #8b9bb5;
}
.w-name {
  font-size: 14px;
  font-weight: 800;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.w-dir.long {
  color: #4ade80;
  font-weight: 700;
  font-size: 12px;
}
.w-dir.short {
  color: #f87171;
  font-weight: 700;
  font-size: 12px;
}
.m-empty {
  text-align: center;
  color: #6a7e9c;
  padding: 28px 8px;
  font-size: 13px;
}
.m-pager {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.pg {
  border: 0;
  border-radius: 999px;
  padding: 4px 12px;
  background: #1a222e;
  color: #b0c4de;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
}
.pg:disabled {
  opacity: 0.4;
}
.pg-info {
  font-size: 12px;
  color: #e8edf5;
  font-weight: 600;
}
.pos-card {
  display: block;
  width: 100%;
  text-align: left;
  background: #10171f;
  border: 1px solid #1a222e;
  border-radius: 12px;
  padding: 12px;
  margin-bottom: 8px;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.pos-card:active {
  border-color: #2a3a52;
  background: #141a24;
}
.pos-hint {
  display: block;
  margin-top: 8px;
  font-size: 11px;
  color: #6a7e9c;
}
.p-top {
  display: flex;
  justify-content: space-between;
  margin-bottom: 8px;
}
.p-top .long {
  color: #4ade80;
  font-weight: 700;
}
.p-top .short {
  color: #f87171;
  font-weight: 700;
}
.p-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  font-size: 12px;
  color: #8b9bb5;
}
.dim {
  color: #6a7e9c;
  font-size: 12px;
  margin: 0 0 12px;
}
</style>
