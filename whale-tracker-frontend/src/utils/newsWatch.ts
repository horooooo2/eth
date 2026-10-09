import { computed, ref } from 'vue';
import { tradfiWatch, longTrendWatch } from './tradfiWatch';
import { preferredCoinsState } from './watchedCoins';

const KEY = 'whale-tracker-news-watch-v1';
function normalize(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.filter((s): s is string => typeof s === 'string' && /^[A-Z0-9]{3,30}$/.test(s)))].slice(0, 60);
}
function read() { try { return normalize(JSON.parse(localStorage.getItem(KEY) || 'null')); } catch { return null; } }
const custom = ref<string[] | null>(read());
export const newsWatch = computed(() => custom.value ?? [...new Set([...longTrendWatch.value, ...tradfiWatch.value, ...preferredCoinsState.value.map(c => `${c}USDT`)])]);
export const newsWatchFollowsRadar = computed(() => custom.value === null);
export function saveNewsWatch(symbols: string[]) {
  const next = normalize(symbols) || [];
  // Persist before publishing so failed storage does not look like a successful save.
  localStorage.setItem(KEY, JSON.stringify(next));
  custom.value = next;
}
export function resetNewsWatch() { localStorage.removeItem(KEY); custom.value = null; }
