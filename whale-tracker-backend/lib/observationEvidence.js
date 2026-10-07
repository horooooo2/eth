const { createHash } = require('node:crypto');
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
  const format = db.prepare("SELECT json_extract(payload_json,'$.format') AS version FROM observation_evidence WHERE event_id=?").get(id);
  const statement = format?.version === 2
    ? db.prepare(`SELECT r.payload_json FROM observation_evidence_links l
        JOIN observation_evidence_rows r ON r.hash=l.hash
        WHERE l.event_id=? AND l.ordinal>=? ORDER BY l.ordinal LIMIT ?`)
    : db.prepare(`SELECT j.value AS payload_json FROM observation_evidence e, json_each(e.payload_json) j
        WHERE e.event_id=? AND CAST(j.key AS INTEGER)>=? ORDER BY CAST(j.key AS INTEGER) LIMIT ?`);
  for (const row of statement.iterate(id, offset, limit)) yield JSON.parse(row.payload_json);
}
module.exports = { encodeEvidence, writeEvidence, removeEvidence, readEvidence };
