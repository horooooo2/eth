import { ref } from 'vue';

const STORAGE_KEY = 'whale-tracker-tradfi-watch-v1';
const DEFAULT_WATCH = ['XAUUSDT', 'XAGUSDT'];
const OLD_DEFAULT_WATCH = ['XAUUSDT', 'XAGUSDT', 'TSLAUSDT', 'EWYUSDT'];

function normalizeWatch(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_WATCH];
  const symbols = [...new Set(value.filter((item): item is string =>
    typeof item === 'string' && /^[A-Z0-9]{3,30}$/.test(item)))].slice(0, 30);
  return symbols.length ? symbols : [...DEFAULT_WATCH];
}

function readStoredWatch(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (Array.isArray(stored) && stored.length === OLD_DEFAULT_WATCH.length
      && stored.every((item, index) => item === OLD_DEFAULT_WATCH[index])) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_WATCH));
      return [...DEFAULT_WATCH];
    }
    return normalizeWatch(stored);
  } catch {
    return [...DEFAULT_WATCH];
  }
}

export const tradfiWatch = ref<string[]>(readStoredWatch());

export function writeTradFiWatch(symbols: string[]) {
  tradfiWatch.value = normalizeWatch(symbols);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tradfiWatch.value)); } catch { /* 当前会话仍可使用 */ }
}
