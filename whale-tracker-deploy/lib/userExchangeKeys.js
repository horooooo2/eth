/**
 * 用户交易所 API 密钥（SQLite）
 */
const { getDb } = require('./db');

const SUPPORTED = new Set(['okx', 'binance']);

function normalizeExchange(exchange) {
  const e = String(exchange || '')
    .trim()
    .toLowerCase();
  return SUPPORTED.has(e) ? e : '';
}

function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 8) return `${k.slice(0, 2)}…`;
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

function rowToPublic(row) {
  if (!row) return null;
  const exchange = row.exchange;
  const configured =
    exchange === 'okx'
      ? Boolean(row.api_key && row.api_secret && row.api_passphrase)
      : Boolean(row.api_key && row.api_secret);
  return {
    exchange,
    configured,
    enabled: Boolean(row.enabled),
    simulated: Boolean(row.simulated),
    apiKeyHint: maskKey(row.api_key),
    hasSecret: Boolean(row.api_secret),
    hasPassphrase: Boolean(row.api_passphrase),
    updatedAt: Number(row.updated_at) || 0,
    ready: exchange === 'okx' ? configured && Boolean(row.enabled) : false,
    status: exchange === 'binance' ? 'pending' : configured ? 'ready' : 'missing',
  };
}

function listExchangeKeys(userId) {
  const uid = String(userId || '');
  const rows = getDb()
    .prepare(
      `SELECT user_id, exchange, api_key, api_secret, api_passphrase, simulated, enabled, updated_at
       FROM user_exchange_keys WHERE user_id = ?`,
    )
    .all(uid);
  const byEx = new Map(rows.map((r) => [r.exchange, r]));
  return {
    okx: rowToPublic(
      byEx.get('okx') || {
        exchange: 'okx',
        api_key: '',
        api_secret: '',
        api_passphrase: '',
        simulated: 1,
        enabled: 1,
        updated_at: 0,
      },
    ),
    binance: rowToPublic(
      byEx.get('binance') || {
        exchange: 'binance',
        api_key: '',
        api_secret: '',
        api_passphrase: '',
        simulated: 1,
        enabled: 0,
        updated_at: 0,
      },
    ),
  };
}

function getExchangeKeysRaw(userId, exchange) {
  const uid = String(userId || '');
  const ex = normalizeExchange(exchange);
  if (!uid || !ex) return null;
  return (
    getDb()
      .prepare(
        `SELECT user_id, exchange, api_key, api_secret, api_passphrase, simulated, enabled, updated_at
         FROM user_exchange_keys WHERE user_id = ? AND exchange = ?`,
      )
      .get(uid, ex) || null
  );
}

/** 供下单使用的凭证对象；未配置返回 null */
function getOkxCredentialsForUser(userId) {
  const row = getExchangeKeysRaw(userId, 'okx');
  if (!row || !row.enabled) return null;
  const apiKey = String(row.api_key || '').trim();
  const secret = String(row.api_secret || '').trim();
  const passphrase = String(row.api_passphrase || '').trim();
  if (!apiKey || !secret || !passphrase) return null;
  return {
    apiKey,
    secret,
    passphrase,
    simulated: Boolean(row.simulated),
  };
}

function upsertExchangeKeys(userId, exchange, input = {}) {
  const uid = String(userId || '');
  const ex = normalizeExchange(exchange);
  if (!uid || !ex) {
    const err = new Error('无效的用户或交易所');
    err.status = 400;
    throw err;
  }
  if (ex === 'binance') {
    const err = new Error('币安交易暂不支持');
    err.status = 400;
    throw err;
  }

  const apiKey = String(input.apiKey ?? input.api_key ?? '').trim();
  const apiSecret = String(input.apiSecret ?? input.api_secret ?? '').trim();
  const apiPassphrase = String(input.apiPassphrase ?? input.api_passphrase ?? '').trim();
  if (!apiKey || !apiSecret || !apiPassphrase) {
    const err = new Error('请填写 OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE');
    err.status = 400;
    throw err;
  }

  const simulated =
    input.simulated === false || input.simulated === 0 || input.simulated === '0' ? 0 : 1;
  const enabled = input.enabled === false || input.enabled === 0 || input.enabled === '0' ? 0 : 1;
  const now = Date.now();

  getDb()
    .prepare(
      `INSERT INTO user_exchange_keys
        (user_id, exchange, api_key, api_secret, api_passphrase, simulated, enabled, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, exchange) DO UPDATE SET
         api_key = excluded.api_key,
         api_secret = excluded.api_secret,
         api_passphrase = excluded.api_passphrase,
         simulated = excluded.simulated,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
    )
    .run(uid, ex, apiKey, apiSecret, apiPassphrase, simulated, enabled, now);

  return listExchangeKeys(uid);
}

function deleteExchangeKeys(userId, exchange) {
  const uid = String(userId || '');
  const ex = normalizeExchange(exchange);
  if (!uid || !ex) {
    const err = new Error('无效的用户或交易所');
    err.status = 400;
    throw err;
  }
  getDb().prepare('DELETE FROM user_exchange_keys WHERE user_id = ? AND exchange = ?').run(uid, ex);
  return listExchangeKeys(uid);
}

function isOkxReadyForUser(userId) {
  return Boolean(getOkxCredentialsForUser(userId));
}

module.exports = {
  listExchangeKeys,
  getExchangeKeysRaw,
  getOkxCredentialsForUser,
  upsertExchangeKeys,
  deleteExchangeKeys,
  isOkxReadyForUser,
  maskKey,
};
