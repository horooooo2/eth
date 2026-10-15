'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHotNewsService,normalize,timestamp,articleUrl}=require('../lib/hotNews');
const now=Date.parse('2026-10-15T19:30:00+08:00');
const row=(title='美联储政策消息',time='2026-10-15 19:20:00')=>({title,summary:'【'+title+'】公开快讯摘要',showTime:time,code:'202610153897086987',titleColor:0});
test('feeds keep original Shanghai publication times, reject stale/future rows and deduplicate titles',()=>{
  assert.equal(timestamp('2026-10-15 19:20:00'),Date.parse('2026-10-15T11:20:00Z'));
  const rows=normalize([row(),row(),row('过期','2026-10-12 19:20:00'),row('未来','2026-10-16 19:20:00'),row('无日期','bad')],'eastmoney',now);
  assert.equal(rows.length,1);assert.equal(rows[0].category,'宏观');assert.match(rows[0].url,/finance\.eastmoney\.com/);
  assert.equal(articleUrl('https://finance.eastmoney.com.evil.test/x'),'');assert.equal(articleUrl('https://user:pass@finance.sina.cn/x'),'');
});
test('Sina fallback extracts readable text and retains the supplied original link',()=>{
  const items=normalize([{id:1,rich_text:'【比特币市场消息】<b>已发布</b>',create_time:'2026-10-15 19:25:00',docurl:'https://finance.sina.cn/7x24/example.html'}],'sina',now);
  assert.equal(items[0].title,'比特币市场消息');assert.equal(items[0].category,'加密');assert.ok(!items[0].summary.includes('<b>'));
});
test('important/relevant news ranks by explicit rules without requiring a model or API token',()=>{
  const items=normalize([row('地方企业动态'),row('美国CPI数据公布')],'eastmoney',now);
  assert.equal(items[0].category,'宏观');assert.equal(items[1].category,'财经');
});
test('cold concurrent readers share one collection job and refreshes serve the previous cache immediately',async()=>{
  let clock=now,calls=0,release;
  const service=createHotNewsService({now:()=>clock,fetchers:{eastmoney:()=>{calls++;return new Promise(resolve=>{release=resolve;});}}});
  const requests=Array.from({length:20},()=>service.get());await Promise.resolve();assert.equal(calls,1);
  release([row()]);const values=await Promise.all(requests);assert.equal(values[0].items.length,1);
  await service.get();assert.equal(calls,1);
  clock+=60001;const stale=await service.get();assert.equal(stale.items.length,1);assert.equal(stale.stale,true);assert.equal(calls,2);
  release([row('比特币最新消息')]);await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await service.get()).items[0].title,'比特币最新消息');
});
test('backup failure is bounded by shared backoff and does not erase the last usable result',async()=>{
  let clock=now,fail=false,primary=0,backup=0;
  const service=createHotNewsService({now:()=>clock,fetchers:{eastmoney:async()=>{primary++;throw Error('fail');},sina:async()=>{backup++;if(fail)throw Error('fail');return [{rich_text:'【比特币消息】公开快讯',create_time:'2026-10-15 19:25:00'}];}}});
  assert.equal((await service.get()).provider,'sina');fail=true;clock+=60001;
  await service.get();await new Promise(resolve=>setImmediate(resolve));
  const stale=await service.get();assert.equal(stale.stale,true);assert.equal(stale.items.length,1);assert.match(stale.warning,/保留/);
  for(let i=0;i<20;i++)await service.get();assert.equal(primary,2);assert.equal(backup,2);
});
test('empty feeds retry with backoff, and the hot-news route preserves macro calendar routes',async()=>{
  require('./helpers/isolateSqlite');
  const service=createHotNewsService({now:()=>now,fetchers:{eastmoney:async()=>[]}});
  const first=await service.get();assert.equal(first.items.length,0);assert.ok(first.nextAttemptAt>now);
  const module=require('../lib/hotNews'),original=module.getHotNews;module.getHotNews=async()=>first;
  const express=require('express'),app=express();app.use('/news',require('../routes/news'));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  try{
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/news/hot?refresh=1');
    assert.equal(response.status,200);assert.equal((await response.json()).ranking,first.ranking);
    assert.equal((await fetch('http://127.0.0.1:'+server.address().port+'/news/comments')).status,404);
  }finally{module.getHotNews=original;await new Promise(resolve=>server.close(resolve));}
});
