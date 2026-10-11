const { hlPost } = require('./hlInfoClient');

// Walk backwards from the sampled position. A gap is unknown, never an opening.
function inferOpenTime(fills, coin, position) {
  if (!Number.isFinite(position.size) || position.size <= 0 || !Number.isFinite(position.observedAt) || !['long','short'].includes(position.side)) return null;
  const rows = fills.filter(f => f && f.coin === coin && Number(f.time) <= position.observedAt && Number(f.time) >= position.observedAt - 90 * 86400000)
    .sort((a, b) => Number(b.time) - Number(a.time) || Number(b.tid) - Number(a.tid));
  let expected = position.side === 'long' ? position.size : -position.size;
  const seen = new Set();
  for (const f of rows) {
    if (f.tid == null || seen.has(String(f.tid))) return null;
    seen.add(String(f.tid));
    const before = Number(f.startPosition), size = Number(f.sz), time = Number(f.time);
    if (f.startPosition == null || f.startPosition === '' || !Number.isFinite(before) || !Number.isFinite(size) || size <= 0 || !Number.isFinite(time) || time <= 0 || !['A','B'].includes(f.side)) return null;
    const after = before + (f.side === 'B' ? size : -size);
    if (Math.abs(after - expected) > Math.max(1e-9, Math.abs(expected) * 1e-8)) return null;
    if (before === 0 || before * after < 0) return time;
    expected = before;
  }
  return null;
}

function createOpenTimeReader({request = hlPost, now = Date.now, intervalMs = 15000, timeoutMs = 20000} = {}) {
  const cache = new Map(), pages = new Map(), pending = new Map();
  let active = false, nextAt = 0;
  async function getFills(position) {
    const address=position.address.toLowerCase(), saved=pages.get(address), running=pending.get(address);
    if(saved && saved.at>=position.observedAt && now()-saved.at<60000)return saved.fills;
    if(running && running.at>=position.observedAt)return running.promise;
    if(active || now()<nextAt)throw Object.assign(new Error('开仓时间补查繁忙，请稍后重新展开'),{status:429});
    active=true;
    const at=now();nextAt=at+intervalMs;
    const promise=(async()=>{
      const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),timeoutMs);
      try {
        const data=await request({type:'userFills',user:address,aggregateByTime:false},0,{priority:'history',signal:controller.signal});
        if(controller.signal.aborted)throw new Error('开仓时间查询超时');
        if(!Array.isArray(data)||data.length>2000||data.some(f=>!f||typeof f.coin!=='string'||!Number.isFinite(Number(f.time))||Number(f.time)<=0))throw new Error('成交响应异常');
        const fills=data.map(({coin,time,tid,startPosition,sz,side})=>({coin,time,tid,startPosition,sz,side}));
        pages.delete(address);pages.set(address,{at,fills});
        while(pages.size>20)pages.delete(pages.keys().next().value);
        return fills;
      }finally{clearTimeout(timer);active=false;}
    })();
    pending.set(address,{at,promise});
    try{return await promise;}finally{pending.delete(address);}
  }
  return async function read(coin, position) {
    const key=`${position.address.toLowerCase()}:${coin}:${position.observedAt}:${position.side}:${position.size}`;
    const cached=cache.get(key);
    if(cached && cached.expires>now())return cached.value;
    const fills=await getFills(position);
    const value={openTime:inferOpenTime(fills,coin,position)};
    cache.delete(key);cache.set(key,{value,expires:now()+600000});
    while(cache.size>1000)cache.delete(cache.keys().next().value);
    return value;
  };
}

module.exports = {inferOpenTime, createOpenTimeReader, readOpenTime:createOpenTimeReader()};
