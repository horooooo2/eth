<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { http } from '@/api';
const props = defineProps<{ active:boolean; mobile:boolean }>();
type Coin = 'BTC'|'ETH';
type Flow = {longUsd:number;shortUsd:number;longShare:number|null;shortShare:number|null;fills:number;whales:number};
type Result = {mode:string;computedAt:number;sinceMs:number;untilMs:number;retentionExpired:boolean;coins:Record<Coin,Flow>;
  coverage:{monitored:number;covered:number;complete:boolean};quality:{unknownReceipts:number;lateFills:number;revisedFills:number;invalidRows:number;unclassifiedFills?:number}};
type Row = {id:string;releaseAt:number;family:string;event:{title:string;forecast:string;previous:string;actual:string;actualSource?:string;revisedActual?:string};
  direction:string;status:string;error:string|null;result:Result|null;revision:Result|null;
  comparisons:Record<Coin,{status:string;whaleDirection:string;eligible:boolean}>|null;
  verification?:{verifiedAt:number;evidenceUnchanged:boolean;coverage:Result['coverage'];quality:Result['quality']}|null};
type Summary = {eligible:number;matches:number;excluded:number;rate:number|null};
type Snapshot = {rows:Row[];total:number;pageSize:number;summary:Record<Coin,Summary>;runtime:{error:string;running:boolean}};
const state=ref<Snapshot|null>(null), family=ref('ALL'), page=ref(1), loading=ref(false), error=ref('');
const revisions=ref<Record<string,boolean>>({});
const coins:Coin[]=['BTC','ETH'];
const filters=[['ALL','全部'],['CPI','CPI'],['CORE_CPI','核心CPI'],['PCE','PCE'],['CORE_PCE','核心PCE'],['NFP','非农']];
const labels:Record<string,string>={MATCH:'方向一致',MISMATCH:'方向不一致',PENDING:'等待实际值',MACRO_NEUTRAL:'宏观中性',FLOW_NEUTRAL:'多空倾向不明确',INSUFFICIENT:'样本不足'};
let timer:ReturnType<typeof setTimeout>|undefined,controller:AbortController|null=null,generation=0;
async function refresh(version:number){
  if(!props.active||version!==generation)return;
  if(document.hidden){timer=setTimeout(()=>void refresh(version),10000);return;}
  controller=new AbortController(); loading.value=!state.value;
  try{
    const {data}=await http.get<Snapshot>('/news/macro-comparison',{params:{family:family.value,page:page.value},signal:controller.signal,timeout:8000});
    if(version===generation){state.value=data;error.value='';}
  }catch{if(version===generation)error.value='宏观对照暂不可用，稍后自动重试';}
  finally{if(version===generation){loading.value=false;controller=null;if(props.active)timer=setTimeout(()=>void refresh(version),10000);}}
}
function restart(){generation++;clearTimeout(timer);controller?.abort();controller=null;loading.value=false;if(props.active)void refresh(generation);}
watch(family,()=>{page.value=1;});
watch([()=>props.active,family,page],restart,{immediate:true});
onUnmounted(()=>{generation++;clearTimeout(timer);controller?.abort();});
const pages=computed(()=>Math.max(1,Math.ceil((state.value?.total||0)/(state.value?.pageSize||20))));
function date(time:number){return new Date(time).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});}
function clock(time:number){return new Date(time).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false});}
function dollars(value:number){return new Intl.NumberFormat('zh-CN',{style:'currency',currency:'USD',notation:'compact',maximumFractionDigits:2}).format(value);}
function percent(value:number|null){return value==null?'—':`${(value*100).toFixed(1)}%`;}
function isRevision(row:Row){return revisions.value[row.id]??Boolean(row.result?.mode==='RETROSPECTIVE'&&row.revision);}
function result(row:Row){return isRevision(row)&&row.revision?row.revision:row.result;}
function coverage(row:Row){return !isRevision(row)&&row.verification ? row.verification.coverage : result(row)!.coverage;}
function quality(row:Row){return !isRevision(row)&&row.verification ? row.verification.quality : result(row)!.quality;}
function direction(row:Row){return row.direction==='SHORT'?'加密偏空 · 美元偏多':row.direction==='LONG'?'加密偏多 · 美元偏空':row.direction==='NEUTRAL'?'符合预期 · 中性':'等待实际值 / 预期';}
function comparison(row:Row,coin:Coin){
  if(!isRevision(row))return labels[row.comparisons?.[coin].status||'PENDING'];
  const flow=result(row)?.coins[coin];
  if(!flow)return '待统计';
  if(row.direction==='PENDING')return '等待实际值';
  if(row.direction==='NEUTRAL')return '宏观中性';
  if(flow.whales<2||!(flow.longUsd+flow.shortUsd>0))return '样本不足';
  const side=(flow.longShare||0)>=0.6?'LONG':(flow.shortShare||0)>=0.6?'SHORT':'NEUTRAL';
  return side==='NEUTRAL'?'多空倾向不明确':side===row.direction?'方向一致':'方向不一致';
}
function comparisonTone(row:Row,coin:Coin){
  const label=comparison(row,coin);
  return label==='方向一致'?'match':label==='方向不一致'?'mismatch':'neutral';
}
</script>

<template>
  <section class="macro-comparison" :class="{'is-mobile':mobile}" aria-label="宏观对照历史">
    <header class="summary-header">
      <div class="summary-title"><h3>BTC / ETH 情绪对照</h3><span>提前方向一致率</span></div>
      <div v-if="state" class="summary" aria-label="方向一致率">
        <div v-for="coin in coins" :key="coin" class="summary-coin">
          <div class="summary-rate"><strong>{{coin}}</strong><span>{{percent(state.summary[coin].rate)}}</span></div>
          <span class="sample-count">{{state.summary[coin].matches}} / {{state.summary[coin].eligible}} 有效样本</span>
        </div>
      </div>
      <p class="explanation">公布前一小时多空 · 按公布批次与币种去重统计<br />关键数据独立保存，不随宏观日历过期消失</p>
    </header>
    <div class="filters" aria-label="指标筛选"><button v-for="[id,label] in filters" :key="id" type="button" :class="{active:family===id}" :aria-pressed="family===id" @click="family=id">{{label}}</button></div>
    <div v-if="error||state?.runtime.error" class="notice" role="status">{{error||state?.runtime.error}}</div>
    <div class="history">
      <p v-if="loading" class="empty">正在读取历史…</p>
      <p v-else-if="!state?.rows.length" class="empty">暂无已公布的关键数据，后台将自动保存后续记录。</p>
      <article v-for="row in state?.rows||[]" :key="row.id" class="event" :class="row.direction.toLowerCase()">
        <header class="event-header">
          <div class="event-heading"><strong>{{row.event.title}}</strong><time :datetime="new Date(row.releaseAt).toISOString()">{{date(row.releaseAt)}} 北京时间</time></div>
          <span class="direction" :class="row.direction.toLowerCase()">{{direction(row)}}</span>
        </header>
        <div v-if="result(row)" class="window"><span>监控窗口：{{clock(result(row)!.sinceMs)}}—{{clock(result(row)!.untilMs)}}（不含公布时点）</span><button v-if="row.revision" type="button" @click="revisions[row.id]=!isRevision(row)">{{isRevision(row)?'查看首次统计':'查看补采修订'}}</button></div>
        <div class="metrics-grid" aria-label="宏观数据对比">
          <div><span class="metric-label">预期</span><span class="metric-value">{{row.event.forecast||'—'}}</span></div>
          <div><span class="metric-label">前值</span><span class="metric-value">{{row.event.previous||'—'}}</span></div>
          <div><span class="metric-label">实际</span><strong class="metric-value actual" :class="row.direction.toLowerCase()">{{row.event.actual||'待回填'}}</strong></div>
        </div>
        <p v-if="row.event.actualSource" class="actual-source">实际值来源：{{row.event.actualSource}}</p>
        <p v-if="row.event.revisedActual" class="quality">最新修订 {{row.event.revisedActual}}；对照保留首次记录的实际值。</p>
        <template v-if="result(row)">
          <div class="coin-analysis">
            <div v-for="coin in coins" :key="coin" class="coin-flow">
              <div class="coin-title"><strong>{{coin}}</strong><span class="comparison-badge" :class="comparisonTone(row,coin)">{{comparison(row,coin)}}</span></div>
              <div class="flow-values">
                <div><span class="side-label">多</span><span class="long">{{dollars(result(row)!.coins[coin].longUsd)}}</span><span class="flow-share long">{{percent(result(row)!.coins[coin].longShare)}}</span></div>
                <div><span class="side-label">空</span><span class="short">{{dollars(result(row)!.coins[coin].shortUsd)}}</span><span class="flow-share short">{{percent(result(row)!.coins[coin].shortShare)}}</span></div>
              </div>
              <div v-if="result(row)!.coins[coin].longShare!=null" class="flow-bar" aria-hidden="true"><span :style="{width:`${(result(row)!.coins[coin].longShare||0)*100}%`}"/></div>
              <small>{{result(row)!.coins[coin].whales}} 个账户 · {{result(row)!.coins[coin].fills}} 笔开仓 / 加仓成交</small>
            </div>
          </div>
          <div class="event-notes">
            <p v-if="result(row)!.mode==='RETROSPECTIVE'" class="quality">{{isRevision(row)?'补采修订':'事后回溯'}}，不计入提前方向一致率。</p>
            <p v-else class="quality">{{row.comparisons?.BTC.eligible||row.comparisons?.ETH.eligible?'符合有效样本条件':'当前不符合有效样本条件，不计入一致率'}}。</p>
            <p v-if="!isRevision(row)&&row.verification" class="quality">冻结成交核验于 {{date(row.verification.verifiedAt)}}：{{row.verification.evidenceUnchanged?'公布前成交证据一致':'成交证据已变化，不计入提前一致率'}}。</p>
            <p v-if="!coverage(row).complete" class="quality">一小时采集覆盖待核实：{{coverage(row).covered}} / {{coverage(row).monitored}} 个监控账户。</p>
            <p v-if="result(row)!.retentionExpired" class="quality">统计时已超出原始成交保留期，历史窗口可能缺失。</p>
            <p class="quality">统计于 {{date(result(row)!.computedAt)}}。<span v-if="row.error">补采修订未完成：{{row.error}}</span></p>
            <p v-if="quality(row).unknownReceipts||quality(row).lateFills||quality(row).revisedFills" class="quality">首次到达时间未知 {{quality(row).unknownReceipts}} 笔 · 公布后补采 {{quality(row).lateFills}} 笔 · 公布后修正 {{quality(row).revisedFills}} 笔。</p>
            <p v-if="quality(row).unclassifiedFills||quality(row).invalidRows" class="quality">无法分类 {{quality(row).unclassifiedFills||0}} 笔 · 异常数据 {{quality(row).invalidRows||0}} 笔，不计入提前一致率。</p>
          </div>
        </template>
        <p v-else class="quality">{{row.status==='ERROR'?'统计失败，后台等待重试':state?.runtime.running?'后台计算中':'等待后台统计'}}。{{row.error||''}}</p>
      </article>
    </div>
    <div v-if="pages>1" class="pagination"><button :disabled="page<=1" @click="page--">上一页</button><span>{{page}} / {{pages}}</span><button :disabled="page>=pages" @click="page++">下一页</button></div>
    <footer>按原子成交的开仓＋加仓金额统计，排除减仓 / 平仓；不受列表展示条数和金额筛选影响。金额占比≥60%、至少2个账户才判定倾向。回溯、补采修订、覆盖不足及中性样本不计入提前一致率；规则标签不代表实际价格涨跌。</footer>
  </section>
</template>

<style scoped>
.macro-comparison {
  --comparison-mono: Consolas, 'SFMono-Regular', Menlo, monospace;
  display: flex; flex-direction: column; box-sizing: border-box; min-width: 0; min-height: 0;
  overflow: hidden; color: var(--text); background: var(--card);
}
.summary-header { flex: none; padding: 16px; border-bottom: 1px solid var(--border); }
.summary-title { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
h3 { margin: 0; font-size: 15px; font-weight: 700; }
.summary-title > span { font-size: 11px; color: var(--muted); }
.summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-bottom: 10px; }
.summary-coin { display: flex; flex-direction: column; gap: 5px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-2); }
.summary-rate { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-family: var(--comparison-mono); font-size: 14px; }
.summary-rate > span { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
.sample-count { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.explanation { margin: 0; font-size: 12px; line-height: 1.6; color: var(--muted); }
.filters { display: flex; flex: none; gap: 8px; padding: 12px 16px; overflow-x: auto; border-bottom: 1px solid var(--border); scrollbar-width: thin; scrollbar-color: var(--border-2) transparent; }
.filters button, .window button, .pagination button { border: 1px solid var(--border-2); border-radius: 6px; padding: 6px 12px; background: var(--panel-2); color: var(--muted); font: inherit; font-size: 13px; cursor: pointer; }
.filters button { flex: none; white-space: nowrap; transition: background .15s, color .15s, border-color .15s; }
.filters button.active { background: color-mix(in srgb, var(--blue) 10%, transparent); color: var(--blue); border-color: color-mix(in srgb, var(--blue) 45%, transparent); font-weight: 600; }
.notice { flex: none; padding: 10px 16px; font-size: 12px; line-height: 1.6; color: var(--yellow); overflow-wrap: anywhere; border-bottom: 1px solid var(--border); }
.history { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 16px; scrollbar-width: thin; scrollbar-color: var(--border-2) transparent; }
.history::-webkit-scrollbar { width: 4px; }
.history::-webkit-scrollbar-track { background: transparent; }
.history::-webkit-scrollbar-thumb { background: var(--border-2); border-radius: 4px; }
.empty { padding: 25px 8px; font-size: 12px; line-height: 1.7; text-align: center; color: var(--muted); }
.event { position: relative; display: flex; flex-direction: column; gap: 12px; padding: 16px; margin-bottom: 16px; border: 1px solid var(--border-2); border-radius: 10px; background: var(--panel-2); overflow: hidden; }
.event:last-child { margin-bottom: 0; }
.event.short, .event.long { color: var(--text); }
.event::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--muted); }
.event.short::before { background: var(--red); }
.event.long::before { background: var(--green); }
.event-header { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 10px; }
.event-heading { min-width: 0; flex: 1 1 160px; display: flex; flex-direction: column; gap: 5px; }
.event-heading strong { font-size: 16px; font-weight: 700; line-height: 1.5; overflow-wrap: anywhere; }
time { color: var(--muted); font-family: var(--comparison-mono); font-size: 11px; line-height: 1.6; }
.direction { padding: 4px 8px; border-radius: 6px; background: color-mix(in srgb, var(--muted) 12%, transparent); color: var(--muted); font-size: 12px; font-weight: 600; line-height: 1.6; }
.direction.short { background: color-mix(in srgb, var(--red) 12%, transparent); }
.direction.long { background: color-mix(in srgb, var(--green) 12%, transparent); }
.window { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 5px; color: var(--muted); font-size: 11px; line-height: 1.6; }
.window button { padding: 4px 6px; color: var(--blue); border-color: color-mix(in srgb, var(--blue) 30%, transparent); background: color-mix(in srgb, var(--blue) 6%, transparent); font-size: 11px; }
.metrics-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); }
.metrics-grid > div { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.metric-label { font-size: 11px; color: var(--muted); }
.metric-value { font-family: var(--comparison-mono); font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.metric-value.actual { font-size: 16px; font-weight: 700; }
.actual-source { margin: -6px 0 0; color: var(--muted); font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }
.coin-analysis { display: flex; flex-direction: column; gap: 10px; padding-top: 12px; border-top: 1px dashed var(--border-2); }
.coin-flow { padding: 10px 12px; border-radius: 6px; background: var(--bg); }
.coin-title { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.coin-title strong { font-family: var(--comparison-mono); font-size: 13px; }
.comparison-badge { padding: 2px 6px; border-radius: 4px; color: var(--muted); background: color-mix(in srgb, var(--muted) 10%, transparent); font-size: 11px; line-height: 1.5; }
.comparison-badge.match { color: var(--green); background: color-mix(in srgb, var(--green) 10%, transparent); }
.comparison-badge.mismatch { color: var(--red); background: color-mix(in srgb, var(--red) 10%, transparent); }
.flow-values { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; font-family: var(--comparison-mono); font-size: 12px; }
.flow-values > div { display: flex; align-items: baseline; gap: 4px; flex-wrap: wrap; min-width: 0; overflow-wrap: anywhere; }
.flow-values > div:last-child { justify-content: flex-end; text-align: right; }
.side-label { font-family: inherit; font-size: 11px; color: var(--muted); }
.flow-share { font-size: 11px; font-variant-numeric: tabular-nums; }
.long { color: var(--green); }
.short { color: var(--red); }
.flow-bar { height: 4px; background: var(--red); margin: 8px 0; border-radius: 4px; overflow: hidden; }
.flow-bar span { display: block; height: 100%; background: var(--green); }
small { display: block; margin-top: 6px; color: var(--muted); font-size: 10px; line-height: 1.6; }
.event-notes { padding-top: 10px; border-top: 1px solid var(--border); }
.quality { margin: 0; color: var(--muted); font-size: 10px; line-height: 1.7; overflow-wrap: anywhere; }
.event-notes .quality + .quality { margin-top: 3px; }
.pagination { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex: none; padding: 10px 16px; border-top: 1px solid var(--border); font-size: 12px; }
.pagination button { font-size: 12px; }
.pagination button:disabled { opacity: .4; cursor: default; }
footer { flex: none; padding: 12px 16px; border-top: 1px solid var(--border); background: var(--bg); color: var(--muted); font-size: 10px; line-height: 1.7; }
button:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
.is-mobile .summary-header { padding: 16px 12px; }
.is-mobile .filters { padding: 12px; }
.is-mobile .filters button { min-height: 40px; }
.is-mobile .history { padding: 12px; }
.is-mobile .event { padding: 14px 12px; }
.is-mobile .quality, .is-mobile small { font-size: 11px; }
.is-mobile .window button, .is-mobile .pagination button { min-height: 36px; }
.is-mobile footer { padding: 12px; }
@media (hover: hover) {
  .filters button:not(.active):hover, .pagination button:not(:disabled):hover { background: var(--panel-3); color: var(--text); }
  .window button:hover { background: color-mix(in srgb, var(--blue) 12%, transparent); }
}
@media (prefers-reduced-motion: reduce) { .filters button { transition: none; } }
</style>
