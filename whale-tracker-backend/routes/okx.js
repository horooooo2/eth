const express = require('express');
const {
  getOkxDashboard,
  refreshOkxDashboard,
  getOkxStatus,
  getTraderDetail,
  seedOkxCache,
} = require('../lib/okxCopyTrading');
const okxTradeRouter = require('./okxTrade');

const router = express.Router();

router.use('/trade', okxTradeRouter);
function assertSeedToken(req, res) {
  const need = String(process.env.OKX_SEED_TOKEN || '').trim();
  if (!need) return true;
  const got = String(req.get('x-okx-seed-token') || req.query.token || '').trim();
  if (got && got === need) return true;
  res.status(401).json({ error: '需要有效的 OKX_SEED_TOKEN' });
  return false;
}

/** GET /api/okx — Top 交易员 + 开单时间流 + 持仓 */
router.get('/', async (req, res) => {
  try {
    const force = req.query.refresh === '1';
    const data = await getOkxDashboard({ force });
    if (!data || !Array.isArray(data.traders)) {
      const status = getOkxStatus();
      return res.status(502).json({
        error: data?.error || status.lastRefresh?.error || 'OKX 暂无交易员数据（境内 IP 常需代理或本机推送缓存）',
        status,
      });
    }
    res.json(data);
  } catch (err) {
    console.error('[GET /api/okx]', err);
    res.status(502).json({
      error: err.message || 'OKX 数据获取失败',
      status: getOkxStatus(),
    });
  }
});

/** GET /api/okx/traders — 仅交易员列表 */
router.get('/traders', async (req, res) => {
  try {
    const force = req.query.refresh === '1';
    const data = await getOkxDashboard({ force });
    res.json({
      traders: data.traders || [],
      meta: data.meta,
      updatedAt: data.updatedAt,
      stale: data.stale,
    });
  } catch (err) {
    console.error('[GET /api/okx/traders]', err);
    res.status(502).json({ error: err.message || 'OKX 交易员获取失败' });
  }
});

/** GET /api/okx/opens — 开/平仓时间流，可选 ?traderId= */
router.get('/opens', async (req, res) => {
  try {
    const data = await getOkxDashboard({ force: false });
    const traderId = String(req.query.traderId || '').trim();
    let opens = Array.isArray(data.opens) ? data.opens : [];
    if (traderId) {
      opens = opens.filter((item) => item.traderId === traderId);
    }
    const limit = Math.min(300, Math.max(1, Number(req.query.limit) || 120));
    res.json({
      opens: opens.slice(0, limit),
      total: opens.length,
      traderId: traderId || null,
      updatedAt: data.updatedAt,
      stale: data.stale,
    });
  } catch (err) {
    console.error('[GET /api/okx/opens]', err);
    res.status(502).json({ error: err.message || 'OKX 开单流获取失败' });
  }
});

/** GET /api/okx/positions — 当前持仓列表，可选 ?traderId= */
router.get('/positions', async (req, res) => {
  try {
    const data = await getOkxDashboard({ force: false });
    const traderId = String(req.query.traderId || '').trim();
    let positions = Array.isArray(data.positions) ? data.positions : [];
    if (traderId) {
      positions = data.positionsByTrader?.[traderId] || [];
    }
    res.json({
      positions,
      total: positions.length,
      traderId: traderId || null,
      updatedAt: data.updatedAt,
      stale: data.stale,
    });
  } catch (err) {
    console.error('[GET /api/okx/positions]', err);
    res.status(502).json({ error: err.message || 'OKX 持仓获取失败' });
  }
});

/** GET /api/okx/traders/:id/detail — 带单表现（左栏） */
router.get('/traders/:id/detail', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const lastDays = String(req.query.lastDays || '3');
    const force = req.query.refresh === '1';
    const data = await getTraderDetail(id, { force, lastDays });
    res.json(data);
  } catch (err) {
    console.error('[GET /api/okx/traders/:id/detail]', err);
    res.status(502).json({ error: err.message || 'OKX 带单数据获取失败' });
  }
});

/** GET /api/okx/traders/:id/positions — 某交易员当前持仓 */
router.get('/traders/:id/positions', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const data = await getOkxDashboard({ force: false });
    const positions = data.positionsByTrader?.[id] || [];
    const trader = (data.traders || []).find((t) => t.id === id) || null;
    res.json({ trader, positions, updatedAt: data.updatedAt, stale: data.stale });
  } catch (err) {
    console.error('[GET /api/okx/traders/:id/positions]', err);
    res.status(502).json({ error: err.message || 'OKX 持仓获取失败' });
  }
});

/** POST /api/okx/seed — 本机抓取后推送缓存（境内服务器直连 OKX 失败时用） */
router.post('/seed', (req, res) => {
  try {
    if (!assertSeedToken(req, res)) return;
    const body = req.body || {};
    const payload = body.data && Array.isArray(body.data.traders) ? body.data : body;
    const result = seedOkxCache(payload, { source: 'push' });
    res.json({ ok: true, ...result, status: getOkxStatus() });
  } catch (err) {
    console.error('[POST /api/okx/seed]', err);
    res.status(400).json({ error: err.message || 'OKX 缓存写入失败' });
  }
});

/** POST /api/okx/refresh — 强制刷新 */
router.post('/refresh', async (_req, res) => {
  try {
    const data = await refreshOkxDashboard();
    res.json({ ok: true, meta: data.meta, traders: data.traders?.length || 0 });
  } catch (err) {
    console.error('[POST /api/okx/refresh]', err);
    res.status(502).json({ error: err.message || 'OKX 刷新失败' });
  }
});

/** GET /api/okx/status */
router.get('/status', (_req, res) => {
  res.json(getOkxStatus());
});

module.exports = router;
