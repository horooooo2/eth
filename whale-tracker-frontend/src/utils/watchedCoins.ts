import { computed, ref } from 'vue';
import { displayAsset, isExoticAsset } from '@/utils/assets';

export const PREFERRED_COINS_KEY = 'whale-tracker-preferred-coins';
export const LEGACY_EXTRA_COINS_KEY = 'whale-tracker-extra-coins';
export const DEFAULT_PREFERRED_COINS = ['BTC', 'ETH'] as const;
export const CORE_MARKET_COINS = ['BTC', 'ETH'] as const;
export const MAX_PREFERRED_COINS = 12;

/** @deprecated use DEFAULT_PREFERRED_COINS */
export const PINNED_WATCH_COINS = DEFAULT_PREFERRED_COINS;
/** @deprecated use MAX_PREFERRED_COINS */
export const MAX_EXTRA_COINS = MAX_PREFERRED_COINS;
/** @deprecated use LEGACY_EXTRA_COINS_KEY */
export const EXTRA_COINS_KEY = LEGACY_EXTRA_COINS_KEY;

export function normalizeCoinId(value: string) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function dedupePreferredCoins(ids: string[]) {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const item of ids) {
    const id = normalizeCoinId(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
    if (next.length >= MAX_PREFERRED_COINS) break;
  }
  return next.length ? next : [...DEFAULT_PREFERRED_COINS];
}

function readLegacyExtraCoins() {
  try {
    const raw = JSON.parse(localStorage.getItem(LEGACY_EXTRA_COINS_KEY) || '[]');
    if (!Array.isArray(raw)) return [] as string[];
    return raw.map((item) => normalizeCoinId(String(item || ''))).filter(Boolean);
  } catch {
    return [] as string[];
  }
}

function readPreferredCoinsFromStorage() {
  try {
    const raw = localStorage.getItem(PREFERRED_COINS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        return dedupePreferredCoins(parsed);
      }
    }
  } catch {
    // ignore
  }
  return dedupePreferredCoins([...DEFAULT_PREFERRED_COINS, ...readLegacyExtraCoins()]);
}

export const preferredCoinsState = ref<string[]>(readPreferredCoinsFromStorage());

/** @deprecated use preferredCoinsState */
export const extraCoinsState = computed(() =>
  preferredCoinsState.value.filter(
    (id) => !CORE_MARKET_COINS.includes(id as (typeof CORE_MARKET_COINS)[number]),
  ),
);

export const watchedCoins = computed(() => [...preferredCoinsState.value]);

export function readWatchedCoins() {
  return [...preferredCoinsState.value];
}

export function readPrimaryCoin() {
  return readWatchedCoins()[0] || 'BTC';
}

export function writePreferredCoins(ids: string[]) {
  const next = dedupePreferredCoins(ids);
  preferredCoinsState.value = next;
  localStorage.setItem(PREFERRED_COINS_KEY, JSON.stringify(next));
}

/** @deprecated use writePreferredCoins */
export function writeExtraCoins(ids: string[]) {
  const extras = ids
    .map((item) => normalizeCoinId(item))
    .filter((id) => id && !CORE_MARKET_COINS.includes(id as (typeof CORE_MARKET_COINS)[number]));
  const core = preferredCoinsState.value.filter((id) =>
    CORE_MARKET_COINS.includes(id as (typeof CORE_MARKET_COINS)[number]),
  );
  writePreferredCoins([...core, ...extras]);
}

/** @deprecated use readWatchedCoins */
export function readExtraCoins() {
  return extraCoinsState.value;
}

export function extraMarketCoins(coins: string[] = readWatchedCoins()) {
  return coins.filter((id) => !CORE_MARKET_COINS.includes(id as (typeof CORE_MARKET_COINS)[number]));
}

export function preferredCoinFilterOptions() {
  return preferredCoinsState.value.map((value) => ({
    value,
    label: displayAsset(value),
    exotic: isExoticAsset(value),
  }));
}

export function coinMatchesWatch(coin: string | undefined | null, watched: string[] = readWatchedCoins()) {
  const key = normalizeCoinId(String(coin || ''));
  if (!key || !watched.length) return false;
  return watched.some((item) => {
    const watch = normalizeCoinId(item);
    if (!watch) return false;
    if (key === watch) return true;
    if (key === `U${watch}` || key === `K${watch}`) return true;
    if (key.endsWith(watch) && key.length <= watch.length + 4) return true;
    const stripped = key.replace(/^U/, '').replace(/^K/, '');
    return stripped === watch;
  });
}
