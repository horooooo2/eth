const express = require('express');
const defillama = require('../lib/defillamaMacro');
const router = express.Router();

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

router.get('/status', (_req, res) => res.json({ defillama: defillama.getStatus() }));
module.exports = router;
