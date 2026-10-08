<script setup lang="ts">
import {computed,ref,watch,onMounted,onUnmounted} from 'vue';
import type {RadarKline} from '@/api';
import {buildCandleSeries} from '@/utils/candleSeries';
const props=withDefaults(defineProps<{bars:RadarKline[];symbol:string;interval:'5m'|'1h'|'1d';visibleCount?:number}>(),{visibleCount:200});
const hover=ref<number|null>(null),chartRoot=ref<HTMLElement|null>(null),width=ref(1000);
const right=computed(()=>width.value-66);
let observer:ResizeObserver|undefined;
onMounted(()=>{observer=new ResizeObserver(entries=>{width.value=Math.max(250,entries[0]!.contentRect.width);});if(chartRoot.value)observer.observe(chartRoot.value);});
onUnmounted(()=>observer?.disconnect());
const series=computed(()=>buildCandleSeries(props.bars,{'5m':300000,'1h':3600000,'1d':86400000}[props.interval],props.visibleCount));
watch(()=>[props.symbol,props.interval,props.visibleCount],()=>{hover.value=null;});
const range=computed(()=>{
  const rows=series.value;
  if(!rows.length)return {low:0,high:1};
  let low=Infinity,high=-Infinity;
  for(const row of rows){low=Math.min(low,row.bar.low);high=Math.max(high,row.bar.high);}
  const padding=Math.max((high-low)*.08,high*.001);
  return {low:low-padding,high:high+padding};
});
const y=(price:number)=>28+(range.value.high-price)/(range.value.high-range.value.low)*192;
const step=computed(()=>(right.value-8)/Math.max(1,series.value.length));
const candles=computed(()=>series.value.map((row,i)=>({...row,x:8+(i+.5)*step.value,
  top:y(Math.max(row.bar.open,row.bar.close)),height:Math.max(.9,Math.abs(y(row.bar.open)-y(row.bar.close))),up:row.bar.close>=row.bar.open})));
const current=computed(()=>candles.value[hover.value??candles.value.length-1]);
const ticks=computed(()=>Array.from({length:5},(_,i)=>({y:28+i*48,price:range.value.high-i*(range.value.high-range.value.low)/4})));
function price(value:number|null|undefined){return value==null?'—':value.toLocaleString('en-US',{maximumFractionDigits:value>=1?3:8});}
function date(time:number){return new Date(time).toLocaleString('zh-CN',{timeZone:props.interval==='1d'?'UTC':undefined,month:'2-digit',day:'2-digit',...(props.interval==='1d'?{}:{hour:'2-digit',minute:'2-digit'})});}
function move(event:PointerEvent){
  const bounds=(event.currentTarget as SVGSVGElement).getBoundingClientRect();
  const x=(event.clientX-bounds.left)/bounds.width*width.value;
  hover.value=x<8||x>right.value?null:Math.min(candles.value.length-1,Math.max(0,Math.floor((x-8)/step.value)));
}
</script>
<template>
  <div ref="chartRoot" class="candle-chart">
    <svg v-if="candles.length" :viewBox="`0 0 ${width} 250`" preserveAspectRatio="none" role="img" :aria-label="`${symbol} ${interval} 蜡烛 K 线`" @pointermove="move" @pointerleave="hover=null">
      <g v-for="tick in ticks" :key="tick.y"><line x1="8" :x2="right" :y1="tick.y" :y2="tick.y" class="grid"/><text :x="right+8" :y="tick.y+4" class="axis">{{price(tick.price)}}</text></g>
      <line v-for="x in Array.from({length:6},(_,i)=>8+i*(right-8)/5)" :key="x" :x1="x" :x2="x" y1="28" y2="220" class="grid"/>
      <g v-for="row in candles" :key="row.bar.openTime" :fill="row.up?'#0ecb81':'#f6465d'" :stroke="row.up?'#0ecb81':'#f6465d'">
        <line :x1="row.x" :x2="row.x" :y1="y(row.bar.high)" :y2="y(row.bar.low)" stroke-width="1"/>
        <rect :x="row.x-Math.max(.8,step*.62)/2" :y="row.top" :width="Math.max(.8,step*.62)" :height="row.height" stroke-width="0"/>
      </g>
      <template v-if="hover!=null&&current"><line :x1="current.x" :x2="current.x" y1="28" y2="220" class="crosshair"/><line x1="8" :x2="right" :y1="y(current.bar.close)" :y2="y(current.bar.close)" class="crosshair"/></template>
      <text x="8" y="242" class="axis">{{date(candles[0]!.bar.openTime)}}</text><text :x="right" y="242" text-anchor="end" class="axis">{{date(candles.at(-1)!.bar.openTime)}}{{interval==='1d'?' UTC':''}}</text>
    </svg>
    <div v-else class="no-data">暂无有效 K 线数据</div>
    <div v-if="hover!=null&&current" class="candle-tooltip"><span>{{date(current.bar.openTime)}}</span><span>开 {{price(current.bar.open)}} · 高 {{price(current.bar.high)}}</span><span>低 {{price(current.bar.low)}} · 收 {{price(current.bar.close)}}</span></div>
  </div>
</template>
<style scoped>
.candle-chart{position:relative;width:100%;height:100%;min-height:0;background:#181b21}.candle-chart svg{display:block;width:100%;height:100%;overflow:visible}.grid{stroke:#252a33;stroke-width:1}.axis{fill:#848e9c;font-size:11px;font-variant-numeric:tabular-nums}.crosshair{stroke:#8993a2;stroke-width:1;stroke-dasharray:4 4;pointer-events:none}.candle-tooltip{box-sizing:border-box;position:absolute;top:8px;right:8px;display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:1px solid #343b48;border-radius:4px;background:#10141deb;color:#dce2eb;font-size:11px;pointer-events:none;z-index:2;max-width:calc(100% - 16px)}.no-data{height:100%;display:flex;align-items:center;justify-content:center;color:#848e9c;font-size:12px}
</style>
