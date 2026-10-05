<script setup lang="ts">
import { computed } from 'vue';
import type { DirectionSummary } from '@/api';
import { coinMatchesWatch } from '@/utils/watchedCoins';
import { formatUsd } from '@/utils/format';
const props = defineProps<{ data: DirectionSummary | null; error: string; coin: string; windowLabel: string }>();
const emit = defineEmits<{ retry: [] }>();
const isAll = computed(() => props.coin.toUpperCase() === 'ALL');
const selected = computed(() => {
  if (isAll.value || !props.data || props.error) return null;
  return props.data.coins.filter(row => coinMatchesWatch(row.coin, [props.coin])).reduce((sum, row) => ({
    addLong: sum.addLong + row.addLong, addShort: sum.addShort + row.addShort,
    reduceLong: sum.reduceLong + row.reduceLong, reduceShort: sum.reduceShort + row.reduceShort,
    net: sum.net + row.net,
  }), { addLong: 0, addShort: 0, reduceLong: 0, reduceShort: 0, net: 0 });
});
const fields = [{ key: 'addLong', label: '开 / 加多', side: 'positive' }, { key: 'addShort', label: '开 / 加空', side: 'negative' }, { key: 'reduceLong', label: '减 / 平多', side: '' }, { key: 'reduceShort', label: '减 / 平空', side: '' }] as const;
</script>
<template>
  <section class="direction-board" aria-label="当前币种仓位统计">
    <header><span>仓位统计 · {{ isAll ? '全部' : coin }} <small>{{ windowLabel }}</small></span><strong :class="selected && selected.net > 0 ? 'positive' : selected && selected.net < 0 ? 'negative' : ''">{{ selected ? (selected.net > 0 ? '+' : '') + formatUsd(selected.net) : '---' }}</strong></header>
    <div class="direction-values"><div v-for="field in fields" :key="field.key"><small>{{ field.label }}</small><b :class="selected ? field.side : ''">{{ selected ? formatUsd(selected[field.key]) : '---' }}</b></div></div>
    <p v-if="isAll">选择币种后查看方向数据</p>
    <p v-else-if="error">统计暂不可用 <button @click="emit('retry')">重试</button></p>
    <p v-else-if="!data">正在读取成交统计…</p>

  </section>
</template>
<style scoped>
.direction-board{background:var(--panel-2);border:1px solid var(--border);border-radius:7px;padding:10px 12px;box-sizing:border-box;min-width:0}.direction-board header{display:flex;justify-content:space-between;gap:8px;align-items:center;font-size:12px;flex-wrap:wrap}.direction-board header small{color:var(--muted);margin-left:5px;font-size:10px}.direction-board strong{font-size:16px;font-variant-numeric:tabular-nums}.direction-values{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 14px;margin-top:9px}.direction-values>div{display:flex;justify-content:space-between;gap:4px;align-items:center;flex-wrap:wrap}.direction-values small{font-size:10px;color:var(--muted)}.direction-values b{font-size:12px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.positive{color:var(--bull)}.negative{color:var(--bear)}p{margin:8px 0 0;font-size:10px;color:var(--muted)}button{cursor:pointer;border:0;background:transparent;color:var(--accent)}
</style>
