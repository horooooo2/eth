const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const filename = require.resolve('../lib/tradfiMarkets');

test('radar fetches only the selected interval and shares the bulk ticker with long trends', async () => {
  const realRequire = createRequire(filename);
  const calls = [];
  const context = { module: { exports: {} }, process: { env: {} }, Date,
    require: id => id === 'axios' ? { create: () => ({ get: async (url, options) => {
      calls.push({ url, params: options?.params });
      if (url.endsWith('exchangeInfo')) return { data: { symbols: [{ symbol: 'XAUUSDT', baseAsset: 'XAU', quoteAsset: 'USDT', status: 'TRADING', contractType: 'TRADIFI_PERPETUAL', underlyingSubType: ['TradFi'] }] } };
      if (url.endsWith('24hr')) return { data: [{ symbol: 'XAUUSDT', lastPrice: '110', priceChangePercent: '2', closeTime: Date.now() }] };
      return { data: [[options.params.startTime, '100']] };
    } }) } : realRequire(id) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context);
  const api = context.module.exports;
  const [short, prices] = await Promise.all([api.getRadarQuotes('XAUUSDT', '5m'), api.getLongTrendPrices()]);
  assert.deepEqual(Object.keys(short.quotes[0].changes), ['5m']);
  assert.equal(prices[0].price, 110);
  assert.equal(calls.filter(call => call.url.endsWith('24hr')).length, 1);
  assert.equal(calls.filter(call => call.url.endsWith('klines')).length, 1);
  await api.getRadarQuotes('XAUUSDT', '24h');
  assert.equal(calls.filter(call => call.url.endsWith('klines')).length, 1);
});
test('rolling changes use a minute baseline one full hour earlier and identify failed refreshes', async () => {
  let clock = Date.UTC(2026, 9, 5, 10, 1, 32), failed = false;
  const requests = [];
  const realRequire = createRequire(filename);
  const context = { module: { exports: {} }, process: { env: {} }, Date: { now: () => clock },
    require: id => id === 'axios' ? { create: () => ({ get: async (url, options) => {
      requests.push(options.params);
      if (failed) throw Error('offline');
      return { data: [[options.params.startTime, '100']] };
    } }) } : realRequire(id) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.testChange = fetchShortChange;', context);
  const read = context.module.exports.testChange;
  const first = await read('BTCUSDT', '1h', 110, clock);
  assert.equal(requests[0].interval, '1m');
  assert.equal(requests[0].startTime, Date.UTC(2026, 9, 5, 9, 1));
  assert.ok(Math.abs(first.change - 10) < 1e-9);
  const newer = await read('BTCUSDT', '1h', 120, clock + 1000);
  assert.equal(requests.length, 1);
  assert.ok(Math.abs(newer.change - 20) < 1e-9);
  clock += 60000; failed = true;
  const old = await read('BTCUSDT', '1h', 120, clock);
  assert.equal(old.stale, true); assert.equal(old.asOf, newer.asOf);
  assert.equal(old.change, newer.change);
});

test('market short intervals preserve 24h values, share baseline requests and limit concurrency', async () => {
  const realRequire = createRequire(filename);
  let active = 0, peak = 0, calls = 0;
  const context = { module: { exports: {} }, process: { env: {} }, Date, setTimeout,
    require: id => id === 'axios' ? { create: () => ({ get: async (url, options) => {
      assert.equal(url, '/fapi/v1/klines');
      calls++; active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2)); active--;
      return { data: [[options.params.startTime, '100']] };
    } }) } : realRequire(id) };
  const seed = `radarMarketCache = { expiresAt: Date.now()+60000, updatedAt: 'seed', quotes: Array.from({length:9}, (_,i)=>({symbol:'TEST'+i+'USDT',lastPrice:'110',priceChangePercent:'27',closeTime:Date.now(),stale:false})) };`;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\n' + seed, context);
  const read = context.module.exports.getRadarMarketQuotes;
  const [a,b] = await Promise.all([read('1h'),read('1h')]);
  assert.equal(calls,9); assert.ok(peak<=4);
  assert.ok(Math.abs(a.quotes[0].changes['1h']-10)<1e-8);
  assert.equal(a.quotes[0].changes['5m'],undefined);
  assert.equal(a.quotes[0].priceChangePercent,'27');
  assert.equal(b.quotes.length,9);
  assert.equal((await read()).quotes[0].changes,undefined);
  await read('1h'); assert.equal(calls,9);
});

test('rolling extrema share the baseline request, preserve real wicks and mark missing minutes unavailable',async()=>{
  const clock=Date.UTC(2026,9,8,10,1,32);let requests=0;
  const realRequire=createRequire(filename);
  const context={module:{exports:{}},process:{env:{}},Date:{now:()=>clock},
    require:id=>id==='axios'?{create:()=>({get:async(_url,options)=>{
      requests++;const {startTime,limit,endTime}=options.params;
      assert.equal(limit,6);assert.equal(endTime,clock);
      const size=options.params.symbol==='BROKENUSDT'?limit-1:limit;
      return {data:Array.from({length:size},(_,i)=>[startTime+i*60000,'100',i===2?'150':'110',i===3?'50':'90','105','10',startTime+(i+1)*60000-1])};
    }})}:realRequire(id)};
  vm.runInNewContext(fs.readFileSync(filename,'utf8')+'\nmodule.exports.read=fetchShortChange;',context);
  const read=context.module.exports.read;
  const first=await read('BTCUSDT','5m',105,clock);
  assert.equal(first.highPrice,150);assert.equal(first.lowPrice,50);assert.equal(first.rangeStale,false);
  const peak=await read('BTCUSDT','5m',170,clock+1000);
  const later=await read('BTCUSDT','5m',110,clock+2000);
  assert.equal(requests,1);assert.equal(peak.highPrice,170);assert.equal(later.highPrice,170);assert.equal(later.rangeStale,true);
  const missing=await read('BROKENUSDT','5m',105,clock);
  assert.equal(missing.highPrice,null);assert.equal(missing.lowPrice,null);
  assert.equal(missing.rangeStale,true);assert.ok(Math.abs(missing.change-5)<1e-9);
});
