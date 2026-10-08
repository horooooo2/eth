const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {createRequire}=require('node:module');
const {createStream}=require('../lib/radarStream');
const {prepareDailyChart}=require('../lib/radarRealtime');

test('daily candles exclude the open UTC day and split-adjust every OHLC field',()=>{
  const day=86400000,boundary=Date.parse('2026-07-15T00:00:00Z'),now=boundary+day;
  const bar=(time,price)=>({openTime:time,closeTime:time+day-1,open:price,high:price*1.1,low:price*.9,close:price});
  const result=prepareDailyChart({available:true,stale:false,bars:[bar(boundary-day,1000),bar(boundary,50),bar(now,55)]},'KORUUSDT',now+123);
  assert.equal(result.bars.length,2);assert.equal(result.bars[0].open,50);assert.equal(result.bars[0].high,55);assert.equal(result.bars[0].low,45);assert.equal(result.bars[0].close,50);
  assert.equal(result.latestBarTime,boundary);assert.equal(result.stale,false);
  const bad=prepareDailyChart({available:true,bars:[bar(boundary-day,5000),bar(boundary,50)]},'KORUUSDT',now);
  assert.equal(bad.available,false);assert.equal(bad.bars.length,0);assert.match(bad.error,/边界异常/);
});

test('snapshot cursor catches updates between HTTP bootstrap and subscription; deletes are replayed',()=>{
  const stream=createStream(),initial=stream.snapshot();
  stream.commit({...initial,quotes:[{symbol:'A',lastPrice:'10'},{symbol:'B',lastPrice:'20'}]});
  stream.commit({...stream.snapshot(),quotes:[{symbol:'A',lastPrice:'11'}]});
  const replay=stream.resume(initial);
  assert.equal(replay.seq,2);assert.equal(stream.snapshot().seq,2);
  assert.equal(stream.snapshot().type,'radarSnapshot');
  assert.equal(replay.events.length,2);assert.deepEqual(replay.events[1].patch.quotes.remove,['B']);
  assert.equal(stream.resume(stream.snapshot()).events.length,0);
});
test('replay is bounded and validates restart, stale, future and invalid cursors',()=>{
  const stream=createStream({maxEvents:2}),initial=stream.snapshot();
  for(let i=0;i<3;i++)stream.commit({...stream.snapshot(),updatedAt:String(i)});
  assert.equal(stream.resume(initial).type,'resyncRequired');
  for(const cursor of [{epoch:'old',seq:3},{epoch:initial.epoch,seq:4},{epoch:initial.epoch,seq:-1},{epoch:initial.epoch,seq:1.5}])assert.equal(stream.resume(cursor).type,'resyncRequired');
  assert.equal(stream.resume({epoch:initial.epoch,seq:1}).events.length,2);
  const tiny=createStream({maxBytes:1}),before=tiny.snapshot();tiny.commit({...before,error:'offline'});
  assert.equal(tiny.resume(before).type,'resyncRequired');
});
test('price updates omit unchanged daily history and metrics; unchanged captures publish nothing',()=>{
  const stream=createStream();let publications=0;stream.subscribe(()=>publications++);
  const row={symbol:'WDCUSDT',currentPrice:10,points:[[1,9],[2,10]],frames:{90:{change:10}}};
  stream.commit({...stream.snapshot(),long:{rows:[row],running:false,error:''}});
  const before=stream.snapshot();stream.commit({...before,long:{...before.long,rows:[{...row,currentPrice:11}]}});
  const patch=stream.resume(before).events[0].patch.long.upserts[0];
  assert.equal(patch.currentPrice,11);assert.equal(patch.points,undefined);assert.equal(patch.frames,undefined);
  stream.commit(stream.snapshot());assert.equal(publications,2);
  assert.deepEqual(stream.snapshot().long.rows[0].points,row.points);
});
test('all short windows share one ticker, identical observation time and four upstream workers',async()=>{
  const filename=require.resolve('../lib/tradfiMarkets'),realRequire=createRequire(filename);
  let active=0,peak=0,tickers=0,baselines=0,baseSeen=false;
  const at=Date.now();
  const symbols=Array.from({length:9},(_,i)=>({symbol:`TEST${i}USDT`,baseAsset:`TEST${i}`,quoteAsset:'USDT',status:'TRADING',contractType:'TRADIFI_PERPETUAL',underlyingSubType:['TradFi']}));
  const context={module:{exports:{}},process:{env:{}},Date,setTimeout,require:id=>id==='axios'?{create:()=>({get:async(url,options)=>{
    if(url.endsWith('exchangeInfo'))return {data:{symbols}};
    if(url.endsWith('24hr')){tickers++;return {data:symbols.map(row=>({symbol:row.symbol,lastPrice:'110',priceChangePercent:'27',closeTime:at}))};}
    assert.equal(baseSeen,true);active++;peak=Math.max(peak,active);baselines++;
    await new Promise(resolve=>setTimeout(resolve,2));active--;
    return {data:[[options.params.startTime,'100']]};
  }})}:realRequire(id)};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),context);
  const api=context.module.exports;
  const result=await api.getRadarStreamQuotes(symbols.map(row=>row.symbol),()=>{baseSeen=true;});
  assert.equal(tickers,1);assert.equal(baselines,18);assert.ok(peak<=4);
  for(const row of result.quotes){assert.equal(row.priceChangePercent,'27');for(const period of ['5m','1h']){assert.ok(Math.abs(row.changes[period]-10)<1e-8);assert.equal(row.changeMeta[period].asOf,at);}}
  await api.getRadarStreamQuotes(symbols.map(row=>row.symbol));assert.equal(baselines,18);
});
