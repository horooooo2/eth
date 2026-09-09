import { computed, ref } from 'vue';

/** 异工作区未读：按「开单人数」计（去重 id） */
const hlPendingIds = ref<string[]>([]);

export const hlWorkspaceBadge = computed(() => hlPendingIds.value.length);

function pushUnique(list: string[], id: string) {
  const key = String(id || '').trim();
  if (!key || list.includes(key)) return false;
  list.push(key);
  return true;
}

export function noteHlWorkspacePending(whaleId: string) {
  const next = [...hlPendingIds.value];
  if (pushUnique(next, whaleId)) hlPendingIds.value = next;
}

export function clearHlWorkspaceBadge() {
  hlPendingIds.value = [];
}

export function formatWorkspaceBadge(n: number) {
  if (n <= 0) return '';
  return n > 99 ? '99+' : String(n);
}
