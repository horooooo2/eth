<script setup lang="ts">
import { computed, ref } from 'vue';
import { WarningFilled } from '@element-plus/icons-vue';
import type { OkxTrader } from '@/api';
import {
  isOkxTraderMonitored,
  monitoredOkxIds,
  toggleOkxTraderMonitor,
} from '@/utils/monitoredOkxTraders';
import { freshModeEnabled, freshWindowHours, freshWindowMs } from '@/utils/freshMode';

const props = defineProps<{
  traders: OkxTrader[];
  loading?: boolean;
  selectedId?: string;
}>();

const emit = defineEmits<{
  select: [trader: OkxTrader];
  lead: [trader: OkxTrader];
}>();

type SortKey = 'default' | 'aum' | 'copyNum' | 'copyPnl' | 'latestOpen';
type FilterKey = 'all' | 'followed' | 'drawdown' | 'positive';

const sortKey = ref<SortKey>('default');
const filterKey = ref<FilterKey>('all');
const nameQuery = ref('');

const sortOptions: Array<{ value: SortKey; label: string }> = [
  { value: 'default', label: '默认' },
  { value: 'latestOpen', label: '最新开单' },
  { value: 'aum', label: '带单规模' },
  { value: 'copyNum', label: '跟单人数' },
  { value: 'copyPnl', label: '跟单收益' },
];

const filterOptions: Array<{ value: FilterKey; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'followed', label: '已关注' },
  { value: 'drawdown', label: '回撤' },
  { value: 'positive', label: '正收益' },
];

const drawdownTip =
  '根据 OKX 公开的累计收益率序列（pnlRatios）估算：按时间从历史峰值回落到当前点的跌幅 = (峰值 − 当前值) / |峰值|，取整段最大值。非交易所官方回撤字段。';

function passFreshTrader(trader: OkxTrader) {
  if (!freshModeEnabled.value) return true;
  const at = Number(trader.lastOpenAt) || 0;
  if (!at) return false;
  const age = Date.now() - at;
  return age >= -60_000 && age <= freshWindowMs();
}

const filteredSorted = computed(() => {
  void monitoredOkxIds.value;
  void freshModeEnabled.value;
  void freshWindowMs();
  let list = [...(props.traders || [])].filter((t) => passFreshTrader(t));

  const q = nameQuery.value.trim().toLowerCase();
  if (q) {
    list = list.filter((t) => {
      const name = String(t.name || '').toLowerCase();
      const id = String(t.id || t.uniqueCode || '').toLowerCase();
      return name.includes(q) || id.includes(q);
    });
  }

  if (filterKey.value === 'followed') {
    list = list.filter((t) => isOkxTraderMonitored(t.id));
  } else if (filterKey.value === 'drawdown') {
    list = list.filter((t) => (Number(t.maxDrawdown) || 0) >= 0.05);
  } else if (filterKey.value === 'positive') {
    list = list.filter((t) => (Number(t.pnl) || 0) > 0 && (Number(t.copyPnl) || 0) > 0);
  }

  if (sortKey.value === 'aum') {
    list.sort((a, b) => (b.aum || 0) - (a.aum || 0));
  } else if (sortKey.value === 'copyNum') {
    list.sort((a, b) => (b.copyTraderNum || 0) - (a.copyTraderNum || 0));
  } else if (sortKey.value === 'copyPnl') {
    list.sort((a, b) => (b.copyPnl || 0) - (a.copyPnl || 0));
  } else if (sortKey.value === 'latestOpen') {
    list.sort(
      (a, b) =>
        (Number(b.lastOpenAt) || 0) - (Number(a.lastOpenAt) || 0) ||
        (a.rank || 0) - (b.rank || 0),
    );
  } else {
    list.sort((a, b) => (a.rank || 0) - (b.rank || 0));
  }
  return list;
});

function formatUsd(n: number, signed = false) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  const sign = signed ? (v > 0 ? '+' : v < 0 ? '-' : '') : v < 0 ? '-' : '';
  const body =
    abs >= 1e6
      ? `${(abs / 1e6).toFixed(2)}M`
      : abs.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return `${sign}$${body}`;
}

function formatPct(n: number) {
  const v = (Number(n) || 0) * 100;
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

function sparkPoints(trader: OkxTrader) {
  const series = trader.pnlRatios || [];
  if (series.length < 2) return '';
  const vals = series.map((p) => p.pnlRatio);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const w = 88;
  const h = 36;
  return vals
    .map((v, i) => {
      const x = (i / (vals.length - 1)) * w;
      const y = h - ((v - min) / span) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

function onCardClick(trader: OkxTrader) {
  emit('select', trader);
}

function onFollowClick(e: Event, trader: OkxTrader) {
  e.stopPropagation();
  toggleOkxTraderMonitor(trader.id);
}

function onLeadClick(e: Event, trader: OkxTrader) {
  e.stopPropagation();
  emit('lead', trader);
}
</script>

<template>
  <section class="okx-traders">
    <header class="panel-head">
        <div class="titles">
        <h3>牛人榜</h3>
        <span v-if="freshModeEnabled" class="sub">闪电 · {{ freshWindowHours }}h</span>
      </div>
      <div class="toolbar">
        <label class="search-wrap">
          <span class="chip-label">搜索</span>
          <input
            v-model="nameQuery"
            type="search"
            class="name-search"
            placeholder="交易员名称 / ID"
            autocomplete="off"
            spellcheck="false"
          />
        </label>
        <div class="chip-group">
          <span class="chip-label">排序</span>
          <div class="seg">
            <button
              v-for="opt in sortOptions"
              :key="opt.value"
              type="button"
              class="seg-chip"
              :class="{ on: sortKey === opt.value }"
              @click="sortKey = opt.value"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>
        <div class="chip-group">
          <span class="chip-label">筛选</span>
          <div class="seg">
            <button
              v-for="opt in filterOptions"
              :key="opt.value"
              type="button"
              class="seg-chip"
              :class="{ on: filterKey === opt.value }"
              @click="filterKey = opt.value"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>
      </div>
    </header>

    <div v-if="loading && !filteredSorted.length" class="empty">加载交易员…</div>
    <div v-else-if="!filteredSorted.length" class="empty">暂无符合条件的交易员</div>
    <div v-else class="card-grid">
      <button
        v-for="trader in filteredSorted"
        :key="trader.id"
        type="button"
        class="okx-card"
        :class="{ active: selectedId === trader.id }"
        @click="onCardClick(trader)"
      >
        <div class="card-top">
          <img
            v-if="trader.avatar"
            class="avatar"
            :src="trader.avatar"
            :alt="trader.name"
            loading="lazy"
          />
          <span v-else class="avatar fallback">{{ trader.name.slice(0, 1) }}</span>
          <div class="id-wrap">
            <span class="name">{{ trader.name }}</span>
            <span class="rank-tag">#{{ trader.rank }}</span>
          </div>
          <span
            class="lead-btn"
            title="带单表现"
            @click="onLeadClick($event, trader)"
          >
            <el-icon :size="14"><WarningFilled /></el-icon>
          </span>
          <span
            class="copy-btn"
            :class="{ followed: isOkxTraderMonitored(trader.id) }"
            @click="onFollowClick($event, trader)"
          >
            {{ isOkxTraderMonitored(trader.id) ? '已关注' : '关注' }}
          </span>
        </div>

        <div class="card-mid">
          <div class="pnl-block">
            <p class="pnl-label">近 90 日交易员收益</p>
            <p class="pnl-pct" :class="trader.pnlRatio >= 0 ? 'up' : 'down'">
              {{ formatPct(trader.pnlRatio) }}
            </p>
            <p class="pnl-amt" :class="trader.pnl >= 0 ? 'up' : 'down'">
              {{ formatUsd(trader.pnl, true) }}
            </p>
          </div>
          <svg
            v-if="sparkPoints(trader)"
            class="spark"
            viewBox="0 0 88 36"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <polyline
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              :points="sparkPoints(trader)"
            />
          </svg>
        </div>

        <div class="card-bot">
          <div class="kv">
            <span class="k">跟单人数</span>
            <span class="v">{{ trader.copyTraderNum }}/{{ trader.maxCopyTraderNum || '—' }}</span>
          </div>
          <div class="kv">
            <span class="k">带单规模</span>
            <span class="v">{{ formatUsd(trader.aum) }}</span>
          </div>
          <div class="kv">
            <span class="k">跟单收益</span>
            <span class="v" :class="(trader.copyPnl || 0) >= 0 ? 'up' : 'down'">
              {{ formatUsd(trader.copyPnl || 0, true) }}
            </span>
          </div>
          <div class="kv">
            <span class="k">
              最大回撤
              <span class="hint" tabindex="0" :title="drawdownTip" @click.stop>?</span>
            </span>
            <span class="v">{{ ((trader.maxDrawdown || 0) * 100).toFixed(1) }}%</span>
          </div>
        </div>
      </button>
    </div>
  </section>
</template>

<style scoped>
.okx-traders {
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
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--okx-border, #1e2630);
  flex-shrink: 0;
}
.titles {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.panel-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
}
.panel-head .sub {
  font-size: 11px;
  color: var(--okx-text-3, #6a7282);
}
.toolbar {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.search-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.name-search {
  flex: 1 1 auto;
  min-width: 0;
  height: 28px;
  margin: 0;
  padding: 0 10px;
  border: 1px solid var(--okx-border, #1e2630);
  border-radius: 8px;
  background: color-mix(in srgb, var(--okx-card, #121821) 70%, transparent);
  color: var(--okx-text, #e0e3eb);
  font: inherit;
  font-size: 12px;
  outline: none;
}
.name-search::placeholder {
  color: var(--okx-text-3, #6a7282);
}
.name-search:focus {
  border-color: color-mix(in srgb, var(--okx-orange, #f15a24) 55%, var(--okx-border, #1e2630));
}
.chip-group {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.chip-label {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 700;
  color: var(--okx-text-3, #6a7282);
}
.seg {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  flex-wrap: nowrap;
  border: 1px solid var(--okx-border, #1e2630);
  border-radius: 8px;
  overflow: hidden;
  background: color-mix(in srgb, var(--okx-card, #121821) 70%, transparent);
}
.seg-chip {
  flex: 1 1 0;
  min-width: 0;
  height: 28px;
  margin: 0;
  padding: 0 4px;
  border: 0;
  border-radius: 0;
  border-left: 1px solid var(--okx-border, #1e2630);
  background: transparent;
  color: var(--okx-text-3, #6a7282);
  font: inherit;
  font-size: 11px;
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
.card-grid {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 10px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
  align-content: start;
}
.okx-card {
  text-align: left;
  border: 1px solid var(--okx-border, #1e2630);
  border-radius: 10px;
  background: var(--okx-bg, #0a0e14);
  color: inherit;
  padding: 12px;
  cursor: pointer;
  font: inherit;
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: border-color 0.15s, background 0.15s;
}
.okx-card:hover {
  border-color: #2a313c;
  background: var(--okx-bg-3, #1a222c);
}
.okx-card.active {
  border-color: var(--okx-orange, #f15a24);
  background: color-mix(in srgb, var(--okx-orange, #f15a24) 8%, var(--okx-bg, #0a0e14));
}
.card-top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
  background: var(--okx-bg-3, #1a222c);
}
.avatar.fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  color: var(--okx-text-2, #a0a8b8);
}
.id-wrap {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}
.name {
  font-size: 13px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rank-tag {
  font-size: 10px;
  color: var(--okx-text-3, #6a7282);
  flex-shrink: 0;
}
.lead-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 4px;
  color: var(--okx-warn, #e6b84c);
  cursor: pointer;
}
.lead-btn:hover {
  background: color-mix(in srgb, var(--okx-warn, #e6b84c) 16%, transparent);
  color: #f0c45c;
}
.copy-btn {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 700;
  padding: 3px 10px;
  border-radius: 4px;
  border: 1px solid var(--okx-orange, #f15a24);
  color: var(--okx-orange, #f15a24);
  background: transparent;
  cursor: pointer;
}
.copy-btn.followed {
  background: color-mix(in srgb, var(--okx-orange, #f15a24) 18%, transparent);
  border-color: var(--okx-orange, #f15a24);
  color: var(--okx-orange, #f15a24);
}
.card-mid {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.pnl-label {
  margin: 0 0 4px;
  font-size: 11px;
  color: var(--okx-text-3, #6a7282);
}
.pnl-pct {
  margin: 0;
  font-size: 22px;
  font-weight: 800;
  line-height: 1.1;
  letter-spacing: -0.02em;
}
.pnl-amt {
  margin: 4px 0 0;
  font-size: 12px;
  font-weight: 600;
}
.up {
  color: var(--okx-up, #58bd7d);
}
.down {
  color: var(--okx-down, #ea5a5a);
}
.spark {
  width: 88px;
  height: 36px;
  flex-shrink: 0;
  color: var(--okx-up, #58bd7d);
}
.card-bot {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.kv {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  min-width: 0;
}
.kv .k {
  color: var(--okx-text-3, #6a7282);
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.kv .hint {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 1px solid var(--okx-border, #1e2630);
  color: var(--okx-text-3, #6a7282);
  font-size: 9px;
  line-height: 1;
  cursor: help;
  user-select: none;
}
.kv .hint:hover,
.kv .hint:focus {
  color: var(--okx-orange, #f15a24);
  border-color: var(--okx-orange, #f15a24);
}
.kv .v {
  color: var(--okx-text, #e0e3eb);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
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
