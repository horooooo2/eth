import { onMounted, onUnmounted, ref, watch } from 'vue';
import { fetchQuotes } from '@/api';
import { useNewsStore } from '@/stores/news';
import { useWhaleStore } from '@/stores/whale';
import { bootstrapAuth, getAuthUiSettings } from '@/stores/auth';
import { useRealtime } from '@/composables/useRealtime';
import type { RecoQuotes } from '@/utils/recommend';
import { preferredCoinsState } from '@/utils/watchedCoins';
import { unlockAlertSound } from '@/utils/alertSound';
import type { WhaleAlert } from '@/utils/whaleAlerts';
import type { WhaleProfile, WhaleTrade } from '@/types';

/** 根 App 调用一次：鉴权、拉数、WS、行情轮询 */
export function useDashboardBootstrap() {
  const whaleStore = useWhaleStore();
  const newsStore = useNewsStore();
  const quotes = ref<RecoQuotes>({});
  const fundingRates = ref<Record<string, number>>({});
  let timer: number | undefined;

  const { start, stop } = useRealtime((msg) => {
    if (msg.type === 'fill' && msg.trade) {
      whaleStore.ingestRealtimeFill(msg.trade as unknown as WhaleTrade);
    } else if (msg.type === 'alert' && msg.alert) {
      whaleStore.ingestRealtimeAlert(msg.alert as unknown as WhaleAlert);
    } else if (msg.type === 'whalePatch' && msg.whaleId && msg.patch) {
      whaleStore.ingestRealtimeWhalePatch(msg.whaleId, msg.patch as Partial<WhaleProfile>);
    }
  });

  async function loadQuotes() {
    const next = await fetchQuotes(preferredCoinsState.value).catch(() => null);
    if (!next) return;
    const { funding, updatedAt: _updatedAt, ...prices } = next;
    const nextQuotes: RecoQuotes = {};
    for (const [key, value] of Object.entries(prices)) {
      if (typeof value === 'number' && Number.isFinite(value)) nextQuotes[key] = value;
    }
    quotes.value = nextQuotes;
    if (funding && typeof funding === 'object') fundingRates.value = funding;
  }

  async function loadAll(refresh = false, silent = false) {
    await Promise.all([
      whaleStore.load(refresh, silent),
      newsStore.load(refresh, silent),
      loadQuotes(),
    ]);
  }

  async function pollNewsAndQuotes() {
    await Promise.all([newsStore.load(false, true), loadQuotes()]);
  }

  onMounted(async () => {
    document.documentElement.classList.add('dark');
    document.documentElement.classList.remove('light');
    unlockAlertSound();
    await bootstrapAuth();
    void getAuthUiSettings();
    await loadAll(false);
    whaleStore.startActivityPolling();
    start();
    timer = window.setInterval(() => {
      void pollNewsAndQuotes();
    }, 60 * 1000);
  });

  onUnmounted(() => {
    if (timer) window.clearInterval(timer);
    whaleStore.stopActivityPolling();
    stop();
  });

  watch(
    preferredCoinsState,
    () => {
      void loadQuotes();
    },
    { deep: true },
  );

  return {
    whaleStore,
    newsStore,
    quotes,
    fundingRates,
    loadQuotes,
    loadAll,
  };
}
