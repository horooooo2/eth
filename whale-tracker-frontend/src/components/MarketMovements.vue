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
  : snapshot.value.stale || error.value ? '数据待更新' : snapshot.value.warming ? '历史补齐中' : '实时采集');
</script>

<template>
  <section class="market-movements" :class="{ 'is-mobile': mobile }" aria-label="币安市场异动">
    <header class="movement-header"><strong>币安合约异动</strong><span class="status" :class="{ stale: snapshot?.stale || error }">{{ status }}</span></header>
    <p class="scope">成交额前 {{ snapshot?.monitored || 100 }} 个 USDT 永续 · 每小时更新范围</p>
    <div class="movement-toolbar">
      <div class="filters" aria-label="异动类型"><button v-for="item in filters" :key="item.id" type="button" :class="{ active: filter === item.id }" :aria-pressed="filter === item.id" @click="filter = item.id">{{ item.label }}</button></div>
      <input v-model="search" type="search" maxlength="40" placeholder="搜索合约" aria-label="搜索异动合约" />
    </div>
    <div v-if="error || snapshot?.error" class="notice" role="status">{{ error || snapshot?.error }}</div>
    <p v-if="snapshot" class="coverage">窗口就绪：5分钟 {{ snapshot.ready5m }}/{{ snapshot.monitored }} · 2小时 {{ snapshot.ready2h }}/{{ snapshot.monitored }} · 今日 {{ snapshot.readyDay }}/{{ snapshot.monitored }}</p>
    <div class="movement-list" aria-live="off">
      <p v-if="loading" class="empty" role="status">正在读取行情…</p>
      <p v-else-if="!rows.length" class="empty">{{ snapshot?.warming ? '正在限速补齐历史行情，已就绪合约继续监测。' : snapshot?.enabled === false ? '市场异动采集已暂停。' : snapshot?.stale || error ? '等待行情恢复，暂不生成新信号。' : '暂无符合条件的市场异动。' }}</p>
      <article v-for="row in rows" :key="row.id" class="movement-row">
        <div class="contract"><strong>{{ row.symbol }}</strong><span class="contract-tag">永续</span></div>
        <span class="change" :class="row.direction.toLowerCase()" :title="['HIGH','LOW'].includes(row.kind) ? '收盘价相对今日 UTC 开盘价的涨跌幅' : '窗口收盘价涨跌幅'">{{ percent(row.change) }}</span>
        <time :datetime="new Date(row.time).toISOString()">{{ timestamp(row.time) }}</time>
        <span class="event-label">{{ row.label }}</span>
      </article>
    </div>
    <footer>按已收盘1分钟K线判断 · 今日按UTC计<br />涨跌阈值3% / 7% / 11% · 同类信号间隔至少5分钟<br />展示最近100条 · 保留最近24小时，最多1000条 · 重启后重新采集</footer>
  </section>
</template>

<style scoped>
.market-movements{display:flex;flex-direction:column;box-sizing:border-box;padding:14px;gap:10px;min-width:0;color:var(--text);background:var(--card)}
.movement-header{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:14px}.status{font-size:11px;color:var(--muted)}.status.stale,.notice{color:var(--yellow)}
.scope,.coverage{font-size:11px;line-height:1.6;color:var(--muted);margin:0}.movement-toolbar{display:flex;flex-direction:column;gap:9px}.filters{display:flex;gap:4px;flex-wrap:wrap}
.filters button{border:0;background:transparent;color:var(--muted);padding:6px 10px;border-radius:5px;cursor:pointer;font:inherit;font-size:12px}.filters button.active{color:var(--text);background:var(--bg);font-weight:600}
input{width:100%;box-sizing:border-box;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:6px;padding:7px 10px;font:inherit;font-size:12px;min-width:0}input:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.notice{font-size:12px;line-height:1.5}.movement-list{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}.movement-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px 8px;padding:11px 0;border-bottom:1px solid var(--border);font-size:12px}.contract{display:flex;align-items:center;gap:5px;min-width:0}.contract strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.contract-tag{flex:none;font-size:10px;color:var(--muted);padding:1px 3px;background:var(--bg);border-radius:3px}.change{text-align:right;font-variant-numeric:tabular-nums}.up{color:var(--green)}.down{color:var(--red)}time,.event-label{color:var(--muted);font-size:11px}.event-label{text-align:right}.empty{text-align:center;color:var(--muted);font-size:12px;line-height:1.8;padding:32px 8px}footer{flex:none;font-size:10px;line-height:1.7;color:var(--muted);border-top:1px solid var(--border);padding-top:8px}
.is-mobile{padding:14px 0;background:transparent}.is-mobile .filters button{min-height:40px;padding:8px 14px;font-size:13px}.is-mobile input{min-height:40px;font-size:14px}.is-mobile .movement-row{padding:14px 0;font-size:14px}.is-mobile time,.is-mobile .event-label{font-size:12px}
</style>
