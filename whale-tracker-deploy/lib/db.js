/**
 * SQLite 连接与建表（better-sqlite3）
 * 库文件默认：项目根/data/whale.db，可用 SQLITE_PATH 覆盖
 */
const fs = require('fs');
const path = require('path');

const {
  FILL_MAX_PER_WHALE,
  CLOSED_POSITION_RETENTION_MS,
} = require('./positionEventPolicy');

/** @deprecated 兼容旧调用；仓位事件改为「持仓中保留 / 平仓后 1 天」 */
const RETENTION_MS = CLOSED_POSITION_RETENTION_MS;
/** 资金动态（fills）保留天数，默认 1 */
const FILL_RETENTION_MS = Math.max(
  60 * 60 * 1000,
  (Number(process.env.FILL_RETENTION_DAYS) || 1) * 24 * 60 * 60 * 1000,
);
/** 已平仓事件窗口（与 CLOSED_POSITION_RETENTION_MS 对齐） */
const ALERT_RETENTION_MS = CLOSED_POSITION_RETENTION_MS;

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

    CREATE TABLE IF NOT EXISTS user_exchange_keys (
      user_id TEXT NOT NULL,
      exchange TEXT NOT NULL,
      api_key TEXT NOT NULL DEFAULT '',
      api_secret TEXT NOT NULL DEFAULT '',
      api_passphrase TEXT NOT NULL DEFAULT '',
      simulated INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, exchange)
    );
    CREATE INDEX IF NOT EXISTS idx_user_exchange_keys_user ON user_exchange_keys(user_id);

    CREATE TABLE IF NOT EXISTS user_ai_keys (
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      api_key TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, provider)
    );
    CREATE INDEX IF NOT EXISTS idx_user_ai_keys_user ON user_ai_keys(user_id);

    CREATE TABLE IF NOT EXISTS v41_execution_records (
      order_intent_id TEXT PRIMARY KEY,
      user_id TEXT,
      client_order_id TEXT,
      exchange_order_id TEXT,
      status TEXT NOT NULL,
      request_json TEXT,
      response_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS whale_ai_runtime_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      lvl TEXT NOT NULL DEFAULT 'info',
      msg TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'ui'
    );
    CREATE INDEX IF NOT EXISTS idx_whale_ai_runtime_logs_user_ts
      ON whale_ai_runtime_logs(user_id, ts DESC);
  `);

  // soft migrations
  try {
    database.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`);
  } catch {
    // column exists
  }
  try {
    database.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_v41_exec_clord ON v41_execution_records(client_order_id) WHERE client_order_id IS NOT NULL AND client_order_id != ''`,
    );
  } catch {
    // ignore
  }
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

/**
 * 清理策略：
 * - fills：超过 FILL_RETENTION 的删掉；每鲸最多 FILL_MAX_PER_WHALE 条（留最新）
 * - events/alerts：当前持仓（positions 表）相关的一直保留；其余超过「平仓后窗口」删除
 */
function purgeOlderThan(retentionMs = RETENTION_MS) {
  const closedRetention = Number(retentionMs) > 0 ? retentionMs : ALERT_RETENTION_MS;
  const fillCutoff = Date.now() - FILL_RETENTION_MS;
  const closedCutoff = Date.now() - closedRetention;
  const database = getDb();

  let deletedDays = 0;
  try {
    const fillTimes = database
      .prepare('SELECT time FROM fills WHERE time < ? LIMIT 20000')
      .all(fillCutoff)
      .map((r) => r.time);
    deletedDays = countDistinctShanghaiDays(fillTimes);
  } catch {
    deletedDays = 0;
  }

  const fills = database.prepare('DELETE FROM fills WHERE time < ?').run(fillCutoff);

  // 每鲸 fills 上限：删掉最旧的多余行
  let fillCapDeleted = 0;
  const whaleIds = database
    .prepare(
      `SELECT whale_id AS id, COUNT(*) AS c FROM fills
       WHERE whale_id IS NOT NULL AND COALESCE(source, '') != 'onchain'
       GROUP BY whale_id HAVING c > ?`,
    )
    .all(FILL_MAX_PER_WHALE);
  const delExtra = database.prepare(`
    DELETE FROM fills WHERE id IN (
      SELECT id FROM fills
      WHERE whale_id = ? AND COALESCE(source, '') != 'onchain'
      ORDER BY time ASC
      LIMIT ?
    )
  `);
  const capTx = database.transaction(() => {
    for (const row of whaleIds) {
      const extra = Number(row.c) - FILL_MAX_PER_WHALE;
      if (extra <= 0) continue;
      fillCapDeleted += delExtra.run(row.id, extra).changes || 0;
    }
  });
  capTx();

  // 非当前持仓的 events / alerts：用 NOT EXISTS 批量删（避免逐行扫几十万）
  const events = database
    .prepare(
      `DELETE FROM events
       WHERE time < ?
         AND NOT EXISTS (
           SELECT 1 FROM positions p
           WHERE p.whale_id = events.whale_id
             AND UPPER(p.coin) = UPPER(COALESCE(events.coin, ''))
             AND p.side = events.side
             AND (ABS(COALESCE(p.size, 0)) > 1e-12 OR ABS(COALESCE(p.position_value, 0)) > 1)
         )`,
    )
    .run(closedCutoff);

  const alerts = database
    .prepare(
      `DELETE FROM alerts
       WHERE time < ?
         AND NOT EXISTS (
           SELECT 1 FROM positions p
           WHERE p.whale_id = alerts.whale_id
             AND UPPER(p.coin) = UPPER(COALESCE(json_extract(alerts.payload_json, '$.items[0].coin'), ''))
             AND LOWER(p.side) = LOWER(COALESCE(json_extract(alerts.payload_json, '$.items[0].side'), ''))
             AND (ABS(COALESCE(p.size, 0)) > 1e-12 OR ABS(COALESCE(p.position_value, 0)) > 1)
         )`,
    )
    .run(closedCutoff);

  const liveCount =
    Number(
      database
        .prepare(
          `SELECT COUNT(*) AS c FROM positions
           WHERE ABS(COALESCE(size, 0)) > 1e-12 OR ABS(COALESCE(position_value, 0)) > 1`,
        )
        .get()?.c,
    ) || 0;

  const deletedRows =
    (fills.changes || 0) + fillCapDeleted + (events.changes || 0) + (alerts.changes || 0);
  if (deletedRows > 0) {
    bumpDailyDeleted(deletedRows, deletedDays || 1);
  }
  return {
    cutoff: fillCutoff,
    fillCutoff,
    alertCutoff: closedCutoff,
    fillsDeleted: (fills.changes || 0) + fillCapDeleted,
    eventsDeleted: events.changes || 0,
    alertsDeleted: alerts.changes || 0,
    deletedRows,
    deletedDays,
    livePositions: liveCount,
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
  CLOSED_POSITION_RETENTION_MS,
  FILL_MAX_PER_WHALE,
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
