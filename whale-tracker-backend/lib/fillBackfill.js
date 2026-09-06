/**
 * 重启后补近 N 天成交（官方 REST），完成后日常靠 WS。
 *
 * 默认关闭（FILL_BACKFILL=1 才启用）。进度在 sync_meta.fills_backfill_cursor。
 *
 * 环境变量：
 * - FILL_BACKFILL=1 开启
 * - FILL_BACKFILL_INTERVAL_MS 默认 5000
 * - FILL_BACKFILL_DAYS 默认 3
 * - FILL_BACKFILL_RATE_LIMIT_MS 默认 1800000（429 冷却）
 */
const { fetchUserFillsByTime, mapFillToTrade, FILL_LOOKBACK_MS } = require('./hyperliquid');
const { readWhaleModeCache, writeCache, whaleCacheName } = require('./cache');
const { persistTradesIncremental } = require('./sqliteStore');
const { getMeta, setMeta } = require('./db');
const { normalizeAddress } = require('./config');

const MODE = 'hf';
const DAY_MS = 24 * 60 * 60 * 1000;
const META_KEY = 'fills_backfill_cursor';
const ENABLED = process.env.FILL_BACKFILL === '1';
/** ~5s/轮：等价吞吐冲约 2 小时（200×7）；默认关闭，稳态靠 WS */
const INTERVAL_MS = Math.max(
  3_000,
  Number(process.env.FILL_BACKFILL_INTERVAL_MS) || 5_000,
);
const DAYS = Math.max(1, Math.min(7, Number(process.env.FILL_BACKFILL_DAYS) || 3));
const RATE_LIMIT_PAUSE_MS = Math.max(
  60_000,
  Number(process.env.FILL_BACKFILL_RATE_LIMIT_MS) || 30 * 60 * 1000,
);

let timer = null;
let running = false;
/** @type {number} 429 冷却截止时间戳；0 表示未限流 */
let rateLimitedUntil = 0;

function loadCursor() {
  try {
    const raw = getMeta(META_KEY)?.value;
    if (!raw) return { dayOffset: 0, whaleIndex: 0, done: false };
    const parsed = JSON.parse(raw);
    return {
      dayOffset: Math.max(0, Number(parsed.dayOffset) || 0),
      whaleIndex: Math.max(0, Number(parsed.whaleIndex) || 0),
      done: Boolean(parsed.done),
    };
  } catch {
    return { dayOffset: 0, whaleIndex: 0, done: false };
  }
}

function saveCursor(cursor) {
  setMeta(META_KEY, JSON.stringify(cursor));
}

function listWhales() {
  const cached = readWhaleModeCache(MODE);
  const whales = Array.isArray(cached?.data?.whales) ? cached.data.whales : [];
  return whales.filter((w) => normalizeAddress(w.address));
}

function dayWindow(dayOffset, now = Date.now()) {
  // dayOffset=0 → [now-1d, now]；dayOffset=1 → [now-2d, now-1d] …
  const end = now - dayOffset * DAY_MS;
  const start = end - DAY_MS;
  return { start, end };
}

function mergeTradesIntoCache(trades) {
  if (!trades?.length) return;
  const cached = readWhaleModeCache(MODE);
  if (!cached?.data) {
    persistTradesIncremental(trades);
    return;
  }
  persistTradesIncremental(trades);
  const prev = Array.isArray(cached.data.trades) ? cached.data.trades : [];
  const seen = new Set(prev.map((t) => String(t?.id || '')));
  const merged = [...trades.filter((t) => t?.id && !seen.has(String(t.id))), ...prev]
    .sort((a, b) => Number(b.time || 0) - Number(a.time || 0))
    .slice(0, 8000);
  writeCache(whaleCacheName(MODE), { ...cached.data, trades: merged });
}

function isRateLimited() {
  return rateLimitedUntil > Date.now();
}

function enterRateLimitPause(err) {
  rateLimitedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
  console.warn(
    `[fill-backfill] 官方 429，暂停 ${Math.round(RATE_LIMIT_PAUSE_MS / 60000)} 分钟后重试：`,
    err?.message || err,
  );
}

async function runOneTick() {
  if (running || !ENABLED) return;
  if (isRateLimited()) return;

  const cursor = loadCursor();
  if (cursor.done) return;

  const whales = listWhales();
  if (!whales.length) {
    console.log('[fill-backfill] 尚无巨鲸名单，等待缓存…');
    return;
  }

  if (cursor.dayOffset >= DAYS) {
    saveCursor({ ...cursor, done: true });
    console.log('[fill-backfill] 近 7 天补齐完成，后续仅依赖 WS');
    return;
  }

  if (cursor.whaleIndex >= whales.length) {
    const next = { dayOffset: cursor.dayOffset + 1, whaleIndex: 0, done: false };
    if (next.dayOffset >= DAYS) {
      saveCursor({ ...next, done: true });
      console.log('[fill-backfill] 近 7 天补齐完成，后续仅依赖 WS');
      return;
    }
    saveCursor(next);
    console.log(`[fill-backfill] 进入第 ${next.dayOffset + 1}/${DAYS} 天批次`);
    return;
  }

  running = true;
  const whale = whales[cursor.whaleIndex];
  const address = normalizeAddress(whale.address);
  const { start, end } = dayWindow(cursor.dayOffset);

  try {
    const fills = await fetchUserFillsByTime(address, start, end);
    const trades = (fills || [])
      .map((fill) => mapFillToTrade(fill, { ...whale, address }, {}))
      .filter((t) => t?.id);
    if (trades.length) mergeTradesIntoCache(trades);
    console.log(
      `[fill-backfill] day=${cursor.dayOffset + 1}/${DAYS} ` +
        `${cursor.whaleIndex + 1}/${whales.length} ${whale.name || address.slice(0, 10)} ` +
        `fills=${trades.length}`,
    );
  } catch (err) {
    console.warn(
      `[fill-backfill] 失败 day=${cursor.dayOffset} idx=${cursor.whaleIndex}:`,
      err.message || err,
    );
    // 限流：不推进游标，冷却半小时
    if (err.status === 429 || /过于频繁|429/.test(String(err.message || ''))) {
      enterRateLimitPause(err);
      running = false;
      return;
    }
  }

  saveCursor({
    dayOffset: cursor.dayOffset,
    whaleIndex: cursor.whaleIndex + 1,
    done: false,
  });
  running = false;
}

function getBackfillStatus() {
  const cursor = loadCursor();
  const whales = listWhales();
  const limited = isRateLimited();
  return {
    enabled: ENABLED,
    intervalMs: INTERVAL_MS,
    days: DAYS,
    lookbackMs: FILL_LOOKBACK_MS,
    rateLimitPauseMs: RATE_LIMIT_PAUSE_MS,
    rateLimited: limited,
    rateLimitedUntil: limited ? rateLimitedUntil : 0,
    ...cursor,
    whaleTotal: whales.length,
    running,
  };
}

/** 重置补齐进度并确保定时器在跑 */
function resetFillBackfill() {
  saveCursor({ dayOffset: 0, whaleIndex: 0, done: false });
  running = false;
  rateLimitedUntil = 0;
  if (!ENABLED) return getBackfillStatus();
  if (!timer) {
    startFillBackfill();
  } else {
    console.log('[fill-backfill] 已重置游标，继续慢补');
    setTimeout(() => {
      void runOneTick();
    }, 3_000);
  }
  return getBackfillStatus();
}

function startFillBackfill() {
  if (!ENABLED) {
    console.log('[fill-backfill] 已关闭（FILL_BACKFILL=0）');
    return;
  }
  if (timer) return;
  const cursor = loadCursor();
  if (cursor.done) {
    console.log('[fill-backfill] 已完成，跳过（清空 meta fills_backfill_cursor 可重跑）');
    return;
  }
  console.log(
    `[fill-backfill] 启动：每 ${INTERVAL_MS}ms 拉 1 地址×1 天，共 ${DAYS} 天（目标约 2h；429 停 ${Math.round(RATE_LIMIT_PAUSE_MS / 60000)} 分钟）`,
  );
  // 启动稍后一点，先让分片/WS 起来
  setTimeout(() => {
    void runOneTick();
  }, 15_000);
  timer = setInterval(() => {
    void runOneTick();
  }, INTERVAL_MS);
}

function stopFillBackfill() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  startFillBackfill,
  stopFillBackfill,
  resetFillBackfill,
  getBackfillStatus,
  runOneTick,
};
