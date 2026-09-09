/**
 * Per-user whale-AI console runtime logs (SQLite).
 * Two channels: SYSTEM | POSITION. Persist newest 300 per channel.
 */
const { getDb } = require('./db');

const MAX_PER_CHANNEL = 300;
const ALLOWED_LVL = new Set(['info', 'success', 'warn', 'error']);
const ALLOWED_CHANNEL = new Set(['SYSTEM', 'POSITION']);

function normalizeLvl(lvl) {
  const v = String(lvl || 'info').toLowerCase();
  return ALLOWED_LVL.has(v) ? v : 'info';
}

function normalizeChannel(channel) {
  const v = String(channel || 'SYSTEM').trim().toUpperCase();
  return ALLOWED_CHANNEL.has(v) ? v : 'SYSTEM';
}

function clipMsg(msg) {
  const s = String(msg || '').trim();
  if (!s) return '';
  return s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
}

function clipField(value, max = 64) {
  const s = String(value || '').trim();
  return s ? s.slice(0, max) : '';
}

function appendRuntimeLog(userId, payload = {}) {
  const uid = String(userId || '').trim();
  if (!uid) {
    const err = new Error('missing user_id');
    err.status = 400;
    throw err;
  }
  const text = clipMsg(payload.msg);
  if (!text) {
    const err = new Error('日志内容不能为空');
    err.status = 400;
    throw err;
  }
  const level = normalizeLvl(payload.lvl);
  const at = Number(payload.ts) > 0 ? Number(payload.ts) : Date.now();
  const src = String(payload.source || 'ui').slice(0, 32);
  const channel = normalizeChannel(payload.channel);
  const eventType = clipField(payload.event_type, 32);
  const strategyId = clipField(payload.strategy_id, 16);
  const symbol = clipField(payload.symbol, 32);
  const reasonCode = clipField(payload.reason_code, 80);

  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO whale_ai_runtime_logs
        (user_id, ts, lvl, msg, source, channel, event_type, strategy_id, symbol, reason_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(uid, at, level, text, src, channel, eventType, strategyId, symbol, reasonCode);

  db.prepare(
    `DELETE FROM whale_ai_runtime_logs
     WHERE user_id = ?
       AND channel = ?
       AND id NOT IN (
         SELECT id FROM whale_ai_runtime_logs
         WHERE user_id = ? AND channel = ?
         ORDER BY ts DESC, id DESC
         LIMIT ?
       )`,
  ).run(uid, channel, uid, channel, MAX_PER_CHANNEL);

  return {
    id: Number(info.lastInsertRowid),
    ts: at,
    lvl: level,
    msg: text,
    source: src,
    channel,
    event_type: eventType,
    strategy_id: strategyId,
    symbol,
    reason_code: reasonCode,
  };
}

function listRuntimeLogs(userId, { limit = MAX_PER_CHANNEL * 2, channel } = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return [];
  const lim = Math.min(MAX_PER_CHANNEL * 2, Math.max(1, Number(limit) || MAX_PER_CHANNEL * 2));
  const ch = channel ? normalizeChannel(channel) : '';
  const sql = ch
    ? `SELECT id, ts, lvl, msg, source, channel, event_type, strategy_id, symbol, reason_code
       FROM whale_ai_runtime_logs
       WHERE user_id = ? AND channel = ?
       ORDER BY ts DESC, id DESC
       LIMIT ?`
    : `SELECT id, ts, lvl, msg, source, channel, event_type, strategy_id, symbol, reason_code
       FROM whale_ai_runtime_logs
       WHERE user_id = ?
       ORDER BY ts DESC, id DESC
       LIMIT ?`;
  const newest = ch
    ? getDb().prepare(sql).all(uid, ch, lim)
    : getDb().prepare(sql).all(uid, lim);
  return newest.reverse().map((row) => ({
    ...row,
    channel: normalizeChannel(row.channel),
  }));
}

function deleteRuntimeLogsForUser(userId) {
  const uid = String(userId || '').trim();
  if (!uid) return 0;
  const info = getDb().prepare('DELETE FROM whale_ai_runtime_logs WHERE user_id = ?').run(uid);
  return Number(info.changes) || 0;
}

module.exports = {
  MAX_PER_CHANNEL,
  MAX_PER_USER: MAX_PER_CHANNEL * 2,
  appendRuntimeLog,
  listRuntimeLogs,
  deleteRuntimeLogsForUser,
};
