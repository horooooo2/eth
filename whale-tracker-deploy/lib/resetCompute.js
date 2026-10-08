const { parentPort, workerData } = require('node:worker_threads');
const tables = ['fills', 'events', 'alert_items', 'alert_sources', 'alerts', 'positions', 'whales'];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  let db;
  try {
    db = new (require('better-sqlite3'))(workerData.database, { fileMustExist: true, timeout: 100 });
    db.pragma('recursive_triggers = ON'); db.pragma('synchronous = NORMAL');
    let deletedRows = 0;
    for (const table of tables) {
      const remove = db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} LIMIT 250)`);
      let blockedAt = 0;
      for (;;) {
        let changes;
        try { changes = remove.run().changes; }
        catch (error) {
          if (error.code !== 'SQLITE_BUSY') throw error;
          blockedAt ||= Date.now();
          if (Date.now() - blockedAt > 30000) throw new Error('数据库写锁持续占用，清理已暂停，请稍后重试');
          await delay(100); continue;
        }
        blockedAt = 0;
        deletedRows += changes;
        parentPort.postMessage({ table, deletedRows });
        if (!changes) break;
        await delay(50);
      }
    }
    db.prepare('UPDATE alert_totals SET total=0, visible=0 WHERE id=1').run();
    parentPort.postMessage({ done: true, deletedRows });
  } catch (error) { parentPort.postMessage({ error: error.message }); }
  finally { db?.close(); }
})();
