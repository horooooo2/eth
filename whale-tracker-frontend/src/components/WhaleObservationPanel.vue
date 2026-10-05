<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { http } from '@/api';
import type { ObservationSnapshot, ObservationEvidence, WhaleObservation, ObservationPosition } from '@/types/whaleObservation';
const props = defineProps<{ snapshot: ObservationSnapshot | null; active: boolean; connected: boolean; linkedCoin: string }>();
const emit = defineEmits<{ locate: [payload: { id: string; name: string; coin: string }]; detail: [id: string] }>();
const data = ref<ObservationSnapshot | null>(null), error=ref(''), loading=ref(false);
const coin=ref(props.linkedCoin || 'ALL'), kind=ref('all'), scroller=ref<HTMLElement>();
const pending=ref<ObservationSnapshot | null>(null), expanded=ref('');
const evidence=ref<ObservationEvidence | null>(null), evidenceError=ref(''), evidenceLoading=ref(false);
let request=0, evidenceRequest=0, disposed=false;
const highlights=ref<Record<string,'new'|'update'>>({});
const highlightTimers=new Map<string,ReturnType<typeof setTimeout>>();
// Sampling timestamps alone are not a new market action.
const positionChange=(row:WhaleObservation)=>JSON.stringify([row.latestPosition&&[row.latestPosition.status,row.latestPosition.reason,row.latestPosition.side,row.latestPosition.size],row.members?.map(m=>[m.whaleId,m.latestPosition?.status,m.latestPosition?.side,m.latestPosition?.size])]);
function highlightChanges(next:ObservationSnapshot) {
  if(!data.value)return;
  const previous=new Map(data.value.rows.map(row=>[row.id,row]));
  const nextIds=new Set(next.rows.map(row=>row.id));
  for(const [id,timer] of highlightTimers)if(!nextIds.has(id)){clearTimeout(timer);highlightTimers.delete(id);delete highlights.value[id];}
  for(const row of next.rows) {
    if((coin.value!=='ALL'&&row.coin!==coin.value)||(kind.value!=='all'&&row.type!==kind.value))continue;
    const old=previous.get(row.id);
    if(old&&old.revision===row.revision&&positionChange(old)===positionChange(row))continue;
    if(highlightTimers.has(row.id))continue;
    highlights.value[row.id]=old?'update':'new';
    highlightTimers.set(row.id,setTimeout(()=>{delete highlights.value[row.id];highlightTimers.delete(row.id);},1800));
  }
}
const coins=computed(()=>[...new Set([...(data.value?.rows || []).map(r=>r.coin), ...(coin.value==='ALL'?[]:[coin.value])])].sort());
const rows=computed(()=>(data.value?.rows || []).filter(r=>(coin.value==='ALL'||r.coin===coin.value)&&(kind.value==='all'||r.type===kind.value)));
function install(next: ObservationSnapshot) {
  highlightChanges(next);
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
watch([coin,kind],()=>{for(const timer of highlightTimers.values())clearTimeout(timer);highlightTimers.clear();highlights.value={};});
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
const trackingStatus=(status:string)=>({gap:'后续成交不连续，追踪中断',closed:'已观测到平仓',reversed:'已观测到反手',forced:'出现清算 / ADL 成交'}[status]||'最后可衔接成交状态');
const interruptionReason=(reason:string)=>({'missing-fields':'成交缺少必要字段','ambiguous-order':'同时间成交先后顺序无法确认','position-mismatch':'相邻成交的仓位数量不衔接，无法确认中间变化'}[reason]||'无法确认连续性');
const positionLabel=(p?:ObservationPosition)=>!p?'未知':p.status==='unknown'?`未知 · ${{stale:'快照超过 3 分钟',error:'采集异常','before-event':'快照早于事件',clock:'时间异常',invalid:'字段不完整',ambiguous:'仓位不唯一',missing:'缺少有效快照'}[p.reason||'missing']||'待核实'}`:p.status==='flat'?'该合约无仓位':`${p.side==='long'?'多':'空'} ${number(p.size||0)} · ${p.status==='same'?'与事件同向':'与事件反向'}`;
const short=(r:WhaleObservation)=>{const s=r.address||r.whaleId;return s.length>18?`${s.slice(0,8)}…${s.slice(-6)}`:s;};
onMounted(()=>{if(!data.value)void refresh();});
onUnmounted(()=>{disposed=true;request++;evidenceRequest++;for(const timer of highlightTimers.values())clearTimeout(timer);highlightTimers.clear();});
</script>

<template>
  <section class="observation-panel">
    <header class="filters">
      <select v-model="coin" aria-label="观察币种"><option value="ALL">全部币种</option><option v-for="c in coins" :key="c" :value="c">{{ c }}</option></select>
      <select v-model="kind" aria-label="观察类型"><option value="all">全部行为</option><option value="collective">多地址共同动作</option><option value="build">持续建仓</option><option value="reverse">方向反转</option><option value="reduce">减仓 / 平仓</option></select>
    </header>
    <div class="scope">近 24 小时 · 最近 100 条 · 已采集合约成交 <span v-if="!connected"> · 连接恢复中</span></div>
    <button v-if="pending" class="updates" @click="showUpdates">观察记录有更新，点击查看</button>
    <div v-if="error || data?.error" class="notice">{{error || data?.error}}</div>
    <div ref="scroller" class="observation-scroll">
      <div v-if="!rows.length" class="empty">{{loading?'正在读取服务器记录…':data?.warming?'正在整理已存成交，稍后自动更新。':'当前筛选下暂无达到条件的观察事件。'}}<small>仅展示有成交依据的行为，不代表市场没有异动。</small></div>
      <article v-for="row in rows" :key="row.id" class="observation-card" :class="[row.side,highlights[row.id]&&`live-${highlights[row.id]}`]">
        <div class="card-top"><strong>{{row.title}}</strong><span>{{row.side==='long'?'多头':'空头'}}</span></div>
        <span v-if="highlights[row.id]" class="live-label" role="status">{{highlights[row.id]==='new'?'新观察':'已更新'}}</span>
        <button v-if="row.type!=='collective'" class="address" :title="row.address||row.whaleId" @click="emit('locate',{id:row.whaleId,name:short(row),coin:row.coin})">{{short(row)}} ↗</button>
        <p>{{row.text}}</p>
        <div v-if="row.positionCounts" class="tracking">最新采集状态：同向 {{row.positionCounts.same}} · 无仓位 {{row.positionCounts.flat}} · 反向 {{row.positionCounts.opposite}} · 未知 {{row.positionCounts.unknown}}<small>各地址采集时间不同；同向不代表期间未平仓重开。</small></div>
        <details v-if="row.members?.length" class="members"><summary>查看参与地址 · {{row.members.length}}</summary><div v-for="member in row.members" :key="member.whaleId"><button class="address" @click="emit('locate',{id:member.whaleId,name:member.address||member.whaleId,coin:row.coin})">{{(member.address||member.whaleId).slice(0,10)}}… · 增仓 {{number(member.addUsd)}} USD ↗</button><small>{{positionLabel(member.latestPosition)}}<template v-if="member.latestPosition?.asOf"> · {{time(member.latestPosition.asOf)}}</template></small></div></details>
        <div v-if="row.metrics.closedPnl != null" class="pnl">减仓已实现盈亏 <b>{{row.metrics.closedPnl>=0?'+':''}}{{row.metrics.closedPnl.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}} USD</b><small>未扣手续费及资金费</small></div>
        <time>{{time(row.startAt)}} — {{time(row.lastAt)}}</time>
        <details v-if="row.latestPosition || row.tracking || row.timing" class="tracking combined-details">
          <summary>仓位与追踪详情</summary>
        <section v-if="row.latestPosition" class="detail-section"><strong>最新采集仓位</strong><div>{{positionLabel(row.latestPosition)}}</div><small v-if="row.latestPosition.asOf">{{time(row.latestPosition.asOf)}} · {{row.coin}} 合约快照</small><small>独立快照，不据此补齐中间成交。</small></section>
        <section v-if="row.tracking" class="detail-section">
          <strong>后续追踪 · {{trackingStatus(row.tracking.status)}}</strong>
          <div>后续增仓 {{number(row.tracking.addUsd)}} / 减仓 {{number(row.tracking.reduceUsd)}} USD</div>
          <div>最后成交后：{{row.tracking.lastSize===0?'空仓':`${row.tracking.lastSize>0?'多':'空'} ${number(Math.abs(row.tracking.lastSize))} ${row.coin}`}}</div>
          <small>{{time(row.tracking.asOf)}} · 非当前持仓快照</small>
          <div v-if="row.tracking.interruption" class="notice">{{interruptionReason(row.tracking.interruption.reason)}}<br>{{time(row.tracking.interruption.at)}}<template v-if="row.tracking.interruption.actualSize!=null"><br>上一笔后 {{number(row.tracking.interruption.expectedSize)}} → 下一笔前 {{number(row.tracking.interruption.actualSize)}} {{row.coin}}</template></div>
        </section>
        <section v-if="row.timing" class="detail-section timing"><strong>数据时间</strong>
          <div v-if="row.timing.eventAt">最近依据成交：{{time(row.timing.eventAt)}}</div>
          <div v-if="row.timing.latestExecutionReceivedAt">该笔首次进入观察模块：{{time(row.timing.latestExecutionReceivedAt)}}</div>
          <div>本版摘要生成：{{time(row.timing.generatedAt)}}</div>
          <small>历史回填和规则重算会产生时间差，不等于实时网络延迟。</small>
        </section>
        </details>
        <footer><button @click="toggle(row)">{{expanded===row.id?'收起依据':`成交依据 · ${row.evidenceCount}`}}</button><button v-if="row.type!=='collective'" @click="emit('detail',row.whaleId)">巨鲸详情</button></footer>
        <div v-if="expanded===row.id" class="evidence">
          <div v-if="evidenceLoading">读取成交依据…</div>
          <div v-if="evidenceError">{{evidenceError}} <button @click="loadEvidence(row)">重试</button></div>
          <div v-for="fill in evidence?.rows||[]" :key="fill.id" class="fill">
            <time>{{time(fill.time)}}</time>
            <small v-if="row.type==='collective'">{{fill.address||fill.whaleId}}</small>
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
.observation-scroll{overflow:auto;flex:1;min-height:0;padding:3px 12px 16px;overflow-anchor:none}.observation-card{position:relative;padding:14px;margin-bottom:14px;border:1px solid color-mix(in srgb,var(--direction) 35%,var(--border));border-left:3px solid var(--direction);border-radius:10px;background:linear-gradient(115deg,color-mix(in srgb,var(--direction) 8%,transparent),transparent 80%),var(--card);box-shadow:0 3px 10px #00000014;overflow-wrap:anywhere}
.observation-card.long{--direction:#20bf91}.observation-card.short{--direction:#f16a7c}
.card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.card-top strong{font-size:16px;line-height:1.5}.card-top span{flex-shrink:0;font-size:12px;font-weight:700;padding:3px 8px;border:1px solid color-mix(in srgb,var(--direction) 45%,transparent);background:color-mix(in srgb,var(--direction) 15%,transparent);border-radius:5px}
.long .card-top span{color:#20bf91}.short .card-top span{color:#f16a7c}.address{padding:8px 0;font-size:13px}.observation-card p{margin:3px 0 12px;font-size:15px;line-height:1.8;overflow-wrap:anywhere}
time{font-size:12px;color:var(--muted)}footer{display:flex;justify-content:space-between;margin-top:12px}footer button{padding:4px 0;font-size:13px}
.pnl{font-size:13px;padding-bottom:10px}.pnl b{margin-left:5px}.pnl small{display:block;color:var(--muted);margin-top:4px}.notice,.updates{padding:10px 14px;font-size:13px}.notice{color:var(--muted)}
.empty{padding:50px 12px;text-align:center;color:var(--muted);font-size:14px;line-height:1.7}.empty small{display:block;margin-top:8px}.evidence{margin-top:10px;border-top:1px dashed var(--border);font-size:13px}
.fill{display:flex;flex-direction:column;gap:6px;padding:12px 0;border-bottom:1px solid var(--border)}.fill small{color:var(--muted)}
.tracking{padding:10px;margin:10px 0;background:var(--card);border:1px solid var(--border);border-radius:8px;font-size:13px;line-height:1.8}.tracking small{color:var(--muted)}.members summary{cursor:pointer;font-size:13px}.members .address{display:block;text-align:left;overflow-wrap:anywhere}
.timing{margin-top:8px;font-size:12px;line-height:1.8;color:var(--muted)}
.tracking small{display:block}.members small{color:var(--muted);font-size:12px}
.tracking summary{cursor:pointer;font-weight:600;font-size:13px;line-height:1.6}.tracking[open] summary{margin-bottom:8px}.tracking:not([open]){padding:8px 10px;margin:7px 0;background:transparent}.tracking summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.live-label{position:absolute;right:14px;top:-7px;padding:0 5px;border-radius:4px;background:var(--card);color:var(--direction);font-size:11px;pointer-events:none}
.live-new{animation:observation-enter 280ms ease-out,observation-glow 1.8s ease-out}.live-update{animation:observation-glow 1.8s ease-out}
@keyframes observation-enter{from{opacity:.35;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}
@keyframes observation-glow{0%,25%{box-shadow:inset 0 0 0 1px var(--direction),0 0 14px color-mix(in srgb,var(--direction) 25%,transparent)}100%{box-shadow:0 3px 10px #00000014}}
@media(prefers-reduced-motion:reduce){.live-new,.live-update{animation:none;outline:1px solid var(--direction);outline-offset:-1px}}
.detail-section{padding:10px 0}.detail-section + .detail-section{border-top:1px solid var(--border)}.detail-section strong{display:block;margin-bottom:6px}.combined-details .timing{margin-top:0}
</style>
