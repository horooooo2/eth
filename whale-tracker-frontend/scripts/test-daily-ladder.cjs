const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
function load(){const scope={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/tradfi-replay/dailyLadderEngine.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,scope);return scope.exports;}
const api=load(),{DailyLadderEngine,DEFAULT_TIERS}=api;
const M=60000,D=1440*M,T=Date.parse('2025-01-01T00:00:00Z');
const settings={symbol:'BTCUSDT',marginUsdt:1000,leverage:3,walletBalance:40000,makerFee:.0002,takerFee:.0005,slippage:.0005,tickSize:.01,qtyStep:.001,riskUsdt:100,maxHoldHours:48,weekMinPct:1,stopPct:30,takeProfitPct:1,tiers:DEFAULT_TIERS.map(t=>({...t}))};
function seed(side='long',partial=false){let rows=Array.from({length:10080},(_,i)=>{const start=side==='long'?107:side==='short'?93:100,o=start+(100-start)*i/10080,c=start+(100-start)*(i+1)/10080;return{t:T+i*M,o,c,h:Math.max(o,c)+.001,l:Math.min(o,c)-.001,v:100};});return partial?rows.slice(30):rows;}
const run=(rows,s=settings,f=[])=>{const e=new DailyLadderEngine(s,f);rows.forEach(b=>e.step(b));return e;};
const bar=(i,o,h,l,c)=>({t:T+7*D+i*M,o,h,l,c,v:100});
const first=bar(0,100,100.1,94.98,95),second=bar(1,95,95.1,89.98,90),third=bar(2,90,90.1,79.98,80);
function reconcile(e,price){assert.ok(Math.abs(e.logs.reduce((s,l)=>s+l.pnl,0)-e.realized)<1e-8);assert.ok(Math.abs(e.realized-e.realizedBySide.long-e.realizedBySide.short)<1e-8);assert.ok(Math.abs(e.settings.walletBalance+e.view(price).net-e.equity)<1e-8);}
let e=run(seed());assert.equal(e.tradeCount,0);e.step(first);assert.equal(e.bias,'long');assert.equal(e.position.side,'long');assert.equal(e.position.fills[0].price,95);assert.ok(e.position.plannedRisk<=10);assert.equal(e.position.event.maxTier,0);
const budget=e.position.event.marginBudget,risk=e.position.event.riskBudget,stop=e.position.stop,opened=e.position.openedAt;
e.step(second);assert.equal(e.position.fills.length,2);assert.ok(e.position.margin<=budget*.3+1e-8);assert.ok(e.position.plannedRisk<=risk*.3+1e-8);
e.step(third);assert.equal(e.position.fills.length,3);assert.ok(e.position.margin<=budget*.6+1e-8);assert.ok(e.position.plannedRisk<=risk*.6+1e-8);assert.equal(e.position.stop,stop);assert.equal(e.position.openedAt,opened);
const qty=e.position.qty;e.step(bar(3,80,80.1,79.98,80));assert.equal(e.position.qty,qty,'Revisiting a filled tier cannot add again');
const target=e.position.target;e.step(bar(4,80,target+1,79.9,target));assert.equal(e.logs[0].reason,'整体回归止盈');assert.ok(e.logs[0].pnl>=e.logs[0].qty*e.logs[0].openPrice*.01-1e-7);assert.equal(e.position,null);const fills=e.tradeCount;
for(let i=5;i<60;i++)e.step(bar(i,80,80.1,60,80));assert.equal(e.tradeCount,fills,'No same-day automatic rebuilding');reconcile(e,80);
// Weekly up uses ONLY short limits; current-day rally cannot flip that direction.
e=run(seed('short'));e.step(bar(0,100,105.02,99.9,105));assert.equal(e.position.side,'short');assert.equal(e.view(105).positions.long,null);assert.equal(e.weekPct,(100/93-1)*100);e.step(bar(1,105,110.02,104.9,110));assert.equal(e.position.fills.length,2);const st=e.position.target;e.step(bar(2,110,110.1,st-1,st));assert.equal(e.logs[0].side,'short');assert.ok(e.logs[0].pnl>0);
// Neutral week cannot trade even a huge daily move.
e=run(seed('neutral'));e.step(bar(0,100,125,75,90));assert.equal(e.tradeCount,0);assert.equal(e.bias,null);
// A partial first daily candle cannot count toward seven complete days.
e=run(seed('long',true));e.step(first);assert.equal(e.tradeCount,0);assert.equal(e.weekPct,null);
// Wick-only touches are not fills; one-tick penetration is required.
e=run(seed());e.step(bar(0,100,100,95,100));assert.equal(e.tradeCount,0);e.step(bar(1,100,100,94.98,100));assert.equal(e.tradeCount,1);assert.ok(e.position,'No favorable same-minute take-profit even with close above target');
// Multi-tier crash uses cumulative 60%, not 10+30+60%; stop after the adds.
e=run(seed());e.step(bar(0,100,101,65,66));assert.equal(e.logs[0].fills.length,3);assert.equal(e.logs[0].reason,'价格止损');assert.ok(e.logs[0].plannedRisk<=60);assert.ok(Math.abs(e.logs[0].pnl+e.logs[0].plannedRisk)<1e-7);reconcile(e,66);
// Same-timestamp funding precedes fills, uses imported mark price, and charges only existing quantity.
e=run(seed(),settings,[{t:first.t,rate:.1,price:200},{t:second.t,rate:.001,price:200}]);e.step(first);assert.equal(e.fundingTotal,0);const firstQty=e.position.qty;e.step(second);assert.ok(Math.abs(e.fundingTotal+firstQty*.2)<1e-8);
e=run(seed('short'),settings,[{t:second.t,rate:.001,price:200}]);e.step(bar(0,100,105.02,99.9,105));const shortQty=e.position.qty;e.step(bar(1,105,105.1,104.9,105));assert.ok(Math.abs(e.fundingTotal-shortQty*.2)<1e-8);
// Gap stop exits existing position; no extra layering beyond invalidation.
e=run(seed());e.step(first);e.step(bar(1,60,61,59,60));assert.equal(e.logs[0].fills.length,1);assert.equal(e.logs[0].reason,'跳空止损');assert.ok(e.logs[0].pnl<-e.logs[0].plannedRisk);
// Cross-day: budgets, stop, clock and consumed tiers survive; levels use new day open.
e=run(seed());e.step(first);for(let i=1;i<1440;i++)e.step(bar(i,95,95.1,94.9,95));
e.step(bar(1440,95,95.1,94.9,95));assert.equal(e.dayOpen,95);assert.equal(e.position.event.marginBudget,budget);assert.equal(e.position.event.riskBudget,risk);assert.equal(e.position.stop,stop);assert.equal(e.position.openedAt,opened);const limits=e.view(95).orders.long.levels;assert.deepEqual(Array.from(limits,o=>o.tier),[1,2]);assert.ok(Math.abs(limits[0].price-85.5)<1e-8);
e.step(bar(1441,95,95.1,85.48,85.5));assert.equal(e.position.fills.length,2);assert.ok(e.position.plannedRisk<=30);assert.equal(e.position.event.maxTier,1);
// Expiring an unfilled day cancels the old limits and resets only its reference.
e=run(seed());for(let i=0;i<1440;i++)e.step(bar(i,100,100.1,99.9,100));e.step(bar(1440,99,99.1,98.9,99));assert.equal(e.events[0].status,'EXPIRED');assert.ok(e.counts.canceled>=3);assert.equal(e.view(99).orders.long.price,94.05);
// Time stop is measured from first entry, never from an addition.
e=run(seed(),{...settings,maxHoldHours:1});e.step(first);for(let i=1;i<59;i++)e.step(bar(i,95,95.1,94.9,95));e.step(bar(59,95,95.1,89.98,90));e.step(bar(60,90,90.1,89.9,90));assert.equal(e.logs[0].closedAt-e.logs[0].openedAt,60*M);assert.equal(e.logs[0].reason,'持仓时间到期');
// Roll window changes direction while a losing position remains: no reverse or further adds.
let flip=seed();for(let i=0;i<10080;i++){const o=i<1440?107-17*i/1440:90+10*(i-1440)/8640,c=i<1440?107-17*(i+1)/1440:90+10*(i+1-1440)/8640;flip[i]={...flip[i],o,c,h:Math.max(o,c)+.001,l:Math.min(o,c)-.001};}
e=run(flip);e.step(first);for(let i=1;i<1440;i++)e.step(bar(i,94,94.1,93.9,94));e.step(bar(1440,94,94.1,93.9,94));assert.equal(e.bias,'short');assert.equal(e.position.side,'long');assert.equal(e.view(94).orders.long,null);assert.equal(e.view(94).orders.short,null);
assert.throws(()=>new DailyLadderEngine({...settings,tiers:[{movePct:5,allocationPct:30},{movePct:10,allocationPct:20},{movePct:20,allocationPct:60}]}));
assert.throws(()=>new DailyLadderEngine({...settings,stopPct:10}));assert.throws(()=>new DailyLadderEngine(settings,[{t:T+1,rate:.001}]));
const broken=seed().slice(0,2);broken[1].t+=M;assert.throws(()=>run(broken));
// Real Worker protocol: full import vs same prefix with unrelated future candles must agree.
function workerRun(rows,n){const messages=[],self={postMessage:m=>messages.push(JSON.parse(JSON.stringify(m))),setInterval,clearInterval},ctx={exports:{},require:name=>{assert.equal(name,'./dailyLadderEngine');return api;},self,clearInterval};vm.createContext(ctx);const src=fs.readFileSync(path.join(__dirname,'../src/tradfi-replay/replay.worker.ts'),'utf8');vm.runInContext(ts.transpileModule(src,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText+'\nself.testAdvance=advance;',ctx);self.onmessage({data:{type:'init-start',candleCount:rows.length,settings,funding:[]}});const flat=new Float64Array(rows.flatMap(b=>[b.t,b.o,b.h,b.l,b.c,b.v]));self.onmessage({data:{type:'init-chunk',start:0,count:rows.length,buffer:flat.buffer}});self.onmessage({data:{type:'init-complete'}});self.testAdvance(n);assert.ok(!messages.some(m=>m.type==='replay-error'));assert.ok(messages.some(m=>m.type==='ready'));return messages.filter(m=>m.type==='tick').at(-1).payload;}
const prefix=[...seed(),first,second,third],future=[...prefix,bar(3,80,180,1,160)];const a=workerRun(prefix,prefix.length),b=workerRun(future,prefix.length);for(const x of[a,b]){delete x.total;delete x.progress;delete x.paused;delete x.allEvents;}assert.deepEqual(a,b);
if(process.argv.includes('--fixture')) { const rows=[...seed(),first,second,third,bar(3,80,89,79.9,88)];for(let i=4;i<70;i++)rows.push(bar(i,88,88.1,87.9,88));fs.writeFileSync(path.join(__dirname,'../../market-data/BTCUSDT_daily_ladder_SYNTHETIC.csv'),'timestamp,open,high,low,close,volume\n'+rows.map(b=>[b.t,b.o,b.h,b.l,b.c,b.v].join(',')).join('\n')); }
console.log('Daily ladder tests passed: completed seven-day bias, neutral/partial-day gates, daily-open levels, single direction, cumulative caps, finite tiers, midnight invariants/cancellation, reversal freeze, cost/funding signs, conservative fills/stops, time exit, no rebuild and Worker prefix causality.');
