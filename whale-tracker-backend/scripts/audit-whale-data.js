'use strict';
// Explicit path, read-only connection, no migrations and no automatic repair.
const path = require('node:path');
const Database = require('better-sqlite3');
const flag = process.argv.indexOf('--db');
if (flag < 0 || !process.argv[flag + 1]) {
  console.error('Usage: node scripts/audit-whale-data.js --db <SQLite file>');
  process.exit(2);
}
const db = new Database(path.resolve(process.argv[flag + 1]), { readonly: true, fileMustExist: true });
try {
  const result = {
    readOnly: true,
    note: 'Flags identify candidates for review, not amounts to divide or delete. Rebuild only from verified raw fills.',
    counts: Object.fromEntries(['whales','positions','fills','events','alerts'].map(table => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n])),
    aggregateFillCandidates: db.prepare("SELECT COUNT(*) AS n FROM fills WHERE instr(id,'+')>0 OR COALESCE(json_extract(payload_json,'$.fillCount'),1)>1").get().n,
    legacyMergedAlertCandidates: db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE json_array_length(payload_json,'$.items')>1 AND json_extract(payload_json,'$.totalUsd') IS NULL").get().n,
    aggregateSamples: db.prepare("SELECT id,whale_id,time,amount_usd FROM fills WHERE instr(id,'+')>0 ORDER BY time DESC LIMIT 10").all(),
    legacyAlertSamples: db.prepare("SELECT id,whale_id,time FROM alerts WHERE json_array_length(payload_json,'$.items')>1 AND json_extract(payload_json,'$.totalUsd') IS NULL ORDER BY time DESC LIMIT 10").all(),
  };
  console.log(JSON.stringify(result, null, 2));
} finally { db.close(); }
