// All raw execution reads and scanner work stay in this bounded process.
const Database=require('better-sqlite3');
const {createFillFactProjection}=require('./fillFactProjection');
const {eventsFromTrade}=require('./sqliteStore');
const {canonicalTradeId,alertDocFromEvent}=require('./positionEventPolicy');
const {scanResonanceSignals,coinKey,DEFAULT_RESONANCE_CONFIG}=require('./resonanceEngine');
const WINDOWS=[2,4,6,12,24];

function compute(request, report = () => {}) {
  const source=new Database(request.database,{readonly:true,fileMustExist:true});
  let output;
  try {
    output=new Database(request.output);
    output.exec('CREATE TABLE results(key TEXT PRIMARY KEY,payload_json TEXT); CREATE TABLE metadata(payload_json TEXT)');
    const put=output.prepare('INSERT INTO results VALUES(?,?)');
    // Statistics use at most 24 hours. Use the batch clock throughout rebuild:
    // a slow computation must not silently lose facts near its window boundary.
    const horizon=Math.max(...WINDOWS.map(w=>Math.max(w,DEFAULT_RESONANCE_CONFIG.accumulationWindowHours)*3600000));
    const projection=createFillFactProjection({getDb:()=>source,retentionMs:Math.min(request.retentionMs,horizon),
      now:()=>request.now,untilMs:request.now,cacheKiB:8192,onProgress:report,classify:eventsFromTrade,canonicalId:canonicalTradeId});
    let version;
    // One WAL read snapshot binds all windows, roster facts and the input version.
    output.transaction(()=>source.transaction(()=>{
      version=source.prepare('SELECT version FROM statistics_input_version WHERE id=1').get().version;
      const ids=new Set(request.roster);
      const whales=[];
      for(const row of source.prepare('SELECT id,payload_json FROM whales WHERE enabled=1').iterate()) {
        if(!ids.has(row.id))continue;
        const whale=JSON.parse(row.payload_json);
        if(String(whale.error||'')!=='等待刷新')whales.push(whale);
      }
      // Discover assets without constructing four account/coin direction summaries.
      const coins=new Set();
      for(const event of projection.read(request.now-horizon,request.now,true))coins.add(coinKey(event.coin));
      const watched=[...coins];
      const eligible=new Set(whales.filter(w=>Number(w.winRate)>=DEFAULT_RESONANCE_CONFIG.minWinRate).map(w=>String(w.id)));
      for(const windowHours of WINDOWS) {
        report({phase:'resonance:'+windowHours});
        const config={...DEFAULT_RESONANCE_CONFIG,windowHours};
        const since=request.now-Math.max(windowHours,config.accumulationWindowHours)*3600000;
        function* alerts(){for(const event of projection.read(since,request.now,false,eligible))yield alertDocFromEvent(event);}
        const result=scanResonanceSignals({whales,alerts:alerts(),activity:[],config,now:request.now,watchedCoins:watched,sortedUniqueAlerts:true});
        put.run('resonance:'+windowHours,JSON.stringify(result));
      }
    })())();
    output.prepare('INSERT INTO metadata VALUES(?)').run(JSON.stringify({version,asOf:request.now,rosterKey:request.rosterKey}));
  } finally { source.close();output?.close(); }
}
if(require.main===module)process.once('message',request=>{
  try {compute(request,progress=>process.send({progress}));process.send({ok:true},()=>process.exit(0));}
  catch(error){process.send({ok:false,error:error.message},()=>process.exit(1));}
});
module.exports={compute,WINDOWS};
