const { createStateStream } = require('./stateStream');

function compactWhales(rows = []) {
  return rows.map(whale => ({ ...whale, positions: (whale.positions || []).map(position => {
    const { entryFills, ...rest } = position;
    return { ...rest, entryFillsOmitted: Math.max(0, Number(position.entryFillsOmitted) || 0) + (entryFills || []).length };
  }) }));
}

let initialized = false;
const stream = createStateStream({
  decorate: () => ({ summary: {
    ...require('./whales').getWhaleSummary(),
    alertTotal: require('./sqliteStore').countStoredAlerts(),
  } }),
  publish: event => require('./realtimeHub').broadcastState(event),
});

function initialize() {
  if (initialized) return;
  const cache = require('./cache');
  const sqlite = require('./sqliteStore');
  if (!cache.subscribeStateCommits || !sqlite.setAlertCommitObserver) throw new Error('Whale sync commit hooks unavailable');
  cache.subscribeStateCommits(change => {
    if (change.data?.mode && change.data.mode !== 'hf') return;
    stream.enqueue({ whales: compactWhales(change.whales || change.changedWhales || []),
      removedWhaleIds: change.removedWhaleIds || [] });
  });
  sqlite.setAlertCommitObserver(change => stream.enqueue(change));
  initialized = true;
}

function bootstrap() {
  initialize();
  // These synchronous reads cannot interleave with another collector callback.
  const cursor = stream.cursor();
  const snapshot = require('./cache').readStateSnapshot('hf', { includeTrades: false });
  const active = require('./config').getActiveWhales();
  const byId = new Map((snapshot?.data?.whales || []).map(w => [String(w.id), w]));
  const whales = active.map(w => ({ ...w, ...(byId.get(String(w.id)) || { positions: [], error: '等待采集' }),
    name: w.name, address: w.address, enabled: w.enabled }));
  return { protocolVersion: 1, ...cursor, updatedAt: snapshot?.updatedAt || 0,
    whales: compactWhales(whales), alerts: require('./sqliteStore').loadPagedAlerts({ page: 1, limit: 100, excludeExotic: '1' }).alerts,
    summary: { ...require('./whales').getWhaleSummary(), alertTotal: require('./sqliteStore').countStoredAlerts() } };
}

function markLiveAlerts(alerts = []) {
  const now = Date.now();
  const ids = alerts.filter(alert => (alert.items || []).some(item => {
    const time = Number(item.time) || Number(alert.at) || 0;
    return time > 0 && now - time >= 0 && now - time <= 120_000;
  })).map(alert => alert.id);
  stream.enqueue({ notifyAlertIds: ids });
}

module.exports = { initialize, bootstrap, stream, compactWhales, markLiveAlerts };
