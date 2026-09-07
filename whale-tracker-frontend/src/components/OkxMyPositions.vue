<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { fetchOkxTradePositions, fetchOkxTradeStatus } from '@/api';
import { isLoggedIn } from '@/stores/auth';

const props = defineProps<{
  /** 父级刷新信号（变化时重新拉仓位） */
  refreshToken?: number;
}>();

const loading = ref(false);
const error = ref('');
const configured = ref(false);
const simulated = ref(true);
const positions = ref<Record<string, unknown>[]>([]);

const openPositions = computed(() =>
  positions.value.filter((p) => {
    const pos = Math.abs(Number(p.pos) || 0);
    return pos > 0;
  }),
);

function formatNum(n: unknown, digits = 4) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function formatUsd(n: unknown) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function sideLabel(p: Record<string, unknown>) {
  const ps = String(p.posSide || '').toLowerCase();
  if (ps === 'long') return '多';
  if (ps === 'short') return '空';
  const pos = Number(p.pos) || 0;
  if (pos > 0) return '多';
  if (pos < 0) return '空';
  return '—';
}

function sideClass(p: Record<string, unknown>) {
  const label = sideLabel(p);
  if (label === '多') return 'up';
  if (label === '空') return 'down';
  return '';
}

async function load() {
  error.value = '';
  if (!isLoggedIn.value) {
    positions.value = [];
    error.value = '登录后显示账户仓位';
    return;
  }
  loading.value = true;
  try {
    const st = await fetchOkxTradeStatus();
    configured.value = st.configured;
    simulated.value = st.simulated;
    if (!st.configured) {
      positions.value = [];
      error.value = '未配置交易 API';
      return;
    }
    const data = await fetchOkxTradePositions('SWAP');
    positions.value = Array.isArray(data.positions) ? data.positions : [];
    configured.value = data.configured;
    simulated.value = data.simulated;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '仓位加载失败';
  } finally {
    loading.value = false;
  }
}

defineExpose({ refresh: load });

onMounted(() => {
  void load();
});

watch(isLoggedIn, () => {
  void load();
});

watch(
  () => props.refreshToken,
  () => {
    void load();
  },
);
</script>

<template>
  <section class="okx-mypos">
    <header class="panel-head">
      <div class="titles">
        <h3>我的仓位</h3>
        <p class="sub">
          <span :class="{ sim: simulated, live: configured && !simulated }">
            {{ !configured ? '未配置' : simulated ? '模拟盘' : '实盘' }}
          </span>
          · {{ openPositions.length }} 个
        </p>
      </div>
      <button type="button" class="ghost" :disabled="loading" @click="load">
        {{ loading ? '…' : '刷新' }}
      </button>
    </header>

    <div v-if="loading && !openPositions.length" class="empty">加载中…</div>
    <div v-else-if="error && !openPositions.length" class="empty err">{{ error }}</div>
    <div v-else-if="!openPositions.length" class="empty">暂无持仓</div>
    <div v-else class="list">
      <article v-for="(p, i) in openPositions" :key="String(p.instId) + '-' + i" class="pos">
        <div class="pos-top">
          <strong>{{ p.instId || '—' }}</strong>
          <span class="side" :class="sideClass(p)">{{ sideLabel(p) }}</span>
        </div>
        <div class="pos-grid">
          <span>数量</span>
          <b>{{ formatNum(p.pos, 4) }}</b>
          <span>均价</span>
          <b>{{ formatNum(p.avgPx, 4) }}</b>
          <span>标记</span>
          <b>{{ formatNum(p.markPx, 4) }}</b>
          <span>未实现</span>
          <b :class="Number(p.upl) >= 0 ? 'up' : 'down'">{{ formatUsd(p.upl) }}</b>
          <span>杠杆</span>
          <b>{{ p.lever || '—' }}x</b>
          <span>保证金</span>
          <b>{{ formatNum(p.margin || p.imr || p.mmr, 2) }}</b>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.okx-mypos {
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
}
.sub .sim {
  color: #f0b429;
}
.sub .live {
  color: #f87171;
}
.ghost {
  border: 0;
  border-radius: 4px;
  padding: 4px 8px;
  background: #1a222e;
  color: #b0c4de;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.ghost:disabled {
  opacity: 0.5;
  cursor: wait;
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
}
.empty.err {
  color: var(--okx-down, #ea5a5a);
}
.list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pos {
  padding: 10px;
  border: 1px solid #1e2630;
  border-radius: 8px;
  background: color-mix(in srgb, #0a0e14 40%, transparent);
}
.pos-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}
.pos-top strong {
  font-size: 13px;
}
.side {
  font-size: 12px;
  font-weight: 700;
}
.side.up,
.up {
  color: var(--okx-up, #58bd7d);
}
.side.down,
.down {
  color: var(--okx-down, #ea5a5a);
}
.pos-grid {
  display: grid;
  grid-template-columns: auto 1fr auto 1fr;
  gap: 4px 10px;
  font-size: 11px;
  color: var(--okx-text-3, #6a7282);
}
.pos-grid b {
  color: var(--okx-text-2, #a0a8b8);
  font-weight: 600;
  text-align: right;
}
</style>
