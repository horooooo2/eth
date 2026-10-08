// Synthetic comparison only: always use a disposable DB, never SQLITE_PATH.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'whale-compute-benchmark-'));
process.env.SQLITE_PATH=path.join(directory,'benchmark.db');
const {getDb,closeDb}=require('../lib/db');
const store=require('../lib/whaleObservationStore');
const {createComputeRunner}=require('../lib/observationCompute');
const count=Math.max(3,Math.min(10000,Number(process.argv[2])||3000));
const now=Date.now(),job={whale_id:'benchmark',coin:'BTC'};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function summaries(db) {
  return db.prepare('SELECT payload_json FROM whale_observations ORDER BY id').all().map(r=>JSON.parse(r.payload_json));
}
function storageCounts(db) {
  return db.prepare(`SELECT (SELECT COUNT(*) FROM observation_evidence_rows) rows,
    (SELECT COUNT(*) FROM observation_evidence_blocks) blocks,
    (SELECT COUNT(*) FROM observation_evidence_block_versions) blockLinks`).get();
}
async function measure(action) {
  let last=performance.now(),maxDelay=0;
  const timer=setInterval(()=>{const at=performance.now();maxDelay=Math.max(maxDelay,at-last-5);last=at;},5);
  await wait(15);
  const started=performance.now();
  try {
    await action();
    const elapsedMs=performance.now()-started;
    await wait(15);
    return {elapsedMs:Math.round(elapsedMs),mainLoopMaxDelayMs:Math.round(maxDelay)};
  }finally{clearInterval(timer);}
}
async function main() {
  try {
    const db=getDb();
    db.transaction(()=>{
      for(let i=0;i<count;i++)store.recordInput(db,{id:`benchmark-${i}`,whaleId:job.whale_id,
        asset:'BTC',side:'buy',startPosition:i,amount:1,price:10000,time:now-(count-i)*60000},now);
    })();
    const synchronous=await measure(()=>store.processPair(db,job,now));
    const expected=summaries(db);
    db.exec(`DELETE FROM whale_observations; DELETE FROM observation_evidence;
      DELETE FROM observation_evidence_links; DELETE FROM observation_evidence_rows;`);
    let childMs=0;
    const isolated=await measure(()=>{
      const started=performance.now();let checks=0;
      return createComputeRunner().run('pair',job,{now,isCurrent:()=>{
        if(++checks===2)childMs=performance.now()-started;
        return true;
      }});
    });
    isolated.childMs=Math.round(childMs);
    isolated.importMs=isolated.elapsedMs-isolated.childMs;
    assert.deepEqual(summaries(db),expected);
    for(const row of expected) {
      const actual=[...require('../lib/observationEvidence').readEvidence(db,row.id)];
      assert.equal(actual.length,row.evidenceCount);
      assert.equal(require('../lib/observationEvidence').encodeEvidence(actual).hash,row.evidenceHash);
    }
    const initialStorage=storageCounts(db),nextNow=now+60000;
    store.recordInput(db,{id:'benchmark-append',whaleId:job.whale_id,asset:'BTC',side:'buy',
      startPosition:count,amount:1,price:10000,time:now},nextNow);
    const append=await measure(()=>createComputeRunner().run('pair',job,{now:nextNow}));
    const afterAppend=storageCounts(db),appended=summaries(db);
    // The independent complete builder must find no differences to apply.
    assert.equal(store.processPair(db,job,nextNow),false);
    assert.deepEqual(summaries(db),appended);
    for(const row of appended) {
      const actual=[...require('../lib/observationEvidence').readEvidence(db,row.id)];
      assert.equal(actual.length,row.evidenceCount);
      assert.equal(require('../lib/observationEvidence').encodeEvidence(actual).hash,row.evidenceHash);
    }
    append.newEvidenceRows=afterAppend.rows-initialStorage.rows;
    append.newBlocks=afterAppend.blocks-initialStorage.blocks;
    append.activeBlockLinks=afterAppend.blockLinks;
    let garbageCollection;
    if(process.argv.includes('--gc-stress')) {
      const {createHash}=require('node:crypto');
      const hashes=Array.from({length:12000},(_,i)=>createHash('sha256').update(`gc-stress-${i}`).digest('hex'));
      db.transaction(()=>{
        const putRow=db.prepare('INSERT INTO observation_evidence_rows VALUES(?,?)');
        const putBlock=db.prepare('INSERT INTO observation_evidence_blocks VALUES(?,?)');
        const putLink=db.prepare('INSERT INTO observation_evidence_block_versions VALUES(?,?,?,?)');
        for(let i=0;i<hashes.length;i++)putRow.run(hashes[i],JSON.stringify({id:`gc-stress-${i}`,time:now}));
        for(let i=0;i<12000;i++) {
          const json=JSON.stringify(Array.from({length:128},(_,j)=>hashes[(i*61+j)%hashes.length]));
          const hash=createHash('sha256').update('evidence-block-v4:').update(json).digest('hex');
          putBlock.run(hash,json);putLink.run('gc-stress','gc-stress-token',i,hash);
        }
        db.prepare('INSERT INTO whale_observations VALUES(?,?,?,?,?)').run('gc-stress','gc-stress','BTC',now,'{"id":"gc-stress"}');
        db.prepare('INSERT INTO observation_evidence VALUES(?,?)').run('gc-stress','{"format":4,"token":"gc-stress-token"}');
      })();
      const rowsBefore=storageCounts(db).rows;
      garbageCollection=await measure(()=>createComputeRunner().run('prune',null));
      garbageCollection.liveReferences=12000*128;
      assert.equal(storageCounts(db).rows,rowsBefore);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM observation_evidence_block_versions WHERE token='gc-stress-token'").get().n,12000);
    }
    console.log(JSON.stringify({inputCount:count,eventCount:expected.length,
      evidenceLinks:expected.reduce((n,r)=>n+r.evidenceCount,0),initialStorage,synchronous,isolated,append,garbageCollection,resultsEqual:true},null,2));
  }finally{
    closeDb();
    if(path.dirname(directory)===path.resolve(os.tmpdir()))fs.rmSync(directory,{recursive:true,force:true});
  }
}
main().catch(err=>{console.error(err);process.exitCode=1;});
