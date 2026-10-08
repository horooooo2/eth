import { ref, shallowRef } from 'vue';
import type { SocketStatus } from '@/utils/socketStatus';
import { http, type TradFiMarketSymbol, type TradFiQuote, type RadarKline } from '@/api';

export type TrendRow={periodChanges?:Partial<Record<30|60|90,number>>;assetGroup?:'STOCK'|'INDEX_ETF'|'METAL_ENERGY'|'UNKNOWN';stockMarket?:string|null;liquidityExempt?:boolean;liquidity?:{version:number;asOf:number;minimum:number;averageQuoteVolume:number|null;sampleDays:number;filtered:boolean;status:string}|null;currentPrice?:number;priceAsOf?:number;priceStale?:boolean;adjustmentNote?:string;symbol:string;name:string;assetType:string;direction:'UP'|'DOWN'|'NEUTRAL'|'INSUFFICIENT'|'TURN_UP'|'TURN_DOWN';days:number;partial?:boolean;recentDays?:number;monthDays?:number;monthChange?:number;change?:number;recentChange?:number;r2?:number;efficiency?:number;score?:number;streak?:number;maxDrawdown?:number;maxRebound?:number;points?:[number,number][];asOf:number|null;latestBarAt:number|null;stale:boolean;reason?:string;error?:string};
export type LongRecord=Omit<TrendRow,'direction'|'days'> & {frames:Record<string,Partial<TrendRow>>};
type Chart={available:boolean;stale:boolean;bars:RadarKline[];error?:string;adjustmentNote?:string};
export type RadarSnapshot={epoch:string;seq:number;catalog:TradFiMarketSymbol[];marketSymbols:string[];quotes:TradFiQuote[];long:{rows:LongRecord[];running:boolean;error:string};updatedAt:string|null;error:string};
type PatchRows<T>={upserts:T[];remove:string[]};
type Delta={type:'radarDelta';epoch:string;seq:number;patch:Partial<Pick<RadarSnapshot,'catalog'|'marketSymbols'|'updatedAt'|'error'>> & {quotes?:PatchRows<TradFiQuote>;long?:PatchRows<LongRecord> & {meta:Omit<RadarSnapshot['long'],'rows'>}}};

export function applyRadarDelta(state:RadarSnapshot,event:Delta):RadarSnapshot|null{
  if(event.epoch!==state.epoch||event.seq!==state.seq+1)return null;
  function update<T extends {symbol:string}>(rows:T[],patch:PatchRows<T>,merge=false){
    const map=new Map(rows.map(row=>[row.symbol,row]));
    for(const symbol of patch.remove)map.delete(symbol);
    for(const row of patch.upserts)map.set(row.symbol,merge?{...map.get(row.symbol),...row}:row);
    return [...map.values()];
  }
  const {quotes,long,...meta}=event.patch;
  return {...state,...meta,seq:event.seq,quotes:quotes?update(state.quotes,quotes):state.quotes,
    long:long?{...long.meta,rows:update(state.long.rows,long,true)}:state.long};
}

// Shared by both tabs: one snapshot, one connection, bounded chart cache.
export function createRadarClient(deps={
  snapshot:async()=> (await http.get<RadarSnapshot>('/tradfi/radar/snapshot',{timeout:15000})).data,
  socket:()=>new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/realtime/radar`),
}){
  const state=shallowRef<RadarSnapshot|null>(null),charts=shallowRef<Record<string,Chart>>({});
  const loading=ref(false),error=ref(''),connected=ref(false),status=ref<SocketStatus>('idle');
  let active=false,ws:WebSocket|null=null,bootstrap:Promise<void>|null=null,retry:ReturnType<typeof setTimeout>|undefined;
  let heartbeat:ReturnType<typeof setInterval>|undefined,attempt=0,lastPong=0;
  const chartSubscriptions=new Map<string,{symbol:string;interval:'5m'|'1h'|'1d'}>();let watches:string[]=[];
  const send=(value:unknown)=>{if(ws?.readyState===1)ws.send(JSON.stringify(value));};
  function subscriptions(){send({type:'watch',symbols:watches});for(const chart of chartSubscriptions.values())send({type:'chart',...chart});}
  function schedule(){
    clearTimeout(retry);
    if(active)retry=setTimeout(()=>{if(state.value)connect();else void ensure();},Math.min(30000,1000*2**Math.min(attempt++,5)));
  }
  function connect(){
    if(!active||!state.value||ws)return;
    status.value='connecting';
    let socket:WebSocket;
    try { socket=deps.socket(); } catch { status.value='disconnected';error.value='实时连接创建失败，稍后重试';schedule();return; }
    ws=socket;
    socket.onopen=()=>{
      if(ws!==socket)return;
      lastPong=Date.now();
      send({type:'resume',epoch:state.value!.epoch,seq:state.value!.seq});
      clearInterval(heartbeat);
      heartbeat=setInterval(()=>{if(Date.now()-lastPong>65000){connected.value=false;status.value='disconnected';socket.close();}else send({type:'ping'});},25000);
    };
    socket.onmessage=event=>{
      if(ws!==socket)return;
      try{
        const msg=JSON.parse(String(event.data));lastPong=Date.now();
        if(msg.type==='radarDelta'){
          if(!state.value)return;
          if(msg.epoch===state.value.epoch&&msg.seq<=state.value.seq)return;
          const next=applyRadarDelta(state.value,msg);
          if(!next){void resync();return;}state.value=next;
        }else if(msg.type==='caughtUp'){
          if(!state.value||msg.epoch!==state.value.epoch||msg.seq!==state.value.seq){void resync();return;}
          connected.value=true;status.value='connected';error.value='';attempt=0;subscriptions();
        }else if(msg.type==='resyncRequired')void resync();
        else if(msg.type==='radarChart'){
          const previous=charts.value[msg.key];
          const result=!msg.result.bars?.length&&previous?.bars.length?{...previous,stale:true,error:msg.result.error||'图表更新失败'}:msg.result;
          const next={...charts.value};delete next[msg.key];next[msg.key]=result;
          while(Object.keys(next).length>40)delete next[Object.keys(next)[0]!];
          charts.value=next;
        }
      }catch{void resync();}
    };
    socket.onerror=()=>{if(ws===socket){connected.value=false;status.value='disconnected';error.value='实时连接异常，保留最近结果';socket.close();}};
    socket.onclose=()=>{
      if(ws!==socket)return;
      ws=null;connected.value=false;status.value=active?'disconnected':'idle';clearInterval(heartbeat);
      if(active){error.value='连接中断，保留最近结果并重新连接';schedule();}
    };
  }
  function disconnect(){const old=ws;ws=null;connected.value=false;status.value=active?'disconnected':'idle';clearInterval(heartbeat);old?.close();}
  async function resync(){disconnect();await ensure(true);}
  function ensure(force=false):Promise<void>{
    if(bootstrap)return bootstrap;
    if(state.value&&!force){connect();return Promise.resolve();}
    loading.value=!state.value;
    bootstrap=(async()=>{
      try{state.value=await deps.snapshot();error.value='';if(active)connect();}
      catch{status.value=active?'disconnected':'idle';error.value='快照读取失败，保留最近结果并稍后重试';schedule();}
      finally{loading.value=false;bootstrap=null;}
    })();
    return bootstrap;
  }
  return {state,charts,loading,error,connected,status,ensure,
    setActive(value:boolean){active=value;clearTimeout(retry);if(value){if(!connected.value)status.value='connecting';void ensure();}else disconnect();},
    setWatches(symbols:string[]){watches=[...new Set(symbols)].slice(0,30);if(connected.value)send({type:'watch',symbols:watches});},
    selectChart(symbol:string,interval:'5m'|'1h'|'1d'){const chart={symbol,interval};chartSubscriptions.set(interval==='1d'?'long':'short',chart);if(connected.value)send({type:'chart',...chart});},
  };
}
export const radarClient=createRadarClient();

export function sortRadarRows<T extends {symbol:string}>(rows:T[],value:(row:T)=>unknown,order:'asc'|'desc'){
  return [...rows].sort((a,b)=>{
    const rawA=value(a),rawB=value(b);
    const x=rawA==null||rawA===''?NaN:Number(rawA),y=rawB==null||rawB===''?NaN:Number(rawB);
    if(!Number.isFinite(x))return Number.isFinite(y)?1:a.symbol.localeCompare(b.symbol);
    if(!Number.isFinite(y))return -1;
    return (order==='asc'?x-y:y-x)||a.symbol.localeCompare(b.symbol);
  });
}
