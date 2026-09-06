import { normalizeCoinId, readPrimaryCoin, readWatchedCoins } from '@/utils/watchedCoins';

const RANGE_KEY = 'whale-tracker-reco-window';
const OLD_RANGE_KEY = 'whale-tracker-reco-24h';
const DECAY_KEY = 'whale-tracker-reco-decay';
const COIN_KEY = 'whale-tracker-reco-coin';
export { RANGE_KEY, DECAY_KEY, COIN_KEY };
export const DAY_MS = 24 * 60 * 60 * 1000;

export const RANGE_OPTIONS = [
  { key: '24h', label: '24h', ms: DAY_MS },
  { key: '3d', label: '3天', ms: 3 * DAY_MS },
  { key: '7d', label: '7天', ms: 7 * DAY_MS },
] as const;

export type RangeKey = (typeof RANGE_OPTIONS)[number]['key'];
export type FocusCoin = string;

export function readRangeKey(): RangeKey | '' {
  const saved = localStorage.getItem(RANGE_KEY);
  if (saved === '24h' || saved === '3d' || saved === '7d') return saved;
  if (saved === '24' || localStorage.getItem(OLD_RANGE_KEY) === '1') return '24h';
  if (saved === '30d' || saved === '48' || saved === '72') return '7d';
  return '';
}

export function readDecay(): boolean {
  return localStorage.getItem(DECAY_KEY) !== '0';
}

export function readFocusCoin(): FocusCoin {
  const preferred = readWatchedCoins();
  const saved = normalizeCoinId(localStorage.getItem(COIN_KEY) || '');
  if (saved && preferred.includes(saved)) return saved;
  return readPrimaryCoin();
}

export function activeRangeMs(key: RangeKey | '') {
  return RANGE_OPTIONS.find((item) => item.key === key)?.ms;
}
