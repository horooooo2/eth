/**
 * Alpha Live dual gate + account environment.
 * Truth for Demo/Live: user_exchange_keys.simulated (via creds.simulated).
 * QA live uses V41_QA_LIVE_ENABLED and must stay independent.
 */

function truthy(v) {
  return ['1', 'true', 'yes', 'on'].includes(String(v || '').trim().toLowerCase());
}

function liveTradingEnabled() {
  return truthy(process.env.V41_LIVE_TRADING_ENABLED);
}

function resolveAccountEnvironment(creds) {
  if (!creds) return null;
  return creds.simulated ? 'OKX_DEMO' : 'OKX_LIVE';
}

function strategyLiveAllowed(orderIntent) {
  if (orderIntent && orderIntent.live_allowed === false) return false;
  const sid = String(orderIntent?.origin_strategy_id || orderIntent?.strategy_id || '')
    .trim()
    .toUpperCase();
  if (sid === 'S8') return false;
  if (sid === 'S1' || sid === 'S2') return orderIntent?.live_allowed !== false;
  return orderIntent?.live_allowed === true;
}

function normalizeIncomingAlpha(orderIntent) {
  const body = orderIntent && typeof orderIntent === 'object' ? orderIntent : {};
  const raw = String(body.alpha_execution || body.execution_mode || '').trim();
  const upper = raw.toUpperCase();
  const lower = raw.toLowerCase();
  let deprecated = false;
  if (lower === 'paper') {
    body.shadow = true;
    body.alpha_execution = 'SHADOW';
    deprecated = true;
  } else if (upper === 'SHADOW' || lower === 'node_gateway_shadow') {
    body.shadow = true;
    body.alpha_execution = 'SHADOW';
  } else if (upper === 'EXECUTE' || lower === 'node_gateway') {
    body.alpha_execution = 'EXECUTE';
  }
  return {
    orderIntent: body,
    deprecated,
    replacement: deprecated ? 'SHADOW' : null,
  };
}

function isAlphaShadow(orderIntent) {
  if (orderIntent && orderIntent.shadow === true) return true;
  if (String(orderIntent?.alpha_execution || '').toUpperCase() === 'SHADOW') return true;
  const alpha = String(process.env.V41_ALPHA_EXECUTION || '').trim().toUpperCase();
  if (alpha === 'SHADOW') return true;
  if (alpha === 'EXECUTE') return false;
  const legacy = String(process.env.V41_ENGINE_EXECUTION_MODE || '').trim().toLowerCase();
  if (legacy === 'node_gateway') return false;
  return true;
}

function assertAlphaLiveExecution(orderIntent, creds) {
  const accountEnvironment = resolveAccountEnvironment(creds);
  if (accountEnvironment !== 'OKX_LIVE') {
    return { accountEnvironment: accountEnvironment || 'OKX_DEMO', allowed: true };
  }
  if (!liveTradingEnabled()) {
    const err = new Error('OKX Live key does not authorize live trading');
    err.status = 403;
    err.code = 'LIVE_EXECUTION_NOT_AUTHORIZED';
    err.details = {
      account_environment: 'OKX_LIVE',
      live_permission: false,
      env_key: 'V41_LIVE_TRADING_ENABLED',
    };
    throw err;
  }
  if (!strategyLiveAllowed(orderIntent)) {
    const err = new Error('strategy is not allowed to trade live');
    err.status = 403;
    err.code = 'STRATEGY_LIVE_NOT_ALLOWED';
    err.details = {
      account_environment: 'OKX_LIVE',
      live_permission: true,
      strategy_id: orderIntent?.origin_strategy_id || orderIntent?.strategy_id || null,
      live_allowed: false,
    };
    throw err;
  }
  return { accountEnvironment: 'OKX_LIVE', allowed: true };
}

module.exports = {
  truthy,
  liveTradingEnabled,
  resolveAccountEnvironment,
  strategyLiveAllowed,
  normalizeIncomingAlpha,
  isAlphaShadow,
  assertAlphaLiveExecution,
};
