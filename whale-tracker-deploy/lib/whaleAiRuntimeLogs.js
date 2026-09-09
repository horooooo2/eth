/**
 * Per-user whale-AI console runtime logs (SQLite), keep latest 1000.
 */
const { getDb } = require('./db');

const MAX_PER_USER = 1000;
const ALLOWED_LVL = new Set(['info', 'success', 'warn', 'error']);

function normalizeLvl(lvl) {
  const v = String(lvl || 'info').toLowerCase();
  return ALLOWED_LVL.has(v) ? v : 'info';
}

function clipMsg(msg) {
  const s = String(msg || '').trim();
  if (!s) return '';
  return s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
}

function appendRuntimeLog(userId, { lvl, msg, source, ts } = {}) {
  const uid = String(userId || '').trim();
  if (!uid) {
    const err = new Error('missing user_id');
    err.status = 400;
    throw err;
  }
  const text = clipMsg(msg);
  if (!text) {
    const err = new Error('日志内容不能为空');
    err.status = 400;
    throw err;
  }
  const level = normalizeLvl(lvl);
  const at = Number(ts) > 0 ? Number(ts) : Date.now();
  const src = String(source || 'ui').slice(0, 32);

  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO whale_ai_runtime_logs (user_id, ts, lvl, msg, source)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(uid, at, level, text, src);

  // Keep newest MAX_PER_USER rows per user
  db.prepare(
    `DELETE FROM whale_ai_runtime_logs
     WHERE user_id = ?
       AND id NOT IN (
         SELECT id FROM whale_ai_runtime_logs
         WHERE user_id = ?
         ORDER BY ts DESC, id DESC
         LIMIT ?
       )`,
  ).run(uid, uid, MAX_PER_USER);

  return {
    id: Number(info.lastInsertRowid),
    ts: at,
    lvl: level,
    msg: text,
    source: src,
  };
}

function listRuntimeLogs(userId, { limit = MAX_PER_USER } = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return [];
  const lim = Math.min(MAX_PER_USER, Math.max(1, Number(limit) || MAX_PER_USER));
  // Newest N, returned chronological (oldest → newest) for console display
  const newest = getDb()
    .prepare(
      `SELECT id, ts, lvl, msg, source
       FROM whale_ai_runtime_logs
       WHERE user_id = ?
       ORDER BY ts DESC, id DESC
       LIMIT ?`,
    )
    .all(uid, lim);
  return newest.reverse();
}

function deleteRuntimeLogsForUser(userId) {
  const uid = String(userId || '').trim();
  if (!uid) return 0;
  const info = getDb().prepare('DELETE FROM whale_ai_runtime_logs WHERE user_id = ?').run(uid);
  return Number(info.changes) || 0;
}

module.exports = {
  MAX_PER_USER,
  appendRuntimeLog,
  listRuntimeLogs,
  deleteRuntimeLogsForUser,
};
