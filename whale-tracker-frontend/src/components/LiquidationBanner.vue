<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  fetchLiquidations,
  type LiquidationPeriod,
  type LiquidationsResponse,
} from '@/api';
import { formatCompact, formatUsd } from '@/utils/format';
import { preferredCoinFilterOptions, preferredCoinsState } from '@/utils/watchedCoins';

const PERIOD_FALLBACK: LiquidationPeriod[] = [
  { hours: 1, label: '1小时爆仓', longUsd: 0, shortUsd: 0, totalUsd: 0, count: 0 },
  { hours: 4, label: '4小时爆仓', longUsd: 0, shortUsd: 0, totalUsd: 0, count: 0 },
  { hours: 12, label: '12小时爆仓', longUsd: 0, shortUsd: 0, totalUsd: 0, count: 0 },
  { hours: 24, label: '24小时爆仓', longUsd: 0, shortUsd: 0, totalUsd: 0, count: 0 },
];

const coin = ref(preferredCoinsState.value[0] || 'BTC');
const loading = ref(false);
const data = ref<LiquidationsResponse | null>(null);
const error = ref('');
const dialogVisible = ref(false);

let pollTimer: number | undefined;
let reqSeq = 0;

const coinOptions = computed(() => preferredCoinFilterOptions());
const dialogTitle = computed(
  () => `${coin.value} 爆仓数据${data.value?.source ? ` · ${data.value.source}` : ''}`,
);

const periods = computed(() => {
  const list = data.value?.periods?.length ? data.value.periods : PERIOD_FALLBACK;
  return [...list].sort((a, b) => a.hours - b.hours);
});

/** 弹窗金额：走全局万/亿格式；0 显示为 -- */
function formatLiqUsd(value: number | null | undefined) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return '--';
  return formatUsd(n);
}

function openDetail() {
  if (!data.value && !error.value) return;
  dialogVisible.value = true;
}

async function load() {
  const seq = ++reqSeq;
  loading.value = true;
  error.value = '';
  try {
    const next = await fetchLiquidations(coin.value);
    if (seq !== reqSeq) return;
    data.value = next;
  } catch (err) {
    if (seq !== reqSeq) return;
    error.value = err instanceof Error ? err.message : '爆仓数据获取失败';
  } finally {
    if (seq === reqSeq) loading.value = false;
  }
}

function ensureCoin() {
  const list = preferredCoinsState.value;
  if (!list.length) {
    coin.value = 'BTC';
    return;
  }
  if (!list.includes(coin.value)) {
    coin.value = list[0];
  }
}

watch(coin, () => {
  void load();
});

watch(preferredCoinsState, () => {
  ensureCoin();
});

onMounted(() => {
  ensureCoin();
  void load();
  pollTimer = window.setInterval(() => {
    void load();
  }, 60_000);
});

onUnmounted(() => {
  if (pollTimer) window.clearInterval(pollTimer);
});
</script>

<template>
  <div class="liq-wrap">
    <div class="liq-banner">
      <el-select
        v-model="coin"
        size="small"
        class="ctrl coin"
        filterable
        :disabled="loading"
        @click.stop
      >
        <el-option
          v-for="opt in coinOptions"
          :key="opt.value"
          :label="opt.label"
          :value="opt.value"
        />
      </el-select>

      <button
        type="button"
        class="body"
        :class="{ loading, clickable: Boolean(data || error) }"
        :title="data ? '点击查看详细爆仓数据' : undefined"
        @click="openDetail"
      >
        <template v-if="error">
          <span class="muted err">{{ error }}</span>
        </template>
        <template v-else-if="data">
          <span class="stat">
            24h <strong>{{ data.totalUsd ? formatUsd(data.totalUsd) : '--' }}</strong>
          </span>
          <span class="stat long">
            多 <strong>{{ data.longUsd ? formatUsd(data.longUsd) : '--' }}</strong>
          </span>
          <span class="stat short">
            空 <strong>{{ data.shortUsd ? formatUsd(data.shortUsd) : '--' }}</strong>
          </span>
          <span class="stat muted">
            {{ data.count ? formatCompact(data.count) : '--' }} 笔
          </span>
        </template>
        <template v-else>
          <span class="muted">加载中…</span>
        </template>
      </button>
    </div>

    <el-dialog
      v-model="dialogVisible"
      :title="dialogTitle"
      width="min(560px, 94vw)"
      append-to-body
      align-center
      class="liq-detail-dialog"
    >
      <div v-if="error && !data" class="empty">{{ error }}</div>
      <div v-else class="period-grid">
        <article v-for="period in periods" :key="period.hours" class="period-card">
          <div class="period-row head">
            <span>{{ period.label || `${period.hours}小时爆仓` }}</span>
            <strong>{{ formatLiqUsd(period.totalUsd) }}</strong>
          </div>
          <div class="period-row">
            <span>多单</span>
            <strong class="long">{{ formatLiqUsd(period.longUsd) }}</strong>
          </div>
          <div class="period-row">
            <span>空单</span>
            <strong class="short">{{ formatLiqUsd(period.shortUsd) }}</strong>
          </div>
        </article>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.liq-wrap {
  width: 100%;
  max-width: 100%;
  min-width: 0;
}

.liq-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  max-width: 100%;
  height: 44px;
  min-width: 0;
  padding: 0 8px 0 10px;
  box-sizing: border-box;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--card);
  overflow: hidden;
}

.ctrl {
  flex: 0 0 auto;
}

.ctrl.coin {
  width: 84px;
}

.ctrl :deep(.el-select__wrapper) {
  min-height: 38px;
  height: 38px;
  padding: 0 8px;
  font-size: 13px;
  font-weight: 700;
  border-radius: 10px;
  box-shadow: none;
  background: color-mix(in srgb, var(--card) 80%, transparent);
}

.body {
  flex: 1;
  min-width: 0;
  height: 38px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: nowrap;
  overflow: hidden;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  white-space: nowrap;
  cursor: default;
}

.body.clickable {
  cursor: pointer;
}

.body.clickable:hover {
  filter: brightness(1.03);
}

.body.loading {
  opacity: 0.72;
}

.stat {
  flex: 0 0 auto;
  color: var(--muted);
  font-size: 12px;
}

.stat strong {
  font-weight: 650;
  color: var(--text);
  margin-left: 2px;
}

.stat.long strong {
  color: #3dd68c;
}

.stat.short strong {
  color: #f56565;
}

.muted {
  color: var(--muted);
  font-size: 12px;
}

.err {
  overflow: hidden;
  text-overflow: ellipsis;
}

.period-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.period-card {
  padding: 14px 14px 12px;
  border: 1px solid color-mix(in srgb, var(--border) 85%, #fff 8%);
  border-radius: 10px;
  background: color-mix(in srgb, var(--card) 70%, #000 30%);
  display: flex;
  flex-direction: column;
  gap: 8px;
  box-sizing: border-box;
  min-width: 0;
}

.period-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
  line-height: 1.35;
}

.period-row span {
  color: var(--muted);
  font-weight: 500;
  flex: 0 0 auto;
}

.period-row strong {
  font-variant-numeric: tabular-nums;
  text-align: right;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.period-row.head span,
.period-row.head strong {
  color: var(--text);
  font-weight: 700;
}

.period-row.head {
  font-size: 14px;
  margin-bottom: 2px;
}

.period-row .long {
  color: #3dd68c;
  font-weight: 700;
}

.period-row .short {
  color: #f56565;
  font-weight: 700;
}

.empty {
  color: var(--muted);
  text-align: center;
  padding: 24px 0;
}

@media (max-width: 1100px) {
  .stat.muted {
    display: none;
  }
}

@media (max-width: 768px) {
  .liq-banner {
    height: auto;
    min-height: 44px;
    flex-wrap: wrap;
    padding: 6px 8px;
  }

  .body {
    width: 100%;
    height: auto;
    min-height: 34px;
    flex-wrap: wrap;
    white-space: normal;
    row-gap: 4px;
  }

  .period-grid {
    gap: 8px;
  }

  .period-card {
    padding: 12px 10px 10px;
  }

  .period-row.head {
    font-size: 13px;
  }

  .period-row {
    font-size: 12px;
  }
}
</style>

<style>
/* append-to-body：弹窗外壳需非 scoped */
.liq-detail-dialog.el-dialog {
  background: color-mix(in srgb, var(--card, #1a1a1a) 88%, #000 12%);
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 14px;
}

.liq-detail-dialog .el-dialog__header {
  padding: 14px 16px 8px;
  margin-right: 0;
}

.liq-detail-dialog .el-dialog__title {
  font-size: 15px;
  font-weight: 700;
}

.liq-detail-dialog .el-dialog__body {
  padding: 8px 16px 16px;
}

.liq-detail-dialog .el-dialog__footer {
  display: none;
}
</style>
