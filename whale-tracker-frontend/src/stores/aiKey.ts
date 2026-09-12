import { computed, ref, watch } from 'vue';
import {
  deleteWhaleAiKey,
  fetchWhaleAiKeyStatus,
  saveWhaleAiKey,
  type WhaleAiKeyStatus,
} from '@/api';
import { isLoggedIn } from '@/stores/auth';

/**
 * Per-user DeepSeek key used by the generic data-analysis feature (news, X, whale
 * data). The backend routes are still named `/api/whale-ai/key` for compatibility.
 */
const status = ref<WhaleAiKeyStatus | null>(null);
const loading = ref(false);
let inflight: Promise<WhaleAiKeyStatus | null> | null = null;

export const aiKeyStatus = computed(() => status.value);
export const aiKeyReady = computed(() => Boolean(status.value?.ready || status.value?.configured));
export const aiKeyHint = computed(() => status.value?.apiKeyHint || '');
export const aiKeyLoading = computed(() => loading.value);

export function clearAiKeyStatus() {
  status.value = null;
}

export async function refreshAiKeyStatus(force = false) {
  if (!isLoggedIn.value) {
    status.value = null;
    return null;
  }
  if (inflight && !force) return inflight;
  loading.value = true;
  inflight = (async () => {
    try {
      const data = await fetchWhaleAiKeyStatus();
      status.value = data;
      return data;
    } catch {
      return status.value;
    } finally {
      loading.value = false;
      inflight = null;
    }
  })();
  return inflight;
}

export async function bindAiKey(apiKey: string) {
  const data = await saveWhaleAiKey(apiKey);
  status.value = {
    provider: data.provider,
    configured: data.configured,
    apiKeyHint: data.apiKeyHint,
    updatedAt: data.updatedAt,
    ready: data.ready,
  };
  return data;
}

export async function unbindAiKey() {
  const data = await deleteWhaleAiKey();
  status.value = {
    provider: data.provider,
    configured: data.configured,
    apiKeyHint: data.apiKeyHint,
    updatedAt: data.updatedAt,
    ready: data.ready,
  };
  return data;
}

watch(
  isLoggedIn,
  (logged) => {
    if (logged) void refreshAiKeyStatus(true);
    else clearAiKeyStatus();
  },
  { immediate: true },
);
