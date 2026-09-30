const express = require('express');
const { getCatalog, getQuotes } = require('../lib/tradfiMarkets');
const { getIntel } = require('../lib/tradfiIntel');
const { getWhaleActivity, getAllWhaleActivity } = require('../lib/tradfiWhales');

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

module.exports = router;
