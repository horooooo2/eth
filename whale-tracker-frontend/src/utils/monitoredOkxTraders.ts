import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';

export const MONITORED_OKX_KEY = 'whale-tracker-monitored-okx-traders';

function readMonitoredFromStorage(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(MONITORED_OKX_KEY) || '[]');
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

export const monitoredOkxIds = ref<string[]>(readMonitoredFromStorage());

export const monitoredOkxCount = computed(() => monitoredOkxIds.value.length);

export function isOkxTraderMonitored(id: string) {
  return monitoredOkxIds.value.includes(id);
}

export function writeMonitoredOkxTraders(ids: string[]) {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const item of ids) {
    const id = String(item || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  monitoredOkxIds.value = next;
  localStorage.setItem(MONITORED_OKX_KEY, JSON.stringify(next));
}

export function toggleOkxTraderMonitor(id: string): boolean {
  const key = String(id || '').trim();
  if (!key) return false;
  if (isOkxTraderMonitored(key)) {
    writeMonitoredOkxTraders(monitoredOkxIds.value.filter((item) => item !== key));
    ElMessage.success('已取消关注');
    return true;
  }
  writeMonitoredOkxTraders([...monitoredOkxIds.value, key]);
  ElMessage.success('已关注');
  return true;
}
