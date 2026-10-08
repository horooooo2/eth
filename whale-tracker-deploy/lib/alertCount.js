const { Worker } = require('node:worker_threads');
let pending = null;
function initialize() {
  if (pending || require('./marketMaintenance').isPaused()) return;
  const worker = new Worker(require.resolve('./alertCountInit'), {
    workerData: { database: require('./db').resolveDbPath() },
    resourceLimits: { maxOldGenerationSizeMb: 32 },
  });
  pending = worker;
  worker.on('message', result => { if (result.error) console.warn('[alert-count]', result.error); });
  worker.on('error', error => console.warn('[alert-count]', error.message));
  worker.once('exit', () => { if (pending === worker) pending = null; });
}
async function stopInitialization() {
  const worker = pending;
  if (worker) await worker.terminate();
  if (pending === worker) pending = null;
}
function getAlertCount() {
  const row = require('./db').getDb().prepare('SELECT total FROM alert_totals WHERE id=1').get();
  const total = row?.total ?? null;
  if (total === null) initialize();
  return { total, countedAt: Date.now(), status: total === null ? 'initializing' : 'ready' };
}
module.exports = { getAlertCount, stopInitialization };
