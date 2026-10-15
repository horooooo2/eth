'use strict';
const { randomUUID } = require('node:crypto');
const { getDb } = require('./db');
function unpack(row) { return row ? { id: row.id, symbol: row.symbol, horizon: row.horizon, status: row.status, createdAt: row.created_at,
  updatedAt: row.updated_at, error: row.error || '', ...JSON.parse(row.payload_json) } : null; }
function create(userId, snapshot, status = 'SAVED', web = false) {
  const db = getDb(), id = randomUUID(), now = Date.now();
  const payload = JSON.stringify({ snapshot, analysis: null, research: null, web });
  if (Buffer.byteLength(payload) > 200000) throw new Error('研判快照超过保存上限');
  db.transaction(() => {
    db.prepare('INSERT INTO contract_research_history (id,user_id,symbol,horizon,snapshot_id,status,payload_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, String(userId), snapshot.symbol, snapshot.horizon, snapshot.id, status, payload, now, now);
    db.prepare(`DELETE FROM contract_research_history WHERE id IN (
      SELECT id FROM contract_research_history WHERE user_id=? AND status!='RUNNING'
      ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET MAX(0,100-(SELECT COUNT(*) FROM contract_research_history WHERE user_id=? AND status='RUNNING'))
    )`).run(String(userId), String(userId));
    db.prepare(`DELETE FROM contract_research_history WHERE id IN (
      SELECT id FROM contract_research_history WHERE status!='RUNNING' ORDER BY created_at DESC,rowid DESC
      LIMIT -1 OFFSET MAX(0,1000-(SELECT COUNT(*) FROM contract_research_history WHERE status='RUNNING'))
    )`).run();
  })();
  return get(id, userId);
}
function recover(userId) {
  // Long-lived jobs have a hard deadline below 2 minutes; never change completed snapshots.
  getDb().prepare("UPDATE contract_research_history SET status='FAILED',error='任务已中断或超时，请重新分析',updated_at=? WHERE user_id=? AND status='RUNNING' AND created_at<?")
    .run(Date.now(), String(userId), Date.now() - 125000);
}
function get(id, userId) { recover(userId); return unpack(getDb().prepare('SELECT * FROM contract_research_history WHERE id=? AND user_id=?').get(String(id), String(userId))); }
function list(userId, symbol) {
  recover(userId);
  return getDb().prepare('SELECT id,symbol,horizon,status,created_at AS createdAt,updated_at AS updatedAt,error FROM contract_research_history WHERE user_id=? AND symbol=? ORDER BY created_at DESC,rowid DESC LIMIT 100').all(String(userId), String(symbol));
}
function find(userId, snapshotId, web, status) {
  const row = getDb().prepare('SELECT * FROM contract_research_history WHERE user_id=? AND snapshot_id=? AND status=? AND json_extract(payload_json,\'$.web\')=? ORDER BY created_at DESC LIMIT 1').get(String(userId), snapshotId, status, web ? 1 : 0);
  return unpack(row);
}
function latest(userId, symbol, horizon, version) {
  recover(userId);
  const rows = getDb().prepare(`SELECT * FROM contract_research_history WHERE user_id=? AND symbol=? AND horizon=?
    AND status IN ('COMPLETED','RUNNING') AND created_at>? ORDER BY created_at DESC,rowid DESC LIMIT 5`)
    .all(String(userId), symbol, horizon, Date.now() - 3600000);
  return rows.map(unpack).find(row => row.snapshot?.version === version) || null;
}
function finish(id, userId, result, error) {
  const previous = get(id, userId); if (!previous || previous.status !== 'RUNNING') return previous;
  const payload = JSON.stringify({ snapshot: previous.snapshot, web: previous.web, analysis: result?.analysis || null, research: result?.research || null });
  if (Buffer.byteLength(payload) > 200000) return finish(id, userId, null, '分析资料超过保存上限');
  getDb().prepare('UPDATE contract_research_history SET status=?,payload_json=?,error=?,updated_at=? WHERE id=? AND user_id=? AND status=\'RUNNING\'')
    .run(error ? 'FAILED' : 'COMPLETED', payload, error || '', Date.now(), id, String(userId));
  return get(id, userId);
}
module.exports = { create, get, list, find, finish, latest };
