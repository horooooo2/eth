'use strict';
// Synthetic data only. Never opens the configured production database.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {fork}=require('node:child_process');const {monitorEventLoopDelay}=require('node:perf_hooks');
const Database=require('better-sqlite3');
const count=Math.min(250000,Math.max(1000,Number(process.argv[2])||25000));
const verify=process.argv.includes('--verify');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'macro-benchmark-')),file=path.join(directory,'facts.db');
let db,child,monitor,timer;
(async()=>{
  try{
    db=new Database(file);db.exec('CREATE TABLE fills(id TEXT PRIMARY KEY,time INTEGER,asset TEXT,source TEXT,payload_json TEXT,received_at INTEGER,fact_updated_at INTEGER); CREATE INDEX idx_time ON fills(time); CREATE TABLE sync_meta(key TEXT PRIMARY KEY,value TEXT);');
    const at=Date.now(),from=at-3600000;
    const insert=db.prepare('INSERT INTO fills VALUES(?,?,?,?,?,?,?)');
    const roster=Array.from({length:50},(_,i)=>({id:`w${i}`,address:`0x${i.toString(16).padStart(40,'0')}`}));
    db.transaction(()=>{for(let i=0;i<count;i++){
      const id=`w${i%50}:${i}`,time=from+Math.floor(i/count*3599000),asset=i%2?'BTC':'ETH';
      const trade={id,whaleId:`w${i%50}`,time,asset,side:i%10<7?'sell':'buy',amount:10,amountUsd:1000,startPosition:0,source:'hyperliquid'};
      insert.run(id,time,asset,'hyperliquid',JSON.stringify(trade),time+1,time+1);
    }})();
    db.prepare('INSERT INTO sync_meta VALUES(?,?)').run('fills_address_watermarks_v2',JSON.stringify(Object.fromEntries(roster.map(row=>[row.address,{coverageStart:from-1,through:at}]))));db.close();db=null;
    const input={database:file,releaseAt:at,mode:'PRE_RELEASE',roster,now:at+1000};
    // Preparing a frozen baseline is fixture setup, outside the measured interval.
    const frozen=verify?require('../lib/macroComparisonCompute').computeWindow(input):null;
    if(verify){input.mode='RETROSPECTIVE';input.frozenEvidenceHash=frozen.evidenceHash;}
    monitor=monitorEventLoopDelay({resolution:5});monitor.enable();let ticks=0;timer=setInterval(()=>ticks++,5);
    child=fork(require.resolve('../lib/macroComparisonCompute'),[],{execArgv:['--max-old-space-size=128'],stdio:['ignore','ignore','ignore','ipc']});
    const started=Date.now();const output=await new Promise((resolve,reject)=>{child.once('message',value=>value.ok?resolve(value):reject(Error(value.error)));child.once('error',reject);child.send(input);});
    if(output.result.coins.BTC.fills+output.result.coins.ETH.fills!==count)throw Error('Lost facts in benchmark');
    if(verify&&output.result.verification?.evidenceUnchanged!==true)throw Error('Frozen evidence changed in verification benchmark');
    console.log(JSON.stringify({syntheticFills:count,verificationMode:verify,totalMs:Date.now()-started,childComputeMs:output.metrics.computeMs,childRssAtEndMiB:output.metrics.rssAtEnd/1048576,parentTimerTicks:ticks,parentEventLoopP95Ms:monitor.percentile(95)/1e6,parentEventLoopMaxMs:monitor.max/1e6,heapLimitMiB:128},null,2));
  }finally{
    clearInterval(timer);monitor?.disable();child?.kill();db?.close();
    if(path.dirname(path.resolve(directory))!==path.resolve(os.tmpdir())||!path.basename(directory).startsWith('macro-benchmark-'))throw Error('Unexpected cleanup path');
    // Wait for the child's read handle to close before removing this test-only directory.
    if(child&&child.exitCode==null)await new Promise(resolve=>child.once('exit',resolve));
    fs.rmSync(directory,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
