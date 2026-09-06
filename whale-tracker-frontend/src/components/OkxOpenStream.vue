<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { OkxOpenEvent } from '@/api';
import { preferredCoinsState } from '@/utils/watchedCoins';
import { freshModeEnabled, freshWindowHours, freshWindowMs } from '@/utils/freshMode';
import { coinIconCandidates, normalizeCoinSymbol } from '@/utils/coinIcons';

const props = defineProps<{
  opens: OkxOpenEvent[];
  positions: OkxOpenEvent[];
  loading?: boolean;
  filterTraderId?: string;
  filterTraderName?: string;
}>();

const emit = defineEmits<{
  reset: [];
}>();

const tab = ref<'positions' | 'opens'>('opens');
const page = ref(1);
const pageSize = computed(() => (tab.value === 'positions' ? 12 : 20));
const sideFilter = ref<'all' | 'long' | 'short'>('all');
const coinFilter = ref<'all' | string>('all');
const openOnly = ref(false);
const minUsd = ref(0);
/** 图标加载失败的币种 → 用字母头像 */
const iconFailed = ref<Record<string, boolean>>({});
/** 主 CDN 失败后的备用地址 */
const iconOverride = ref<Record<string, string>>({});

const preferredCoins = computed(() => preferredCoinsState.value || []);

const MIN_USD_OPTIONS = [
  { value: 0, label: '全部金额' },
  { value: 1000, label: '≥ $1k' },
  { value: 5000, label: '≥ $5k' },
  { value: 10000, label: '≥ $1万' },
  { value: 50000, label: '≥ $5万' },
];

function eventTime(item: OkxOpenEvent) {
  if (item.kind === 'close') return Number(item.closeTime) || Number(item.at) || 0;
  return Number(item.openTime) || Number(item.at) || 0;
}

function passFreshOpen(item: OkxOpenEvent) {
  if (!freshModeEnabled.value) return true;
  const at = eventTime(item);
  if (!at) return false;
  const age = Date.now() - at;
  return age >= -60_000 && age <= freshWindowMs();
}

/** 当前仓：有开仓时间则按窗口；脱敏无时间时仍保留（否则几乎全空） */
function passFreshPosition(item: OkxOpenEvent) {
  if (!freshModeEnabled.value) return true;
  const at = eventTime(item);
  if (!at) return true;
  const age = Date.now() - at;
  return age >= -60_000 && age <= freshWindowMs();
}

function passCommon(item: OkxOpenEvent, forPositions = false) {
  if (props.filterTraderId && item.traderId !== props.filterTraderId) return false;
  if (forPositions ? !passFreshPosition(item) : !passFreshOpen(item)) return false;
  if (sideFilter.value !== 'all' && item.side !== sideFilter.value) return false;
  if (coinFilter.value !== 'all') {
    const coin = (item.coin || item.instId || '').toUpperCase();
    if (!coin.includes(String(coinFilter.value).toUpperCase())) return false;
  }
  const usd = Math.abs(Number(item.margin) || Number(item.pnl) || 0);
  if (minUsd.value > 0 && usd < minUsd.value) return false;
  return true;
}

const filteredOpens = computed(() => {
  void freshModeEnabled.value;
  void freshWindowMs();
  const list = Array.isArray(props.opens) ? props.opens : [];
  return [...list]
    .filter((item) => {
      if (!passCommon(item, false)) return false;
      if (openOnly.value && item.kind !== 'open') return false;
      return true;
    })
    .sort((a, b) => (b.at || 0) - (a.at || 0));
});

const filteredPositions = computed(() => {
  void freshModeEnabled.value;
  void freshWindowMs();
  const list = Array.isArray(props.positions) ? props.positions : [];
  return [...list]
    .filter((item) => passCommon(item, true))
    .sort((a, b) => (b.at || 0) - (a.at || 0) || (b.margin || 0) - (a.margin || 0));
});

const activeList = computed(() =>
  tab.value === 'positions' ? filteredPositions.value : filteredOpens.value,
);

const sideCounts = computed(() => {
  void freshModeEnabled.value;
  void freshWindowMs();
  const source = tab.value === 'positions' ? props.positions : props.opens;
  const base = (source || []).filter((item) => {
    if (props.filterTraderId && item.traderId !== props.filterTraderId) return false;
    if (tab.value === 'positions' ? !passFreshPosition(item) : !passFreshOpen(item)) return false;
    return true;
  });
  return {
    long: base.filter((i) => i.side === 'long').length,
    short: base.filter((i) => i.side === 'short').length,
  };
});

const coinCountBase = computed(() => {
  void freshModeEnabled.value;
  void freshWindowMs();
  const source = tab.value === 'positions' ? props.positions : props.opens;
  return (source || []).filter((item) => {
    if (props.filterTraderId && item.traderId !== props.filterTraderId) return false;
    if (tab.value === 'positions' ? !passFreshPosition(item) : !passFreshOpen(item)) return false;
    if (sideFilter.value !== 'all' && item.side !== sideFilter.value) return false;
    if (tab.value === 'opens' && openOnly.value && item.kind !== 'open') return false;
    const usd = Math.abs(Number(item.margin) || Number(item.pnl) || 0);
    if (minUsd.value > 0 && usd < minUsd.value) return false;
    return true;
  });
});

const coinCounts = computed(() => {
  const source = coinCountBase.value;
  const map: Record<string, number> = { all: source.length };
  for (const coin of preferredCoins.value) {
    map[coin] = source.filter((item) => {
      const c = (item.coin || item.instId || '').toUpperCase();
      return c.includes(coin.toUpperCase());
    }).length;
  }
  return map;
});

const totalPages = computed(() =>
  Math.max(1, Math.ceil(activeList.value.length / pageSize.value)),
);

const pageItems = computed(() => {
  const start = (page.value - 1) * pageSize.value;
  return activeList.value.slice(start, start + pageSize.value);
});

watch(
  [
    () => props.filterTraderId,
    tab,
    sideFilter,
    coinFilter,
    openOnly,
    minUsd,
    freshModeEnabled,
    freshWindowHours,
  ],
  () => {
    page.value = 1;
  },
);

watch(totalPages, (n) => {
  if (page.value > n) page.value = n;
});

function toggleSide(side: 'long' | 'short') {
  sideFilter.value = sideFilter.value === side ? 'all' : side;
}

function formatTime(ms: number) {
  if (!ms) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

function formatPx(n: number) {
  const v = Number(n) || 0;
  if (!v) return '—';
  if (v >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (v >= 1) return v.toFixed(4);
  return v.toPrecision(4);
}

function formatUsd(n: number, signed = false) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  const sign = signed ? (v > 0 ? '+' : v < 0 ? '-' : '') : '';
  if (abs >= 1e4) return `${sign}${(abs / 1e4).toFixed(1)}万`;
  return `${sign}${abs.toFixed(0)}`;
}

function formatUsdDetail(n: number, signed = false) {
  const v = Number(n) || 0;
  if (!Number.isFinite(v) || v === 0) return signed ? '+0.00' : '0.00';
  const abs = Math.abs(v);
  const sign = signed ? (v > 0 ? '+' : v < 0 ? '-' : '') : v < 0 ? '-' : '';
  return `${sign}${abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatPct(n: number) {
  const v = Number(n) * 100;
  if (!Number.isFinite(v) || !v) return '';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}

function formatPctDetail(n: number) {
  const v = Number(n) * 100;
  if (!Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

function formatSize(n: number) {
  const v = Math.abs(Number(n) || 0);
  if (!v) return '—';
  return `${v.toLocaleString('en-US', { maximumFractionDigits: 4 })} 张`;
}

/** OKX 脱敏：无币种/合约 ID，仅收益与保证金等 */
function isDesensitized(item: OkxOpenEvent) {
  const coin = String(item.coin || '').trim();
  const instId = String(item.instId || '').trim();
  return !instId && !coin;
}

function pairLabel(item: OkxOpenEvent) {
  if (isDesensitized(item)) return '仓位已隐藏';
  if (item.instId) return `${item.instId.replace(/-SWAP$/i, '').replace(/-/g, '')} 永续`;
  if (item.coin) return `${item.coin}USDT 永续`;
  return '合约 永续';
}

function coinLetter(item: OkxOpenEvent) {
  const c = normalizeCoinSymbol(item.coin || item.instId) || '?';
  return c.slice(0, 1);
}

function resolvedCoinIcon(item: OkxOpenEvent) {
  const coin = normalizeCoinSymbol(item.coin || item.instId);
  if (!coin || iconFailed.value[coin]) return '';
  if (iconOverride.value[coin]) return iconOverride.value[coin];
  return coinIconCandidates(coin)[0] || '';
}

function onCoinIconError(item: OkxOpenEvent) {
  const coin = normalizeCoinSymbol(item.coin || item.instId);
  if (!coin) return;
  const urls = coinIconCandidates(coin);
  const current = resolvedCoinIcon(item);
  const idx = urls.indexOf(current);
  if (idx >= 0 && idx < urls.length - 1) {
    iconOverride.value = { ...iconOverride.value, [coin]: urls[idx + 1] };
    return;
  }
  iconFailed.value = { ...iconFailed.value, [coin]: true };
}

function mgnModeLabel(item: OkxOpenEvent) {
  if (item.mgnMode === 'cross') return '全仓';
  if (item.mgnMode === 'isolated') return '逐仓';
  return '';
}

/** OKX 维持保证金率：ecotrade 多为百分数（如 52.2），偶发小数 */
function formatMgnRatio(n?: number) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '—';
  const pct = v > 0 && v <= 1 ? v * 100 : v;
  return `${pct.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
}
</script>

<template>
  <section class="okx-right">
    <header class="panel-head">
      <div class="left">
        <div class="tabs">
          <button
            type="button"
            class="tab"
            :class="{ on: tab === 'opens' }"
            @click="tab = 'opens'"
          >
            开单记录
          </button>
          <button
            type="button"
            class="tab"
            :class="{ on: tab === 'positions' }"
            @click="tab = 'positions'"
          >
            当前仓位
          </button>
        </div>
        <p class="sub">
          <template v-if="freshModeEnabled">闪电 · 近 {{ freshWindowHours }}h · </template>
          <template v-if="filterTraderId">
            {{ filterTraderName || filterTraderId }} · {{ activeList.length }} 条
          </template>
          <template v-else>全部牛人 · {{ activeList.length }} 条 · 时间降序</template>
        </p>
      </div>
      <button type="button" class="reset-btn" title="重置为全部牛人" @click="emit('reset')">
        重置
      </button>
    </header>

    <div class="filters">
      <div class="coin-row">
        <button
          type="button"
          class="coin-chip"
          :class="{ on: coinFilter === 'all' }"
          @click="coinFilter = 'all'"
        >
          全部 {{ coinCounts.all ?? 0 }}
        </button>
        <button
          v-for="coin in preferredCoins"
          :key="coin"
          type="button"
          class="coin-chip"
          :class="{ on: coinFilter === coin }"
          @click="coinFilter = coin"
        >
          {{ coin }} {{ coinCounts[coin] ?? 0 }}
        </button>
        <select v-model.number="minUsd" class="min-usd">
          <option v-for="opt in MIN_USD_OPTIONS" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
      </div>
      <div class="side-row">
        <div class="seg side-seg">
          <button
            type="button"
            class="seg-chip long"
            :class="{ on: sideFilter === 'long' }"
            @click="toggleSide('long')"
          >
            多 {{ sideCounts.long }}
          </button>
          <button
            v-if="tab === 'opens'"
            type="button"
            class="seg-chip"
            :class="{ on: openOnly }"
            @click="openOnly = !openOnly"
          >
            开
          </button>
          <button
            type="button"
            class="seg-chip short"
            :class="{ on: sideFilter === 'short' }"
            @click="toggleSide('short')"
          >
            空 {{ sideCounts.short }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="loading && !pageItems.length" class="empty">加载中…</div>
    <div v-else-if="!pageItems.length" class="empty">暂无数据</div>

    <!-- 当前仓位：OKX 风格双列卡片 -->
    <div v-else-if="tab === 'positions'" class="pos-grid">
      <article
        v-for="item in pageItems"
        :key="item.id + '-pos'"
        class="pos-card"
        :class="[item.side, { hidden: isDesensitized(item) }]"
      >
        <div class="pos-head">
          <template v-if="!isDesensitized(item)">
            <img
              v-if="resolvedCoinIcon(item)"
              class="coin-icon-img"
              :src="resolvedCoinIcon(item)"
              :alt="item.coin || ''"
              loading="lazy"
              @error="onCoinIconError(item)"
            />
            <span
              v-else
              class="coin-icon"
              :data-coin="normalizeCoinSymbol(item.coin || item.instId)"
              >{{ coinLetter(item) }}</span
            >
          </template>
          <span v-else class="coin-icon muted" aria-hidden="true">?</span>
          <div class="pos-title">
            <div class="pair-row">
              <span class="pair">{{ pairLabel(item) }}</span>
              <span class="trader-name" :title="item.traderName">{{ item.traderName }}</span>
            </div>
            <div v-if="!isDesensitized(item)" class="badge-row">
              <span class="side-badge" :class="item.side">
                {{ item.side === 'short' ? '空' : '多' }}
                <template v-if="item.lever"> {{ item.lever }}x</template>
              </span>
              <span v-if="mgnModeLabel(item)" class="mode-badge">{{ mgnModeLabel(item) }}</span>
            </div>
          </div>
        </div>

        <p v-if="isDesensitized(item)" class="hidden-tip">该交易员已隐藏仓位详情</p>

        <div class="pos-pnl">
          <div class="pnl-col">
            <span class="pnl-k">收益额</span>
            <span class="pnl-v" :class="item.pnl >= 0 ? 'up' : 'down'">
              {{ formatUsdDetail(item.pnl, true) }} USDT
            </span>
          </div>
          <div class="pnl-col right">
            <span class="pnl-k">收益率</span>
            <span class="pnl-v" :class="item.pnlRatio >= 0 ? 'up' : 'down'">
              {{ formatPctDetail(item.pnlRatio) }}
            </span>
          </div>
        </div>

        <div v-if="isDesensitized(item)" class="pos-metrics">
          <div class="metric">
            <span class="mk">保证金</span>
            <span class="mv">
              {{ item.margin ? `${formatUsdDetail(Math.abs(item.margin))} USDT` : '—' }}
            </span>
          </div>
        </div>
        <div v-else class="pos-metrics">
          <div class="metric">
            <span class="mk">持仓量</span>
            <span class="mv">{{ formatSize(item.size) }}</span>
          </div>
          <div class="metric">
            <span class="mk">保证金</span>
            <span class="mv">
              {{ item.margin ? `${formatUsdDetail(Math.abs(item.margin))} USDT` : '—' }}
            </span>
          </div>
          <div class="metric">
            <span class="mk">开仓均价</span>
            <span class="mv">{{ formatPx(item.openAvgPx) }}</span>
          </div>
          <div class="metric">
            <span class="mk">标记价格</span>
            <span class="mv">{{ formatPx(item.markPx) }}</span>
          </div>
          <div class="metric">
            <span class="mk">预估强平价</span>
            <span class="mv">{{ formatPx(item.liqPx || 0) }}</span>
          </div>
          <div class="metric">
            <span class="mk">维持保证金率</span>
            <span class="mv">{{ formatMgnRatio(item.mgnRatio) }}</span>
          </div>
        </div>
      </article>
    </div>

    <!-- 开单记录：时间流列表 -->
    <div v-else class="feed">
      <article
        v-for="item in pageItems"
        :key="item.id"
        class="event"
        :class="[item.kind, item.side]"
      >
        <div class="event-top">
          <span class="time">{{ formatTime(item.at) }}</span>
          <span class="tag" :class="item.kind">
            {{ item.kind === 'close' ? '平仓' : '开单' }}
          </span>
          <span class="side" :class="item.side">{{ item.side === 'short' ? '空' : '多' }}</span>
          <span class="coin">{{
            isDesensitized(item) ? '该交易员已隐藏仓位详情' : item.coin || item.instId
          }}</span>
          <span class="pnl" :class="item.pnl >= 0 ? 'up' : 'down'">
            {{ formatUsd(item.pnl, true) }}
            <small v-if="formatPct(item.pnlRatio)">{{ formatPct(item.pnlRatio) }}</small>
          </span>
        </div>
        <div class="event-mid">
          <span class="trader">{{ item.traderName }}</span>
          <span v-if="item.lever" class="lever">{{ item.lever }}x</span>
          <span v-if="item.margin">保证金 {{ formatUsd(Math.abs(item.margin)) }}</span>
          <span v-if="item.openAvgPx">开 {{ formatPx(item.openAvgPx) }}</span>
          <span v-if="item.closeAvgPx">平 {{ formatPx(item.closeAvgPx) }}</span>
        </div>
      </article>
    </div>

    <footer v-if="activeList.length" class="pager">
      <button type="button" class="page-btn" :disabled="page <= 1" @click="page -= 1">上一页</button>
      <span class="page-info">{{ page }} / {{ totalPages }}</span>
      <button
        type="button"
        class="page-btn"
        :disabled="page >= totalPages"
        @click="page += 1"
      >
        下一页
      </button>
    </footer>
  </section>
</template>

<style scoped>
.okx-right {
  height: 100%;
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
  gap: 8px;
  padding: 10px 12px 8px;
  border-bottom: 1px solid var(--okx-border, #1e2630);
  flex-shrink: 0;
}
.left {
  min-width: 0;
}
.tabs {
  display: flex;
  gap: 4px;
}
.tab {
  border: 0;
  border-radius: 4px;
  padding: 4px 12px;
  background: transparent;
  color: var(--okx-text-2, #a0a8b8);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.tab.on {
  background: color-mix(in srgb, var(--okx-orange, #f15a24) 18%, var(--okx-bg-3, #1a222c));
  color: var(--okx-orange, #f15a24);
}
.sub {
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--okx-text-3, #6a7282);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reset-btn {
  flex-shrink: 0;
  border: 0;
  border-radius: 4px;
  padding: 4px 12px;
  background: var(--okx-bg-3, #1a222c);
  color: var(--okx-text-2, #a0a8b8);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.reset-btn:hover {
  color: var(--okx-text, #e0e3eb);
}
.filters {
  padding: 8px 10px;
  border-bottom: 1px solid var(--okx-border, #1e2630);
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
}
.coin-row,
.side-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.coin-chip {
  border: 1px solid var(--okx-border, #1e2630);
  border-radius: 999px;
  background: transparent;
  color: var(--okx-text-3, #6a7282);
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  padding: 4px 10px;
  cursor: pointer;
}
.coin-chip.on {
  color: var(--okx-orange, #f15a24);
  border-color: color-mix(in srgb, var(--okx-orange, #f15a24) 45%, var(--okx-border, #1e2630));
  background: color-mix(in srgb, var(--okx-orange, #f15a24) 12%, transparent);
}
.seg {
  display: flex;
  min-width: 0;
  flex-wrap: nowrap;
  border: 1px solid var(--okx-border, #1e2630);
  border-radius: 8px;
  overflow: hidden;
  background: color-mix(in srgb, var(--okx-card, #121821) 70%, transparent);
}
.side-seg {
  flex: 1 1 auto;
}
.seg-chip {
  flex: 1 1 0;
  min-width: 0;
  height: 28px;
  margin: 0;
  padding: 0 8px;
  border: 0;
  border-radius: 0;
  border-left: 1px solid var(--okx-border, #1e2630);
  background: transparent;
  color: var(--okx-text-3, #6a7282);
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  text-align: center;
  cursor: pointer;
  white-space: nowrap;
}
.seg-chip:first-child {
  border-left: 0;
}
.seg-chip.on {
  color: var(--okx-orange, #f15a24);
  background: color-mix(in srgb, var(--okx-orange, #f15a24) 16%, transparent);
}
.seg-chip.long.on {
  color: var(--okx-up, #58bd7d);
  background: color-mix(in srgb, var(--okx-up, #58bd7d) 16%, transparent);
}
.seg-chip.short.on {
  color: var(--okx-down, #ea5a5a);
  background: color-mix(in srgb, var(--okx-down, #ea5a5a) 16%, transparent);
}
.min-usd {
  margin-left: auto;
  border: 1px solid var(--okx-border, #1e2630);
  border-radius: 4px;
  background: var(--okx-bg, #0a0e14);
  color: var(--okx-text-2, #a0a8b8);
  font: inherit;
  font-size: 12px;
  padding: 3px 6px;
}
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
  border: 1px solid var(--okx-border, #1e2630);
  border-radius: 10px;
  background: var(--okx-bg, #0a0e14);
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
.coin-icon.muted {
  color: var(--okx-text-3, #6a7282);
  background: var(--okx-bg-3, #1a222c);
}
.pos-card.hidden .pair {
  color: var(--okx-text-2, #a0a8b8);
  font-weight: 600;
}
.hidden-tip {
  margin: 0 0 10px;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(240, 185, 11, 0.08);
  border: 1px solid rgba(240, 185, 11, 0.22);
  color: var(--okx-text-2, #a0a8b8);
  font-size: 12px;
  line-height: 1.4;
}
.coin-icon-img {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  flex-shrink: 0;
  object-fit: cover;
  background: var(--okx-bg-3, #1a222c);
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
  color: var(--okx-text, #e0e3eb);
  white-space: nowrap;
}
.trader-name {
  min-width: 0;
  font-size: 11px;
  color: var(--okx-text-3, #6a7282);
  overflow: hidden;
  text-overflow: ellipsis;
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
  color: var(--okx-up, #58bd7d);
  background: color-mix(in srgb, var(--okx-up, #58bd7d) 16%, transparent);
}
.side-badge.short {
  color: var(--okx-down, #ea5a5a);
  background: color-mix(in srgb, var(--okx-down, #ea5a5a) 16%, transparent);
}
.mode-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
  color: var(--okx-text-2, #a0a8b8);
  background: var(--okx-bg-3, #1a222c);
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
  color: var(--okx-text-3, #6a7282);
  margin-bottom: 2px;
}
.pnl-v {
  font-size: 15px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.pnl-v.up {
  color: var(--okx-up, #58bd7d);
}
.pnl-v.down {
  color: var(--okx-down, #ea5a5a);
}
.pos-metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 10px;
}
.metric {
  min-width: 0;
}
.mk {
  display: block;
  font-size: 11px;
  color: var(--okx-text-3, #6a7282);
  margin-bottom: 2px;
}
.mv {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--okx-text, #e0e3eb);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (max-width: 1100px) {
  .pos-grid {
    grid-template-columns: 1fr;
  }
}
.feed {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.event {
  border: 1px solid var(--okx-border, #1e2630);
  border-radius: 8px;
  background: var(--okx-bg, #0a0e14);
  padding: 10px 12px;
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
  color: var(--okx-text-3, #6a7282);
  font-variant-numeric: tabular-nums;
}
.tag {
  font-size: 11px;
  font-weight: 700;
  padding: 1px 8px;
  border-radius: 4px;
  background: var(--okx-bg-3, #1a222c);
  color: var(--okx-text-2, #a0a8b8);
}
.tag.open {
  background: color-mix(in srgb, var(--okx-up, #58bd7d) 16%, transparent);
  color: var(--okx-up, #58bd7d);
}
.tag.close {
  background: color-mix(in srgb, var(--okx-down, #ea5a5a) 16%, transparent);
  color: var(--okx-down, #ea5a5a);
}
.side {
  font-size: 12px;
  font-weight: 700;
}
.side.long {
  color: var(--okx-up, #58bd7d);
}
.side.short {
  color: var(--okx-down, #ea5a5a);
}
.coin {
  font-size: 13px;
  font-weight: 700;
}
.pnl {
  margin-left: auto;
  font-size: 13px;
  font-weight: 700;
}
.pnl.up {
  color: var(--okx-up, #58bd7d);
}
.pnl.down {
  color: var(--okx-down, #ea5a5a);
}
.pnl small {
  margin-left: 4px;
  font-size: 11px;
  font-weight: 600;
  opacity: 0.85;
}
.event-mid {
  font-size: 12px;
  color: var(--okx-text-2, #a0a8b8);
}
.trader {
  color: var(--okx-text, #e0e3eb);
  font-weight: 600;
}
.lever {
  color: var(--okx-accent, #f0b90b);
  font-weight: 700;
}
.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 8px;
  border-top: 1px solid var(--okx-border, #1e2630);
  flex-shrink: 0;
}
.page-btn {
  border: 0;
  border-radius: 4px;
  padding: 4px 12px;
  background: var(--okx-bg-3, #1a222c);
  color: var(--okx-text-2, #a0a8b8);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.page-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.page-info {
  font-size: 12px;
  color: var(--okx-text-2, #a0a8b8);
  font-variant-numeric: tabular-nums;
}
.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--okx-text-3, #6a7282);
  font-size: 13px;
  padding: 24px;
}
</style>
