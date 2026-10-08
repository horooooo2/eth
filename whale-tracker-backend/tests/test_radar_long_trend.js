const test=require('node:test'),assert=require('node:assert/strict');
require('./helpers/isolateSqlite');
const {getDb}=require('../lib/db');
const {analyze,createService}=require('../lib/radarLongTrend');
const DAY=86400000,day=Math.floor(Date.now()/DAY)*DAY;
const series=(price,n=91,end=day)=>Array.from({length:n},(_,i)=>({openTime:end-(n-i)*DAY,closeTime:end-(n-i-1)*DAY-1,close:price(i)}));
test('rising and falling paths are symmetric and do not require an unbroken daily streak',()=>{
  const up=analyze(series(i=>100*Math.exp(.01*i+(i%2?.003:-.003))),90,day);
  const down=analyze(series(i=>100*Math.exp(-.01*i+(i%2?.003:-.003))),90,day);
  assert.equal(up.direction,'UP');assert.equal(down.direction,'DOWN');assert.ok(up.r2>.99);assert.ok(down.r2>.99);
  const pullback=analyze(series(i=>100*Math.exp(.01*i+(i%4===0?-.018:0))),90,day);
  assert.equal(pullback.direction,'UP');assert.ok(pullback.downDays>0);
});
test('flat, jump-only and reversed recent paths are not sustained trends',()=>{
  assert.equal(analyze(series(()=>100),90,day).direction,'NEUTRAL');
  assert.equal(analyze(series(i=>i===90?200:100),90,day).direction,'NEUTRAL');
  assert.equal(analyze(series(i=>100*Math.exp(i<=70?.01*i:.7-.02*(i-70))),90,day).direction,'TURN_DOWN');
});
test('90-day return needs 91 completed bars; open candles, gaps and conflicting duplicates are excluded',()=>{
  const bars=series(i=>100+i);
  assert.ok(Math.abs(analyze(bars,90,day).change-90)<1e-10);
  const result=analyze([...bars,{openTime:day,closeTime:day+DAY-1,close:1000000}],90,day);
  assert.deepEqual(result,analyze(bars,90,day));
  assert.equal(analyze(bars.slice(1),90,day).days,89);
  assert.equal(analyze(bars.filter((_,i)=>i!==40),90,day).direction,'INSUFFICIENT');
  assert.equal(analyze([...bars,{...bars[0],close:1}],90,day).direction,'INSUFFICIENT');
  assert.equal(analyze(bars.slice(1),30,day).days,30);
});
test('scan is single-flight, serialized, persistent, paged, and preserves failures as stale',async()=>{
  let clock=day+60000,calls=0,active=0,maxActive=0,fail=false;
  const contracts=Array.from({length:25},(_,i)=>({symbol:`COIN${i}USDT`,name:`Coin ${i}`,baseAsset:`COIN${i}`,assetType:'TRADFI'}));
  const options={getDb,now:()=>clock,catalog:async()=>({contracts}),pause:async()=>{},fetchBars:async()=>{
    calls++;active++;maxActive=Math.max(maxActive,active);await new Promise(r=>setImmediate(r));active--;
    if(fail)throw Object.assign(Error('limited'),{response:{status:429}});
    return series(i=>100+i,91,Math.floor(clock/DAY)*DAY);
  }};
  const service=createService(options);
  assert.equal(service.snapshot().running,true);
  const pending=service.refresh();assert.equal(service.refresh(),pending);await pending;
  assert.equal(calls,25);assert.equal(maxActive,1);
  assert.equal(service.snapshot().rows.length,20);assert.equal(service.snapshot({page:2}).rows.length,5);
  assert.equal(service.snapshot().rows[0].latestBarAt,day-DAY);
  assert.equal(service.snapshot({direction:'DOWN'}).count,0);
  const restored=createService(options);await restored.refresh();assert.equal(calls,25);
  clock+=DAY;fail=true;await restored.refresh();assert.equal(calls,26);
  const old=restored.snapshot();assert.equal(old.rows.length,20);assert.ok(old.rows.every(r=>r.stale));assert.match(old.error,/限流/);
  await restored.refresh();assert.equal(calls,26);
});

test('upstream outages stop after three failures and reads remain available during collection',async()=>{
  getDb().prepare('DELETE FROM radar_long_trends').run();
  let calls=0,release;
  const contracts=Array.from({length:10},(_,i)=>({symbol:`TEST${i}USDT`,name:'Test',assetType:'TRADFI'}));
  const service=createService({getDb,now:()=>day,catalog:async()=>({contracts}),pause:async()=>{},fetchBars:async()=>{
    calls++;if(calls===1)await new Promise(r=>{release=r;});throw Error('offline');
  }});
  const first=service.snapshot();assert.equal(first.running,true);
  while(!release)await new Promise(r=>setImmediate(r));
  const read=service.snapshot();assert.equal(read.running,true);assert.equal(calls,1);
  const task=service.refresh();release();await task;
  assert.equal(calls,3);assert.equal(service.snapshot().running,false);assert.match(service.snapshot().error,/连续/);
  await service.refresh();assert.equal(calls,3);
});

test('short history uses actual interval without inventing a full 90-day return',()=>{
  const partial=analyze(series(i=>100+i,58),90,day);
  assert.equal(partial.days,57);assert.equal(partial.partial,true);assert.ok(Math.abs(partial.change-57)<1e-8);
  assert.equal(partial.direction,'UP');assert.equal(partial.recentDays,20);assert.equal(partial.monthDays,30);
  assert.equal(analyze(series(i=>100+i,20),90,day).direction,'INSUFFICIENT');
  assert.equal(analyze(series(i=>100+i,58).filter((_,i)=>i!==10),90,day).direction,'INSUFFICIENT');
});
test('only TradFi is fetched; catalog and watch rows survive filters, pagination and failures',async()=>{
  getDb().prepare('DELETE FROM radar_long_trends').run();
  const calls=[];
  const contracts=[{symbol:'BTCUSDT',assetType:'CRYPTO'},...Array.from({length:25},(_,i)=>({symbol:`STOCK${i}USDT`,name:`Stock ${i}`,assetType:'TRADFI'}))];
  const service=createService({getDb,now:()=>day,catalog:async()=>({contracts}),pause:async()=>{},fetchBars:async(symbol)=>{calls.push(symbol);return series(i=>100+i);}});
  await service.refresh();assert.equal(calls.length,25);assert.ok(!calls.includes('BTCUSDT'));
  const result=service.snapshot({direction:'DOWN',search:'no-match',page:2,watchSymbols:['STOCK24USDT'],focus:'STOCK23USDT'});
  assert.equal(result.count,0);assert.equal(result.catalog.length,25);assert.equal(result.watched[0].symbol,'STOCK24USDT');assert.equal(result.watched[0].points.length,91);assert.equal(result.focused.symbol,'STOCK23USDT');
  getDb().prepare('DELETE FROM radar_long_trends').run();
  const failed=createService({getDb,now:()=>day,catalog:async()=>({contracts}),pause:async()=>{},fetchBars:async()=>{throw Error('offline');}});
  await failed.refresh();assert.equal(failed.snapshot().count,25);assert.equal(failed.snapshot({search:'STOCK24'}).rows[0].error,'等待日线采集');
});

test('sorting applies across the full filtered result before pagination and leaves watches unchanged',async()=>{
  getDb().prepare('DELETE FROM radar_long_trends').run();
  const contracts=Array.from({length:25},(_,i)=>({symbol:`SORT${i}USDT`,assetType:'TRADFI'}));
  const service=createService({getDb,now:()=>day,catalog:async()=>({contracts}),pause:async()=>{},fetchBars:async symbol=>series(i=>100+i*Number(symbol.match(/SORT(\d+)/)[1]))});
  await service.refresh();
  const options={sort:'change',order:'desc',watchSymbols:['SORT0USDT']};
  const first=service.snapshot(options),second=service.snapshot({...options,page:2});
  assert.equal(first.rows[0].symbol,'SORT24USDT');assert.equal(second.rows.at(-1).symbol,'SORT0USDT');assert.ok(first.rows.at(-1).change>=second.rows[0].change);
  assert.equal(first.watched[0].symbol,'SORT0USDT');assert.equal(service.snapshot({sort:'price',order:'asc'}).rows[0].symbol,'SORT0USDT');
});
const {normalizeHistory}=require('../lib/radarLongTrend');
test('KORU split normalizes historical closes once and does not manufacture a 95 percent loss',()=>{
  const end=Date.parse('2026-08-01T00:00:00Z'),split=Date.parse('2026-07-15T00:00:00Z');
  const adjusted=series(i=>25*Math.exp(i*.001),91,end);
  const raw=adjusted.map(b=>({...b,close:b.close*(b.openTime<split?20:1)}));
  const normalized=normalizeHistory('KORUUSDT',raw);
  assert.match(normalized.note,/20/);assert.ok(normalized.bars.every((bar,i)=>Math.abs(bar.close-adjusted[i].close)<1e-10));
  assert.deepEqual(normalizeHistory('KORUUSDT',normalized.bars).bars,normalized.bars);
  assert.ok(raw[0].close>400);assert.ok(analyze(normalized.bars,90,end).change>0);
  assert.deepEqual(normalizeHistory('WDCUSDT',raw).bars,raw);
});
test('current prices refresh in background, share requests and retain stale values on failure',async()=>{
  getDb().prepare('DELETE FROM radar_long_trends').run();
  let clock=day,calls=0,fail=false;
  const service=createService({getDb,now:()=>clock,catalog:async()=>({contracts:[{symbol:'WDCUSDT',assetType:'TRADFI'}]}),pause:async()=>{},fetchBars:async()=>series(i=>100+i),fetchPrices:async()=>{calls++;if(fail)throw Error('offline');return [{symbol:'WDCUSDT',price:123,time:clock}];}});
  service.snapshot();service.snapshot();await service.refresh();await new Promise(r=>setImmediate(r));
  assert.equal(calls,1);assert.equal(service.snapshot().rows[0].currentPrice,123);
  assert.equal(service.snapshot().rows[0].priceStale,false);
  clock+=61000;fail=true;service.snapshot();await new Promise(r=>setImmediate(r));
  assert.equal(service.snapshot().rows[0].currentPrice,123);assert.equal(service.snapshot().rows[0].priceStale,true);assert.equal(calls,2);
});

test('v2 persisted daily closes migrate and recalculate without fetching history again',async()=>{
  getDb().prepare('DELETE FROM radar_long_trends').run();
  const end=Date.parse('2026-08-01T00:00:00Z'),split=Date.parse('2026-07-15T00:00:00Z');
  const bars=series(i=>25+i*.01,91,end).map(b=>({...b,close:b.close*(b.openTime<split?20:1)}));
  const market={symbol:'KORUUSDT',assetType:'TRADFI'};
  getDb().prepare('INSERT INTO radar_long_trends VALUES(?,?)').run(market.symbol,JSON.stringify({market,points:bars.map(b=>[b.openTime,b.close]),frames:{},asOf:end,error:'',ruleVersion:2}));
  let calls=0;
  const service=createService({getDb,now:()=>end,catalog:async()=>({contracts:[market]}),pause:async()=>{},fetchBars:async()=>{calls++;return bars;}});
  const row=service.snapshot().rows[0];assert.equal(row.days,90);assert.ok(row.change>0);assert.ok(row.points[0][1]<30);
  await service.refresh();assert.equal(calls,0);
});
