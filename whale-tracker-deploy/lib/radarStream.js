'use strict';
const {randomUUID}=require('node:crypto');

// One immutable state and bounded replay buffer shared by every radar client.
function createStream({maxEvents=80,maxBytes=4*1024*1024}={}){
  const epoch=randomUUID();let seq=0,bytes=0;
  let state={catalog:[],marketSymbols:[],quotes:[],long:{rows:[],running:false,error:''},updatedAt:null,error:''};
  const history=[],listeners=new Set();
  function commit(next){
    next=Object.fromEntries(Object.keys(state).map(key=>[key,next[key]]));
    const patch={};
    for(const key of ['catalog','marketSymbols','updatedAt','error'])if(JSON.stringify(next[key])!==JSON.stringify(state[key]))patch[key]=next[key];
    for(const key of ['quotes','long']){
      const rowsKey=key==='quotes'?null:'rows';
      const oldRows=rowsKey?state[key].rows:state[key],newRows=rowsKey?next[key].rows:next[key];
      const old=new Map(oldRows.map(row=>[row.symbol,JSON.stringify(row)]));
      const symbols=new Set(newRows.map(row=>row.symbol));
      const upserts=newRows.filter(row=>old.get(row.symbol)!==JSON.stringify(row));
      if(rowsKey)for(let i=0;i<upserts.length;i++){
        const row=upserts[i],previous=old.get(row.symbol);
        if(!previous)continue;
        const original=JSON.parse(previous),delta={...row};
        // Daily history/metrics are large and normally unchanged by live prices.
        for(const field of ['points','frames'])if(JSON.stringify(row[field])===JSON.stringify(original[field]))delete delta[field];
        upserts[i]=delta;
      }
      const remove=oldRows.filter(row=>!symbols.has(row.symbol)).map(row=>row.symbol);
      const meta=rowsKey?Object.fromEntries(Object.entries(next[key]).filter(([k])=>k!=='rows')):null;
      const oldMeta=rowsKey?Object.fromEntries(Object.entries(state[key]).filter(([k])=>k!=='rows')):null;
      if(upserts.length||remove.length||JSON.stringify(meta)!==JSON.stringify(oldMeta))patch[key]={upserts,remove,...(rowsKey?{meta}:{})};
    }
    if(!Object.keys(patch).length)return;
    state=next;
    const event={type:'radarDelta',epoch,seq:++seq,patch},payload=JSON.stringify(event);
    const size=Buffer.byteLength(payload);
    history.push({event,size});bytes+=size;
    while(history.length>maxEvents||bytes>maxBytes){bytes-=history.shift().size;}
    for(const listener of listeners)listener(event,payload);
  }
  function resume(cursor){
    if(cursor.epoch!==epoch||!Number.isSafeInteger(cursor.seq)||cursor.seq<0||cursor.seq>seq
      ||(cursor.seq<seq&&(!history.length||cursor.seq<history[0].event.seq-1)))return {type:'resyncRequired'};
    return {type:'caughtUp',epoch,seq,events:history.filter(row=>row.event.seq>cursor.seq).map(row=>row.event)};
  }
  return {commit,resume,snapshot:()=>({type:'radarSnapshot',epoch,seq,...state}),subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);}};
}
const stream=createStream();
let task=null,nextAttempt=0;
function captureLong(){
  if(!require('./featureFlags').radarEnabled())return;
  const frame=stream.snapshot();
  try{stream.commit({...frame,long:require('./radarLongTrend').snapshotAll()});}
  catch{stream.commit({...frame,long:{...frame.long,error:'日线缓存读取失败，保留最近结果'}});}
}
function refresh(extra=[]){
  if(task||Date.now()<nextAttempt||!require('./featureFlags').radarEnabled())return task;
  nextAttempt=Date.now()+15000;
  task=(async()=>{
    const markets=require('./tradfiMarkets');
    const result=await markets.getRadarStreamQuotes(extra,base=>{
      const old=stream.snapshot(),previous=new Map(old.quotes.map(row=>[row.symbol,row]));
      // Preserve prior short windows until this collection completes, marked stale.
      stream.commit({...old,...base,quotes:base.quotes.map(row=>({...row,changes:previous.get(row.symbol)?.changes,
        changeMeta:previous.get(row.symbol)?.changeMeta,shortStale:true}))});
    });
    stream.commit({...stream.snapshot(),...result,error:result.stale?'行情源暂不可用，保留缓存行情':''});
    captureLong();
  })().catch(()=>{
    const old=stream.snapshot();
    stream.commit({...old,error:'行情更新失败，保留最近结果',quotes:old.quotes.map(row=>({...row,stale:true,shortStale:true}))});
  }).finally(()=>{task=null;nextAttempt=Math.max(nextAttempt,Date.now()+15000);});
  return task;
}
function snapshot(){captureLong();void refresh();return stream.snapshot();}
module.exports={createStream,stream,snapshot,refresh,captureLong};
