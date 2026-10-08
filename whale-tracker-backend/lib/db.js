/**
 * SQLite 连接与建表（better-sqlite3）
 * 库文件默认：项目根/data/whale.db，可用 SQLITE_PATH 覆盖
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  FILL_MAX_PER_WHALE,
  CLOSED_POSITION_RETENTION_MS,
} = require('./positionEventPolicy');

/** @deprecated 兼容旧调用；仓位事件改为「持仓中保留 / 平仓后 1 天」 */
const RETENTION_MS = CLOSED_POSITION_RETENTION_MS;
/** 原始成交保留至少 24 小时，默认 2 天；展示条数不得裁剪统计事实 */
const FILL_RETENTION_MS = Math.max(
  24 * 60 * 60 * 1000,
  (Number(process.env.FILL_RETENTION_DAYS) || 2) * 24 * 60 * 60 * 1000,
);
/** 已平仓事件窗口（与 CLOSED_POSITION_RETENTION_MS 对齐） */
const ALERT_RETENTION_MS = CLOSED_POSITION_RETENTION_MS;

let db;
let Database;
let isolatedTestDir = null;

function isolateTestDbPath() {
  if (isolatedTestDir) return process.env.SQLITE_PATH;
  const id = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  isolatedTestDir = fs.mkdtempSync(path.join(os.tmpdir(), `whale-test-${id}-`));
  const file = path.join(isolatedTestDir, `whale-${id}.db`);
  process.env.SQLITE_PATH = file;
  const cleanup = () => {
    try {
      closeDb();
    } catch {
      // ignore
    }
    if (!isolatedTestDir) return;
    try {
      fs.rmSync(isolatedTestDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    isolatedTestDir = null;
  };
  process.on('exit', cleanup);
  return file;
}

function resolveDbPath() {
  if (process.env.SQLITE_PATH) return process.env.SQLITE_PATH;
  if (process.env.NODE_TEST_CONTEXT) return isolateTestDbPath();
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
    PRAGMA recursive_triggers = ON;

    CREATE TABLE IF NOT EXISTS observation_inputs (
      id TEXT PRIMARY KEY, whale_id TEXT NOT NULL, coin TEXT NOT NULL,
      time INTEGER NOT NULL, received_at INTEGER NOT NULL, payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS observation_inputs_pair ON observation_inputs(whale_id, coin, time);
    CREATE INDEX IF NOT EXISTS observation_inputs_time ON observation_inputs(time);
    CREATE TABLE IF NOT EXISTS observation_jobs (
      whale_id TEXT NOT NULL, coin TEXT NOT NULL, PRIMARY KEY(whale_id, coin)
    );
    CREATE TABLE IF NOT EXISTS observation_pair_runs (
      whale_id TEXT NOT NULL, coin TEXT NOT NULL, last_run INTEGER NOT NULL,
      PRIMARY KEY(whale_id, coin)
    );
    CREATE TABLE IF NOT EXISTS whale_observations (
      id TEXT PRIMARY KEY, whale_id TEXT NOT NULL, coin TEXT NOT NULL,
      last_at INTEGER NOT NULL, payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS observation_evidence (
      event_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS observation_evidence_rows (
      hash TEXT PRIMARY KEY, payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS observation_evidence_links (
      event_id TEXT NOT NULL, ordinal INTEGER NOT NULL, hash TEXT NOT NULL,
      PRIMARY KEY(event_id, ordinal)
    );
    CREATE INDEX IF NOT EXISTS observation_evidence_links_hash ON observation_evidence_links(hash);
    CREATE INDEX IF NOT EXISTS observations_pair ON whale_observations(whale_id, coin);
    CREATE INDEX IF NOT EXISTS observations_time ON whale_observations(last_at DESC, id);
    CREATE TABLE IF NOT EXISTS observation_versions (
      whale_id TEXT NOT NULL, coin TEXT NOT NULL, version INTEGER NOT NULL,
      PRIMARY KEY(whale_id,coin)
    );
    CREATE TABLE IF NOT EXISTS observation_summary_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
    INSERT OR IGNORE INTO observation_summary_version VALUES(1,0);
    CREATE TABLE IF NOT EXISTS observation_calculations (token TEXT PRIMARY KEY, started_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS observation_staged_rows (token TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(token,hash));
    CREATE INDEX IF NOT EXISTS observation_staged_rows_hash ON observation_staged_rows(hash);
    CREATE TABLE IF NOT EXISTS observation_evidence_versions (
      event_id TEXT NOT NULL, token TEXT NOT NULL, ordinal INTEGER NOT NULL, hash TEXT NOT NULL,
      PRIMARY KEY(token,event_id,ordinal)
    );
    CREATE INDEX IF NOT EXISTS observation_evidence_versions_hash ON observation_evidence_versions(hash);
    CREATE TABLE IF NOT EXISTS observation_evidence_blocks (
      hash TEXT PRIMARY KEY, hashes_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS observation_evidence_block_versions (
      event_id TEXT NOT NULL, token TEXT NOT NULL, ordinal INTEGER NOT NULL, hash TEXT NOT NULL,
      PRIMARY KEY(token,event_id,ordinal)
    );
    CREATE INDEX IF NOT EXISTS observation_evidence_block_versions_hash ON observation_evidence_block_versions(hash);
    CREATE TABLE IF NOT EXISTS observation_staged_blocks (
      token TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(token,hash)
    );
    CREATE INDEX IF NOT EXISTS observation_staged_blocks_hash ON observation_staged_blocks(hash);
    CREATE TABLE IF NOT EXISTS observation_input_guards (
      whale_id TEXT NOT NULL, coin TEXT NOT NULL, invalidation INTEGER NOT NULL, max_time INTEGER NOT NULL,
      PRIMARY KEY(whale_id,coin)
    );
    INSERT OR IGNORE INTO observation_input_guards
      SELECT i.whale_id,i.coin,0,MAX(i.time) FROM observation_inputs i
      WHERE NOT EXISTS (SELECT 1 FROM observation_input_guards g WHERE g.whale_id=i.whale_id AND g.coin=i.coin)
      GROUP BY i.whale_id,i.coin;
    CREATE TABLE IF NOT EXISTS observation_committed_versions (
      whale_id TEXT NOT NULL, coin TEXT NOT NULL, version INTEGER NOT NULL,
      window_at INTEGER NOT NULL, through_at INTEGER, PRIMARY KEY(whale_id,coin)
    );
    CREATE TABLE IF NOT EXISTS observation_gc_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
    INSERT OR IGNORE INTO observation_gc_version VALUES(1,0);
    ${['observation_evidence','observation_evidence_rows','observation_evidence_links','observation_evidence_versions',
      'observation_evidence_blocks','observation_evidence_block_versions','observation_staged_rows','observation_staged_blocks',
      'observation_calculations','whale_observations'].flatMap(table=>['INSERT','UPDATE','DELETE'].map(action=>
      `CREATE TRIGGER IF NOT EXISTS gc_${table}_${action.toLowerCase()} AFTER ${action} ON ${table} BEGIN
        UPDATE observation_gc_version SET version=version+1 WHERE id=1; END;`)).join('\n')}
    CREATE TRIGGER IF NOT EXISTS observation_guard_insert AFTER INSERT ON observation_inputs BEGIN
      INSERT INTO observation_input_guards VALUES(NEW.whale_id,NEW.coin,0,NEW.time)
        ON CONFLICT(whale_id,coin) DO UPDATE SET
          invalidation=invalidation+CASE WHEN NEW.time<=max_time THEN 1 ELSE 0 END,
          max_time=MAX(max_time,NEW.time);
    END;
    CREATE TRIGGER IF NOT EXISTS observation_guard_delete AFTER DELETE ON observation_inputs BEGIN
      INSERT INTO observation_input_guards VALUES(OLD.whale_id,OLD.coin,1,OLD.time)
        ON CONFLICT(whale_id,coin) DO UPDATE SET invalidation=invalidation+1;
    END;
    CREATE TRIGGER IF NOT EXISTS observation_guard_update AFTER UPDATE ON observation_inputs BEGIN
      INSERT INTO observation_input_guards VALUES(OLD.whale_id,OLD.coin,1,OLD.time)
        ON CONFLICT(whale_id,coin) DO UPDATE SET invalidation=invalidation+1;
      INSERT INTO observation_input_guards VALUES(NEW.whale_id,NEW.coin,1,NEW.time)
        ON CONFLICT(whale_id,coin) DO UPDATE SET invalidation=invalidation+1,max_time=MAX(max_time,NEW.time);
    END;
    CREATE TRIGGER IF NOT EXISTS observation_input_insert AFTER INSERT ON observation_inputs BEGIN
      INSERT INTO observation_versions VALUES(NEW.whale_id,NEW.coin,1)
        ON CONFLICT(whale_id,coin) DO UPDATE SET version=version+1;
      INSERT INTO observation_jobs SELECT NEW.whale_id,NEW.coin WHERE NOT EXISTS
        (SELECT 1 FROM observation_jobs WHERE whale_id=NEW.whale_id AND coin=NEW.coin);
    END;
    CREATE TRIGGER IF NOT EXISTS observation_input_delete AFTER DELETE ON observation_inputs BEGIN
      INSERT INTO observation_versions VALUES(OLD.whale_id,OLD.coin,1)
        ON CONFLICT(whale_id,coin) DO UPDATE SET version=version+1;
      INSERT INTO observation_jobs SELECT OLD.whale_id,OLD.coin WHERE NOT EXISTS
        (SELECT 1 FROM observation_jobs WHERE whale_id=OLD.whale_id AND coin=OLD.coin);
    END;
    CREATE TRIGGER IF NOT EXISTS observation_input_update AFTER UPDATE ON observation_inputs BEGIN
      INSERT INTO observation_versions VALUES(OLD.whale_id,OLD.coin,1)
        ON CONFLICT(whale_id,coin) DO UPDATE SET version=version+1;
      INSERT INTO observation_versions VALUES(NEW.whale_id,NEW.coin,1)
        ON CONFLICT(whale_id,coin) DO UPDATE SET version=version+1;
      INSERT INTO observation_jobs SELECT OLD.whale_id,OLD.coin WHERE NOT EXISTS
        (SELECT 1 FROM observation_jobs WHERE whale_id=OLD.whale_id AND coin=OLD.coin);
      INSERT INTO observation_jobs SELECT NEW.whale_id,NEW.coin WHERE NOT EXISTS
        (SELECT 1 FROM observation_jobs WHERE whale_id=NEW.whale_id AND coin=NEW.coin);
    END;
    CREATE TRIGGER IF NOT EXISTS observation_summary_insert AFTER INSERT ON whale_observations BEGIN
      UPDATE observation_summary_version SET version=version+1 WHERE id=1;
    END;
    CREATE TRIGGER IF NOT EXISTS observation_summary_update AFTER UPDATE ON whale_observations BEGIN
      UPDATE observation_summary_version SET version=version+1 WHERE id=1;
    END;
    CREATE TRIGGER IF NOT EXISTS observation_summary_delete AFTER DELETE ON whale_observations BEGIN
      UPDATE observation_summary_version SET version=version+1 WHERE id=1;
    END;
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
    CREATE INDEX IF NOT EXISTS idx_positions_retention_match ON positions(whale_id,UPPER(coin),LOWER(side));

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
    CREATE INDEX IF NOT EXISTS idx_fills_observation_scan ON fills(time,id);
    CREATE INDEX IF NOT EXISTS idx_fills_whale_time ON fills(whale_id, time);
    CREATE TABLE IF NOT EXISTS statistics_input_version(id INTEGER PRIMARY KEY,version INTEGER NOT NULL);
    INSERT OR IGNORE INTO statistics_input_version VALUES(1,0);
    CREATE TABLE IF NOT EXISTS statistics_batches(id TEXT PRIMARY KEY,version INTEGER NOT NULL,as_of INTEGER NOT NULL,roster_key TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS statistics_results(batch_id TEXT NOT NULL,key TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(batch_id,key));
    CREATE TABLE IF NOT EXISTS statistics_current(id INTEGER PRIMARY KEY,batch_id TEXT NOT NULL);
    ${['fills','whales'].flatMap(table=>['INSERT','UPDATE','DELETE'].map(action=>
      `CREATE TRIGGER IF NOT EXISTS statistics_${table}_${action.toLowerCase()} AFTER ${action} ON ${table} BEGIN
        UPDATE statistics_input_version SET version=version+1 WHERE id=1; END;`)).join('\n')}

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
    CREATE INDEX IF NOT EXISTS idx_events_retention_scan ON events(time,id);
    CREATE INDEX IF NOT EXISTS idx_events_whale_time ON events(whale_id, time);

    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      whale_id TEXT,
      time INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_time ON alerts(time);
    CREATE INDEX IF NOT EXISTS idx_alerts_retention_scan ON alerts(time,id);
    CREATE INDEX IF NOT EXISTS idx_alerts_whale_time ON alerts(whale_id, time);

    CREATE TABLE IF NOT EXISTS alert_items (
      alert_id TEXT NOT NULL,
      item_index INTEGER NOT NULL,
      kind TEXT,
      coin TEXT NOT NULL DEFAULT '',
      side TEXT NOT NULL DEFAULT '',
      usd REAL DEFAULT 0,
      time INTEGER DEFAULT 0,
      PRIMARY KEY (alert_id, item_index)
    );
    CREATE INDEX IF NOT EXISTS idx_alert_items_alert_coin_side_usd
      ON alert_items(alert_id, coin, side, usd);
    CREATE INDEX IF NOT EXISTS idx_alert_items_coin_side_usd_alert
      ON alert_items(coin, side, usd, alert_id);

    CREATE TABLE IF NOT EXISTS alert_sources (
      source_id TEXT PRIMARY KEY,
      alert_id TEXT NOT NULL
    );

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

    CREATE TABLE IF NOT EXISTS user_ai_keys (
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      api_key TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, provider)
    );
    CREATE INDEX IF NOT EXISTS idx_user_ai_keys_user ON user_ai_keys(user_id);

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

    CREATE TABLE IF NOT EXISTS okx_ai_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      ord_id TEXT NOT NULL,
      cl_ord_id TEXT NOT NULL DEFAULT '',
      inst_id TEXT NOT NULL,
      coin TEXT NOT NULL DEFAULT '',
      side TEXT NOT NULL,
      pos_side TEXT NOT NULL DEFAULT '',
      px REAL,
      sz TEXT NOT NULL DEFAULT '',
      amount_usd REAL,
      leverage INTEGER,
      simulated INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, ord_id)
    );
    CREATE INDEX IF NOT EXISTS idx_okx_ai_orders_user ON okx_ai_orders(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS binance_ai_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      client_order_id TEXT NOT NULL DEFAULT '',
      symbol TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'crypto',
      side TEXT NOT NULL,
      position_side TEXT NOT NULL DEFAULT 'BOTH',
      price REAL,
      quantity TEXT NOT NULL DEFAULT '',
      margin_usdt REAL,
      leverage INTEGER,
      simulated INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, order_id)
    );
    CREATE INDEX IF NOT EXISTS idx_binance_ai_orders_user ON binance_ai_orders(user_id, scope, created_at DESC);

    CREATE TABLE IF NOT EXISTS tradfi_range_strategies (
      user_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'waiting',
      simulated INTEGER NOT NULL DEFAULT 0,
      additions INTEGER NOT NULL DEFAULT 0,
      state_json TEXT NOT NULL DEFAULT '{}',
      last_error TEXT NOT NULL DEFAULT '',
      started_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, symbol)
    );
    CREATE INDEX IF NOT EXISTS idx_tradfi_range_enabled ON tradfi_range_strategies(enabled, updated_at DESC);

    CREATE TABLE IF NOT EXISTS tradfi_range_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tradfi_range_events_user ON tradfi_range_events(user_id, symbol, created_at DESC);

    CREATE TABLE IF NOT EXISTS tradfi_manual_strategy_closures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      trade_id TEXT NOT NULL,
      order_id TEXT NOT NULL DEFAULT '',
      symbol TEXT NOT NULL,
      side TEXT NOT NULL DEFAULT '',
      position_side TEXT NOT NULL DEFAULT '',
      price REAL,
      quantity REAL NOT NULL DEFAULT 0,
      amount_usd REAL,
      realized_pnl REAL NOT NULL DEFAULT 0,
      commission REAL NOT NULL DEFAULT 0,
      commission_asset TEXT NOT NULL DEFAULT 'USDT',
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, trade_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tradfi_manual_closures_user ON tradfi_manual_strategy_closures(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS tradfi_ai_analyses (
      analysis_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      context_hash TEXT NOT NULL,
      engine_version TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      status TEXT NOT NULL,
      model TEXT,
      context_json TEXT NOT NULL DEFAULT '{}',
      direction_json TEXT NOT NULL DEFAULT '{}',
      explanation_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id, symbol, context_hash, engine_version, prompt_version)
    );
    CREATE INDEX IF NOT EXISTS idx_tradfi_ai_analyses_user ON tradfi_ai_analyses(user_id, symbol, created_at DESC);
  `);
  // Add a derived display index without altering any historical amounts/payloads.
  if (!database.prepare('PRAGMA table_info(alerts)').all().some(column => column.name === 'is_visible')) {
    database.transaction(() => {
      database.exec('ALTER TABLE alerts ADD COLUMN is_visible INTEGER NOT NULL DEFAULT 1');
      database.exec("UPDATE alerts SET is_visible = 0 WHERE json_extract(payload_json, '$.items[0].evidenceSource') = 'snapshot'");
    })();
  }
  database.exec('CREATE INDEX IF NOT EXISTS idx_alerts_visible_time ON alerts(is_visible, time DESC)');
  // Transactional counter: inserts, corrections, deletes and rollbacks stay exact.
  database.exec(`
    CREATE TABLE IF NOT EXISTS alert_totals (id INTEGER PRIMARY KEY CHECK(id=1), visible INTEGER NOT NULL);
    INSERT INTO alert_totals SELECT 1, (SELECT COUNT(*) FROM alerts WHERE is_visible=1)
      WHERE NOT EXISTS (SELECT 1 FROM alert_totals WHERE id=1);
    CREATE TRIGGER IF NOT EXISTS alert_total_insert AFTER INSERT ON alerts BEGIN
      UPDATE alert_totals SET visible=visible+(NEW.is_visible=1) WHERE id=1;
    END;
    CREATE TRIGGER IF NOT EXISTS alert_total_delete AFTER DELETE ON alerts BEGIN
      UPDATE alert_totals SET visible=visible-(OLD.is_visible=1) WHERE id=1;
    END;
    CREATE TRIGGER IF NOT EXISTS alert_total_update AFTER UPDATE OF is_visible ON alerts BEGIN
      UPDATE alert_totals SET visible=visible+(NEW.is_visible=1)-(OLD.is_visible=1) WHERE id=1;
    END;
  `);
  // Upgrade the brief development schema that stored only source_id.
  let alertSourcesUpgraded = false;
  try {
    database.exec("ALTER TABLE alert_sources ADD COLUMN alert_id TEXT NOT NULL DEFAULT ''");
    alertSourcesUpgraded = true;
  } catch {
    // Column already exists.
  }
  if (alertSourcesUpgraded) {
    database.exec("UPDATE alert_sources SET alert_id = source_id WHERE alert_id = ''");
  }
  database.exec('CREATE INDEX IF NOT EXISTS idx_alert_sources_alert_id ON alert_sources(alert_id)');
  // Backfill legacy alert items only once. Re-scanning the full alert history
  // on every restart would negate the query optimization on a small server.
  const marker = database.prepare('SELECT 1 FROM sync_meta WHERE key = ?').get('alert_items_backfill_v2');
  if (!marker) {
    const backfill = database.transaction(() => {
      database.exec(`
        INSERT OR IGNORE INTO alert_items (alert_id, item_index, kind, coin, side, usd, time)
        SELECT a.id,
               CAST(item.key AS INTEGER),
               COALESCE(json_extract(item.value, '$.kind'), ''),
               UPPER(TRIM(COALESCE(json_extract(item.value, '$.coin'), ''))),
               LOWER(TRIM(COALESCE(json_extract(item.value, '$.side'), ''))),
               COALESCE(json_extract(item.value, '$.usd'), 0),
               COALESCE(json_extract(item.value, '$.time'), 0)
        FROM (SELECT id, payload_json FROM alerts WHERE json_valid(payload_json)) AS a,
             json_each(a.payload_json, '$.items') AS item
        WHERE json_type(a.payload_json, '$.items') = 'array';
        INSERT OR IGNORE INTO alert_sources(source_id, alert_id)
        SELECT id, id FROM alerts;
      `);
      database.prepare('INSERT INTO sync_meta(key, value, updated_at) VALUES (?, ?, ?)')
        .run('alert_items_backfill_v2', 'done', Date.now());
    });
    backfill();
  }
  // 旧策略表（v41_* / whale_ai_runtime_logs）不再创建；user_ai_keys / user_exchange_keys 继续使用。

  // soft migrations
  try {
    database.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`);
  } catch {
    // column exists
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
 * - fills：超过 FILL_RETENTION 的删掉；不受前端展示条数限制
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

  // Raw executions underpin rolling statistics: retain by time, never by display cap.
  const fillCapDeleted = 0;

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
  database.prepare(`DELETE FROM alert_items WHERE NOT EXISTS
    (SELECT 1 FROM alerts WHERE alerts.id = alert_items.alert_id)`).run();
  database.prepare(`DELETE FROM alert_sources WHERE NOT EXISTS
    (SELECT 1 FROM alerts WHERE alerts.id = alert_sources.alert_id)`).run();

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
