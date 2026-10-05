const crypto = require('node:crypto');
function createStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS strategy_shadow_events (
    user_id TEXT NOT NULL, event_id TEXT NOT NULL, symbol TEXT NOT NULL, direction TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, snapshot_json TEXT NOT NULL,
    PRIMARY KEY(user_id,event_id));
    CREATE INDEX IF NOT EXISTS idx_shadow_events ON strategy_shadow_events(user_id,symbol,created_at DESC);
    CREATE TABLE IF NOT EXISTS strategy_shadow_analyses (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, event_id TEXT NOT NULL, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, status TEXT NOT NULL, record_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_shadow_analyses ON strategy_shadow_analyses(user_id,event_id,created_at DESC);`);
  const read = row => row ? JSON.parse(row.snapshot_json || row.record_json) : null;
  return {
    observe(userId, event) {
      const active = db.prepare('SELECT * FROM strategy_shadow_events WHERE user_id=? AND symbol=? AND direction=? AND expires_at>? ORDER BY created_at DESC LIMIT 1')
        .get(userId, event.symbol, event.direction, event.createdAt);
      if (active) return read(active); // One immutable event for a six-hour same-direction episode.
      db.prepare('INSERT OR IGNORE INTO strategy_shadow_events VALUES (?,?,?,?,?,?,?)')
        .run(userId, event.id, event.symbol, event.direction, event.createdAt, event.expiresAt, JSON.stringify(event));
      return this.event(userId, event.id);
    },
    event(userId, eventId) { return read(db.prepare('SELECT snapshot_json FROM strategy_shadow_events WHERE user_id=? AND event_id=?').get(userId, eventId)); },
    attempts(userId, eventId) { return db.prepare('SELECT record_json FROM strategy_shadow_analyses WHERE user_id=? AND event_id=? ORDER BY created_at DESC, rowid DESC').all(userId, eventId).map(read); },
    create(userId, event, now) {
      const record = { id: crypto.randomUUID(), eventId: event.id, symbol: event.symbol, status: 'RUNNING',
        createdAt: now, updatedAt: now, mode: 'LIVE_SHADOW_ONLY', executionInfluence: false, event };
      db.prepare('INSERT INTO strategy_shadow_analyses VALUES (?,?,?,?,?,?,?)').run(record.id, userId, event.id, now, now, record.status, JSON.stringify(record));
      return record;
    },
    update(userId, record, patch) {
      const next = { ...record, ...patch, updatedAt: Date.now() };
      db.prepare('UPDATE strategy_shadow_analyses SET status=?, updated_at=?,record_json=? WHERE id=? AND user_id=?')
        .run(next.status, next.updatedAt, JSON.stringify(next), record.id, userId);
      return next;
    },
    history(userId, symbol) {
      return db.prepare(`SELECT a.record_json FROM strategy_shadow_analyses a
        JOIN strategy_shadow_events e ON a.user_id=e.user_id AND a.event_id=e.event_id
        WHERE a.user_id=? AND e.symbol=? ORDER BY a.created_at DESC, a.rowid DESC LIMIT 20`).all(userId, symbol).map(read);
    },
    record(userId, id) { return read(db.prepare('SELECT record_json FROM strategy_shadow_analyses WHERE user_id=? AND id=?').get(userId, id)); },
  };
}
let store;
function getStore() { return store || (store = createStore(require('./db').getDb())); }
module.exports = { createStore, getStore };
