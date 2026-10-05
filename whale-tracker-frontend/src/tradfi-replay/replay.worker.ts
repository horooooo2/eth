import { DailyLadderEngine, type Candle } from './dailyLadderEngine';
const scope: any = self;
let candles: Candle[] = [], expected = 0, index = 0, engine: DailyLadderEngine;
let timer: number | null = null, speed = 10, sentLogs = 0, ready = false, failed = false;
function stop() { if (timer != null) clearInterval(timer); timer = null; }
function snapshot() {
  const bar = candles[Math.max(0,index-1)];
  const subset = candles.slice(Math.max(0,index-720),index), stride = Math.max(1,Math.ceil(subset.length/240));
  return { ...engine.view(index ? bar.c : 0), index,total:candles.length,progress:candles.length?index/candles.length:0,
    time:index?bar.t:0,price:index?bar.c:0,paused:timer==null,
    recentLogs:engine.logs.slice(-100),logsTotal:engine.logs.length,
    ...(index===candles.length ? {allEvents:engine.events} : {}),
    candles:subset.filter((_,i)=>i%stride===0 || i===subset.length-1) };
}
function advance(count=1) {
  if (!ready || failed) return;
  const end=Math.min(candles.length,index+count);
  try { while(index<end) { engine.step(candles[index]); index++; } }
  catch(error) { fail(error); return; }
  if(index>=candles.length)stop();
  scope.postMessage({type:'tick',payload:snapshot(),newLogs:engine.logs.slice(sentLogs)});sentLogs=engine.logs.length;
}
function fail(error: unknown) { stop(); failed=true; ready=false; scope.postMessage({type:'replay-error',message:error instanceof Error?error.message:String(error)}); }
scope.onmessage=(event:MessageEvent)=>{
  const m=event.data;
  try {
    if(m.type==='init-start') {
      stop(); ready=false;failed=false;index=sentLogs=0;candles=[];expected=Number(m.candleCount);
      if(!Number.isInteger(expected)||expected<=0)throw new Error('无效的数据长度');
      engine=new DailyLadderEngine(m.settings,m.funding || []);
      scope.postMessage({type:'warmup-progress',progress:6,stage:'周度选向 / 日内分档引擎就绪，等待分钟数据…'});
    } else if(m.type==='init-chunk') {
      if(failed||ready)return;
      const flat=new Float64Array(m.buffer), count=Number(m.count);
      if(m.start!==candles.length||!Number.isInteger(count)||count<=0||flat.length!==count*6||candles.length+count>expected)throw new Error('分块顺序或长度不正确');
      for(let i=0;i<count;i++){const n=i*6;candles.push({t:flat[n],o:flat[n+1],h:flat[n+2],l:flat[n+3],c:flat[n+4],v:flat[n+5]});}
      scope.postMessage({type:'warmup-progress',progress:8+Math.floor(candles.length/expected*90),stage:`载入分钟数据 ${candles.length.toLocaleString()} / ${expected.toLocaleString()}`});
      scope.postMessage({type:'chunk-ack',received:candles.length,total:expected});
    } else if(m.type==='init-complete') {
      if(failed)return;
      if(candles.length!==expected)throw new Error('分钟数据传送不完整');
      ready=true;scope.postMessage({type:'warmup-progress',progress:100,stage:'就绪：指标将在回放中逐根预热，不读取未来行情'});
      scope.postMessage({type:'ready',payload:snapshot()});
    } else if(m.type==='step'){stop();advance(1);}
    else if(m.type==='play'&&ready){stop();speed=Math.min(10000,Math.max(1,Math.floor(Number(m.speed)||1)));timer=self.setInterval(()=>advance(speed),50);}
    else if(m.type==='speed')speed=Math.min(10000,Math.max(1,Math.floor(Number(m.speed)||1)));
    else if(m.type==='pause'||m.type==='stop')stop();
    else if(m.type==='export')scope.postMessage({type:'export',payload:engine.logs});
    else if(m.type==='peak-fills')scope.postMessage({type:'peak-fills',side:m.side,payload:engine.lossContext[m.side as 'long'|'short']||null});
  }catch(error){fail(error);}
};
