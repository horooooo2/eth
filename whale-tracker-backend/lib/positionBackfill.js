/**
 * 对「当前仍持仓」的币种慢速回补更久成交 → 写入仓位事件（开/加/减/平）
 * POSITION_BACKFILL=1 时启用（默认开）
 */
const { getDb } = require('./db');
const { persistTradesIncremental } = require('./sqliteStore');
const {
  fetchUserFillsByCoin,
  mapFillToTrade,
  fetchCoinNameMap,
} = require('./hyperliquid');
const { readConfig } = require('./config');

const ENABLED = process.env.POSITION_BACKFILL !== '0';
const INTERVAL_MS = Math.max(
  3000,
  Number(process.env.POSITION_BACKFILL_INTERVAL_MS) || 8000,
);
const LOOKBACK_MS = Math.max(
  30 * 24 * 60 * 60 * 1000,
  (Number(process.env.POSITION_BACKFILL_DAYS) || 180) * 24 * 60 * 60 * 1000,
);

let timer = null;
let cursor = 0;
let running = false;
let lastError = '';
let doneRounds = 0;

function listOpenPositions() {
  const database = getDb();
  return database
    .prepare(
      `SELECT whale_id, coin, side, size, open_time FROM positions
       WHERE ABS(COALESCE(size, 0)) > 1e-12 OR ABS(COALESCE(position_value, 0)) > 1
       ORDER BY whale_id, coin`,
    )
    .all();
}

function whaleById(id) {
  const cfg = readConfig();
  return (cfg.whales || []).find((w) => w.id === id) || null;
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const rows = listOpenPositions();
    if (!rows.length) {
      running = false;
      return;
    }
    if (cursor >= rows.length) {
      cursor = 0;
      doneRounds += 1;
    }
    const row = rows[cursor];
    cursor += 1;
    const whale = whaleById(row.whale_id);
    if (!whale?.address) {
      running = false;
      return;
    }
    let names = {};
    try {
      names = await fetchCoinNameMap();
    } catch {
      names = {};
    }
    const fills = await fetchUserFillsByCoin(whale.address, row.coin, {
      lookbackMs: LOOKBACK_MS,
      maxPages: 8,
      currentSize: row.size,
      side: row.side,
    });
    if (fills.length) {
      const trades = fills.map((fill) =>
        mapFillToTrade(fill, { ...whale, address: whale.address }, names),
      );
      persistTradesIncremental(trades);
    }
    lastError = '';
  } catch (err) {
    lastError = err.message || String(err);
    console.warn('[position-backfill]', lastError);
  } finally {
    running = false;
  }
}

function getPositionBackfillStatus() {
  return {
    enabled: ENABLED,
    intervalMs: INTERVAL_MS,
    lookbackMs: LOOKBACK_MS,
    cursor,
    doneRounds,
    running,
    lastError,
    openPositions: (() => {
      try {
        return listOpenPositions().length;
      } catch {
        return 0;
      }
    })(),
  };
}

function startPositionBackfill() {
  if (!ENABLED) {
    console.log('[position-backfill] 已关闭（POSITION_BACKFILL=0）');
    return;
  }
  if (timer) return;
  console.log(
    `[position-backfill] 启动 interval=${INTERVAL_MS}ms lookbackDays=${Math.round(LOOKBACK_MS / 864e5)}`,
  );
  timer = setInterval(() => {
    tick().catch(() => {});
  }, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  setTimeout(() => {
    tick().catch(() => {});
  }, 5000);
}

module.exports = {
  startPositionBackfill,
  getPositionBackfillStatus,
};
