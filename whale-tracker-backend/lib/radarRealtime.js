'use strict';
const {WebSocketServer}=require('ws');
const {safeSend}=require('./socketSend');
const radar=require('./radarStream');
const enabled=()=>require('./featureFlags').radarEnabled();
function attachRadarRealtime(server){
  const wss=new WebSocketServer({noServer:true,maxPayload:4096}),clients=new Set();
  const chartCache=new Map(),chartQueue=new Set(),chartInFlight=new Set();let chartTask=null;
  const extras=()=>[...new Set([...clients].flatMap(socket=>socket.watches||[]))].slice(0,150);
  async function refreshCharts(){
    if(!enabled())return;
    for(const socket of clients)if(socket.ready&&socket.chart&&!chartInFlight.has(socket.chart))chartQueue.add(socket.chart);
    if(chartTask)return chartTask;
    chartTask=(async()=>{
      // Two shared workers, including subscriptions arriving during a fetch.
      await Promise.all(Array.from({length:2},async()=>{while(chartQueue.size){
        const key=chartQueue.values().next().value;chartQueue.delete(key);
        if(!enabled()||![...clients].some(socket=>socket.ready&&socket.chart===key))continue;
        chartInFlight.add(key);
        const [symbol,interval]=key.split(':');
        try{
          let result=await require('./tradfiMarkets').getTradFiKlines(symbol,interval);
          const previous=chartCache.get(key);
          if(!result.bars?.length&&previous?.bars?.length)result={...previous,stale:true,error:result.error||'图表更新失败'};
          chartCache.delete(key);chartCache.set(key,result);
          while(chartCache.size>40)chartCache.delete(chartCache.keys().next().value);
          const payload=JSON.stringify({type:'radarChart',key,result});
          for(const socket of clients)if(socket.ready&&socket.chart===key)safeSend(socket,payload);
        }finally{chartInFlight.delete(key);}
      }}));
    })().catch(()=>{}).finally(()=>{chartTask=null;});
    return chartTask;
  }
  const unsubscribe=radar.stream.subscribe((_event,payload)=>{
    for(const socket of clients)if(socket.ready)safeSend(socket,payload);
  });
  wss.on('connection',socket=>{
    socket.ready=false;socket.alive=true;clients.add(socket);
    socket.on('pong',()=>{socket.alive=true;});
    socket.on('close',()=>clients.delete(socket));socket.on('error',()=>clients.delete(socket));
    socket.on('message',raw=>{
      try{
        if(!enabled()){socket.close(1013,'radar paused');return;}
        const msg=JSON.parse(String(raw));
        if(msg.type==='resume'){
          socket.ready=false;const replay=radar.stream.resume(msg);
          if(replay.type==='resyncRequired'){safeSend(socket,replay);return;}
          for(const event of replay.events)if(!safeSend(socket,event))return;
          socket.ready=true;safeSend(socket,{type:'caughtUp',epoch:replay.epoch,seq:replay.seq});
        }else if(msg.type==='watch'){
          const known=new Set(radar.stream.snapshot().catalog.map(row=>row.symbol));
          socket.watches=Array.isArray(msg.symbols)?[...new Set(msg.symbols.filter(s=>known.has(s)))].slice(0,30):[];
        }else if(msg.type==='chart'){
          const known=radar.stream.snapshot().catalog.some(row=>row.symbol===msg.symbol);
          if(!known||!['5m','1h'].includes(msg.interval))return;
          socket.chart=`${msg.symbol}:${msg.interval}`;
          const cached=chartCache.get(socket.chart);
          if(cached)safeSend(socket,{type:'radarChart',key:socket.chart,result:cached});
          void refreshCharts();
        }else if(msg.type==='refresh')void radar.refresh(extras());
        else if(msg.type==='ping')safeSend(socket,{type:'pong',at:Date.now()});
      }catch{safeSend(socket,{type:'resyncRequired'});}
    });
    void radar.refresh(extras());
  });
  const timer=setInterval(()=>{
    if(!clients.size||!enabled())return;
    radar.captureLong();void radar.refresh(extras());void refreshCharts();
  },15000);
  const dailyTimer=setInterval(()=>{if(clients.size&&enabled())radar.captureLong();},3000);
  const heartbeat=setInterval(()=>{
    for(const socket of clients){if(!enabled()||!socket.alive){socket.terminate();continue;}socket.alive=false;socket.ping();}
  },30000);
  for(const handle of [timer,dailyTimer,heartbeat])handle.unref?.();
  server.on('close',()=>{for(const handle of [timer,dailyTimer,heartbeat])clearInterval(handle);unsubscribe();for(const socket of clients)socket.terminate();wss.close();});
  return {upgrade(req,socket,head){
    if(!enabled()||clients.size>=20){socket.destroy();return;}
    wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
  }};
}
module.exports={attachRadarRealtime};
