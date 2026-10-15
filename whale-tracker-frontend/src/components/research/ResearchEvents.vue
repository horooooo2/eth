<script setup lang="ts">
import {computed} from 'vue';
import type {ResearchModel} from '@/composables/useContractResearch';
import type {ResearchEvent} from '@/types/contractResearch';
const props=defineProps<{model:ResearchModel}>();const m=computed(()=>props.model);
function stamp(e:ResearchEvent){if(e.ongoing)return {day:'持续',month:'关注'};let date=e.date;if(e.at){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(e.at));date=['year','month','day'].map(t=>parts.find(p=>p.type===t)?.value).join('-');}return {day:date?.slice(8,10)||'—',month:date?['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][Number(date.slice(5,7))-1]:'待定'};}
function category(e:ResearchEvent){return /财报|earnings/i.test(e.title)?'公司财报':/评级|目标价/.test(e.title)?'机构调整':/产能|供给|NAND|HDD|SSD/i.test(e.title)?'行业供给':/CPI|PCE|非农|FOMC|利率/.test(e.title)?'宏观数据':e.relation;}
function high(e:ResearchEvent){return e.importance==='high'||(!e.importance&&/财报|CPI|PCE|非农|FOMC|利率/i.test(e.title));}
</script>
<template>
<div v-if="m.current" class="research-reference">
<div class="research-ref-notice"><b>{{ m.current.symbol.replace(/USDT$/,'') }} 相关事件</b><span>仅展示与当前标的有关的事件，时间按北京时间显示。</span></div>
<h3 class="research-ref-title">{{ m.current.symbol.replace(/USDT$/,'') }} · 事件列表</h3>
<div class="research-event-list"><article v-for="e in m.events" :key="e.id" class="research-card research-event-item">
  <div class="research-event-date"><b>{{ stamp(e).day }}</b><span>{{ stamp(e).month }}</span></div>
  <div class="research-event-content"><h3>{{ e.title }}</h3><p>{{ e.note || e.relation }}</p><div v-if="e.previous!=null||e.forecast!=null||e.actual!=null" class="research-pair"><span>前值 <b>{{ e.previous || '—' }}</b></span><span>预期 <b>{{ e.forecast || '—' }}</b></span><span>实际 <b>{{ e.actual || (m.eventState(e)==='近期已发生'?'待核实':'待公布') }}</b></span></div><div class="research-event-tags"><span v-if="high(e)" class="research-rating-badge negative">高重要度</span><span class="research-event-state" :class="{past:m.eventState(e)==='近期已发生'}">{{ m.eventState(e)==='近期已发生'?'已发生':m.eventState(e) }}</span><span>{{ category(e) }}</span><span v-if="e.stale" class="research-tag warning">日程待复核</span></div><div class="research-event-meta"><span>{{ m.eventDate(e) }}</span><a v-if="m.safeUrl(e.sourceUrl)" :href="m.safeUrl(e.sourceUrl)" target="_blank" rel="noopener noreferrer">{{ e.source }} ↗</a></div><details v-if="e.quote" class="research-quote"><summary>查看对应摘录</summary><blockquote>{{ e.quote }}</blockquote></details></div>
</article></div>
<p v-if="!m.events.length" class="research-quiet-empty">暂无已收录事件，联网分析可补充相关资料。</p>
</div>
</template>
