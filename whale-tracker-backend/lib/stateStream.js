const { randomUUID } = require('node:crypto');

// The database owns durable state. A new process epoch deliberately invalidates
// old cursors: clients install a fresh snapshot after a restart, never guess.
function createStateStream({ epoch = randomUUID(), maxEvents = 2000, maxBytes = 8 * 1024 * 1024,
  maxPendingItems = 5000, maxPendingBytes = 4 * 1024 * 1024, maxEventBytes = 4 * 1024 * 1024,
  decorate = () => ({}), publish = () => {}, delayMs = 50 } = {}) {
  let seq = 0;
  let bytes = 0;
  let timer;
  const log = [];
  const whales = new Map();
  const alerts = new Map();
  const removedWhales = new Set();
  const removedAlerts = new Set();
  const notifyAlertIds = new Set();
  const pendingSizes = new Map();
  let pendingBytes = 0;
  function account(group, id, value) {
    const key = `${group}:${id}`;
    pendingBytes -= pendingSizes.get(key) || 0;
    if (value === undefined) pendingSizes.delete(key);
    else {
      const size = Buffer.byteLength(JSON.stringify(value)) + Buffer.byteLength(key) + 16;
      pendingSizes.set(key, size); pendingBytes += size;
    }
    if (pendingSizes.size > maxPendingItems || pendingBytes > maxPendingBytes) {
      // These are only transport deltas: SQLite already owns the complete commit.
      // Rotate the epoch so no client can continue from a discarded delta.
      reset(); return false;
    }
    return true;
  }
  function enqueue(change = {}) {
    for (const id of change.notifyAlertIds || []) {
      notifyAlertIds.add(String(id)); if (!account('notify', String(id), String(id))) return;
    }
    for (const id of change.removedWhaleIds || []) {
      whales.delete(String(id)); removedWhales.add(String(id)); account('whale', String(id));
      if (!account('removedWhale', String(id), String(id))) return;
    }
    for (const id of change.removedAlertIds || []) {
      alerts.delete(String(id)); removedAlerts.add(String(id)); account('alert', String(id));
      if (!account('removedAlert', String(id), String(id))) return;
    }
    for (const row of change.whales || []) {
      if (!row?.id) continue;
      whales.set(String(row.id), row); removedWhales.delete(String(row.id));
      account('removedWhale', String(row.id));
      if (!account('whale', String(row.id), row)) return;
    }
    for (const row of change.alerts || []) {
      if (!row?.id) continue;
      alerts.set(String(row.id), row); removedAlerts.delete(String(row.id));
      account('removedAlert', String(row.id));
      if (!account('alert', String(row.id), row)) return;
    }
    if (!timer && (whales.size || alerts.size || removedWhales.size || removedAlerts.size)) {
      timer = setTimeout(flush, delayMs); timer.unref?.();
    }
  }
  function flush() {
    clearTimeout(timer); timer = undefined;
    if (!whales.size && !alerts.size && !removedWhales.size && !removedAlerts.size) return null;
    // Decorate before consuming pending state: a failed summary read is retryable.
    let extra;
    try { extra = decorate(); } catch (err) {
      timer = setTimeout(flush, Math.max(1000, delayMs)); timer.unref?.();
      console.warn('[state-stream] snapshot decoration failed:', err.message);
      return null;
    }
    const encoded = JSON.stringify({ ...extra, type: 'stateCommit', epoch, seq: seq + 1,
      updatedAt: Date.now(), whales: [...whales.values()], alerts: [...alerts.values()],
      removedWhaleIds: [...removedWhales], removedAlertIds: [...removedAlerts],
      notifyAlertIds: [...notifyAlertIds].filter(id => alerts.has(id) && !removedAlerts.has(id)) });
    const size = Buffer.byteLength(encoded);
    if (size > maxEventBytes) { reset(); return null; }
    const event = JSON.parse(encoded);
    seq++;
    whales.clear(); alerts.clear(); removedWhales.clear(); removedAlerts.clear();
    notifyAlertIds.clear();
    pendingSizes.clear(); pendingBytes = 0;
    log.push({ event, size }); bytes += size;
    while (log.length && (log.length > maxEvents || bytes > maxBytes)) bytes -= log.shift().size;
    try { publish(event); } catch (err) { console.warn('[state-stream] publish failed:', err.message); }
    return event;
  }
  function cursor() {
    flush();
    if (whales.size || alerts.size || removedWhales.size || removedAlerts.size) throw new Error('State commit is not ready for a consistent snapshot');
    return { epoch, seq };
  }
  function resume(request = {}) {
    cursor();
    const after = Number(request.afterSeq);
    if (request.epoch !== epoch || !Number.isSafeInteger(after) || after < 0 || after > seq ||
      (after < seq && (!log.length || after < log[0].event.seq - 1))) {
      return { type: 'resyncRequired', epoch, seq };
    }
    return { events: log.filter(row => row.event.seq > after).map(row => row.event), epoch, seq };
  }
  function reset() {
    clearTimeout(timer); timer = undefined;
    whales.clear(); alerts.clear(); removedWhales.clear(); removedAlerts.clear();
    notifyAlertIds.clear();
    pendingSizes.clear(); pendingBytes = 0;
    log.length = 0; bytes = 0; seq = 0; epoch = randomUUID();
    try { publish({ type: 'resyncRequired', epoch, seq }); }
    catch (err) { console.warn('[state-stream] resync publication failed:', err.message); }
  }
  return { enqueue, flush, cursor, resume, reset, close: () => clearTimeout(timer) };
}

module.exports = { createStateStream };
