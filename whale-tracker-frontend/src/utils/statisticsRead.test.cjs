const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'), vm=require('node:vm'), ts=require('typescript');
const api={};
const source=fs.readFileSync(require('node:path').join(__dirname,'statisticsRead.ts'),'utf8');
vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:api,Error,setTimeout});
test('transient statistics failures retry once and return the complete response',async()=>{
  for(const message of ['TIMEOUT','GATEWAY_502','GATEWAY_503','GATEWAY_504','Network Error']) {
    let calls=0,waits=0;
    const result=await api.retryStatistics(async()=>{if(++calls===1)throw Error(message);return {net:123};},async()=>{waits++;});
    assert.equal(result.net,123);assert.equal(calls,2);assert.equal(waits,1);
  }
});
test('persistent failures stop after two attempts and preserve the final error',async()=>{
  let calls=0;const error=Error('TIMEOUT');
  await assert.rejects(api.retryStatistics(async()=>{calls++;throw error;},async()=>{}),e=>e===error);
  assert.equal(calls,2);
});
test('invalid requests, authentication, rate limits and calculation errors are not retried',async()=>{
  for(const message of ['不支持的时间范围','Unauthorized','查询过于频繁，请稍后再试','方向统计暂不可用']) {
    let calls=0;const error=Error(message);
    await assert.rejects(api.retryStatistics(async()=>{calls++;throw error;},async()=>{assert.fail('must not wait');}),e=>e===error);
    assert.equal(calls,1);
  }
  assert.equal(api.statisticsErrorText(Error('TIMEOUT')),'请求超时');
  assert.equal(api.statisticsErrorText(Error('GATEWAY_503')),'服务暂时繁忙');
});
test('completed-result freshness distinguishes pending facts, expired windows and failed refreshes',()=>{
  const value={asOf:Date.now(),inputVersion:1,currentInputVersion:1,pendingUpdates:false,refreshing:false,stale:false,error:null};
  assert.match(api.statisticsFreshnessText(value),/^统计截至/);
  assert.match(api.statisticsFreshnessText({...value,pendingUpdates:true}),/后续数据更新中/);
  assert.match(api.statisticsFreshnessText({...value,stale:true}),/已过期/);
  assert.match(api.statisticsFreshnessText({...value,error:'failed'}),/暂未更新/);
  assert.equal(api.statisticsFreshnessText(), '');
});
