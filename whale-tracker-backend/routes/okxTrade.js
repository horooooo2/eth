const express = require('express');
const { requireUser } = require('../lib/authStore');
const {
  getTradeStatus,
  getBalance,
  getAccountPositions,
  getPendingOrders,
  placeOrder,
  placeStanceOrder,
  cancelOrder,
  summarizeBalance,
  isTradeConfigured,
  withTradeCredentials,
} = require('../lib/okxTradeClient');
const { getOkxCredentialsForUser, patchOkxFlags } = require('../lib/userExchangeKeys');
const { recordAiOrder, buildAccountPreview } = require('../lib/okxAiLedger');

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

function userCredsOrThrow(req) {
  const creds = getOkxCredentialsForUser(req.user.user.id);
  if (!creds) {
    const err = new Error('请先在「API 设置」中配置 OKX 下单密钥');
    err.status = 400;
    throw err;
  }
  return creds;
}

/** Run private OKX calls with the user's saved demo/live flag (no silent flip). */
async function withUserTrade(req, fn) {
  const creds = userCredsOrThrow(req);
  return withTradeCredentials(creds, fn);
}


function rememberAiOrder(req, result) {
  try {
    recordAiOrder(req.user.user.id, req.body || {}, result);
  } catch (err) {
    console.warn('[okx-ai] record failed', err && err.message);
  }
}

/** GET /api/okx/trade/status */
router.get('/status', (req, res) => {
  if (!assertLogin(req, res)) return;
  const creds = getOkxCredentialsForUser(req.user.user.id);
  if (creds) {
    return res.json({ ...getTradeStatus(creds), source: 'user' });
  }
  res.json({ ...getTradeStatus(), source: isTradeConfigured() ? 'env' : 'none' });
});

/** GET /api/okx/trade/balance */
router.get('/balance', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const creds = userCredsOrThrow(req);
    const ccy = String(req.query.ccy || '').trim();
    const rows = await withUserTrade(req, () => getBalance(ccy || undefined));
    res.json({
      ...getTradeStatus(creds),
      balance: summarizeBalance(rows),
      rawCount: rows.length,
    });
  } catch (err) {
    sendErr(res, err);
  }
});

/** GET /api/okx/trade/positions */
router.get('/positions', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const creds = userCredsOrThrow(req);
    const instType = String(req.query.instType || 'SWAP');
    const instId = String(req.query.instId || '').trim() || undefined;
    const positions = await withUserTrade(req, () =>
      getAccountPositions(instType, instId),
    );
    res.json({ ...getTradeStatus(creds), positions });
  } catch (err) {
    sendErr(res, err);
  }
});

/** GET /api/okx/trade/orders-pending */
router.get('/orders-pending', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const creds = userCredsOrThrow(req);
    const instType = String(req.query.instType || 'SWAP');
    const instId = String(req.query.instId || '').trim() || undefined;
    const orders = await withUserTrade(req, () => getPendingOrders(instType, instId));
    res.json({ ...getTradeStatus(creds), orders });
  } catch (err) {
    sendErr(res, err);
  }
});

/** POST /api/okx/trade/order */
router.post('/order', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const creds = userCredsOrThrow(req);
    const result = await withUserTrade(req, () => placeOrder(req.body || {}));
    res.json({ ok: true, ...getTradeStatus(creds), ...result });
  } catch (err) {
    sendErr(res, err);
  }
});

/** POST /api/okx/trade/stance-order — 按仓位建议 + 用户金额限价挂单 */
router.post('/stance-order', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const creds = userCredsOrThrow(req);
    const result = await withUserTrade(req, () => placeStanceOrder(req.body || {}));
    rememberAiOrder(req, result);
    res.json({ ok: true, ...getTradeStatus(creds), ...result });
  } catch (err) {
    sendErr(res, err);
  }
});

/**
 * POST /api/okx/trade/stance-order-stream — SSE 分步进度
 * events: stage | done | error
 */
router.post('/stance-order-stream', async (req, res) => {
  if (!assertLogin(req, res)) return;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const writeEvent = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const creds = userCredsOrThrow(req);
    writeEvent('stage', {
      id: 'init',
      status: 'running',
      progress: 5,
      message: '准备挂单…',
    });
    const result = await withUserTrade(req, () =>
      placeStanceOrder(req.body || {}, {
        onStage: (stage) => writeEvent('stage', stage),
      }),
    );
    rememberAiOrder(req, result);
    writeEvent('done', { ok: true, ...getTradeStatus(creds), ...result });
  } catch (err) {
    writeEvent('error', {
      error: err.message || '挂单失败',
      code: err.code || undefined,
      okx: err.okx || undefined,
    });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

/** GET /api/okx/trade/ai-book — 仅 AI 开单的仓位与挂单 */
router.get('/ai-book', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const creds = userCredsOrThrow(req);
    const book = await withUserTrade(req, () => buildAccountPreview(req.user.user.id));
    res.json({ ok: true, ...getTradeStatus(creds), ...book });
  } catch (err) {
    sendErr(res, err);
  }
});

/** POST /api/okx/trade/cancel */
router.post('/cancel', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const creds = userCredsOrThrow(req);
    const result = await withUserTrade(req, () => cancelOrder(req.body || {}));
    res.json({ ok: true, ...getTradeStatus(creds), ...result });
  } catch (err) {
    sendErr(res, err);
  }
});

module.exports = router;
