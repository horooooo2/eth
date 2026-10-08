const { parentPort, workerData } = require('node:worker_threads');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  let reader, writer;
  try {
    const Database = require('better-sqlite3');
    reader = new Database(workerData.database, { readonly: true, fileMustExist: true, timeout: 100 });
    reader.exec('BEGIN');
    const baseline = reader.prepare('SELECT all_delta FROM alert_totals WHERE id=1').get().all_delta;
    const first = reader.prepare('SELECT rowid FROM alerts ORDER BY rowid LIMIT 1000');
    const next = reader.prepare('SELECT rowid FROM alerts WHERE rowid>? ORDER BY rowid LIMIT 1000');
    let count = 0, cursor;
    for (;;) {
      const rows = cursor === undefined ? first.all() : next.all(cursor);
      count += rows.length;
      if (!rows.length) break;
      cursor = rows[rows.length - 1].rowid;
      await delay(25);
    }
    reader.exec('COMMIT'); reader.close(); reader = null;
    writer = new Database(workerData.database, { fileMustExist: true, timeout: 100 });
    writer.pragma('synchronous = NORMAL');
    // The read snapshot and change delta reconcile concurrent inserts/deletes.
    // A completed reset already sets total=0 and must never be overwritten.
    writer.prepare('UPDATE alert_totals SET total=?+(all_delta-?) WHERE id=1 AND total IS NULL').run(count, baseline);
    parentPort.postMessage({ done: true });
  } catch (error) { parentPort.postMessage({ error: error.message }); }
  finally { reader?.close(); writer?.close(); }
})();
