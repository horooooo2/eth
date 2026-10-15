<script setup lang="ts">
import { computed } from 'vue';
import type { ResearchModel } from '@/composables/useContractResearch';
import ResearchSources from './ResearchSources.vue';
const props=defineProps<{model:ResearchModel}>(); const m=computed(()=>props.model);
const groups=[{id:'buyside',label:'买方资管 · 持仓与配置',note:'持仓对应披露报告期；配置观点与基于持仓的 AI 解读分别标注。'},{id:'sellside',label:'卖方投行 · 个股评级',note:'目标价、评级和核心逻辑保留来源，资料日期未知时明确标记。'}] as const;
function rating(v:string|null){const labels:Record<string,string>={'buy':'买入','strong buy':'强烈买入','overweight':'增持','outperform':'跑赢大盘','hold':'持有','neutral':'中性','sell':'卖出','underweight':'减持','underperform':'跑输大盘'};return v?labels[v.toLowerCase()]||v:'未公开';}
function tone(v:string|null){return /buy|overweight|outperform|买入|增持|跑赢/i.test(v||'')?'positive':/sell|underweight|underperform|卖出|减持|跑输/i.test(v||'')?'negative':'neutral';}
</script>
<template>
<div v-if="m.current" class="research-reference">
  <div class="research-ref-notice"><b>{{ m.current.symbol.replace(/USDT$/,'') }} · 机构观点</b><span>机构披露、公开报道与 AI 解读分别标注</span></div>
  <section v-for="group in groups" :key="group.id" class="research-institution-zone" :class="group.id">
    <h3 class="research-ref-title research-institution-heading">{{ group.label }} · {{ m.institutions.filter(i=>i.type===group.id).length }} 家</h3>
    <p class="research-muted">{{ group.note }}</p>
    <div v-if="m.institutions.some(i=>i.type===group.id)" class="research-ref-table research-institution-table">
      <table><thead><tr><th>机构</th><th>{{ group.id==='buyside'?'配置立场':'评级' }}</th><th v-if="group.id==='buyside'">持仓／变动</th><th>目标价</th><th v-if="group.id==='sellside'">支撑位</th><th>核心逻辑</th></tr></thead><tbody>
      <tr v-for="item in m.institutions.filter(i=>i.type===group.id)" :key="item.name"><td><strong>{{ item.name }}</strong><small>{{ item.asOf || '日期待核对' }}{{ item.stale && item.asOf?' · 历史参考':'' }}</small></td><td><span class="research-rating-badge" :class="tone(item.rating)" :title="item.rating || ''">{{ rating(item.rating) }}</span></td><td v-if="group.id==='buyside'">{{ item.holding || '—' }}<small>{{ item.change || '变动未取得' }}</small></td><td>{{ item.target || '—' }}</td><td v-if="group.id==='sellside'">{{ item.support || '—' }}</td><td><span class="research-provenance">{{ item.logicKind==='reported'?'公开论述摘要':'AI 解读' }} · {{ item.verification==='indexed'?'搜索摘录待核原文':'已读来源' }}</span><p>{{ item.logic || '目前仅取得评级或持仓，尚无可归属的具体论述。' }}</p><ResearchSources :model="m" :ids="item.sourceIds"/></td></tr></tbody></table>
    </div>
    <div class="research-institution-cards research-analysis-cards"><article v-for="item in m.institutions.filter(i=>i.type===group.id)" :key="item.name" class="research-card research-institution-card"><div class="research-card-title"><h3>{{ item.name }}</h3><span class="research-rating-badge" :class="tone(item.rating)">{{ rating(item.rating) }}</span></div><small>{{ item.asOf || '资料日期待核对' }} · {{ item.verification==='indexed'?'搜索摘录，尚未核对原文':'来源内容已读取' }}</small><div class="research-institution-metrics"><template v-if="group.id==='buyside'"><div><span>持仓／资金</span><b>{{ item.holding || '—' }}</b></div><div><span>变动</span><b>{{ item.change || '—' }}</b></div></template><div><span>目标价</span><b>{{ item.target || '—' }}</b></div><div v-if="group.id==='sellside'"><span>支撑位</span><b>{{ item.support || '—' }}</b></div></div><h4>{{ item.logicKind==='reported'?'核心逻辑分析':'AI 解读' }}</h4><p>{{ item.logic || '未取得明确的机构论述，不补造研报理由。' }}</p><ResearchSources :model="m" :ids="item.sourceIds"/><details v-if="item.quote" class="research-quote"><summary>查看对应摘录</summary><blockquote>{{ item.quote }}</blockquote></details></article></div>
    <div v-if="!m.institutions.some(i=>i.type===group.id)" class="research-quiet-empty">{{ m.analysis?'本次定向检索未形成可归属的机构条目，请查看下方检索状态及来源。':'点击「AI 多空分析」获取当前标的的机构资料。' }}</div>
  </section>
  <details v-if="m.research" class="research-data-details"><summary>检索状态与来源</summary><p class="research-muted">{{ m.research.warning }}</p><div v-for="source in m.research.sources" :key="source.id" class="research-evidence"><a v-if="m.safeUrl(source.url)" :href="m.safeUrl(source.url)" target="_blank" rel="noopener noreferrer">{{ source.title }} ↗</a><small> · {{ source.verification==='read'?'已读原文':source.verification==='indexed'?'搜索摘录':'暂未取得正文或摘录' }}</small></div></details>
</div>
</template>
