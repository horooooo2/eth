const express = require('express');
const { getCatalog, getQuotes } = require('../lib/tradfiMarkets');
const { getIntel } = require('../lib/tradfiIntel');
const { getWhaleActivity, getAllWhaleActivity } = require('../lib/tradfiWhales');
const { requireUser } = require('../lib/authStore');
const { getBinanceCredentialsForUser } = require('../lib/userExchangeKeys');
const { previewTradfiOrder, placeTradfiOrder } = require('../lib/binanceTradfiTrade');

const router = express.Router();

router.get('/catalog', async (_req, res) => {
  try {
    const result = await getCatalog();
    res.json({ symbols: result.symbols, updatedAt: result.updatedAt, stale: Boolean(result.stale), source: 'Binance USDⓈ-M Futures' });
  } catch (err) {
    console.error('[GET /api/tradfi/catalog]', err.message);
    res.status(502).json({ error: 'TradFi 合约清单暂不可用', details: err.message });
  }
});

router.get('/quotes', async (req, res) => {
  try {
    res.json(await getQuotes(req.query.symbols));
  } catch (err) {
    console.error('[GET /api/tradfi/quotes]', err.message);
    res.status(502).json({ error: 'TradFi 行情暂不可用', details: err.message });
  }
});

router.get('/intel', async (req, res) => {
  try {
    res.json(await getIntel(req.query.symbol));
  } catch (err) {
    console.error('[GET /api/tradfi/intel]', err.message);
    res.status(err.status || 502).json({ error: err.message || 'TradFi 资讯暂不可用' });
  }
});

router.get('/whales/all', async (_req, res) => {
  try {
    res.json(await getAllWhaleActivity());
  } catch (err) {
    console.error('[GET /api/tradfi/whales/all]', err.message);
    res.status(err.status || 502).json({ error: err.message || 'TradFi 大户动态暂不可用' });
  }
});

router.get('/whales', async (req, res) => {
  try {
    res.json(await getWhaleActivity(req.query.symbol, req.query.dex, req.query.addresses));
  } catch (err) {
    console.error('[GET /api/tradfi/whales]', err.message);
    res.status(err.status || 502).json({ error: err.message || 'TradFi 大户动态暂不可用' });
  }
});

router.post('/order/preview', async (req, res) => {
  try {
    const user = requireUser(req);
    const creds = getBinanceCredentialsForUser(user.user.id);
    const plan = await previewTradfiOrder(req.body || {});
    res.json({ ok: true, configured: Boolean(creds), plan: { ...plan, testnet: creds?.simulated ?? null } });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message || '订单预览失败' });
  }
});

router.post('/order/test', async (req, res) => {
  try {
    const user = requireUser(req);
    const creds = getBinanceCredentialsForUser(user.user.id);
    if (!creds) return res.status(400).json({ error: '请先在 API 设置中配置币安 API 密钥' });
    res.json(await placeTradfiOrder(creds, req.body || {}, true));
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message || '币安测试下单失败', code: err.code });
  }
});

router.post('/order', async (req, res) => {
  try {
    const user = requireUser(req);
    if (req.body?.confirm !== true) return res.status(400).json({ error: '请先确认订单参数' });
    const creds = getBinanceCredentialsForUser(user.user.id);
    if (!creds) return res.status(400).json({ error: '请先在 API 设置中配置币安 API 密钥' });
    res.json(await placeTradfiOrder(creds, req.body || {}));
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message || '币安下单失败', code: err.code });
  }
});

module.exports = router;
