// This process only reads the live DB. Its output is a disposable private DB;
// neither raw histories nor evidence arrays travel over IPC.
const Database = require('better-sqlite3');
const { createHash } = require('node:crypto');
const { buildObservations, buildCollective } = require('./whaleObservationEngine');
const { eventsFromTrade } = require('./sqliteStore');
const { readTriggerEvidence, EVIDENCE_BLOCK_SIZE } = require('./observationEvidence');
process.once('disconnect',()=>process.exit(0));

process.on('message', request => {
  const reply=value=>{global.gc?.();process.send({...value,requestId:request.requestId,rss:process.memoryUsage().rss});};
  let source, output;
  try {
    source = new Database(request.database, { readonly: true, fileMustExist: true });
    if(request.kind==='prune') {
      output=new Database(request.output);
      output.exec('CREATE TABLE candidates(kind TEXT,identity); CREATE INDEX candidates_kind ON candidates(kind); CREATE TABLE metadata(payload_json TEXT)');
      let gcVersion;
      output.transaction(()=>{
        source.transaction(()=>{
          gcVersion=source.prepare('SELECT version FROM observation_gc_version WHERE id=1').get().version;
          require('./observationGarbage').planGarbage(source,output);
        })();
        output.prepare('INSERT INTO metadata VALUES(?)').run(JSON.stringify({kind:'prune',version:gcVersion}));
      })();
      source.close();source=null;output.close();output=null;
      reply({ok:true});return;
    }
    let version, inputs, invalidation, throughAt=null;
    // Materialize compact inputs in a short read snapshot, then release the WAL
    // before CPU work. The memory limit belongs to this process, not the API.
    source.transaction(() => {
      if (request.kind === 'pair') {
        version = source.prepare('SELECT version FROM observation_versions WHERE whale_id=? AND coin=?')
          .get(request.job.whale_id,request.job.coin)?.version || 0;
        invalidation=source.prepare('SELECT invalidation FROM observation_input_guards WHERE whale_id=? AND coin=?')
          .get(request.job.whale_id,request.job.coin)?.invalidation || 0;
        inputs = [];
        for (const row of source.prepare(`SELECT payload_json,received_at FROM observation_inputs
          WHERE whale_id=? AND coin=? AND time>=? ORDER BY time,id`)
          .iterate(request.job.whale_id,request.job.coin,request.now-7*86400000)) {
          inputs.push({ ...JSON.parse(row.payload_json), observationReceivedAt:row.received_at });
        }
        throughAt=inputs.at(-1)?.time || null;
      } else {
        version = source.prepare('SELECT version FROM observation_summary_version WHERE id=1').get().version;
        inputs = [];
        for (const row of source.prepare(`SELECT w.id,w.payload_json FROM whale_observations w
          JOIN observation_evidence e ON e.event_id=w.id WHERE w.last_at>=?
          AND json_extract(w.payload_json,'$.type') IN ('build','reverse')`).iterate(request.now-25*3600000)) {
          const event=JSON.parse(row.payload_json),evidence=[];
          if(request.job?.coins&&!request.job.coins.includes(event.coin))continue;
          // Follow-up rows are time ordered and never enter collective amounts.
          // Close the iterator at the trigger instead of decoding the next 24h.
          for(const item of readTriggerEvidence(source,row.id,event.lastAt))evidence.push(item);
          inputs.push({ ...event, evidence });
        }
      }
    })();
    source.close(); source = null;
    const events = request.kind === 'pair'
      ? buildObservations(inputs,eventsFromTrade,undefined,{since:request.now-25*3600000})
      : buildCollective(inputs);
    inputs = null;
    output = new Database(request.output);
    output.exec(`CREATE TABLE events(id TEXT PRIMARY KEY,payload_json TEXT);
      CREATE TABLE rows(hash TEXT PRIMARY KEY,payload_json TEXT);
      CREATE TABLE blocks(hash TEXT PRIMARY KEY,hashes_json TEXT);
      CREATE TABLE links(event_id TEXT,ordinal INTEGER,hash TEXT,PRIMARY KEY(event_id,ordinal));
      CREATE TABLE metadata(payload_json TEXT);`);
    const putRow = output.prepare('INSERT OR IGNORE INTO rows VALUES(?,?)');
    const putLink = output.prepare('INSERT INTO links VALUES(?,?,?)');
    const putBlock = output.prepare('INSERT OR IGNORE INTO blocks VALUES(?,?)');
    const putEvent = output.prepare('INSERT INTO events VALUES(?,?)');
    const memo = new WeakMap();
    output.transaction(() => {
      for (const full of events) {
        const { evidence, ...fields } = full;
        const digest = createHash('sha256'); digest.update('[');
        let block=[];
        function flushBlock(ordinal) {
          const json=JSON.stringify(block);
          const hash=createHash('sha256').update('evidence-block-v4:').update(json).digest('hex');
          putBlock.run(hash,json);putLink.run(full.id,ordinal,hash);block=[];
        }
        let latest = null, readyAt = 0, complete = true;
        for (let i=0;i<evidence.length;i++) {
          const row=evidence[i];
          let item=memo.get(row);
          if (!item) {
            const json=JSON.stringify(row); item={json,hash:createHash('sha256').update(json).digest('hex')}; memo.set(row,item);
            putRow.run(item.hash,item.json);
          }
          block.push(item.hash);
          if(block.length===EVIDENCE_BLOCK_SIZE)flushBlock(Math.floor(i/EVIDENCE_BLOCK_SIZE));
          if (i) digest.update(','); digest.update(item.json);
          if (!latest || row.time>latest.time) latest=row;
          if (Number.isFinite(row.receivedAt) && row.receivedAt>0) readyAt=Math.max(readyAt,row.receivedAt); else complete=false;
        }
        if(block.length)flushBlock(Math.floor((evidence.length-1)/EVIDENCE_BLOCK_SIZE));
        digest.update(']');
        putEvent.run(full.id,JSON.stringify({event:{...fields,evidenceCount:evidence.length,evidenceHash:digest.digest('hex')},
          timing:{eventAt:latest?.time||null,latestExecutionReceivedAt:latest?.receivedAt||null,
            inputsReadyAt:complete?readyAt:null,generatedAt:Math.max(request.now,readyAt)}}));
      }
      output.prepare('INSERT INTO metadata VALUES(?)').run(JSON.stringify({version,invalidation,throughAt,kind:request.kind,job:request.job,now:request.now}));
    })();
    output.close(); output=null;
    reply({ok:true});
  } catch (error) {
    try { source?.close(); output?.close(); } catch {}
    reply({ok:false,error:error.message});
  }
});
