const { Worker } = require('node:worker_threads');
const { randomUUID } = require('node:crypto');
const maintenance = require('./marketMaintenance');
const JOB_KEY = 'market_reset_job_v1';
let job = null, active = false;
function save() { require('./db').setMeta(JOB_KEY, JSON.stringify(job)); }
function clearMarketTables() {
  return new Promise((resolve, reject) => {
    const worker = new Worker(require.resolve('./resetCompute'), {
      workerData: { database: require('./db').resolveDbPath() },
      resourceLimits: { maxOldGenerationSizeMb: 32 },
    });
    let result, failure;
    worker.on('message', value => {
      if (value.error) failure = new Error(value.error);
      else if (value.done) result = value;
      else if (job) Object.assign(job, value);
    });
    worker.once('error', error => { failure = error; });
    worker.once('exit', code => {
      if (failure || code !== 0 || !result) reject(failure || new Error('后台清理未完成'));
      else resolve(result);
    });
  });
}
async function resetSiteData() {
  const fills = require('./fillBackfill');
  await require('./alertCount').stopInitialization();
  await clearMarketTables();
  require('./sqliteStore').invalidateFillProjection();
  require('./sqliteStore').invalidateAlertQueries();
  require('./whaleSync').stream.reset();
  require('./whales').invalidateWhaleCache();
  require('./realtimeBridge').resetMarketMemory();
  fills.resetFillBackfill();
  if (job) {
    job.status = 'recovering'; job.clearedAt = Date.now(); save();
  }
  maintenance.resume();
  fills.startFillBackfill();
  require('./positionPoller').restart();
  return { recovery: fills.getResetRecoveryStatus() };
}
function launch() {
  active = true;
  maintenance.begin();
  require('./fillBackfill').stopFillBackfill();
  require('./positionPoller').stop();
  setImmediate(async () => {
    try {
      job.status = 'clearing'; save();
      const result = await module.exports.resetSiteData();
      if (maintenance.isPaused()) maintenance.resume();
      job.status = result.recovery?.status === 'recovering' ? 'recovering' : 'complete';
      job.clearedAt = Date.now(); job.error = result.refresh?.error || null;
    } catch (error) {
      job.status = 'failed'; job.error = error.message || '重置失败';
      console.error('[reset] cleanup failed:', job.error);
      maintenance.begin();
      require('./fillBackfill').stopFillBackfill(); require('./positionPoller').stop();
    } finally {
      active = false;
      try { save(); } catch (error) { console.error('[reset] persist status:', error.message); }
    }
  });
}
function startResetJob() {
  if (active) { const error = new Error('正在清理数据，请稍候'); error.status = 409; throw error; }
  job = { id: randomUUID(), status: 'queued', startedAt: Date.now(), deletedRows: 0, table: null, error: null };
  save(); launch();
  return { ok: true, job: { ...job } };
}
function getResetStatus() {
  const clearing = active || maintenance.isPaused();
  const recovery = clearing ? null : require('./fillBackfill').getResetRecoveryStatus();
  if (job?.status === 'recovering' && recovery?.status !== 'recovering' && recovery) job.status = 'complete';
  return { job: job ? { ...job } : null, recovery, error: job?.error || null };
}
function resumeInterruptedReset() {
  const stored = require('./db').getMeta(JOB_KEY);
  if (!stored?.value) return;
  try { job = JSON.parse(stored.value); } catch { return; }
  if (['queued', 'clearing'].includes(job?.status)) launch();
  else if (job?.status === 'failed') maintenance.begin();
}
module.exports = { resetSiteData, startResetJob, getResetStatus, resumeInterruptedReset, isBusy: () => active };
