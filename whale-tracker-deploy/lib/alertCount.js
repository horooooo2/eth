const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

if (!isMainThread) {
  let database;
  try {
    database = new (require('better-sqlite3'))(workerData.database, { readonly: true, fileMustExist: true, timeout: 1000 });
    const total = database.prepare('SELECT COUNT(*) AS total FROM alerts').get().total;
    parentPort.postMessage({ total, countedAt: Date.now() });
  } catch (error) { parentPort.postMessage({ error: error.message }); }
  finally { database?.close(); }
} else {
  let pending = null;
  function getAlertCount() {
    if (pending) return pending;
    const worker = new Worker(__filename, {
      workerData: { database: require('./db').resolveDbPath() },
      resourceLimits: { maxOldGenerationSizeMb: 32 },
    });
    const task = new Promise((resolve, reject) => {
      let result, failure;
      // Keep concurrent requests sharing this worker until it actually exits.
      const timer = setTimeout(() => {
        reject(new Error('异动条数统计超时，请稍后重试'));
        void worker.terminate();
      }, 5000);
      worker.once('message', value => { result = value; });
      worker.once('error', error => { failure = error; });
      worker.once('exit', code => {
        clearTimeout(timer);
        if (pending === task) pending = null;
        if (failure || result?.error || code !== 0 || !result) {
          reject(failure || new Error(result?.error || '异动条数统计超时或未完成，请稍后重试'));
        } else resolve(result);
      });
    });
    pending = task;
    return task;
  }
  module.exports = { getAlertCount };
}
