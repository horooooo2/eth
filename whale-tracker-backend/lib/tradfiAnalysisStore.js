const crypto = require('node:crypto');
const { getDb } = require('./db');

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value || ''); } catch { return fallback; }
}
function mapRow(row) {
  if (!row) return null;
  return {
    analysisId: row.analysis_id,
    userId: row.user_id,
    symbol: row.symbol,
    contextHash: row.context_hash,
    engineVersion: row.engine_version,
    promptVersion: row.prompt_version,
    status: row.status,
    model: row.model || null,
    context: parseJson(row.context_json),
    directionResult: parseJson(row.direction_json),
    explanation: parseJson(row.explanation_json),
    error: row.error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function findByContext({ userId, symbol, contextHash, engineVersion, promptVersion }) {
  const row = getDb().prepare(`SELECT * FROM tradfi_ai_analyses
    WHERE user_id=? AND symbol=? AND context_hash=? AND engine_version=? AND prompt_version=?`).get(
    String(userId), String(symbol), String(contextHash), String(engineVersion), String(promptVersion));
  return mapRow(row);
}
function createPending(input) {
  const db = getDb();
  const previous = findByContext(input);
  if (previous?.status === 'COMPLETED' || previous?.status === 'PENDING' || previous?.status === 'RUNNING') return previous;
  const now = Date.now();
  const analysisId = crypto.randomUUID();
  if (previous) {
    db.prepare(`UPDATE tradfi_ai_analyses SET analysis_id=?,status='PENDING',model=NULL,
      context_json=?,direction_json=?,explanation_json='{}',error=NULL,created_at=?,updated_at=? WHERE analysis_id=?`)
      .run(analysisId, JSON.stringify(input.context), JSON.stringify(input.directionResult), now, now, previous.analysisId);
  } else {
    db.prepare(`INSERT INTO tradfi_ai_analyses
      (analysis_id,user_id,symbol,context_hash,engine_version,prompt_version,status,context_json,direction_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'PENDING',?,?,?,?)`).run(
      analysisId, String(input.userId), String(input.symbol), String(input.contextHash),
      String(input.engineVersion), String(input.promptVersion), JSON.stringify(input.context),
      JSON.stringify(input.directionResult), now, now);
  }
  db.prepare(`DELETE FROM tradfi_ai_analyses WHERE analysis_id IN (
    SELECT analysis_id FROM tradfi_ai_analyses ORDER BY created_at DESC LIMIT -1 OFFSET 2000
  )`).run();
  return findByContext(input);
}
function updateStatus(analysisId, status, patch = {}) {
  const allowed = new Set(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED']);
  if (!allowed.has(status)) throw new Error('无效的 TradFi 分析状态');
  const now = Date.now();
  getDb().prepare(`UPDATE tradfi_ai_analyses SET status=?,model=COALESCE(?,model),
    explanation_json=COALESCE(?,explanation_json),error=?,updated_at=? WHERE analysis_id=?`)
    .run(status, patch.model || null, patch.explanation == null ? null : JSON.stringify(patch.explanation), patch.error || null, now, String(analysisId));
  return getById(analysisId);
}
function getById(analysisId, userId) {
  const row = userId == null
    ? getDb().prepare('SELECT * FROM tradfi_ai_analyses WHERE analysis_id=?').get(String(analysisId))
    : getDb().prepare('SELECT * FROM tradfi_ai_analyses WHERE analysis_id=? AND user_id=?').get(String(analysisId), String(userId));
  return mapRow(row);
}

module.exports = { findByContext, createPending, updateStatus, getById };
