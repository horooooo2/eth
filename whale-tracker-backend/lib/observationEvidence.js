const { createHash } = require('node:crypto');
// Persisted format 4 uses this fixed block size; changing it needs a new format.
const EVIDENCE_BLOCK_SIZE = 128;
// Shared follow-up rows are serialized once per rebuild, stored once per content hash.
function encodeEvidence(rows, memo = new WeakMap()) {
  const digest = createHash('sha256'); digest.update('[');
  const encoded = rows.map((row, index) => {
    let item = memo.get(row);
    if (!item) {
      const json = JSON.stringify(row);
      item = { json, hash: createHash('sha256').update(json).digest('hex') };
      memo.set(row, item);
    }
    if (index) digest.update(',');
    digest.update(item.json);
    return item;
  });
  digest.update(']');
  return { encoded, hash: digest.digest('hex') };
}
function writeEvidence(db, id, encoded) {
  db.prepare('DELETE FROM observation_evidence_links WHERE event_id=?').run(id);
  const put = db.prepare('INSERT OR IGNORE INTO observation_evidence_rows VALUES(?,?)');
  const link = db.prepare('INSERT INTO observation_evidence_links VALUES(?,?,?)');
  for (let i = 0; i < encoded.length; i++) {
    const row = encoded[i]; put.run(row.hash, row.json); link.run(id, i, row.hash);
  }
  db.prepare('INSERT OR REPLACE INTO observation_evidence VALUES(?,?)').run(id, '{"format":2}');
}
function removeEvidence(db, id) {
  db.prepare('DELETE FROM observation_evidence_links WHERE event_id=?').run(id);
  db.prepare('DELETE FROM observation_evidence WHERE event_id=?').run(id);
}
function* readEvidence(db, id, offset = 0, limit = -1) {
  const format = db.prepare("SELECT json_extract(payload_json,'$.format') AS version, json_extract(payload_json,'$.token') AS token FROM observation_evidence WHERE event_id=?").get(id);
  if (format?.version === 4) {
    const rows = db.prepare(`SELECT r.payload_json FROM observation_evidence_block_versions l
      JOIN observation_evidence_blocks b ON b.hash=l.hash, json_each(b.hashes_json) j
      JOIN observation_evidence_rows r ON r.hash=j.value
      WHERE l.token=? AND l.event_id=? AND l.ordinal>=? AND l.ordinal<=?
        AND (l.ordinal>? OR CAST(j.key AS INTEGER)>=?)
      ORDER BY l.ordinal,CAST(j.key AS INTEGER) LIMIT ?`);
    const block=Math.floor(offset/EVIDENCE_BLOCK_SIZE);
    const lastBlock=limit<0?Number.MAX_SAFE_INTEGER:Math.floor((offset+limit-1)/EVIDENCE_BLOCK_SIZE);
    for(const row of rows.iterate(format.token,id,block,lastBlock,block,offset%EVIDENCE_BLOCK_SIZE,limit))yield JSON.parse(row.payload_json);
    return;
  }
  if (format?.version === 3) {
    const rows = db.prepare(`SELECT r.payload_json FROM observation_evidence_versions l
      JOIN observation_evidence_rows r ON r.hash=l.hash
      WHERE l.token=? AND l.event_id=? AND l.ordinal>=? ORDER BY l.ordinal LIMIT ?`);
    for (const row of rows.iterate(format.token,id,offset,limit)) yield JSON.parse(row.payload_json);
    return;
  }
  const statement = format?.version === 2
    ? db.prepare(`SELECT r.payload_json FROM observation_evidence_links l
        JOIN observation_evidence_rows r ON r.hash=l.hash
        WHERE l.event_id=? AND l.ordinal>=? ORDER BY l.ordinal LIMIT ?`)
    : db.prepare(`SELECT j.value AS payload_json FROM observation_evidence e, json_each(e.payload_json) j
        WHERE e.event_id=? AND CAST(j.key AS INTEGER)>=? ORDER BY CAST(j.key AS INTEGER) LIMIT ?`);
  for (const row of statement.iterate(id, offset, limit)) yield JSON.parse(row.payload_json);
}
function* readTriggerEvidence(db,id,lastAt) {
  // Bound each query even when the event has a day of later follow-up rows.
  for(let offset=0;;offset+=EVIDENCE_BLOCK_SIZE) {
    let count=0;
    for(const row of readEvidence(db,id,offset,EVIDENCE_BLOCK_SIZE)) {
      if(row.time>lastAt)return;
      count++;yield row;
    }
    if(count<EVIDENCE_BLOCK_SIZE)return;
  }
}
module.exports = { EVIDENCE_BLOCK_SIZE, encodeEvidence, writeEvidence, removeEvidence, readEvidence, readTriggerEvidence };
