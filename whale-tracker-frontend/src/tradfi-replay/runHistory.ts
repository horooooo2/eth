export type ReplayReport = { id: string; createdAt: string; strategyName: string; version: string; complete: boolean; settings: { symbol: string }; result: { net: number }; [key: string]: any };
export type RunSummary = Pick<ReplayReport, 'id' | 'createdAt' | 'strategyName' | 'version'> & { symbol: string; net: number; strategyId?: string };
// Separate database: existing large CSV history is not migrated or read for reports.
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('strategy-replay-results', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('reports', { keyPath: 'id' });
      request.result.createObjectStore('summaries', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function saveRun(report: ReplayReport) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['reports', 'summaries'], 'readwrite');
      tx.objectStore('reports').put(report);
      tx.objectStore('summaries').put({ id: report.id, createdAt: report.createdAt, strategyName: report.strategyName, strategyId: report.strategyId, version: report.version, symbol: report.settings.symbol, net: report.result.net });
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}
async function readStore<T>(store: string, id?: string): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store), request = id ? tx.objectStore(store).get(id) : tx.objectStore(store).getAll();
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
export const getRun = (id: string) => readStore<ReplayReport | undefined>('reports', id);
export async function listRuns() { return (await readStore<RunSummary[]>('summaries')).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
