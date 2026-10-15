<script setup lang="ts">
import type { ResearchModel } from '@/composables/useContractResearch';
import ResearchPanels from '@/components/research/ResearchPanels.vue';
import ContractLogo from '@/components/ContractLogo.vue';
defineProps<{ model: ResearchModel }>();
</script>
<template>
  <section class="research-workspace research-mobile" aria-label="手机合约研判">
    <header class="research-preference-toolbar">
      <div class="research-assets" aria-label="偏好标的"><button v-for="id in model.quickAssets" :key="id" :class="{ active: model.symbol === id }" :aria-pressed="model.symbol === id" @click="model.select(id)"><ContractLogo :symbol="id" :asset-type="model.catalog.find(a => a.symbol === id)?.assetType" /><span>{{ id.replace(/USDT$/, '') }}<small>{{ model.catalog.find(a => a.symbol === id)?.name || '合约资料' }}</small><small>{{ model.num(id === model.symbol ? model.current?.quote?.lastPrice : model.catalog.find(a => a.symbol === id)?.lastPrice) }} USDT</small></span></button></div>
      <button class="research-primary research-run-button" :disabled="!model.current || model.pending || model.running || model.starting" @click="model.analyze">{{ model.running || model.starting ? '分析中…' : 'AI 多空分析' }}</button>
    </header>
    <p v-if="!model.quickAssets.length" class="research-notice">标的偏好中暂无可用合约，请在「我的 → 标的偏好」中调整。</p>
    <nav class="research-tabs" aria-label="研判内容"><button v-for="item in model.tabs" :key="item.id" :class="{ active: model.tab === item.id }" :aria-pressed="model.tab === item.id" @click="model.tab = item.id">{{ item.label }}</button></nav>
    <ResearchPanels :model="model" />
  </section>
</template>
