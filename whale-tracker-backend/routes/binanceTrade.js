const express = require('express');
const { requireUser } = require('../lib/authStore');
const { getBinanceCredentialsForUser } = require('../lib/userExchangeKeys');
const { signedRequest } = require('../lib/binanceTradfiTrade');
const { planStance, placeStance, accountBook } = require('../lib/binanceCryptoTrade');
const { validatedAiOrder } = require('../lib/cryptoAiOrderGate');
const { recordBinanceAiOrder } = require('../lib/binanceAiLedger');

const router = express.Router();
function credentials(req) {
  const user = requireUser(req);
  const creds = getBinanceCredentialsForUser(user.user.id);
  if (!creds) { const err = new Error('请先在「API 设置」中配置币安下单密钥'); err.status = 400; throw err; }
  return creds;
}
function fail(res, err) { res.status(Number(err.status) || 500).json({ error: err.message || '币安交易请求失败', code: err.code }); }

router.get('/ai-book', async (req, res) => {
  try {
    const user = requireUser(req);
    res.json(await accountBook(credentials(req), user.user.id, 'crypto'));
  } catch (err) { fail(res, err); }
});
router.post('/stance-preview', async (req, res) => {
  try {
    const user = requireUser(req);
    credentials(req);
    res.json({ ok: true, plan: await planStance(validatedAiOrder(req.body, user.user.id)) });
  } catch (err) { fail(res, err); }
});
router.post('/stance-order', async (req, res) => {
  try {
    const user = requireUser(req);
    const creds = credentials(req);
    const result = await placeStance(creds, validatedAiOrder(req.body, user.user.id));
    recordBinanceAiOrder(user.user.id, 'crypto', {
      orderId: result.order?.orderId, clientOrderId: result.order?.clientOrderId,
      symbol: result.plan.symbol, side: result.plan.side, positionSide: result.order?.positionSide,
      price: result.plan.price, quantity: result.plan.quantity, marginUsdt: result.plan.marginUsdt,
      leverage: result.plan.leverage, simulated: result.simulated,
    });
    res.json(result);
  } catch (err) { fail(res, err); }
});
router.post('/cancel', async (req, res) => {
  try {
    const creds = credentials(req);
    const symbol = String(req.body?.symbol || '').toUpperCase();
    const orderId = String(req.body?.orderId || '');
    if (!/^[A-Z0-9]{3,30}USDT$/.test(symbol) || !/^\d+$/.test(orderId)) return res.status(400).json({ error: '无效订单' });
    const order = await signedRequest(creds, 'GET', '/fapi/v1/order', { symbol, orderId });
    const canceled = await signedRequest(creds, 'DELETE', '/fapi/v1/order', { symbol, orderId });
    const group = /^wtai_([a-f0-9]{22})_e$/.exec(String(order.clientOrderId || ''))?.[1];
    let protectionCleanup = [];
    if (group) {
      try {
        const open = await signedRequest(creds, 'GET', '/fapi/v1/openAlgoOrders', { symbol });
        const related = (Array.isArray(open) ? open : []).filter((item) => String(item.clientAlgoId || '').startsWith(`wtai_${group}_`));
        protectionCleanup = await Promise.allSettled(related.map((item) => signedRequest(creds, 'DELETE', '/fapi/v1/algoOrder', { algoId: String(item.algoId) })));
      } catch (err) { return res.status(502).json({ error: `开仓挂单已取消，但保护单清理失败：${err.message}`, canceled }); }
    }
    const failed = protectionCleanup.filter((item) => item.status === 'rejected');
    if (failed.length) return res.status(502).json({ error: '开仓挂单已取消，但部分止损止盈单清理失败，请在币安检查条件单', canceled });
    res.json({ ok: true, order: canceled });
  } catch (err) { fail(res, err); }
});
module.exports = router;
