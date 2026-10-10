const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const exportsObject={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(__dirname+'/alertGrouping.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:exportsObject});
const {groupNearbyAlerts,locatedCoinFilter}=exportsObject;
const a=(id,time,kind='increase',coin='BTC',side='short')=>({id,whaleId:'whale',at:time,kind,items:[{time,kind,coin,side,usd:100,evidenceSource:'fill'}]});
test('nearby adds merge, retain details and do not mutate source',()=>{
 const rows=[a('1',100000),a('2',200000),a('3',500000)];const grouped=groupNearbyAlerts(rows);
 assert.equal(grouped.length,1);assert.equal(grouped[0].items.length,3);assert.equal(grouped[0].id,'3');assert.equal(rows[2].items.length,1);
 assert.equal(groupNearbyAlerts([...rows,rows[0]])[0].items.length,3);
});
test('window does not chain indefinitely, and reductions break the sequence',()=>{
 assert.equal(groupNearbyAlerts([a('1',1),a('2',500001),a('3',1000001)]).length,2);
 assert.equal(groupNearbyAlerts([a('1',100),a('2',200,'decrease'),a('3',300)]).length,3);
});
test('different actions, sides, wallets, DEXs and evidence do not combine',()=>{
 const base=a('1',100);for(const other of [a('2',200,'open'),a('2',200,'increase','BTC','long'),a('2',200,'increase','xyz:BTC'),{...a('2',200),whaleId:'another'},{...a('2',200),items:[{...base.items[0],evidenceSource:'snapshot'}]}])assert.equal(groupNearbyAlerts([base,other]).length,2);
});
test('location preserves preferred symbols and falls back only for absent targets',()=>{
 assert.equal(locatedCoinFilter('BTC','btc',['BTC','ETH']),'BTC');
 assert.equal(locatedCoinFilter('BTC','ETH',['BTC','ETH']),'ETH');
 assert.equal(locatedCoinFilter('BTC','SOL',['BTC','ETH']),'all');
 assert.equal(locatedCoinFilter('BTC',undefined,['BTC']),'BTC');
 assert.equal(locatedCoinFilter('BTC','para:SNDK',['xyz:SNDK']),'all');
});

test('alert list and detail forward the asset when locating a whale',()=>{
 const source=fs.readFileSync(__dirname+'/../components/NewsList.vue','utf8');
 const link=source.match(/<WhaleLocateLink\s[^>]*:id="row.alert.whaleId"[^>]*>/s)?.[0];
 assert.ok(link);assert.match(link,/:coin="row.view.coin"/);
 const body=source.match(/function locateFromAlert\(alert: WhaleAlert\) \{([\s\S]*?)\n\}/)[1];
 const events=[];
 const compiled=ts.transpileModule('function locateFromAlert(alert:any){'+body+'}\nlocateFromAlert(alert);',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(compiled,{alert:{whaleId:'w',whaleName:'whale',items:[{coin:'MET'}]},emit:(name,payload)=>events.push(payload)});
 assert.equal(events[0].coin,'MET');
 assert.equal(locatedCoinFilter('BTC',events[0].coin,['BTC','ETH']),'all');
});
