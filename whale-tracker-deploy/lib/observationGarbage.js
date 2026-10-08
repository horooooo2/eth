// Expensive reference scans run in the read-only computation process. The API
// applies only these bounded candidate lists, guarded by a reference epoch.
const TABLES = {
  markers:['observation_evidence','event_id'],
  v2:['observation_evidence_links','rowid'],
  v3:['observation_evidence_versions','rowid'],
  v4:['observation_evidence_block_versions','rowid'],
  stagedRows:['observation_staged_rows','rowid'],
  stagedBlocks:['observation_staged_blocks','rowid'],
  blocks:['observation_evidence_blocks','hash'],
  rows:['observation_evidence_rows','hash'],
};
function planGarbage(source,output) {
  source.exec(`CREATE TEMP TABLE gc_markers AS SELECT event_id AS identity FROM observation_evidence
    WHERE NOT EXISTS (SELECT 1 FROM whale_observations w WHERE w.id=event_id) LIMIT 5000;
    CREATE TEMP TABLE gc_v2 AS SELECT l.rowid AS identity FROM observation_evidence_links l
      WHERE NOT EXISTS (SELECT 1 FROM observation_evidence e WHERE e.event_id=l.event_id
        AND json_extract(e.payload_json,'$.format')=2 AND e.event_id NOT IN (SELECT identity FROM gc_markers)) LIMIT 5000;
    CREATE TEMP TABLE gc_v3 AS SELECT l.rowid AS identity FROM observation_evidence_versions l
      WHERE NOT EXISTS (SELECT 1 FROM observation_calculations c WHERE c.token=l.token)
        AND NOT EXISTS (SELECT 1 FROM observation_evidence e WHERE e.event_id=l.event_id
          AND json_extract(e.payload_json,'$.format')=3 AND json_extract(e.payload_json,'$.token')=l.token
          AND e.event_id NOT IN (SELECT identity FROM gc_markers)) LIMIT 5000;
    CREATE TEMP TABLE gc_v4 AS SELECT l.rowid AS identity FROM observation_evidence_block_versions l
      WHERE NOT EXISTS (SELECT 1 FROM observation_calculations c WHERE c.token=l.token)
        AND NOT EXISTS (SELECT 1 FROM observation_evidence e WHERE e.event_id=l.event_id
          AND json_extract(e.payload_json,'$.format')=4 AND json_extract(e.payload_json,'$.token')=l.token
          AND e.event_id NOT IN (SELECT identity FROM gc_markers)) LIMIT 5000;
    CREATE TEMP TABLE gc_stagedRows AS SELECT s.rowid AS identity FROM observation_staged_rows s
      WHERE NOT EXISTS (SELECT 1 FROM observation_calculations c WHERE c.token=s.token) LIMIT 5000;
    CREATE TEMP TABLE gc_stagedBlocks AS SELECT s.rowid AS identity FROM observation_staged_blocks s
      WHERE NOT EXISTS (SELECT 1 FROM observation_calculations c WHERE c.token=s.token) LIMIT 5000;
    CREATE TEMP TABLE gc_blocks AS SELECT b.hash AS identity FROM observation_evidence_blocks b
      WHERE NOT EXISTS (SELECT 1 FROM observation_evidence_block_versions l WHERE l.hash=b.hash
        AND l.rowid NOT IN (SELECT identity FROM gc_v4))
        AND NOT EXISTS (SELECT 1 FROM observation_staged_blocks s JOIN observation_calculations c ON c.token=s.token WHERE s.hash=b.hash)
      LIMIT 5000;
    CREATE TEMP TABLE gc_live_hashes(hash TEXT PRIMARY KEY);
    INSERT OR IGNORE INTO gc_live_hashes SELECT j.value FROM observation_evidence_blocks b,json_each(b.hashes_json) j
      WHERE b.hash NOT IN (SELECT identity FROM gc_blocks);
    CREATE TEMP TABLE gc_rows AS SELECT r.hash AS identity FROM observation_evidence_rows r
      WHERE NOT EXISTS (SELECT 1 FROM observation_evidence_links l WHERE l.hash=r.hash AND l.rowid NOT IN (SELECT identity FROM gc_v2))
        AND NOT EXISTS (SELECT 1 FROM observation_evidence_versions l WHERE l.hash=r.hash AND l.rowid NOT IN (SELECT identity FROM gc_v3))
        AND NOT EXISTS (SELECT 1 FROM gc_live_hashes h WHERE h.hash=r.hash)
        AND NOT EXISTS (SELECT 1 FROM observation_staged_rows s JOIN observation_calculations c ON c.token=s.token WHERE s.hash=r.hash)
      LIMIT 5000;`);
  const put=output.prepare('INSERT INTO candidates VALUES(?,?)');
  for(const kind of Object.keys(TABLES)) {
    for(const row of source.prepare(`SELECT identity FROM gc_${kind}`).iterate())put.run(kind,row.identity);
  }
}
async function applyGarbage(db,output,meta,isCurrent) {
  const epoch=()=>db.prepare('SELECT version FROM observation_gc_version WHERE id=1').get().version;
  let expected=meta.version;
  const valid=()=>isCurrent()&&epoch()===expected;
  for(const [kind,[table,key]] of Object.entries(TABLES)) {
    const remove=db.prepare(`DELETE FROM ${table} WHERE ${key}=?`);
    let batch=[];
    function commit() {
      return db.transaction(()=>{
        if(!valid())return false;
        for(const id of batch)remove.run(id);
        expected=epoch();return true;
      })();
    }
    for(const row of output.prepare('SELECT identity FROM candidates WHERE kind=?').iterate(kind)) {
      batch.push(row.identity);
      if(batch.length===256) {
        if(!commit())return {stale:true,changed:false};
        batch=[];await new Promise(resolve=>setImmediate(resolve));
      }
    }
    if(!commit())return {stale:true,changed:false};
    await new Promise(resolve=>setImmediate(resolve));
  }
  return {stale:!valid(),changed:false};
}
module.exports={planGarbage,applyGarbage};
