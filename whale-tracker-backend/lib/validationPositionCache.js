// Compact, bounded snapshots shared by validations in the same DEX market.
// No disk reads in the per-account scan; entries expire after one hour.
function createPositionCache({now=Date.now,ttlMs=3600000,maxBytes=32*1024*1024,maxEntries=5000}={}) {
  const entries=new Map();let bytes=0;
  const key=(address,dex)=>`${String(dex||'').toLowerCase()}:${String(address).toLowerCase()}`;
  function remove(k){const old=entries.get(k);if(old){bytes-=old.bytes;entries.delete(k);}}
  function prune(){for(const [k,item] of entries)if(now()-item.observedAt>=ttlMs)remove(k);}
  return {
    get(address,dex){
      const k=key(address,dex),item=entries.get(k);
      if(!item)return null;
      if(now()-item.observedAt>=ttlMs){remove(k);return null;}
      entries.delete(k);entries.set(k,item);return {state:item.state,observedAt:item.observedAt};
    },
    put(address,dex,state,observedAt=now()){
      if(!Array.isArray(state?.assetPositions))throw new Error('仓位响应不完整');
      const assetPositions=state.assetPositions.map(row=>{
        const p=row?.position;
        if(!p||typeof p.coin!=='string'||p.szi==null||p.positionValue==null||!Number.isFinite(Number(p.szi))||!Number.isFinite(Number(p.positionValue))||Number(p.positionValue)<0)throw new Error('仓位数据异常');
        const position={};
        for(const field of ['coin','szi','positionValue','entryPx','unrealizedPnl','liquidationPx','marginUsed','returnOnEquity'])position[field]=p[field];
        if(p.leverage)position.leverage={value:p.leverage.value,type:p.leverage.type};
        return {position};
      });
      const compact={assetPositions},size=Buffer.byteLength(JSON.stringify(compact));
      prune();const k=key(address,dex);remove(k);
      if(size>maxBytes)return;
      while(entries.size && (bytes+size>maxBytes||entries.size>=maxEntries))remove(entries.keys().next().value);
      entries.set(k,{state:compact,observedAt,bytes:size});bytes+=size;
    },
    stats(){prune();return {entries:entries.size,bytes};},
  };
}
module.exports={createPositionCache};
