<script setup lang="ts">
import { computed } from 'vue';
import { contractDetails } from '@/utils/contractDetails';

const props = withDefaults(defineProps<{ symbol: string; assetType: string; name?: string; iconOnly?: boolean }>(), { name: '', iconOnly: false });
const details = computed(() => contractDetails(props.symbol, props.assetType, props.name));
</script>

<template>
  <a v-if="details" class="detail-link" :class="{ 'icon-only': iconOnly }" :href="details.href" target="_blank" rel="noopener noreferrer" :title="details.title" :aria-label="`${symbol} 详情：${details.title}`" @click.stop>
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 10.5v6M12 7.5v.5"/></svg><span v-if="!iconOnly">详情</span>
  </a>
  <span v-else class="detail-link unavailable" :class="{ 'icon-only': iconOnly }" title="暂无详情" aria-disabled="true" @click.stop><span v-if="!iconOnly">详情</span></span>
</template>

<style scoped>
.detail-link{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;flex:none;height:28px;padding:0 7px;border:1px solid var(--line);border-radius:6px;color:var(--muted);background:transparent;font:inherit;font-size:12px;text-decoration:none;white-space:nowrap;cursor:pointer}
.detail-link svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round}
.detail-link:hover{color:var(--text);background:var(--hover)}
.detail-link:focus-visible{outline:2px solid var(--gold);outline-offset:2px}
.detail-link.icon-only{width:24px;height:24px;padding:0;border:0}
.detail-link.icon-only svg{width:18px;height:18px}
.unavailable{opacity:.4;cursor:default}
</style>
