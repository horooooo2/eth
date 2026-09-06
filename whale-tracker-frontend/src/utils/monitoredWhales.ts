import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';

export const MONITORED_WHALES_KEY = 'whale-tracker-monitored-whales';

function readMonitoredFromStorage(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(MONITORED_WHALES_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const next: string[] = [];
    for (const item of raw) {
      const id = String(item || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      next.push(id);
    }
    return next;
  } catch {
    return [];
  }
}

export const monitoredWhaleIds = ref<string[]>(readMonitoredFromStorage());

export const monitoredCount = computed(() => monitoredWhaleIds.value.length);

export function isWhaleMonitored(id: string) {
  return monitoredWhaleIds.value.includes(id);
}

export function writeMonitoredWhales(ids: string[]) {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const item of ids) {
    const id = String(item || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  monitoredWhaleIds.value = next;
  localStorage.setItem(MONITORED_WHALES_KEY, JSON.stringify(next));
}

/** 切换关注；成功返回 true */
export function toggleWhaleMonitor(id: string): boolean {
  const key = String(id || '').trim();
  if (!key) return false;
  if (isWhaleMonitored(key)) {
    writeMonitoredWhales(monitoredWhaleIds.value.filter((item) => item !== key));
    ElMessage.success('已取消关注');
    return true;
  }
  writeMonitoredWhales([...monitoredWhaleIds.value, key]);
  ElMessage.success('已关注');
  return true;
}
