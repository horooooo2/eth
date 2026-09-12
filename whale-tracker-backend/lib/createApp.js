const express = require('express');
const cors = require('cors');
const whalesRouter = require('../routes/whales');
const newsRouter = require('../routes/news');
const marketsRouter = require('../routes/markets');
const authRouter = require('../routes/auth');
const xRouter = require('../routes/x');
const { fetchFedOdds } = require('./markets');
const { getHlInfoConfig } = require('./hlInfoClient');
const { getStartedAt, getUptimeMs } = require('./runtime');
const { pushRequest, pushError, getMonitorSnapshot } = require('./opsMonitor');

/** 仅 POST /api/whales/alert-history 使用的 body 上限（有界，不是无限放大） */
const ALERT_HISTORY_BODY_LIMIT = process.env.ALERT_HISTORY_BODY_LIMIT || '4mb';

function normalizePrefix(prefix) {
  if (!prefix) return '';
  return `/${String(prefix).replace(/^\/+|\/+$/g, '')}`;
}

let whaleRefreshBusy = false;
let whaleRefreshLast = null;

function mountRoutes(app, prefix) {
  const base = normalizePrefix(prefix);
  app.get(`${base}/health`, (_req, res) => {
    let sqlite = null;
    try {
      sqlite = require('./db').dbStatus();
    } catch (err) {
      sqlite = { ok: false, error: err.message };
    }
    res.json({
      ok: true,
      service: 'whale-tracker',
      time: new Date().toISOString(),
      startedAt: getStartedAt(),
      uptimeMs: getUptimeMs(),
      hlInfo: getHlInfoConfig(),
      sqlite,
      realtime: (() => {
        try {
          return require('./realtimeBridge').getRealtimeStatus();
        } catch {
          return { connected: false };
        }
      })(),
      fillBackfill: (() => {
        try {
          return require('./fillBackfill').getBackfillStatus();
        } catch {
          return { enabled: false };
        }
      })(),
      whaleRefresh: whaleRefreshLast,
    });
  });
  app.get(`${base}/poly-fed`, async (_req, res) => {
    try {
      res.json(await fetchFedOdds());
    } catch (err) {
      res.status(502).json({ title: '9 月 FOMC', items: [], hikePct: 0, cutPct: 0, holdPct: 0, source: 'Polymarket', error: err.message });
    }
  });
  app.use(`${base}/auth`, authRouter);
  app.use(`${base}/whales`, whalesRouter);
  app.use(`${base}/news`, newsRouter);
  app.use(`${base}/markets`, marketsRouter);
  app.use(`${base}/x`, xRouter);
  // 通用 AI 数据分析（DeepSeek key + analyze），非策略
  app.use(`${base}/whale-ai`, require('../routes/whaleAi'));
  app.get(`${base}/data/browse`, (req, res) => {
    try {
      const { loadDbBrowse } = require('./sqliteStore');
      const limit = Number(req.query.limit) || 50;
      const data = loadDbBrowse({ limit });
      res.json({
        ...data,
        startedAt: getStartedAt(),
        uptimeMs: getUptimeMs(),
        whaleRefresh: whaleRefreshLast,
      });
    } catch (err) {
      console.error('[GET /api/data/browse]', err);
      pushError({ source: 'data/browse', message: err.message || '读取数据库失败' });
      res.status(500).json({ error: err.message || '读取数据库失败' });
    }
  });
  app.get(`${base}/data/monitor`, (_req, res) => {
    try {
      res.json(getMonitorSnapshot());
    } catch (err) {
      res.status(500).json({ error: err.message || '读取监控失败' });
    }
  });
  app.post(`${base}/data/refresh-whales`, async (_req, res) => {
    if (whaleRefreshBusy) {
      return res.status(409).json({
        error: '正在拉取中，请稍候',
        whaleRefresh: whaleRefreshLast,
      });
    }
    whaleRefreshBusy = true;
    const started = Date.now();
    whaleRefreshLast = {
      status: 'running',
      startedAt: started,
      finishedAt: null,
      error: null,
    };
    try {
      const { refreshWhalesShard } = require('./whales');
      // 连跑几片，尽快更新一批热门巨鲸（避免一次全量打爆官方）
      const rounds = Math.max(1, Math.min(8, Number(_req.query?.rounds) || 3));
      let last = null;
      for (let i = 0; i < rounds; i += 1) {
        last = await refreshWhalesShard({ force: true });
      }
      whaleRefreshLast = {
        status: 'ok',
        startedAt: started,
        finishedAt: Date.now(),
        rounds,
        error: null,
        result: last
          ? {
              pending: last.pending ?? null,
              incomplete: Boolean(last.incomplete),
              whaleCount: Array.isArray(last.whales) ? last.whales.length : null,
            }
          : null,
      };
      pushRequest({
        method: 'JOB',
        path: '/data/refresh-whales',
        status: 200,
        ms: Date.now() - started,
        ok: true,
        message: `拉取巨鲸完成 rounds=${rounds}`,
      });
      res.json({ ok: true, whaleRefresh: whaleRefreshLast });
    } catch (err) {
      whaleRefreshLast = {
        status: 'error',
        startedAt: started,
        finishedAt: Date.now(),
        error: err.message || '拉取失败',
      };
      console.error('[POST /api/data/refresh-whales]', err);
      pushError({ source: 'refresh-whales', message: err.message || '拉取失败' });
      res.status(500).json({ error: err.message || '拉取失败', whaleRefresh: whaleRefreshLast });
    } finally {
      whaleRefreshBusy = false;
    }
  });

  /** POST /api/data/reset — 清空市场数据，保留用户与手动巨鲸，并重启补齐 */
  app.post(`${base}/data/reset`, async (_req, res) => {
    if (whaleRefreshBusy) {
      return res.status(409).json({
        error: '正在重置/拉取中，请稍候',
        whaleRefresh: whaleRefreshLast,
      });
    }
    whaleRefreshBusy = true;
    const started = Date.now();
    whaleRefreshLast = {
      status: 'resetting',
      startedAt: started,
      finishedAt: null,
      error: null,
    };
    try {
      const { resetSiteData } = require('./siteReset');
      const result = await resetSiteData({
        rounds: Math.max(1, Math.min(8, Number(_req.query?.rounds) || 3)),
      });
      whaleRefreshLast = {
        status: 'ok',
        kind: 'reset',
        startedAt: started,
        finishedAt: Date.now(),
        error: null,
        result,
      };
      pushRequest({
        method: 'JOB',
        path: '/data/reset',
        status: 200,
        ms: Date.now() - started,
        ok: true,
        message: `整站重置完成 manuals=${result.keptManuals}`,
      });
      res.json({
        ok: true,
        whaleRefresh: whaleRefreshLast,
        fillBackfill: result.backfill,
        keptManuals: result.keptManuals,
      });
    } catch (err) {
      whaleRefreshLast = {
        status: 'error',
        kind: 'reset',
        startedAt: started,
        finishedAt: Date.now(),
        error: err.message || '重置失败',
      };
      console.error('[POST /api/data/reset]', err);
      pushError({ source: 'data/reset', message: err.message || '重置失败' });
      res.status(500).json({ error: err.message || '重置失败', whaleRefresh: whaleRefreshLast });
    } finally {
      whaleRefreshBusy = false;
    }
  });
}

/**
 * @param {{ prefixes?: string[] }} [options]
 * prefixes: Node 生产用 ['/api']；EdgeOne 函数目录已是 /api，同时挂 '' 与 '/api' 以防路径未剥离。
 */
function createApp(options = {}) {
  const prefixes = Array.isArray(options.prefixes) && options.prefixes.length
    ? options.prefixes
    : ['/api'];
  const app = express();
  app.use(cors());
  // 异动历史同步会一次性上传前端本地缓存的全部记录（3000 条 × ~450B ≈ 1.3MB），
  // 超过全局 1mb 限制。只放宽这一个路由，其余接口仍走 1mb。
  const alertHistoryJson = express.json({ limit: ALERT_HISTORY_BODY_LIMIT });
  app.use((req, res, next) => {
    if (req.method === 'POST' && /\/whales\/alert-history\/?$/.test(String(req.path || ''))) {
      return alertHistoryJson(req, res, next);
    }
    return next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    if (!String(req.path || '').startsWith('/api') && !String(req.originalUrl || '').includes('/api/')) {
      return next();
    }
    // 监控接口自身不写入，避免刷屏
    if (/\/data\/monitor\b/.test(req.originalUrl || req.url || '')) return next();
    const started = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - started;
      const status = res.statusCode;
      const path = req.originalUrl || req.url || req.path || '';
      const entry = {
        method: req.method,
        path,
        status,
        ms,
        ok: status < 400,
        message: `${req.method} ${path} → ${status} (${ms}ms)`,
      };
      pushRequest(entry);
      if (status >= 400) {
        pushError({
          source: 'http',
          message: entry.message,
          detail: { status, path, method: req.method },
        });
      }
    });
    next();
  });
  app.get('/poly-fed', async (_req, res) => {
    try {
      res.json(await fetchFedOdds());
    } catch (err) {
      res.status(502).json({ title: '9 月 FOMC', items: [], hikePct: 0, cutPct: 0, holdPct: 0, source: 'Polymarket', error: err.message });
    }
  });
  prefixes.forEach((prefix) => mountRoutes(app, prefix));
  return app;
}

module.exports = { createApp };
