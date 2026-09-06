/**
 * 整站数据重置：清空成交/异动/仓位/缓存，保留用户与手动巨鲸名单，
 * 其余监控地址仍保留以便重新拉取与历史补齐。
 */
const { getDb, setMeta } = require('./db');
const { clearWhaleModeCache } = require('./cache');
const { readConfig, getActiveWhales } = require('./config');

function clearMarketTables() {
  const database = getDb();
  const tx = database.transaction(() => {
    database.prepare('DELETE FROM fills').run();
    database.prepare('DELETE FROM events').run();
    database.prepare('DELETE FROM alerts').run();
    database.prepare('DELETE FROM positions').run();
    database.prepare('DELETE FROM whales').run();
    // 不删 users / sessions / user_settings
  });
  tx();
}

/**
 * @returns {Promise<object>}
 */
async function resetSiteData(options = {}) {
  const rounds = Math.max(1, Math.min(8, Number(options.rounds) || 3));

  const config = readConfig();
  const manuals = (config.whales || []).filter((w) => w && w.manual);
  const rosterBefore = getActiveWhales();

  clearMarketTables();
  clearWhaleModeCache();

  setMeta(
    'fills_backfill_cursor',
    JSON.stringify({ dayOffset: 0, whaleIndex: 0, done: false }),
  );
  try {
    const { resetFillBackfill } = require('./fillBackfill');
    resetFillBackfill();
  } catch (err) {
    console.warn('[reset] fillBackfill restart:', err.message);
  }

  let refresh = null;
  try {
    const { refreshWhalesShard, invalidateWhaleCache } = require('./whales');
    invalidateWhaleCache();
    for (let i = 0; i < rounds; i += 1) {
      refresh = await refreshWhalesShard({ force: true });
    }
  } catch (err) {
    console.warn('[reset] refresh after wipe:', err.message);
    refresh = { error: err.message };
  }

  try {
    require('./realtimeBridge').syncFromCache();
  } catch {
    // ignore
  }

  let backfill = null;
  try {
    backfill = require('./fillBackfill').getBackfillStatus();
  } catch {
    backfill = null;
  }

  return {
    keptManuals: manuals.length,
    rosterSize: rosterBefore.length,
    manuals: manuals.map((w) => ({ id: w.id, name: w.name, address: w.address })),
    backfill,
    refresh: refresh
      ? {
          pending: refresh.pending ?? null,
          incomplete: Boolean(refresh.incomplete),
          whaleCount: Array.isArray(refresh.whales) ? refresh.whales.length : null,
          error: refresh.error || null,
        }
      : null,
  };
}

module.exports = {
  resetSiteData,
};
