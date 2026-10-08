const test=require('node:test'),assert=require('node:assert/strict');
require('./helpers/isolateSqlite');
delete process.env.RADAR_ENABLED;
test('radar pause rejects all radar requests before collection and preserves management routes',async()=>{
  const service=require('../lib/radarLongTrend');
  await service.refresh();
  assert.throws(()=>service.snapshot(),error=>error.code==='RADAR_DISABLED');
  const server=require('../lib/createApp').createApp().listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    for(const endpoint of ['catalog','available','quotes','market','market-cap','news','klines','long-trends']) {
      const response=await fetch(base+'/api/tradfi/radar/'+endpoint);
      assert.equal(response.status,503,endpoint);
      assert.equal((await response.json()).code,'RADAR_DISABLED');
    }
    const ai=await fetch(base+'/api/whale-ai/market-chat-stream',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(ai.status,503);assert.equal((await ai.json()).code,'RADAR_DISABLED');
    for(const endpoint of ['/api/health','/api/data/monitor','/api/data/browse'])assert.equal((await fetch(base+endpoint)).status,200,endpoint);
    // The retained handlers can be restored without changing their implementation.
    process.env.RADAR_ENABLED='1';
    assert.equal((await fetch(base+'/api/tradfi/radar/market?interval=invalid')).status,400);
  } finally {delete process.env.RADAR_ENABLED;await new Promise(resolve=>server.close(resolve));}
});
