/**
 * Public whale-ai engine routes → Python V4.1 internal API
 * Mounted at /api/whale-ai/engine
 */
const express = require('express');
const { requireUser, canResumeEngine } = require('../lib/authStore');
const v41 = require('../lib/v41EngineClient');
const { getOkxCredentialsForUser, isOkxReadyForUser } = require('../lib/userExchangeKeys');
const {
  getAccountPositions,
  placeOrder,
  withTradeCredentials,
} = require('../lib/okxTradeClient');
const { executeOrderIntent, cancelOrderIntent } = require('../lib/v41ExecutionGateway');

const router = express.Router();

function sendErr(res, err) {
  const status = Number(err.status) || 500;
  res.status(status).json({
    code: err.code || 'V41_ENGINE_ERROR',
    error: err.message || '引擎请求失败',
    message: err.message || '引擎请求失败',
    details: err.details || undefined,
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

function withFreshness(payload) {
  const bridge = v41.bridgeStatus();
  const available =
    bridge.freshness === 'LIVE' || bridge.freshness === 'STALE';
  return {
    ...payload,
    engineAvailable: available,
    bridge,
  };
}

router.get('/health', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const data = await v41.health();
    res.json(withFreshness({ ok: Boolean(data?.ok), health: data }));
  } catch (err) {
    if (
      err.code === 'V41_ENGINE_UNAVAILABLE' ||
      err.code === 'V41_ENGINE_TIMEOUT' ||
      err.code === 'V41_ENGINE_DISABLED'
    ) {
      return res.status(200).json(
        withFreshness({
          ok: false,
          health: { ok: false, state: 'OFFLINE', engine: 'v4.1', version: '4.1' },
          code: err.code,
          message: err.message,
        }),
      );
    }
    sendErr(res, err);
  }
});

router.get('/dashboard', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const snapshot = await v41.getSnapshot();
    const view = snapshot?.view || null;
    res.json(
      withFreshness({
        snapshot,
        view,
        // Flatten personal ViewModel fields for Vue convenience
        ...(view
          ? {
              engine: view.engine,
              active_strategy: view.active_strategy,
              market_risk: view.market_risk,
              signals: view.signals,
              recent_order_intents: view.recent_order_intents,
              last_update: view.last_update,
            }
          : {}),
      }),
    );
  } catch (err) {
    if (
      err.code === 'V41_ENGINE_UNAVAILABLE' ||
      err.code === 'V41_ENGINE_TIMEOUT' ||
      err.code === 'V41_ENGINE_DISABLED'
    ) {
      return res.status(200).json(
        withFreshness({
          snapshot: null,
          view: null,
          ok: false,
          code: err.code,
          message: err.message,
        }),
      );
    }
    sendErr(res, err);
  }
});

router.get('/regime', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    res.json(await v41.getRegime());
  } catch (err) {
    sendErr(res, err);
  }
});

router.get('/risk-budget', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    res.json(await v41.getRiskBudget());
  } catch (err) {
    sendErr(res, err);
  }
});

router.get('/strategy-health', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    res.json(await v41.getStrategyHealth());
  } catch (err) {
    sendErr(res, err);
  }
});

router.get('/trade-intents', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    res.json(await v41.getTradeIntents());
  } catch (err) {
    sendErr(res, err);
  }
});

router.get('/order-intents', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    res.json(await v41.getOrderIntents());
  } catch (err) {
    sendErr(res, err);
  }
});

router.get('/positions', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    res.json(await v41.getPositions());
  } catch (err) {
    sendErr(res, err);
  }
});

router.get('/incidents', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    res.json(await v41.getIncidents());
  } catch (err) {
    sendErr(res, err);
  }
});

router.post('/start', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    res.json(await v41.start());
  } catch (err) {
    sendErr(res, err);
  }
});

router.post('/pause', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    res.json(await v41.pause());
  } catch (err) {
    sendErr(res, err);
  }
});

router.post('/kill', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const userId = req.user.user.id;
    const operatorId = String(req.user.user.username || req.user.user.id);
    const engineResult = await v41.kill({
      reason: String(req.body?.reason || 'MANUAL_EMERGENCY_STOP'),
      operator_id: operatorId,
    });

    let closed = 0;
    const closeErrors = [];
    if (isOkxReadyForUser(userId)) {
      try {
        const creds = getOkxCredentialsForUser(userId);
        await withTradeCredentials(creds, async () => {
          const positions = await getAccountPositions('SWAP');
          for (const row of positions || []) {
            const instId = String(row.instId || '').trim();
            const pos = Number(row.pos || row.availPos || 0);
            if (!instId || !(Math.abs(pos) > 0)) continue;
            const posSide = String(row.posSide || '').toLowerCase();
            let side = 'sell';
            if (posSide === 'short' || pos < 0) side = 'buy';
            else if (posSide === 'long' || pos > 0) side = 'sell';
            try {
              await placeOrder({
                instId,
                side,
                ordType: 'market',
                sz: String(Math.abs(pos)),
                reduceOnly: true,
                posSide: posSide === 'long' || posSide === 'short' ? posSide : undefined,
              });
              closed += 1;
            } catch (e) {
              closeErrors.push(e.message || String(e));
            }
          }
        });
      } catch (e) {
        closeErrors.push(e.message || String(e));
      }
    }

    console.log('[V41_KILL_SWITCH] engine=%s closed=%s', engineResult?.state, closed);
    res.json({ ok: true, engine: engineResult, closed, closeErrors });
  } catch (err) {
    sendErr(res, err);
  }
});

router.post('/system/resume', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    if (!canResumeEngine(req.user)) {
      const err = new Error('无权限执行人工恢复（需要 risk_admin / owner）');
      err.status = 403;
      err.code = 'RESUME_FORBIDDEN';
      throw err;
    }
    const operatorId = String(req.user.user.username || req.user.user.id);
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 3) {
      const err = new Error('请填写恢复原因');
      err.status = 400;
      err.code = 'INVALID_REASON';
      throw err;
    }
    const result = await v41.resume({
      operator_id: operatorId,
      reason,
      incident_id: req.body?.incident_id || req.body?.incidentId || null,
    });
    res.json(result);
  } catch (err) {
    sendErr(res, err);
  }
});

/** Python → Node OrderIntent（internal token，非浏览器） */
router.post('/internal/order-intent', async (req, res) => {
  const token = String(req.headers['x-engine-token'] || '');
  const expected = String(process.env.V41_ENGINE_INTERNAL_TOKEN || 'dev-internal-token');
  if (!token || token !== expected) {
    return res.status(401).json({ code: 'UNAUTHORIZED', error: 'invalid engine token' });
  }
  try {
    const result = await executeOrderIntent(req.body || {});
    res.json(result);
  } catch (err) {
    sendErr(res, err);
  }
});

/** Python → Node cancel opening order on strategy switch */
router.post('/internal/cancel-order', async (req, res) => {
  const token = String(req.headers['x-engine-token'] || '');
  const expected = String(process.env.V41_ENGINE_INTERNAL_TOKEN || 'dev-internal-token');
  if (!token || token !== expected) {
    return res.status(401).json({ code: 'UNAUTHORIZED', error: 'invalid engine token' });
  }
  try {
    const result = await cancelOrderIntent(req.body || {});
    res.json(result);
  } catch (err) {
    sendErr(res, err);
  }
});

router.post('/active-strategy', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const strategyId = String(req.body?.strategy_id || req.body?.strategyId || '').trim();
    const operatorId = String(req.user.user.username || req.user.user.id);
    const result = await v41.switchStrategy({
      strategy_id: strategyId,
      reason: 'manual_user_switch',
      operator_id: operatorId,
    });
    res.json(result);
  } catch (err) {
    sendErr(res, err);
  }
});

router.get('/strategy/active', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    res.json(await v41.getActiveStrategy());
  } catch (err) {
    sendErr(res, err);
  }
});

router.get('/strategies', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    res.json(await v41.listStrategies());
  } catch (err) {
    sendErr(res, err);
  }
});

router.post('/strategy/switch', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const strategyId = String(req.body?.strategy_id || req.body?.strategyId || '').trim();
    if (!strategyId) {
      const err = new Error('strategy_id required');
      err.status = 400;
      err.code = 'INVALID_STRATEGY';
      throw err;
    }
    const operatorId = String(req.user.user.username || req.user.user.id);
    const result = await v41.switchStrategy({
      strategy_id: strategyId,
      reason: String(req.body?.reason || 'manual_user_switch'),
      operator_id: operatorId,
    });
    res.json(result);
  } catch (err) {
    sendErr(res, err);
  }
});

router.get('/bridge-status', (req, res) => {
  if (!assertLogin(req, res)) return;
  res.json(v41.bridgeStatus());
});

function assertHftSimEnv(res) {
  const on = String(process.env.V41_HFT_SIM_ENABLED || 'false').toLowerCase() === 'true'
    || String(process.env.V41_HFT_SIM_ENABLED || '') === '1';
  if (!on) {
    res.status(403).json({ code: 'HFT_SIM_DISABLED', error: 'QA-HFT-SIM disabled' });
    return false;
  }
  return true;
}

router.post('/test/hft-sim/start', async (req, res) => {
  if (!assertLogin(req, res)) return;
  if (!assertHftSimEnv(res)) return;
  try {
    res.json(await v41.hftSimStart(req.body || {}));
  } catch (err) {
    sendErr(res, err);
  }
});

router.post('/test/hft-sim/stop', async (req, res) => {
  if (!assertLogin(req, res)) return;
  if (!assertHftSimEnv(res)) return;
  try {
    res.json(await v41.hftSimStop());
  } catch (err) {
    sendErr(res, err);
  }
});

router.get('/test/hft-sim/status', async (req, res) => {
  if (!assertLogin(req, res)) return;
  if (!assertHftSimEnv(res)) return;
  try {
    res.json(await v41.hftSimStatus());
  } catch (err) {
    sendErr(res, err);
  }
});

router.get('/test/hft-sim/report', async (req, res) => {
  if (!assertLogin(req, res)) return;
  if (!assertHftSimEnv(res)) return;
  try {
    res.json(await v41.hftSimReport());
  } catch (err) {
    sendErr(res, err);
  }
});

router.get('/whale-bridge/status', (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const { whaleBridgeStatus } = require('../lib/v41WhaleDataBridge');
    res.json(whaleBridgeStatus());
  } catch (err) {
    sendErr(res, err);
  }
});

router.get('/whale-bridge/telemetry', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    res.json(await v41.whaleTelemetry());
  } catch (err) {
    sendErr(res, err);
  }
});

router.post('/whale-bridge/forward-once', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const { forwardOnce } = require('../lib/v41WhaleDataBridge');
    res.json(await forwardOnce());
  } catch (err) {
    sendErr(res, err);
  }
});

module.exports = router;
