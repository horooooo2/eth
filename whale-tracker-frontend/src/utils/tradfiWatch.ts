import { ref } from 'vue';

const STORAGE_KEY = 'whale-tracker-tradfi-watch-v1';
export const DEFAULT_RADAR_WATCH = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'XAUUSDT', 'XAGUSDT', 'QQQUSDT', 'NVDAUSDT',
];
const PREVIOUS_DEFAULT_WATCH = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'LTCUSDT',
  'BCHUSDT', 'DOTUSDT', 'TRXUSDT', 'TONUSDT', 'SUIUSDT', 'APTUSDT', 'NEARUSDT', 'UNIUSDT', 'ETCUSDT', 'ATOMUSDT',
  'XAUUSDT', 'XAGUSDT', 'SNDKUSDT', 'TSLAUSDT', 'INTCUSDT', 'WTIUSDT',
];
const LEGACY_DEFAULT_WATCHES = [
  ['XAUUSDT', 'XAGUSDT'],
  ['XAUUSDT', 'XAGUSDT', 'TSLAUSDT', 'EWYUSDT'],
];
const DEFAULT_WATCH = DEFAULT_RADAR_WATCH;

function normalizeWatch(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_WATCH];
  const symbols = [...new Set(value.filter((item): item is string =>
    typeof item === 'string' && /^[A-Z0-9]{3,30}$/.test(item)))].slice(0, 30);
  return symbols.length ? symbols : [...DEFAULT_WATCH];
}

function readStoredWatch(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    const isPreviousDefault = Array.isArray(stored)
      && stored.length === PREVIOUS_DEFAULT_WATCH.length
      && stored.every((item, index) => item === PREVIOUS_DEFAULT_WATCH[index]);
    if (isPreviousDefault || (Array.isArray(stored) && LEGACY_DEFAULT_WATCHES.some((legacy) =>
      stored.length === legacy.length && stored.every((item, index) => item === legacy[index])))) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_RADAR_WATCH));
      return [...DEFAULT_WATCH];
    }
    return normalizeWatch(stored);
  } catch {
    return [...DEFAULT_WATCH];
  }
}

export const tradfiWatch = ref<string[]>(readStoredWatch());

export function isDefaultRadarWatch(symbols: string[]) {
  return symbols.length === DEFAULT_RADAR_WATCH.length
    && DEFAULT_RADAR_WATCH.every((symbol, index) => symbols[index] === symbol);
}

export function writeTradFiWatch(symbols: string[]) {
  tradfiWatch.value = normalizeWatch(symbols);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tradfiWatch.value)); } catch { /* 当前会话仍可使用 */ }
}
