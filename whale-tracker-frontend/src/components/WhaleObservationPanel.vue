<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { http } from '@/api';
import type { ObservationSnapshot, ObservationEvidence, WhaleObservation } from '@/types/whaleObservation';
const props = defineProps<{ snapshot: ObservationSnapshot | null; active: boolean; connected: boolean; linkedCoin: string }>();
const emit = defineEmits<{ locate: [payload: { id: string; name: string; coin: string }]; detail: [id: string] }>();
const data = ref<ObservationSnapshot | null>(null), error=ref(''), loading=ref(false);
const coin=ref(props.linkedCoin || 'ALL'), kind=ref('all'), scroller=ref<HTMLElement>();
const pending=ref<ObservationSnapshot | null>(null), expanded=ref('');
const evidence=ref<ObservationEvidence | null>(null), evidenceError=ref(''), evidenceLoading=ref(false);
let request=0, evidenceRequest=0, disposed=false;
const coins=computed(()=>[...new Set([...(data.value?.rows || []).map(r=>r.coin), ...(coin.value==='ALL'?[]:[coin.value])])].sort());
const rows=computed(()=>(data.value?.rows || []).filter(r=>(coin.value==='ALL'||r.coin===coin.value)&&(kind.value==='all'||r.type===kind.value)));
function install(next: ObservationSnapshot) {
  data.value=next; error.value='';
  if(expanded.value && !next.rows.some(r=>r.id===expanded.value)) { expanded.value=''; evidence.value=null; evidenceRequest++; }
  else if(expanded.value && evidence.value && next.rows.find(r=>r.id===expanded.value)?.revision!==evidence.value.revision) {
    evidence.value=null; evidenceError.value='记录已更新，请重新读取依据'; evidenceRequest++; evidenceLoading.value=false;
  }
}
function accept(next: ObservationSnapshot, live=false) {
  const latest=pending.value || data.value;
  if(latest?.epoch===next.epoch && (latest.seq>next.seq || (latest.seq===next.seq && (!pending.value || live)))) return;
  if(live && data.value && (!props.active || (scroller.value?.scrollTop || 0)>80)) {pending.value=next;return;}
  pending.value=null; install(next);
}
watch(()=>props.snapshot,next=>{if(next){request++;loading.value=false;accept(next,true);}}, {immediate:true});
watch(()=>props.linkedCoin,next=>{coin.value=next || 'ALL';});
async function refresh() {
  const id=++request;loading.value=true;
  try {const {data:next}=await http.get<ObservationSnapshot>('/whales/observations'); if(id===request&&!disposed){error.value='';accept(next);}}
  catch {if(id===request)error.value='读取失败，保留最近结果。';}
  finally {if(id===request)loading.value=false;}
}
function showUpdates(){if(pending.value){install(pending.value);pending.value=null;}scroller.value?.scrollTo({top:0,behavior:'smooth'});}
async function loadEvidence(row: WhaleObservation, more=false) {
  const id=++evidenceRequest; evidenceLoading.value=true;evidenceError.value='';
  try {
    const offset=more ? evidence.value?.rows.length || 0 : 0;
    const {data:next}=await http.get<ObservationEvidence>(`/whales/observations/${row.id}/evidence`,{params:{offset}});
    if(id!==evidenceRequest||disposed)return;
    if(next.revision!==row.revision){evidence.value=null;evidenceError.value='记录已修订，请先刷新观察列表';return;}
    if(more && evidence.value?.revision!==next.revision){evidence.value=null;evidenceError.value='依据已修订，请重新读取';return;}
    evidence.value=more&&evidence.value?{...next,rows:[...evidence.value.rows,...next.rows]}:next;
  }catch{if(id===evidenceRequest)evidenceError.value='依据读取失败，记录可能已合并或过期。';}
  finally{if(id===evidenceRequest)evidenceLoading.value=false;}
}
function toggle(row:WhaleObservation){evidenceRequest++;evidenceLoading.value=false;evidence.value=null;evidenceError.value='';expanded.value=expanded.value===row.id?'':row.id;if(expanded.value)void loadEvidence(row);}
const time=(n:number)=>new Date(n).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const number=(n:number)=>n.toLocaleString('en-US',{maximumFractionDigits:6});
const action=(kind:string)=>({open:'开仓',increase:'加仓',decrease:'减仓',close:'平仓'}[kind]||kind);
const short=(r:WhaleObservation)=>{const s=r.address||r.whaleId;return s.length>18?`${s.slice(0,8)}…${s.slice(-6)}`:s;};
onMounted(()=>{if(!data.value)void refresh();});
onUnmounted(()=>{disposed=true;request++;evidenceRequest++;});
</script>

<template>
  <section class="observation-panel">
    <header class="filters">
      <select v-model="coin" aria-label="观察币种"><option value="ALL">全部币种</option><option v-for="c in coins" :key="c" :value="c">{{ c }}</option></select>
      <select v-model="kind" aria-label="观察类型"><option value="all">全部行为</option><option value="build">持续建仓</option><option value="reverse">方向反转</option><option value="reduce">减仓 / 平仓</option></select>
      <button :disabled="loading" title="读取服务器已存结果" @click="refresh">{{loading?'读取中':'刷新'}}</button>
    </header>
    <div class="scope">近 24 小时 · 最近 100 条 · 已采集合约成交 <span v-if="!connected"> · 连接恢复中</span></div>
    <button v-if="pending" class="updates" @click="showUpdates">观察记录有更新，点击查看</button>
    <div v-if="error || data?.error" class="notice">{{error || data?.error}}</div>
    <div ref="scroller" class="observation-scroll">
      <div v-if="!rows.length" class="empty">{{loading?'正在读取服务器记录…':data?.warming?'正在整理已存成交，稍后自动更新。':'当前筛选下暂无达到条件的观察事件。'}}<small>仅展示有成交依据的行为，不代表市场没有异动。</small></div>
      <article v-for="row in rows" :key="row.id" class="observation-card" :class="row.side">
        <div class="card-top"><strong>{{row.title}}</strong><span>{{row.side==='long'?'多头':'空头'}}</span></div>
        <button class="address" :title="row.address||row.whaleId" @click="emit('locate',{id:row.whaleId,name:short(row),coin:row.coin})">{{short(row)}} ↗</button>
        <p>{{row.text}}</p>
        <div v-if="row.metrics.closedPnl != null" class="pnl">减仓已实现盈亏 <b>{{row.metrics.closedPnl>=0?'+':''}}{{row.metrics.closedPnl.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}} USD</b><small>未扣手续费及资金费</small></div>
        <time>{{time(row.startAt)}} — {{time(row.lastAt)}}</time>
        <footer><button @click="toggle(row)">{{expanded===row.id?'收起依据':`成交依据 · ${row.evidenceCount}`}}</button><button @click="emit('detail',row.whaleId)">巨鲸详情</button></footer>
        <div v-if="expanded===row.id" class="evidence">
          <div v-if="evidenceLoading">读取成交依据…</div>
          <div v-if="evidenceError">{{evidenceError}} <button @click="loadEvidence(row)">重试</button></div>
          <div v-for="fill in evidence?.rows||[]" :key="fill.id" class="fill">
            <time>{{time(fill.time)}}</time>
            <span>{{fill.legs.map(l=>`${action(l.kind)}${l.side==='long'?'多':'空'}`).join(' / ')}}</span>
            <b>{{number(fill.size)}} {{row.coin}} × {{number(fill.price)}} USD</b>
            <small>仓位数量 {{number(fill.start)}} → {{number(fill.end)}} · 正数为多，负数为空</small>
          </div>
          <button v-if="evidence && evidence.rows.length<evidence.total" :disabled="evidenceLoading" @click="loadEvidence(row,true)">加载更多依据</button>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.observation-panel{display:flex;flex-direction:column;min-height:0;color:var(--text)}
.filters{display:flex;gap:8px;padding:14px 12px 8px}.filters select{min-width:0;flex:1;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:7px;cursor:pointer}
button{font:inherit;cursor:pointer;background:transparent;color:var(--accent);border:0}button:disabled{opacity:.5;cursor:wait}.scope{padding:0 14px 12px;font-size:12px;color:var(--muted)}
.observation-scroll{overflow:auto;flex:1;min-height:0;padding:0 12px 16px;overflow-anchor:none}.observation-card{padding:15px 0;border-bottom:1px solid var(--border)}
.card-top{display:flex;align-items:center;justify-content:space-between;gap:8px}.card-top strong{font-size:16px}.card-top span{font-size:12px;color:var(--muted)}
.long .card-top span{color:#20bf91}.short .card-top span{color:#f16a7c}.address{padding:8px 0;font-size:13px}.observation-card p{margin:3px 0 12px;font-size:15px;line-height:1.8;overflow-wrap:anywhere}
time{font-size:12px;color:var(--muted)}footer{display:flex;justify-content:space-between;margin-top:12px}footer button{padding:4px 0;font-size:13px}
.pnl{font-size:13px;padding-bottom:10px}.pnl b{margin-left:5px}.pnl small{display:block;color:var(--muted);margin-top:4px}.notice,.updates{padding:10px 14px;font-size:13px}.notice{color:var(--muted)}
.empty{padding:50px 12px;text-align:center;color:var(--muted);font-size:14px;line-height:1.7}.empty small{display:block;margin-top:8px}.evidence{margin-top:10px;border-top:1px dashed var(--border);font-size:13px}
.fill{display:flex;flex-direction:column;gap:6px;padding:12px 0;border-bottom:1px solid var(--border)}.fill small{color:var(--muted)}
</style>
