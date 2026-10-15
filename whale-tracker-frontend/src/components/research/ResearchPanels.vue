<script setup lang="ts">
import {computed} from 'vue';import type {ResearchModel} from '@/composables/useContractResearch';
import ResearchOverview from './ResearchOverview.vue';import ResearchScore from './ResearchScore.vue';import ResearchInstitutions from './ResearchInstitutions.vue';import ResearchEvents from './ResearchEvents.vue';import ResearchAlerts from './ResearchAlerts.vue';
const props=defineProps<{model:ResearchModel}>();const m=computed(()=>props.model);
</script>
<template>
<div class="research-panels">
  <div v-if="m.error" class="research-notice danger" role="alert">{{ m.error }}<button :disabled="m.pending" @click="m.load();m.loadCatalog()">重试读取</button></div>
  <div v-if="m.notice" class="research-notice" role="status">{{ m.notice }}</div>
  <div v-if="m.running" class="research-notice working" role="status"><span class="research-dot"/>正在定向检索机构与事件、读取来源并分析多空。{{ m.pollError?'状态读取暂时失败，将自动重试。':'' }}</div>
  <div v-if="m.pending&&!m.current" class="research-loading"><span class="research-spinner"/>正在读取行情与公开资料…</div>
  <ResearchOverview v-if="m.current&&m.tab==='overview'" :model="m"/>
  <ResearchScore v-if="m.current&&m.tab==='evidence'" :model="m"/>
  <ResearchInstitutions v-if="m.current&&m.tab==='institutions'" :model="m"/>
  <ResearchEvents v-if="m.current&&m.tab==='events'" :model="m"/>
  <ResearchAlerts v-if="m.current&&m.tab==='alerts'" :model="m"/>
  <div v-if="!m.current&&!m.pending&&m.quickAssets.length" class="research-empty">选择标的后读取资料。<button class="research-text" @click="m.load()">读取资料</button></div>
  <details v-if="m.current" class="research-boundaries"><summary>资料覆盖与来源</summary><ul class="research-list"><li v-for="v in m.current.warnings" :key="v">{{ v }}</li><li v-for="v in m.analysis?.limitations" :key="v">{{ v }}</li></ul><div class="research-source-feed"><div v-for="source in m.sources" :key="source.id"><a v-if="m.safeUrl(source.url)" :href="m.safeUrl(source.url)" target="_blank" rel="noopener noreferrer">{{ source.title }} ↗</a><span v-else>{{ source.title }}</span><small>{{ m.date(source.asOf) }}{{ source.verification==='indexed'?' · 搜索摘录待核原文':'' }}</small></div></div></details>
  <footer v-if="m.current" class="research-footer"><span>资料采样 {{ m.date(m.current.generatedAt) }}{{ m.research?.at?' · 检索于 '+m.date(m.research.at):'' }}</span><span>评分为证据支持度，不代表胜率或未来收益。</span></footer>
</div>
</template>
