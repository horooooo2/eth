// Current positions have a separate bounded loop; historical fill work must not
// determine how long an otherwise quiet account's position stays unobserved.
let timer;
const active = new Set();
const attempted = new Map();
function tick() {
  const now = Date.now();
  const { getActiveWhales } = require('./config');
  const rows = require('./cache').readStateSnapshot('hf', { includeTrades: false }).data.whales || [];
  const byId = new Map(rows.map(row => [row.id, row]));
  const roster = getActiveWhales();
  const ids = new Set(roster.map(w => w.id));
  for (const id of attempted.keys()) if (!ids.has(id)) attempted.delete(id);
  const due = roster.filter(w => !active.has(w.id) && now - (attempted.get(w.id) || 0) > 30000 &&
    now - (Number(byId.get(w.id)?.positionObservedAt) || 0) > 60000)
    .sort((a, b) => Math.max(attempted.get(a.id) || 0, Number(byId.get(a.id)?.positionObservedAt) || 0) -
      Math.max(attempted.get(b.id) || 0, Number(byId.get(b.id)?.positionObservedAt) || 0));
  for (const whale of due.slice(0, Math.max(0, 2 - active.size))) {
    active.add(whale.id); attempted.set(whale.id, now);
    Promise.resolve().then(() => require('./whales').refreshWhalePositionFromSource(whale.id))
      .catch(error => console.warn('[position-poller]', error.code || error.message))
      .finally(() => active.delete(whale.id));
  }
}
function start() { if (timer) return; timer = setInterval(tick, 1000); timer.unref(); }
module.exports = { start, stop() { clearInterval(timer); timer = null; } };
