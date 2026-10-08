const {sortRows}=require('./radarSort');
const DAY=86400000;
const WINDOWS=[30,60,90];
const RULE_VERSION=3;
// Confirmed 20-for-1 split; historical daily closes before this UTC day use old units.
// https://www.binance.com/en/support/announcement/detail/2ce887ba8fe14fdaa088e5bed7553a4e
const KORU_SPLIT=Date.parse('2026-07-15T00:00:00Z');
function normalizeHistory(symbol,bars){
  if(symbol!=='KORUUSDT')return {bars,note:''};
  const before=bars.filter(b=>b.openTime<KORU_SPLIT).sort((a,b)=>a.openTime-b.openTime);
  const after=bars.filter(b=>b.openTime>=KORU_SPLIT).sort((a,b)=>a.openTime-b.openTime);
  if(!before.length||!after.length)return {bars,note:''};
  const ratio=before.at(-1).close/after[0].close;
  if(ratio>10&&ratio<40)return {bars:bars.map(b=>b.openTime<KORU_SPLIT?{...b,close:b.close/20}:b),note:'已按 2026-07-15 的 1 拆 20 调整历史收盘价'};
  if(ratio>=.25&&ratio<=4)return {bars,note:'历史收盘价已处于拆分后价格口径'};
  throw Error('拆分价格边界异常，暂不计算');
}
function framesFor(symbol,bars,day){
  const normalized=normalizeHistory(symbol,bars);let points=[];
  const frames=Object.fromEntries(WINDOWS.map(days=>{const {points:series=[],...metrics}=analyze(normalized.bars,days,day);if(days===90)points=series;return [days,metrics];}));
  return {frames,points,adjustmentNote:normalized.note};
}
function analyze(bars,days,asOf) {
  const end=Math.floor(asOf/DAY)*DAY;
  const unique=new Map();
  for(const bar of bars) {
    if(!Number.isFinite(bar.openTime)||bar.openTime%DAY!==0||bar.closeTime>=end||bar.closeTime!==bar.openTime+DAY-1||!Number.isFinite(bar.close)||bar.close<=0)continue;
    if(unique.has(bar.openTime)&&unique.get(bar.openTime)!==bar.close)return {direction:'INSUFFICIENT',reason:'日线重复且价格冲突',days:0};
    unique.set(bar.openTime,bar.close);
  }
  const points=[...unique].filter(([time])=>time>=end-(days+1)*DAY&&time<end).sort((a,b)=>a[0]-b[0]);
  if(points.length<21||points.at(-1)?.[0]!==end-DAY||points.some((p,i)=>i&&p[0]-points[i-1][0]!==DAY))
    return {direction:'INSUFFICIENT',reason:'已收盘日线不足或存在缺口',days:Math.max(0,points.length-1),points};
  const requestedDays=days;days=points.length-1;
  const prices=points.map(p=>p[1]),logs=prices.map(Math.log),n=logs.length;
  const mean=logs.reduce((a,b)=>a+b,0)/n,center=(n-1)/2;
  let covariance=0,variance=0,total=0,path=0,up=0,down=0,peak=prices[0],trough=prices[0],drawdown=0,rebound=0;
  for(let i=0;i<n;i++) {
    covariance+=(i-center)*(logs[i]-mean);variance+=(i-center)**2;total+=(logs[i]-mean)**2;
    peak=Math.max(peak,prices[i]);trough=Math.min(trough,prices[i]);
    drawdown=Math.max(drawdown,1-prices[i]/peak);rebound=Math.max(rebound,prices[i]/trough-1);
    if(i){path+=Math.abs(logs[i]-logs[i-1]);if(prices[i]>prices[i-1])up++;if(prices[i]<prices[i-1])down++;}
  }
  const change=(prices.at(-1)/prices[0]-1)*100,slope=covariance/variance;
  const r2=total>1e-16?Math.min(1,covariance**2/(variance*total)):0;
  const efficiency=path>0?Math.min(1,Math.abs(logs.at(-1)-logs[0])/path):0;
  const recentDays=Math.min(20,days),recentChange=(prices.at(-1)/prices.at(-1-recentDays)-1)*100;
  const monthDays=Math.min(30,days),monthChange=(prices.at(-1)/prices.at(-1-monthDays)-1)*100;
  // Compare consecutive thirds, allowing daily pullbacks without accepting a single jump.
  const chunks=[0,1,2].map(i=>prices.slice(Math.floor(i*n/3),Math.floor((i+1)*n/3)));
  const highs=chunks.map(chunk=>Math.max(...chunk)),lows=chunks.map(chunk=>Math.min(...chunk));
  const structureUp=highs[0]<highs[1]&&highs[1]<highs[2]&&lows[0]<lows[1]&&lows[1]<lows[2];
  const structureDown=highs[0]>highs[1]&&highs[1]>highs[2]&&lows[0]>lows[1]&&lows[1]>lows[2];
  const strong=Math.abs(change)>=5&&r2>=0.35&&efficiency>=0.1;
  const direction=strong&&change>0&&slope>0&&recentChange>0&&monthChange>0&&structureUp?'UP'
    :strong&&change<0&&slope<0&&recentChange<0&&monthChange<0&&structureDown?'DOWN'
    :change>=5&&recentChange<=-5?'TURN_DOWN':change<=-5&&recentChange>=5?'TURN_UP':'NEUTRAL';
  let streak=0;const sign=Math.sign(prices.at(-1)-prices.at(-2));
  for(let i=n-1;i>0&&sign&&Math.sign(prices[i]-prices[i-1])===sign;i--)streak++;
  return {direction,days,requestedDays,partial:days<requestedDays,change,recentChange,recentDays,monthChange,monthDays,structureUp,structureDown,r2,efficiency,upDays:up,downDays:down,streak:streak*sign,
    maxDrawdown:drawdown*100,maxRebound:rebound*100,score:Math.round(100*r2*efficiency),points};
}
function createService({catalog=()=>require('./tradfiMarkets').getLongTrendContracts(),
  fetchBars=(symbol,day)=>require('./tradfiMarkets').getRadarDailyHistory(symbol,day),
  fetchPrices=null,now=Date.now,pause=()=>new Promise(r=>setTimeout(r,350)),getDb=()=>require('./db').getDb()}={}) {
  let initialized=false,running=false,task=null,nextAttempt=0,done=0,total=0,error='',records=new Map();
  let prices=new Map(),priceTask=null,priceAttempt=0;
  function refreshPrices(){
    if(!fetchPrices||priceTask||now()<priceAttempt)return;
    priceAttempt=now()+15000;
    priceTask=Promise.resolve().then(fetchPrices).then(result=>{prices=new Map(result.map(row=>[row.symbol,row]));}).catch(()=>{}).finally(()=>{priceTask=null;});
  }
  function livePrice(symbol){const quote=prices.get(symbol);return {currentPrice:quote?.price??null,priceAsOf:quote?.time??null,priceStale:!quote||now()-quote.time>60000};}
  function init() {
    if(initialized)return;
    const db=getDb();db.exec('CREATE TABLE IF NOT EXISTS radar_long_trends(symbol TEXT PRIMARY KEY,payload_json TEXT NOT NULL)');
    for(const row of db.prepare('SELECT symbol,payload_json FROM radar_long_trends').all()) {
      try {const value=JSON.parse(row.payload_json);
        if(value.market?.assetType!=='TRADFI')continue;
        if(value.ruleVersion===2&&value.points?.length){
          const bars=value.points.map(([openTime,close])=>({openTime,close,closeTime:openTime+DAY-1}));
          Object.assign(value,framesFor(row.symbol,bars,value.asOf),{ruleVersion:RULE_VERSION});
          db.prepare('UPDATE radar_long_trends SET payload_json=? WHERE symbol=?').run(JSON.stringify(value),row.symbol);
        }
        if(value.ruleVersion===RULE_VERSION)records.set(row.symbol,value);
      }catch{}
    }
    initialized=true;
  }
  function refresh() {
    init();if(task||now()<nextAttempt)return task;
    running=true;error='';done=0;const day=Math.floor(now()/DAY)*DAY;
    let consecutiveFailures=0,retryMs=5*60000;
    // Defer collection so an HTTP read never waits for Binance or a full scan.
    task=new Promise(resolve=>setImmediate(resolve)).then(async()=>{
      const result=await catalog();
      if(result.stale||!Array.isArray(result.contracts)||!result.contracts.length)throw Error('合约清单未更新');
      const contracts=result.contracts.filter(market=>market.assetType==='TRADFI');
      if(contracts.length>2000)throw Error('合约数量超出本轮处理上限');
      total=contracts.length;
      const live=new Set(contracts.map(c=>c.symbol));
      for(const symbol of records.keys())if(!live.has(symbol)){records.delete(symbol);getDb().prepare('DELETE FROM radar_long_trends WHERE symbol=?').run(symbol);}
      // Publish the full catalog before collection, so pending/failed symbols never disappear.
      for(const market of contracts)if(!records.has(market.symbol))records.set(market.symbol,{market,frames:{},points:[],asOf:null,error:'等待日线采集',ruleVersion:RULE_VERSION});
      for(const market of contracts) {
        const previous=records.get(market.symbol);
        const metadata={symbol:market.symbol,name:market.name,baseAsset:market.baseAsset,assetType:market.assetType};
        if(previous?.asOf===day&&!previous.error){records.set(market.symbol,{...previous,market:metadata});done++;continue;}
        try {
          const bars=await fetchBars(market.symbol,day);
          const {points,frames,adjustmentNote}=framesFor(market.symbol,bars,day);
          const latestBarAt=points.at(-1)?.[0]??null;
          const rowError=latestBarAt!==day-DAY?'日线尚未更新或存在异常':'';
          const value={market:metadata,frames,points,adjustmentNote,latestBarAt,asOf:day,ruleVersion:RULE_VERSION,error:rowError};
          if(rowError)error='部分日线尚未更新，稍后重试';
          getDb().prepare('INSERT OR REPLACE INTO radar_long_trends VALUES(?,?)').run(market.symbol,JSON.stringify(value));
          records.set(market.symbol,value);
          consecutiveFailures=0;
        } catch(err) {
          error='部分日线读取失败，保留旧结果并稍后重试';
          const value=previous?{...previous,error:'日线未更新'}:{market:{symbol:market.symbol,name:market.name,baseAsset:market.baseAsset,assetType:market.assetType},frames:{},asOf:null,error:'日线读取失败',ruleVersion:RULE_VERSION};
          records.set(market.symbol,value);
          if([418,429].includes(err.response?.status)) {
            const raw=err.response?.headers?.['retry-after'];
            const delay=Number.isFinite(Number(raw))?Number(raw)*1000:Date.parse(raw)-now();
            if(Number.isFinite(delay))retryMs=Math.max(retryMs,delay);
            throw Error('行情源限流，暂停本轮并稍后重试');
          }
          if(++consecutiveFailures>=3)throw Error('行情源连续读取失败，暂停本轮并稍后重试');
        }
        done++;await pause();
      }
    }).catch(err=>{error=err.message||'长期趋势暂未更新';}).finally(()=>{
      running=false;task=null;nextAttempt=error?now()+retryMs:day+DAY+60000;
    });
    return task;
  }
  function snapshot({days=90,direction='ALL',assetType='ALL',search='',page=1,watchSymbols=[],focus='',sort='score',order='desc'}={}) {
    init();void refresh();refreshPrices();
    const day=Math.floor(now()/DAY)*DAY,query=String(search).slice(0,80).toLowerCase();
    let rows=[...records.values()].map(record=>({...record.market,...livePrice(record.market.symbol),adjustmentNote:record.adjustmentNote,...(record.frames[days]||{direction:'INSUFFICIENT',days:0,reason:record.error}),
      latestBarAt:record.latestBarAt??record.points?.at(-1)?.[0]??null,
      asOf:record.asOf,stale:record.asOf!==day||Boolean(record.error),error:record.error}));
    const coverage={total:total||records.size,loaded:records.size,fresh:rows.filter(r=>!r.stale).length,insufficient:rows.filter(r=>r.direction==='INSUFFICIENT').length};
    const allRows=rows;
    rows=rows.filter(r=>(assetType==='ALL'||r.assetType===assetType)&&(!query||`${r.symbol} ${r.name}`.toLowerCase().includes(query)))
      .filter(r=>direction==='ALL'||(direction==='TREND'?['UP','DOWN'].includes(r.direction):r.direction===direction))
;
    rows=sortRows(rows,row=>sort==='price'?records.get(row.symbol)?.points?.at(-1)?.[1]:row[sort],order);
    const count=rows.length,pages=Math.max(1,Math.ceil(count/20)),current=Math.min(pages,Math.max(1,Math.floor(page)||1));
    const visible=rows.slice((current-1)*20,current*20).map(row=>({...row,points:(records.get(row.symbol)?.points||[]).slice(-(days+1))}));
    const withPoints=row=>({...row,points:(records.get(row.symbol)?.points||[]).slice(-(days+1))});
    const watched=[...new Set(watchSymbols)].slice(0,30).map(symbol=>allRows.find(row=>row.symbol===symbol)||{symbol,name:symbol,assetType:'TRADFI',direction:'INSUFFICIENT',days:0,stale:true,reason:running?'正在核对合约清单':'未在当前可交易传统金融合约清单中',error:'暂无可用日线'}).map(withPoints);
    const focused=allRows.find(row=>row.symbol===focus);
    return {sort,order,watched,focused:focused?withPoints(focused):null,catalog:allRows.map(({symbol,name})=>({symbol,name})),rows:visible,count,page:current,pages,days,running,done,total,coverage,error,ruleVersion:RULE_VERSION,
      source:'Binance USDⓈ-M Futures · 已收盘日线',asOf:day};
  }
  return {snapshot,refresh};
}
const service=createService({fetchPrices:()=>require('./tradfiMarkets').getLongTrendPrices()});
module.exports={...service,createService,analyze,normalizeHistory,WINDOWS};
