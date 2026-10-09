<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import CandlestickChart from './CandlestickChart.vue';
import ContractLogo from './ContractLogo.vue';
import ContractDetailLink from './ContractDetailLink.vue';
import { ElMessage } from 'element-plus';
import { scrollRadarToTop } from '@/utils/radarScroll';
import { candlePriceRange } from '@/utils/candleSeries';
import { radarClient, sortRadarRows, type TrendRow } from '@/utils/radarRealtime';
type Snapshot={watched:TrendRow[];focused:TrendRow|null;catalog:{symbol:string;name:string}[];rows:TrendRow[];count:number;page:number;pages:number;days:number;running:boolean;done:number;total:number;coverage:{total:number;loaded:number;fresh:number;insufficient:number};error:string;source:string};
const props=defineProps<{active:boolean}>();
const days=ref(90),direction=ref('ALL'),search=ref(''),page=ref(1);
const assetGroup=ref<TrendRow['assetGroup']|null>(null);
const assetGroups=[{id:'STOCK',label:'股票'},{id:'INDEX_ETF',label:'指数 / ETF'},{id:'METAL_ENERGY',label:'金属 / 能源'}] as const;
function toggleAssetGroup(group:NonNullable<TrendRow['assetGroup']>){assetGroup.value=assetGroup.value===group?null:group;}
function groupLabel(row:TrendRow){return assetGroups.find(group=>group.id===row.assetGroup)?.label||'待识别';}
function marketLabel(row:TrendRow){return ({HK:'港股',CN:'中国个股',CHINA_ADR:'中概股',US:'美股',KR:'韩股'} as Record<string,string>)[row.stockMarket||'']||'';}
import { longTrendWatch as watchedSymbols } from '@/utils/tradfiWatch';
const WATCH_KEY='whale-tracker-long-trend-watch-v1';
function toggleWatch(symbol:string){
  if(watchedSymbols.value.includes(symbol))watchedSymbols.value=watchedSymbols.value.filter(item=>item!==symbol);
  else {if(watchedSymbols.value.length>=30){ElMessage.warning('最多关注 30 个合约');return;}watchedSymbols.value=[...watchedSymbols.value,symbol];}
  try{localStorage.setItem(WATCH_KEY,JSON.stringify(watchedSymbols.value));}catch{}
}
const watchRows=computed(()=>data.value?.watched||[]);
const displayedDays=computed(()=>data.value?.days??days.value);
const sort=ref<'score'|'change'|'monthChange'>('score'),order=ref<'asc'|'desc'>('desc');
function sortBy(key:'change'|'monthChange'){
  if(sort.value===key)order.value=order.value==='desc'?'asc':'desc';else{sort.value=key;order.value='desc';}
}
const cardPage=ref(1);
const loading=radarClient.loading,error=radarClient.error;
const selectedSymbol=ref('');
const allRows=computed<TrendRow[]>(()=> (radarClient.state.value?.long.rows||[]).map(record=>({
  ...record,...(record.frames[String(days.value)]||{direction:'INSUFFICIENT',days:0,reason:record.error}),
  periodChanges:Object.fromEntries(([30,60,90] as const).map(period=>{const frame=record.frames[String(period)];return [period,frame?.days===period?frame.change:undefined];})),
  priceStale:record.priceStale||!radarClient.connected.value,
  points:(record.points||[]).slice(-(days.value+1)),
} as TrendRow)));
const data=computed<Snapshot|null>(()=>{
  const frame=radarClient.state.value;if(!frame)return null;
  const query=search.value.trim().toLowerCase();
  const filtered=allRows.value.filter(row=>!row.liquidity?.filtered&&(!assetGroup.value||row.assetGroup===assetGroup.value)&&(!query||`${row.symbol} ${row.name}`.toLowerCase().includes(query))
    &&(direction.value==='ALL'||row.direction===direction.value));
  const sorted=sortRadarRows(filtered,row=>row[sort.value],order.value);
  const pages=Math.max(1,Math.ceil(sorted.length/20)),current=Math.min(page.value,pages);
  const bySymbol=new Map(allRows.value.map(row=>[row.symbol,row]));
  const watched=watchedSymbols.value.map(symbol=>bySymbol.get(symbol)||{symbol,name:symbol,assetType:'TRADFI',direction:'INSUFFICIENT',days:0,asOf:null,latestBarAt:null,stale:true,reason:'暂无可用日线',points:[]} as TrendRow);
  return {watched,focused:bySymbol.get(selectedSymbol.value)||null,catalog:allRows.value.map(({symbol,name})=>({symbol,name})),
    rows:sorted.slice((current-1)*20,current*20),count:sorted.length,page:current,pages,days:days.value,
    running:frame.long.running,done:0,total:allRows.value.length,coverage:{total:allRows.value.length,loaded:allRows.value.length,fresh:0,insufficient:0},error:frame.long.error,source:'Binance USDⓈ-M Futures'};
});
const selected=computed(()=>allRows.value.find(row=>row.symbol===selectedSymbol.value)||watchRows.value[0]||data.value?.rows[0]||null);
watch([days,direction,search,sort,order,assetGroup],()=>{page.value=1;});
watch(()=>data.value?.pages,count=>{if(count)page.value=Math.min(page.value,count);});
watch(()=>watchedSymbols.value.length,count=>{cardPage.value=Math.min(cardPage.value,Math.max(1,Math.ceil(count/6)));});
const pct=(value?:number)=>value==null?'—':`${value>0?'+':''}${value.toFixed(2)}%`;
const label=(row:TrendRow)=>({UP:'持续走强',DOWN:'持续走弱',NEUTRAL:'震荡 / 趋势未确认',INSUFFICIENT:'数据不足',TURN_UP:'近期转强',TURN_DOWN:'近期转弱'}[row.direction]);
const date=(time:number)=>new Date(time).toISOString().slice(0,10);
const rows=computed(()=>data.value?.rows||[]);
const cardPages=computed(()=>Math.max(1,Math.ceil(watchRows.value.length/6)));
const cards=computed(()=>watchRows.value.slice((cardPage.value-1)*6,cardPage.value*6));
const selectedPrices=computed(()=>selected.value?.points||[]);
const price=(value?:number)=>value==null?'—':value.toLocaleString('en-US',{maximumFractionDigits:value>=1?3:8});
const color=(value?:number)=>value==null?'neutral':value>0?'positive':value<0?'negative':'neutral';
function selectRow(row:TrendRow){selectedSymbol.value=row.symbol;const index=watchRows.value.findIndex(item=>item.symbol===row.symbol);if(index>=0)cardPage.value=Math.floor(index/6)+1;}
function selectListRow(row:TrendRow,event:MouseEvent){selectRow(row);scrollRadarToTop(event.currentTarget as Element);}
const dailyChart=computed(()=>selected.value?radarClient.charts.value[`${selected.value.symbol}:1d`]:undefined);
const dailyBars=computed(()=>{
  const end=selected.value?.asOf;
  return (dailyChart.value?.bars||[]).filter(bar=>!end||bar.closeTime<end);
});
const selectedRange=computed(()=>{
  const end=selected.value?.asOf;
  return candlePriceRange(dailyBars.value.filter(bar=>end && bar.openTime>=end-displayedDays.value*86400000));
});
watch(()=>[selected.value?.symbol,props.active,radarClient.state.value?.catalog.length] as const,([symbol,active])=>{
  if(symbol&&active)radarClient.selectChart(symbol,'1d');
},{immediate:true});
const emptyMessage=computed(()=>loading.value?'正在读取长期趋势…':data.value?.running?'正在扫描日线，符合条件的合约会陆续出现。':error.value||data.value?.error?'数据暂未就绪，请稍后重试。':'当前筛选下没有符合条件的合约。');
</script>
<template>
<section class="long-trends">
  <section class="toolbar" aria-label="长期趋势筛选">
    <span class="scope-label">传统金融 USDT 永续合约</span>
    <div class="periods asset-groups" role="group" aria-label="长期趋势资产分类"><button v-for="group in assetGroups" :key="group.id" type="button" :class="{active:assetGroup===group.id}" :aria-pressed="assetGroup===group.id" @click="toggleAssetGroup(group.id)">{{group.label}}</button></div>
    <div class="periods" aria-label="长期趋势周期"><button v-for="period in [30,60,90]" :key="period" :class="{active:days===period}" @click="days=period">{{period}} 天</button></div>
    <div class="periods" aria-label="长期趋势方向"><button v-for="item in [{id:'ALL',label:'全部合约'},{id:'UP',label:'持续走强'},{id:'DOWN',label:'持续走弱'},{id:'TURN_UP',label:'近期转强'},{id:'TURN_DOWN',label:'近期转弱'},{id:'NEUTRAL',label:'震荡'}]" :key="item.id" :class="{active:direction===item.id}" @click="direction=item.id">{{item.label}}</button></div>
    <label class="search"><span>⌕</span><input v-model="search" type="search" aria-label="搜索长期趋势合约" placeholder="搜索代码或名称"></label>
    <button type="button" class="refresh" @click="sort='score';order='desc';page=1">重置排序</button>
  </section>
  <p v-if="error||data?.error" class="error" role="alert">{{error||data?.error}}</p>
  <section class="watch-layout">
    <section class="market-panel watch-panel">

      <div class="watch-cards"><article v-for="row in cards" :key="row.symbol" class="watch-card" :class="{chosen:selected?.symbol===row.symbol}">
        <button class="watch-select" :aria-label="`查看 ${row.symbol} 长期走势`" @click="selectRow(row)">
          <span class="watch-card-top"><ContractLogo :symbol="row.symbol" /><span class="watch-name" :title="`${row.symbol} · ${row.name}`">{{row.symbol.replace(/USDT$/,'')}}<small>{{row.name}} · {{row.assetType==='TRADFI'?'传统金融':'USDT 永续'}}</small></span></span>
          <span class="watch-price"><span class="watch-price-value">{{price(row.currentPrice)}}</span><small>USDT · 现价</small><small v-if="row.priceStale" class="error price-warning">{{row.currentPrice==null?'现价待更新':'缓存现价'}}</small></span>
          <b class="watch-change" :class="color(row.change)">{{pct(row.change)}}</b>
          <span class="watch-card-bottom"><span>{{row.days}} / {{displayedDays}} 天</span><b :class="color(row.change)">{{label(row)}}</b></span>
          <span class="watch-trend-score"><span>趋势分</span><b :class="color(row.change)">{{row.score??'—'}}</b></span><small v-if="row.stale" class="error">{{row.error||'尚未更新，旧结果'}}</small>
          <small v-if="row.reason && row.reason!==row.error" class="error">{{row.reason}}</small>
        </button>
        <ContractDetailLink class="watch-detail" :symbol="row.symbol" :asset-type="row.assetType" :name="row.name" icon-only />
        <button class="follow-icon active" :aria-label="`取消关注 ${row.symbol}`" @click="toggleWatch(row.symbol)">★</button>
      </article><div v-if="!cards.length" class="watch-empty">{{loading?'正在读取关注合约…':'可点击下方列表的星标添加关注'}}</div></div>
      <div v-if="cardPages>1" class="pagination"><button :disabled="cardPage<=1" @click="cardPage--">上一组</button><span>{{cardPage}} / {{cardPages}}</span><button :disabled="cardPage>=cardPages" @click="cardPage++">下一组</button></div>
    </section>
    <section class="market-panel selected-panel">
      <header class="selected-summary">
        <div class="selected-name"><ContractLogo :symbol="selected?.symbol||''" large /><span><b>{{selected?.name||selected?.symbol||'选择趋势标的'}}</b><small>{{selected?.symbol||'—'}} · {{selected?label(selected):'点击卡片或列表查看'}}</small></span></div>
        <div class="detail-prices"><span>合约现价<b>{{price(selected?.currentPrice)}}</b><small v-if="selected?.priceStale" class="error"> · {{selected.currentPrice==null?'现价待更新':'缓存现价'}}</small></span><span>合约日收盘价<b>{{price(selectedPrices.at(-1)?.[1])}}</b></span></div>
        <div class="selected-metrics">
          <div><span>区间涨跌（{{displayedDays}} 天）</span><b :class="color(selected?.change)">{{pct(selected?.change)}}</b></div>
          <div><span>最大回撤</span><b class="negative">{{selected?.maxDrawdown==null?'—':`${selected.maxDrawdown.toFixed(2)}%`}}</b></div>
          <div><span>实际 / 目标天数</span><b>{{selected?.days??0}} / {{displayedDays}} 天</b></div>
          <div><span>区间最高价</span><b>{{price(selectedRange?.high)}}</b></div><div><span>区间最低价</span><b>{{price(selectedRange?.low)}}</b></div><div><span>趋势分</span><b :class="color(selected?.change)">{{selected?.score??'—'}}</b></div>
        </div>
        <div class="detail-prices recent-performance"><span v-for="period in [30,60,90] as const" :key="period" :title="selected?.periodChanges?.[period]==null?'完整周期日线不足或存在缺口':''">近 {{period}} 天<b :class="color(selected?.periodChanges?.[period])">{{pct(selected?.periodChanges?.[period])}}</b></span></div>
        <p v-if="selected?.adjustmentNote" class="adjustment-note">{{selected.adjustmentNote}}</p>
      </header>
      <div class="chart-heading"><div><b>K 线走势</b><span>日线 · 已收盘 · UTC</span></div><div class="periods chart-periods" aria-label="走势图周期"><button v-for="period in [30,60,90]" :key="period" :class="{active:days===period}" @click="days=period">{{period}} 天</button></div></div>
      <div class="chart-wrap">
        <div v-if="!dailyBars.length" class="chart-state">{{dailyChart?.error||'正在加载日线 K 线…'}}</div>
        <template v-else>
          <div v-if="dailyChart?.stale||selected?.stale" class="chart-refresh-note">{{dailyChart?.error||selected?.error||'缓存日线'}} · 保留最近可用走势</div>
          <CandlestickChart :bars="dailyBars" :symbol="selected?.symbol||''" interval="1d" :visible-count="displayedDays+1" />
        </template>
      </div>
    </section>
  </section>
  <section class="market-panel result-panel">
    <header class="market-title"><div><h2>全部传统金融合约</h2><p>最近 {{displayedDays}} 天 · {{data?.count||0}} 个标的 · 点击合约联动走势图</p></div><span class="source">Binance USDⓈ-M Futures · 已收盘日线</span></header>
    <div class="table-wrap"><table><thead><tr><th>合约</th><th>类别</th><th>合约现价</th><th>合约日收盘价</th><th :aria-sort="sort==='change'?(order==='asc'?'ascending':'descending'):'none'"><button class="sort-heading" @click="sortBy('change')">区间涨跌 {{sort==='change'?(order==='asc'?'↑':'↓'):'↕'}}</button></th><th>实际 / 目标天数</th><th :aria-sort="sort==='monthChange'?(order==='asc'?'ascending':'descending'):'none'"><button class="sort-heading" @click="sortBy('monthChange')">近 30 天 {{sort==='monthChange'?(order==='asc'?'↑':'↓'):'↕'}}</button></th><th>趋势分</th><th>趋势状态</th><th>统计截至（UTC）</th><th class="operation-cell">操作</th></tr></thead><tbody>
      <tr v-for="row in rows" :key="row.symbol" :class="{chosen:selected?.symbol===row.symbol}" @click="selectListRow(row,$event)">
        <td><div class="contract-cell"><ContractLogo :symbol="row.symbol" /><span><button class="contract-link" :aria-label="`查看 ${row.symbol} 图表`" @click.stop="selectRow(row)">{{row.symbol.replace(/USDT$/,'')}}</button><small>{{row.name}}</small></span></div></td>
        <td><span class="type-label" :class="row.assetType==='TRADFI'?'type-tradfi':'type-crypto'">{{groupLabel(row)}}</span><small v-if="marketLabel(row)">{{marketLabel(row)}}</small></td><td class="price-cell">{{price(row.currentPrice)}}<small v-if="row.priceStale" class="error">{{row.currentPrice==null?'待更新':'缓存现价'}}</small></td><td class="price-cell">{{price(row.points?.at(-1)?.[1])}}</td><td :class="color(row.change)">{{pct(row.change)}}</td><td>{{row.days}} / {{displayedDays}} 天<small v-if="row.partial">历史较短</small></td><td :class="color(row.monthChange)">{{pct(row.monthChange)}}<small v-if="row.monthDays && row.monthDays<30">实际 {{row.monthDays}} 天</small></td><td>{{row.score??'—'}}</td><td><span class="trend-tag" :class="row.direction==='UP'||row.direction==='TURN_UP'?'positive':row.direction==='DOWN'||row.direction==='TURN_DOWN'?'negative':''">{{label(row)}}</span><small v-if="row.stale" class="error">{{row.error||'尚未更新'}}</small><small v-if="row.reason">{{row.reason}}</small></td><td>{{row.latestBarAt?date(row.latestBarAt):'—'}}</td><td class="operation-cell"><div class="contract-actions"><button class="follow-icon" :class="{active:watchedSymbols.includes(row.symbol)}" :aria-label="`${watchedSymbols.includes(row.symbol)?'取消关注':'关注'} ${row.symbol}`" @click.stop="toggleWatch(row.symbol)">★</button><ContractDetailLink :symbol="row.symbol" :asset-type="row.assetType" :name="row.name" icon-only /></div></td>
      </tr><tr v-if="!rows.length"><td colspan="11" class="empty-row">{{emptyMessage}}</td></tr>
    </tbody></table></div>
    <div v-if="data" class="pagination list-pagination"><button :disabled="data.page<=1" @click="page=data.page-1">上一页</button><span>{{data.page}} / {{data.pages}} · 每页 20 个</span><button :disabled="data.page>=data.pages" @click="page=data.page+1">下一页</button></div>
    <footer class="market-foot"><span>趋势使用已收盘日线（UTC）；现价约每 15 秒刷新，失败显示缓存状态。</span><span>允许中途回调，不要求每日同向；卡片、列表与图表使用相同周期。</span></footer>
  </section>
  <details class="rules"><summary>筛选规则与数据口径</summary><p>只采集币安可交易的传统金融 USDT 永续合约。默认不选择资产分类，展示通过流动性筛选的合约。A股、港股、中概股及指数 / ETF、金属 / 能源保留；其他已确认个股按最近 20 个完整市场交易日对应的币安 UTC 日线成交额取均值，低于 500 万 USDT 时从列表中过滤，周末、市场休市日与未完成日线不参与。样本不足、交易日历或类别未确认时先保留；已关注卡片不受此过滤影响。目标 {{displayedDays}} 天，历史较短时按实际连续区间计算并标注，不补齐或年化；不足 20 天、日线缺口或未更新时不判定趋势。持续走强 / 走弱要求区间涨跌绝对值 ≥ 5%、对数价格拟合 R² ≥ 0.35、方向效率 ≥ 0.10、近 20 天及近 30 天同向，且前中后三段的收盘高低点依次抬高 / 降低；区间与近 20 天反向且各变化至少 5% 时标记近期转向，其余为震荡。趋势分为 R² × 方向效率 × 100，不代表获利概率，短历史与完整周期不宜直接比较。图表采用线性价格坐标，关注列表不受筛选和翻页影响。</p></details>
</section>
</template>
<style scoped src="./RadarBoard.css"></style>
<style scoped>
.long-trends{min-width:0}.adjustment-note{padding:0 14px;color:var(--gold);font-size:11px}.scope-label{color:var(--gold)}.add-select{max-width:240px;height:32px;background:var(--surface);color:var(--text);border:1px solid var(--line);border-radius:6px}.selected-metrics{grid-template-columns:repeat(3,minmax(0,1fr))}.progress,.rules{color:var(--muted);font-size:12px;line-height:1.7}.progress{margin:0 0 12px}.error{color:#f3b77c}.result-panel{margin-top:12px}.rules{margin-top:12px}.rules summary{cursor:pointer}.watch-select{padding-bottom:14px}.watch-card-top{padding-right:52px}.watch-change{margin-left:0}.contract-link{border:0;padding:0;background:transparent;color:inherit;font:inherit;font-weight:700;cursor:pointer}.table-wrap td small{display:block;font-size:10px;margin-top:4px}.chart-heading{flex-wrap:wrap}.chart-heading>div:first-child{flex-wrap:wrap}.rules p{max-width:1000px}
</style>

<style scoped src="./RadarTheme.css"></style>
