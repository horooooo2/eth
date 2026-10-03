import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  fetchWhalesBatch,
  refreshWhaleById,
  fetchPersistedAlertHistory,
} from '@/api';
import type { WhaleProfile, WhaleTrade, WhalePosition } from '@/types';
import {
  alertEventTime,
  alertKindLabel,
  filterRecentAlerts,
  isTrackedAlertKind,
  mergeDockAlerts,
  normalizeStoredAlert,
  type WhaleAlert,
} from '@/utils/whaleAlerts';
import { isWhaleMonitored } from '@/utils/monitoredWhales';
import {
  DISPLAY_TOP_N,
  pickDisplayWhales,
  pickReplacementWhale,
  sortWhalesForDisplay,
} from '@/utils/topWhales';

/** 前端只缓存服务器异动；异动生成和持久化由服务器负责。 */
const HISTORY_KEY = 'whale-tracker-alert-history-v3';
const LEGACY_HISTORY_KEYS = ['whale-tracker-alert-history', 'whale-tracker-alert-history-v2'];
const MAX_HISTORY = 3000;
const PENDING_REFRESH_ERROR = '等待刷新';
const ACTIVITY_MAX = 3000;
const ACTIVITY_POLL_MS = 60_000;
/** v4：异动不再前端分页刷 /trades */



function isPendingPlaceholder(whale: WhaleProfile) {
  return whale.error === PENDING_REFRESH_ERROR;
}

function hasPendingPlaceholders(list: WhaleProfile[]) {
  return list.some(isPendingPlaceholder);
}

function isPositionDiffAlert(alert: WhaleAlert) {
  if (!isTrackedAlertKind(alert.kind)) return false;
  const id = String(alert.id || '');
  // 丢弃旧版补种 / 平仓反推；保留 backfill- 开仓补仓回填
  if (id.startsWith('seed-') || id.startsWith('fill-close-') || id.startsWith('close-fill-')) {
    return false;
  }
  if (id.startsWith('fill-') && !id.startsWith('fill-open') && !id.startsWith('fill-increase')) {
    return false;
  }
  return alert.layer !== 'transfer' && alert.layer !== 'fill';
}

function purgeLegacyAlertHistory() {
  try {
    for (const key of LEGACY_HISTORY_KEYS) {
      localStorage.removeItem(key);
    }
  } catch {
    // ignore
  }
}

function readAlertHistory(): WhaleAlert[] {
  purgeLegacyAlertHistory();
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    const items = Array.isArray(raw) ? raw : [];
    return filterRecentAlerts(
      items
        .map((item) => normalizeStoredAlert(item as WhaleAlert))
        .filter((item): item is WhaleAlert => Boolean(item && isPositionDiffAlert(item))),
    ).sort((a, b) => alertEventTime(b) - alertEventTime(a));
  } catch {
    return [];
  }
}

function writeAlertHistory(items: WhaleAlert[]) {
  const recent = filterRecentAlerts(items.filter(isPositionDiffAlert))
    .sort((a, b) => alertEventTime(b) - alertEventTime(a))
    .slice(0, MAX_HISTORY);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(recent));
  } catch {
    // Keep the in-memory history usable when browser storage is full/unavailable.
  }
}

function sortWhalesHf(list: WhaleProfile[]) {
  return sortWhalesForDisplay(list);
}

export const useWhaleStore = defineStore('whale', () => {
  const whales = ref<WhaleProfile[]>([]);
  const activity = ref<WhaleTrade[]>([]);
  const warnings = ref<string[]>([]);
  const updatedAt = ref(0);
  const stale = ref(false);
  const loading = ref(false);
  const loadProgress = ref<{ loaded: number; total: number } | null>(null);
  const loadProgressAt = ref(0);
  const error = ref('');
  const refreshingWhaleIds = ref<Record<string, boolean>>({});
  const alertPolling = ref(false);
  const activityPolling = ref(false);
  let activityPollTimer: number | undefined;
  let loadSeq = 0;
  const selectedWhaleId = ref('');
  const selectedWhaleName = ref('');
  const alerts = ref<WhaleAlert[]>([]);
  const alertHistory = ref<WhaleAlert[]>(readAlertHistory());
  /** 实时异动序号。 */
  const alertRealtimeSeq = ref(0);
  /** 活动流最新一条时间，用于增量拉取 */
  const activityLastSeenTime = ref(0);
  /** 当前列表展示的 20 个 id（稳定，不因静默刷新重排） */
  const displayIds = ref<string[]>([]);
  const backfillRunning = ref(false);
  const alertBackfillDone = ref(false);
  let backfillSeq = 0;
  let alertHydrateStarted = false;
  let alertHistoryFetch: Promise<void> | null = null;

  async function syncAlertHistoryFromServer() {
    if (typeof window === 'undefined') return;
    if (alertHistoryFetch) return alertHistoryFetch;
    const realtimeSeq = alertRealtimeSeq.value;
    alertHistoryFetch = (async () => {
      try {
        const data = await fetchPersistedAlertHistory(300);
        const remote = (data.alerts || [])
          .map((item) => normalizeStoredAlert(item as WhaleAlert))
          .filter((item): item is WhaleAlert => Boolean(item && isPositionDiffAlert(item)));
        const serverRows = filterRecentAlerts(remote)
          .sort((a, b) => alertEventTime(b) - alertEventTime(a));
        // 如果请求期间收到 WS 新事件，把新事件合并进快照，避免旧响应覆盖它。
        const current = !alertHydrateStarted || alertRealtimeSeq.value === realtimeSeq
          ? serverRows
          : [...serverRows, ...alertHistory.value];
        alertHydrateStarted = true;
        const map = new Map(current.map((item) => [item.id, item]));
        alertHistory.value = [...map.values()]
          .sort((a, b) => alertEventTime(b) - alertEventTime(a))
          .slice(0, MAX_HISTORY);
        writeAlertHistory(alertHistory.value);
      } catch {
        // 保留缓存数据，待下一次轮询重试。
      } finally {
        alertHistoryFetch = null;
      }
    })();
    return alertHistoryFetch;
  }


  const enabledWhales = computed(() =>
    whales.value.filter((item) => item.enabled !== false),
  );

  function hasAnyOpenPosition(whale: WhaleProfile | null | undefined) {
    return Boolean(whale?.positions?.some((position) => Math.abs(Number(position.size) || 0) > 0));
  }

  const whalesWithPositions = computed(() => enabledWhales.value.filter(hasAnyOpenPosition));

  const rankedWhales = computed(() => sortWhalesHf(whales.value));

  const displayWhales = computed(() => {
    if (!displayIds.value.length) {
      return pickDisplayWhales(whalesWithPositions.value, { limit: DISPLAY_TOP_N });
    }
    const byId = new Map(whales.value.map((item) => [item.id, item]));
    return displayIds.value
      .map((id) => byId.get(id))
      .filter((item): item is WhaleProfile => Boolean(item && item.enabled !== false && hasAnyOpenPosition(item)));
  });

  function ensureDisplayRoster(force = false) {
    const activeIds = new Set(whalesWithPositions.value.map((item) => item.id));
    if (!force) displayIds.value = displayIds.value.filter((id) => activeIds.has(id));
    if (!force && displayIds.value.length >= Math.min(DISPLAY_TOP_N, whalesWithPositions.value.length)) {
      // 用最新对象刷新，但保持 id 顺序；踢出后缺额时补人
      if (displayIds.value.length < DISPLAY_TOP_N && whalesWithPositions.value.length > displayIds.value.length) {
        const next = pickDisplayWhales(whalesWithPositions.value, {
          limit: DISPLAY_TOP_N,
          preferIds: displayIds.value,
        });
        displayIds.value = next.map((item) => item.id);
      }
      return;
    }
    displayIds.value = pickDisplayWhales(whalesWithPositions.value, {
      limit: DISPLAY_TOP_N,
      preferIds: displayIds.value,
    }).map((item) => item.id);
  }

  async function replaceDisplayWhale(removeId: string) {
    const key = String(removeId || '');
    if (!key) return null;
    const pool = whalesWithPositions.value;
    const current = displayIds.value.length ? displayIds.value : displayWhales.value.map((w) => w.id);
    const replacement = pickReplacementWhale(pool, current, key);
    if (!replacement) return null;
    displayIds.value = [...current.filter((id) => id !== key), replacement.id].slice(0, DISPLAY_TOP_N);
    try {
      await refreshWhale(replacement.id);
    } catch {
      // 列表已换人；失败可点卡片重试
    }
    void backfillAlertsForWhales([replacement]);
    return replacement;
  }

  /**
   * 定位 / 监控跳转：若目标不在当前 Top20，插到列表最前（挤掉末位），保证能滚到卡片。
   */
  function ensureWhaleInDisplay(whaleId: string) {
    const id = String(whaleId || '');
    if (!id) return false;
    const whale = whales.value.find((item) => item.id === id && item.enabled !== false);
    if (!hasAnyOpenPosition(whale)) return false;
    if (!displayIds.value.length) ensureDisplayRoster(true);
    if (displayIds.value.includes(id)) return true;
    displayIds.value = [id, ...displayIds.value.filter((item) => item !== id)].slice(0, DISPLAY_TOP_N);
    return true;
  }

  function patchWhalePosition(
    whaleId: string,
    coin: string,
    side: 'long' | 'short' | '',
    patch: Partial<WhalePosition>,
  ) {
    const idx = whales.value.findIndex((item) => item.id === whaleId);
    if (idx < 0) return;
    const whale = whales.value[idx];
    const coinKey = String(coin || '').toUpperCase();
    const positions = (whale.positions || []).map((pos) => {
      const sameCoin =
        String(pos.coin || '').toUpperCase() === coinKey ||
        String(pos.coinLabel || '').toUpperCase() === coinKey;
      const sameSide = !side || pos.side === side;
      if (!sameCoin || !sameSide) return pos;
      return { ...pos, ...patch };
    });
    const next = whales.value.slice();
    next[idx] = { ...whale, positions };
    whales.value = next;
  }

  function filterDockAlerts(entries: WhaleAlert[]) {
    // 只监控关注列表中的巨鲸
    const mapped = entries
      .map((alert) => {
        if (!isTrackedAlertKind(alert.kind)) return null;
        if (!isWhaleMonitored(alert.whaleId)) return null;
        let items = (alert.items || []).filter(
          (item) => isTrackedAlertKind(item.kind) || item.kind === alert.kind,
        );
        if (!items.length) return null;
        const lead = items[0];
        return {
          ...alert,
          items,
          kind: lead.kind,
          kindLabel:
            items.length > 1
              ? `${alertKindLabel(lead.kind)}（多单）`
              : alertKindLabel(lead.kind),
          headline:
            items.length > 1 ? `${lead.title}（${items.length} 笔）` : lead.title,
          monitored: true,
          watchType: 'whale' as const,
        } as WhaleAlert & { monitored?: boolean; watchType?: 'whale' | 'position' };
      })
      .filter(Boolean) as Array<WhaleAlert & { monitored?: boolean; watchType?: 'whale' | 'position' }>;

    return mapped.sort((a, b) => alertEventTime(b) - alertEventTime(a));
  }

  function mergeAlertHistory(entries: WhaleAlert[]) {
    const map = new Map<string, WhaleAlert>();
    // 同 ID 的服务端/本地更新以本次传入的最新版本为准；旧写法先写新值再写
    // 历史值，会让旧时间和旧详情反向覆盖最新事件。
    for (const item of [...alertHistory.value, ...entries]) {
      const normalized = normalizeStoredAlert(item);
      if (!normalized?.id || !isPositionDiffAlert(normalized)) continue;
      map.set(normalized.id, normalized);
    }
    alertHistory.value = filterRecentAlerts([...map.values()])
      .sort((a, b) => alertEventTime(b) - alertEventTime(a))
      .slice(0, MAX_HISTORY);
    writeAlertHistory(alertHistory.value);
  }

  /** WebSocket 实时成交 */
  function ingestRealtimeFill(trade: WhaleTrade) {
    if (!trade?.id || trade.source === 'onchain') return;
    mergeActivity([trade], false);
  }

  /** WebSocket 实时异动 */
  function ingestRealtimeAlert(alert: WhaleAlert) {
    const normalized = normalizeStoredAlert(alert);
    if (!normalized || !isPositionDiffAlert(normalized)) return;
    mergeAlertHistory([normalized]);
    // Duplicate IDs are legitimate server updates, not a reason to reload the list.
    alertRealtimeSeq.value += 1;
    if (!isTrackedAlertKind(normalized.kind) && !normalized.items?.some((i) => isTrackedAlertKind(i.kind))) {
      return;
    }
    // 同币同向 10s 内合并进监控卡片
    alerts.value = mergeDockAlerts(filterDockAlerts([normalized, ...alerts.value])).slice(0, 100);
  }

  /** WebSocket 仓位补丁 */
  function ingestRealtimeWhalePatch(whaleId: string, patch: Partial<WhaleProfile>) {
    const id = String(whaleId || '');
    if (!id || !patch) return;
    const idx = whales.value.findIndex((item) => item.id === id);
    if (idx < 0) return;
    const prev = whales.value[idx];
    const next = whales.value.slice();
    next[idx] = { ...prev, ...patch, id } as WhaleProfile;
    whales.value = next;
    if (hasAnyOpenPosition(next[idx])) ensureWhaleInDisplay(id);
    ensureDisplayRoster(true);
    // 异动只由服务器采集、落库和广播；此处只更新仓位视图。
  }

  function dismissAlert(id: string) {
    alerts.value = alerts.value.filter((item) => item.id !== id);
  }

  function clearAlerts() {
    alerts.value = [];
  }

  function tradeDedupKey(trade: WhaleTrade) {
    return String(trade.id || trade.hash || `${trade.whaleId}-${trade.time}-${trade.asset}-${trade.side}`);
  }

  /** 按 tid/hash 去重合并，新记录在前，截断到窗口上限 */
  function mergeActivity(incoming: WhaleTrade[], replace = false) {
    const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const map = new Map<string, WhaleTrade>();
    const base = replace ? [] : activity.value;
    for (const item of [...incoming, ...base]) {
      if (!item || (Number(item.time) || 0) < cutoff) continue;
      const key = tradeDedupKey(item);
      if (!key) continue;
      if (!map.has(key)) map.set(key, item);
    }
    activity.value = [...map.values()]
      .sort((a, b) => Number(b.time || 0) - Number(a.time || 0))
      .slice(0, ACTIVITY_MAX);
    if (activity.value.length) {
      activityLastSeenTime.value = Math.max(
        activityLastSeenTime.value,
        Number(activity.value[0].time) || 0,
      );
    }
  }

  function applyWhalePayload(
    data: {
      whales?: WhaleProfile[];
      activity?: WhaleTrade[];
      warnings?: string[];
      updatedAt?: number;
      stale?: boolean;
      done?: boolean;
      progressive?: boolean;
      total?: number;
    },
    options: { merge?: boolean; replaceActivity?: boolean } = {},
  ) {
    const nextWhales = data.whales || [];
    const nextActivity = data.activity || [];
    // 空结果（越界批次/后端会话新建）不允许清空已有列表
    if (!nextWhales.length && whales.value.length) return;

    const incomingCount = nextWhales.length;
    const currentCount = whales.value.length;
    const total = Number(data.total) || 0;
    let merge = Boolean(options.merge);
    if (!merge && currentCount > 0 && incomingCount > 0) {
      // 分段/静默返回的是子集：禁止用更短列表覆盖完整列表
      if (data.progressive && !data.done) merge = true;
      else if (incomingCount < currentCount) merge = true;
      else if (total > 0 && incomingCount < total) merge = true;
    }

    let mergedWhales = nextWhales;
    if (merge) {
      const updates = new Map(nextWhales.map((item) => [item.id, item]));
      mergedWhales = whales.value.map((item) => {
        const next = updates.get(item.id);
        if (!next) return item;
        // 磁盘占位不能覆盖内存里已拉到的真实数据
        if (isPendingPlaceholder(next) && !isPendingPlaceholder(item)) return item;
        return next;
      });
      const seen = new Set(mergedWhales.map((item) => item.id));
      for (const item of nextWhales) {
        if (!seen.has(item.id)) mergedWhales.push(item);
      }
    } else if (whales.value.length) {
      // 全量替换时同样避免用「等待刷新」回退已成功的条目
      const prev = new Map(whales.value.map((item) => [item.id, item]));
      mergedWhales = nextWhales.map((item) => {
        const old = prev.get(item.id);
        if (old && isPendingPlaceholder(item) && !isPendingPlaceholder(old)) return old;
        return item;
      });
    }

    // 分段未结束时只合并增量成交；结束或全量时去重累积（硬刷新可 replace）
    if (nextActivity.length) {
      if (!merge || data.done || options.replaceActivity) {
        mergeActivity(nextActivity, Boolean(options.replaceActivity));
      } else {
        mergeActivity(nextActivity, false);
      }
    }

    whales.value = mergedWhales;
    warnings.value = data.warnings || warnings.value;
    updatedAt.value = data.updatedAt || updatedAt.value;
    stale.value = Boolean(data.stale);

    const rosterReady = !data.progressive || Boolean(data.done);
    if (rosterReady && !hasPendingPlaceholders(mergedWhales)) {
      const wasEmpty = !displayIds.value.length;
      ensureDisplayRoster(wasEmpty);
      if (!alertBackfillDone.value) {
        alertBackfillDone.value = true;
        void scheduleAlertBackfill();
      }
    }
  }

  /**
   * 已废弃：不再为异动去分页拉 /trades（DISPLAY_TOP_N=200 时会刷爆接口）。
   * 异动以服务端 SQLite + 仓位 diff + WS 为准。
   */
  async function backfillAlertsForWhales(_list: WhaleProfile[]) {
    return;
  }

  async function scheduleAlertBackfill() {
    // no-op：保留调用点，避免旧逻辑复活
  }

  function setProgress(value: { loaded: number; total: number } | null) {
    loadProgress.value = value;
    loadProgressAt.value = value ? Date.now() : 0;
  }



  /** Only fetch one server cache page; the UI owns explicit paging. */
  async function load(_refresh = false, silent = false) {
    const seq = ++loadSeq;
    if (!silent) loading.value = true;
    try {
      const data = await fetchWhalesBatch({ offset: 0, limit: 20 });
      if (seq !== loadSeq) return;
      applyWhalePayload(data, { merge: true });
      error.value = '';
    } catch (err) {
      if (seq === loadSeq) error.value = err instanceof Error ? err.message : '巨鲸数据加载失败';
    } finally {
      if (seq === loadSeq) { loading.value = false; setProgress(null); }
    }
  }

  function acceptCachePage(rows: WhaleProfile[]) {
    applyWhalePayload({ whales: rows, done: true }, { merge: true });
  }

  function acceptAlertPage(rows: WhaleAlert[]) {
    const merged = new Map([...alertHistory.value, ...rows].map(row => [row.id, row]));
    alertHistory.value = filterRecentAlerts([...merged.values()]).sort((a, b) => alertEventTime(b) - alertEventTime(a)).slice(0, MAX_HISTORY);
    writeAlertHistory(alertHistory.value);
  }

  function loadWhaleTrades(whale: Pick<WhaleProfile, 'id' | 'name'>) {
    selectedWhaleId.value = whale.id;
    selectedWhaleName.value = whale.name;
  }

  function clearWhaleFilter() {
    selectedWhaleId.value = '';
    selectedWhaleName.value = '';
  }

  /** 点击报错 /「等待刷新」卡片：只重拉该巨鲸，不切换成交筛选 */
  async function refreshWhale(id: string) {
    const key = String(id || '');
    if (!key || refreshingWhaleIds.value[key]) return null;
    refreshingWhaleIds.value = { ...refreshingWhaleIds.value, [key]: true };
    try {
      const data = await refreshWhaleById(key);
      const profile = data.whale;
      if (!profile?.id) throw new Error('刷新结果无效');

      const idx = whales.value.findIndex((item) => item.id === profile.id);
      if (idx >= 0) {
        const next = whales.value.slice();
        next[idx] = profile;
        whales.value = next;
      } else {
        whales.value = [...whales.value, profile];
      }
      if (hasAnyOpenPosition(profile)) ensureWhaleInDisplay(profile.id);
      ensureDisplayRoster(true);

      if (Array.isArray(data.trades)) {
        const others = activity.value.filter((item) => item.whaleId !== profile.id);
        mergeActivity([...data.trades, ...others], true);
      }
      if (data.updatedAt) updatedAt.value = data.updatedAt;
      return profile;
    } finally {
      const next = { ...refreshingWhaleIds.value };
      delete next[key];
      refreshingWhaleIds.value = next;
    }
  }

  /** 已关闭后台成交补历史；保留空实现避免旧调用报错 */
  function ensureAlertHistory() {
    // no-op
  }

  /**
   * 轻量刷新：读缓存并写回列表 / 异动（与 30s 静默轮询同一路径）。
   */
  async function pollAlerts() {
    if (typeof window === 'undefined') return;
    if (alertPolling.value || loading.value) return;
    alertPolling.value = true;
    try {
      await load(false, true);
    } catch {
      // 异动/共振轮询失败保持静默
    } finally {
      alertPolling.value = false;
    }
  }

  /**
   * 已关闭全员成交轮询：开仓提醒走仓位快照 diff（30s 列表刷新 + 后台分片）。
   * 异动仅通过服务器持久化记录和实时消息更新。
   */
  async function pollActivityIncremental() {
    // no-op：保留函数避免旧调用报错
  }

  function startActivityPolling(_intervalMs = ACTIVITY_POLL_MS) {
    stopActivityPolling();
    // 不再 setInterval 拉 /whales/activity
  }

  function stopActivityPolling() {
    if (activityPollTimer) {
      window.clearInterval(activityPollTimer);
      activityPollTimer = undefined;
    }
  }

  /** 硬刷新前清空内存态，避免旧列表数量/顺序残留 */
  function resetForHardRefresh() {
    whales.value = [];
    activity.value = [];
    activityLastSeenTime.value = 0;
    warnings.value = [];
    updatedAt.value = 0;
    stale.value = false;
    error.value = '';
    setProgress(null);
    selectedWhaleId.value = '';
    selectedWhaleName.value = '';
    alerts.value = [];
    alertHistory.value = [];
    refreshingWhaleIds.value = {};
    displayIds.value = [];
    alertBackfillDone.value = false;
    backfillSeq += 1;
    writeAlertHistory([]);
  }

  async function loadAllTrades() {
    selectedWhaleId.value = '';
    selectedWhaleName.value = '';
    // 只读服务器本地缓存，不强制打上游
    await load(false);
  }

  return {
    acceptCachePage,
    acceptAlertPage,
    whales,
    displayWhales,
    displayIds,
    activity,
    activityLastSeenTime,
    warnings,
    updatedAt,
    stale,
    loading,
    loadProgress,
    error,
    refreshingWhaleIds,
    alertPolling,
    activityPolling,
    backfillRunning,
    selectedWhaleId,
    selectedWhaleName,
    alerts,
    alertHistory,
    alertRealtimeSeq,
    enabledWhales,
    rankedWhales,
    load,
    loadWhaleTrades,
    refreshWhale,
    replaceDisplayWhale,
    ensureWhaleInDisplay,
    patchWhalePosition,
    ensureDisplayRoster,
    ensureAlertHistory,
    pollAlerts,
    pollActivityIncremental,
    startActivityPolling,
    stopActivityPolling,
    loadAllTrades,
    syncAlertHistoryFromServer,
    clearWhaleFilter,
    resetForHardRefresh,
    dismissAlert,
    clearAlerts,
    ingestRealtimeFill,
    ingestRealtimeAlert,
    ingestRealtimeWhalePatch,
  };
});
