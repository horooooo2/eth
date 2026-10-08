// Disposable, disk-backed derived facts. Never hold the raw retention window in JS.
// The authoritative fills table is untouched; a restart rebuilds this TEMP index.
function createFillFactProjection({ getDb, retentionMs, classify, canonicalId,
  now = Date.now, untilMs = Number.MAX_SAFE_INTEGER, cacheKiB = 2048, onProgress = () => {} }) {
  let state = null;
  const batchSize = 256;
  function initialize() {
    const db = getDb();
    if (state?.db === db) return state;
    db.exec(`PRAGMA temp_store = FILE;
      PRAGMA temp.cache_size = -${Math.max(2048, Math.min(16384, Math.floor(cacheKiB)))};
      DROP TABLE IF EXISTS temp.execution_facts;
      CREATE TEMP TABLE execution_facts (
        id TEXT PRIMARY KEY, time INTEGER NOT NULL, whale_id TEXT, facts TEXT NOT NULL
      );
      CREATE INDEX temp.execution_facts_time ON execution_facts(time);`);
    const cutoff = now() - retentionMs;
    state = { db, ready: false, cursorTime: cutoff, cursorId: '', prunedAt: now(), pending: null, scanned: 0,
      scan: db.prepare(`SELECT id,time,payload_json FROM fills
        WHERE (time,id) > (?,?) AND time <= ? AND COALESCE(source,'') != 'onchain'
        ORDER BY time,id LIMIT ?`),
      put: db.prepare('INSERT OR REPLACE INTO temp.execution_facts VALUES(?,?,?,?)'),
      remove: db.prepare('DELETE FROM temp.execution_facts WHERE id=?') };
    return state;
  }
  function put(s, trade) {
    const id = canonicalId(trade);
    if (!id) return;
    const events = trade.source === 'onchain' || Number(trade.time) < now() - retentionMs || Number(trade.time) > untilMs
      ? [] : classify(trade).map(event => ({ ...event,
        payload: { price: trade.price, whaleName: trade.whaleName, from: trade.from || trade.address } }));
    if (events.length) s.put.run(id, events[0].time, String(trade.whaleId || ''), JSON.stringify(events));
    else s.remove.run(id);
  }
  function step(s) {
    const rows = s.scan.all(s.cursorTime, s.cursorId, untilMs, batchSize);
    s.db.transaction(() => {
      for (const row of rows) {
        let trade;
        try { trade = JSON.parse(row.payload_json); } catch { continue; }
        if (trade) put(s, trade);
      }
    })();
    if (rows.length) {
      const last = rows[rows.length - 1]; s.cursorTime = last.time; s.cursorId = last.id;
    }
    if (rows.length < batchSize) s.ready = true;
    s.scanned += rows.length;
    if (s.ready || s.scanned % 10240 === 0) onProgress({ phase: 'projection', scanned: s.scanned, ready: s.ready });
  }
  function ensure() {
    const s = initialize();
    try { while (!s.ready) step(s); } catch (err) { state = null; throw err; }
    return s;
  }
  async function prepare() {
    const s = initialize();
    if (s.ready) return;
    if (s.pending) return s.pending;
    s.pending = (async () => {
      try {
        while (state === s && !s.ready) {
          step(s);
          await new Promise(resolve => setImmediate(resolve));
        }
        if (state !== s) throw new Error('Execution projection invalidated during rebuild');
      } catch (err) { if (state === s) state = null; throw err; }
      finally { s.pending = null; }
    })();
    return s.pending;
  }
  function update(trades) {
    if (!state || state.db !== getDb()) return;
    const s = state;
    try { s.db.transaction(() => { for (const trade of trades) put(s, trade); })(); }
    catch (err) {
      // The source commit already succeeded. Discard the derived cache, never serve stale facts.
      state = null;
      console.warn('[execution-facts] discarded failed cache:', err.message);
    }
  }
  function* read(since, until, includeExits, eligibleWhales) {
    if (eligibleWhales?.size === 0) return;
    const s = ensure(), cutoff = now() - retentionMs;
    if (now() - s.prunedAt > 60000) {
      s.db.prepare('DELETE FROM temp.execution_facts WHERE time < ?').run(cutoff);
      s.prunedAt = now();
    }
    const query = s.db.prepare('SELECT whale_id,facts FROM temp.execution_facts WHERE time >= ? AND time <= ? ORDER BY time');
    for (const row of query.iterate(Math.max(since, cutoff), until)) {
      if (eligibleWhales && !eligibleWhales.has(row.whale_id)) continue;
      for (const event of JSON.parse(row.facts)) {
        if (includeExits || event.kind === 'open' || event.kind === 'increase') yield event;
      }
    }
  }
  return { read, update, prepare, invalidate() { state = null; } };
}
module.exports = { createFillFactProjection };
