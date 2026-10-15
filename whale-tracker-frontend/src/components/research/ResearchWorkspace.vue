<script setup lang="ts">
import { computed } from 'vue';
import { useContractResearch } from '@/composables/useContractResearch';
import ContractLogo from '@/components/ContractLogo.vue';
import ResearchPanels from './ResearchPanels.vue';
import MobileResearch from '@/components/mobile/MobileResearch.vue';
import './research.css';
const props = defineProps<{ active: boolean; mobile: boolean }>();
const model = useContractResearch(computed(() => props.active));
</script>
<template>
  <MobileResearch v-if="mobile" :model="model" />
  <section v-else class="research-workspace" aria-label="合约研判">
    <header class="research-preference-toolbar">
      <div class="research-assets" aria-label="偏好标的"><button v-for="id in model.quickAssets" :key="id" :class="{ active: model.symbol === id }" :aria-pressed="model.symbol === id" @click="model.select(id)"><ContractLogo :symbol="id" :asset-type="model.catalog.find(a => a.symbol === id)?.assetType" /><span>{{ id.replace(/USDT$/, '') }}<small>{{ model.catalog.find(a => a.symbol === id)?.name || '合约资料' }}</small><small>{{ model.num(id === model.symbol ? model.current?.quote?.lastPrice : model.catalog.find(a => a.symbol === id)?.lastPrice) }} USDT</small></span></button></div>
      <button class="research-primary research-run-button" :disabled="!model.current || model.pending || model.running || model.starting" @click="model.analyze">{{ model.running || model.starting ? '分析进行中…' : 'AI 多空分析' }}</button>
    </header>
    <p v-if="!model.quickAssets.length" class="research-notice">标的偏好中暂无可用的币安 USDT 永续合约，请在设置中调整标的偏好。</p>
    <p v-if="model.catalogStale" class="research-notice">合约目录正在使用缓存，交易状态需重新确认。</p>
    <nav class="research-tabs" aria-label="研判内容"><button v-for="item in model.tabs" :key="item.id" :class="{ active: model.tab === item.id }" :aria-pressed="model.tab === item.id" @click="model.tab = item.id">{{ item.label }}</button></nav>
    <ResearchPanels :model="model" />
  </section>
</template>
