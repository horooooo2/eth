const express = require('express');
const { getMarkets, getQuotes, getLiquidations, lookupCoin } = require('../lib/markets');
const { fetchWhaleAlerts } = require('../lib/onchain');

const router = express.Router();

function parseCoins(query) {
  const raw = query.coins;
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

router.get('/quotes', async (req, res) => {
  try {
    res.json(await getQuotes(parseCoins(req.query)));
  } catch (err) {
    console.error('[GET /api/markets/quotes]', err);
    res.status(502).json({ error: err.message || '现价获取失败' });
  }
});

router.get('/liquidations', async (req, res) => {
  try {
    const coin = req.query.coin || 'BTC';
    res.json(await getLiquidations(coin));
  } catch (err) {
    console.error('[GET /api/markets/liquidations]', err);
    res.status(502).json({ error: err.message || '爆仓数据获取失败' });
  }
});

/** GET /api/markets/whale-alerts — 全网大额链上转账（资金动向） */
router.get('/whale-alerts', async (req, res) => {
  try {
    const minUsd = Math.max(0, Number(req.query.minUsd) || 100_000);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const data = await fetchWhaleAlerts(minUsd, limit);
    res.json({
      alerts: (data.alerts || []).slice(0, limit),
      source: data.source || null,
      warning: data.error || data.warning || null,
      minUsd,
      updatedAt: Date.now(),
    });
  } catch (err) {
    console.error('[GET /api/markets/whale-alerts]', err);
    res.status(502).json({ error: err.message || '巨鲸异动获取失败', alerts: [] });
  }
});

router.get('/lookup', async (req, res) => {
  try {
    const result = await lookupCoin(req.query.symbol);
    if (!result.ok) {
      return res.status(404).json({ error: result.error || '币种输入错误，请检查后再试' });
    }
    res.json(result);
  } catch (err) {
    console.error('[GET /api/markets/lookup]', err);
    res.status(502).json({ error: err.message || '币种查询失败' });
  }
});

router.get('/', async (req, res) => {
  try {
    const force = req.query.refresh === '1';
    const data = await getMarkets(force, parseCoins(req.query));
    res.json(data);
  } catch (err) {
    console.error('[GET /api/markets]', err);
    res.status(502).json({ error: err.message || '币种数据获取失败' });
  }
});

module.exports = router;
