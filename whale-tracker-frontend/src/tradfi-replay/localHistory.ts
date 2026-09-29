export type ReplaySettings = {
  margin: number;
  leverage: number;
  makerFeePct: number;
  tickSize: number;
  qtyStep: number;
  walletBalance?: number;
};

export type ReplayDataset = {
  id: string;
  symbol: string;
  candleName: string;
  fundingName: string;
  candleRows: number;
  fundingRows: number;
  start: number;
  end: number;
  size: number;
  savedAt: number;
  settings?: ReplaySettings;
  candleFile: Blob;
  fundingFile: Blob | null;
};

export type ReplayDatasetSummary = Omit<ReplayDataset, 'candleFile' | 'fundingFile'>;

type LegacyFile = {
  id: string; kind: 'candles' | 'funding'; name: string; symbol: string; size: number;
  rows: number; start: number; end: number; savedAt: number; file: Blob;
};

const DATABASE = 'tradfi-replay-history';
const STORE = 'datasets';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 2);
    request.onupgradeneeded = () => {
      const database = request.result;
      const datasets = database.createObjectStore(STORE, { keyPath: 'id' });
      if (!database.objectStoreNames.contains('files')) return;
      // Keep previously saved individual CSVs available after moving to
      // one dataset per replay. Pair matching funding when available.
      const legacyRequest = request.transaction!.objectStore('files').getAll();
      legacyRequest.onsuccess = () => {
        const files = legacyRequest.result as LegacyFile[];
        const funding = files.filter((item) => item.kind === 'funding');
        for (const candle of files.filter((item) => item.kind === 'candles')) {
          const match = funding.filter((item) => item.symbol === candle.symbol && item.start <= candle.end && item.end >= candle.start)
            .sort((a, b) => Math.abs(a.savedAt - candle.savedAt) - Math.abs(b.savedAt - candle.savedAt))[0];
          datasets.put({ id: `legacy:${candle.id}`, symbol: candle.symbol, candleName: candle.name, fundingName: match?.name || '',
            candleRows: candle.rows, fundingRows: match?.rows || 0, start: candle.start, end: candle.end,
            size: candle.size + (match?.size || 0), savedAt: Math.max(candle.savedAt, match?.savedAt || 0),
            candleFile: candle.file, fundingFile: match?.file || null } satisfies ReplayDataset);
        }
      };
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开本地数据历史'));
  });
}

async function transact<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, mode);
    const request = operation(transaction.objectStore(STORE));
    let result: T;
    request.onsuccess = () => { result = request.result; };
    transaction.oncomplete = () => { database.close(); resolve(result); };
    transaction.onerror = () => { database.close(); reject(transaction.error || request.error || new Error('本地数据历史操作失败')); };
    transaction.onabort = () => { database.close(); reject(transaction.error || new Error('本地数据历史操作已取消')); };
  });
}

export function saveReplayDataset(record: ReplayDataset): Promise<IDBValidKey> {
  return transact('readwrite', (store) => store.put(record));
}

export async function listReplayDatasets(): Promise<ReplayDatasetSummary[]> {
  const records = await transact<ReplayDataset[]>('readonly', (store) => store.getAll());
  return records.map(({ candleFile: _candles, fundingFile: _funding, ...summary }) => summary).sort((a, b) => b.savedAt - a.savedAt);
}

export function getReplayDataset(id: string): Promise<ReplayDataset | undefined> {
  return transact('readonly', (store) => store.get(id));
}

export function deleteReplayDataset(id: string): Promise<undefined> {
  return transact('readwrite', (store) => store.delete(id));
}
