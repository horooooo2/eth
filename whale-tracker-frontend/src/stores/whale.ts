import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import {
  fetchWhales,
  fetchWhalesBatch,
  refreshWhaleById,
  fetchPersistedAlertHistory,
  pushPersistedAlertHistory,
  isRetryableLoadError,
  retryableErrorText,
  scheduleSilentRetry,
  withRetrySuffix,
} from '@/api';
import type { WhaleProfile, WhaleTrade, WhalePosition } from '@/types';
import {
  alertEventTime,
  alertKindLabel,
  diffWhaleActivity,
  filterFreshDockAlerts,
  filterRecentAlerts,
  isTrackedAlertKind,
  mergeDockAlerts,
  normalizeStoredAlert,
  readAlertSnap,
  readSeenTradeIds,
  snapshotWhales,
  writeAlertSnap,
  writeSeenTradeIds,
  type WhaleAlert,
} from '@/utils/whaleAlerts';
import { isWhaleMonitored } from '@/utils/monitoredWhales';
import { alertPassesFreshGate, absorbOpenEvidence, freshModeEnabled, freshWindowHours } from '@/utils/freshMode';
import {
  DISPLAY_TOP_N,
  pickDisplayWhales,
  pickReplacementWhale,
  sortWhalesForDisplay,
} from '@/utils/topWhales';

/** v3：异动只保留开仓/补仓 */
const HISTORY_KEY = 'whale-tracker-alert-history-v3';
const LEGACY_HISTORY_KEYS = ['whale-tracker-alert-history', 'whale-tracker-alert-history-v2'];
const MAX_HISTORY = 3000;
/** GoldRush 并发更高：每批拉多个，缩短 200+ 名单首屏时间 */
const WHALE_BATCH_SIZE = 12;
/** 单次拉取最多重试 3 次，避免一次超时/限流就让整轮分段加载停在半路 */
const BATCH_RETRY_LIMIT = 3;
const BATCH_RETRY_DELAY_MS = 2000;
/** 进度超过该时长未推进即视为失效，允许后续轮询重新接管 */
const PROGRESS_STALE_MS = 90 * 1000;
const PENDING_REFRESH_ERROR = '等待刷新';
const ACTIVITY_MAX = 3000;
const ACTIVITY_POLL_MS = 60_000;
/** v4：异动不再前端分页刷 /trades */

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isPendingPlaceholder(whale: WhaleProfile) {
  return whale.error === PENDING_REFRESH_ERROR;
}

function hasPendingPlaceholders(list: WhaleProfile[]) {
  return list.some(isPendingPlaceholder);
}

function isIncompletePayload(data: { incomplete?: boolean; whales?: WhaleProfile[] }) {
  if (data.incomplete) return true;
  return hasPendingPlaceholders(data.whales || []);
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
  localStorage.setItem(HISTORY_KEY, JSON.stringify(recent));
  schedulePushAlertHistory(recent);
}

let pushAlertTimer: number | undefined;
function schedulePushAlertHistory(items: WhaleAlert[]) {
  if (typeof window === 'undefined') return;
  if (pushAlertTimer) window.clearTimeout(pushAlertTimer);
  pushAlertTimer = window.setTimeout(() => {
    pushAlertTimer = undefined;
    void pushPersistedAlertHistory(items).catch(() => null);
  }, 800);
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
  /** 实时异动序号：供异动列表监听并静默重拉分页 */
  const alertRealtimeSeq = ref(0);
  /** 活动流最新一条时间，用于增量拉取 */
  const activityLastSeenTime = ref(0);
  /** 当前列表展示的 20 个 id（稳定，不因静默刷新重排） */
  const displayIds = ref<string[]>([]);
  const backfillRunning = ref(false);
  const alertBackfillDone = ref(false);
  let backfillSeq = 0;
  let alertHydrateStarted = false;

  async function hydrateAlertHistoryFromServer() {
    if (typeof window === 'undefined' || alertHydrateStarted) return;
    alertHydrateStarted = true;
    try {
      const data = await fetchPersistedAlertHistory(300);
      const remote = (data.alerts || [])
        .map((item) => normalizeStoredAlert(item as WhaleAlert))
        .filter((item): item is WhaleAlert => Boolean(item && isPositionDiffAlert(item)));
      if (!remote.length) return;
      const map = new Map<string, WhaleAlert>();
      for (const item of [...remote, ...alertHistory.value]) {
        if (!item?.id) continue;
        map.set(item.id, item);
      }
      alertHistory.value = filterRecentAlerts([...map.values()])
        .sort((a, b) => alertEventTime(b) - alertEventTime(a))
        .slice(0, MAX_HISTORY);
      // 只写本地，避免立刻把合并结果再 POST 打满
      localStorage.setItem(HISTORY_KEY, JSON.stringify(alertHistory.value));
      // 近时过滤：同步轻量开仓证据
      absorbOpenEvidence(alertHistory.value.filter((a) => (a.items?.[0]?.kind || a.kind) === 'open'));
    } catch {
      // 服务端不可用时仍用 localStorage
    }
  }
  void hydrateAlertHistoryFromServer();

  const enabledWhales = computed(() =>
    whales.value.filter((item) => item.enabled !== false),
  );

  const rankedWhales = computed(() => sortWhalesHf(whales.value));

  const displayWhales = computed(() => {
    if (!displayIds.value.length) {
      return pickDisplayWhales(enabledWhales.value, { limit: DISPLAY_TOP_N });
    }
    const byId = new Map(whales.value.map((item) => [item.id, item]));
    return displayIds.value.map((id) => byId.get(id)).filter(Boolean) as WhaleProfile[];
  });

  function ensureDisplayRoster(force = false) {
    if (!force && displayIds.value.length >= Math.min(DISPLAY_TOP_N, enabledWhales.value.length)) {
      // 用最新对象刷新，但保持 id 顺序；踢出后缺额时补人
      if (displayIds.value.length < DISPLAY_TOP_N && enabledWhales.value.length > displayIds.value.length) {
        const next = pickDisplayWhales(enabledWhales.value, {
          limit: DISPLAY_TOP_N,
          preferIds: displayIds.value,
        });
        displayIds.value = next.map((item) => item.id);
      }
      return;
    }
    displayIds.value = pickDisplayWhales(enabledWhales.value, {
      limit: DISPLAY_TOP_N,
      preferIds: displayIds.value,
    }).map((item) => item.id);
  }

  async function replaceDisplayWhale(removeId: string) {
    const key = String(removeId || '');
    if (!key) return null;
    const pool = enabledWhales.value;
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
    if (!whales.value.some((item) => item.id === id && item.enabled !== false)) return false;
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

    return mapped
      .filter((alert) => {
        if (!freshModeEnabled.value) return true;
        const whale = whales.value.find((item) => item.id === alert.whaleId) || null;
        return alertPassesFreshGate(alert, whale, Date.now());
      })
      .sort((a, b) => alertEventTime(b) - alertEventTime(a));
  }

  function ingestAlerts(
    nextWhales: WhaleProfile[],
    nextActivity: WhaleTrade[],
    options: { commitBaseline?: boolean } = {},
  ) {
    const commitBaseline = options.commitBaseline !== false;

    // 分段加载未完成：不写异动、不固化基线（避免半份名单变成「已首轮」）
    if (!commitBaseline) return;

    const result = diffWhaleActivity({
      prevSnap: readAlertSnap(),
      nextWhales,
      activity: nextActivity,
      seenIds: readSeenTradeIds(),
    });
    writeAlertSnap(snapshotWhales(nextWhales));
    writeSeenTradeIds(result.seenIds);
    // 主路径：仅仓位快照 diff；成交仅作新开仓后的按需验证
    const historyAlerts = result.alerts.filter((item) => isTrackedAlertKind(item.kind));
    mergeAlertHistory(historyAlerts);
    if (historyAlerts.length) alertRealtimeSeq.value += 1;

    const freshDiffs = filterFreshDockAlerts(historyAlerts);
    const dockAlerts = mergeDockAlerts(filterDockAlerts(freshDiffs));
    // 新异动可入栏；已展示卡片不按时间老化踢掉，仅手动关闭；顺带清掉减仓/平仓旧卡
    alerts.value = mergeDockAlerts(
      filterDockAlerts([...dockAlerts, ...alerts.value]),
    ).slice(0, 4);

    // 附加：新开仓后后台补拉该地址成交作验证，不挡主流程
    const openIds = dockAlerts
      .filter((item) => item.kind === 'open')
      .map((item) => item.whaleId)
      .filter(Boolean);
    if (openIds.length) queueOpenFillVerify(openIds);
  }

  /** 同时最多验证 2 个新开仓地址，避免又打满 HL */
  const openVerifyPending = new Set<string>();
  function queueOpenFillVerify(whaleIds: string[]) {
    const ids = [...new Set(whaleIds)].filter((id) => id && !openVerifyPending.has(id)).slice(0, 2);
    for (const id of ids) {
      openVerifyPending.add(id);
      void refreshWhale(id)
        .catch(() => null)
        .finally(() => {
          openVerifyPending.delete(id);
        });
    }
  }

  function mergeAlertHistory(entries: WhaleAlert[]) {
    const map = new Map<string, WhaleAlert>();
    for (const item of [...entries, ...alertHistory.value]) {
      const normalized = normalizeStoredAlert(item);
      if (!normalized?.id || !isPositionDiffAlert(normalized)) continue;
      map.set(normalized.id, normalized);
    }
    alertHistory.value = filterRecentAlerts([...map.values()])
      .sort((a, b) => alertEventTime(b) - alertEventTime(a))
      .slice(0, MAX_HISTORY);
    writeAlertHistory(alertHistory.value);
    absorbOpenEvidence(entries.filter((a) => (a.items?.[0]?.kind || a.kind) === 'open'));
  }

  /** 异动分页：只吸收 open 到轻量证据池（不写全量 localStorage） */
  function absorbAlertPage(entries: WhaleAlert[]) {
    if (!entries?.length) return;
    absorbOpenEvidence(entries);
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
    // 无论是否重复 id，都通知异动列表重拉（避免只靠 history 顶栏 id）
    alertRealtimeSeq.value += 1;
    // 近时过滤开启时：老仓补仓不进 dock
    if (freshModeEnabled.value) {
      const whale = whales.value.find((item) => item.id === normalized.whaleId) || null;
      if (!alertPassesFreshGate(normalized, whale, Date.now())) return;
    }
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
    ingestAlerts(whales.value, activity.value);
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

    ingestAlerts(mergedWhales, activity.value, {
      // 分段未完成不固化基线，避免首批空 openTime 把「首轮」用掉且永不弹窗
      commitBaseline: !data.progressive || Boolean(data.done),
    });
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

  function isBatchSessionReset(err: unknown) {
    const msg = err instanceof Error ? err.message : String(err || '');
    return /分段加载会话已失效|分段加载会话已中断|WHALE_BATCH_RESET/.test(msg);
  }

  /** 分段卡住时：若磁盘已有完整缓存（无「等待刷新」占位），直接收尾 */
  async function tryTakeFullCache(seq: number, minTotal = 0) {
    try {
      const cached = await fetchWhales(false);
      if (seq !== loadSeq) return false;
      const count = cached.whales?.length || 0;
      if (!count) return false;
      if (minTotal > 0 && count < minTotal) return false;
      if (isIncompletePayload(cached)) return false;
      applyWhalePayload(cached);
      setProgress({ loaded: count, total: count });
      error.value = '';
      return true;
    } catch {
      return false;
    }
  }

  async function loadProgressive(
    refresh = false,
    _silent = false,
    seq: number,
    options: { merge?: boolean } = {},
  ) {
    let offset = 0;
    let firstBatch = true;
    let restarted = false;
    let lastError: unknown = null;
    let expectedTotal = 0;

    try {
      while (true) {
        if (seq !== loadSeq) return;

        // 单批失败不再整条链路中断：重试若干次，仍失败则抛给上层
        let data: Awaited<ReturnType<typeof fetchWhalesBatch>> | null = null;
        for (let attempt = 0; attempt < BATCH_RETRY_LIMIT; attempt += 1) {
          try {
            data = await fetchWhalesBatch({
              offset,
              limit: WHALE_BATCH_SIZE,
              refresh: refresh && firstBatch,
            });
            lastError = null;
            break;
          } catch (err) {
            if (seq !== loadSeq) return;
            lastError = err;
            // 批次卡住期间缓存可能已被分片写满，优先收尾
            if (await tryTakeFullCache(seq, expectedTotal || 20)) {
              lastError = null;
              return;
            }
            // 后端会话被并发刷新顶掉时，从头重来一次
            if (isBatchSessionReset(err) && !restarted) {
              restarted = true;
              offset = 0;
              firstBatch = true;
              lastError = null;
              break;
            }
            if (attempt === BATCH_RETRY_LIMIT - 1) throw err;
            await sleep(BATCH_RETRY_DELAY_MS * (attempt + 1));
          }
        }
        if (seq !== loadSeq) return;
        if (!data) {
          if (lastError) throw lastError;
          continue;
        }

        applyWhalePayload(data, { merge: options.merge || whales.value.length > 0 });
        const total = Number(data.total) || data.whales?.length || 0;
        const loaded = Number(data.loaded) || data.whales?.length || 0;
        expectedTotal = Math.max(expectedTotal, total);
        setProgress(total > 0 ? { loaded, total } : null);
        firstBatch = false;
        if (data.done || !data.whales?.length) break;
        const nextOffset = Number(data.nextOffset ?? loaded) || 0;
        // 偏移没有前进说明后端已到边界，避免死循环
        if (nextOffset <= offset || nextOffset >= total) break;
        offset = nextOffset;

        // 分批间隙：若后台分片已写出完整缓存，不必继续硬拉 HL
        if (await tryTakeFullCache(seq, total)) return;
      }

      if (seq === loadSeq) error.value = '';
    } catch (err) {
      if (seq === loadSeq && (await tryTakeFullCache(seq, expectedTotal))) {
        lastError = null;
        return;
      }
      throw err;
    } finally {
      // 先落到满值，让右上角滚字动画跑完再清空
      if (seq === loadSeq) {
        if (expectedTotal > 0) {
          setProgress({ loaded: expectedTotal, total: expectedTotal });
          window.setTimeout(() => {
            if (seq === loadSeq) setProgress(null);
          }, 900);
        } else {
          setProgress(null);
        }
      }
    }
  }

  async function load(refresh = false, silent = false) {
    const seq = ++loadSeq;
    const first = !whales.value.length;
    const progressFresh =
      Boolean(loadProgress.value) && Date.now() - loadProgressAt.value < PROGRESS_STALE_MS;
    // 只在进度确实还在推进时让静默轮询避让；进度僵死则由本轮接管
    if (silent && progressFresh && !refresh) return;
    if (!silent || first) loading.value = true;
    if (!silent) error.value = '';
    let retrying = false;
    try {
      // 静默轮询：读缓存；若仍有占位则继续分段补齐
      if (silent && whales.value.length && !refresh) {
        const data = await fetchWhales(false);
        if (seq !== loadSeq) return;
        applyWhalePayload(data);
        error.value = '';
        if (isIncompletePayload(data) || hasPendingPlaceholders(whales.value)) {
          await loadProgressive(false, true, seq, { merge: true });
        } else {
          setProgress(null);
        }
        return;
      }

      // 强制刷新：直接分段拉取
      if (refresh) {
        await loadProgressive(true, silent, seq);
        return;
      }

      // 优先取缓存（含过期缓存），先渲染；若含「等待刷新」占位则继续补齐
      let hasCache = false;
      let incompleteCache = false;
      try {
        const cached = await fetchWhales(false);
        if (seq !== loadSeq) return;
        if (cached.whales?.length) {
          applyWhalePayload(cached);
          hasCache = true;
          incompleteCache = isIncompletePayload(cached);
          error.value = '';
          loading.value = false;
          if (incompleteCache) {
            const total = cached.whales.length;
            const pending = Number(cached.pending) || cached.whales.filter(isPendingPlaceholder).length;
            setProgress({ loaded: Math.max(0, total - pending), total });
          }
        }
      } catch {
        // 无缓存或缓存失败时走分段冷启动
      }

      if (hasCache && !incompleteCache) {
        return;
      }
      await loadProgressive(false, silent, seq, { merge: hasCache });
    } catch (err) {
      if (seq !== loadSeq) return;
      setProgress(null);
      retrying = isRetryableLoadError(err);
      if (retrying) {
        if (!silent || first) {
          error.value = withRetrySuffix(retryableErrorText(err, '巨鲸数据加载失败'));
        }
        scheduleSilentRetry('whales', () => load(refresh, true));
      } else if (!silent || first) {
        error.value = err instanceof Error ? err.message : '巨鲸数据加载失败';
      }
    } finally {
      if (seq === loadSeq && !(retrying && first)) loading.value = false;
    }
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

      if (Array.isArray(data.trades)) {
        const others = activity.value.filter((item) => item.whaleId !== profile.id);
        mergeActivity([...data.trades, ...others], true);
      }
      if (data.updatedAt) updatedAt.value = data.updatedAt;
      ingestAlerts(whales.value, activity.value);
      return profile;
    } finally {
      const next = { ...refreshingWhaleIds.value };
      delete next[key];
      refreshingWhaleIds.value = next;
    }
  }

  /**
   * 异动刷新：只重拉巨鲸仓位并做 diff，不再批量补成交/openTime。
   */
  async function refreshAlertHistory(_maxWhales = 40) {
    await load(false, true);
    return {
      enriched: 0,
      tradeCount: 0,
      warning: null as string | null,
    };
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
   * 新开仓时由 ingestAlerts → queueOpenFillVerify 按需补成交验证。
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

  /** 开启/调整近时窗口时，清掉 dock 里不符合开仓门禁的卡片 */
  watch([freshModeEnabled, freshWindowHours], () => {
    if (!freshModeEnabled.value) return;
    alerts.value = alerts.value.filter((alert) => {
      const whale = whales.value.find((item) => item.id === alert.whaleId) || null;
      return alertPassesFreshGate(alert, whale, Date.now());
    });
  });

  return {
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
    refreshAlertHistory,
    ensureAlertHistory,
    pollAlerts,
    pollActivityIncremental,
    startActivityPolling,
    stopActivityPolling,
    loadAllTrades,
    clearWhaleFilter,
    resetForHardRefresh,
    dismissAlert,
    clearAlerts,
    absorbAlertPage,
    ingestRealtimeFill,
    ingestRealtimeAlert,
    ingestRealtimeWhalePatch,
  };
});
