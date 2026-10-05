<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from 'vue';
import { goldStrategy } from '../../tradfi-replay/strategies';
import { fetchRadarQuotes, fetchRadarKlines, type TradFiQuote, type RadarKline } from '@/api';
const StrategyShadowPanel = defineAsyncComponent(() => import('./StrategyShadowPanel.vue'));
const props = defineProps<{ active: boolean; replayVisited: boolean }>();
defineEmits<{ replay: [] }>();
// Isolated from the radar watchlist, selected symbol, timers and trading-account APIs.
const assets = [{symbol:'XAUUSDT',name:'黄金',icon:'Au'},{symbol:'XAGUSDT',name:'白银',icon:'Ag'}];
const selected = ref('XAUUSDT');
const interval = ref<'5m'|'15m'|'1h'>('1h');
const quotes = ref<Record<string, TradFiQuote>>({});
const bars = ref<RadarKline[]>([]);
const busy = ref(false), chartBusy = ref(false), error = ref(''), chartError = ref(''), updated = ref('');
const hover = ref<number|null>(null);
let quoteRun=0, chartRun=0;
const current = computed(()=>quotes.value[selected.value]);
function number(value: unknown, digits=2) { return value == null || value === '' || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString('zh-CN',{minimumFractionDigits:digits,maximumFractionDigits:digits}); }
function clock(value: number|string) { return new Date(value).toLocaleString('zh-CN',{hour12:false}); }
function sign(value: unknown) { return value != null && Number(value)<0 ? 'down' : 'up'; }
async function loadQuotes() {
  const run=++quoteRun;busy.value=true;error.value='';
  try { const data=await fetchRadarQuotes(assets.map(a=>a.symbol)); if(run!==quoteRun)return;
    quotes.value=Object.fromEntries(data.quotes.map(q=>[q.symbol,q]));updated.value=data.updatedAt;
  } catch(e) { if(run===quoteRun)error.value=e instanceof Error?e.message:'行情读取失败'; }
  finally { if(run===quoteRun)busy.value=false; }
}
async function loadChart() {
  const run=++chartRun, symbol=selected.value, period=interval.value;
  chartBusy.value=true;chartError.value='';bars.value=[];hover.value=null;
  try { const data=await fetchRadarKlines(symbol,period);if(run!==chartRun)return;
    if(data.symbol!==symbol || data.interval!==period)throw new Error('行情标的或周期不匹配，请重试');
    bars.value=data.bars.filter(b=>[b.openTime,b.close].every(Number.isFinite)&&b.close>0);
    chartError.value=!data.available?'当前合约暂无走势数据':data.stale?'当前展示服务器缓存走势，暂未取得最新数据':'';
  } catch(e) { if(run===chartRun)chartError.value=e instanceof Error?e.message:'走势读取失败'; }
  finally { if(run===chartRun)chartBusy.value=false; }
}
watch(()=>props.active, active=>{
  if(active){if(!updated.value)void loadQuotes();if(!bars.value.length)void loadChart();}
  else {++quoteRun;++chartRun;busy.value=false;chartBusy.value=false;}
},{immediate:true});
watch([selected,interval],()=>{if(props.active)void loadChart();});
onBeforeUnmount(()=>{++quoteRun;++chartRun;});
const bounds=computed(()=>{const values=bars.value.map(b=>b.close);return {min:Math.min(...values),max:Math.max(...values)};});
const line=computed(()=>bars.value.map((b,i)=>`${i?'L':'M'} ${20+i/Math.max(1,bars.value.length-1)*960} ${280-(b.close-bounds.value.min)/Math.max(bounds.value.max-bounds.value.min,0.000001)*250}`).join(' '));
const hovered=computed(()=>hover.value==null?null:bars.value[hover.value]);
function move(event: MouseEvent) {const rect=(event.currentTarget as SVGElement).getBoundingClientRect();const x=(event.clientX-rect.left)/rect.width*1000;hover.value=Math.max(0,Math.min(bars.value.length-1,Math.round((x-20)/960*(bars.value.length-1))));}
</script>
<template>
  <main class="strategy-home">
    <div class="strip" aria-label="策略标的">
      <button v-for="asset in assets" :key="asset.symbol" class="ticker" :class="{selected:selected===asset.symbol}" @click="selected=asset.symbol">
        <span class="ticker-top"><b>{{asset.name}}</b><small>{{quotes[asset.symbol]?.stale?'缓存行情':'USDT 合约'}}</small></span>
        <span class="ticker-main"><strong>{{number(quotes[asset.symbol]?.lastPrice)}}</strong><em :class="sign(quotes[asset.symbol]?.priceChangePercent)">{{number(quotes[asset.symbol]?.priceChangePercent)}}%</em></span><small>{{asset.symbol}} · 24h 涨跌</small>
      </button>
    </div>
    <section class="focus">
      <div class="asset-icon">{{assets.find(a=>a.symbol===selected)?.icon}}</div><div><h2>{{selected}}</h2><small>{{assets.find(a=>a.symbol===selected)?.name}} · 贵金属永续合约</small></div>
      <div class="focus-price"><strong>{{number(current?.lastPrice)}}</strong><small :class="sign(current?.priceChangePercent)">{{number(current?.priceChangePercent)}}% · 24h</small></div>
      <div class="focus-actions"><button class="btn primary" @click="$emit('replay')">{{replayVisited?'继续策略回放':'策略回放'}}</button></div>
    </section>
    <div class="main-grid">
      <section class="panel chart-panel"><div class="panel-head"><h2>合约走势</h2><div class="periods"><button v-for="p in (['5m','15m','1h'] as const)" :key="p" :class="{selected:interval===p}" @click="interval=p">{{p==='1h'?'1 小时':p==='15m'?'15 分钟':'5 分钟'}}</button></div></div>
        <p v-if="chartError" class="notice" role="status">{{chartError}}</p>
        <div class="chart"><svg v-if="bars.length" viewBox="0 0 1000 310" preserveAspectRatio="none" aria-label="合约收盘价走势" @mousemove="move" @mouseleave="hover=null"><path :d="line" fill="none" stroke="#37cba0" stroke-width="2" vector-effect="non-scaling-stroke"/><line v-if="hover!=null" :x1="20+hover/Math.max(1,bars.length-1)*960" :x2="20+hover/Math.max(1,bars.length-1)*960" y1="0" y2="310" stroke="#718499" stroke-dasharray="5 5"/></svg><div v-else class="empty">{{chartBusy?'正在读取走势…':'暂无走势数据'}}</div><div v-if="hovered" class="tooltip">{{clock(hovered.openTime)}}<br>收盘价 {{number(hovered.close,3)}} USDT</div></div>
        <div v-if="bars.length" class="chart-meta"><span>{{clock(bars[0]!.openTime)}}</span><span>收盘价 {{number(bounds.min)}} — {{number(bounds.max)}} USDT</span><span>{{clock(bars[bars.length-1]!.openTime)}}</span></div>
      </section>
      <aside class="panel"><div class="panel-head"><h2>{{goldStrategy.name}}</h2><small>策略参数</small></div><p class="note">{{goldStrategy.subtitle}}</p><dl><div><dt>事件保证金预算</dt><dd>1,000 USDT</dd></div><div><dt>杠杆</dt><dd>3×</dd></div><div><dt>模拟账户权益</dt><dd>40,000 USDT</dd></div><div><dt>Maker / Taker 费率</dt><dd>0.02% / 0.05%（回放可修改）</dd></div><div><dt>价格 Tick / 数量步进</dt><dd>0.01 / 0.001</dd></div><div><dt>风险 / 持仓期限</dt><dd>≤100U 且≤权益1% / 24小时</dd></div></dl><p class="note">具体参数在回放页面设置。导入分钟 K 线与配套资金费后运行；已有回放返回此页会暂停，重新进入可继续。</p></aside>
    </div>
    <section class="panel rules"><div class="panel-head"><h2>策略规则</h2><small>{{goldStrategy.subtitle}}</small></div><div class="rule-grid"><article><h3>周度背景选方向</h3><p>此前七根完整 UTC 日线累计下跌优先做多、上涨优先做空，未达到方向阈值则等待。始终只持有一侧。</p></article><article><h3>日内分档挂单</h3><p>按日开盘的涨跌幅挂单。默认 5% / 10% / 20% 三档，对应累计预算 10% / 30% / 60%，可在回放修改。</p></article><article><h3>累计额度补仓</h3><p>只补更深且未成交的档位，扣除已经投入的额度。换日更新参考价，但已有仓位的预算、止损和计时不重置。</p></article><article><h3>整体回归退出</h3><p>按整个仓位扣费后的净收益止盈，同时保留固定止损与最长持仓期限。退出后当日不重建。参数仍需回测验证。</p></article></div></section>
    <StrategyShadowPanel :symbol="selected" :active="active" />
  </main>
</template>
<style scoped>
.strategy-home{box-sizing:border-box;min-height:100%;padding:24px;background:#0b1017;color:#dce6f1;font-size:14px}.ticker-top,.ticker-main,.focus,.panel-head,.chart-meta{display:flex;align-items:center;justify-content:space-between;gap:16px}small,.note,.chart-meta{color:#8fa2b7}.btn,.periods button,.ticker{cursor:pointer;color:inherit;border:1px solid #304153;background:#172330;border-radius:7px;padding:10px 16px}.btn:disabled{opacity:.5;cursor:wait}.btn.primary{background:#d7ac38;color:#161b23;border-color:#d7ac38;font-weight:700}.strip{display:flex;gap:14px;margin:8px 0 20px;flex-wrap:wrap}.ticker{min-width:240px;text-align:left;padding:16px}.ticker.selected{border-color:#c4a34a;background:#24251f}.ticker-main{margin:12px 0}.ticker-main strong,.focus-price strong{font:600 25px ui-monospace,Consolas,monospace}.ticker-main em{font-style:normal}.up{color:#32c99e}.down{color:#f27e8d}.focus,.panel{background:#121b26;border:1px solid #29394b;border-radius:10px;padding:20px}.focus{justify-content:flex-start;flex-wrap:wrap;margin-bottom:20px}.asset-icon{display:grid;place-items:center;background:#392f19;color:#eaca71;width:50px;height:50px;border-radius:12px;font-size:23px;font-weight:700}h2{font-size:17px;margin:0 0 5px}.focus-price{margin-left:24px;display:grid;gap:8px}.focus-actions{margin-left:auto}.main-grid{display:grid;grid-template-columns:minmax(0,1.8fr) minmax(280px,1fr);gap:20px}.panel{min-width:0}.panel-head{border-bottom:1px solid #273747;padding-bottom:14px}.periods{display:flex;gap:7px}.periods button{padding:6px 10px}.periods .selected{color:#e9c66b;border-color:#a58c48}.chart{height:330px;position:relative;margin-top:16px}.chart svg{width:100%;height:100%;background:repeating-linear-gradient(0deg,transparent,transparent 65px,#233140 66px)}.tooltip{position:absolute;left:14px;top:8px;background:#0d141ee8;border:1px solid #3a4f66;border-radius:6px;padding:10px;pointer-events:none;line-height:1.8}.empty{height:100%;display:grid;place-items:center;color:#8397ae}.chart-meta{font-size:11px;flex-wrap:wrap}.notice{color:#e7bc66;font-size:12px}dl>div{display:flex;justify-content:space-between;gap:16px;padding:13px 0;border-bottom:1px solid #243243}dt{color:#9dacc0}dd{margin:0;text-align:right}.note{font-size:12px;line-height:1.8}.rules{margin-top:20px}.rule-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:24px}h3{font-size:14px;color:#d8ba69}.rule-grid p{line-height:1.9;color:#a4b4c7;font-size:13px}@media(max-width:1000px){.main-grid{grid-template-columns:1fr}.rule-grid{grid-template-columns:1fr 1fr}}@media(max-width:600px){.strategy-home{padding:12px}.ticker{flex:1;min-width:150px}.rule-grid{grid-template-columns:1fr}.focus-price{margin-left:0}.chart-meta{display:block}.chart-meta span{display:block}}
</style>
