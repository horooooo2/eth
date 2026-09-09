/**
 * 简易用户 / 会话 / 设置（SQLite，内用）
 */
const crypto = require('crypto');
const { getDb } = require('./db');

const SESSION_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000; // 约 10 年，内网长期登录

function newId(prefix = 'u') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  try {
    const next = crypto.scryptSync(String(password || ''), String(salt || ''), 64);
    const expected = Buffer.from(String(hash || ''), 'hex');
    if (expected.length !== next.length) return false;
    return crypto.timingSafeEqual(next, expected);
  } catch {
    return false;
  }
}

function normalizeUsername(name) {
  return String(name || '')
    .trim()
    .slice(0, 64);
}

function listUsers() {
  return getDb()
    .prepare('SELECT id, username, created_at AS createdAt FROM users ORDER BY created_at DESC')
    .all();
}

function createUser(username, password) {
  const name = normalizeUsername(username);
  if (!name || name.length < 2) {
    const err = new Error('用户名至少 2 个字符');
    err.status = 400;
    throw err;
  }
  if (!password || String(password).length < 4) {
    const err = new Error('密码至少 4 个字符');
    err.status = 400;
    throw err;
  }
  const exists = getDb().prepare('SELECT id FROM users WHERE username = ?').get(name);
  if (exists) {
    const err = new Error('用户名已存在');
    err.status = 409;
    throw err;
  }
  const { salt, hash } = hashPassword(password);
  const id = newId('user');
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO users (id, username, password_hash, password_salt, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, name, hash, salt, now);
  getDb()
    .prepare(
      `INSERT INTO user_settings (user_id, settings_json, updated_at) VALUES (?, '{}', ?)`,
    )
    .run(id, now);
  return { id, username: name, createdAt: now };
}

function findUserByUsername(username) {
  return getDb()
    .prepare(
      `SELECT id, username, password_hash AS passwordHash, password_salt AS passwordSalt, created_at AS createdAt
       FROM users WHERE username = ?`,
    )
    .get(normalizeUsername(username));
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  getDb()
    .prepare(
      `INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(token, userId, expiresAt, now);
  return { token, expiresAt };
}

function purgeExpiredSessions() {
  getDb().prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

function getSessionUser(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  purgeExpiredSessions();
  const row = getDb()
    .prepare(
      `SELECT s.token, s.expires_at AS expiresAt, u.id, u.username, u.created_at AS createdAt,
              COALESCE(u.role, 'user') AS role
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`,
    )
    .get(t);
  if (!row) return null;
  if (Number(row.expiresAt) < Date.now()) {
    getDb().prepare('DELETE FROM sessions WHERE token = ?').run(t);
    return null;
  }
  return {
    token: row.token,
    expiresAt: row.expiresAt,
    user: {
      id: row.id,
      username: row.username,
      createdAt: row.createdAt,
      role: row.role || 'user',
    },
  };
}

function destroySession(token) {
  const t = String(token || '').trim();
  if (!t) return;
  getDb().prepare('DELETE FROM sessions WHERE token = ?').run(t);
}

function login(username, password) {
  const user = findUserByUsername(username);
  if (!user || !verifyPassword(password, user.passwordSalt, user.passwordHash)) {
    const err = new Error('用户名或密码错误');
    err.status = 401;
    throw err;
  }
  const session = createSession(user.id);
  const settings = readSettings(user.id);
  return {
    token: session.token,
    expiresAt: session.expiresAt,
    user: { id: user.id, username: user.username, createdAt: user.createdAt },
    settings: settings.settings,
    settingsUpdatedAt: settings.updatedAt,
  };
}

function readSettings(userId) {
  const row = getDb()
    .prepare('SELECT settings_json AS json, updated_at AS updatedAt FROM user_settings WHERE user_id = ?')
    .get(userId);
  if (!row) return { settings: {}, updatedAt: 0 };
  let settings = {};
  try {
    settings = JSON.parse(row.json || '{}') || {};
  } catch {
    settings = {};
  }
  return { settings, updatedAt: Number(row.updatedAt) || 0 };
}

function writeSettings(userId, settings) {
  const now = Date.now();
  const json = JSON.stringify(settings && typeof settings === 'object' ? settings : {});
  getDb()
    .prepare(
      `INSERT INTO user_settings (user_id, settings_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
    )
    .run(userId, json, now);
  return { settings: JSON.parse(json), updatedAt: now };
}

function extractBearer(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || '';
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  if (req.query?.token) return String(req.query.token).trim();
  if (req.body?.token) return String(req.body.token).trim();
  return '';
}

function requireUser(req) {
  const session = getSessionUser(extractBearer(req));
  if (!session) {
    const err = new Error('未登录或登录已过期');
    err.status = 401;
    throw err;
  }
  return session;
}

function findUserById(id) {
  return getDb()
    .prepare(
      `SELECT id, username, password_hash AS passwordHash, password_salt AS passwordSalt, created_at AS createdAt
       FROM users WHERE id = ?`,
    )
    .get(String(id || ''));
}

function deleteUser(userId) {
  const id = String(userId || '');
  const user = findUserById(id);
  if (!user) {
    const err = new Error('用户不存在');
    err.status = 404;
    throw err;
  }
  const database = getDb();
  database.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  database.prepare('DELETE FROM user_settings WHERE user_id = ?').run(id);
  try {
    database.prepare('DELETE FROM user_exchange_keys WHERE user_id = ?').run(id);
  } catch {
    /* table may not exist on very old DBs mid-migrate */
  }
  database.prepare('DELETE FROM users WHERE id = ?').run(id);
  return { id, username: user.username };
}

function updateUserPassword(userId, password) {
  const id = String(userId || '');
  const user = findUserById(id);
  if (!user) {
    const err = new Error('用户不存在');
    err.status = 404;
    throw err;
  }
  if (!password || String(password).length < 4) {
    const err = new Error('密码至少 4 个字符');
    err.status = 400;
    throw err;
  }
  const { salt, hash } = hashPassword(password);
  getDb()
    .prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?')
    .run(hash, salt, id);
  // 改密后清掉该用户会话，需重新登录
  getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  return { id, username: user.username };
}

function canResumeEngine(session) {
  const user = session?.user;
  if (!user) return false;
  const role = String(user.role || 'user').toLowerCase();
  if (role === 'admin' || role === 'risk_admin') return true;
  const admins = String(process.env.V41_RESUME_ADMINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (admins.includes(String(user.username || '').toLowerCase())) return true;
  const ownerId = String(process.env.V41_ENGINE_OWNER_USER_ID || '').trim();
  if (ownerId && ownerId === String(user.id)) return true;
  // 若未配置管理员名单与 owner，则仅允许当前会话用户（个人站）
  if (!admins.length && !ownerId) return true;
  return false;
}

module.exports = {
  listUsers,
  createUser,
  deleteUser,
  updateUserPassword,
  login,
  getSessionUser,
  destroySession,
  readSettings,
  writeSettings,
  extractBearer,
  requireUser,
  canResumeEngine,
  SESSION_TTL_MS,
};
