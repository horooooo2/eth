/**
 * Trusted Alpha user_id: session or owner binding.
 * Never trust browser / OrderIntent body.user_id.
 */

let boundEngineUserId = '';

function bindEngineOwner(userId) {
  boundEngineUserId = String(userId || '').trim();
  return boundEngineUserId;
}

function clearBoundEngineOwner() {
  boundEngineUserId = '';
}

function getBoundEngineOwner() {
  return boundEngineUserId;
}

function ownerEnvUserId() {
  return String(process.env.V41_ENGINE_OWNER_USER_ID || '').trim();
}

/**
 * @param {{ sessionUserId?: string }} [auth]
 * @returns {string}
 */
function resolveTrustedUserId(auth = {}) {
  const session = String(auth.sessionUserId || '').trim();
  if (session) return session;
  if (boundEngineUserId) return boundEngineUserId;
  return ownerEnvUserId();
}

function assertExecuteUserReady(userId) {
  if (String(userId || '').trim()) return { user_id: String(userId).trim() };
  const err = new Error('EXECUTE requires authenticated user_id');
  err.status = 403;
  err.code = 'ALPHA_EXECUTION_USER_NOT_READY';
  err.details = { user_id_ready: false };
  throw err;
}

module.exports = {
  bindEngineOwner,
  clearBoundEngineOwner,
  getBoundEngineOwner,
  ownerEnvUserId,
  resolveTrustedUserId,
  assertExecuteUserReady,
};
