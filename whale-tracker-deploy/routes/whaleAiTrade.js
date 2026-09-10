/**
 * 鲸鱼 AI 专用交易路由（OKX 私有 API）
 * 挂载于 /api/whale-ai/trade/*
 * 使用用户绑定的 OKX Key（SQLite user_exchange_keys），不走服务端全局 Key。
 */
const express = require('express');
const { requireUser } = require('../lib/authStore');
const userBinding = require('../lib/v41UserBinding');
const {
  listExchangeKeys,
  upsertExchangeKeys,
  deleteExchangeKeys,
  getOkxCredentialsForUser,
  isOkxReadyForUser,
} = require('../lib/userExchangeKeys');
const {
  getTradeStatus,
  getBalance,
  getAccountPositions,
  getPendingOrders,
  placeOrder,
  cancelOrder,
  summarizeBalance,
  withTradeCredentials,
  getAccountConfig,
} = require('../lib/okxTradeClient');

const router = express.Router();

function sendErr(res, err) {
  const status = Number(err.status) || 500;
  res.status(status).json({
    error: err.message || '鲸鱼AI 交易请求失败',
    code: err.code || undefined,
    okx: err.okx || undefined,
  });
}

function attachOptionalUser(req) {
  try {
    req.user = requireUser(req);
  } catch {
    req.user = null;
  }
}

function trustedUserId(req) {
  attachOptionalUser(req);
  return userBinding.resolveTrustedUserId({ sessionUserId: req.user?.user?.id });
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

function assertTrustedOwner(req, res) {
  const uid = trustedUserId(req);
  if (!uid) {
    const err = new Error('尚未绑定交易操作用户');
    err.status = 403;
    err.code = 'ENGINE_OWNER_NOT_BOUND';
    sendErr(res, err);
    return false;
  }
  req.trustedUserId = uid;
  return true;
}

function requireUserOkx(userId) {
  const creds = getOkxCredentialsForUser(userId);
  if (!creds) {
    const err = new Error('请先在鲸鱼AI 绑定 OKX 交易 API Key');
    err.status = 400;
    throw err;
  }
  return creds;
}

function runAsUser(userId, fn) {
  const creds = requireUserOkx(userId);
  return withTradeCredentials(creds, fn);
}

function publicTradeStatus(userId) {
  const keys = listExchangeKeys(userId);
  const okx = keys.okx || {};
  const ready = isOkxReadyForUser(userId);
  let live = null;
  if (ready) {
    try {
      live = getTradeStatus(getOkxCredentialsForUser(userId));
    } catch {
      live = null;
    }
  }
  return {
    ready,
    exchange: 'okx',
    configured: Boolean(okx.configured),
    simulated: okx.simulated !== false,
    apiKeyHint: okx.apiKeyHint || '',
    updatedAt: okx.updatedAt || 0,
    status: okx.status || 'missing',
    trade: live,
  };
}

/** GET /api/whale-ai/trade/status */
router.get('/status', (req, res) => {
  if (!assertTrustedOwner(req, res)) return;
  res.json(publicTradeStatus(req.trustedUserId));
});

/** GET /api/whale-ai/trade/keys */
router.get('/keys', (req, res) => {
  if (!assertLogin(req, res)) return;
  res.json(listExchangeKeys(req.user.user.id));
});

/** PUT /api/whale-ai/trade/keys — 绑定 OKX（body.exchange 默认 okx） */
router.put('/keys', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const body = req.body || {};
    const exchange = String(body.exchange || 'okx').toLowerCase();
    if (exchange !== 'okx') {
      const err = new Error('鲸鱼AI 交易目前仅支持 OKX');
      err.status = 400;
      throw err;
    }
    const userId = req.user.user.id;
    const simulated =
      body.simulated === false || body.simulated === 0 || body.simulated === '0' ? false : true;

    const probe = {
      apiKey: String(body.apiKey || body.api_key || '').trim(),
      secret: String(body.apiSecret || body.api_secret || '').trim(),
      passphrase: String(body.apiPassphrase || body.api_passphrase || '').trim(),
      simulated,
    };
    if (!probe.apiKey || !probe.secret || !probe.passphrase) {
      const err = new Error('请填写 OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE');
      err.status = 400;
      throw err;
    }

    let verified = false;
    let warn = '';
    try {
      await withTradeCredentials(probe, () =>
        getAccountConfig({ timeoutMs: Number(process.env.OKX_TIMEOUT_MS) || 60_000 }),
      );
      verified = true;
    } catch (err) {
      const detail = String(err.message || err.code || '校验失败');
      const isTimeout = /timeout|ETIMEDOUT|ECONNABORTED|TIMEOUT|超时/i.test(detail);
      if (isTimeout) {
        warn = `${simulated ? '模拟盘' : '实盘'} API 校验超时，密钥已保存；下单时若密钥有误会失败。`;
        console.warn('[whale-ai/trade] okx key verify timeout, save anyway:', detail);
      } else {
        const mode = simulated ? '模拟盘' : '实盘';
        const wrapped = new Error(
          `${mode} API 校验失败：${detail}。请确认密钥属于该盘，且账户模式已切换为合约。`,
        );
        wrapped.status = 400;
        throw wrapped;
      }
    }

    const data = upsertExchangeKeys(userId, exchange, {
      ...body,
      simulated,
      enabled: body.enabled !== false && body.enabled !== 0 && body.enabled !== '0',
    });
    res.json({
      ok: true,
      verified,
      warn,
      ...data,
      trade: publicTradeStatus(userId),
    });
  } catch (err) {
    sendErr(res, err);
  }
});

/** DELETE /api/whale-ai/trade/keys */
router.delete('/keys', (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const exchange = String(req.query.exchange || req.body?.exchange || 'okx').toLowerCase();
    const data = deleteExchangeKeys(req.user.user.id, exchange);
    res.json({ ok: true, ...data, trade: publicTradeStatus(req.user.user.id) });
  } catch (err) {
    sendErr(res, err);
  }
});

/** GET /api/whale-ai/trade/balance */
router.get('/balance', async (req, res) => {
  if (!assertTrustedOwner(req, res)) return;
  try {
    const userId = req.trustedUserId;
    const ccy = String(req.query.ccy || '').trim();
    const rows = await runAsUser(userId, () => getBalance(ccy || undefined));
    res.json({
      ...publicTradeStatus(userId),
      balance: summarizeBalance(rows),
      rawCount: rows.length,
    });
  } catch (err) {
    console.error('[GET /api/whale-ai/trade/balance]', err.message || err);
    sendErr(res, err);
  }
});

/** GET /api/whale-ai/trade/positions */
router.get('/positions', async (req, res) => {
  if (!assertTrustedOwner(req, res)) return;
  try {
    const userId = req.trustedUserId;
    const instType = String(req.query.instType || 'SWAP');
    const instId = String(req.query.instId || '').trim() || undefined;
    const positions = await runAsUser(userId, () => getAccountPositions(instType, instId));
    res.json({ ...publicTradeStatus(userId), positions });
  } catch (err) {
    console.error('[GET /api/whale-ai/trade/positions]', err.message || err);
    sendErr(res, err);
  }
});

/** GET /api/whale-ai/trade/orders-pending */
router.get('/orders-pending', async (req, res) => {
  if (!assertTrustedOwner(req, res)) return;
  try {
    const userId = req.trustedUserId;
    const instType = String(req.query.instType || 'SWAP');
    const instId = String(req.query.instId || '').trim() || undefined;
    const orders = await runAsUser(userId, () => getPendingOrders(instType, instId));
    res.json({ ...publicTradeStatus(userId), orders });
  } catch (err) {
    console.error('[GET /api/whale-ai/trade/orders-pending]', err.message || err);
    sendErr(res, err);
  }
});

/** POST /api/whale-ai/trade/order — 开仓 / 加仓 / 减仓（reduceOnly） */
router.post('/order', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const userId = req.user.user.id;
    const body = req.body || {};
    const result = await runAsUser(userId, () => placeOrder(body));
    console.log(
      '[whale-ai/trade] order by',
      req.user?.user?.username || 'unknown',
      result.order?.ordId || result.order?.clOrdId || '',
    );
    res.json({ ok: true, ...publicTradeStatus(userId), ...result });
  } catch (err) {
    console.error('[POST /api/whale-ai/trade/order]', err.message || err);
    sendErr(res, err);
  }
});

/**
 * POST /api/whale-ai/trade/close — 市价全平 / 减仓
 * body: { instId, side?: buy|sell, posSide?: long|short, sz?, tdMode? }
 * 不传 sz 时按当前持仓数量全平。
 */
router.post('/close', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const userId = req.user.user.id;
    const body = req.body || {};
    const instId = String(body.instId || '').trim();
    if (!instId) {
      const err = new Error('缺少 instId');
      err.status = 400;
      throw err;
    }

    const result = await runAsUser(userId, async () => {
      let sz = String(body.sz ?? '').trim();
      let side = String(body.side || '').toLowerCase();
      let posSide = String(body.posSide || '').toLowerCase();
      const tdMode = String(body.tdMode || 'cross').toLowerCase();

      if (!sz || !(Number(sz) > 0) || (side !== 'buy' && side !== 'sell')) {
        const positions = await getAccountPositions('SWAP', instId);
        const match = (positions || []).find((p) => {
          const id = String(p.instId || '');
          if (id !== instId) return false;
          if (posSide === 'long' || posSide === 'short') {
            return String(p.posSide || '').toLowerCase() === posSide;
          }
          return true;
        });
        if (!match) {
          const err = new Error(`未找到持仓 ${instId}`);
          err.status = 404;
          throw err;
        }
        const pos = Number(match.pos || match.availPos || 0);
        if (!(Math.abs(pos) > 0)) {
          const err = new Error('持仓数量为 0');
          err.status = 400;
          throw err;
        }
        sz = String(Math.abs(pos));
        const matchPosSide = String(match.posSide || '').toLowerCase();
        if (matchPosSide === 'long' || matchPosSide === 'short') {
          posSide = matchPosSide;
          side = matchPosSide === 'long' ? 'sell' : 'buy';
        } else {
          // net 模式：pos>0 为多，平仓卖；pos<0 为空，平仓买
          side = pos > 0 ? 'sell' : 'buy';
          posSide = '';
        }
      }

      return placeOrder({
        instId,
        side,
        posSide: posSide || undefined,
        sz,
        tdMode,
        ordType: 'market',
        reduceOnly: true,
        clOrdId: body.clOrdId,
        tag: body.tag || 'whale-ai',
      });
    });

    console.log(
      '[whale-ai/trade] close by',
      req.user?.user?.username || 'unknown',
      instId,
      result.order?.ordId || '',
    );
    res.json({ ok: true, ...publicTradeStatus(userId), ...result });
  } catch (err) {
    console.error('[POST /api/whale-ai/trade/close]', err.message || err);
    sendErr(res, err);
  }
});

/** POST /api/whale-ai/trade/cancel */
router.post('/cancel', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const userId = req.user.user.id;
    const result = await runAsUser(userId, () => cancelOrder(req.body || {}));
    res.json({ ok: true, ...publicTradeStatus(userId), ...result });
  } catch (err) {
    console.error('[POST /api/whale-ai/trade/cancel]', err.message || err);
    sendErr(res, err);
  }
});

module.exports = router;
