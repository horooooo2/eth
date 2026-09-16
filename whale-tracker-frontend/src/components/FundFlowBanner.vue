<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { fetchDexFlowCoins, type DexFlowCoinRow } from '@/api';
import { formatUsd, formatSignedUsd } from '@/utils/format';
import { preferredCoinFilterOptions, preferredCoinsState } from '@/utils/watchedCoins';

const PERIODS = [
  { key: '5m', label: '5M' },
  { key: '15m', label: '15M' },
  { key: '1h', label: '1H' },
  { key: '2h', label: '2H' },
  { key: '4h', label: '4H' },
  { key: '6h', label: '6H' },
] as const;

type PeriodKey = (typeof PERIODS)[number]['key'];

const coin = ref(preferredCoinsState.value[0] || 'BTC');
const period = ref<PeriodKey>('1h');
const marketType = ref<'spot' | 'swap'>('swap');
const loading = ref(false);
const error = ref('');
const row = ref<DexFlowCoinRow | null>(null);

let pollTimer: number | undefined;
let reqSeq = 0;

const coinOptions = computed(() => preferredCoinFilterOptions());

async function load() {
  const seq = ++reqSeq;
  loading.value = true;
  error.value = '';
  try {
    const data = await fetchDexFlowCoins(period.value, [coin.value], marketType.value);
    if (seq !== reqSeq) return;
    const found = (data.coins || []).find((c) => c.coin === coin.value) || null;
    row.value = found;
  } catch (err) {
    if (seq !== reqSeq) return;
    error.value = err instanceof Error ? err.message : '资金流向加载失败';
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

watch(coin, () => void load());
watch(period, () => void load());
watch(marketType, () => void load());
watch(preferredCoinsState, () => {
  ensureCoin();
});

onMounted(() => {
  ensureCoin();
  void load();
  pollTimer = window.setInterval(() => void load(), 60_000);
});

onUnmounted(() => {
  if (pollTimer) window.clearInterval(pollTimer);
});
</script>

<template>
  <div class="flow-wrap">
    <div class="flow-banner">
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

      <el-select
        v-model="marketType"
        size="small"
        class="ctrl market"
        :disabled="loading"
        @click.stop
      >
        <el-option label="现货" value="spot" />
        <el-option label="合约" value="swap" />
      </el-select>

      <el-select
        v-model="period"
        size="small"
        class="ctrl period"
        :disabled="loading"
        @click.stop
      >
        <el-option
          v-for="p in PERIODS"
          :key="p.key"
          :label="p.label"
          :value="p.key"
        />
      </el-select>

      <div class="body" :class="{ loading }">
        <template v-if="error">
          <span class="muted err">{{ error }}</span>
        </template>
        <template v-else-if="row">
          <span class="stat">
            净流入 <strong :class="(row.net || 0) >= 0 ? 'long' : 'short'">
              {{ formatSignedUsd(row.net || 0) }}
            </strong>
          </span>
        </template>
        <template v-else>
          <span class="muted">加载中…</span>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.flow-wrap {
  width: 100%;
  max-width: 100%;
  min-width: 0;
}

.flow-banner {
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
  width: 96px;
}

.ctrl.market {
  width: 76px;
}

.ctrl.period {
  width: 84px;
}

.ctrl :deep(.el-select__wrapper) {
  min-height: 32px;
  height: 32px;
  padding: 0 6px;
  font-size: 13px;
  font-weight: 700;
  border-radius: 10px;
  box-shadow: none;
  background: color-mix(in srgb, var(--card) 80%, transparent);
}

.body {
  flex: 1;
  min-width: 0;
  height: 32px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: nowrap;
  overflow: hidden;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  white-space: nowrap;
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
  margin-left: 2px;
}

.stat strong.long {
  color: var(--green);
}

.stat strong.short {
  color: var(--red);
}

.muted {
  color: var(--muted);
  font-size: 12px;
}

.err {
  overflow: hidden;
  text-overflow: ellipsis;
}

@media (max-width: 1100px) {
  .stat {
    font-size: 11px;
  }
}
</style>
