import { computed, ref, shallowRef } from 'vue';
import type { WhalePosition, WhaleProfile, WhaleTrade } from '@/types';
import {
  alertEventTime,
  type WhaleAlert,
} from '@/utils/whaleAlerts';

export const FRESH_MODE_KEY = 'whale-tracker-fresh-mode';
export const FRESH_HOURS_KEY = 'whale-tracker-fresh-hours';

/** 弹窗预设（小时） */
export const FRESH_WINDOW_PRESETS = [1, 2, 6, 12, 24] as const;
export type FreshWindowPreset = (typeof FRESH_WINDOW_PRESETS)[number];

const MIN_HOURS = 1;
const MAX_HOURS = 24;
/** 开仓证据最多保留条数（仅 open） */
const EVIDENCE_MAX = 800;
/** 证据池回看上限（与最大预设一致） */
const EVIDENCE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

const EMPTY_COINS = new Set<string>();

function clampHours(value: number): number {
  const n = Math.floor(Number(value) || 0);
  if (!Number.isFinite(n)) return 2;
  return Math.min(MAX_HOURS, Math.max(MIN_HOURS, n));
}

function nearestPreset(hours: number): FreshWindowPreset {
  const n = clampHours(hours);
  let best: FreshWindowPreset = 2;
  let bestDist = Infinity;
  for (const p of FRESH_WINDOW_PRESETS) {
    const d = Math.abs(p - n);
    if (d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  return best;
}

function readFreshHours(): FreshWindowPreset {
  try {
    const n = Number(localStorage.getItem(FRESH_HOURS_KEY));
    if ((FRESH_WINDOW_PRESETS as readonly number[]).includes(n)) {
      return n as FreshWindowPreset;
    }
    if (Number.isFinite(n) && n > 0) return nearestPreset(n);
  } catch {
    // ignore
  }
  return 2;
}

function readFreshEnabled(): boolean {
  try {
    return localStorage.getItem(FRESH_MODE_KEY) === '1';
  } catch {
    return false;
  }
}

/** 近时过滤开关 */
export const freshModeEnabled = ref(readFreshEnabled());
/** 窗口小时数（仅预设） */
export const freshWindowHours = ref<FreshWindowPreset>(readFreshHours());

/** 轻量开仓证据（仅 kind=open） */
export const freshOpenEvidence = shallowRef<WhaleAlert[]>([]);
/** whaleId → 窗口内开过的币 */
export const freshOpenCoinIndex = shallowRef<Map<string, Set<string>>>(new Map());

/** 开启近时时的全屏进度 */
export const freshApplyBusy = ref(false);
export const freshApplyProgress = ref(0);
export const freshApplyLabel = ref('');

export function freshWindowMs() {
  return freshWindowHours.value * 60 * 60 * 1000;
}

/** @deprecated 使用 freshWindowMs() */
export const FRESH_WINDOW_MS = 2 * 60 * 60 * 1000;

function persistEnabled(on: boolean) {
  try {
    if (on) localStorage.setItem(FRESH_MODE_KEY, '1');
    else localStorage.removeItem(FRESH_MODE_KEY);
  } catch {
    // ignore
  }
}

function persistHours(hours: number) {
  try {
    localStorage.setItem(FRESH_HOURS_KEY, String(hours));
  } catch {
    // ignore
  }
}

function coinKey(value: string | undefined | null) {
  return String(value || '')
    .toUpperCase()
    .replace(/^K/, '');
}

function isOpenAlert(alert: WhaleAlert) {
  return (alert.items?.[0]?.kind || alert.kind) === 'open';
}

function yieldToMain() {
  return new Promise<void>((resolve) => {
    window.setTimeout(() => resolve(), 0);
  });
}

/**
 * 从证据列表重建索引（按当前窗口小时过滤）。
 * 分片写入，避免一次扫大量数据卡死。
 */
export async function rebuildFreshOpenIndex(now = Date.now(), onChunk?: () => void) {
  const map = new Map<string, Set<string>>();
  const windowMs = freshWindowMs();
  const list = freshOpenEvidence.value;
  const chunk = 80;
  for (let i = 0; i < list.length; i += 1) {
    const alert = list[i];
    if (!isOpenAlert(alert)) continue;
    const at = alertEventTime(alert);
    if (!at || now - at > windowMs || now - at < -60_000) continue;
    const wid = String(alert.whaleId || '');
    const coin = coinKey(alert.items?.[0]?.coin);
    if (!wid || !coin) continue;
    let set = map.get(wid);
    if (!set) {
      set = new Set();
      map.set(wid, set);
    }
    set.add(coin);
    if (i > 0 && i % chunk === 0) {
      onChunk?.();
      await yieldToMain();
    }
  }
  freshOpenCoinIndex.value = map;
}

/** 只吸收 open 异动到轻量证据池（不写全量历史） */
export function absorbOpenEvidence(alerts: WhaleAlert[] | undefined, now = Date.now()) {
  if (!alerts?.length) return;
  const map = new Map<string, WhaleAlert>();
  for (const item of freshOpenEvidence.value) {
    if (item?.id) map.set(item.id, item);
  }
  for (const raw of alerts) {
    if (!raw || !isOpenAlert(raw)) continue;
    const at = alertEventTime(raw);
    if (!at || now - at > EVIDENCE_LOOKBACK_MS) continue;
    const id = String(raw.id || '');
    if (!id) continue;
    map.set(id, raw);
  }
  freshOpenEvidence.value = [...map.values()]
    .sort((a, b) => alertEventTime(b) - alertEventTime(a))
    .slice(0, EVIDENCE_MAX);
  // 同步轻量索引（当前窗口）；调用方可再 await rebuildFreshOpenIndex 做分片
  const syncMap = new Map<string, Set<string>>();
  const windowMs = freshWindowMs();
  for (const alert of freshOpenEvidence.value) {
    const at = alertEventTime(alert);
    if (!at || now - at > windowMs) continue;
    const wid = String(alert.whaleId || '');
    const coin = coinKey(alert.items?.[0]?.coin);
    if (!wid || !coin) continue;
    let set = syncMap.get(wid);
    if (!set) {
      set = new Set();
      syncMap.set(wid, set);
    }
    set.add(coin);
  }
  freshOpenCoinIndex.value = syncMap;
}

/** 开启并设定窗口 */
export function enableFreshMode(hours: number) {
  const next = nearestPreset(hours);
  freshWindowHours.value = next;
  freshModeEnabled.value = true;
  persistHours(next);
  persistEnabled(true);
}

/** 关闭近时过滤 */
export function disableFreshMode() {
  freshModeEnabled.value = false;
  persistEnabled(false);
}

/** @deprecated */
export function setFreshMode(on = false) {
  if (on) enableFreshMode(freshWindowHours.value);
  else disableFreshMode();
}

export function setFreshWindowHours(hours: number) {
  const next = nearestPreset(hours);
  freshWindowHours.value = next;
  persistHours(next);
}

export function toggleFreshMode() {
  if (freshModeEnabled.value) disableFreshMode();
  else enableFreshMode(freshWindowHours.value);
}

export function isWithinFreshWindow(ts: number | null | undefined, now = Date.now()) {
  const t = Number(ts) || 0;
  if (!t) return false;
  const windowMs = freshWindowMs();
  return now - t <= windowMs && now - t >= -60_000;
}

export function positionOpenTime(
  pos: Pick<WhalePosition, 'openTime' | 'firstOpenTime'> | null | undefined,
) {
  if (!pos) return 0;
  return Number(pos.firstOpenTime) || Number(pos.openTime) || 0;
}

export function findPositionForAlert(
  whale: WhaleProfile | null | undefined,
  alert: WhaleAlert,
) {
  if (!whale) return null;
  const item = alert.items?.[0];
  const coin = coinKey(item?.coin);
  const side = item?.side;
  if (!coin) return null;
  const sameCoin = (pos: WhalePosition) =>
    coinKey(pos.coin) === coin || coinKey(pos.coinLabel) === coin;
  return (
    whale.positions?.find((pos) => sameCoin(pos) && (!side || pos.side === side)) ||
    whale.positions?.find((pos) => sameCoin(pos)) ||
    null
  );
}

/** 开仓/加仓对应仓位是否仍在（名义≥100）；无巨鲸快照时无法判定，视为仍有效 */
export function alertPositionStillOpen(
  alert: WhaleAlert,
  whale?: WhaleProfile | null,
) {
  const kind = alert.items?.[0]?.kind || alert.kind;
  if (kind !== 'open' && kind !== 'increase') return true;
  if (!whale) return true;
  const item = alert.items?.[0];
  const coin = coinKey(item?.coin);
  const side = item?.side;
  if (!coin) return false;
  return (whale.positions || []).some((pos) => {
    const matchCoin = coinKey(pos.coin) === coin || coinKey(pos.coinLabel) === coin;
    if (!matchCoin) return false;
    if (side && pos.side !== side) return false;
    return Math.abs(Number(pos.positionValue) || 0) >= 100;
  });
}

export function isFreshPosition(
  pos: Pick<WhalePosition, 'coin' | 'coinLabel' | 'openTime' | 'firstOpenTime' | 'lastAddTime'>,
  now = Date.now(),
  evidence?: { openCoins?: Set<string> },
) {
  const openT = positionOpenTime(pos);
  if (openT && isWithinFreshWindow(openT, now)) return true;
  // 老仓在窗口内加仓也算有动作（异动「加仓」常见）
  const addT = Number(pos.lastAddTime) || 0;
  if (addT && isWithinFreshWindow(addT, now)) return true;
  if (!evidence?.openCoins?.size) return false;
  const coin = coinKey(pos.coinLabel || pos.coin);
  return Boolean(coin && evidence.openCoins.has(coin));
}

/** O(1) 取某巨鲸窗口内开仓币；不再扫全历史 */
export function freshOpenCoinsForWhale(whaleId: string, _alerts?: WhaleAlert[], _now = Date.now()) {
  if (!whaleId) return EMPTY_COINS;
  return freshOpenCoinIndex.value.get(whaleId) || EMPTY_COINS;
}

export function alertPassesFreshGate(
  alert: WhaleAlert,
  whale?: WhaleProfile | null,
  now = Date.now(),
  _evidenceAlerts?: WhaleAlert[],
) {
  if (!freshModeEnabled.value) return true;
  // 已平仓的开/加仓异动不进闪电模式
  if (!alertPositionStillOpen(alert, whale)) return false;
  const kind = alert.items?.[0]?.kind || alert.kind;
  if (kind === 'open') {
    return isWithinFreshWindow(alertEventTime(alert), now);
  }
  if (kind === 'increase') {
    const openCoins = freshOpenCoinsForWhale(alert.whaleId);
    const pos = findPositionForAlert(whale, alert);
    if (pos && isFreshPosition(pos, now, { openCoins })) return true;
    const coin = coinKey(alert.items?.[0]?.coin);
    return Boolean(coin && openCoins.has(coin));
  }
  return isWithinFreshWindow(alertEventTime(alert), now);
}

/**
 * 异动列表用：时间窗 + 仓位仍在即可。
 * 不加「须有窗口内开仓证据」——分页下「全部」会被其它币/缺证据加仓挤空。
 */
export function alertPassesFreshListGate(
  alert: WhaleAlert,
  whale?: WhaleProfile | null,
  now = Date.now(),
) {
  if (!freshModeEnabled.value) return true;
  if (!alertPositionStillOpen(alert, whale)) return false;
  return isWithinFreshWindow(alertEventTime(alert), now);
}

export function filterFreshAlerts(
  alerts: WhaleAlert[],
  whales: WhaleProfile[] | undefined,
  now = Date.now(),
) {
  if (!freshModeEnabled.value) return alerts;
  const map = new Map((whales || []).map((w) => [w.id, w]));
  return alerts.filter((alert) => alertPassesFreshGate(alert, map.get(alert.whaleId) || null, now));
}

export function whaleHasFreshActivity(
  whale: WhaleProfile,
  now = Date.now(),
  _alerts?: WhaleAlert[],
) {
  const openCoins = freshOpenCoinsForWhale(whale.id, undefined, now);
  // 只认当前仍持有的新鲜仓位；已平仓的开仓证据不再把巨鲸留在列表里
  for (const pos of whale.positions || []) {
    if (Math.abs(Number(pos.positionValue) || 0) < 100) continue;
    if (isFreshPosition(pos, now, { openCoins })) return true;
  }
  return false;
}

export function filterFreshWhales(
  whales: WhaleProfile[],
  now = Date.now(),
  alerts?: WhaleAlert[],
) {
  if (!freshModeEnabled.value) return whales;
  return whales.filter((whale) => whaleHasFreshActivity(whale, now, alerts));
}

export function filterFreshPositions(
  positions: WhalePosition[],
  now = Date.now(),
  evidence?: { openCoins?: Set<string> },
) {
  if (!freshModeEnabled.value) return positions;
  return positions.filter((pos) => isFreshPosition(pos, now, evidence));
}

/** 可明确判定为加仓（非开仓、非减/平）的成交 */
export function isClearlyIncreaseTrade(trade: WhaleTrade) {
  if (!trade || trade.source === 'onchain') return false;
  if (Math.abs(Number(trade.closedPnl) || 0) > 1) return false;
  const dir = String(trade.dir || '');
  if (/open/i.test(dir)) return false;
  // 减仓/平仓/翻仓不是加仓
  if (/close|reduce|long\s*>|short\s*>/i.test(dir)) return false;
  const start = Number(trade.startPosition);
  if (Number.isFinite(start)) return Math.abs(start) >= 1e-8;
  return false;
}

/** 成交是否为「从 0 开仓」。缺 startPosition/dir 时无法判定，返回 false。 */
export function isOpeningFillTrade(trade: WhaleTrade) {
  if (!trade || trade.source === 'onchain') return false;
  if (Math.abs(Number(trade.closedPnl) || 0) > 1) return false;
  const dir = String(trade.dir || '');
  if (/open/i.test(dir)) return true;
  if (/close|long >|short >/i.test(dir)) return false;
  const start = Number(trade.startPosition);
  if (Number.isFinite(start)) return Math.abs(start) < 1e-8;
  return false;
}

export function tradePassesFreshGate(
  trade: WhaleTrade,
  whale?: WhaleProfile | null,
  now = Date.now(),
  _alerts?: WhaleAlert[],
) {
  if (!freshModeEnabled.value) return true;
  if (!isWithinFreshWindow(trade.time, now)) return false;
  // 能识别为加仓则剔除；缺字段时不误杀整表
  if (isClearlyIncreaseTrade(trade)) return false;
  const coin = coinKey(trade.assetLabel || trade.asset);
  const openCoins = whale ? freshOpenCoinsForWhale(whale.id) : EMPTY_COINS;
  const pos =
    whale?.positions?.find(
      (p) =>
        (coinKey(p.coin) === coin || coinKey(p.coinLabel) === coin) &&
        Math.abs(Number(p.positionValue) || 0) >= 100,
    ) || null;
  // 平仓/减仓：仓位可能已减或已平，时间窗内仍展示
  const dir = String(trade.dir || '');
  const isCloseLike =
    Math.abs(Number(trade.closedPnl) || 0) > 1 || /close|reduce/i.test(dir);
  if (isCloseLike) return true;
  if (!pos) return false;
  return isFreshPosition(pos, now, { openCoins });
}

export function filterFreshTrades(
  trades: WhaleTrade[],
  whales?: WhaleProfile[],
  now = Date.now(),
  alerts?: WhaleAlert[],
) {
  if (!freshModeEnabled.value) return trades;
  if (!whales?.length) {
    return trades.filter((item) => isWithinFreshWindow(item.time, now));
  }
  const map = new Map(whales.map((w) => [w.id, w]));
  return trades.filter((item) =>
    tradePassesFreshGate(item, map.get(item.whaleId || '') || null, now, alerts),
  );
}

export function filterFreshByTime<T>(
  items: T[],
  getTime: (item: T) => number | null | undefined,
  now = Date.now(),
) {
  if (!freshModeEnabled.value) return items;
  return items.filter((item) => isWithinFreshWindow(getTime(item), now));
}

export const freshModeOn = computed(() => freshModeEnabled.value);

export const freshModeTitle = computed(() =>
  freshModeEnabled.value
    ? `闪电模式 · 近 ${freshWindowHours.value} 小时`
    : '闪电模式（未开启）',
);

const APPLY_MIN_MS = 320;
const APPLY_TIMEOUT_MS = 20_000;

function setApplyProgress(pct: number, label: string) {
  freshApplyProgress.value = Math.max(0, Math.min(100, Math.round(pct)));
  freshApplyLabel.value = label;
}

/**
 * 开启近时过滤：全屏真实进度，尽快完成；最短展示约 0.3s，超时 20s。
 */
export async function applyFreshModeWithProgress(
  hours: number,
  options?: {
    fetchOpenAlerts?: (sinceMs: number) => Promise<WhaleAlert[]>;
    reloadAlertPage?: () => Promise<void>;
  },
): Promise<'ok' | 'timeout' | 'error'> {
  const next = nearestPreset(hours);
  const started = Date.now();
  freshApplyBusy.value = true;
  setApplyProgress(4, '正在处理数据…');

  try {
    // 先写入小时（索引按新窗口重建），开关稍后再开，减少中途半状态闪烁
    freshWindowHours.value = next;
    persistHours(next);
    await yieldToMain();
    setApplyProgress(12, '拉取开仓证据…');

    const sinceMs = Date.now() - Math.min(EVIDENCE_LOOKBACK_MS, next * 3600 * 1000);
    if (options?.fetchOpenAlerts) {
      const opens = await options.fetchOpenAlerts(sinceMs);
      if (Date.now() - started > APPLY_TIMEOUT_MS) {
        setApplyProgress(100, '处理超时');
        return 'timeout';
      }
      setApplyProgress(35, '合并开仓证据…');
      await yieldToMain();
      absorbOpenEvidence(opens);
    }

    setApplyProgress(55, '建立开仓索引…');
    await rebuildFreshOpenIndex(Date.now(), () => {
      const elapsed = Date.now() - started;
      const pct = 55 + Math.min(20, (elapsed / 2000) * 20);
      setApplyProgress(pct, '建立开仓索引…');
    });

    if (Date.now() - started > APPLY_TIMEOUT_MS) {
      setApplyProgress(100, '处理超时');
      return 'timeout';
    }

    setApplyProgress(78, '应用闪电模式…');
    await yieldToMain();
    freshModeEnabled.value = true;
    persistEnabled(true);

    setApplyProgress(88, '刷新异动列表…');
    if (options?.reloadAlertPage) {
      await options.reloadAlertPage();
    }
    await yieldToMain();

    const elapsed = Date.now() - started;
    if (elapsed < APPLY_MIN_MS) {
      await new Promise<void>((r) => window.setTimeout(r, APPLY_MIN_MS - elapsed));
    }
    setApplyProgress(100, '完成');
    await yieldToMain();
    return 'ok';
  } catch {
    return 'error';
  } finally {
    window.setTimeout(() => {
      freshApplyBusy.value = false;
      freshApplyProgress.value = 0;
      freshApplyLabel.value = '';
    }, 180);
  }
}
