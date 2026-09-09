/**
 * 用户 AI 提供商 API 密钥（SQLite）
 */
const { getDb } = require('./db');

const SUPPORTED = new Set(['deepseek']);
const DEFAULT_PROVIDER = 'deepseek';

function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 8) return `${k.slice(0, 2)}…`;
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

function normalizeProvider(provider) {
  const p = String(provider || DEFAULT_PROVIDER)
    .trim()
    .toLowerCase();
  return SUPPORTED.has(p) ? p : '';
}

function rowToPublic(row) {
  if (!row) {
    return {
      provider: DEFAULT_PROVIDER,
      configured: false,
      apiKeyHint: '',
      updatedAt: 0,
      ready: false,
    };
  }
  const apiKey = String(row.api_key || '').trim();
  const configured = Boolean(apiKey);
  return {
    provider: row.provider || DEFAULT_PROVIDER,
    configured,
    apiKeyHint: maskKey(apiKey),
    updatedAt: Number(row.updated_at) || 0,
    ready: configured,
  };
}

function getAiKeyStatus(userId, provider = DEFAULT_PROVIDER) {
  const uid = String(userId || '');
  const p = normalizeProvider(provider) || DEFAULT_PROVIDER;
  if (!uid) return rowToPublic(null);
  const row = getDb()
    .prepare(
      `SELECT user_id, provider, api_key, updated_at
       FROM user_ai_keys WHERE user_id = ? AND provider = ?`,
    )
    .get(uid, p);
  return rowToPublic(row || { provider: p, api_key: '', updated_at: 0 });
}

function getRawAiKey(userId, provider = DEFAULT_PROVIDER) {
  const uid = String(userId || '');
  const p = normalizeProvider(provider);
  if (!uid || !p) return null;
  const row = getDb()
    .prepare(
      `SELECT user_id, provider, api_key, updated_at
       FROM user_ai_keys WHERE user_id = ? AND provider = ?`,
    )
    .get(uid, p);
  const apiKey = String(row?.api_key || '').trim();
  if (!apiKey) return null;
  return { provider: p, apiKey, updatedAt: Number(row.updated_at) || 0 };
}

function upsertAiKey(userId, provider, apiKeyInput) {
  const uid = String(userId || '');
  const p = normalizeProvider(provider);
  if (!uid || !p) {
    const err = new Error('无效的用户或 AI 提供商');
    err.status = 400;
    throw err;
  }
  const apiKey = String(apiKeyInput || '').trim();
  if (!apiKey) {
    const err = new Error('请填写 DEEPSEEK_API_KEY');
    err.status = 400;
    throw err;
  }
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO user_ai_keys (user_id, provider, api_key, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, provider) DO UPDATE SET
         api_key = excluded.api_key,
         updated_at = excluded.updated_at`,
    )
    .run(uid, p, apiKey, now);
  return getAiKeyStatus(uid, p);
}

function deleteAiKey(userId, provider = DEFAULT_PROVIDER) {
  const uid = String(userId || '');
  const p = normalizeProvider(provider);
  if (!uid || !p) {
    const err = new Error('无效的用户或 AI 提供商');
    err.status = 400;
    throw err;
  }
  getDb().prepare('DELETE FROM user_ai_keys WHERE user_id = ? AND provider = ?').run(uid, p);
  return getAiKeyStatus(uid, p);
}

function isAiKeyReady(userId, provider = DEFAULT_PROVIDER) {
  return Boolean(getRawAiKey(userId, provider));
}

module.exports = {
  DEFAULT_PROVIDER,
  getAiKeyStatus,
  getRawAiKey,
  upsertAiKey,
  deleteAiKey,
  isAiKeyReady,
};
