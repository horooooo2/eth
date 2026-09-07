const express = require('express');
const { requireUser } = require('../lib/authStore');
const {
  getTradeStatus,
  getBalance,
  getAccountPositions,
  getPendingOrders,
  placeOrder,
  cancelOrder,
  summarizeBalance,
  isTradeConfigured,
} = require('../lib/okxTradeClient');

const router = express.Router();

function sendErr(res, err) {
  const status = Number(err.status) || 500;
  res.status(status).json({
    error: err.message || '交易请求失败',
    code: err.code || undefined,
    okx: err.okx || undefined,
  });
}

function assertLogin(req, res) {
  try {
    req.user = requireUser(req);
    return true;
  } catch (err) {
    sendErr(res, err);
    return false;
  }
}

/** GET /api/okx/trade/status — 是否已配置（不含密钥） */
router.get('/status', (_req, res) => {
  res.json(getTradeStatus());
});

/** GET /api/okx/trade/balance */
router.get('/balance', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    if (!isTradeConfigured()) {
      return res.status(503).json({ error: '未配置 OKX 交易 API Key', ...getTradeStatus() });
    }
    const ccy = String(req.query.ccy || '').trim();
    const rows = await getBalance(ccy || undefined);
    res.json({
      ...getTradeStatus(),
      balance: summarizeBalance(rows),
      rawCount: rows.length,
    });
  } catch (err) {
    console.error('[GET /api/okx/trade/balance]', err.message || err);
    sendErr(res, err);
  }
});

/** GET /api/okx/trade/positions */
router.get('/positions', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    if (!isTradeConfigured()) {
      return res.status(503).json({ error: '未配置 OKX 交易 API Key', ...getTradeStatus() });
    }
    const instType = String(req.query.instType || 'SWAP');
    const instId = String(req.query.instId || '').trim() || undefined;
    const positions = await getAccountPositions(instType, instId);
    res.json({ ...getTradeStatus(), positions });
  } catch (err) {
    console.error('[GET /api/okx/trade/positions]', err.message || err);
    sendErr(res, err);
  }
});

/** GET /api/okx/trade/orders-pending */
router.get('/orders-pending', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    if (!isTradeConfigured()) {
      return res.status(503).json({ error: '未配置 OKX 交易 API Key', ...getTradeStatus() });
    }
    const instType = String(req.query.instType || 'SWAP');
    const instId = String(req.query.instId || '').trim() || undefined;
    const orders = await getPendingOrders(instType, instId);
    res.json({ ...getTradeStatus(), orders });
  } catch (err) {
    console.error('[GET /api/okx/trade/orders-pending]', err.message || err);
    sendErr(res, err);
  }
});

/** POST /api/okx/trade/order */
router.post('/order', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    if (!isTradeConfigured()) {
      return res.status(503).json({ error: '未配置 OKX 交易 API Key', ...getTradeStatus() });
    }
    const result = await placeOrder(req.body || {});
    console.log(
      '[okx-trade] order by',
      req.user?.user?.username || req.user?.username || 'unknown',
      result.order?.ordId || result.order?.clOrdId || '',
    );
    res.json({ ok: true, ...getTradeStatus(), ...result });
  } catch (err) {
    console.error('[POST /api/okx/trade/order]', err.message || err);
    sendErr(res, err);
  }
});

/** POST /api/okx/trade/cancel */
router.post('/cancel', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    if (!isTradeConfigured()) {
      return res.status(503).json({ error: '未配置 OKX 交易 API Key', ...getTradeStatus() });
    }
    const result = await cancelOrder(req.body || {});
    res.json({ ok: true, ...getTradeStatus(), ...result });
  } catch (err) {
    console.error('[POST /api/okx/trade/cancel]', err.message || err);
    sendErr(res, err);
  }
});

module.exports = router;
