/**
 * Public whale-ai engine routes → Python V4.1 internal API
 * Mounted at /api/whale-ai/engine
 */
const express = require('express');
const { requireUser, canResumeEngine } = require('../lib/authStore');
const v41 = require('../lib/v41EngineClient');
const { executeOrderIntent, cancelOrderIntent } = require('../lib/v41ExecutionGateway');
const { getOkxCredentialsForUser } = require('../lib/userExchangeKeys');
const alphaGate = require('../lib/v41AlphaLiveGate');
const userBinding = require('../lib/v41UserBinding');
const runtimeEvents = require('../lib/v41RuntimeEvents');

async function bindSessionUser(req) {
  const userId = String(req.user?.user?.id || '').trim();
  if (!userId) return { user_id_ready: false };
  userBinding.bindEngineOwner(userId);
  try {
    return await v41.bindUser(userId);
  } catch (err) {
    console.warn('[V41_BIND_USER_FAILED]', err.message || err);
    return { ok: false, user_id: userId, user_id_ready: true, bind_error: err.message };
  }
}

function attachAccountEnvironment(snapshot, userId) {
  const creds = userId ? getOkxCredentialsForUser(userId) : null;
  const account_environment = alphaGate.resolveAccountEnvironment(creds);
  const live_permission = alphaGate.liveTradingEnabled();
  if (!snapshot || typeof snapshot !== 'object') {
    return { account_environment, live_permission, user_id_ready: Boolean(userId) };
  }
  snapshot.account_environment = account_environment;
  snapshot.live_permission = live_permission;
  snapshot.user_id_ready = Boolean(userId);
  if (snapshot.view && typeof snapshot.view === 'object') {
    snapshot.view.account_environment = account_environment;
    snapshot.view.live_permission = live_permission;
    snapshot.view.user_id_ready = Boolean(userId);
    if (snapshot.view.engine && typeof snapshot.view.engine === 'object') {
      snapshot.view.engine.alpha_execution = snapshot.alpha_execution || snapshot.view.engine.alpha_execution;
      delete snapshot.view.engine.mode;
    }
  }
  return snapshot;
}

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
  const runtime = String(bridge.engine_runtime_status || bridge.freshness || '').toUpperCase();
  const available =
    bridge.transport_status === 'CONNECTED' &&
    runtime !== 'OFFLINE' &&
    runtime !== 'DISABLED' &&
    runtime !== 'NEVER' &&
    runtime !== 'UNKNOWN';
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
    const sessionId = String(req.user.user.id);
    if (userBinding.getBoundEngineOwner() !== sessionId) {
      await bindSessionUser(req);
    }
    const snapshot = attachAccountEnvironment(await v41.getSnapshot(), sessionId);
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
    await bindSessionUser(req);
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
    const operatorId = String(req.user.user.username || req.user.user.id);
    // Engine lock only — do NOT synchronously flatten all OKX positions (timeout + wrong-account risk).
    const engineResult = await v41.kill({
      reason: String(req.body?.reason || 'MANUAL_EMERGENCY_STOP'),
      operator_id: operatorId,
    });
    console.log('[V41_KILL_SWITCH] engine=%s', engineResult?.state);
    res.json({ ok: true, engine: engineResult, closed: 0, closeErrors: [] });
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
    const result = await executeOrderIntent(req.body || {}, {
      sessionUserId: userBinding.getBoundEngineOwner(),
    });
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

/** QA capability + account mode (demo/live from user.simulated) */
router.get('/test/hft-sim/capability', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const qaEx = require('../lib/v41QaExchange');
    const userId = String(req.user.user.id);
    const cap = qaEx.resolveQaCapability(userId);
    // Also merge Python enabled flag
    let py = {};
    try {
      py = await v41.hftSimStatus();
    } catch {
      py = { enabled: false, engine_available: false };
    }
    res.json({
      ...cap,
      enabled: Boolean(py.enabled ?? cap.hft_sim_enabled),
      engine_available: py.engine_available !== false,
      python_env_resolved: py.env_resolved,
    });
  } catch (err) {
    sendErr(res, err);
  }
});

router.post('/internal/qa/ensure-leverage', async (req, res) => {
  const token = String(req.headers['x-engine-token'] || '');
  const expected = String(process.env.V41_ENGINE_INTERNAL_TOKEN || 'dev-internal-token');
  if (!token || token !== expected) {
    return res.status(401).json({ code: 'UNAUTHORIZED', error: 'invalid engine token' });
  }
  try {
    const qaEx = require('../lib/v41QaExchange');
    const userId = String(
      req.body?.user_id || process.env.V41_ENGINE_OWNER_USER_ID || '',
    ).trim();
    if (!userId) {
      return res.status(400).json({
        code: 'USER_ID_REQUIRED',
        error: 'qa ensure-leverage requires user_id (per-user OKX keys)',
      });
    }
    const result = await qaEx.ensureLeverage(userId, {
      instId: String(req.body?.instId || req.body?.symbol || 'BTC-USDT-SWAP'),
      lever: Number(req.body?.lever || req.body?.target_leverage || 3),
      mgnMode: String(req.body?.mgnMode || 'cross'),
    });
    res.json(result);
  } catch (err) {
    sendErr(res, err);
  }
});

router.get('/internal/qa/position', async (req, res) => {
  const token = String(req.headers['x-engine-token'] || '');
  const expected = String(process.env.V41_ENGINE_INTERNAL_TOKEN || 'dev-internal-token');
  if (!token || token !== expected) {
    return res.status(401).json({ code: 'UNAUTHORIZED', error: 'invalid engine token' });
  }
  try {
    const qaEx = require('../lib/v41QaExchange');
    const userId = String(
      req.query?.user_id || process.env.V41_ENGINE_OWNER_USER_ID || '',
    ).trim();
    if (!userId) {
      return res.status(400).json({
        code: 'USER_ID_REQUIRED',
        error: 'qa position requires user_id (per-user OKX keys)',
      });
    }
    const instId = String(req.query?.instId || req.query?.symbol || 'BTC-USDT-SWAP');
    const snap = await qaEx.fetchQaPosition(userId, instId);
    res.json({ ok: true, user_id: userId, ...snap });
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

router.get('/strategy/:id/diagnostics', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const data = await v41.getStrategyDiagnostics(req.params.id);
    res.json(withFreshness(data));
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

/** Python is truth source for HFT enabled — do not gate on Node-only env.
 *  demo/live must come from server-side OKX keys (user.simulated), never browser forge.
 */
router.post('/test/hft-sim/start', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    const body = { ...(req.body || {}) };
    const mode = String(body.execution_mode || 'simulator').toLowerCase();
    // Strip client-forged account fields
    delete body.account_mode;
    delete body.live_money;
    delete body.exchange_environment;
    delete body.user_id; // always from session — never trust browser

    if (mode === 'exchange') {
      const qaEx = require('../lib/v41QaExchange');
      const userId = String(req.user.user.id);
      const cap = qaEx.resolveQaCapability(userId);
      if (!cap.exchange_available) {
        const err = new Error(
          cap.account_mode === 'OKX_LIVE' && !cap.qa_live_enabled
            ? 'QA live trading disabled'
            : !cap.qa_exchange_enabled
              ? 'QA exchange path disabled'
              : 'OKX credentials not ready for QA',
        );
        err.status = 403;
        err.code =
          cap.account_mode === 'OKX_LIVE' && !cap.qa_live_enabled
            ? 'QA_LIVE_TRADING_DISABLED'
            : !cap.qa_exchange_enabled
              ? 'QA_EXCHANGE_DISABLED'
              : 'OKX_NOT_READY';
        err.details = cap;
        throw err;
      }
      body.execution_mode = 'exchange';
      body.exchange_environment = cap.exchange_environment; // demo | live from DB
      body.user_id = userId; // per-user OKX keys for QA position / orders
      body.continuous = true; // strategy-like: run until stop, ignore P&L scoring
      body.symbol = 'BTC-USDT-SWAP';
      body.max_position_notional_usdt = Math.min(Number(body.max_position_notional_usdt || 50), 50);
      body.inject_failures = false;
    } else {
      body.execution_mode = 'simulator';
      body.exchange_environment = null;
      body.user_id = String(req.user.user.id);
    }
    res.json(await v41.hftSimStart(body));
  } catch (err) {
    sendErr(res, err);
  }
});

router.post('/test/hft-sim/stop', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    res.json(await v41.hftSimStop());
  } catch (err) {
    sendErr(res, err);
  }
});

router.get('/test/hft-sim/status', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    res.json(await v41.hftSimStatus());
  } catch (err) {
    sendErr(res, err);
  }
});

router.get('/test/hft-sim/report', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    res.json(await v41.hftSimReport());
  } catch (err) {
    sendErr(res, err);
  }
});

router.get('/execution/selections', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    res.json(await v41.executionSelections());
  } catch (err) {
    sendErr(res, err);
  }
});

router.post('/execution/select', async (req, res) => {
  if (!assertLogin(req, res)) return;
  try {
    await bindSessionUser(req);
    const body = {
      ...(req.body || {}),
      operator_id: String(req.user?.user?.username || req.user?.user?.id || 'system'),
    };
    res.json(await v41.executionSelect(body));
  } catch (err) {
    sendErr(res, err);
  }
});

router.get('/events', async (req, res) => {
  if (!assertLogin(req, res)) return;
  const filters = {
    limit: req.query.limit,
    before: req.query.before,
    after: req.query.after,
    before_event_id: req.query.before_event_id,
    after_event_id: req.query.after_event_id,
    strategy_id: req.query.strategy_id,
    symbol: req.query.symbol,
    event_type: req.query.event_type,
    severity: req.query.severity,
  };
  let python = [];
  let pythonError = '';
  try {
    const data = await v41.listRuntimeEvents(filters);
    python = Array.isArray(data?.events) ? data.events : [];
  } catch (err) {
    pythonError = err.message || 'python events unavailable';
  }
  const node = runtimeEvents.list(filters);
  const events = runtimeEvents.mergeEvents(python, node, filters);
  res.json({
    ok: true,
    source: 'SERVER',
    count: events.length,
    limit: Math.max(1, Math.min(Number(filters.limit) || 200, 500)),
    python_count: python.length,
    node_count: node.length,
    python_error: pythonError || undefined,
    events,
  });
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
