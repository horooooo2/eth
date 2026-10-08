const test=require('node:test'),assert=require('node:assert/strict');
const {sortRows}=require('../lib/radarSort');
test('numeric sorting is signed, stable, null-last, and does not mutate shared caches',()=>{
  const rows=[{symbol:'A',value:'10'},{symbol:'B',value:'-5'},{symbol:'C',value:null},{symbol:'D',value:'2'},{symbol:'E',value:''}];
  assert.deepEqual(sortRows(rows,r=>r.value,'asc').map(r=>r.symbol),['B','D','A','C','E']);
  assert.deepEqual(sortRows(rows,r=>r.value,'desc').map(r=>r.symbol),['A','D','B','C','E']);
  assert.deepEqual(rows.map(r=>r.symbol),['A','B','C','D','E']);
});
test('daily history explicitly requests USD-M futures klines and excludes the open day',async()=>{
  const axios=require('axios'),original=axios.create,calls=[];
  axios.create=options=>({get:async(path,request)=>{calls.push({options,path,request});return {data:[[86400000,'10','12','9','11','1',172799999]]};}});
  const path=require.resolve('../lib/tradfiMarkets');delete require.cache[path];
  try {
    const market=require(path);const bars=await market.getRadarDailyHistory('WDCUSDT',172800000);
    assert.equal(calls[0].options.baseURL,'https://fapi.binance.com');assert.equal(calls[0].path,'/fapi/v1/klines');
    assert.deepEqual(calls[0].request.params,{symbol:'WDCUSDT',interval:'1d',endTime:172799999,limit:91});assert.equal(bars[0].close,11);
  }finally{axios.create=original;delete require.cache[path];}
});
