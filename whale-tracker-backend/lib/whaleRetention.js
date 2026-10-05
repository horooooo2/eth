const { getDb, FILL_RETENTION_MS, CLOSED_POSITION_RETENTION_MS, FILL_MAX_PER_WHALE } = require('./db');
let timer;

// Bounded maintenance replaces the old full-table purge on every price tick.
function runRetentionBatch(now = Date.now(), limit = 500) {
  const db = getDb();
  const take = Math.max(1, Math.min(2000, Number(limit) || 500));
  const removedAlertIds = [];
  let removedFills = 0;
  let removedEvents = 0;
  db.transaction(() => {
    removedFills += db.prepare('DELETE FROM fills WHERE id IN (SELECT id FROM fills WHERE time < ? ORDER BY time LIMIT ?)')
      .run(now - FILL_RETENTION_MS, take).changes;
    const over = db.prepare("SELECT whale_id, COUNT(*) AS n FROM fills WHERE whale_id IS NOT NULL AND COALESCE(source, '') != 'onchain' GROUP BY whale_id HAVING n > ? LIMIT 1").get(FILL_MAX_PER_WHALE);
    if (over) removedFills += db.prepare("DELETE FROM fills WHERE id IN (SELECT id FROM fills WHERE whale_id = ? AND COALESCE(source, '') != 'onchain' ORDER BY time DESC, id DESC LIMIT ? OFFSET ?)")
      .run(over.whale_id, take, FILL_MAX_PER_WHALE).changes;
    const closedCutoff = now - CLOSED_POSITION_RETENTION_MS;
    removedEvents = db.prepare(`DELETE FROM events WHERE id IN (
      SELECT e.id FROM events e WHERE e.time < ? AND NOT EXISTS (
        SELECT 1 FROM positions p WHERE p.whale_id=e.whale_id AND UPPER(p.coin)=UPPER(e.coin) AND p.side=e.side
        AND (ABS(COALESCE(p.size,0))>1e-12 OR ABS(COALESCE(p.position_value,0))>1)) ORDER BY e.time LIMIT ?)`)
      .run(closedCutoff, take).changes;
    const rows = db.prepare(`SELECT a.id FROM alerts a WHERE a.time < ? AND NOT EXISTS (
      SELECT 1 FROM positions p WHERE p.whale_id=a.whale_id
      AND UPPER(p.coin)=UPPER(COALESCE(json_extract(a.payload_json,'$.items[0].coin'),''))
      AND LOWER(p.side)=LOWER(COALESCE(json_extract(a.payload_json,'$.items[0].side'),''))
      AND (ABS(COALESCE(p.size,0))>1e-12 OR ABS(COALESCE(p.position_value,0))>1)) ORDER BY a.time LIMIT ?`).all(closedCutoff, take);
    const drop = db.prepare('DELETE FROM alerts WHERE id=?');
    const dropItems = db.prepare('DELETE FROM alert_items WHERE alert_id=?');
    const dropSources = db.prepare('DELETE FROM alert_sources WHERE alert_id=?');
    for (const row of rows) { dropItems.run(row.id); dropSources.run(row.id); drop.run(row.id); removedAlertIds.push(row.id); }
  })();
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
