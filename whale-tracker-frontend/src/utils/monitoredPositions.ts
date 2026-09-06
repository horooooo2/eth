import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { whaleCoinKey } from '@/utils/whaleCardUtils';

export const MONITORED_POSITIONS_KEY = 'whale-tracker-monitored-positions';

export interface MonitoredPosition {
  whaleId: string;
  coin: string;
  side: 'long' | 'short';
}

function normalizeKey(whaleId: string, coin: string, side: 'long' | 'short') {
  return `${String(whaleId || '').trim()}|${whaleCoinKey(coin)}|${side}`;
}

function readMonitoredPositions(): MonitoredPosition[] {
  try {
    const raw = JSON.parse(localStorage.getItem(MONITORED_POSITIONS_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const next: MonitoredPosition[] = [];
    for (const item of raw) {
      const whaleId = String(item?.whaleId || '').trim();
      const coin = whaleCoinKey(item?.coin || '');
      const side = item?.side === 'short' ? 'short' : item?.side === 'long' ? 'long' : '';
      if (!whaleId || !coin || !side) continue;
      const key = normalizeKey(whaleId, coin, side);
      if (seen.has(key)) continue;
      seen.add(key);
      next.push({ whaleId, coin, side });
    }
    return next;
  } catch {
    return [];
  }
}

export const monitoredPositions = ref<MonitoredPosition[]>(readMonitoredPositions());

export const monitoredPositionCount = computed(() => monitoredPositions.value.length);

export function isPositionMonitored(
  whaleId: string,
  coin: string,
  side: 'long' | 'short',
) {
  const key = normalizeKey(whaleId, coin, side);
  return monitoredPositions.value.some(
    (item) => normalizeKey(item.whaleId, item.coin, item.side) === key,
  );
}

export function writeMonitoredPositions(items: MonitoredPosition[]) {
  const seen = new Set<string>();
  const next: MonitoredPosition[] = [];
  for (const item of items) {
    const whaleId = String(item.whaleId || '').trim();
    const coin = whaleCoinKey(item.coin);
    const side = item.side === 'short' ? 'short' : 'long';
    if (!whaleId || !coin) continue;
    const key = normalizeKey(whaleId, coin, side);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push({ whaleId, coin, side });
  }
  monitoredPositions.value = next;
  localStorage.setItem(MONITORED_POSITIONS_KEY, JSON.stringify(next));
}

export function togglePositionMonitor(
  whaleId: string,
  coin: string,
  side: 'long' | 'short',
): boolean {
  const key = normalizeKey(whaleId, coin, side);
  if (isPositionMonitored(whaleId, coin, side)) {
    writeMonitoredPositions(
      monitoredPositions.value.filter(
        (item) => normalizeKey(item.whaleId, item.coin, item.side) !== key,
      ),
    );
    ElMessage.success('已取消仓位监控');
    return true;
  }
  writeMonitoredPositions([...monitoredPositions.value, { whaleId, coin: whaleCoinKey(coin), side }]);
  ElMessage.success('已加入仓位监控');
  return true;
}

export function alertMatchesPositionMonitor(
  whaleId: string,
  items: Array<{ coin?: string; side?: 'long' | 'short' }> = [],
) {
  return items.some((item) => {
    if (!item.coin || !item.side) return false;
    return isPositionMonitored(whaleId, item.coin, item.side);
  });
}
