// Run the production engine against a local CSV without a browser or any live orders.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
function load(name){const scope={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/tradfi-replay',name),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,scope);return scope.exports;}
const {DailyLadderEngine,LADDER_RULES,DEFAULT_TIERS}=load('dailyLadderEngine.ts'),{parseCandles,embeddedFunding,guessSymbol}=load('csv.ts');
if(!process.argv[2])throw new Error('Usage: node scripts/run-daily-ladder.cjs <minute.csv> [output.json]');
const input=path.resolve(process.argv[2]),text=fs.readFileSync(input,'utf8'),rows=parseCandles(text),funding=embeddedFunding(text)||[];
const settings={symbol:guessSymbol(path.basename(input),text)||'UNKNOWN',marginUsdt:1000,makerFee:.0002,weekMinPct:1,stopPct:30,takeProfitPct:1,tiers:DEFAULT_TIERS,leverage:3,walletBalance:40000,takerFee:.0005,slippage:.0005,tickSize:.01,qtyStep:.001,riskUsdt:100,maxHoldHours:24};
const engine=new DailyLadderEngine(settings,funding),started=Date.now();for(const bar of rows)engine.step(bar);
const result=engine.view(rows.at(-1).c),long=engine.logs.filter(l=>l.side==='long'),short=engine.logs.filter(l=>l.side==='short');
assert.ok(engine.logs.every(l=>l.closedAt-l.openedAt<=24*3600000&&l.fills.length<=3&&new Set(l.fills.map(f=>f.tierEnd)).size===l.fills.length));
assert.ok(Math.abs(engine.logs.reduce((s,l)=>s+l.pnl,0)-result.realized)<1e-7);
const report={dataSha256:require("node:crypto").createHash("sha256").update(text).digest("hex"),version:LADDER_RULES.version,input,settings,rules:LADDER_RULES,rows:rows.length,fundingRows:funding.length,engineMs:Date.now()-started,summary:{...engine.counts,trades:engine.logs.length,longTrades:long.length,shortTrades:short.length,net:result.net,realized:result.realized,unrealized:result.unrealized,fees:result.fees,funding:result.funding,maxDrawdown:result.maxDrawdown,maxHoldHours:engine.logs.length?Math.max(...engine.logs.map(l=>(l.closedAt-l.openedAt)/3600000)):0,openPositions:engine.position?1:0},result,trades:engine.logs,events:engine.events};
if(process.argv[3])fs.writeFileSync(path.resolve(process.argv[3]),JSON.stringify(report,null,2));
console.log(JSON.stringify({rows:report.rows,fundingRows:report.fundingRows,engineMs:report.engineMs,...report.summary},null,2));
