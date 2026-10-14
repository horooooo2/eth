<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { http } from '@/api';
const props = defineProps<{ active: boolean; mobile: boolean }>();
type Movement = { id: string; symbol: string; name: string; label: string; kind: string;
  time: number; change: number; price: number; referencePrice: number; direction: 'UP' | 'DOWN' };
type Snapshot = { events: Movement[]; monitored: number; ready5m: number; ready2h: number; readyDay: number;
  latestAt: number | null; warming: number; connected: boolean; stale: boolean; enabled: boolean; error: string };
const snapshot = ref<Snapshot | null>(null), error = ref(''), loading = ref(false);
const filter = ref('ALL'), search = ref('');
const filters = [{ id: 'ALL', label: '全部' }, { id: 'UP', label: '涨' }, { id: 'DOWN', label: '跌' },
  { id: 'HIGH', label: '新高' }, { id: 'LOW', label: '新低' }];
const rows = computed(() => (snapshot.value?.events || []).filter(row => {
  const matches = filter.value === 'ALL' || (['HIGH', 'LOW'].includes(filter.value)
    ? row.kind === filter.value : row.direction === filter.value);
  return matches && `${row.symbol} ${row.name}`.toLowerCase().includes(search.value.trim().toLowerCase());
}));
let timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | null = null, generation = 0;
async function refresh(version: number) {
  if (!props.active || version !== generation) return;
  if (document.hidden) { timer = setTimeout(() => void refresh(version), 5000); return; }
  loading.value = !snapshot.value; controller = new AbortController();
  try {
    const { data } = await http.get<Snapshot>('/markets/movements', { signal: controller.signal, timeout: 8000 });
    if (version !== generation) return;
    snapshot.value = data; error.value = '';
  } catch {
    if (version === generation) error.value = '行情状态暂不可用，稍后自动重试';
  } finally {
    if (version === generation) { loading.value = false; controller = null;
      if (props.active) timer = setTimeout(() => void refresh(version), 5000); }
  }
}
watch(() => props.active, active => {
  generation++; clearTimeout(timer); controller?.abort(); controller = null; loading.value = false;
  if (active) void refresh(generation);
}, { immediate: true });
onUnmounted(() => { generation++; clearTimeout(timer); controller?.abort(); });
function percent(value: number) { return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`; }
function timestamp(value: number) { return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); }
const status = computed(() => !snapshot.value ? '连接中' : !snapshot.value.enabled ? '已暂停'
  : snapshot.value.stale || error.value || snapshot.value.error || !snapshot.value.connected ? '数据待更新'
    : snapshot.value.warming ? '历史补齐中' : '实时采集');
const statusTone = computed(() => status.value === '实时采集' ? 'live'
  : ['数据待更新', '历史补齐中'].includes(status.value) ? 'pending' : 'idle');
</script>

<template>
  <section class="market-movements" :class="{ 'is-mobile': mobile }" aria-label="币安市场异动">
    <header class="movement-heading">
      <div class="movement-header">
        <strong>币安合约异动</strong>
        <span class="status" :class="statusTone"><span class="status-dot" aria-hidden="true"></span>{{ status }}</span>
      </div>
      <p class="scope">成交额前 {{ snapshot?.monitored ?? 100 }} 个 USDT 永续 · 每小时更新范围</p>
    </header>
    <div class="movement-toolbar">
      <div class="filters" aria-label="异动类型"><button v-for="item in filters" :key="item.id" type="button" :class="{ active: filter === item.id }" :aria-pressed="filter === item.id" @click="filter = item.id">{{ item.label }}</button></div>
      <div class="search-box">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 4.5 4.5" /></svg>
        <input v-model="search" type="search" maxlength="40" placeholder="搜索合约" aria-label="搜索异动合约" />
      </div>
      <div v-if="snapshot" class="coverage" aria-label="监测窗口就绪数量">
        <div><span>5分钟</span><span class="coverage-value">{{ snapshot.ready5m }}/{{ snapshot.monitored }}</span></div>
        <div><span>2小时</span><span class="coverage-value">{{ snapshot.ready2h }}/{{ snapshot.monitored }}</span></div>
        <div><span>今日</span><span class="coverage-value">{{ snapshot.readyDay }}/{{ snapshot.monitored }}</span></div>
      </div>
      <div v-if="error || snapshot?.error" class="notice" role="status">{{ error || snapshot?.error }}</div>
    </div>
    <div class="movement-list" aria-live="off">
      <p v-if="loading" class="empty" role="status">正在读取行情…</p>
      <p v-else-if="!rows.length" class="empty">{{ snapshot?.warming ? '正在限速补齐历史行情，已就绪合约继续监测。' : snapshot?.enabled === false ? '市场异动采集已暂停。' : snapshot?.stale || error ? '等待行情恢复，暂不生成新信号。' : '暂无符合条件的市场异动。' }}</p>
      <article v-for="row in rows" :key="row.id" class="movement-row">
        <div class="movement-left">
          <div class="contract"><strong :title="row.symbol">{{ row.symbol }}</strong><span class="contract-tag">永续</span></div>
          <time :datetime="new Date(row.time).toISOString()">{{ timestamp(row.time) }}</time>
        </div>
        <div class="movement-right">
          <span class="change" :class="row.change >= 0 ? 'up' : 'down'" :title="['HIGH','LOW'].includes(row.kind) ? '收盘价相对今日 UTC 开盘价的涨跌幅' : '窗口收盘价涨跌幅'">{{ percent(row.change) }}</span>
          <span class="event-label" :class="['HIGH', 'LOW'].includes(row.kind) ? 'neutral' : row.direction.toLowerCase()">{{ row.label }}</span>
        </div>
      </article>
    </div>
    <footer>
      <p>按已收盘1分钟K线判断 · 今日按UTC计</p>
      <p>涨跌阈值 <span>3% / 7% / 11%</span> · 同类信号间隔至少 <span>5分钟</span></p>
      <p>展示最近100条 · 保留最近24小时，最多1000条 · 重启后重新采集</p>
    </footer>
  </section>
</template>

<style scoped>
.market-movements {
  --movement-mono: Consolas, 'SFMono-Regular', Menlo, monospace;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  color: var(--text);
  background: var(--card);
}
.movement-heading { flex: none; padding: 16px; border-bottom: 1px solid var(--border); }
.movement-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.movement-header strong { font-size: 16px; font-weight: 700; }
.status { display: inline-flex; align-items: center; gap: 6px; flex: none; color: var(--muted); font-size: 12px; }
.status.live { color: var(--blue); }
.status.pending, .notice { color: var(--yellow); }
.status-dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: currentColor; }
.status.live .status-dot { box-shadow: 0 0 6px color-mix(in srgb, var(--blue) 50%, transparent); animation: live-pulse 1.5s ease-in-out infinite; }
@keyframes live-pulse { 50% { opacity: .4; } }
.scope { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
.movement-toolbar { display: flex; flex-direction: column; gap: 12px; flex: none; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.filters { display: flex; gap: 8px; }
.filters button {
  flex: 1; min-width: 0; padding: 6px 8px; border: 1px solid var(--border-2); border-radius: 6px;
  background: var(--panel-2); color: var(--muted); cursor: pointer; font: inherit; font-size: 13px;
  transition: background .15s, color .15s, border-color .15s;
}
.filters button.active { color: var(--blue); border-color: color-mix(in srgb, var(--blue) 45%, transparent); background: color-mix(in srgb, var(--blue) 10%, transparent); font-weight: 600; }
.search-box { display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 0 12px; border: 1px solid var(--border-2); border-radius: 8px; background: var(--bg); }
.search-box svg { width: 16px; height: 16px; flex: none; color: var(--muted); }
.search-box input { width: 100%; min-width: 0; min-height: 34px; border: 0; padding: 0; background: transparent; color: var(--text); font: inherit; font-size: 13px; outline: none; }
.search-box input::placeholder { color: var(--muted); }
.search-box:focus-within { border-color: var(--blue); outline: 2px solid color-mix(in srgb, var(--blue) 25%, transparent); }
.filters button:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
.coverage { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; padding: 8px 10px; border-radius: 6px; background: var(--panel-2); color: var(--muted); font-size: 11px; }
.coverage > div { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 3px 6px; }
.coverage-value { color: var(--text); font-family: var(--movement-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
.notice { font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.movement-list { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 4px 0; scrollbar-width: thin; scrollbar-color: var(--border-2) transparent; }
.movement-list::-webkit-scrollbar { width: 4px; }
.movement-list::-webkit-scrollbar-thumb { background: var(--border-2); border-radius: 4px; }
.movement-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid color-mix(in srgb, var(--border-2) 55%, transparent); }
.movement-row:last-child { border-bottom: 0; }
.movement-left { display: flex; flex-direction: column; gap: 5px; flex: 1; min-width: 0; }
.movement-right { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; flex: none; }
.contract { display: flex; align-items: center; gap: 8px; min-width: 0; }
.contract strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--movement-mono); font-size: 14px; font-weight: 600; }
.contract-tag { flex: none; padding: 1px 6px; border-radius: 4px; background: color-mix(in srgb, var(--muted) 15%, transparent); color: var(--muted); font-size: 10px; }
.change { font-family: var(--movement-mono); font-variant-numeric: tabular-nums; font-size: 16px; font-weight: 700; }
.up { color: var(--green); }
.down { color: var(--red); }
time { color: var(--muted); font-family: var(--movement-mono); font-size: 12px; white-space: nowrap; }
.event-label { padding: 2px 6px; border-radius: 4px; font-size: 11px; line-height: 1.5; white-space: nowrap; }
.event-label.up { background: color-mix(in srgb, var(--green) 10%, transparent); }
.event-label.down { background: color-mix(in srgb, var(--red) 10%, transparent); }
.event-label.neutral { background: color-mix(in srgb, var(--muted) 10%, transparent); color: var(--muted); }
.empty { padding: 32px 16px; color: var(--muted); text-align: center; font-size: 12px; line-height: 1.8; }
footer { flex: none; padding: 12px 16px; border-top: 1px solid var(--border); background: var(--bg); color: var(--muted); font-size: 11px; line-height: 1.6; }
footer p { margin: 0 0 4px; }
footer p:last-child { margin-bottom: 0; }
footer span { color: var(--text); }
.is-mobile .movement-heading { padding: 16px 12px; }
.is-mobile .movement-toolbar { padding: 12px; }
.is-mobile .filters button { min-height: 40px; }
.is-mobile .search-box { min-height: 40px; }
.is-mobile .search-box input { min-height: 38px; font-size: 14px; }
.is-mobile .movement-row { padding: 14px 12px; }
.is-mobile footer { padding: 12px; }
@media (hover: hover) {
  .filters button:not(.active):hover { background: var(--panel-3); color: var(--text); }
  .movement-row:hover { background: var(--panel-2); }
}
@media (prefers-reduced-motion: reduce) {
  .status.live .status-dot { animation: none; }
  .filters button { transition: none; }
}
</style>
