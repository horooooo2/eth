/**
 * SQLite 连接与建表（better-sqlite3）
 * 库文件默认：项目根/data/whale.db，可用 SQLITE_PATH 覆盖
 */
const fs = require('fs');
const path = require('path');

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** 资金动态（fills）保留天数，可用 FILL_RETENTION_DAYS 覆盖，默认 3 */
const FILL_RETENTION_MS = Math.max(
  24 * 60 * 60 * 1000,
  (Number(process.env.FILL_RETENTION_DAYS) || 3) * 24 * 60 * 60 * 1000,
);
/** 异动 / events 保留（默认仍 7 天） */
const ALERT_RETENTION_MS = Math.max(
  24 * 60 * 60 * 1000,
  (Number(process.env.ALERT_RETENTION_DAYS) || 7) * 24 * 60 * 60 * 1000,
);

let db;
let Database;

function resolveDbPath() {
  if (process.env.SQLITE_PATH) return process.env.SQLITE_PATH;
  return path.join(__dirname, '..', 'data', 'whale.db');
}

function getDatabaseCtor() {
  if (Database) return Database;
  try {
    Database = require('better-sqlite3');
    return Database;
  } catch (err) {
    const e = new Error(
      `无法加载 better-sqlite3：${err.message}。请在服务器执行 npm install（必要时先装 build-essential）`,
    );
    e.cause = err;
    throw e;
  }
}

function migrate(database) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS whales (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      direction TEXT,
      long_usd REAL DEFAULT 0,
      short_usd REAL DEFAULT 0,
      net_usd REAL DEFAULT 0,
      priority REAL DEFAULT 0,
      closed_trades INTEGER DEFAULT 0,
      error TEXT,
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS positions (
      whale_id TEXT NOT NULL,
      coin TEXT NOT NULL,
      side TEXT NOT NULL,
      size REAL DEFAULT 0,
      entry_px REAL DEFAULT 0,
      position_value REAL DEFAULT 0,
      unrealized_pnl REAL DEFAULT 0,
      leverage REAL,
      open_time INTEGER,
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (whale_id, coin, side)
    );

    CREATE TABLE IF NOT EXISTS fills (
      id TEXT PRIMARY KEY,
      whale_id TEXT,
      time INTEGER NOT NULL,
      asset TEXT,
      side TEXT,
      amount REAL DEFAULT 0,
      amount_usd REAL DEFAULT 0,
      price REAL DEFAULT 0,
      closed_pnl REAL DEFAULT 0,
      hash TEXT,
      source TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fills_time ON fills(time);
    CREATE INDEX IF NOT EXISTS idx_fills_whale_time ON fills(whale_id, time);

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      whale_id TEXT,
      time INTEGER NOT NULL,
      kind TEXT NOT NULL,
      coin TEXT,
      side TEXT,
      usd REAL DEFAULT 0,
      title TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_time ON events(time);
    CREATE INDEX IF NOT EXISTS idx_events_whale_time ON events(whale_id, time);

    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      whale_id TEXT,
      time INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_time ON alerts(time);
    CREATE INDEX IF NOT EXISTS idx_alerts_whale_time ON alerts(whale_id, time);

    CREATE TABLE IF NOT EXISTS sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY,
      settings_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );
  `);
}

function getDb() {
  if (db) return db;
  const DatabaseCtor = getDatabaseCtor();
  const file = resolveDbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseCtor(file);
  migrate(db);
  console.log(`[sqlite] ready ${file}`);
  return db;
}

function closeDb() {
  if (!db) return;
  try {
    db.close();
  } catch {
    // ignore
  }
  db = null;
}

function setMeta(key, value) {
  const database = getDb();
  database
    .prepare(
      `INSERT INTO sync_meta(key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(String(key), value == null ? '' : String(value), Date.now());
}

function getMeta(key) {
  const row = getDb().prepare('SELECT value, updated_at FROM sync_meta WHERE key = ?').get(String(key));
  if (!row) return null;
  return { value: row.value, updatedAt: Number(row.updated_at) || 0 };
}

function shanghaiYmd(ts = Date.now()) {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

/** 跨自然日（上海）时清零今日计数 */
function ensureDailyIoBucket() {
  const ymd = shanghaiYmd();
  const cur = getMeta('daily_io_ymd');
  if (cur?.value !== ymd) {
    setMeta('daily_io_ymd', ymd);
    setMeta('daily_added_rows', '0');
    setMeta('daily_deleted_rows', '0');
    setMeta('daily_deleted_days', '0');
  }
  return ymd;
}

function bumpMetaCounter(key, delta) {
  const n = Math.max(0, Math.floor(Number(delta) || 0));
  if (!n) return;
  ensureDailyIoBucket();
  const cur = Number(getMeta(key)?.value || 0) || 0;
  setMeta(key, String(cur + n));
}

function bumpDailyAdded(rows) {
  bumpMetaCounter('daily_added_rows', rows);
}

function bumpDailyDeleted(rows, days) {
  bumpMetaCounter('daily_deleted_rows', rows);
  bumpMetaCounter('daily_deleted_days', days);
}

function readDailyIoStats() {
  ensureDailyIoBucket();
  return {
    ymd: getMeta('daily_io_ymd')?.value || shanghaiYmd(),
    addedRows: Number(getMeta('daily_added_rows')?.value || 0) || 0,
    deletedRows: Number(getMeta('daily_deleted_rows')?.value || 0) || 0,
    deletedDays: Number(getMeta('daily_deleted_days')?.value || 0) || 0,
  };
}

function countDistinctShanghaiDays(times = []) {
  const set = new Set();
  for (const t of times) {
    const n = Number(t) || 0;
    if (!n) continue;
    set.add(shanghaiYmd(n));
  }
  return set.size;
}

function purgeOlderThan(retentionMs = RETENTION_MS) {
  // retentionMs 兼容旧调用：同时用作 alerts/events 窗口；fills 用更短的 FILL_RETENTION_MS
  const alertRetention = retentionMs || ALERT_RETENTION_MS;
  const fillCutoff = Date.now() - FILL_RETENTION_MS;
  const alertCutoff = Date.now() - alertRetention;
  const database = getDb();

  // 删除前统计涉及多少个自然日（上海），供看板「今日删除」
  let deletedDays = 0;
  try {
    const fillTimes = database
      .prepare('SELECT time FROM fills WHERE time < ? LIMIT 20000')
      .all(fillCutoff)
      .map((r) => r.time);
    const eventTimes = database
      .prepare('SELECT time FROM events WHERE time < ? LIMIT 20000')
      .all(alertCutoff)
      .map((r) => r.time);
    const alertTimes = database
      .prepare('SELECT time FROM alerts WHERE time < ? LIMIT 20000')
      .all(alertCutoff)
      .map((r) => r.time);
    deletedDays = countDistinctShanghaiDays([...fillTimes, ...eventTimes, ...alertTimes]);
  } catch {
    deletedDays = 0;
  }

  const fills = database.prepare('DELETE FROM fills WHERE time < ?').run(fillCutoff);
  const events = database.prepare('DELETE FROM events WHERE time < ?').run(alertCutoff);
  const alerts = database.prepare('DELETE FROM alerts WHERE time < ?').run(alertCutoff);
  const deletedRows =
    (fills.changes || 0) + (events.changes || 0) + (alerts.changes || 0);
  if (deletedRows > 0) {
    bumpDailyDeleted(deletedRows, deletedDays || (deletedRows > 0 ? 1 : 0));
  }
  return {
    cutoff: fillCutoff,
    fillCutoff,
    alertCutoff,
    fillsDeleted: fills.changes || 0,
    eventsDeleted: events.changes || 0,
    alertsDeleted: alerts.changes || 0,
    deletedRows,
    deletedDays,
  };
}

function dbStatus() {
  try {
    const database = getDb();
    const whales = database.prepare('SELECT COUNT(*) AS c FROM whales').get().c;
    const fills = database.prepare('SELECT COUNT(*) AS c FROM fills').get().c;
    const events = database.prepare('SELECT COUNT(*) AS c FROM events').get().c;
    const alerts = database.prepare('SELECT COUNT(*) AS c FROM alerts').get().c;
    const meta = getMeta('whales_updated_at');
    return {
      ok: true,
      path: resolveDbPath(),
      whales,
      fills,
      events,
      alerts,
      whalesUpdatedAt: meta ? Number(meta.value) || meta.updatedAt : 0,
    };
  } catch (err) {
    return { ok: false, error: err.message, path: resolveDbPath() };
  }
}

module.exports = {
  RETENTION_MS,
  FILL_RETENTION_MS,
  ALERT_RETENTION_MS,
  resolveDbPath,
  getDb,
  closeDb,
  setMeta,
  getMeta,
  purgeOlderThan,
  dbStatus,
  shanghaiYmd,
  ensureDailyIoBucket,
  bumpDailyAdded,
  bumpDailyDeleted,
  readDailyIoStats,
};
