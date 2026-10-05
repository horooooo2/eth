const { randomUUID } = require('node:crypto');

// The database owns durable state. A new process epoch deliberately invalidates
// old cursors: clients install a fresh snapshot after a restart, never guess.
function createStateStream({ epoch = randomUUID(), maxEvents = 2000, maxBytes = 8 * 1024 * 1024,
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
  function enqueue(change = {}) {
    for (const id of change.notifyAlertIds || []) notifyAlertIds.add(String(id));
    for (const id of change.removedWhaleIds || []) { whales.delete(String(id)); removedWhales.add(String(id)); }
    for (const id of change.removedAlertIds || []) { alerts.delete(String(id)); removedAlerts.add(String(id)); }
    for (const row of change.whales || []) {
      if (!row?.id) continue;
      whales.set(String(row.id), row); removedWhales.delete(String(row.id));
    }
    for (const row of change.alerts || []) {
      if (!row?.id) continue;
      alerts.set(String(row.id), row); removedAlerts.delete(String(row.id));
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
    const event = JSON.parse(JSON.stringify({ ...extra, type: 'stateCommit', epoch, seq: ++seq,
      updatedAt: Date.now(), whales: [...whales.values()], alerts: [...alerts.values()],
      removedWhaleIds: [...removedWhales], removedAlertIds: [...removedAlerts],
      notifyAlertIds: [...notifyAlertIds].filter(id => alerts.has(id) && !removedAlerts.has(id)) }));
    whales.clear(); alerts.clear(); removedWhales.clear(); removedAlerts.clear();
    notifyAlertIds.clear();
    const size = Buffer.byteLength(JSON.stringify(event));
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
    log.length = 0; bytes = 0; seq = 0; epoch = randomUUID();
    publish({ type: 'resyncRequired', epoch, seq });
  }
  return { enqueue, flush, cursor, resume, reset, close: () => clearTimeout(timer) };
}

module.exports = { createStateStream };
