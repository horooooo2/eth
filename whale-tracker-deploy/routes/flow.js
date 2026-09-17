const express = require('express');
const cex = require('../lib/cexMarketFlow');
const onchain = require('../lib/onchainFlow');
const coinank = require('../lib/coinankFlow');
const defillama = require('../lib/defillamaMacro');

const router = express.Router();

function parseCoins(query) {
  const raw = query.coins;
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

/** 兼容旧 period 名 */
function normalizePeriod(raw) {
  const p = String(raw || '1h').toLowerCase();
  if (cex.PERIODS[p]) return p;
  if (p === '24h' || p === '7d') return '6h';
  return '1h';
}

/**
 * GET /api/flow/coins?period=1h&coins=BTC,ETH,SOL&marketType=spot|swap
 *
 * 优先级：
 *   1. CoinAnk 对应市场的官方 net 字段（主源）
 *   2. Binance/OKX/Bybit WS 聚合（同市场类型的 taker 净流入 fallback）
 *
 * net 直接用 CoinAnk 的，不用 buy-sell 重算；
 * buy/sell/price 从同市场类型的 WS 取（仅供前端展示，不影响 net）。
 */
router.get('/coins', (req, res) => {
  try {
    const period = normalizePeriod(req.query.period);
    const coins = parseCoins(req.query);
    const marketType = String(req.query.marketType || 'spot').toLowerCase() === 'swap' ? 'swap' : 'spot';

    // 1. WS 聚合（同 marketType 的 buy/sell/price/fallback）
    const wsData = cex.getFlowCoins(period, coins, marketType);
    const wsMap = {};
    for (const row of (wsData.coins || [])) wsMap[row.coin] = row;

    // 2. CoinAnk net（主）
    const coinankNet = coinank.getNet(period, marketType) || {};
    const coinankStatus = coinank.getStatus();

    const wanted = (coins.length ? coins : ['BTC', 'ETH', 'SOL'])
      .map((c) => String(c || '').toUpperCase())
      .filter(Boolean);

    const rows = wanted.map((coin) => {
      const ws = wsMap[coin] || { buy: 0, sell: 0, count: 0, price: null };
      const hasCoinank = coinankNet[coin] !== undefined && coinankNet[coin] !== null;
      const net = hasCoinank ? Math.round(coinankNet[coin]) : Math.round(ws.net || 0);
      const source = hasCoinank
        ? (coinankStatus.stale ? `coinank-${marketType}-stale` : `coinank-${marketType}`)
        : (ws.source || `cex-ws-${marketType}`);
      return {
        coin,
        buy: Math.round(ws.buy || 0),
        sell: Math.round(ws.sell || 0),
        net,
        count: ws.count || 0,
        price: ws.price || null,
        changePct: null,
        period,
        marketType,
        source,
      };
    });
    rows.sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

    res.json({
      period,
      marketType,
      coins: rows,
      updatedAt: Date.now(),
      accumulating: !rows.length || !!wsData.accumulating,
      primary: hasCoinankAny(rows) ? `coinank-${marketType}` : `cex-ws-${marketType}`,
    });
  } catch (err) {
    console.error('[GET /api/flow/coins]', err);
    res.status(500).json({ error: err.message || '资金流向读取失败', coins: [] });
  }
});

function hasCoinankAny(rows) {
  return rows.some((r) => r.source && r.source.startsWith('coinank'));
}

/** GET /api/flow/dex?period=1h&coins=ETH,BTC — DEX on-chain flow */
router.get('/dex', (req, res) => {
  try {
    const period = normalizePeriod(req.query.period);
    const coins = parseCoins(req.query);
    res.json(onchain.getFlowCoins(period, coins));
  } catch (err) {
    console.error('[GET /api/flow/dex]', err);
    res.status(500).json({ error: err.message || 'DEX 资金流向读取失败', coins: [] });
  }
});

/** GET /api/flow/defillama?coins=BTC,ETH,SOL — 按偏好币种聚合的协议沉淀 */
router.get('/defillama', async (req, res) => {
  try {
    const snap = await defillama.getSnapshot(req.query.coins);
    res.json(snap);
  } catch (err) {
    console.error('[GET /api/flow/defillama]', err);
    res.status(500).json({
      ok: false,
      error: err.message || 'DeFiLlama 读取失败',
      overview: null,
      coins: [],
    });
  }
});

/** GET /api/flow/status */
router.get('/status', (_req, res) => {
  res.json({
    defillama: defillama.getStatus(),
    coinank: coinank.getStatus(),
    cex: cex.getStatus(),
    dex: onchain.getStatus(),
  });
});

module.exports = router;
