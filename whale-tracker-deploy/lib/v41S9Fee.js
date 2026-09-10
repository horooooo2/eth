/**
 * Read-only OKX trade fee for the bound engine owner.
 * Never trusts query / body / frontend user_id.
 */
require('./s9Capabilities');
const userBinding = require('./v41UserBinding');
const { getOkxCredentialsForUser } = require('./userExchangeKeys');
const alphaGate = require('./v41AlphaLiveGate');
const okxTrade = require('./okxTradeClient');

function feeFail(code, message, status, details) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.reason = 'S9_COST_DATA_UNAVAILABLE';
  err.details = details;
  return err;
}

function isTimeoutError(err) {
  const code = String(err && err.code ? err.code : '');
  const msg = String(err && err.message ? err.message : '');
  return (
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    code === 'FEE_API_TIMEOUT' ||
    /timeout/i.test(msg)
  );
}

async function fetchTrustedOwnerTradeFee(options = {}) {
  const ignored = String(options.queryUserId || options.bodyUserId || '').trim();
  const ownerId =
    options.ownerId || userBinding.getBoundEngineOwner() || userBinding.ownerEnvUserId();
  if (!ownerId) {
    throw feeFail('OWNER_NOT_READY', 'trusted owner unavailable', 403, {
      ignored_query_user_id: ignored || undefined,
      bound_engine_owner: userBinding.getBoundEngineOwner() || null,
      owner_env_user_id: userBinding.ownerEnvUserId() || null,
    });
  }
  const getCreds = options.getCreds || getOkxCredentialsForUser;
  const creds = getCreds(ownerId);
  if (!creds) {
    throw feeFail('CREDENTIAL_NOT_FOUND', 'okx credential unavailable', 503, {
      owner_bound: true,
      owner_id: ownerId,
    });
  }
  const resolveEnv = options.resolveEnv || alphaGate.resolveAccountEnvironment;
  const accountEnvironment = resolveEnv(creds);
  if (accountEnvironment !== 'OKX_DEMO') {
    throw feeFail('ACCOUNT_ENV_NOT_READY', `account env ${accountEnvironment}`, 403, {
      owner_bound: true,
      owner_id: ownerId,
      account_environment: accountEnvironment,
      simulated: creds.simulated,
    });
  }
  const instId = String(options.instId || 'BTC-USDT-SWAP').trim() || 'BTC-USDT-SWAP';
  const withCreds = options.withTradeCredentials || okxTrade.withTradeCredentials;
  const getFee = options.getTradeFee || okxTrade.getTradeFee;
  let fee;
  try {
    fee = await withCreds(creds, () => getFee({ instId, instType: 'SWAP' }));
  } catch (err) {
    if (isTimeoutError(err)) {
      throw feeFail('FEE_API_TIMEOUT', err.message || 'fee api timeout', 504, {
        owner_id: ownerId,
        okx_path: '/api/v5/account/trade-fee',
      });
    }
    throw feeFail('FEE_API_ERROR', err.message || 'fee api failed', Number(err.status) || 502, {
      owner_id: ownerId,
      account_environment: accountEnvironment,
      okx_path: '/api/v5/account/trade-fee',
      okx_code: err.code || undefined,
    });
  }
  if (!fee || !Number.isFinite(Number(fee.taker_bps)) || Number(fee.taker_bps) <= 0) {
    throw feeFail('FEE_RESPONSE_INVALID', 'fee response invalid', 502, {
      owner_id: ownerId,
      instId,
      account_environment: accountEnvironment,
    });
  }
  return {
    ok: true,
    instId: fee.instId || instId,
    taker: fee.taker,
    maker: fee.maker,
    taker_bps: fee.taker_bps,
    maker_bps: fee.maker_bps,
    source: 'okx_account_trade_fee',
    fee_source: 'okx_account_trade_fee',
    updated_at: new Date().toISOString(),
    owner_bound: true,
    owner_id: ownerId,
    account_environment: accountEnvironment,
    ignored_query_user_id: ignored || undefined,
    simulated: creds.simulated,
    http_status: fee.http_status || 200,
    okx_code: fee.okx_code || '0',
    fee_ready: true,
  };
}

module.exports = { fetchTrustedOwnerTradeFee };
