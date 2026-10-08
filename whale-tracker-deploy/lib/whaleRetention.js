const { getDb, FILL_RETENTION_MS, CLOSED_POSITION_RETENTION_MS } = require('./db');
let timer;
let scanDb, cursors = {};

// LIMIT after NOT EXISTS bounds deletions, but can still scan every retained
// open-position event. Bound candidates first and rotate past protected rows.
function scanCandidates(db, table, cutoff, limit) {
  const cursor = cursors[table] || {time: -1, id: ''};
  const coin = table === 'events' ? 'a.coin' : "COALESCE(json_extract(a.payload_json,'$.items[0].coin'),'')";
  const side = table === 'events' ? 'p.side=a.side' : "LOWER(p.side)=LOWER(COALESCE(json_extract(a.payload_json,'$.items[0].side'),''))";
  const rows = db.prepare(`WITH candidates AS MATERIALIZED (
    SELECT * FROM ${table} WHERE time < ? AND (time,id) > (?,?) ORDER BY time,id LIMIT ?
  ) SELECT a.id,a.time,EXISTS (
    SELECT 1 FROM positions p WHERE p.whale_id=a.whale_id AND UPPER(p.coin)=UPPER(${coin}) AND ${side}
    AND (ABS(COALESCE(p.size,0))>1e-12 OR ABS(COALESCE(p.position_value,0))>1)
  ) AS protected FROM candidates a ORDER BY a.time,a.id`).all(cutoff,cursor.time,cursor.id,limit);
  return {rows, cursor: rows.length === limit ? rows.at(-1) : null};
}

// Bounded maintenance replaces the old full-table purge on every price tick.
function runRetentionBatch(now = Date.now(), limit = 500) {
  const db = getDb();
  const take = Math.max(1, Math.min(2000, Number(limit) || 500));
  if (scanDb !== db) { scanDb=db; cursors={}; }
  const scanLimit=Math.max(256,take);
  const nextCursors={};
  const removedAlertIds = [];
  let removedFills = 0;
  let removedEvents = 0;
  db.transaction(() => {
    removedFills += db.prepare('DELETE FROM fills WHERE id IN (SELECT id FROM fills WHERE time < ? ORDER BY time LIMIT ?)')
      .run(now - FILL_RETENTION_MS, take).changes;
    const closedCutoff = now - CLOSED_POSITION_RETENTION_MS;
    const events=scanCandidates(db,'events',closedCutoff,scanLimit);
    nextCursors.events=events.cursor;
    const dropEvent=db.prepare('DELETE FROM events WHERE id=?');
    for(const row of events.rows.filter(row=>!row.protected).slice(0,take))removedEvents+=dropEvent.run(row.id).changes;
    const alerts=scanCandidates(db,'alerts',closedCutoff,scanLimit);
    nextCursors.alerts=alerts.cursor;
    const rows=alerts.rows.filter(row=>!row.protected).slice(0,take);
    const drop = db.prepare('DELETE FROM alerts WHERE id=?');
    const dropItems = db.prepare('DELETE FROM alert_items WHERE alert_id=?');
    const dropSources = db.prepare('DELETE FROM alert_sources WHERE alert_id=?');
    for (const row of rows) { dropItems.run(row.id); dropSources.run(row.id); drop.run(row.id); removedAlertIds.push(row.id); }
  })();
  Object.assign(cursors,nextCursors);
  if (removedAlertIds.length) {
    require('./sqliteStore').invalidateAlertQueries();
    require('./whaleSync').stream.enqueue({ removedAlertIds });
  }
  return { removedFills, removedEvents, removedAlertIds };
}

function startRetention() {
  if (timer) return;
  timer = setInterval(() => {
    try { runRetentionBatch(); } catch (err) { console.warn('[whale-retention]', err.message); }
  }, 60_000);
  timer.unref?.();
}
module.exports = { runRetentionBatch, startRetention };
