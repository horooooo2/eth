const express = require('express');
const { getCatalog, getQuotes } = require('../lib/tradfiMarkets');
const { getIntel } = require('../lib/tradfiIntel');
const { getWhaleActivity, getAllWhaleActivity } = require('../lib/tradfiWhales');
const { requireUser } = require('../lib/authStore');
const { getBinanceCredentialsForUser } = require('../lib/userExchangeKeys');
const { accountBook } = require('../lib/binanceCryptoTrade');
const rangeStrategy = require('../lib/tradfiRangeStrategy');

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

router.get('/account', async (req, res) => {
  try {
    const user = requireUser(req);
    const creds = getBinanceCredentialsForUser(user.user.id);
    if (!creds) return res.json({ ok: true, configured: false, scope: 'tradfi', balance: { totalEq: null, usdtEq: null, availBal: null }, openPnl: 0, historyPnl: null, records: [] });
    const [book, catalog] = await Promise.all([accountBook(creds, user.user.id, 'tradfi'), getCatalog()]);
    const symbols = new Set(catalog.symbols.map((row) => row.symbol));
    const records = book.records.filter((row) => symbols.has(row.instId));
    res.json({ ...book, scope: 'tradfi', records, openPnl: records.filter((row) => row.kind === 'position').reduce((sum, row) => sum + Number(row.openUpl || 0), 0) });
  } catch (err) { res.status(err.status || 502).json({ error: err.message || 'TradFi 交易账户加载失败', code: err.code }); }
});

router.get('/range/status', (req, res) => {
  try {
    const user = requireUser(req);
    res.json({ ok: true, ...rangeStrategy.status(user.user.id, req.query.symbol) });
  } catch (err) { res.status(err.status || 500).json({ error: err.message || '震荡策略状态加载失败' }); }
});

router.post('/range/start', async (req, res) => {
  try {
    const user = requireUser(req);
    const creds = getBinanceCredentialsForUser(user.user.id);
    if (!creds) throw Object.assign(new Error('请先在 API 设置中配置币安 API 密钥'), { status: 400 });
    res.json({ ok: true, ...rangeStrategy.enable(user.user.id, req.body?.symbol, creds.simulated, req.body) });
    void rangeStrategy.reconcile();
  } catch (err) { res.status(err.status || 500).json({ error: err.message || '震荡策略启动失败', code: err.code }); }
});

router.post('/range/stop', async (req, res) => {
  try {
    const user = requireUser(req);
    res.json({ ok: true, ...await rangeStrategy.disable(user.user.id, req.body?.symbol) });
  } catch (err) { res.status(err.status || 500).json({ error: err.message || '震荡策略暂停失败', code: err.code }); }
});

router.post('/close-all', async (req, res) => {
  try {
    const user = requireUser(req);
    res.json({ ok: true, ...await rangeStrategy.closeAll(user.user.id) });
  } catch (err) { res.status(err.status || 500).json({ error: err.message || '一键平仓提交失败', code: err.code }); }
});

module.exports = router;
