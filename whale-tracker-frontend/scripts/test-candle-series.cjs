const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
const out={},source=fs.readFileSync(require.resolve('../src/utils/candleSeries.ts'),'utf8').replace(/^import .*;\r?$/gm,'');
new Function('exports',ts.transpile(source,{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}))(out);
const bar=(i,close)=>({openTime:i*60000,open:close,high:close+1,low:close-1,close,closeTime:(i+1)*60000-1,volume:0});
test('candles are ordered, deduplicated and sliced without moving-average calculations',()=>{
 const rows=Array.from({length:200},(_,i)=>bar(i,i+10));
 const visible=out.buildCandleSeries([...rows.reverse(),bar(199,209)],60000,31);
 assert.equal(visible.length,31);assert.equal(visible[0].bar.openTime,169*60000);
 assert.deepEqual(Object.keys(visible[0]),['bar']);
});
test('invalid OHLC is excluded while valid candles across gaps are retained',()=>{
 const rows=Array.from({length:30},(_,i)=>bar(i,i+10));rows[20].high=1;
 const visible=out.buildCandleSeries(rows,60000,30);assert.equal(visible.length,29);
 assert.equal(visible.find(row=>row.bar.openTime===21*60000).bar.close,31);
});

test('interval extrema use candle wicks rather than closing prices and reject invalid bars',()=>{
 const a=bar(0,100),b=bar(1,110);a.high=150;b.low=50;
 assert.deepEqual(out.candlePriceRange([a,b]),{high:150,low:50});
 assert.equal(out.candlePriceRange([]),null);
 assert.deepEqual(out.candlePriceRange([a,{...b,high:1}]),{high:150,low:99});
});
