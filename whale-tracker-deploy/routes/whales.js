const express = require('express');
const {
  getWhales,
  getWhalesBatch,
  getWhaleCacheBatch,
  queryWhaleCache,
  getWhaleSummary,
  getWhaleResonance,
  refreshSingleWhale,
  refreshAlertHistory,
  listTrades,
  getWhaleTrades,
  getWhaleTransfers,
  getWhalePosition,
  getWhalePerpMarkPrices,
  getWhaleEquityHistory,
  getWhaleOpenOrders,
  invalidateWhaleCache,
  buildActivityFeed,
  getActivitySince,
} = require('../lib/whales');
const { readConfig, writeConfig, setWhaleMode, normalizeAddress, normalizeMode, addManualWhale, renameWhale } = require('../lib/config');
const { loadRecentEvents, loadRecentAlerts, loadPagedAlerts, loadAlertFlowSummary, countStoredAlerts, persistAlerts } = require('../lib/sqliteStore');

const router = express.Router();
const whaleSync = require('../lib/whaleSync');
const { requireAuthenticated, requireAdmin } = require('../lib/maintenanceAuth');

router.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/alert-history') return next(); // retired below
  if (['/config', '/mode'].includes(req.path) && req.method !== 'GET') return requireAdmin(req, res, next);
  if (req.method !== 'GET' || /\/(?:alert-history|history)\/refresh$/.test(req.path)) return requireAuthenticated(req, res, next);
  next();
});

router.get('/observations', (_req, res) => {
  res.set('Cache-Control', 'no-store').json(require('../lib/whaleObservationWorker').snapshot());
});
router.get('/observations/:id/evidence', (req, res) => {
  const offset = Number(req.query.offset || 0);
  if (!/^[a-f0-9]{32}$/.test(req.params.id) || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000) return res.status(400).json({error:'无效查询'});
  try {
    const result = require('../lib/whaleObservationStore').evidence(require('../lib/db').getDb(), req.params.id, offset);
    if (!result) return res.status(404).json({error:'记录已合并、撤回或过期，请刷新列表'});
    res.set('Cache-Control','no-store').json(result);
  } catch { res.status(503).json({error:'成交依据暂不可用'}); }
});

router.get('/bootstrap', (_req, res) => {
  try { res.set('Cache-Control', 'no-store').json(whaleSync.bootstrap()); }
  catch (err) { console.error('[whales/bootstrap]', err); res.status(503).json({ error: '巨鲸快照暂不可用，请稍后重试' }); }
});

/** 总览读取服务端快照，不触发上游采集，也不要求前端遍历分页。 */
router.get('/summary', (req, res) => {
  try {
    res.json({ ...getWhaleSummary({ coin: req.query.coin }), alertTotal: countStoredAlerts() });
  } catch (err) {
    console.error('[GET /api/whales/summary]', err);
    res.status(500).json({ error: err.message || '读取巨鲸汇总失败' });
  }
});

const sharedStats = require('../lib/sharedQuery').createSharedQuery();
router.get('/resonance', async (req, res) => {
  const windowHours = Number(req.query.windowHours || 6);
  if (![2, 4, 6, 12, 24].includes(windowHours)) return res.status(400).json({ error: '不支持的共振时间范围' });
  const watchedCoins = String(req.query.coins || 'BTC,ETH').split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 12);
  try { res.json(await sharedStats(JSON.stringify(['resonance', windowHours, [...watchedCoins].sort()]), async () => {
    await require('../lib/sqliteStore').prepareFillProjection();
    return getWhaleResonance({ windowHours, watchedCoins });
  })); }
  catch (err) { console.error('[GET /api/whales/resonance]', err); res.status(500).json({ error: '读取共振信号失败' }); }
});

router.get('/direction-summary', async (req, res) => {
  const durations = { '15m': 900000, '1h': 3600000, '4h': 14400000, '24h': 86400000 };
  const windowKey = String(req.query.window || '1h');
  if (!durations[windowKey]) return res.status(400).json({ error: '不支持的时间范围' });
  try {
    const result = await sharedStats('direction:' + windowKey, async () => {
      await require('../lib/sqliteStore').prepareFillProjection();
      const now = Date.now(), sinceMs = now - durations[windowKey];
      return { ...require('../lib/sqliteStore').loadDirectionSummary(sinceMs, now), sinceMs, untilMs: now, asOf: now,
        basis: 'stored-executions', coverage: 'locally-observed', executionCoverage: require('../lib/fillBackfill').getCoverageStatus() };
    });
    res.json(result);
  } catch (err) { console.error('[direction-summary]', err); res.status(500).json({ error: '方向统计暂不可用' }); }
});

/** 净流入资金只查服务器异动库，时间窗口和币种由参数明确限定。 */
router.get('/alert-history/summary', async (req, res) => {
  try {
    const windows = { '15m': 15 * 60_000, '1h': 60 * 60_000, '4h': 4 * 60 * 60_000, '24h': 24 * 60 * 60_000 };
    const windowKey = String(req.query.window || '1h');
    const duration = windows[windowKey];
    if (!duration) return res.status(400).json({ error: '不支持的异动统计时间范围' });
    await require('../lib/sqliteStore').prepareFillProjection();
    res.json({ ...loadAlertFlowSummary({ sinceMs: Date.now() - duration, coin: req.query.coin }), executionCoverage: require("../lib/fillBackfill").getCoverageStatus() });
  } catch (err) {
    console.error('[GET /api/whales/alert-history/summary]', err);
    res.status(500).json({ error: err.message || '读取异动汇总失败' });
  }
});

/** GET /api/whales/cache-page — 前端只读缓存页，不触发上游采集。 */
router.get('/cache-page', (req, res) => {
  try {
    const data = getWhaleCacheBatch(req.query);
    const { trades, ...rest } = data;
    res.json({ ...rest, whales: compactWhaleList(rest.whales), activity: rest.activity || buildActivityFeed(trades) });
  } catch (err) {
    console.error('[GET /api/whales/cache-page]', err);
    res.status(500).json({ error: err.message || '读取巨鲸缓存失败' });
  }
});

/** 列表条件在服务端执行，只返回当前页和筛选计数。 */
router.get('/cache-query', (req, res) => {
  try {
    const data = queryWhaleCache(req.query);
    res.json({ ...data, whales: compactWhaleList(data.whales) });
  } catch (err) {
    console.error('[GET /api/whales/cache-query]', err);
    res.status(500).json({ error: err.message || '查询巨鲸列表失败' });
  }
});

/** 列表只传持仓摘要；成交明细由已有的单仓位详情接口按需加载。 */
function compactWhaleList(whales = []) {
  return (whales || []).map((whale) => ({
    ...whale,
    positions: (whale.positions || []).map((position) => {
      const { entryFills, ...summary } = position;
      return {
        ...summary,
        // 保留笔数提示，展开明细时前端再从 /positions/:coin 获取完整数据。
        entryFillsOmitted: Math.max(0, Number(position.entryFillsOmitted) || 0) + (entryFills || []).length,
      };
    }),
  }));
}

function compactAlertList(alerts = []) {
  return (alerts || []).map((alert) => {
    const items = Array.isArray(alert.items) ? alert.items : [];
    return {
      ...alert,
      // 第一项用于卡片和详情展示；其余只用于服务端筛选结果的前端过滤/计数。
      items: items.map((item, index) => index === 0 ? item : ({
        kind: item.kind,
        coin: item.coin,
        side: item.side,
        usd: item.usd,
        time: item.time,
        evidenceSource: item.evidenceSource,
        timeSource: item.timeSource,
        sourceId: item.sourceId,
      })),
    };
  });
}

/** GET /api/whales/events — 近 7 天开/补/减仓事件（SQLite） */
router.get('/events', (req, res) => {
  try {
    const limit = Number(req.query.limit) || 200;
    const events = loadRecentEvents(limit);
    res.json({ events, total: events.length, retentionDays: 7 });
  } catch (err) {
    console.error('[GET /api/whales/events]', err);
    res.status(500).json({ error: err.message || '读取异动事件失败' });
  }
});

/** GET /api/whales/alert-history — 异动分页（SQLite） */
router.get('/alert-history', (req, res) => {
  try {
    whaleSync.initialize();
    const cursor = whaleSync.stream.cursor();
    // 兼容旧调用：无 page 时按 limit 拉最近 N 条
    if (req.query.page == null && req.query.paged == null) {
      const limit = Number(req.query.limit) || 500;
      const alerts = compactAlertList(loadRecentAlerts(limit));
      return res.json({ ...cursor, alerts, total: alerts.length, retentionDays: 7 });
    }
    const data = loadPagedAlerts(req.query);
    res.json({ ...data, ...cursor, alerts: compactAlertList(data.alerts) });
  } catch (err) {
    console.error('[GET /api/whales/alert-history]', err);
    res.status(500).json({ error: err.message || '读取异动历史失败', alerts: [] });
  }
});

/** POST /api/whales/alert-history — 前端同步异动到 SQLite */
router.post('/alert-history', (req, res) => {
  res.status(410).json({ error: '异动由服务器采集，浏览器上传入口已停用' });
});

/** GET /api/whales — 默认分页返回；兼容全量读取需显式传 full=1 */
router.get('/', async (req, res) => {
  try {
    const force = req.query.refresh === '1';
    const useBatch = req.query.full !== '1';
    if (useBatch) {
      const data = await getWhalesBatch(req.query);
      const { trades, ...rest } = data;
      const config = readConfig();
      return res.json({
        ...rest,
        whales: compactWhaleList(rest.whales),
        mode: rest.mode || config.mode || 'hf',
        activity: rest.activity || buildActivityFeed(trades),
      });
    }
    const data = await getWhales(force);
    const { trades, ...rest } = data;
    const activity = buildActivityFeed(trades);
    const config = readConfig();
    res.json({ ...rest, whales: compactWhaleList(rest.whales), mode: rest.mode || config.mode || 'hf', activity });
  } catch (err) {
    console.error('[GET /api/whales]', err);
    const status = err.status || 502;
    res.status(status).json({ error: err.message || '巨鲸数据获取失败' });
  }
});

/** GET /api/whales/activity?since= — 增量成交（须在 /:id 之前） */
router.get('/activity', async (req, res) => {
  try {
    const since = Number(req.query.since) || 0;
    const data = await getActivitySince(since);
    res.json(data);
  } catch (err) {
    console.error('[GET /api/whales/activity]', err);
    res.status(502).json({ error: err.message || '活动流获取失败' });
  }
});

/** GET /api/whales/config — 当前监控地址列表 */
router.get('/config', (_req, res) => {
  res.json(readConfig());
});

/**
 * POST /api/whales/mode
 * body: { mode: 'stable' | 'hf' }
 * 只切换名单；各模式独立缓存，有缓存时切换可秒开
 */
router.post('/mode', (req, res) => {
  try {
    const mode = normalizeMode(req.body?.mode);
    const saved = setWhaleMode(mode);
    res.json({
      ok: true,
      mode: saved.mode,
      total: saved.whales.length,
    });
  } catch (err) {
    console.error('[POST /api/whales/mode]', err);
    res.status(500).json({ error: err.message || '切换巨鲸类型失败' });
  }
});

/** GET /api/whales/trades — 全部巨鲸成交分页（须在 /:id 之前） */
router.get('/trades', async (req, res) => {
  try {
    const data = await listTrades(req.query);
    res.json(data);
  } catch (err) {
    console.error('[GET /api/whales/trades]', err);
    res.status(502).json({ error: err.message || '交易记录获取失败' });
  }
});

/** POST/GET /api/whales/alert-history/refresh — 手动补齐异动历史（成交/开仓时间） */
async function handleAlertHistoryRefresh(req, res) {
  try {
    const data = await refreshAlertHistory(req.query || {});
    res.json(data);
  } catch (err) {
    console.error('[alert-history/refresh]', err);
    res.status(err.status || 502).json({ error: err.message || '异动历史拉取失败' });
  }
}
router.post('/alert-history/refresh', handleAlertHistoryRefresh);
router.get('/alert-history/refresh', handleAlertHistoryRefresh);
router.post('/history/refresh', handleAlertHistoryRefresh);
router.get('/history/refresh', handleAlertHistoryRefresh);

router.get('/:id/positions/:coin', async (req, res) => {
  try {
    const data = await getWhalePosition(req.params.id, req.params.coin, {
      side: req.query.side,
      cacheOnly: req.query.view === 'cached',
    });
    res.json(data);
  } catch (err) {
    const status = err.status || 502;
    console.error('[GET /api/whales/:id/positions/:coin]', err);
    res.status(status).json({ error: err.message || '持仓详情获取失败' });
  }
});

/** GET /api/whales/:id/market-prices — 当前合约仓位标记价，不读取现货账户 */
router.get('/:id/market-prices', async (req, res) => {
  try {
    res.json(await getWhalePerpMarkPrices(req.params.id));
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message || '合约行情获取失败' });
  }
});

/** GET /api/whales/:id/equity-history — Hyperliquid 官方合约账户权益历史 */
router.get('/:id/equity-history', async (req, res) => {
  try {
    const allowed = new Set(['24h', '7d', '30d', 'all']);
    const range = allowed.has(String(req.query.range || 'all')) ? String(req.query.range || 'all') : 'all';
    res.json(await getWhaleEquityHistory(req.params.id, range));
  } catch (err) {
    console.error('[GET /api/whales/:id/equity-history]', err);
    res.status(err.status || 502).json({ error: err.message || '读取合约权益历史失败' });
  }
});

/** GET /api/whales/:id/orders — 单个巨鲸未完成订单（含条件单） */
router.get('/:id/orders', async (req, res) => {
  try {
    res.json(await getWhaleOpenOrders(req.params.id));
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message || '未完成订单获取失败' });
  }
});

/** GET /api/whales/:id/trades — 单个巨鲸成交分页 */
router.get('/:id/trades', async (req, res) => {
  try {
    const data = await getWhaleTrades(req.params.id, req.query);
    res.json(data);
  } catch (err) {
    const status = err.status || 502;
    console.error('[GET /api/whales/:id/trades]', err);
    res.status(status).json({ error: err.message || '该巨鲸成交记录获取失败' });
  }
});

/** GET /api/whales/:id/transfers — 单个巨鲸转账（充提/划转） */
router.get('/:id/transfers', async (req, res) => {
  try {
    const data = await getWhaleTransfers(req.params.id, req.query);
    res.json(data);
  } catch (err) {
    const status = err.status || 502;
    console.error('[GET /api/whales/:id/transfers]', err);
    res.status(status).json({ error: err.message || '该巨鲸转账记录获取失败' });
  }
});

/** POST /api/whales/:id/refresh — 强制重拉单个巨鲸 */
router.post('/:id/refresh', async (req, res) => {
  try {
    const data = await refreshSingleWhale(req.params.id);
    res.json(data);
  } catch (err) {
    const status = err.status || 502;
    console.error('[POST /api/whales/:id/refresh]', err);
    res.status(status).json({ error: err.message || '该巨鲸刷新失败' });
  }
});

/** POST /api/whales/manual — 手动添加巨鲸地址（可选名称） */
router.post('/manual', async (req, res) => {
  try {
    const { whale } = addManualWhale({
      address: req.body?.address,
      name: req.body?.name,
    });
    invalidateWhaleCache();
    let refreshed = null;
    try {
      refreshed = await refreshSingleWhale(whale.id);
    } catch (err) {
      console.warn('[POST /api/whales/manual] 首拉失败:', err.message);
    }
    try {
      require('../lib/realtimeBridge').syncFromCache();
    } catch {
      // ignore
    }
    res.json({
      ok: true,
      whale: refreshed?.whale || whale,
      message: '已添加；成交将随补齐与 WS 逐步写入',
    });
  } catch (err) {
    const status = err.status || 502;
    console.error('[POST /api/whales/manual]', err);
    res.status(status).json({ error: err.message || '添加失败' });
  }
});

/** PATCH /api/whales/:id/name — 修改巨鲸展示名称 */
router.patch('/:id/name', (req, res) => {
  try {
    const { whale } = renameWhale(req.params.id, req.body?.name);
    invalidateWhaleCache();
    const { readWhaleModeCache, commitWhaleState } = require('../lib/cache');
    const current = readWhaleModeCache('hf')?.data?.whales?.find(row => row.id === whale.id);
    commitWhaleState('hf', { whales: [{ ...(current || { positions: [] }), ...whale, customName: true }] });
    try {
      require('../lib/realtimeBridge').syncFromCache();
    } catch {
      // ignore
    }
    res.json({ ok: true, whale });
  } catch (err) {
    const status = err.status || 502;
    console.error('[PATCH /api/whales/:id/name]', err);
    res.status(status).json({ error: err.message || '改名失败' });
  }
});

/**
 * POST /api/whales/config
 * body: { whales: Whale[], keywords?: string[], mode?: string }
 */
router.post('/config', (req, res) => {
  try {
    const body = req.body || {};
    if (!Array.isArray(body.whales)) {
      return res.status(400).json({ error: 'whales 必须是数组' });
    }

    const whales = body.whales.map((item, index) => {
      const name = String(item.name || '').trim();
      const address = String(item.address || '').trim();
      if (!name) {
        throw new Error(`第 ${index + 1} 条缺少名称`);
      }
      if (address && !normalizeAddress(address) && !address.endsWith('.eth')) {
        if (!/^0x/i.test(address) && !address.includes('.')) {
          throw new Error(`${name} 的地址格式无效`);
        }
      }
      return {
        id: String(item.id || name).trim(),
        name,
        address,
        description: String(item.description || ''),
        winRate: Number(item.winRate) || 0,
        maxDrawdown: Number(item.maxDrawdown) || 0,
        closedTrades: Number(item.closedTrades) || 0,
        weekVlm: Number(item.weekVlm) || 0,
        priority: Number(item.priority) || 0,
        style: item.style,
        enabled: item.enabled !== false,
      };
    });

    const current = readConfig();
    const saved = writeConfig({
      mode: body.mode != null ? normalizeMode(body.mode) : current.mode,
      whales,
      keywordGroups: current.keywordGroups,
      keywords: Array.isArray(body.keywords) ? body.keywords : current.keywords,
    });
    invalidateWhaleCache(saved.mode);
    const { getActiveWhales } = require('../lib/config');
    const { commitWhaleState } = require('../lib/cache');
    const active = getActiveWhales();
    commitWhaleState('hf', { whales: active, rosterIds: active.map(row => row.id) });
    res.json(saved);
  } catch (err) {
    res.status(400).json({ error: err.message || '配置保存失败' });
  }
});

module.exports = router;
