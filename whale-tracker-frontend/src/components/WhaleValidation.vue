<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { sortValidationPositions } from '@/utils/validationSort';
import { http } from '@/api';
import { whaleAssetLabel } from '@/utils/whaleAssetLabel';
import { formatUsd, formatPrice } from '@/utils/format';
const props = defineProps<{ coin: string }>();
type Position = {address:string;openTime?:number|null;name:string;side:string;size:number;usd:number;observedAt:number;entryPx:number|null;unrealizedPnl:number|null;liquidationPx:number|null;marginUsed:number|null;leverage:number|null;leverageType:string|null;returnOnEquity:number|null};
type Job = { id:string; mode:'normal'|'deep'; canStop:boolean; eligible:number; phase:string; nextOffset:number; offset:number; positionTotal:number; coin:string; status:string; total:number; success:number; failed:number; longUsd:number; shortUsd:number; longCount:number; shortCount:number; startedAt:number; finishedAt:number|null; error?:string; positions:Position[] };
const visible=ref(false), busy=ref(false), error=ref(''), job=ref<Job|null>(null);
let timer:ReturnType<typeof setTimeout>|undefined, generation=0;
let pollingGeneration:number|null=null;
const minimized=ref(false), stopping=ref(false);
const statusLabel=computed(()=>job.value?.status==='running'?(job.value.phase==='leaderboard'?'正在筛选排行榜':'验证进行中'):job.value?.status==='complete'?'验证完成':job.value?.status==='stopped'?'已停止':'验证未完整完成');
function minimize(){minimized.value=true;visible.value=false;}
function restore(){minimized.value=false;visible.value=true;}
async function stop(){
  if(!job.value || stopping.value)return;
  stopping.value=true;clearTimeout(timer);const seq=++generation;
  try{const {data}=await http.post<Job>(`/whales/validation/${job.value.id}/stop`,{offset:job.value.positions.length});if(seq===generation){accept(data);error.value='';if(data.nextOffset<data.positionTotal)timer=setTimeout(()=>void poll(data.id,seq),100);}}
  catch(e){if(seq===generation){error.value=message(e);timer=setTimeout(()=>void poll(job.value!.id,seq),3000);}}
  finally{stopping.value=false;}
}
const chooser=ref(false);
const sortKey=ref<'usd'|'openTime'|'entryPx'|'unrealizedPnl'>('usd'), ascending=ref(false);
const sortOptions=[{key:'usd',label:'仓位价值'},{key:'openTime',label:'开仓时间'},{key:'entryPx',label:'开仓均价'},{key:'unrealizedPnl',label:'开仓盈亏'}] as const;
const visibleCount=ref(50);
const positionSide=ref<'all'|'long'|'short'>('all');
function toggleSide(side:'long'|'short'){positionSide.value=positionSide.value===side?'all':side;}
watch([sortKey,ascending,positionSide],()=>{visibleCount.value=50;});
const sortedPositions=computed(()=>sortValidationPositions((job.value?.positions||[]).filter(row=>positionSide.value==='all'||row.side===positionSide.value),sortKey.value,ascending.value));
function accept(data:Job){
  const previous=job.value?.id===data.id ? job.value.positions : [];
  job.value={...data,positions:[...previous.slice(0,data.offset),...data.positions]};
}
function choose(){if(job.value?.status==='running'){restore();return;}chooser.value=true;}
const expanded=ref('');
const timingState=ref<Record<string,string>>({});
let disposed=false;
async function togglePosition(row:Position){
  const key=row.address+row.side;
  expanded.value=expanded.value===key?'':key;
  if(!expanded.value || !job.value || row.openTime!=null)return;
  const id=job.value.id, requestKey=id+key;
  if(['loading','done'].includes(timingState.value[requestKey]||''))return;
  timingState.value[requestKey]='loading';
  try{
    const {data}=await http.get<{openTime:number|null}>(`/whales/validation/${id}/open-time`,{params:{address:row.address}});
    if(disposed||job.value?.id!==id)return;
    const current=job.value.positions.find(p=>p.address===row.address&&p.side===row.side);
    if(current)current.openTime=data.openTime;
    timingState.value[requestKey]='done';
  }catch{if(!disposed&&job.value?.id===id)timingState.value[requestKey]='done';}
}
const progress=computed(()=>job.value?.total ? Math.round((job.value.success+job.value.failed)/job.value.total*100) : 0);
const market=computed(()=>job.value?.coin.includes(':')?job.value.coin.split(':')[0]:'默认合约');
const amount=(value:number|null|undefined)=>value==null?'—':formatUsd(value);
const price=(value:number|null|undefined)=>value==null?'—':formatPrice(value);
const direction=computed(()=>!job.value || job.value.longUsd+job.value.shortUsd===0?'未发现持仓':job.value.longUsd>job.value.shortUsd?'样本仓位偏多':job.value.longUsd<job.value.shortUsd?'样本仓位偏空':'样本多空持平');
const openTimeLabel=(value:number|null|undefined)=>{
  if(value==null || !Number.isFinite(value) || value<=0)return '-';
  const date=new Date(value);
  return Number.isNaN(date.getTime())?'-':date.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
};
const time=(value:number)=>new Date(value).toLocaleTimeString('zh-CN',{hour12:false});
function message(e:unknown){
  const err=e as {message?:string;details?:{error?:string};response?:{data?:{error?:string}}};
  return err?.response?.data?.error || err?.details?.error || (err?.message==='TIMEOUT'?'请求超时，请重试':err?.message) || '读取验证结果失败，请重试';
}
async function poll(id:string, seq:number){
  if(seq!==generation || pollingGeneration===seq)return;
  clearTimeout(timer);pollingGeneration=seq;
  try {const {data}=await http.get<Job>(`/whales/validation/${id}`,{params:{offset:job.value?.id===id?job.value.positions.length:0}});if(seq!==generation)return;accept(data);error.value='';if((data.status==='running'||data.nextOffset<data.positionTotal)&&(visible.value||minimized.value))timer=setTimeout(()=>void poll(id,seq),data.nextOffset<data.positionTotal?100:5000);}
  catch(e){if(seq===generation){error.value=message(e);const err=e as {status?:number;response?:{status?:number}};const status=err.status||err.response?.status;if([401,403,404].includes(status||0)){if(job.value?.id===id)job.value={...job.value,status:'error',canStop:false};}else if(visible.value||minimized.value)timer=setTimeout(()=>void poll(id,seq),10000);}}
  finally{if(pollingGeneration===seq)pollingGeneration=null;}
}
async function start(mode:'normal'|'deep', coin=props.coin, restartId?:string){
  chooser.value=false;
  if(busy.value||coin==='all')return;
  if(job.value?.status==='running'){restore();return;}
  minimized.value=false;visible.value=true;busy.value=true;error.value='';clearTimeout(timer);const seq=++generation;if(!restartId)job.value=null;expanded.value='';timingState.value={};visibleCount.value=50;positionSide.value='all';
  try {const {data}=await http.post<Job>('/whales/validation',{coin,mode,restartId});if(seq!==generation)return;accept(data);if(data.status==='running'||data.nextOffset<data.positionTotal)timer=setTimeout(()=>void poll(data.id,seq),data.nextOffset<data.positionTotal?100:5000);}
  catch(e){if(seq===generation)error.value=message(e);}finally{busy.value=false;}
}
watch(visible,value=>{if(!value){if(job.value?.status==='running'||busy.value)minimized.value=true;if(!minimized.value){clearTimeout(timer);generation++;}}});
onMounted(async()=>{
  const seq=generation;
  try{const {data}=await http.get<Job|null>('/whales/validation/current');if(seq!==generation||!data)return;
    if(data.status==='running'){accept(data);minimized.value=true;void poll(data.id,seq);}
  }catch{/* A new session or restarted server has no recoverable task. */}
});
onUnmounted(()=>{disposed=true;clearTimeout(timer);generation++;});
</script>
<template>
  <button type="button" class="validation-trigger" :disabled="coin==='all'||busy" title="选择具体标的后验证最多 200 个候选账户" @click="choose">数据验证</button>
  <el-dialog v-model="chooser" title="选择验证方式" width="min(460px,94vw)" append-to-body>
    <div class="mode-options"><button @click="start('normal')"><b>普通验证</b><span>现有候选地址，最多 200 个</span></button><button @click="start('deep')"><b>深度验证</b><span>榜单账户价值 ≥100 万美元且周成交额 >0，最多 1,000 个；可能耗时数十分钟</span></button></div>
  </el-dialog>
  <el-dialog v-model="visible" class="whale-validation-dialog" width="min(1060px,96vw)" append-to-body align-center>
    <template #header><div class="validation-title">巨鲸仓位数据验证 <span>Snapshot Validation</span></div></template>
    <div class="validation-body">
      <div class="validation-status-pane">
      <div class="disclaimer-top">{{job?.mode==='deep'?'深度验证：动态筛选榜单账户价值 ≥100 万美元、周成交额 >0 的账户，按价值降序最多取 1,000 个。':'普通验证：扫描现有候选池内最多 200 个账户。'}} 仅统计所选合约市场，不代表全平台所有巨鲸；各账户采样时间不同。</div>
      <p v-if="error" class="validation-error">{{error}} <button v-if="job" @click="poll(job.id,generation)">重新读取</button></p>
      <p v-if="busy">正在创建验证任务…</p>
      <template v-if="job">
        <p v-if="job.mode==='deep'">符合条件 {{job.eligible}} 个 · 本次扫描 {{job.total}} 个</p>
        <div class="contract-info"><b>{{whaleAssetLabel(job.coin)}}</b><span>{{market}}</span></div>
        <section class="progress-section" aria-label="验证进度">
          <div class="progress-header"><span class="progress-status"><i :class="{running:job.status==='running'}"></i>{{statusLabel}}</span><span class="progress-total">{{job.success+job.failed}} / {{job.total}}</span></div>
          <div class="progress-stats"><span class="long-text">成功 {{job.success}}</span><span class="short-text">失败 {{job.failed}}</span><span>未扫描 {{job.total-job.success-job.failed}}</span></div>
          <div class="progress-bar" role="progressbar" :aria-valuenow="progress" :aria-valuemin="0" :aria-valuemax="100"><div :style="{width:progress+'%'}"></div></div>
          <p class="sample-time">采样区间：{{time(job.startedAt)}} — {{job.finishedAt?time(job.finishedAt):'进行中'}}<small>完成结果复用 10 分钟</small></p>
        </section>
        <p v-if="job.error" class="validation-error">{{job.error}}</p>
        <div class="position-section"><button type="button" class="position-card long" :class="{selected:positionSide==='long'}" :aria-pressed="positionSide==='long'" @click="toggleSide('long')"><span>多仓价值</span><strong>{{formatUsd(job.longUsd)}}</strong><small>{{job.longCount}} 个账户</small></button><button type="button" class="position-card short" :class="{selected:positionSide==='short'}" :aria-pressed="positionSide==='short'" @click="toggleSide('short')"><span>空仓价值</span><strong>{{formatUsd(job.shortUsd)}}</strong><small>{{job.shortCount}} 个账户</small></button></div>
        <div class="result-status" :class="{incomplete:job.status!=='complete'}">{{direction}}<small v-if="job.status!=='complete'">当前成功样本 {{job.success}} 个，结果不完整</small></div>
      </template>
      <p v-if="job" class="disclaimer-bottom">按持仓名义金额比较，不是对价格涨跌的预测；失败及未扫描账户不计为零仓位。</p>
      </div>
        <section class="validation-rows">
          <div class="list-heading">
            <b>匹配仓位 <span>{{sortedPositions.length}}</span></b>
            <div class="position-sort" role="group" aria-label="排序字段"><button v-for="option in sortOptions" :key="option.key" type="button" :class="{active:sortKey===option.key}" :aria-pressed="sortKey===option.key" :title="option.key==='openTime'?'仅按可确认的开仓时间排序，未知时间排在最后':option.key==='unrealizedPnl'?'当前仓位浮动盈亏':''" @click="sortKey=option.key">{{option.label}}</button></div>
            <div class="position-sort sort-direction" role="group" aria-label="排序方向"><button type="button" :class="{active:ascending}" :aria-pressed="ascending" @click="ascending=true">升序 ↑</button><button type="button" :class="{active:!ascending}" :aria-pressed="!ascending" @click="ascending=false">降序 ↓</button></div>
          </div>
          <div class="position-scroll">
          <p v-if="!sortedPositions.length" class="position-empty">{{job?.status==='running'?'正在扫描，匹配到的仓位将在这里展示':'暂无匹配仓位'}}</p>
          <template v-if="job">
          <article v-for="row in sortedPositions.slice(0,visibleCount)" :key="row.address+row.side" class="validation-position">
            <button class="position-toggle" :aria-expanded="expanded===row.address+row.side" @click="togglePosition(row)">
              <div class="position-identity"><b>{{row.name}}</b><small>开仓时间 {{openTimeLabel(row.openTime)}}</small></div>
              <div class="position-amount"><div class="position-price-line"><b :class="row.side==='long'?'long-text':'short-text'">{{row.side==='long'?'做多':'做空'}} {{formatUsd(row.usd)}}</b><span>均价 {{price(row.entryPx)}}</span></div><small class="detail-toggle-label">{{expanded===row.address+row.side?'收起详情':'仓位详情'}}<svg viewBox="0 0 20 20" :class="{rotated:expanded===row.address+row.side}" aria-hidden="true"><path d="m5 7 5 5 5-5"/></svg></small></div>
            </button>
            <div v-if="expanded===row.address+row.side" class="position-detail">
              <span v-if="timingState[job.id+row.address+row.side]==='loading'">开仓时间查询中…</span>
              <div class="detail-address">{{row.address}}</div>
              <dl><div><dt>合约</dt><dd>{{whaleAssetLabel(job.coin)}}</dd></div><div><dt>持仓数量</dt><dd>{{row.size.toLocaleString('en-US',{maximumFractionDigits:10})}}</dd></div><div><dt>开仓均价</dt><dd>{{price(row.entryPx)}}</dd></div><div><dt>名义仓位价值</dt><dd>{{formatUsd(row.usd)}}</dd></div><div><dt>浮动盈亏</dt><dd :class="row.unrealizedPnl==null?'':row.unrealizedPnl>=0?'long-text':'short-text'">{{amount(row.unrealizedPnl)}}</dd></div><div><dt>保证金收益率</dt><dd>{{row.returnOnEquity==null?'—':(row.returnOnEquity*100).toFixed(2)+'%'}}</dd></div><div><dt>杠杆 / 模式</dt><dd>{{row.leverage==null?'—':row.leverage+'×'}} · {{row.leverageType==='cross'?'全仓':row.leverageType==='isolated'?'逐仓':'未知'}}</dd></div><div><dt>占用保证金</dt><dd>{{amount(row.marginUsed)}}</dd></div><div><dt>强平价格</dt><dd>{{price(row.liquidationPx)}}</dd></div><div><dt>采样时间</dt><dd>{{time(row.observedAt)}}</dd></div></dl>
            </div>
          </article>
          <button v-if="sortedPositions.length>visibleCount" type="button" class="validation-trigger" @click="visibleCount+=50">显示更多（已显示 {{visibleCount}} / {{sortedPositions.length}}）</button>
          </template>
          </div>
        </section>
    </div>
    <template #footer><div class="validation-actions"><button v-if="job?.status==='stopped'" :disabled="busy||!job.canStop" @click="start(job.mode,job.coin,job.id)">{{busy?'启动中…':'启动'}}</button><button v-else class="validation-stop" :disabled="job?.status!=='running'||!job?.canStop||stopping" @click="stop">{{stopping?'停止中…':'停止'}}</button><button @click="minimize">最小化</button></div></template>
  </el-dialog>
  <Teleport to="body"><aside v-if="minimized" class="validation-mini" aria-label="后台数据验证">
    <div><b>{{job?whaleAssetLabel(job.coin):'数据验证'}}</b><button @click="restore">展开 ↗</button></div>
    <p>{{busy?'正在创建任务…':statusLabel}} · {{job?job.success+job.failed:0}} / {{job?.total||0}}</p>
    <div class="progress-bar"><div :style="{width:progress+'%'}"></div></div>
    <p v-if="error" class="validation-error">{{error}}</p>
    <button v-if="job?.status==='running' && job.canStop" :disabled="stopping" @click="stop">{{stopping?'停止中…':'停止任务'}}</button>
    <button v-else-if="job?.status==='stopped' && job.canStop" :disabled="busy" @click="start(job.mode,job.coin,job.id)">{{busy?'启动中…':'启动'}}</button><button v-if="job?.status!=='running'&&!busy" @click="minimized=false">关闭</button>
  </aside></Teleport>
</template>
<style scoped>
.position-card{font:inherit;color:inherit;text-align:left;cursor:pointer;transition:background-color .15s,border-color .15s}
.position-card.long.selected{background:#08251d;border-color:#00a86b}
.position-card.short.selected{background:#301217;border-color:#d94853}
.position-card:focus-visible{outline:2px solid #60a5fa;outline-offset:3px}

.list-heading{flex-wrap:wrap;align-items:center}.list-heading>b{white-space:nowrap}.list-heading .position-sort{display:flex;flex-wrap:wrap;gap:5px;margin:0}.position-sort button{font:inherit;font-size:11px;white-space:nowrap}.position-sort button.active{color:#f5bd45;border-color:#a77b24;background:#f5bd4515}.position-sort button:focus-visible{outline:2px solid #f5bd45;outline-offset:2px}.sort-direction{margin-left:auto!important}

.position-price-line{display:flex;align-items:baseline;justify-content:flex-end;gap:5px;flex-wrap:wrap}.position-price-line span{font-size:12px;color:#8f9bb3}.position-toggle .detail-toggle-label{display:flex;justify-content:flex-end;align-items:center;gap:5px}.detail-toggle-label svg{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;transition:transform .15s}.detail-toggle-label svg.rotated{transform:rotate(180deg)}

.mode-options{display:grid;gap:14px}.mode-options button{display:grid;gap:10px;text-align:left;border:1px solid #334155;border-radius:10px;padding:18px;background:#1a202c;color:#e2e8f0;cursor:pointer}.mode-options span{color:#8f9bb3;line-height:1.6;font-size:12px}.position-sort{display:flex;gap:8px;margin-bottom:8px}.position-sort select,.position-sort button{background:#1a202c;border:1px solid #334155;color:#e2e8f0;border-radius:6px;padding:7px;cursor:pointer}

.validation-trigger{border:1px solid var(--border);border-radius:8px;padding:7px 12px;background:var(--panel-2);color:var(--text);cursor:pointer;white-space:nowrap}.validation-trigger:disabled{opacity:.45;cursor:default}
.validation-title{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:18px;font-weight:700;color:#e2e8f0}.validation-title span{font-size:12px;font-weight:400;color:#8f9bb3}
.validation-body{display:flex;flex-direction:column;gap:20px;padding:20px 24px;max-height:72vh;max-height:72dvh;overflow:auto;color:#8f9bb3;font-size:13px}.validation-body *{box-sizing:border-box}.validation-body p{margin:0;line-height:1.6}.disclaimer-top{font-size:12px;line-height:1.7;background:#0b0e14;padding:12px 16px;border-radius:8px;border-left:3px solid #3b82f6}.contract-info{display:flex;justify-content:space-between;gap:12px;border-bottom:1px dashed #2a2f3e;padding-bottom:12px}.contract-info b{font-size:16px;color:#e2e8f0}.contract-info span,.progress-total{font-family:Consolas,monospace}
.progress-section{display:flex;flex-direction:column;gap:12px;border:1px solid #2a2f3e;background:#1a202c;border-radius:8px;padding:16px}.progress-header,.progress-stats{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}.progress-status{display:flex;align-items:center;gap:7px;color:#60a5fa}.progress-status i{width:8px;height:8px;border-radius:50%;background:currentColor}.progress-status i.running{animation:validation-pulse 1.5s infinite}.progress-stats{font-size:12px}.progress-bar{height:6px;border-radius:4px;overflow:hidden;background:#0b0e14}.progress-bar>div{height:100%;background:linear-gradient(90deg,#3b82f6,#60a5fa);transition:width .3s}.sample-time{font-size:12px}.sample-time small{display:block;color:#748097;margin-top:4px}
.position-section{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.position-card{background:#1a202c;border:1px solid #2a2f3e;border-radius:8px;padding:16px;display:flex;flex-direction:column;gap:8px;min-width:0}.position-card.long{border-top:3px solid #00e676}.position-card.short{border-top:3px solid #ff4d4d}.position-card strong{font:700 20px Consolas,monospace;color:#e2e8f0;overflow-wrap:anywhere}.position-card small{font-size:12px}.long-text{color:#00e676!important}.short-text,.validation-error{color:#ff4d4d!important}.result-status{text-align:center;background:#f59e0b15;border:1px solid #f59e0b50;color:#f59e0b;border-radius:8px;padding:12px;font-weight:600}.result-status small{display:block;font-weight:400;margin-top:6px}.result-status.incomplete{background:#8f9bb315;border-color:#8f9bb340;color:#8f9bb3}.disclaimer-bottom{border-top:1px solid #2a2f3e;padding-top:16px;font-size:11px;color:#748097}
.validation-rows{display:flex;flex-direction:column;gap:10px}.list-heading{display:flex;justify-content:space-between;gap:8px}.list-heading b{color:#e2e8f0}.list-heading span{color:#748097;margin-left:6px}.validation-position{border:1px solid #2a2f3e;border-radius:8px;overflow:hidden;background:#1a202c}.position-toggle{display:flex;justify-content:space-between;gap:10px;width:100%;padding:14px;border:0;background:transparent;color:#e2e8f0;cursor:pointer;text-align:left;font:inherit}.position-toggle:hover{background:#242c3d}.position-toggle:focus-visible{outline:2px solid #60a5fa;outline-offset:-2px}.position-identity{min-width:0}.position-identity b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}.position-toggle small{display:block;margin-top:5px;color:#8f9bb3;font-size:11px}.position-amount{text-align:right;flex-shrink:0}.position-detail{padding:0 14px 14px;border-top:1px solid #2a2f3e}.detail-address{font:11px Consolas,monospace;overflow-wrap:anywhere;padding-top:12px}.position-detail dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:16px 0}.position-detail dt{font-size:11px;margin-bottom:5px}.position-detail dd{margin:0;color:#e2e8f0;overflow-wrap:anywhere}.position-detail p{font-size:11px;color:#748097}.validation-body::-webkit-scrollbar{width:6px}.validation-body::-webkit-scrollbar-thumb{background:#2a2f3e;border-radius:4px}@keyframes validation-pulse{50%{opacity:.4}}@media(prefers-reduced-motion:reduce){.progress-status i.running{animation:none}.progress-bar>div{transition:none}}@media(max-width:600px){.validation-body{padding:16px;gap:16px}.validation-title{font-size:16px}.validation-title span{display:none}.position-card{padding:12px}.position-card strong{font-size:18px}.position-identity b{max-width:140px}.position-toggle{padding:12px}.position-amount{font-size:12px}}
.validation-body{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.12fr);height:min(660px,calc(90dvh - 150px));max-height:none;overflow:hidden;padding:0;gap:0}.validation-status-pane{display:flex;flex-direction:column;gap:18px;overflow-y:auto;padding:22px;min-height:0}.validation-rows{min-height:0;overflow-y:auto;padding:22px;border-left:1px solid #2a2f3e}.validation-position{flex-shrink:0}.position-empty{margin:auto!important;text-align:center;color:#748097}.list-heading{position:sticky;top:-22px;background:#131823;padding:12px 0;z-index:1}.validation-actions{display:flex;justify-content:flex-end;gap:10px}.validation-actions button,.validation-mini button{border:1px solid #334155;border-radius:7px;padding:8px 16px;color:#e2e8f0;background:#242c3d;cursor:pointer}.validation-actions button:disabled,.validation-mini button:disabled{opacity:.45;cursor:default}.validation-actions .validation-stop{color:#ff7878}.validation-mini{position:fixed;right:20px;top:20px;z-index:3000;width:min(300px,calc(100vw - 32px));padding:16px;border:1px solid #334155;border-radius:12px;background:#131823;color:#e2e8f0;box-shadow:0 12px 40px #0008;font-size:13px}.validation-mini>div:first-child{display:flex;align-items:center;justify-content:space-between;gap:8px}.validation-mini p{color:#8f9bb3;font-size:12px}.validation-mini button{padding:5px 10px}.validation-mini>.progress-bar{margin-bottom:12px}@media(max-width:700px){.validation-body{grid-template-columns:1fr;grid-template-rows:45% 55%;height:calc(90dvh - 140px)}.validation-status-pane,.validation-rows{padding:16px}.validation-rows{border-left:0;border-top:1px solid #2a2f3e}.list-heading{top:-16px}}
.validation-rows{overflow:hidden;gap:12px}.validation-rows .list-heading{position:static;flex-shrink:0;padding:0 0 12px;border-bottom:1px solid #2a2f3e}.position-scroll{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:10px}.position-scroll>.position-empty{padding:24px 8px}
</style>
<style>
.el-dialog.whale-validation-dialog{padding:0;background:#131823;border:1px solid #2a2f3e;border-radius:12px;overflow:hidden;box-shadow:0 20px 50px #0008}.whale-validation-dialog .el-dialog__header{padding:20px 44px 20px 24px;margin:0;border-bottom:1px solid #2a2f3e}.whale-validation-dialog .el-dialog__headerbtn{top:10px}.whale-validation-dialog .el-dialog__body{padding:0}.whale-validation-dialog .el-dialog__footer{padding:14px 22px;border-top:1px solid #2a2f3e}
</style>
