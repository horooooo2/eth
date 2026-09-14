const express = require('express');
const { getDexFlowCoins, parsePeriod, getDexFlowStatus } = require('../lib/dexpaprikaFlow');

const router = express.Router();

function parseCoins(query) {
  const raw = query.coins;
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

/** GET /api/flow/coins?period=24h&coins=BTC,ETH,SOL — 读服务端定时缓存 */
router.get('/coins', (req, res) => {
  try {
    const period = parsePeriod(req.query.period);
    const coins = parseCoins(req.query);
    res.json(getDexFlowCoins(period, coins));
  } catch (err) {
    console.error('[GET /api/flow/coins]', err);
    res.status(500).json({ error: err.message || '资金流向读取失败', coins: [] });
  }
});

/** GET /api/flow/status — 定时任务状态 */
router.get('/status', (_req, res) => {
  res.json(getDexFlowStatus());
});

module.exports = router;
