'use strict';
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { RULE_VERSION, indicator, releaseTime, eventIdentity, macroDirection, compare } = require('./macroComparisonRules');
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
function createStore(file, now = Date.now()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, { timeout: 100 });
  db.pragma('journal_mode = WAL'); db.pragma('synchronous = NORMAL');
  db.exec(`CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE IF NOT EXISTS releases(id TEXT PRIMARY KEY,release_at INTEGER NOT NULL,family TEXT NOT NULL,event_json TEXT NOT NULL,first_seen INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS release_history ON releases(release_at DESC,id);
    CREATE TABLE IF NOT EXISTS windows(release_at INTEGER PRIMARY KEY,status TEXT NOT NULL,mode TEXT NOT NULL,result_json TEXT,revision_json TEXT,revision_done INTEGER DEFAULT 0,due_at INTEGER NOT NULL,error TEXT,attempts INTEGER DEFAULT 0,updated_at INTEGER NOT NULL);`);
  db.exec('CREATE INDEX IF NOT EXISTS window_queue ON windows(status,due_at); CREATE INDEX IF NOT EXISTS window_revision ON windows(revision_done,status,release_at);');
  db.exec('CREATE TABLE IF NOT EXISTS window_revisions(id INTEGER PRIMARY KEY,release_at INTEGER NOT NULL,result_json TEXT NOT NULL,created_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS window_revision_history ON window_revisions(release_at,id);');
  if (!db.prepare('PRAGMA table_info(windows)').all().some(column => column.name === 'verification_json')) db.exec('ALTER TABLE windows ADD COLUMN verification_json TEXT');
  if (!db.prepare('PRAGMA table_info(windows)').all().some(column => column.name === 'verification_due_at')) db.exec('ALTER TABLE windows ADD COLUMN verification_due_at INTEGER');
  db.prepare("INSERT OR IGNORE INTO metadata VALUES('started_at',?)").run(String(now));
  const startedAt = Number(db.prepare("SELECT value FROM metadata WHERE key='started_at'").get().value);
  db.prepare("UPDATE windows SET status='PENDING',due_at=? WHERE status='RUNNING'").run(now);
  if (db.prepare("SELECT value FROM metadata WHERE key='rule_version'").get()?.value !== RULE_VERSION) {
    // Recheck only recent forward snapshots. Historical evidence remains unchanged.
    db.prepare(`UPDATE windows SET status='PENDING',due_at=?,revision_done=1 WHERE status='COMPLETE' AND mode='PRE_RELEASE'
      AND result_json IS NOT NULL AND release_at>=? AND release_at<=?`).run(now,now-23*3600000,now);
    db.prepare("INSERT OR REPLACE INTO metadata VALUES('rule_version',?)").run(RULE_VERSION);
  }
  function archive(events, at = Date.now()) {
    db.transaction(() => {
      for (const event of events) {
        const id = eventIdentity(event); if (!id) continue;
        const releaseAt = releaseTime(event), family = indicator(event.title).family;
        const old = db.prepare('SELECT event_json,first_seen FROM releases WHERE id=?').get(id);
        const previous = parse(old?.event_json);
        // Keep the first forecast once published, rather than rewriting it using later consensus.
        const next = { ...previous,...event, forecast: previous?.forecast && at >= releaseAt ? previous.forecast : event.forecast || previous?.forecast || '',
          actual: previous?.actual || event.actual || '', previous: event.previous || previous?.previous || '',
          actualSource: previous?.actual ? previous.actualSource : event.actualSource, historyId: id };
        if (previous?.actual && event.actual && event.actual !== previous.actual) next.revisedActual = event.actual;
        // The timestamp belongs to this exact forecast version, never to an earlier value.
        next.forecastObservedAt = previous?.forecastVersion === RULE_VERSION && previous.forecast === next.forecast
          ? previous.forecastObservedAt || (next.forecast ? at : null) : next.forecast ? at : null;
        next.forecastVersion = RULE_VERSION;
        if (previous?.forecast !== next.forecast || previous?.actual !== next.actual) next.note = '';
        const payload = JSON.stringify(next);
        if (payload !== old?.event_json) db.prepare(`INSERT INTO releases VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET event_json=excluded.event_json,updated_at=excluded.updated_at`)
          .run(id,releaseAt,family,payload,old?.first_seen || at,at);
        const mode = startedAt <= releaseAt - 3600000 && (old?.first_seen || at) <= releaseAt - 3600000 ? 'PRE_RELEASE' : 'RETROSPECTIVE';
        db.prepare(`INSERT OR IGNORE INTO windows(release_at,status,mode,due_at,updated_at) VALUES(?,'PENDING',?,?,?)`).run(releaseAt,mode,releaseAt,at);
      }
    })();
  }
  function nextJob(at = Date.now()) {
    db.prepare("UPDATE windows SET status='PENDING',due_at=verification_due_at WHERE status='COMPLETE' AND verification_due_at<=?").run(at);
    // One bounded repair, 15 minutes after release; all indicators share this window.
    if (db.prepare("SELECT 1 FROM windows WHERE revision_done=0 AND status='COMPLETE' AND release_at<=? LIMIT 1").get(at-900000)) {
      db.prepare(`UPDATE windows SET status='PENDING',due_at=?,attempts=0 WHERE result_json IS NOT NULL AND revision_done=0 AND release_at<=? AND status='COMPLETE'`).run(at,at-900000);
    }
    const row = db.prepare("SELECT * FROM windows WHERE status IN ('PENDING','ERROR') AND due_at<=? ORDER BY due_at,release_at LIMIT 1").get(at);
    if (!row) return null;
    const cohort = parse(row.result_json)?.cohort;
    return { releaseAt: row.release_at, mode: row.result_json ? 'RETROSPECTIVE' : row.mode, revision: Boolean(row.result_json),
      frozenEvidenceHash: parse(row.result_json)?.mode === 'PRE_RELEASE' ? parse(row.result_json)?.evidenceHash : undefined,
      roster:Array.isArray(cohort) && cohort.every(whale=>whale && typeof whale.id==='string' && typeof whale.address==='string') ? cohort : undefined };
  }
  function running(job, at) { db.prepare("UPDATE windows SET status='RUNNING',updated_at=? WHERE release_at=?").run(at,job.releaseAt); }
  function commit(job,result,at = Date.now()) {
    const { verification, ...snapshot } = result;
    result = snapshot;
    const field = job.revision ? 'revision_json' : 'result_json';
    db.transaction(() => {
      const current = db.prepare('SELECT result_json,revision_json FROM windows WHERE release_at=?').get(job.releaseAt);
      if (!current || (!job.revision && current.result_json)) return;
      const primary = parse(current.result_json) || result, checked = verification || primary;
      const clean = [primary.quality,checked.quality].every(quality => quality && ['unknownReceipts','lateFills','revisedFills','invalidRows','unclassifiedFills'].every(key => quality[key] === 0));
      // Watermarks can advance without any new fills. Recheck only clean, incomplete forward windows,
      // at most once per five minutes, and stop before the raw hour expires.
      const verificationDue = primary.mode === 'PRE_RELEASE' && primary.evidenceHash && primary.coverage?.monitored > 0 && clean && !checked.coverage?.complete
        && checked.evidenceUnchanged !== false && at < job.releaseAt + 23*3600000
        ? Math.min(Math.max(at+300000,job.revision ? 0 : job.releaseAt+900000),job.releaseAt+23*3600000) : null;
      db.prepare('UPDATE windows SET verification_due_at=? WHERE release_at=?').run(verificationDue,job.releaseAt);
      if (job.revision && verification) db.prepare('UPDATE windows SET verification_json=? WHERE release_at=?').run(JSON.stringify(verification),job.releaseAt);
      if (job.revision) {
        const previous = parse(current.revision_json || current.result_json);
        const fingerprint = value => JSON.stringify([value?.evidenceHash,value?.coverage,value?.quality,value?.mode]);
        if (fingerprint(previous) === fingerprint(result)) {
          db.prepare("UPDATE windows SET status='COMPLETE',revision_done=1,error=NULL,attempts=0,updated_at=? WHERE release_at=?").run(at,job.releaseAt); return;
        }
        db.prepare('INSERT INTO window_revisions(release_at,result_json,created_at) VALUES(?,?,?)').run(job.releaseAt,JSON.stringify(result),at);
      }
      db.prepare(`UPDATE windows SET ${field}=?,status='COMPLETE',revision_done=?,error=NULL,attempts=0,updated_at=? WHERE release_at=?`)
        .run(JSON.stringify(result),job.revision || at >= job.releaseAt+900000 ? 1 : 0,at,job.releaseAt);
    })();
  }
  function repairable(at = Date.now()) {
    return db.prepare('SELECT release_at FROM windows WHERE release_at>=? AND release_at<=?').all(at-23*3600000,at).map(row=>row.release_at);
  }
  function requestRevision(releaseAt,at = Date.now()) {
    const row = db.prepare('SELECT status,result_json,updated_at FROM windows WHERE release_at=?').get(releaseAt);
    if (!row?.result_json || row.status === 'RUNNING') return false;
    if (row.status === 'PENDING' || row.status === 'ERROR') return true;
    db.prepare("UPDATE windows SET status='PENDING',due_at=?,revision_done=1,attempts=0 WHERE release_at=?")
      .run(Math.max(at,row.updated_at+300000),releaseAt); return true;
  }
  function fail(job,error,at = Date.now()) {
    db.prepare("UPDATE windows SET status='ERROR',error=?,attempts=attempts+1,due_at=?,updated_at=? WHERE release_at=?")
      .run(error,at+60000,at,job.releaseAt);
  }
  function pendingActuals(at = Date.now()) {
    return db.prepare('SELECT event_json FROM releases WHERE release_at<=? AND release_at>=? ORDER BY release_at DESC LIMIT 30').all(at,at-30*86400000)
      .map(row => parse(row.event_json)).filter(event => event && !event.actual);
  }
  function list({ page = 1, family = 'ALL', at = Date.now() } = {}) {
    const where = family === 'ALL' ? '' : 'AND r.family=@family';
    const params = { at, family, offset: (page-1)*20 };
    const total = db.prepare(`SELECT COUNT(*) AS count FROM releases r WHERE release_at<=@at ${where}`).get({ at,family }).count;
    const rows = db.prepare(`SELECT r.*,w.status,w.mode,w.result_json,w.revision_json,w.verification_json,w.error FROM releases r JOIN windows w ON w.release_at=r.release_at
      WHERE r.release_at<=@at ${where} ORDER BY r.release_at DESC,r.family,r.id LIMIT 20 OFFSET @offset`).all(params);
    return { total, page, pageSize: 20, rows: rows.map(row => {
      const event = parse(row.event_json), result = parse(row.result_json), revision = parse(row.revision_json), verification = parse(row.verification_json), direction = macroDirection(event,at);
      return { id: row.id, releaseAt: row.release_at, family: row.family, event, direction, status: row.status, error: row.error,
        result, revision, verification, comparisons: result ? Object.fromEntries(Object.entries(result.coins).map(([coin,flow]) => [coin,compare(direction,flow,result,event,verification)])) : null };
    }) };
  }
  function summary(at = Date.now()) {
    const batches = new Map();
    for (const row of db.prepare(`SELECT r.release_at,r.event_json,w.result_json,w.verification_json FROM releases r JOIN windows w ON w.release_at=r.release_at WHERE r.release_at<=?`).iterate(at)) {
      const event = parse(row.event_json), result = parse(row.result_json), direction = macroDirection(event,at);
      if (!result || !['LONG','SHORT'].includes(direction)) continue;
      const key = row.release_at;
      if (!batches.has(key)) batches.set(key,{result,verification:parse(row.verification_json),directions:new Set(),forecastsKnown:true});
      batches.get(key).directions.add(direction);
      if (!(event.forecastObservedAt && event.forecastObservedAt <= result.sinceMs)) batches.get(key).forecastsKnown = false;
      if (indicator(event.title)?.key.endsWith(':unknown')) batches.get(key).forecastsKnown = false;
    }
    const counts = { BTC: { eligible:0,matches:0,excluded:0 }, ETH: { eligible:0,matches:0,excluded:0 } };
    for (const { result,verification,directions,forecastsKnown } of batches.values()) for (const coin of ['BTC','ETH']) {
      const value = counts[coin];
      if (directions.size !== 1 || !forecastsKnown) { value.excluded++; continue; }
      const comparison = compare([...directions][0],result.coins[coin],result,null,verification);
      if (!comparison.eligible) { value.excluded++; continue; }
      value.eligible++; if (comparison.status === 'MATCH') value.matches++;
    }
    return Object.fromEntries(Object.entries(counts).map(([coin,value]) => [coin,{...value,rate:value.eligible ? value.matches/value.eligible : null}]));
  }
  return { archive, nextJob, running, commit, fail, pendingActuals, list, summary, repairable, requestRevision, startedAt, file,
    close: () => db.close(), ruleVersion: RULE_VERSION };
}
module.exports = { createStore };
