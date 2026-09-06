import type {
  PositionEntryFill,
  PositionEntryFillKind,
  WhalePosition,
  WhaleProfile,
} from '@/types';
import { filterFreshPositions, freshModeEnabled, freshOpenCoinsForWhale } from '@/utils/freshMode';
import type { WhaleAlert } from '@/utils/whaleAlerts';
import { normalizeCoinId } from '@/utils/watchedCoins';

export function whaleCoinKey(coin: string | undefined | null) {
  return normalizeCoinId(String(coin || '').replace(/^K/, ''));
}

export function whaleTopCoins(whale: WhaleProfile): string[] {
  if (whale.topCoins?.length) return whale.topCoins;
  const match = (whale.description || '').match(/主做\s*([^，,；;]+)/);
  if (match?.[1]) {
    return match[1]
      .split(/[/|、\s]+/)
      .map((item) => whaleCoinKey(item))
      .filter(Boolean);
  }
  const fromPos = (whale.positions || [])
    .map((pos) => whaleCoinKey(pos.coinLabel || pos.coin))
    .filter(Boolean);
  return [...new Set(fromPos)];
}

export function whaleMatchesCoin(whale: WhaleProfile, coin: string) {
  const key = whaleCoinKey(coin);
  if (!key) return true;
  if (whaleTopCoins(whale).some((item) => whaleCoinKey(item) === key)) return true;
  return (whale.positions || []).some((pos) => positionMatchesCoin(pos, coin));
}

export function positionMatchesCoin(pos: WhalePosition, coin: string) {
  const key = whaleCoinKey(coin);
  if (!key) return true;
  return whaleCoinKey(pos.coinLabel || pos.coin) === key;
}

export function whaleHasPositionCoin(whale: WhaleProfile, coin: string) {
  return perpWhalePositions(whale).some((pos) => positionMatchesCoin(pos, coin));
}

export function perpWhalePositions(whale: WhaleProfile) {
  return (whale.positions || []).filter((pos) => {
    const coin = String(pos.coin || pos.coinLabel || '');
    if (/^@\d+$/i.test(coin)) return false;
    if (coin.includes(':')) return false;
    return Math.abs(Number(pos.size) || 0) > 0 || Math.abs(Number(pos.positionValue) || 0) > 0;
  });
}

export function visibleWhalePositions(
  whale: WhaleProfile,
  coinFilter: string,
  alerts?: WhaleAlert[],
) {
  let positions = perpWhalePositions(whale);
  // 「近时」模式：只展示窗口内新开仓的持仓（缺 openTime 时用开仓异动兜底）
  if (freshModeEnabled.value) {
    const openCoins = freshOpenCoinsForWhale(whale.id, alerts);
    positions = filterFreshPositions(positions, Date.now(), { openCoins });
  }
  if (!coinFilter || coinFilter === 'all') return positions;
  return positions.filter((pos) => positionMatchesCoin(pos, coinFilter));
}

/** 按当前币种筛选范围计算方向；未筛币种时用账户整体方向 */
export function scopedWhaleDirection(
  whale: WhaleProfile,
  coinFilter: string = 'all',
  alerts?: WhaleAlert[],
): 'long' | 'short' | 'neutral' {
  // 「近时」模式或筛了币种：按可见持仓重算方向，避免旧仓位干扰
  if (freshModeEnabled.value || (coinFilter && coinFilter !== 'all')) {
    const positions = visibleWhalePositions(whale, coinFilter, alerts);
    if (!positions.length) return 'neutral';
    let longUsd = 0;
    let shortUsd = 0;
    for (const pos of positions) {
      const usd = Math.abs(Number(pos.positionValue) || 0);
      if (pos.side === 'long') longUsd += usd;
      else if (pos.side === 'short') shortUsd += usd;
    }
    if (longUsd > shortUsd && longUsd > 0) return 'long';
    if (shortUsd > longUsd && shortUsd > 0) return 'short';
    return 'neutral';
  }
  return whale.direction === 'long' || whale.direction === 'short' ? whale.direction : 'neutral';
}

export function positionsAggregatePnlPct(positions: WhalePosition[]): number | null {
  if (!positions.length) return null;
  let weighted = 0;
  let totalMargin = 0;
  for (const pos of positions) {
    const pct = positionPnlPct(pos);
    const margin = positionMarginUsd(pos);
    if (pct == null || !margin) continue;
    weighted += pct * margin;
    totalMargin += margin;
  }
  if (!totalMargin) return null;
  return weighted / totalMargin;
}

export function inferMarkPx(pos: WhalePosition): number | null {
  const entry = Number(pos.entryPx) || 0;
  const size = Math.abs(Number(pos.size) || 0);
  const pnl = Number(pos.unrealizedPnl) || 0;
  if (!entry || !size) return entry || null;
  return pos.side === 'long' ? entry + pnl / size : entry - pnl / size;
}

function positionMarginUsd(pos: WhalePosition): number {
  const margin = Number(pos.marginUsed) || 0;
  if (margin > 0) return margin;
  const lev = Number(pos.leverage) || 0;
  const notional = Math.abs(Number(pos.positionValue) || 0);
  if (lev > 0 && notional > 0) return notional / lev;
  return notional;
}

/** 仓位盈亏百分比：按保证金口径（含杠杆），与交易所 ROE 一致 */
export function positionPnlPct(pos: WhalePosition): number | null {
  const pnl = Number(pos.unrealizedPnl);
  if (!Number.isFinite(pnl)) return null;
  const margin = positionMarginUsd(pos);
  if (!margin) return null;
  return (pnl / margin) * 100;
}

export function whaleAggregatePnlPct(whale: WhaleProfile): number | null {
  const positions = whale.positions || [];
  if (!positions.length) return null;
  let weighted = 0;
  let totalMargin = 0;
  for (const pos of positions) {
    const pct = positionPnlPct(pos);
    const margin = positionMarginUsd(pos);
    if (pct == null || !margin) continue;
    weighted += pct * margin;
    totalMargin += margin;
  }
  if (!totalMargin) return null;
  return weighted / totalMargin;
}

/** 盈亏百分比与进度条宽度 1:1，如 +24% → 24% 条宽，上限 100% */
export function pnlBarWidth(pct: number | null) {
  if (pct == null) return 0;
  return Math.min(100, Math.abs(pct));
}

export function formatSideWinRate(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return '--';
  return `${Math.round(value)}%`;
}

/** 补仓记录合并窗口：10 秒内视为同一笔拆单 */
export const ENTRY_FILL_MERGE_MS = 10_000;
/** 展开明细时首尾各保留条数，中间用 ... 省略 */
export const ENTRY_FILL_EDGE = 1000;

/** 10 秒窗口内的同类记录合并为一笔（加权均价） */
export function mergePositionEntryFills(
  fills: PositionEntryFill[] = [],
  windowMs = ENTRY_FILL_MERGE_MS,
) {
  const merged: PositionEntryFill[] = [];
  for (const fill of fills) {
    const prev = merged[merged.length - 1];
    if (prev && prev.kind === fill.kind && fill.time - prev.time <= windowMs) {
      const size = prev.size + fill.size;
      const usd = prev.usd + fill.usd;
      prev.size = size;
      prev.usd = usd;
      prev.price = size > 0 ? usd / size : fill.price;
      prev.closedPnl = (prev.closedPnl || 0) + (fill.closedPnl || 0);
      continue;
    }
    merged.push({ ...fill });
  }
  return merged;
}

/** 明细行类型：老缓存没有 kind 时退化为「首笔开仓、其余补仓」 */
export function entryFillKind(
  fill: PositionEntryFill,
  index: number,
): PositionEntryFillKind {
  if (fill.kind) return fill.kind;
  return index === 0 ? 'open' : 'add';
}

const ENTRY_FILL_LABELS: Record<PositionEntryFillKind, string> = {
  open: '开仓',
  add: '补仓',
  reduce: '减仓',
};

export function entryFillLabel(fill: PositionEntryFill, index: number) {
  return ENTRY_FILL_LABELS[entryFillKind(fill, index)];
}

/** 时间正序完整明细（未做首尾裁剪展示） */
export function positionEntryFills(pos: WhalePosition) {
  return mergePositionEntryFills(pos.entryFills || []);
}

export function entryFillTotalCount(pos: Pick<WhalePosition, 'entryFills' | 'entryFillsOmitted'>) {
  return positionEntryFills(pos as WhalePosition).length + (Number(pos.entryFillsOmitted) || 0);
}

export type EntryFillDisplayItem =
  | { type: 'fill'; fill: PositionEntryFill; index: number }
  | { type: 'gap'; omitted: number };

/**
 * 展开展示：开仓在前 → 前 1000 → ... → 后 1000（最新）。
 * 后端已裁剪时靠 entryFillsOmitted 插入分隔；否则前端本地裁剪。
 */
export function displayEntryFillItems(
  fills: PositionEntryFill[] = [],
  omitted = 0,
  edge = ENTRY_FILL_EDGE,
): EntryFillDisplayItem[] {
  const merged = mergePositionEntryFills(fills);
  const knownOmitted = Math.max(0, Number(omitted) || 0);

  if (knownOmitted > 0 && merged.length > edge) {
    const head = merged.slice(0, edge);
    const tail = merged.slice(edge);
    return [
      ...head.map((fill, index) => ({ type: 'fill' as const, fill, index })),
      { type: 'gap', omitted: knownOmitted },
      ...tail.map((fill, i) => ({
        type: 'fill' as const,
        fill,
        index: edge + knownOmitted + i,
      })),
    ];
  }

  if (merged.length > edge * 2) {
    const skip = merged.length - edge * 2;
    return [
      ...merged.slice(0, edge).map((fill, index) => ({ type: 'fill' as const, fill, index })),
      { type: 'gap', omitted: skip },
      ...merged.slice(-edge).map((fill, i) => ({
        type: 'fill' as const,
        fill,
        index: edge + skip + i,
      })),
    ];
  }

  return merged.map((fill, index) => ({ type: 'fill' as const, fill, index }));
}
