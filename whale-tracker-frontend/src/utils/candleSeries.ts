import type { RadarKline } from '@/api';
export function buildCandleSeries(input:RadarKline[],_intervalMs:number,count:number){
  const bars=[...input].filter(bar=>Number.isFinite(bar.openTime)&&[bar.open,bar.high,bar.low,bar.close].every(value=>Number.isFinite(value)&&value>0)
    &&bar.high>=Math.max(bar.open,bar.close)&&bar.low<=Math.min(bar.open,bar.close)&&bar.high>=bar.low)
    .sort((a,b)=>a.openTime-b.openTime).filter((bar,index,all)=>!index||bar.openTime!==all[index-1]!.openTime);
  return bars.slice(-Math.max(1,Math.floor(count))).map(bar=>({bar}));
}

export function candlePriceRange(input: RadarKline[]) {
  const bars = buildCandleSeries(input, 0, input.length).map(row => row.bar);
  if (!bars.length) return null;
  return bars.reduce((range, bar) => ({ high: Math.max(range.high, bar.high), low: Math.min(range.low, bar.low) }),
    { high: bars[0]!.high, low: bars[0]!.low });
}
