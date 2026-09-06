<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import {
  fetchPagedTrades,
  fetchWhaleTrades,
  isRetryableLoadError,
  scheduleSilentRetry,
} from '@/api';
import type { WhaleProfile, WhaleTrade } from '@/types';
import { preferredCoinFilterOptions, preferredCoinsState } from '@/utils/watchedCoins';
import { enrichTrade, type EnrichedTrade } from '@/utils/tradeEnrichment';
import type { RecoQuotes } from '@/utils/recommend';
import {
  freshModeEnabled,
  freshWindowHours,
  freshWindowMs,
  isClearlyIncreaseTrade,
  isOpeningFillTrade,
  tradePassesFreshGate,
} from '@/utils/freshMode';
import {
  formatPrice,
  formatPnl,
  formatTimeShort,
  formatUsd,
} from '@/utils/format';
import { resolveWhaleTitle } from '@/utils/whaleReference';
import { useWhaleStore } from '@/stores/whale';
import { storeToRefs } from 'pinia';

const PAGE_SIZE = 50;

const props = defineProps<{
  whales: WhaleProfile[];
  loading?: boolean;
  selectedId: string;
  selectedName: string;
  updatedAt?: number;
  quotes?: RecoQuotes;
  /** 巨鲸首屏就绪后再拉成交 */
  bootReady?: boolean;
}>();

const emit = defineEmits<{
  focusWhale: [payload: { id: string; name: string }];
}>();

const whaleStore = useWhaleStore();
const { activity } = storeToRefs(whaleStore);

const assetFilter = ref('');
const page = ref(1);
const trades = ref<WhaleTrade[]>([]);
const total = ref(0);
const pageLoading = ref(false);
let reqSeq = 0;

const tableWrap = ref<HTMLElement | null>(null);
const tableHeight = ref(360);

const coinOptions = computed(() => preferredCoinFilterOptions());
const filtered = computed(() => Boolean(props.selectedId));
const busy = computed(() => pageLoading.value || Boolean(props.loading && !trades.value.length));
const scopeHint = computed(() => {
  const freshHint = freshModeEnabled.value
    ? ` · 闪电模式近 ${freshWindowHours.value}h`
    : '';
  if (props.selectedId) {
    const title = resolveWhaleTitle(props.whales, {
      id: props.selectedId,
      name: props.selectedName,
    });
    return `筛选：${title} · 开仓 / 补仓 / 减仓 / 平仓${freshHint}`;
  }
  return `全部资金动态 · 开仓 / 补仓 / 减仓 / 平仓${freshHint}`;
});

function tradeSinceMs() {
  if (!freshModeEnabled.value) return undefined;
  return Date.now() - freshWindowMs();
}

/** 分页接口结果为主；仅第 1 页合并实时 activity，并截断到 PAGE_SIZE */
const rows = computed(() => {
  // 显式依赖，开关/切窗后立即重算
  void freshModeEnabled.value;
  void freshWindowHours.value;
  const now = Date.now();
  const since = tradeSinceMs();
  const map = new Map<string, WhaleTrade>();
  for (const trade of trades.value) {
    if (trade.source === 'onchain') continue;
    if (since && Number(trade.time || 0) < since) continue;
    map.set(String(trade.id || trade.hash || ''), trade);
  }
  if (page.value === 1) {
    for (const trade of activity.value) {
      if (trade.source === 'onchain') continue;
      if (since && Number(trade.time || 0) < since) continue;
      if (props.selectedId && trade.whaleId !== props.selectedId) continue;
      const id = String(trade.id || trade.hash || '');
      if (!id || map.has(id)) continue;
      if (assetFilter.value) {
        const coin = String(trade.assetLabel || trade.asset || '');
        if (coin.toUpperCase() !== assetFilter.value.toUpperCase()) continue;
      }
      map.set(id, trade);
    }
  }
  return [...map.values()]
    .sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0))
    .slice(0, PAGE_SIZE)
    .map((trade) => {
      const whale = props.whales.find((item) => item.id === trade.whaleId);
      return enrichTrade(trade, whale, props.quotes || {});
    })
    .filter((row) =>
      tradePassesFreshGate(
        row.trade,
        props.whales.find((w) => w.id === row.trade.whaleId) || null,
        now,
        whaleStore.alertHistory,
      ),
    );
});

const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));

function measureTable() {
  const el = tableWrap.value;
  if (!el) return;
  const pager = el.querySelector('.pager') as HTMLElement | null;
  const pagerH = pager?.getBoundingClientRect().height || 44;
  tableHeight.value = Math.max(200, Math.floor(el.clientHeight - pagerH - 4));
}

async function loadPage(silent = false) {
  const first = !trades.value.length;
  const seq = ++reqSeq;
  if (!silent || first) pageLoading.value = true;
  try {
    const query = {
      page: page.value,
      limit: PAGE_SIZE,
      asset: assetFilter.value || undefined,
      sinceMs: tradeSinceMs(),
    };
    const data = props.selectedId
      ? await fetchWhaleTrades(props.selectedId, query)
      : await fetchPagedTrades(query);
    if (seq !== reqSeq) return;
    trades.value = (data.trades || []).filter((item) => item.source !== 'onchain');
    total.value = data.total || trades.value.length;
  } catch (err) {
    if (seq !== reqSeq) return;
    if (isRetryableLoadError(err)) {
      scheduleSilentRetry('trades', () => loadPage(true));
    } else if (!silent || first) {
      trades.value = [];
      total.value = 0;
      ElMessage.error(err instanceof Error ? err.message : '资金动态加载失败');
    }
  } finally {
    if (seq === reqSeq) {
      pageLoading.value = false;
      nextTick(() => measureTable());
    }
  }
}

watch(
  [
    () => props.selectedId,
    assetFilter,
    page,
    () => props.updatedAt,
    freshModeEnabled,
    freshWindowHours,
    () => props.bootReady,
  ],
  ([selectedId, , pageVal, , freshOn, freshHours, ready], prev) => {
    if (!ready) return;
    if (
      prev &&
      (selectedId !== prev[0] ||
        assetFilter.value !== prev[1] ||
        freshOn !== prev[4] ||
        freshHours !== prev[5]) &&
      pageVal !== 1
    ) {
      pageLoading.value = true;
      page.value = 1;
      return;
    }
    const soft =
      Boolean(prev) &&
      selectedId === prev![0] &&
      assetFilter.value === prev![1] &&
      pageVal === prev![2] &&
      props.updatedAt !== prev![3] &&
      freshOn === prev![4] &&
      freshHours === prev![5] &&
      ready === prev![6];
    if (!soft) pageLoading.value = true;
    void loadPage(soft);
  },
  { immediate: true },
);

watch(preferredCoinsState, (coins) => {
  if (assetFilter.value && !coins.includes(assetFilter.value)) assetFilter.value = '';
});

function onReset() {
  assetFilter.value = '';
  page.value = 1;
  whaleStore.clearWhaleFilter();
  void loadPage(false);
}

function onWhaleClick(row: EnrichedTrade) {
  const trade = row.trade;
  if (trade.whaleId) {
    const whale = props.whales.find((item) => item.id === trade.whaleId);
    if (!whale) {
      ElMessage.info(`未在监控列表中找到 ${trade.whaleName}`);
      return;
    }
    emit('focusWhale', { id: whale.id, name: whale.name });
    return;
  }
  void copyAddress(trade.from || trade.to);
}

async function copyAddress(value: string) {
  const addr = (value || '').trim();
  if (!addr) {
    ElMessage.warning('没有可复制的地址');
    return;
  }
  try {
    await navigator.clipboard.writeText(addr);
    ElMessage.success('地址已复制');
  } catch {
    ElMessage.error('复制失败');
  }
}

function sideLabel(row: EnrichedTrade) {
  if (row.isClosing) return row.side === 'long' ? '减/平多' : '减/平空';
  if (isOpeningFillTrade(row.trade)) {
    return row.side === 'long' ? '开多' : '开空';
  }
  if (isClearlyIncreaseTrade(row.trade)) {
    return row.side === 'long' ? '加多' : '加空';
  }
  return row.side === 'long' ? '开/加多' : '开/加空';
}

function rowWhaleTitle(row: EnrichedTrade) {
  const address = row.trade.from || row.trade.to;
  return resolveWhaleTitle(props.whales, {
    id: row.trade.whaleId || undefined,
    name: row.trade.whaleName,
    address: address ? String(address) : undefined,
  });
}

let resizeObs: ResizeObserver | undefined;
onMounted(() => {
  measureTable();
  if (typeof ResizeObserver !== 'undefined' && tableWrap.value) {
    resizeObs = new ResizeObserver(() => measureTable());
    resizeObs.observe(tableWrap.value);
  }
});
onUnmounted(() => {
  resizeObs?.disconnect();
});

defineExpose({
  refresh: onReset,
});
</script>

<template>
  <div class="whale-table">
    <div class="toolbar">
      <el-select
        v-model="assetFilter"
        size="small"
        clearable
        filterable
        placeholder="币种筛选"
        class="asset"
        popper-class="pc-dark-select"
      >
        <el-option
          v-for="opt in coinOptions"
          :key="opt.value"
          :label="opt.label"
          :value="opt.value"
        />
      </el-select>
      <span class="toolbar-spacer" />
      <button type="button" class="reset-btn" @click="onReset">重置</button>
    </div>

    <p class="hint" :class="{ muted: !filtered }">{{ scopeHint }}</p>

    <div ref="tableWrap" class="body" v-loading="busy">
      <el-empty v-if="!busy && !rows.length" description="暂无仓位相关记录（数据补齐中）" />
      <div v-else class="list">
        <article
          v-for="row in rows"
          :key="row.trade.id"
          class="row"
          :class="{ close: row.isClosing, [row.side]: true }"
        >
          <div class="line data-line">
            <span class="side" :class="row.side">{{ sideLabel(row) }}</span>
            <strong class="asset">{{ row.trade.assetLabel || row.trade.asset }}</strong>
            <button
              type="button"
              class="whale"
              :title="rowWhaleTitle(row)"
              @click="onWhaleClick(row)"
            >
              {{ rowWhaleTitle(row) }}
            </button>
          </div>
          <div class="line amount-line">
            <strong class="usd">{{ formatUsd(row.trade.amountUsd) }}</strong>
            <span class="price">价 {{ formatPrice(row.trade.price || row.entryPx) }}</span>
            <span
              v-if="row.isClosing"
              class="pnl"
              :class="(row.trade.closedPnl || 0) >= 0 ? 'up' : 'down'"
            >
              {{ formatPnl(row.trade.closedPnl) }}
            </span>
            <span
              v-else-if="row.pnlPct != null"
              class="pnl"
              :class="row.pnlPct >= 0 ? 'up' : 'down'"
            >
              {{ row.pnlPct >= 0 ? '+' : '' }}{{ row.pnlPct.toFixed(1) }}%
            </span>
            <span v-else class="pnl dim">--</span>
          </div>
          <div class="line time-line">
            <span class="time">{{ formatTimeShort(row.trade.time) }}</span>
            <span v-if="row.entryPx" class="sub">开 {{ formatPrice(row.entryPx) }}</span>
            <span v-if="row.markPx" class="sub">现 {{ formatPrice(row.markPx) }}</span>
          </div>
        </article>
      </div>

      <div v-if="total > PAGE_SIZE" class="pager">
        <button
          type="button"
          class="pager-btn"
          :disabled="page <= 1 || busy"
          @click="page = 1"
        >
          首页
        </button>
        <button
          type="button"
          class="pager-btn"
          :disabled="page <= 1 || busy"
          @click="page = Math.max(1, page - 1)"
        >
          上一页
        </button>
        <span class="pager-info">第 {{ page }}/{{ pageCount }} 页 · 共 {{ total }} 条</span>
        <button
          type="button"
          class="pager-btn"
          :disabled="page >= pageCount || busy"
          @click="page = Math.min(pageCount, page + 1)"
        >
          下一页
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.whale-table {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.toolbar-spacer {
  flex: 1 1 auto;
}
.toolbar .asset {
  width: 128px;
}
.toolbar .asset :deep(.el-select__wrapper) {
  min-height: 30px;
  border-radius: 999px;
  background: #1a222e;
  box-shadow: 0 0 0 1px #1f2937 inset;
}
.toolbar .asset :deep(.el-select__wrapper:hover),
.toolbar .asset :deep(.el-select__wrapper.is-focused) {
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 45%, #1f2937) inset;
}
.toolbar .asset :deep(.el-select__placeholder),
.toolbar .asset :deep(.el-select__selected-item) {
  color: var(--soft, #8b9bb5);
  font-size: 12px;
  font-weight: 600;
}
.reset-btn {
  border: 0;
  border-radius: 999px;
  padding: 5px 14px;
  background: #1a222e;
  color: #b0c4de;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.reset-btn:hover {
  background: #2a3a52;
  color: #f0f4fa;
}
.hint {
  margin: 0;
  font-size: 12px;
  color: var(--text);
  line-height: 1.4;
}
.hint.muted {
  color: var(--muted);
}
.body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-bottom: 4px;
}
.row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 10px 8px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--card) 88%, #000 12%);
}
.line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  width: 100%;
}
.line > * {
  flex: 1 1 0;
  min-width: 0;
  text-align: left;
}
.data-line .side {
  flex: 0 0 auto;
  text-align: center;
}
.data-line .asset {
  flex: 1 1 auto;
}
.data-line .whale {
  flex: 1 1 auto;
  text-align: right;
}
.side {
  font-size: 11px;
  font-weight: 700;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--muted);
  white-space: nowrap;
}
.side.long {
  color: var(--bull);
  border-color: color-mix(in srgb, var(--bull) 40%, var(--border));
}
.side.short {
  color: var(--bear);
  border-color: color-mix(in srgb, var(--bear) 40%, var(--border));
}
.asset {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.whale {
  border: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-weight: 700;
  font-size: 13px;
  padding: 0;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.whale:hover {
  color: var(--accent);
  text-decoration: underline;
}
.usd {
  font-size: 13px;
  font-weight: 700;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.price,
.pnl,
.time,
.sub {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pnl {
  font-weight: 700;
  text-align: right;
}
.pnl.dim {
  font-weight: 500;
}
.amount-line .price {
  text-align: center;
}
.time-line .time {
  font-weight: 600;
  color: var(--text);
}
.time-line .sub {
  text-align: center;
}
.time-line .sub:last-child {
  text-align: right;
}
.up {
  color: var(--bull);
}
.down {
  color: var(--bear);
}
.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding-top: 8px;
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
</style>
