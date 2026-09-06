<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { fetchOkxTraderDetail, type OkxLeadRow, type OkxTrader } from '@/api';

const props = defineProps<{
  traderId?: string;
  trader?: OkxTrader | null;
}>();

const loading = ref(false);
const error = ref('');
const rows = ref<OkxLeadRow[]>([]);
const period = ref('3');

const drawdownTip =
  '根据 OKX 公开的累计收益率序列（pnlRatios）估算：按时间从历史峰值回落到当前点的跌幅 = (峰值 − 当前值) / |峰值|，取整段最大值。非交易所官方回撤字段。';

const title = computed(() => props.trader?.name || '带单表现');

async function loadDetail() {
  if (!props.traderId) {
    rows.value = [];
    error.value = '';
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    const data = await fetchOkxTraderDetail(props.traderId, period.value);
    rows.value = Array.isArray(data.rows) ? data.rows : [];
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载失败';
    if (props.trader) {
      const dd = Number(props.trader.maxDrawdown) || 0;
      rows.value = [
        {
          key: 'maxDrawdown',
          label: '最大回撤',
          value: `${(dd * 100).toFixed(2)}%`,
          tone: dd >= 0.2 ? 'down' : dd > 0 ? 'warn' : 'neutral',
        },
        {
          key: 'aum',
          label: '带单规模',
          value: String(props.trader.aum ?? '—'),
          tone: 'neutral',
        },
      ];
    } else {
      rows.value = [];
    }
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.traderId, period.value] as const,
  () => {
    void loadDetail();
  },
  { immediate: true },
);
</script>

<template>
  <section class="okx-lead">
    <header class="panel-head">
      <div class="titles">
        <h3>带单表现</h3>
        <p class="sub">{{ traderId ? title : '点击中间牛人查看带单数据' }}</p>
      </div>
      <select v-if="traderId" v-model="period" class="period">
        <option value="1">近 7 日</option>
        <option value="2">近 30 日</option>
        <option value="3">近 90 日</option>
        <option value="4">近 365 日</option>
      </select>
    </header>

    <div v-if="!traderId" class="empty">选择交易员后展示带单表现</div>
    <div v-else-if="loading && !rows.length" class="empty">加载中…</div>
    <div v-else-if="error && !rows.length" class="empty err">{{ error }}</div>
    <div v-else class="rows">
      <div v-for="row in rows" :key="row.key" class="row">
        <span class="label">
          {{ row.label }}
          <span
            v-if="row.key === 'maxDrawdown'"
            class="hint"
            tabindex="0"
            :title="drawdownTip"
          >?</span>
        </span>
        <span class="value" :class="row.tone">{{ row.value }}</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.okx-lead {
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
  padding: 12px 14px 8px;
  border-bottom: 1px solid var(--okx-border, #1e2630);
  flex-shrink: 0;
}
.titles {
  min-width: 0;
}
.panel-head h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
}
.panel-head .sub {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--okx-text-3, #6a7282);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.period {
  flex-shrink: 0;
  max-width: 96px;
  border: 1px solid var(--okx-border, #1e2630);
  border-radius: 4px;
  background: var(--okx-bg, #0a0e14);
  color: var(--okx-text-2, #a0a8b8);
  font: inherit;
  font-size: 12px;
  padding: 4px 6px;
}
.rows {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 0;
}
.row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 11px 0;
  border-bottom: 1px solid var(--okx-border, #1e2630);
  min-width: 0;
}
.row:last-child {
  border-bottom: none;
}
.label {
  font-size: 13px;
  color: var(--okx-text-2, #a0a8b8);
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.hint {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1px solid var(--okx-border, #1e2630);
  color: var(--okx-text-3, #6a7282);
  font-size: 10px;
  line-height: 1;
  cursor: help;
  user-select: none;
}
.hint:hover,
.hint:focus {
  color: var(--okx-orange, #f15a24);
  border-color: var(--okx-orange, #f15a24);
}
.value {
  font-size: 14px;
  font-weight: 700;
  color: var(--okx-text, #e0e3eb);
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  max-width: 58%;
}
.value.up {
  color: var(--okx-up, #58bd7d);
}
.value.down {
  color: var(--okx-down, #ea5a5a);
}
.value.warn {
  color: var(--okx-warn, #e6b84c);
}
.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 20px 14px;
  color: var(--okx-text-3, #6a7282);
  font-size: 14px;
  line-height: 1.5;
}
.empty.err {
  color: var(--okx-down, #ea5a5a);
}
</style>
