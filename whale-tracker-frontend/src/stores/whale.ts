import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import { fetchWhaleBootstrap } from '@/api';
import type { WhalePosition, WhaleProfile, WhaleTrade } from '@/types';
import { isTrackedAlertKind, type WhaleAlert } from '@/utils/whaleAlerts';
import { isWhaleMonitored } from '@/utils/monitoredWhales';
import { visibleWhalePositions } from '@/utils/whaleCardUtils';
import { emptyWhaleState, stateFromBootstrap, reduceStateCommit, mergeAlertQuery, recentAlerts, canApplyDetailResponse, notificationIds,
  type StateCursor, type WhaleStateCommit } from '@/utils/whaleState';

/** Network input is reduced once; components keep IDs, never entity copies. */
export const useWhaleStore = defineStore('whale', () => {
  const state = shallowRef(emptyWhaleState());
  const loading = ref(false);
  const error = ref('');
  const synced = ref(false);
  const selectedWhaleId = ref('');
  const selectedWhaleName = ref('');
  const activity = ref<WhaleTrade[]>([]);
  const refreshingWhaleIds = ref<Record<string, boolean>>({});
  const dismissedAlertIds = ref(new Set<string>());
  const liveAlertIds = ref<string[]>([]);
  const alertRealtimeSeq = ref(0);
  let bootstrapPromise: Promise<void> | null = null;
  let generation = 0;

  const whalesById = computed(() => state.value.whalesById);
  const alertsById = computed(() => state.value.alertsById);
  const whales = computed(() => Object.values(whalesById.value));
  const enabledWhales = computed(() => whales.value.filter(whale => whale.enabled !== false));
  const displayWhales = computed(() => enabledWhales.value.filter(whale => !whale.error && visibleWhalePositions(whale, 'all').length));
  const alertHistory = computed(() => recentAlerts(Object.values(alertsById.value)));
  const alerts = computed(() => liveAlertIds.value.map(id => alertsById.value[id])
    .filter((alert): alert is WhaleAlert => Boolean(alert && !dismissedAlertIds.value.has(alert.id)
      && isWhaleMonitored(alert.whaleId) && isTrackedAlertKind(alert.kind))));
  const updatedAt = computed(() => state.value.updatedAt);
  const summary = computed(() => state.value.summary);
  const revision = computed(() => state.value.seq);
  const epoch = computed(() => state.value.epoch);
  const minimumAlertQuerySeq = computed(() => state.value.minimumAlertQuerySeq);
  const cursor = (): StateCursor => ({ epoch: state.value.epoch, seq: state.value.seq });

  function bootstrap() {
    if (bootstrapPromise) return bootstrapPromise;
    const requestGeneration = generation;
    const requestedCursor = cursor();
    loading.value = true;
    synced.value = false;
    bootstrapPromise = (async () => {
      try {
        const payload = await fetchWhaleBootstrap();
        if (requestGeneration !== generation) return;
        if (payload.epoch === state.value.epoch && payload.seq < state.value.seq) return;
        if (state.value.epoch !== requestedCursor.epoch && state.value.epoch !== payload.epoch) return;
        state.value = stateFromBootstrap(payload);
        liveAlertIds.value = liveAlertIds.value.filter(id => Boolean(state.value.alertsById[id]));
        error.value = '';
      } catch (err) {
        if (requestGeneration === generation) error.value = err instanceof Error ? err.message : '巨鲸快照加载失败';
        throw err;
      } finally {
        if (requestGeneration === generation) { loading.value = false; bootstrapPromise = null; }
      }
    })();
    return bootstrapPromise;
  }

  function applyCommit(commit: WhaleStateCommit) {
    const freshIds = notificationIds(state.value, commit, synced.value, Date.now());
    const result = reduceStateCommit(state.value, commit);
    if (result.status === 'resync') synced.value = false;
    if (result.status !== 'applied') return result.status;
    state.value = result.state;
    if (commit.alerts?.length || commit.removedAlertIds?.length) {
      liveAlertIds.value = [...new Set([...freshIds, ...liveAlertIds.value])]
        .filter(id => Boolean(state.value.alertsById[id])).slice(0, 100);
      alertRealtimeSeq.value += 1;
    }
    return result.status;
  }

  function acceptAlertPage(rows: WhaleAlert[], responseCursor: StateCursor) {
    const merged = mergeAlertQuery(state.value, rows, responseCursor);
    if (!merged) return false;
    state.value = merged;
    return true;
  }

  function patchWhalePosition(id: string, coin: string, side: 'long' | 'short' | '', patch: Partial<WhalePosition>, requested?: WhaleProfile) {
    const whale = whalesById.value[id];
    if (!canApplyDetailResponse(whale, requested)) return false;
    const positions = whale!.positions.map(position => {
      const matches = [position.coin, position.coinLabel].some(value => String(value || '').toUpperCase() === coin.toUpperCase());
      return matches && (!side || position.side === side) ? { ...position, ...patch } : position;
    });
    state.value = { ...state.value, whalesById: { ...whalesById.value, [id]: { ...whale!, positions } } };
    return true;
  }

  function loadWhaleTrades(whale: Pick<WhaleProfile, 'id' | 'name'>) {
    selectedWhaleId.value = whale.id;
    selectedWhaleName.value = whale.name;
  }
  function clearWhaleFilter() { selectedWhaleId.value = ''; selectedWhaleName.value = ''; }
  function dismissAlert(id: string) { dismissedAlertIds.value = new Set([...dismissedAlertIds.value, id]); }
  function clearAlerts() { liveAlertIds.value = []; }
  function resetForHardRefresh() {
    generation += 1; bootstrapPromise = null; loading.value = false; synced.value = false;
    state.value = emptyWhaleState(); activity.value = []; clearWhaleFilter(); clearAlerts();
    dismissedAlertIds.value = new Set(); error.value = '';
  }
  return {
    whalesById, alertsById, whales, enabledWhales, displayWhales, alertHistory, alerts,
    activity, refreshingWhaleIds, loading, error, updatedAt, summary, revision, epoch, synced,
    selectedWhaleId, selectedWhaleName, alertRealtimeSeq,
    cursor, bootstrap, applyCommit, acceptAlertPage, patchWhalePosition, minimumAlertQuerySeq,
    loadWhaleTrades, clearWhaleFilter, dismissAlert, clearAlerts, resetForHardRefresh,
  };
});
