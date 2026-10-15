<script setup lang="ts">
import {computed} from 'vue';import type {ResearchModel} from '@/composables/useContractResearch';
const props=defineProps<{model:ResearchModel}>();const m=computed(()=>props.model);
function when(at:number|null){if(!at)return '日期未知';const diff=Date.now()-at;if(diff>=0&&diff<3600000)return '1小时内';if(diff>=0&&diff<86400000)return Math.floor(diff/3600000)+'小时前';return new Date(at).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric'});}
function state(item:{value:number|null;triggered:boolean;near?:boolean}){return item.value==null?'unknown':item.triggered?'triggered':item.near?'near':'clear';}
const labels:Record<string,string>={unknown:'未评估',triggered:'已触发',near:'接近',clear:'未触发'};
</script>
<template>
<div v-if="m.current" class="research-reference">
  <div class="research-ref-notice"><b>{{ m.current.symbol.replace(/USDT$/,'') }} 相关警报。</b><button class="research-text" @click="m.loadAlerts">重新检查</button></div>
  <h3 class="research-ref-title">活跃警报</h3>
  <p v-if="m.alertError" class="research-notice danger">{{ m.alertError }}</p>
  <div class="research-active-alerts"><article v-for="item in m.alerts?.alerts" :key="item.id" class="research-card research-alert-line"><i class="research-alert-led" :class="item.level"/><div><b>{{ item.title }}</b><p>{{ item.detail }}</p></div><time :title="m.date(item.at)">{{ when(item.at) }}</time></article></div>
  <p v-if="m.alerts&&!m.alerts.alerts.length" class="research-quiet-empty">当前可用资料未触发已配置条件；缺失数据不代表风险解除。</p>
  <h3 class="research-ref-title">警报阈值配置</h3>
  <div class="research-ref-table research-alert-table"><table><thead><tr><th>指标</th><th>警报条件</th><th>当前状态</th></tr></thead><tbody><tr v-for="item in m.alerts?.thresholds" :key="item.id"><td>{{ item.label }}<small v-if="item.value!=null">当前 {{ m.num(item.value) }}{{ item.unit }}</small></td><td>{{ item.rule }}</td><td><span class="research-alert-state" :class="state(item)">{{ labels[state(item)] }}</span></td></tr></tbody></table></div>
  <p class="research-muted research-alert-footnote">阈值按当前快照检查，不会在后台重复调用 AI。{{ m.alerts?'检查于 '+m.date(m.alerts.evaluatedAt):'' }}；点击 AI 多空分析会重新读取资料。</p>
</div>
</template>
