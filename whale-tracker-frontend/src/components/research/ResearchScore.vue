<script setup lang="ts">
import { computed } from 'vue';
import type { ResearchModel } from '@/composables/useContractResearch';
import ResearchSources from './ResearchSources.vue';
const props=defineProps<{model:ResearchModel}>(); const m=computed(()=>props.model);
const maps=[['8–10 · 强支持','多项证据方向一致，仍需检查事件与持有风险。'],['6–8 · 较多支持','当前证据较支持该方向，但存在反向条件。'],['4–6 · 证据分歧','支持与不利因素交织，优势尚不明确。'],['2–4 · 支持较弱','该方向的有效依据较少，不自动代表反向有优势。'],['0–2 · 很少支持','当前资料几乎不支持该方向。']];
function width(v:number|null|undefined){return Math.max(0,Math.min(100,(v??0)*10))+'%';}
function contribution(v:number|null,w:number){return v==null?'—':(v*w/100).toFixed(2);}
</script>
<template>
<div v-if="m.current" class="research-reference">
  <div class="research-ref-notice"><b>{{ m.current.symbol.replace(/USDT$/,'') }} · {{ m.current.market.name }}</b><span>权重配置：技术面25% · 机构共识25% · 基本面20% · 事件催化20% · 资金／空头10%</span></div>
  <div class="research-score-layout">
    <article class="research-card research-composite"><h3>综合评分</h3><div v-for="side in (['bull','bear'] as const)" :key="side" class="research-composite-side"><span>{{ side==='bull'?'多头综合分':'空头综合分' }}</span><strong :class="side">{{ m.range(m.scores?.[side]) }} <small v-if="m.scores?.[side]">/ 10</small></strong><div class="research-ref-bar"><i :class="side" :style="{width:width(m.scores?.[side]?.low)}"/></div></div><p>{{ m.scores?.label }}；多空独立评估，分数越高表示证据对该方向的支持越强。</p><p v-if="m.analysis">{{ m.analysis.summary }}</p><small>资料覆盖 {{ m.scores?.coverage || 0 }}% · 缺失项不补零</small></article>
    <article class="research-card research-score-breakdown"><h3>维度明细</h3><div v-for="d in m.dimensions" :key="d.id" class="research-breakdown-item"><div class="research-breakdown-name"><span>{{ d.label }} ({{ d.weight }}%)</span><b class="bull">多 {{ m.num(d.bull,1) }}</b><b class="bear">空 {{ m.num(d.bear,1) }}</b></div><div class="research-dual-bars"><div class="research-ref-bar"><i class="bull" :style="{width:width(d.bull)}"/></div><div class="research-ref-bar"><i class="bear" :style="{width:width(d.bear)}"/></div></div><p>{{ d.question }}</p></div></article>
  </div>
  <h3 class="research-ref-title">加权计算</h3>
  <div class="research-ref-table research-weight-table"><table><thead><tr><th>维度</th><th>多头得分</th><th>空头得分</th><th>权重</th><th>多头贡献</th><th>空头贡献</th></tr></thead><tbody><tr v-for="d in m.dimensions" :key="d.id"><td>{{ d.label }}</td><td>{{ m.num(d.bull,1) }}</td><td>{{ m.num(d.bear,1) }}</td><td>{{ d.weight }}%</td><td>{{ contribution(d.bull,d.weight) }}</td><td>{{ contribution(d.bear,d.weight) }}</td></tr><tr class="research-weight-total"><td>合计</td><td>—</td><td>—</td><td>100%</td><td class="bull">{{ m.range(m.scores?.bull) }}</td><td class="bear">{{ m.range(m.scores?.bear) }}</td></tr></tbody></table></div>
  <div class="research-weight-mobile"><article v-for="d in m.dimensions" :key="d.id" class="research-card"><h4>{{ d.label }} <small>{{ d.weight }}%</small></h4><div class="research-pair"><span>多头 {{ m.num(d.bull,1) }} → <b class="bull">{{ contribution(d.bull,d.weight) }}</b></span><span>空头 {{ m.num(d.bear,1) }} → <b class="bear">{{ contribution(d.bear,d.weight) }}</b></span></div></article><p>合计（100%）：<b class="bull">多 {{ m.range(m.scores?.bull) }}</b> · <b class="bear">空 {{ m.range(m.scores?.bear) }}</b></p></div>
  <h3 class="research-ref-title">状态映射说明</h3>
  <div class="research-map-grid"><article v-for="[label,note] in maps" :key="label" class="research-card"><h4>{{ label }}</h4><p>{{ note }}</p></article><article class="research-card research-etf-exception"><h4>杠杆 ETF 例外</h4><p>KORU 等每日重置产品存在路径依赖，普通方向分不能替代对多日复利偏离的分析。</p></article></div>
  <details class="research-data-details"><summary>各维度的评分依据</summary><article v-for="d in m.dimensions" :key="d.id" class="research-rating-row"><h4>{{ d.label }} · {{ d.method }}</h4><p>{{ d.question }}</p><p>{{ d.reason }}</p><ResearchSources :model="m" :ids="d.sourceIds"/></article></details>
</div>
</template>
