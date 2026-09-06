import type { WhaleDirection, WhaleProfile, WhaleTrade } from '@/types';
import { compareSelectableAssets, displayAsset, isExoticAsset, isSelectableAsset } from '@/utils/assets';
import { directionLabel, formatPnl, formatPrice, formatUsd } from '@/utils/format';
import { coinMatchesWatch } from '@/utils/watchedCoins';

/** 仓位层 + 验证层成交 + 链上预警 */
export type WhaleAlertKind =
  | 'open'
  | 'close'
  | 'increase'
  | 'decrease'
  | 'flip'
  | 'fill'
  | 'transfer';

export type AlertLayer = 'position' | 'fill' | 'transfer';

export interface WhaleAlertItem {
  kind: WhaleAlertKind;
  title: string;
  detail: string;
  coin?: string;
  side?: 'long' | 'short';
  usd?: number;
  pnl?: number;
  time?: number;
  price?: number | null;
  leverage?: number | null;
  marginUsed?: number | null;
  /** 验证层：关联成交摘要 */
  verifyText?: string;
}

export interface AlertPosView {
  coin: string;
  side: 'long' | 'short' | null;
  usd: number | null;
  price: number | null;
  leverage: number | null;
  pnl: number | null;
  openTime: number | null;
  marginUsed: number | null;
}

export interface WhaleAlert {
  id: string;
  at: number;
  whaleId: string;
  whaleName: string;
  address: string;
  kind: WhaleAlertKind;
  kindLabel: string;
  headline: string;
  items: WhaleAlertItem[];
  layer: AlertLayer;
  /** 是否来自用户监控的巨鲸（前端标记） */
  monitored?: boolean;
}

export interface PositionSnap {
  direction: WhaleDirection;
  error?: string | null;
  positions: {
    coin: string;
    side: 'long' | 'short';
    size: number;
    positionValue: number;
    unrealizedPnl: number;
    entryPx: number;
    leverage: number | null;
  }[];
}

const SNAP_KEY = 'whale-tracker-alert-snap';
const SEEN_KEY = 'whale-tracker-alert-seen';
const SEED_DOCK_KEY = 'whale-tracker-seed-dock-seen';
const SIZE_CHANGE_PCT = 0.04;
/** 监控不设金额门槛；仅忽略极小粉尘 */
const DUST_USD = 1;

const KIND_LABEL: Record<WhaleAlertKind, string> = {
  open: '开单',
  close: '平单',
  increase: '加仓',
  decrease: '减仓',
  flip: '反向',
  fill: '成交',
  transfer: '链上预警',
};

export const POSITION_ALERT_KINDS: WhaleAlertKind[] = [
  'open',
  'close',
  'increase',
  'decrease',
  'flip',
];

/** 异动 / 监控只认开仓、补仓 */
export const TRACKED_ALERT_KINDS: WhaleAlertKind[] = ['open', 'increase'];

export function isPositionAlertKind(kind: WhaleAlertKind) {
  return POSITION_ALERT_KINDS.includes(kind);
}

export function isTrackedAlertKind(kind: WhaleAlertKind) {
  return TRACKED_ALERT_KINDS.includes(kind);
}

export function alertLayerOf(alert: Pick<WhaleAlert, 'kind' | 'layer'>): AlertLayer {
  if (alert.layer) return alert.layer;
  if (alert.kind === 'transfer') return 'transfer';
  if (alert.kind === 'fill') return 'fill';
  return 'position';
}

export function alertKindLabel(kind: WhaleAlertKind) {
  return KIND_LABEL[kind];
}

export function alertEventTime(item: WhaleAlert): number {
  const times = (item.items || [])
    .map((entry) => Number(entry.time) || 0)
    .filter((value) => value > 0);
  if (times.length) return Math.max(...times);
  return Number(item.at) || 0;
}

/** 异动记录列表仅保留最近 7 天 */
export const ALERT_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** 右下角监控弹窗仅提示最近一段时间内的新异动 */
export const DOCK_ALERT_MAX_AGE_MS = 15 * 60 * 1000;

const SEEN_TRADE_ID_LIMIT = 3000;

export function isRecentAlert(alert: WhaleAlert, now = Date.now()) {
  return alertEventTime(alert) >= now - ALERT_HISTORY_WINDOW_MS;
}

export function filterRecentAlerts(alerts: WhaleAlert[], now = Date.now()) {
  return alerts.filter((item) => isRecentAlert(item, now));
}

export function isFreshDockAlert(alert: WhaleAlert, now = Date.now()) {
  return alertEventTime(alert) >= now - DOCK_ALERT_MAX_AGE_MS;
}

export function filterFreshDockAlerts(alerts: WhaleAlert[], now = Date.now()) {
  return alerts.filter((item) => isFreshDockAlert(item, now));
}

/** 监控卡片合并窗口：同巨鲸、同币、同方向、同类，10 秒内合成一张 */
export const DOCK_ALERT_MERGE_MS = 10_000;

function dockAlertMergeKey(alert: WhaleAlert): string {
  const lead = alert.items?.[0];
  const coin = coinKey(lead?.coin || alertCoins(alert)[0] || '');
  const side = lead?.side || '';
  const kind = lead?.kind || alert.kind;
  return `${alert.whaleId}|${coin}|${side}|${kind}`;
}

function itemDedupeKey(item: WhaleAlertItem): string {
  return `${Number(item.time) || 0}|${item.title}|${Number(item.usd) || 0}|${Number(item.price) || 0}`;
}

function decorateMergedDockAlert(alert: WhaleAlert): WhaleAlert {
  const items = [...(alert.items || [])].sort(
    (a, b) => (Number(b.time) || 0) - (Number(a.time) || 0),
  );
  const lead = items[0];
  const n = items.length;
  const kind = (lead?.kind || alert.kind) as WhaleAlertKind;
  const baseLabel = alertKindLabel(kind);
  const title = lead?.title || alert.headline || baseLabel;
  const times = items.map((item) => Number(item.time) || 0).filter((v) => v > 0);
  return {
    ...alert,
    kind,
    kindLabel: n > 1 ? `${baseLabel}（多单）` : baseLabel,
    headline: n > 1 ? `${title}（${n} 笔）` : title,
    items,
    at: Math.max(Number(alert.at) || 0, ...times, 0),
  };
}

/**
 * 右下角监控卡片：同方向、同币种、10s 内合并；多笔时 kindLabel 带「（多单）」。
 * 输入顺序不限；输出按事件时间新→旧。
 */
export function mergeDockAlerts(
  alerts: WhaleAlert[],
  windowMs = DOCK_ALERT_MERGE_MS,
): WhaleAlert[] {
  const sorted = [...(alerts || [])].sort((a, b) => alertEventTime(b) - alertEventTime(a));
  const groups: WhaleAlert[] = [];

  for (const alert of sorted) {
    if (!alert) continue;
    const key = dockAlertMergeKey(alert);
    const t = alertEventTime(alert);
    const hit = groups.find((group) => {
      if (dockAlertMergeKey(group) !== key) return false;
      return Math.abs(alertEventTime(group) - t) <= windowMs;
    });

    if (!hit) {
      groups.push(
        decorateMergedDockAlert({
          ...alert,
          items: [...(alert.items || [])],
        }),
      );
      continue;
    }

    const seen = new Set((hit.items || []).map(itemDedupeKey));
    for (const item of alert.items || []) {
      const id = itemDedupeKey(item);
      if (seen.has(id)) continue;
      hit.items.push(item);
      seen.add(id);
    }
    // 保留更新的 id，避免重复 toast key 跳动过大
    if ((Number(alert.at) || 0) >= (Number(hit.at) || 0)) {
      hit.id = alert.id;
    }
    Object.assign(hit, decorateMergedDockAlert(hit));
  }

  return groups.sort((a, b) => alertEventTime(b) - alertEventTime(a));
}

export function listAlertKindOptions(alerts: WhaleAlert[]) {
  const seen = new Map<WhaleAlertKind, string>();
  for (const alert of alerts) {
    if (!isPositionAlertKind(alert.kind)) continue;
    seen.set(alert.kind, alert.kindLabel || KIND_LABEL[alert.kind]);
  }
  return [...seen.entries()]
    .sort((a, b) => KIND_RANK[a[0]] - KIND_RANK[b[0]])
    .map(([value, label]) => ({ value, label }));
}

function coinKey(coin: string) {
  return String(coin || '').toUpperCase().replace(/^K/, '');
}

export function alertCoins(alert: WhaleAlert): string[] {
  const coins = new Set<string>();
  for (const item of alert.items || []) {
    const key = coinKey(item.coin || '');
    if (key) coins.add(key);
  }
  return [...coins];
}

export function alertMatchesCoinFilter(alert: WhaleAlert, filterCoin: string) {
  if (!filterCoin || filterCoin === 'all') return true;
  return (alert.items || []).some((item) => coinMatchesWatch(item.coin, [filterCoin]));
}

export function scopeAlertToCoin(alert: WhaleAlert, filterCoin: string): WhaleAlert {
  if (!filterCoin || filterCoin === 'all') return alert;
  const items = (alert.items || []).filter((item) => coinMatchesWatch(item.coin, [filterCoin]));
  if (!items.length) return alert;
  const kind = pickKind(items);
  const lead = items[0];
  return {
    ...alert,
    items,
    kind,
    kindLabel: alertKindLabel(kind),
    headline: items.length > 1 ? `${lead.title} 等 ${items.length} 笔变化` : lead.title,
  };
}

export function listAlertCoinOptions(alerts: WhaleAlert[]) {
  const seen = new Set<string>();
  for (const alert of alerts) {
    for (const coin of alertCoins(alert)) {
      if (isSelectableAsset(coin)) seen.add(coin);
    }
  }
  return [...seen]
    .sort(compareSelectableAssets)
    .map((value) => ({
      value,
      label: displayAsset(value),
      exotic: isExoticAsset(value),
    }));
}

export function tradeFillSide(trade: WhaleTrade): 'long' | 'short' {
  if (trade.source === 'onchain') {
    return trade.side === 'buy' || trade.side === 'in' ? 'long' : 'short';
  }
  if (Math.abs(Number(trade.closedPnl) || 0) > 1) {
    return trade.side === 'sell' ? 'long' : 'short';
  }
  return trade.side === 'buy' ? 'long' : 'short';
}

/** 成交是否为开仓侧（共振等旧逻辑用；异动主路径不再用成交推断开平） */
export function isTradeOpen(trade: WhaleTrade) {
  if (trade.source === 'onchain') return false;
  return Math.abs(Number(trade.closedPnl) || 0) <= 1;
}

/** 从条目/标题推断多空；不含「加仓/减仓」（无方向，勿当成做多） */
export function inferSide(alert: WhaleAlert, item?: WhaleAlertItem): 'long' | 'short' | null {
  if (item?.side === 'long' || item?.side === 'short') return item.side;
  const text = `${item?.title || ''} ${alert.headline || ''}`;
  if (/开多|平多|做多/.test(text)) return 'long';
  if (/开空|平空|做空/.test(text)) return 'short';
  if (/买入|^买/.test(text)) return 'long';
  if (/卖出|^卖/.test(text)) return 'short';
  return null;
}

export function alertItemSide(alert: WhaleAlert, item?: WhaleAlertItem): 'long' | 'short' | null {
  return inferSide(alert, item);
}

export function alertMatchesSideFilter(
  alert: WhaleAlert,
  filterSide: 'all' | 'long' | 'short',
): boolean {
  if (!filterSide || filterSide === 'all') return true;
  const items = alert.items || [];
  if (!items.length) return inferSide(alert) === filterSide;
  return items.some((item) => alertItemSide(alert, item) === filterSide);
}

/** 按多空收窄 items（与 scopeAlertToCoin 对称） */
export function scopeAlertToSide(
  alert: WhaleAlert,
  filterSide: 'all' | 'long' | 'short',
): WhaleAlert {
  if (!filterSide || filterSide === 'all') return alert;
  const items = (alert.items || []).filter((item) => alertItemSide(alert, item) === filterSide);
  if (!items.length) return alert;
  const kind = pickKind(items);
  const lead = items[0];
  return {
    ...alert,
    items,
    kind,
    kindLabel: alertKindLabel(kind),
    headline: items.length > 1 ? `${lead.title} 等 ${items.length} 笔变化` : lead.title,
  };
}

export function resolveAlertPos(alert: WhaleAlert, whale?: WhaleProfile | null): AlertPosView {
  const item = alert.items?.[0];
  const coin = item?.coin || '';
  const inferred = inferSide(alert, item);
  const sameCoin = (pos: { coin: string; coinLabel?: string; side?: string }) =>
    coinKey(pos.coin) === coinKey(coin) || coinKey(pos.coinLabel || '') === coinKey(coin);
  const live =
    whale?.positions?.find(
      (pos) => sameCoin(pos) && (!inferred || pos.side === inferred),
    ) || whale?.positions?.find((pos) => sameCoin(pos));
  const closed = alert.kind === 'close' || alert.kind === 'decrease' || item?.kind === 'close' || item?.kind === 'decrease';
  const usd = item?.usd ?? null;
  const lev = item?.leverage ?? (!closed ? live?.leverage ?? null : null);
  const price = item?.price || (!closed ? live?.entryPx || null : null);
  const pnl = item?.pnl ?? (!closed ? Number(live?.unrealizedPnl) || null : item?.pnl ?? null);
  const leverage = lev && lev > 0 ? lev : null;
  return {
    coin: coin || live?.coin || '--',
    side: inferred ?? (!closed ? live?.side ?? null : null),
    usd,
    price,
    leverage,
    pnl,
    openTime: item?.time || live?.openTime || alert.at || null,
    marginUsed: leverage && usd ? usd / leverage : null,
  };
}

const KIND_RANK: Record<WhaleAlertKind, number> = {
  close: 0,
  open: 1,
  flip: 2,
  increase: 3,
  decrease: 4,
  fill: 5,
  transfer: 6,
};

function absSize(value: number) {
  return Math.abs(Number(value) || 0);
}

function meaningfulSizeChange(prev: number, next: number) {
  const a = absSize(prev);
  const b = absSize(next);
  if (!a && !b) return false;
  if (!a || !b) return true;
  return Math.abs(b - a) / a >= SIZE_CHANGE_PCT;
}

export function snapshotWhales(whales: WhaleProfile[]): Record<string, PositionSnap> {
  const out: Record<string, PositionSnap> = {};
  for (const whale of whales) {
    if (whale.enabled === false) continue;
    out[whale.id] = {
      direction: whale.direction,
      error: whale.error,
      positions: (whale.positions || []).map((pos) => ({
        coin: pos.coin,
        side: pos.side,
        size: pos.size,
        positionValue: pos.positionValue,
        unrealizedPnl: pos.unrealizedPnl,
        entryPx: pos.entryPx,
        leverage: pos.leverage,
      })),
    };
  }
  return out;
}

export function readAlertSnap(): Record<string, PositionSnap> {
  try {
    const raw = JSON.parse(sessionStorage.getItem(SNAP_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function writeAlertSnap(snap: Record<string, PositionSnap>) {
  sessionStorage.setItem(SNAP_KEY, JSON.stringify(snap));
}

export function readSeenTradeIds(): Set<string> {
  try {
    const raw = JSON.parse(sessionStorage.getItem(SEEN_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch {
    return new Set();
  }
}

export function writeSeenTradeIds(ids: Set<string>) {
  sessionStorage.setItem(SEEN_KEY, JSON.stringify([...ids].slice(-SEEN_TRADE_ID_LIMIT)));
}

export function readSeenSeedDockIds(): Set<string> {
  try {
    const raw = JSON.parse(sessionStorage.getItem(SEED_DOCK_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch {
    return new Set();
  }
}

export function writeSeenSeedDockIds(ids: Set<string>) {
  sessionStorage.setItem(SEED_DOCK_KEY, JSON.stringify([...ids].slice(-SEEN_TRADE_ID_LIMIT)));
}

function markActivitySeen(activity: WhaleTrade[], seen: Set<string>) {
  for (const trade of activity) {
    if (trade.id) seen.add(trade.id);
  }
}

function posMap(snap?: PositionSnap) {
  const map = new Map<string, PositionSnap['positions'][number]>();
  for (const pos of snap?.positions || []) {
    map.set(coinKey(pos.coin), pos);
  }
  return map;
}

function tradePrice(trade: WhaleTrade) {
  if (Number(trade.price) > 0) return Number(trade.price);
  if (Number(trade.amount) > 0 && Number(trade.amountUsd) > 0) {
    return Number(trade.amountUsd) / Number(trade.amount);
  }
  return 0;
}

function posSpecs(pos?: PositionSnap['positions'][number], price?: number) {
  const px = price || pos?.entryPx || 0;
  const lev = pos?.leverage ?? null;
  return {
    price: px || null,
    leverage: lev,
  };
}

function attachSpecs(
  item: WhaleAlertItem,
  pos?: PositionSnap['positions'][number],
  price?: number,
): WhaleAlertItem {
  const specs = posSpecs(pos, price);
  item.price = specs.price;
  item.leverage = specs.leverage;
  if (pos?.side) item.side = pos.side;
  const usd = Number(item.usd) || 0;
  if (item.leverage && usd) item.marginUsed = usd / item.leverage;
  else item.marginUsed = null;
  return item;
}

function pickKind(items: WhaleAlertItem[]): WhaleAlertKind {
  const ranked = [...items]
    .filter((item) => isPositionAlertKind(item.kind))
    .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
  return ranked[0]?.kind || items[0]?.kind || 'open';
}

/** 仓位快照对比 → 开/加/减/平/反（不生成成交推断类事件） */
function diffPositions(prev: PositionSnap | undefined, next: PositionSnap): WhaleAlertItem[] {
  if (!prev || prev.error || next.error) return [];
  const before = posMap(prev);
  const after = posMap(next);
  const items: WhaleAlertItem[] = [];

  for (const [coin, pos] of after) {
    const old = before.get(coin);
    if (!old) {
      if ((pos.positionValue || 0) < DUST_USD) continue;
      // 该币种此前无仓位 → 开单
      items.push(
        attachSpecs(
          {
            kind: 'open',
            title: pos.side === 'long' ? `开多 ${coin}` : `开空 ${coin}`,
            detail: `仓位 ${formatUsd(pos.positionValue)} · 开仓价 ${formatPrice(pos.entryPx)}`,
            coin,
            usd: pos.positionValue,
            side: pos.side,
          },
          pos,
        ),
      );
      continue;
    }
    if (old.side !== pos.side) {
      items.push(
        attachSpecs(
          {
            kind: 'flip',
            title: `${coin} 反向${pos.side === 'long' ? '做多' : '做空'}`,
            detail: `${directionLabel(old.side)} → ${directionLabel(pos.side)} · ${formatUsd(pos.positionValue)}`,
            coin,
            usd: pos.positionValue,
            side: pos.side,
          },
          pos,
        ),
      );
      continue;
    }
    if (meaningfulSizeChange(old.size, pos.size)) {
      const up = absSize(pos.size) > absSize(old.size);
      const deltaUsd = Math.abs((pos.positionValue || 0) - (old.positionValue || 0));
      items.push(
        attachSpecs(
          {
            kind: up ? 'increase' : 'decrease',
            title: `${up ? '加仓' : '减仓'} ${coin}`,
            detail: `${formatUsd(old.positionValue)} → ${formatUsd(pos.positionValue)}（Δ ${formatUsd(deltaUsd)}）`,
            coin,
            usd: deltaUsd || pos.positionValue,
            side: pos.side,
          },
          pos,
        ),
      );
    }
  }

  for (const [coin, pos] of before) {
    if (after.has(coin) || (pos.positionValue || 0) < DUST_USD) continue;
    items.push(
      attachSpecs(
        {
          kind: 'close',
          title: pos.side === 'long' ? `平多 ${coin}` : `平空 ${coin}`,
          detail: `原仓位 ${formatUsd(pos.positionValue)} · 浮盈 ${formatPnl(pos.unrealizedPnl)}`,
          coin,
          usd: pos.positionValue,
          pnl: pos.unrealizedPnl,
          side: pos.side,
        },
        pos,
      ),
    );
  }

  // 异动只保留开仓 / 补仓；平仓、减仓、反向不进列表
  return items.filter((item) => item.kind === 'open' || item.kind === 'increase');
}

function relatedFills(fills: WhaleTrade[], coin: string) {
  const key = coinKey(coin);
  return fills.filter((trade) => {
    if (trade.source === 'onchain') return false;
    const asset = coinKey(trade.assetLabel || trade.asset);
    return Boolean(key && asset && (asset === key || coinMatchesWatch(asset, [key])));
  });
}

/** 成交仅作验证层：挂到仓位事件上，不单独推断开平 */
function attachFillVerification(items: WhaleAlertItem[], fills: WhaleTrade[]) {
  for (const item of items) {
    if (!item.coin) continue;
    const related = relatedFills(fills, item.coin);
    if (!related.length) continue;
    let buyUsd = 0;
    let sellUsd = 0;
    let notional = 0;
    let pxSum = 0;
    let pxWeight = 0;
    let latest = 0;
    for (const trade of related) {
      const usd = Math.abs(Number(trade.amountUsd) || 0);
      const px = tradePrice(trade);
      if (trade.side === 'buy' || trade.side === 'in') buyUsd += usd;
      else sellUsd += usd;
      notional += usd;
      if (px > 0 && usd > 0) {
        pxSum += px * usd;
        pxWeight += usd;
      }
      latest = Math.max(latest, Number(trade.time) || 0);
    }
    const avgPx = pxWeight > 0 ? pxSum / pxWeight : 0;
    const sideText =
      buyUsd > sellUsd * 1.15 ? '偏买入' : sellUsd > buyUsd * 1.15 ? '偏卖出' : '买卖混合';
    const verify = `验证成交 ${formatUsd(notional)}（${sideText}${avgPx ? ` · 均价 ${formatPrice(avgPx)}` : ''}）`;
    item.verifyText = verify;
    item.detail = `${item.detail} · ${verify}`;
    if (latest) item.time = latest;
    if (avgPx && !item.price) item.price = avgPx;
  }
}

/**
 * 首次加载：用当前持仓 + openTime 补种近 7 天开仓记录。
 * 主路径已停用（异动只认仓位 diff）；保留导出供排查/回滚。
 */
function resolveSeedOpenTime(pos: {
  openTime?: number | null;
  firstOpenTime?: number | null;
  lastAddTime?: number | null;
  entryFills?: Array<{ time?: number }> | null;
}): number {
  const direct =
    Number(pos.openTime) ||
    Number(pos.firstOpenTime) ||
    Number(pos.lastAddTime) ||
    0;
  if (direct) return direct;
  const fills = Array.isArray(pos.entryFills) ? pos.entryFills : [];
  let earliest = 0;
  for (const fill of fills) {
    const t = Number(fill?.time) || 0;
    if (!t) continue;
    if (!earliest || t < earliest) earliest = t;
  }
  return earliest;
}

export function seedOpenAlertsFromPositions(
  whales: WhaleProfile[],
  now = Date.now(),
): WhaleAlert[] {
  const cutoff = now - ALERT_HISTORY_WINDOW_MS;
  const alerts: WhaleAlert[] = [];
  for (const whale of whales) {
    if (whale.enabled === false) continue;
    for (const pos of whale.positions || []) {
      const openTime = resolveSeedOpenTime(pos);
      if (!openTime || openTime < cutoff) continue;
      if ((pos.positionValue || 0) < DUST_USD) continue;
      const coin = pos.coin;
      const side = pos.side;
      if (!coin || (side !== 'long' && side !== 'short')) continue;
      const item: WhaleAlertItem = attachSpecs(
        {
          kind: 'open',
          title: side === 'long' ? `开多 ${coin}` : `开空 ${coin}`,
          detail: `仓位 ${formatUsd(pos.positionValue)} · 开仓价 ${formatPrice(pos.entryPx)}`,
          coin,
          usd: pos.positionValue,
          side,
          time: openTime,
        },
        pos,
      );
      alerts.push({
        id: `seed-open-${whale.id}-${coinKey(coin)}-${side}-${openTime}`,
        at: openTime,
        whaleId: whale.id,
        whaleName: whale.name,
        address: whale.address,
        kind: 'open',
        kindLabel: KIND_LABEL.open,
        headline: item.title,
        items: [item],
        layer: 'position',
      });
    }
  }
  return alerts.sort((a, b) => alertEventTime(b) - alertEventTime(a));
}

/**
 * 核心：仓位快照 diff 驱动异动。
 * 成交只附着验证信息；不再把买卖成交翻译成开/平仓事件。
 */
export function diffWhaleActivity(input: {
  prevSnap: Record<string, PositionSnap>;
  nextWhales: WhaleProfile[];
  activity: WhaleTrade[];
  seenIds: Set<string>;
  now?: number;
}): { alerts: WhaleAlert[]; seenIds: Set<string> } {
  const now = input.now || Date.now();
  const seen = new Set(input.seenIds);
  const firstRun = !Object.keys(input.prevSnap).length;
  const alerts: WhaleAlert[] = [];
  const nextSnap = snapshotWhales(input.nextWhales);

  if (firstRun) {
    markActivitySeen(input.activity, seen);
    // 首轮只固化基线，不反推历史开仓（避免补种脏数据）
    return { alerts: [], seenIds: seen };
  }

  const fillsByWhale = new Map<string, WhaleTrade[]>();
  for (const trade of input.activity) {
    if (!trade.whaleId || trade.source === 'onchain') continue;
    if (!trade.id || seen.has(trade.id)) continue;
    // 验证层可用较新成交；seen 仅用于避免重复挂载噪音时可延后标记
    const list = fillsByWhale.get(trade.whaleId) || [];
    list.push(trade);
    fillsByWhale.set(trade.whaleId, list);
  }

  for (const whale of input.nextWhales) {
    if (whale.enabled === false) continue;
    const prev = input.prevSnap[whale.id];
    const next = nextSnap[whale.id];
    if (!next) continue;

    const items = diffPositions(prev, next);
    if (!items.length) continue;

    const freshFills = (fillsByWhale.get(whale.id) || []).filter((trade) => {
      const ts = Number(trade.time) || 0;
      return ts >= now - DOCK_ALERT_MAX_AGE_MS;
    });
    attachFillVerification(items, freshFills);
    for (const trade of fillsByWhale.get(whale.id) || []) {
      if (trade.id) seen.add(trade.id);
    }

    const kind = pickKind(items);
    const lead = items[0];
    const eventAt = Math.max(now, ...items.map((entry) => Number(entry.time) || 0));
    const coinPart = coinKey(lead.coin || 'x');
    const sizeFp = items
      .map((item) => `${item.kind}:${Number(item.usd || 0).toFixed(0)}`)
      .join('|');
    const alert: WhaleAlert = {
      id: `pos-${whale.id}-${coinPart}-${kind}-${sizeFp}`,
      at: eventAt,
      whaleId: whale.id,
      whaleName: whale.name,
      address: whale.address,
      kind,
      kindLabel: KIND_LABEL[kind],
      headline: items.length > 1 ? `${lead.title} 等 ${items.length} 笔变化` : lead.title,
      items,
      layer: 'position',
    };
    if (!isFreshDockAlert(alert, now) && eventAt < now - DOCK_ALERT_MAX_AGE_MS) {
      // 仍写入历史由调用方 merge；dock 由 filterFreshDockAlerts 过滤
    }
    alerts.push(alert);
  }

  return { alerts, seenIds: seen };
}

/**
 * 近 24h 成交回填开仓 / 补仓异动（方案 2 历史段）。
 * 按币种重建仓位尺寸：从 0 → 有仓为开仓，同向变大为补仓；减仓/平仓不生成异动。
 */
export function buildOpenIncreaseAlertsFromFills(
  whale: Pick<WhaleProfile, 'id' | 'name' | 'address'>,
  fills: WhaleTrade[],
  sinceMs: number,
): WhaleAlert[] {
  const cutoff = Math.max(0, Number(sinceMs) || 0);
  const list = (fills || [])
    .filter((trade) => {
      if (!trade || trade.source === 'onchain') return false;
      const ts = Number(trade.time) || 0;
      return ts >= cutoff;
    })
    .sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0));

  type CoinState = { signed: number };
  const states = new Map<string, CoinState>();
  const alerts: WhaleAlert[] = [];
  const eps = 1e-8;

  for (const trade of list) {
    const coin = String(trade.assetLabel || trade.asset || '').trim();
    if (!coin) continue;
    const key = coinKey(coin);
    const state = states.get(key) || { signed: 0 };
    const prev = state.signed;
    const buy = trade.side === 'buy' || trade.side === 'B' || trade.side === 'in';
    const fillSign = buy ? 1 : -1;
    const sz = Math.abs(Number(trade.amount) || 0);
    if (sz < eps) continue;
    state.signed = prev + fillSign * sz;
    states.set(key, state);

    const isCloseSide = Math.abs(Number(trade.closedPnl) || 0) > 1;
    if (isCloseSide) continue;

    const side: 'long' | 'short' = fillSign > 0 ? 'long' : 'short';
    const usd = Math.abs(Number(trade.amountUsd) || 0) || Math.abs((Number(trade.price) || 0) * sz);
    const ts = Number(trade.time) || Date.now();
    let kind: 'open' | 'increase';
    let title: string;
    if (Math.abs(prev) < eps) {
      kind = 'open';
      title = side === 'long' ? `开多 ${coin}` : `开空 ${coin}`;
    } else if (Math.sign(prev) === fillSign || Math.abs(prev) < eps) {
      kind = 'increase';
      title = `加仓 ${coin}`;
    } else {
      continue;
    }

    const id = `backfill-${kind}-${whale.id}-${key}-${trade.id || ts}`;
    alerts.push({
      id,
      at: ts,
      whaleId: whale.id,
      whaleName: whale.name,
      address: whale.address,
      kind,
      kindLabel: KIND_LABEL[kind],
      headline: title,
      layer: 'position',
      items: [
        {
          kind,
          title,
          detail: `成交 ${formatUsd(usd)} · 价 ${formatPrice(trade.price)}`,
          coin,
          usd,
          side,
          price: Number(trade.price) || null,
          time: ts,
        },
      ],
    });
  }

  return alerts;
}

/**
 * 线上 light 列表缺少仓位 diff 历史时：用带已实现盈亏的成交还原近 7 天平仓记录。
 */
export function buildCloseRecordsFromFills(
  activity: WhaleTrade[],
  whales: WhaleProfile[],
): WhaleAlert[] {
  const meta = Object.fromEntries(
    whales.map((item) => [item.id, { address: item.address, name: item.name }]),
  );
  const cutoff = Date.now() - ALERT_HISTORY_WINDOW_MS;
  return activity
    .filter(
      (trade) =>
        trade.whaleId &&
        trade.source !== 'onchain' &&
        Number(trade.time) >= cutoff &&
        Math.abs(Number(trade.closedPnl) || 0) > 1 &&
        (Number(trade.amountUsd) || 0) >= DUST_USD,
    )
    .map((trade) => {
      // HL: 卖出(A)平多，买入(B)平空
      const closedLong = trade.side === 'sell' || trade.side === 'out';
      const side = closedLong ? ('long' as const) : ('short' as const);
      const coin = trade.assetLabel || trade.asset;
      const usd = Number(trade.amountUsd) || 0;
      const pnl = Number(trade.closedPnl) || 0;
      const title = closedLong ? `平多 ${coin}` : `平空 ${coin}`;
      const item: WhaleAlertItem = {
        kind: 'close',
        title,
        detail: `名义 ${formatUsd(usd)} · 已实现 ${formatPnl(pnl)}`,
        coin,
        usd,
        side,
        pnl,
        time: trade.time,
        price: tradePrice(trade) || null,
        leverage: null,
        marginUsed: null,
      };
      return {
        id: `close-fill-${trade.id}`,
        at: trade.time,
        whaleId: trade.whaleId as string,
        whaleName: meta[trade.whaleId as string]?.name || trade.whaleName,
        address: meta[trade.whaleId as string]?.address || trade.to || trade.from,
        kind: 'close' as const,
        kindLabel: KIND_LABEL.close,
        headline: title,
        layer: 'position' as const,
        items: [item],
      };
    })
    .sort((a, b) => b.at - a.at);
}

/** 预警层：监控地址链上大额转入/转出 */
export function buildTransferRecords(activity: WhaleTrade[], whales: WhaleProfile[]): WhaleAlert[] {
  const addr = Object.fromEntries(whales.map((item) => [item.id, item.address]));
  const name = Object.fromEntries(whales.map((item) => [item.id, item.name]));
  const cutoff = Date.now() - ALERT_HISTORY_WINDOW_MS;
  return activity
    .filter(
      (trade) =>
        trade.source === 'onchain' &&
        trade.whaleId &&
        Number(trade.time) >= cutoff,
    )
    .map((trade) => {
      const inflow = trade.side === 'buy' || trade.side === 'in';
      const title = inflow ? '链上大额转入' : '链上大额转出';
      const usd = Number(trade.amountUsd) || 0;
      return {
        id: `transfer-${trade.id}`,
        at: trade.time,
        whaleId: trade.whaleId as string,
        whaleName: name[trade.whaleId as string] || trade.whaleName,
        address: addr[trade.whaleId as string] || trade.to || trade.from,
        kind: 'transfer' as const,
        kindLabel: KIND_LABEL.transfer,
        headline: `${title} ${trade.assetLabel || trade.asset || ''}`.trim(),
        layer: 'transfer' as const,
        items: [
          {
            kind: 'transfer' as const,
            title,
            detail: `${trade.assetLabel || trade.asset || '--'} ${formatUsd(usd)}`,
            coin: trade.assetLabel || trade.asset,
            side: inflow ? ('long' as const) : ('short' as const),
            usd,
            time: trade.time,
            price: tradePrice(trade) || null,
            leverage: null,
            marginUsed: null,
          },
        ],
      };
    })
    .sort((a, b) => b.at - a.at);
}

export function normalizeStoredAlert(alert: WhaleAlert): WhaleAlert | null {
  if (!alert?.id || !alert.kind) return null;
  if (!isTrackedAlertKind(alert.kind)) return null;
  const id = String(alert.id);
  // 丢弃旧版补种 / 成交反推 / 成交明细噪音
  if (
    id.startsWith('fill-') ||
    id.startsWith('seed-') ||
    id.startsWith('close-fill-') ||
    id.startsWith('fill-close-')
  ) {
    return null;
  }
  if (alert.kind === 'fill' || alert.layer === 'fill') return null;
  if ((alert as { kind: string }).kind === 'move') return null;
  return {
    ...alert,
    kindLabel: alert.kindLabel || KIND_LABEL[alert.kind] || alert.kind,
    layer: alertLayerOf(alert),
    items: Array.isArray(alert.items) ? alert.items : [],
  };
}
