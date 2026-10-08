<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import ContractLogo from './ContractLogo.vue';
import { http } from '@/api';
import { ElMessage } from 'element-plus';
type TrendRow={currentPrice?:number;priceAsOf?:number;priceStale?:boolean;adjustmentNote?:string;symbol:string;name:string;assetType:string;direction:'UP'|'DOWN'|'NEUTRAL'|'INSUFFICIENT'|'TURN_UP'|'TURN_DOWN';days:number;partial?:boolean;recentDays?:number;monthDays?:number;monthChange?:number;change?:number;recentChange?:number;r2?:number;efficiency?:number;score?:number;streak?:number;maxDrawdown?:number;maxRebound?:number;points?:[number,number][];asOf:number|null;latestBarAt:number|null;stale:boolean;reason?:string;error?:string};
type Snapshot={watched:TrendRow[];focused:TrendRow|null;catalog:{symbol:string;name:string}[];rows:TrendRow[];count:number;page:number;pages:number;days:number;running:boolean;done:number;total:number;coverage:{total:number;loaded:number;fresh:number;insufficient:number};error:string;source:string};
const props=defineProps<{active:boolean}>();
const days=ref(90),direction=ref('ALL'),search=ref(''),page=ref(1);
const WATCH_KEY='whale-tracker-long-trend-watch-v1';
const watchedSymbols=ref<string[]>((()=>{try{const stored=JSON.parse(localStorage.getItem(WATCH_KEY)||'null');if(Array.isArray(stored))return [...new Set(stored.filter((s):s is string=>typeof s==='string'&&/^[A-Z0-9]{3,30}$/.test(s)))].slice(0,30);}catch{}return ['WDCUSDT','KUAISHOUUSDT','HK1810USDT'];})());
function toggleWatch(symbol:string){
  if(watchedSymbols.value.includes(symbol))watchedSymbols.value=watchedSymbols.value.filter(item=>item!==symbol);
  else {if(watchedSymbols.value.length>=30){ElMessage.warning('最多关注 30 个合约');return;}watchedSymbols.value=[...watchedSymbols.value,symbol];}
  try{localStorage.setItem(WATCH_KEY,JSON.stringify(watchedSymbols.value));}catch{}
}
const watchRows=ref<TrendRow[]>([]);
let displayedDays=90;
const sort=ref<'score'|'change'|'monthChange'>('score'),order=ref<'asc'|'desc'>('desc');
function sortBy(key:'change'|'monthChange'){
  if(sort.value===key)order.value=order.value==='desc'?'asc':'desc';else{sort.value=key;order.value='desc';}
}
const cardPage=ref(1);
const hoverIndex=ref<number|null>(null);
const data=ref<Snapshot|null>(null),error=ref(''),loading=ref(false),selected=ref<TrendRow|null>(null);
let selectedSymbol='';
let timer:ReturnType<typeof setTimeout>|undefined,controller:AbortController|undefined,sequence=0;
function cancel(){sequence++;controller?.abort();clearTimeout(timer);loading.value=false;}
async function load(){
  if(!props.active||document.hidden)return;
  clearTimeout(timer);controller?.abort();const id=++sequence;controller=new AbortController();loading.value=true;
  try {
    const response=await http.get<Snapshot>('/tradfi/radar/long-trends',{params:{sort:sort.value,order:order.value,days:days.value,direction:direction.value,assetType:'TRADFI',watch:watchedSymbols.value.join(','),focus:selectedSymbol,search:search.value,page:page.value},signal:controller.signal,timeout:15000});
    if(id!==sequence)return;
    data.value=response.data;watchRows.value=response.data.watched;error.value='';
    selected.value=response.data.focused||response.data.watched.find(row=>row.symbol===selectedSymbol)||response.data.watched[0]||response.data.rows[0]||null;
    cardPage.value=Math.min(cardPage.value,Math.max(1,Math.ceil(response.data.watched.length/6)));
    selectedSymbol=selected.value?.symbol||'';
    hoverIndex.value=null;
  }catch{if(id===sequence)error.value='读取失败，保留最近结果，稍后重试。';}
  finally{if(id===sequence){loading.value=false;timer=setTimeout(load,data.value?.running?3000:15000);}}
}
watch([days,direction,search,sort,order],()=>{page.value=1;});
watch(()=>[props.active,days.value,direction.value,search.value,page.value,sort.value,order.value,watchedSymbols.value.join(',')],()=>{
  cancel();data.value=null;hoverIndex.value=null;error.value='';
  if(displayedDays!==days.value){selected.value=null;watchRows.value=[];displayedDays=days.value;}
  if(!props.active)selected.value=null;
  if(props.active)timer=setTimeout(load,250);
},{immediate:true});
function visibility(){if(document.hidden)cancel();else if(props.active)void load();}
onMounted(()=>document.addEventListener('visibilitychange',visibility));
onUnmounted(()=>{cancel();document.removeEventListener('visibilitychange',visibility);});
const pct=(value?:number)=>value==null?'—':`${value>0?'+':''}${value.toFixed(2)}%`;
const label=(row:TrendRow)=>({UP:'持续走强',DOWN:'持续走弱',NEUTRAL:'震荡 / 趋势未确认',INSUFFICIENT:'数据不足',TURN_UP:'近期转强',TURN_DOWN:'近期转弱'}[row.direction]);
const date=(time:number)=>new Date(time).toISOString().slice(0,10);
const rows=computed(()=>data.value?.rows||[]);
const cardPages=computed(()=>Math.max(1,Math.ceil(watchRows.value.length/6)));
const cards=computed(()=>watchRows.value.slice((cardPage.value-1)*6,cardPage.value*6));
const selectedPrices=computed(()=>selected.value?.points||[]);
const price=(value?:number)=>value==null?'—':value.toLocaleString('en-US',{maximumFractionDigits:value>=1?3:8});
const color=(value?:number)=>value==null?'neutral':value>0?'positive':value<0?'negative':'neutral';
function selectRow(row:TrendRow){selected.value=row;selectedSymbol=row.symbol;hoverIndex.value=null;const index=watchRows.value.findIndex(item=>item.symbol===row.symbol);if(index>=0)cardPage.value=Math.floor(index/6)+1;}
const chartPoints=computed(()=>{
  const points=selectedPrices.value;if(!points.length)return [];
  const values=points.map(point=>point[1]),low=Math.min(...values),high=Math.max(...values),span=high-low||Math.max(high*.001,1);
  return points.map((point,index)=>({x:12+index*776/Math.max(1,points.length-1),y:12+(high-point[1])/span*176,time:point[0],price:point[1]}));
});
const chartPath=computed(()=>chartPoints.value.map((point,index)=>`${index?'L':'M'} ${point.x} ${point.y}`).join(' '));
const hoveredPoint=computed(()=>hoverIndex.value==null?null:chartPoints.value[hoverIndex.value]);
function moveChart(event:PointerEvent){
  const rect=(event.currentTarget as SVGSVGElement).getBoundingClientRect();
  const ratio=Math.max(0,Math.min(1,((event.clientX-rect.left)/rect.width*800-12)/776));
  hoverIndex.value=Math.round(ratio*Math.max(0,chartPoints.value.length-1));
}
const emptyMessage=computed(()=>loading.value?'正在读取长期趋势…':data.value?.running?'正在扫描日线，符合条件的合约会陆续出现。':error.value||data.value?.error?'数据暂未就绪，请稍后重试。':'当前筛选下没有符合条件的合约。');
</script>
<template>
<section class="long-trends">
  <section class="toolbar" aria-label="长期趋势筛选">
    <span class="scope-label">传统金融 USDT 永续合约</span>
    <div class="periods" aria-label="长期趋势周期"><button v-for="period in [30,60,90]" :key="period" :class="{active:days===period}" @click="days=period">{{period}} 天</button></div>
    <div class="periods" aria-label="长期趋势方向"><button v-for="item in [{id:'ALL',label:'全部合约'},{id:'UP',label:'持续走强'},{id:'DOWN',label:'持续走弱'},{id:'TURN_UP',label:'近期转强'},{id:'TURN_DOWN',label:'近期转弱'},{id:'NEUTRAL',label:'震荡'}]" :key="item.id" :class="{active:direction===item.id}" @click="direction=item.id">{{item.label}}</button></div>
    <label class="search"><span>⌕</span><input v-model="search" type="search" aria-label="搜索长期趋势合约" placeholder="搜索代码或名称"></label><button class="refresh" :disabled="loading" @click="load">{{loading?'读取中…':'刷新结果'}}</button>
    <button class="refresh" :disabled="sort==='score' && order==='desc'" @click="sort='score';order='desc';page=1">重置排序</button>
  </section>
  <p v-if="data" class="progress" role="status">已缓存 {{data.coverage.loaded}} / {{data.coverage.total}} 个合约 · 当日已更新 {{data.coverage.fresh}} 个 · 历史不足 {{data.coverage.insufficient}} 个<span v-if="data.running"> · 扫描中 {{data.done}} / {{data.total||'…'}}</span></p>
  <p v-if="error||data?.error" class="error" role="alert">{{error||data?.error}}</p>
  <section class="watch-layout">
    <section class="market-panel watch-panel">
      <header class="market-title"><div><h2>我的关注</h2><p>{{watchedSymbols.length}} 个传统金融标的 · 不受下方筛选影响</p></div></header>
      <div class="watch-cards"><article v-for="row in cards" :key="row.symbol" class="watch-card" :class="{chosen:selected?.symbol===row.symbol}">
        <button class="watch-select" :aria-label="`查看 ${row.symbol} 长期走势`" @click="selectRow(row)">
          <span class="watch-card-top"><ContractLogo :symbol="row.symbol" /><span class="watch-name">{{row.symbol.replace(/USDT$/,'')}}<small>{{row.name}} · {{row.assetType==='TRADFI'?'传统金融':'USDT 永续'}}</small></span></span>
          <span class="watch-price">{{price(row.currentPrice)}}<small>USDT · 现价</small><small v-if="row.priceStale" class="error">{{row.currentPrice==null?'现价待更新':'缓存现价'}}</small></span>
          <b class="watch-change" :class="color(row.change)">{{pct(row.change)}}</b><span class="watch-card-bottom">{{row.days}} / {{days}} 天 · {{label(row)}}<br>趋势分 {{row.score??'—'}}</span><small v-if="row.stale" class="error">{{row.error||'尚未更新，旧结果'}}</small>
          <small v-if="row.reason && row.reason!==row.error" class="error">{{row.reason}}</small>
        </button>
        <button class="follow-icon active" :aria-label="`取消关注 ${row.symbol}`" @click="toggleWatch(row.symbol)">★</button>
      </article><div v-if="!cards.length" class="watch-empty">{{loading?'正在读取关注合约…':'可点击下方列表的星标添加关注'}}</div></div>
      <div v-if="cardPages>1" class="pagination"><button :disabled="cardPage<=1" @click="cardPage--">上一组</button><span>{{cardPage}} / {{cardPages}}</span><button :disabled="cardPage>=cardPages" @click="cardPage++">下一组</button></div>
    </section>
    <section class="market-panel selected-panel">
      <header class="selected-summary">
        <div class="selected-name"><ContractLogo :symbol="selected?.symbol||''" large /><span><b>{{selected?.name||selected?.symbol||'选择趋势标的'}}</b><small>{{selected?.symbol||'—'}} · {{selected?label(selected):'点击卡片或列表查看'}}</small></span></div>
        <div class="selected-metrics"><div><span>合约现价</span><b>{{price(selected?.currentPrice)}}</b><small v-if="selected?.priceStale" class="error">{{selected.currentPrice==null?'现价待更新':'缓存现价'}}</small></div><div><span>合约最新日收盘价</span><b>{{price(selectedPrices.at(-1)?.[1])}}</b></div><div><span>实际 {{selected?.days??0}} 天涨跌</span><b :class="color(selected?.change)">{{pct(selected?.change)}}</b></div><div><span>近 {{selected?.recentDays??20}} 天</span><b :class="color(selected?.recentChange)">{{pct(selected?.recentChange)}}</b></div><div><span>近 {{selected?.monthDays??30}} 天</span><b :class="color(selected?.monthChange)">{{pct(selected?.monthChange)}}</b></div><div><span>趋势分</span><b>{{selected?.score??'—'}}</b></div><div><span>最大回撤</span><b>{{selected?.maxDrawdown==null?'—':`${selected.maxDrawdown.toFixed(2)}%`}}</b></div></div>
      </header>
      <p v-if="selected?.adjustmentNote" class="adjustment-note">{{selected.adjustmentNote}}</p>
      <div class="chart-heading"><div><b>价格走势</b><span>日线 · {{selectedPrices.length}} 个收盘价 · UTC</span></div><div class="periods chart-periods" aria-label="走势图周期"><button v-for="period in [30,60,90]" :key="period" :class="{active:days===period}" @click="days=period">{{period}} 天</button></div></div>
      <div class="chart-wrap"><div v-if="!chartPoints.length" class="chart-state">{{emptyMessage}}</div><template v-else>
        <div v-if="selected?.stale" class="chart-refresh-note">{{selected.error||'尚未更新'}} · 保留最近可用走势</div>
        <svg class="price-chart" viewBox="0 0 800 220" preserveAspectRatio="none" role="img" :aria-label="`${selected?.symbol} ${days} 天日线价格走势`" @pointermove="moveChart" @pointerleave="hoverIndex=null">
          <line v-for="y in [12,56,100,144,188]" :key="y" x1="12" :y1="y" x2="788" :y2="y" class="chart-gridline"/>
          <path v-if="chartPoints.length>1" :d="`${chartPath} L 788 200 L 12 200 Z`" class="chart-area"/><path :d="chartPath" class="chart-line"/>
          <line v-if="hoveredPoint" :x1="hoveredPoint.x" y1="8" :x2="hoveredPoint.x" y2="200" class="chart-crosshair"/><circle v-if="hoveredPoint" :cx="hoveredPoint.x" :cy="hoveredPoint.y" r="4" class="chart-point"/>
        </svg>
        <div v-if="hoveredPoint" class="chart-tooltip" :style="{left:`${Math.max(16,Math.min(84,hoveredPoint.x/8))}%`,top:'15%'}"><b>{{price(hoveredPoint.price)}} USDT</b><span>{{date(hoveredPoint.time)}} · 日收盘价（UTC）</span></div>
        <div class="chart-axis"><span>{{date(selectedPrices[0]![0])}}</span><span>{{date(selectedPrices.at(-1)![0])}}</span></div>
      </template></div>
    </section>
  </section>
  <section class="market-panel result-panel">
    <header class="market-title"><div><h2>全部传统金融合约</h2><p>最近 {{days}} 天 · {{data?.count||0}} 个标的 · 点击合约联动走势图</p></div><span class="source">Binance USDⓈ-M Futures · 已收盘日线</span></header>
    <div class="table-wrap"><table><thead><tr><th>合约</th><th>类别</th><th>合约现价</th><th>合约日收盘价</th><th :aria-sort="sort==='change'?(order==='asc'?'ascending':'descending'):'none'"><button class="sort-heading" @click="sortBy('change')">区间涨跌 {{sort==='change'?(order==='asc'?'↑':'↓'):'↕'}}</button></th><th>实际 / 目标天数</th><th :aria-sort="sort==='monthChange'?(order==='asc'?'ascending':'descending'):'none'"><button class="sort-heading" @click="sortBy('monthChange')">近 30 天 {{sort==='monthChange'?(order==='asc'?'↑':'↓'):'↕'}}</button></th><th>趋势分</th><th>趋势状态</th><th>统计截至（UTC）</th><th>关注</th></tr></thead><tbody>
      <tr v-for="row in rows" :key="row.symbol" :class="{chosen:selected?.symbol===row.symbol}" @click="selectRow(row)">
        <td><div class="contract-cell"><ContractLogo :symbol="row.symbol" /><span><button class="contract-link" :aria-label="`查看 ${row.symbol} 图表`" @click.stop="selectRow(row)">{{row.symbol.replace(/USDT$/,'')}}</button><small>{{row.name}}</small></span></div></td>
        <td><span class="type-label" :class="row.assetType==='TRADFI'?'type-tradfi':'type-crypto'">{{row.assetType==='TRADFI'?'传统金融':'虚拟币'}}</span></td><td class="price-cell">{{price(row.currentPrice)}}<small v-if="row.priceStale" class="error">{{row.currentPrice==null?'待更新':'缓存现价'}}</small></td><td class="price-cell">{{price(row.points?.at(-1)?.[1])}}</td><td :class="color(row.change)">{{pct(row.change)}}</td><td>{{row.days}} / {{days}} 天<small v-if="row.partial">历史较短</small></td><td :class="color(row.monthChange)">{{pct(row.monthChange)}}<small v-if="row.monthDays && row.monthDays<30">实际 {{row.monthDays}} 天</small></td><td>{{row.score??'—'}}</td><td><span :class="row.direction==='UP'?'positive':row.direction==='DOWN'?'negative':'neutral'">{{label(row)}}</span><small v-if="row.stale" class="error">{{row.error||'尚未更新'}}</small><small v-if="row.reason">{{row.reason}}</small></td><td>{{row.latestBarAt?date(row.latestBarAt):'—'}}</td><td><button class="follow-icon" :class="{active:watchedSymbols.includes(row.symbol)}" :aria-label="`${watchedSymbols.includes(row.symbol)?'取消关注':'关注'} ${row.symbol}`" @click.stop="toggleWatch(row.symbol)">★</button></td>
      </tr><tr v-if="!rows.length"><td colspan="11" class="empty-row">{{emptyMessage}}</td></tr>
    </tbody></table></div>
    <div v-if="data" class="pagination list-pagination"><button :disabled="data.page<=1" @click="page=data.page-1">上一页</button><span>{{data.page}} / {{data.pages}} · 每页 20 个</span><button :disabled="data.page>=data.pages" @click="page=data.page+1">下一页</button></div>
    <footer class="market-foot"><span>趋势使用已收盘日线（UTC）；现价约每 15 秒刷新，失败显示缓存状态。</span><span>允许中途回调，不要求每日同向；卡片、列表与图表使用相同周期。</span></footer>
  </section>
  <details class="rules"><summary>筛选规则与数据口径</summary><p>只采集币安可交易的传统金融 USDT 永续合约。默认展示全部合约。目标 {{days}} 天，历史较短时按实际连续区间计算并标注，不补齐或年化；不足 20 天、日线缺口或未更新时不判定趋势。持续走强 / 走弱要求区间涨跌绝对值 ≥ 5%、对数价格拟合 R² ≥ 0.35、方向效率 ≥ 0.10、近 20 天及近 30 天同向，且前中后三段的收盘高低点依次抬高 / 降低；区间与近 20 天反向且各变化至少 5% 时标记近期转向，其余为震荡。趋势分为 R² × 方向效率 × 100，不代表获利概率，短历史与完整周期不宜直接比较。图表采用线性价格坐标，关注列表不受筛选和翻页影响。</p></details>
</section>
</template>
<style scoped src="./RadarBoard.css"></style>
<style scoped>
.long-trends{min-width:0}.adjustment-note{padding:0 14px;color:var(--gold);font-size:11px}.scope-label{color:var(--gold)}.add-select{max-width:240px;height:32px;background:var(--surface);color:var(--text);border:1px solid var(--line);border-radius:6px}.selected-metrics{grid-template-columns:repeat(3,minmax(0,1fr))}.progress,.rules{color:var(--muted);font-size:12px;line-height:1.7}.progress{margin:0 0 12px}.error{color:#f3b77c}.result-panel{margin-top:12px}.rules{margin-top:12px}.rules summary{cursor:pointer}.watch-select{padding-bottom:14px}.watch-card-top{padding-right:0}.watch-change{margin-left:0}.contract-link{border:0;padding:0;background:transparent;color:inherit;font:inherit;font-weight:700;cursor:pointer}.table-wrap td small{display:block;font-size:10px;margin-top:4px}.chart-heading{flex-wrap:wrap}.chart-heading>div:first-child{flex-wrap:wrap}.rules p{max-width:1000px}
</style>
