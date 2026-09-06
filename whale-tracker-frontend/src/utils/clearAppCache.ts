import { writeMonitoredPositions } from '@/utils/monitoredPositions';
import { writeMonitoredWhales } from '@/utils/monitoredWhales';
import { FRESH_HOURS_KEY, FRESH_MODE_KEY } from '@/utils/freshMode';
import { PREFERRED_COINS_KEY } from '@/utils/watchedCoins';

const KEEP_KEYS = new Set([PREFERRED_COINS_KEY, FRESH_MODE_KEY, FRESH_HOURS_KEY]);

function clearStorage(storage: Storage) {
  const toRemove: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (!key) continue;
    if (!key.startsWith('whale-tracker-')) continue;
    if (KEEP_KEYS.has(key)) continue;
    toRemove.push(key);
  }
  for (const key of toRemove) storage.removeItem(key);
}

/**
 * 清除本站本地缓存，仅保留币种偏好。
 * 同时重置监控列表的内存状态，避免界面仍显示旧监控。
 */
export function clearAppLocalCache() {
  if (typeof localStorage !== 'undefined') clearStorage(localStorage);
  if (typeof sessionStorage !== 'undefined') clearStorage(sessionStorage);
  writeMonitoredWhales([]);
  writeMonitoredPositions([]);
}
