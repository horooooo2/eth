<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { fetchDefillamaMacro, type DefillamaCoinRow } from '@/api';
import { preferredCoinsState } from '@/utils/watchedCoins';
import { coinIconCandidates } from '@/utils/coinIcons';
import { formatUsd } from '@/utils/format';

const props = defineProps<{
  bootReady?: boolean;
  active?: boolean;
}>();

const loading = ref(false);
const error = ref('');
const rows = ref<DefillamaCoinRow[]>([]);
const overview = ref<{
  totalTvl: number;
  tvlChange1dPct: number | null;
  preferredTvl?: number;
  preferredDexVolume24h?: number;
  preferredStableMcap?: number;
  dexVolume24h?: number;
  stableMcap?: number;
} | null>(null);
const stale = ref(false);
const expanded = ref<string | null>(null);
const iconFallback = ref<Record<string, number>>({});
let timer: ReturnType<typeof setInterval> | null = null;
let reqSeq = 0;

const TOKEN_COLORS: Record<string, string> = {
  BTC: '#f7931a',
  ETH: '#627eea',
  SOL: '#14f195',
  HYPE: '#22d3ee',
  BNB: '#f3ba2f',
};

const maxTvl = computed(() => Math.max(...rows.value.map((r) => r.chainTvl || 0), 1));

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
  iconFallback.value = { ...iconFallback.value, [sym]: Math.min(next, cands.length) };
}

function showLetter(sym: string) {
  const cands = coinIconCandidates(sym);
  return (iconFallback.value[sym] || 0) >= cands.length || !cands.length;
}

function barPct(tvl: number) {
  if (!tvl || tvl <= 0) return 0;
  return Math.max(4, (tvl / maxTvl.value) * 100);
}

function changeClass(pct: number | null | undefined) {
  if (pct == null || !Number.isFinite(pct)) return 'muted';
  if (pct > 0) return 'up';
  if (pct < 0) return 'down';
  return 'muted';
}

function formatPct(pct: number | null | undefined) {
  if (pct == null || !Number.isFinite(pct)) return '--';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function toggle(coin: string) {
  expanded.value = expanded.value === coin ? null : coin;
}

async function load(force = false) {
  if (!props.bootReady) return;
  if (loading.value && !force) return;
  const seq = ++reqSeq;
  loading.value = true;
  error.value = '';
  try {
    const coins = preferredCoinsState.value.length ? preferredCoinsState.value : ['BTC', 'ETH'];
    const next = await fetchDefillamaMacro(coins);
    if (seq !== reqSeq) return;
    rows.value = next.coins || [];
    overview.value = next.overview;
    stale.value = !!next.stale;
    if (!next.ok && !next.overview) {
      error.value = next.error || 'DeFiLlama 数据尚未就绪';
    }
  } catch (err) {
    if (seq !== reqSeq) return;
    if (!rows.value.length) {
      error.value = err instanceof Error ? err.message : '协议沉淀加载失败';
    }
  } finally {
    if (seq === reqSeq) loading.value = false;
  }
}

function startPoll() {
  if (timer) return;
  timer = setInterval(() => {
    if (props.active !== false) void load(false);
  }, 120_000);
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
    <div v-if="overview" class="summary">
      <div class="card">
        <div class="lab">偏好链 TVL</div>
        <div class="val">{{ formatUsd(overview.preferredTvl || 0) }}</div>
        <div class="chg muted">全网 {{ formatUsd(overview.totalTvl) }}</div>
      </div>
      <div class="card">
        <div class="lab">偏好链 DEX 24h</div>
        <div class="val">{{ formatUsd(overview.preferredDexVolume24h || 0) }}</div>
        <div class="chg muted">全网 {{ formatUsd(overview.dexVolume24h || 0) }}</div>
      </div>
      <div class="card">
        <div class="lab">偏好链稳定币</div>
        <div class="val">{{ formatUsd(overview.preferredStableMcap || 0) }}</div>
        <div class="chg muted">链上流通</div>
      </div>
    </div>

    <div class="source-hint">
      DeFiLlama · 按偏好币种对应公链聚合
      <span v-if="stale" class="stale">缓存延迟</span>
    </div>

    <el-skeleton v-if="loading && !rows.length" :rows="6" animated class="pad" />
    <el-alert
      v-else-if="error && !rows.length"
      type="warning"
      :closable="false"
      :title="error"
      class="pad"
    />
    <el-empty v-else-if="!rows.length" description="暂无偏好币种沉淀数据" class="pad" />

    <div v-else class="list">
      <div v-for="row in rows" :key="row.coin" class="block">
        <button
          type="button"
          class="row"
          :class="{ expanded: expanded === row.coin, unsupported: row.unsupported }"
          @click="toggle(row.coin)"
        >
          <div class="token">
            <span class="icon-wrap">
              <img
                v-if="!showLetter(row.coin)"
                class="icon-img"
                :src="iconSrc(row.coin)"
                :alt="row.coin"
                @error="onIconError(row.coin)"
              />
              <span
                v-else
                class="icon-fallback"
                :style="{ background: tokenColor(row.coin) }"
              >
                {{ row.coin.slice(0, 1) }}
              </span>
            </span>
            <span class="names">
              <b>{{ row.coin }}</b>
              <em>{{ row.chain || '未映射公链' }}</em>
            </span>
          </div>

          <div class="bar-wrap" aria-hidden="true">
            <div class="track">
              <div class="fill" :style="{ width: `${barPct(row.chainTvl || 0)}%` }" />
            </div>
          </div>

          <div class="net">{{ formatUsd(row.chainTvl || 0) }}</div>
          <div class="chg" :class="changeClass(row.tvlChange1dPct)">
            {{ formatPct(row.tvlChange1dPct) }}
          </div>
        </button>

        <div v-if="expanded === row.coin" class="detail">
          <div v-if="row.unsupported" class="lab">该币种暂未映射到 DeFiLlama 公链</div>
          <template v-else>
            <div class="grid">
              <div>
                <div class="lab">公链 TVL</div>
                <div class="val">{{ formatUsd(row.chainTvl || 0) }}</div>
              </div>
              <div>
                <div class="lab">TVL 1D</div>
                <div class="val" :class="changeClass(row.tvlChange1dPct)">
                  {{ formatPct(row.tvlChange1dPct) }}
                </div>
              </div>
              <div>
                <div class="lab">DEX 24h</div>
                <div class="val">{{ formatUsd(row.dexVolume24h || 0) }}</div>
              </div>
              <div>
                <div class="lab">DEX 1D</div>
                <div class="val" :class="changeClass(row.dexChange1dPct)">
                  {{ formatPct(row.dexChange1dPct) }}
                </div>
              </div>
              <div>
                <div class="lab">链上稳定币</div>
                <div class="val">{{ formatUsd(row.stableMcap || 0) }}</div>
              </div>
              <div>
                <div class="lab">公链</div>
                <div class="val">{{ row.chain }}</div>
              </div>
            </div>
            <div v-if="row.protocols?.length" class="proto">
              <div class="lab">相关协议（按该链 TVL）</div>
              <div v-for="p in row.protocols" :key="p.slug || p.name" class="proto-row">
                <span class="proto-name">
                  <b>{{ p.name }}</b>
                  <em>{{ p.category }}</em>
                </span>
                <span class="proto-tvl">{{ formatUsd(p.tvl) }}</span>
                <span class="proto-chg" :class="changeClass(p.change1dPct)">
                  {{ formatPct(p.change1dPct) }}
                </span>
              </div>
            </div>
          </template>
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
.summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(max-content, 1fr));
  gap: 8px;
  padding: 10px 12px 6px;
  flex-shrink: 0;
  overflow-x: auto;
}
.card {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--panel);
}
.card .lab {
  color: var(--soft);
  font-size: 10.5px;
  margin-bottom: 4px;
  white-space: nowrap;
}
.card .val {
  font-size: 13px;
  font-weight: 750;
  font-variant-numeric: tabular-nums;
  color: var(--text);
  white-space: nowrap;
}
.card .chg {
  margin-top: 3px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.source-hint {
  padding: 4px 12px 8px;
  font-size: 11px;
  color: var(--soft);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 8px;
}
.stale {
  color: var(--orange, #f59e0b);
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
  border-color: color-mix(in srgb, var(--blue) 40%, var(--border));
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}
.row.unsupported {
  opacity: 0.72;
}
.token {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 108px;
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
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
  width: 100%;
  height: 4px;
  background: var(--panel-3);
  border-radius: 2px;
  overflow: hidden;
}
.fill {
  height: 100%;
  border-radius: 2px;
  background: linear-gradient(90deg, color-mix(in srgb, var(--blue) 55%, transparent), var(--blue));
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
.chg.muted,
.muted {
  color: var(--soft);
}
.chg.up,
.up {
  color: var(--green);
}
.chg.down,
.down {
  color: var(--red);
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
.proto {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.proto-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 7px;
  background: var(--panel);
  border: 1px solid var(--border);
}
.proto-name {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}
.proto-name b {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.proto-name em {
  font-style: normal;
  font-size: 10px;
  color: var(--soft);
}
.proto-tvl {
  width: 78px;
  text-align: right;
  font-size: 12px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
.proto-chg {
  width: 52px;
  text-align: right;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
</style>
