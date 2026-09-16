<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { fetchDexFlowCoins, type DexFlowCoinRow } from '@/api';
import { preferredCoinsState } from '@/utils/watchedCoins';
import { coinIconCandidates } from '@/utils/coinIcons';
import { formatSignedUsd, formatUsd } from '@/utils/format';

const PERIODS = [
  { key: '5m', label: '5M' },
  { key: '15m', label: '15M' },
  { key: '1h', label: '1H' },
  { key: '2h', label: '2H' },
  { key: '4h', label: '4H' },
  { key: '6h', label: '6H' },
] as const;

type PeriodKey = (typeof PERIODS)[number]['key'];

const props = defineProps<{
  bootReady?: boolean;
  active?: boolean;
}>();

const loading = ref(false);
const error = ref('');
const coins = ref<DexFlowCoinRow[]>([]);
const expanded = ref<string | null>(null);
const sortMode = ref<'net' | 'in' | 'out'>('net');
const period = ref<PeriodKey>('1h');
const iconFallback = ref<Record<string, number>>({});
let timer: ReturnType<typeof setInterval> | null = null;

const TOKEN_COLORS: Record<string, string> = {
  BTC: '#f7931a',
  ETH: '#627eea',
  SOL: '#14f195',
  HYPE: '#22d3ee',
};

const rows = computed(() => {
  const list = [...coins.value];
  if (sortMode.value === 'in') return list.sort((a, b) => b.buy - a.buy);
  if (sortMode.value === 'out') return list.sort((a, b) => b.sell - a.sell);
  return list.sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
});

const maxAbsNet = computed(() => {
  const vals = rows.value.map((c) => Math.abs(Number(c.net) || 0));
  return Math.max(...vals, 1);
});

function tokenColor(sym: string) {
  return TOKEN_COLORS[sym] || 'var(--blue)';
}

function iconSrc(sym: string) {
  const cands = coinIconCandidates(sym);
  const idx = iconFallback.value[sym] || 0;
  return cands[idx] || '';
}

function onIconError(sym: string) {
  const cands = coinIconCandidates(sym);
  const next = (iconFallback.value[sym] || 0) + 1;
  if (next < cands.length) {
    iconFallback.value = { ...iconFallback.value, [sym]: next };
  } else {
    iconFallback.value = { ...iconFallback.value, [sym]: cands.length };
  }
}

function showLetter(sym: string) {
  const cands = coinIconCandidates(sym);
  return (iconFallback.value[sym] || 0) >= cands.length || !cands.length;
}

function priceLabel(price: number | null | undefined) {
  if (price == null || !Number.isFinite(price) || price <= 0) return '--';
  if (price < 1) return `$${price.toPrecision(4)}`;
  if (price < 100) return `$${price.toFixed(2)}`;
  return `$${price.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function barPct(coin: DexFlowCoinRow) {
  const net = Math.abs(Number(coin.net) || 0);
  if (net <= 0) return 0;
  return Math.max(2, (net / maxAbsNet.value) * 50);
}

function toggle(sym: string) {
  expanded.value = expanded.value === sym ? null : sym;
}

function setPeriod(key: PeriodKey) {
  if (period.value === key) return;
  period.value = key;
  void load(true);
}

async function load(force = false) {
  if (!props.bootReady) return;
  if (loading.value && !force) return;
  loading.value = true;
  error.value = '';
  try {
    const data = await fetchDexFlowCoins(period.value, preferredCoinsState.value);
    coins.value = data.coins || [];
  } catch (err) {
    if (!coins.value.length) {
      error.value = err instanceof Error ? err.message : '资金流向加载失败';
    }
  } finally {
    loading.value = false;
  }
}

function startPoll() {
  if (timer) return;
  timer = setInterval(() => {
    if (props.active !== false) void load(false);
  }, 60_000);
}

function stopPoll() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

watch(
  () => props.bootReady,
  (ready) => {
    if (ready) void load(false);
  },
  { immediate: true },
);

watch(
  () => props.active,
  (active) => {
    if (active) {
      void load(false);
      startPoll();
    } else {
      stopPoll();
    }
  },
  { immediate: true },
);

watch(
  () => preferredCoinsState.value.join(','),
  () => {
    if (props.bootReady) void load(true);
  },
);

onMounted(() => {
  if (props.active !== false) startPoll();
});

onUnmounted(() => stopPoll());
</script>

<template>
  <div class="flow">
    <div class="toolbar">
      <div class="seg sort">
        <button type="button" :class="{ active: sortMode === 'net' }" @click="sortMode = 'net'">净流入</button>
        <button type="button" :class="{ active: sortMode === 'in' }" @click="sortMode = 'in'">流入</button>
        <button type="button" :class="{ active: sortMode === 'out' }" @click="sortMode = 'out'">流出</button>
      </div>
      <div class="seg period">
        <button
          v-for="p in PERIODS"
          :key="p.key"
          type="button"
          :class="{ active: period === p.key }"
          @click="setPeriod(p.key)"
        >
          {{ p.label }}
        </button>
      </div>
    </div>
    <div class="source-hint">DexPaprika 池子成交 · {{ period.toUpperCase() }}</div>

    <el-skeleton v-if="loading && !rows.length" :rows="6" animated class="pad" />
    <el-alert
      v-else-if="error && !rows.length"
      type="warning"
      :closable="false"
      :title="error"
      class="pad"
    />
    <el-empty v-else-if="!rows.length" description="暂无币种资金流向" class="pad" />

    <div v-else class="list">
      <div v-for="coin in rows" :key="coin.coin" class="block">
        <button
          type="button"
          class="row"
          :class="{ expanded: expanded === coin.coin }"
          @click="toggle(coin.coin)"
        >
          <div class="token">
            <span class="icon-wrap">
              <img
                v-if="!showLetter(coin.coin)"
                class="icon-img"
                :src="iconSrc(coin.coin)"
                :alt="coin.coin"
                @error="onIconError(coin.coin)"
              />
              <span
                v-else
                class="icon-fallback"
                :style="{ background: tokenColor(coin.coin) }"
              >
                {{ coin.coin.slice(0, 1) }}
              </span>
            </span>
            <span class="names">
              <b>{{ coin.coin }}</b>
              <em>{{ priceLabel(coin.price) }}</em>
            </span>
          </div>

          <div class="bar-wrap" aria-hidden="true">
            <div class="track">
              <div
                v-if="(coin.net || 0) !== 0"
                class="fill"
                :class="(coin.net || 0) >= 0 ? 'pos' : 'neg'"
                :style="{ width: `${barPct(coin)}%` }"
              />
              <div class="center" />
            </div>
          </div>

          <div class="net" :class="(coin.net || 0) >= 0 ? 'up' : 'down'">
            {{ formatSignedUsd(coin.net || 0) }}
          </div>
          <div
            class="chg"
            :class="coin.changePct == null ? 'muted' : coin.changePct >= 0 ? 'up' : 'down'"
          >
            <template v-if="coin.changePct == null">--</template>
            <template v-else>{{ coin.changePct >= 0 ? '↑' : '↓' }}{{ Math.abs(coin.changePct).toFixed(1) }}%</template>
          </div>
        </button>

        <div v-if="expanded === coin.coin" class="detail">
          <div v-if="coin.unsupported" class="lab">该币种暂未配置 Dex 池子</div>
          <div v-else class="grid">
            <div>
              <div class="lab">流入（买入）</div>
              <div class="val up">{{ formatUsd(coin.buy || 0) }}</div>
            </div>
            <div>
              <div class="lab">流出（卖出）</div>
              <div class="val down">{{ formatUsd(coin.sell || 0) }}</div>
            </div>
            <div>
              <div class="lab">成交笔数</div>
              <div class="val">{{ coin.count || 0 }}</div>
            </div>
            <div>
              <div class="lab">池子</div>
              <div class="val mono">{{ coin.pair || '--' }}</div>
            </div>
            <div>
              <div class="lab">DEX</div>
              <div class="val">{{ coin.dex || '--' }}</div>
            </div>
            <div>
              <div class="lab">网络</div>
              <div class="val">{{ coin.network || '--' }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.flow {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px 6px;
  flex-shrink: 0;
  flex-wrap: wrap;
}
.source-hint {
  padding: 0 12px 8px;
  font-size: 11px;
  color: var(--soft);
  border-bottom: 1px solid var(--border);
}
.seg {
  display: inline-flex;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 2px;
  gap: 1px;
}
.seg button {
  background: transparent;
  border: none;
  color: var(--muted);
  font-size: 11px;
  padding: 4px 8px;
  border-radius: 5px;
  cursor: pointer;
  font-family: inherit;
}
.seg button:hover {
  color: var(--text);
}
.seg button.active {
  background: var(--panel-3);
  color: #fff;
}
.pad {
  padding: 16px 12px;
}
.list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.block {
  display: flex;
  flex-direction: column;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 9px;
  cursor: pointer;
  color: inherit;
  font: inherit;
  text-align: left;
  transition: 0.16s;
}
.row:hover {
  border-color: var(--border-2);
  background: var(--panel-2);
}
.row.expanded {
  background: var(--panel-2);
  border-color: color-mix(in srgb, var(--purple) 40%, var(--border));
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}
.token {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 96px;
  flex-shrink: 0;
}
.icon-wrap {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
}
.icon-img {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: block;
  object-fit: cover;
  background: var(--panel-3);
}
.icon-fallback {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 10px;
  font-weight: 800;
  color: #fff;
}
.names {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
  min-width: 0;
}
.names b {
  font-size: 12.5px;
}
.names em {
  font-style: normal;
  font-size: 10px;
  color: var(--soft);
}
.bar-wrap {
  flex: 1;
  height: 22px;
  position: relative;
  display: flex;
  align-items: center;
  min-width: 40px;
}
.track {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 100%;
  height: 4px;
  background: var(--panel-3);
  border-radius: 2px;
}
.fill {
  position: absolute;
  top: 0;
  height: 100%;
  border-radius: 2px;
}
.fill.pos {
  left: 50%;
  background: linear-gradient(90deg, var(--green-2), var(--green));
  box-shadow: 0 0 8px rgba(22, 199, 132, 0.35);
}
.fill.neg {
  right: 50%;
  background: linear-gradient(90deg, var(--red), var(--red-2));
  box-shadow: 0 0 8px rgba(234, 57, 67, 0.35);
}
.center {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 1px;
  height: 12px;
  background: var(--border-2);
}
.net {
  width: 88px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  font-size: 12.5px;
  flex-shrink: 0;
}
.chg {
  width: 58px;
  text-align: right;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.chg.muted {
  color: var(--soft);
}
.detail {
  padding: 10px 12px 12px;
  border: 1px solid var(--border);
  border-top: 1px dashed var(--border);
  border-radius: 0 0 9px 9px;
  background: var(--panel-2);
  margin-top: -1px;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 16px;
}
.lab {
  color: var(--soft);
  font-size: 10.5px;
  margin-bottom: 3px;
}
.val {
  color: var(--text);
  font-weight: 650;
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
}
.val.mono {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11.5px;
  font-weight: 500;
}
</style>
