/**
 * Read-only OKX trade fee for the bound engine owner.
 * Never trusts query / body / frontend user_id.
 */
const userBinding = require('./v41UserBinding');
const { getOkxCredentialsForUser } = require('./userExchangeKeys');
const alphaGate = require('./v41AlphaLiveGate');
const okxTrade = require('./okxTradeClient');

async function fetchTrustedOwnerTradeFee(options = {}) {
  const ignored = String(options.queryUserId || options.bodyUserId || '').trim();
  const ownerId =
    options.ownerId || userBinding.getBoundEngineOwner() || userBinding.ownerEnvUserId();
  if (!ownerId) {
    const err = new Error('trusted owner unavailable');
    err.status = 403;
    err.code = 'S9_COST_DATA_UNAVAILABLE';
    err.details = { ignored_query_user_id: ignored || undefined };
    throw err;
  }
  const getCreds = options.getCreds || getOkxCredentialsForUser;
  const creds = getCreds(ownerId);
  if (!creds) {
    const err = new Error('okx credential unavailable');
    err.status = 503;
    err.code = 'S9_COST_DATA_UNAVAILABLE';
    err.details = { owner_bound: true };
    throw err;
  }
  const instId = String(options.instId || 'BTC-USDT-SWAP').trim() || 'BTC-USDT-SWAP';
  const withCreds = options.withTradeCredentials || okxTrade.withTradeCredentials;
  const getFee = options.getTradeFee || okxTrade.getTradeFee;
  const fee = await withCreds(creds, () => getFee({ instId, instType: 'SWAP' }));
  if (!fee || !Number.isFinite(Number(fee.taker_bps)) || Number(fee.taker_bps) <= 0) {
    const err = new Error('fee response invalid');
    err.status = 502;
    err.code = 'S9_COST_DATA_UNAVAILABLE';
    throw err;
  }
  const resolveEnv = options.resolveEnv || alphaGate.resolveAccountEnvironment;
  return {
    ok: true,
    instId: fee.instId || instId,
    taker: fee.taker,
    maker: fee.maker,
    taker_bps: fee.taker_bps,
    maker_bps: fee.maker_bps,
    source: 'okx_account_trade_fee',
    updated_at: new Date().toISOString(),
    owner_bound: true,
    owner_id: ownerId,
    account_environment: resolveEnv(creds),
    ignored_query_user_id: ignored || undefined,
    simulated: creds.simulated,
  };
}

module.exports = { fetchTrustedOwnerTradeFee };
