import type { WhaleProfile } from '@/types';
import {
  avgEntry,
  chaseHint,
  coinSides,
  positionPnlPct,
  spotOf,
  type RecoOptions,
  type RecoQuotes,
  type RecoWhaleRow,
} from '@/utils/recommend';
import { formatPct, formatUsd } from '@/utils/format';

/** Hyperliquid 维持保证金率近似（0.4%） */
const MAINTENANCE_MARGIN_RATE = 0.004;

export type MarginMode = 'isolated' | 'cross';

/** 逐仓爆仓价近似：仅本仓保证金承担风险 */
export function estimateLiquidationPx(
  side: 'long' | 'short',
  entryPx: number,
  leverage: number,
): number | null {
  if (!entryPx || !leverage || leverage < 1) return null;
  const im = 1 / leverage;
  if (side === 'long') return entryPx * (1 - im + MAINTENANCE_MARGIN_RATE);
  return entryPx * (1 + im - MAINTENANCE_MARGIN_RATE);
}

/** 全仓爆仓价近似：账户总权益承担本仓及他仓浮亏 */
export function estimateCrossLiquidationPx(
  side: 'long' | 'short',
  entryPx: number,
  notionalUsd: number,
  accountEquityUsd: number,
): number | null {
  if (!entryPx || notionalUsd <= 0 || accountEquityUsd <= 0) return null;
  const size = notionalUsd / entryPx;
  if (!size) return null;
  const maintenanceUsd = notionalUsd * MAINTENANCE_MARGIN_RATE;
  const bufferUsd = accountEquityUsd - maintenanceUsd;
  if (bufferUsd <= 0) return side === 'long' ? entryPx : entryPx;
  if (side === 'long') return entryPx - bufferUsd / size;
  return entryPx + bufferUsd / size;
}

export function estimateUserLiquidationPx(input: {
  side: 'long' | 'short';
  entryPx: number;
  leverage: number;
  marginUsd: number;
  marginMode?: MarginMode;
  accountEquityUsd?: number;
}): number | null {
  const leverage = Math.max(1, input.leverage || 1);
  const marginUsd = Math.max(0, input.marginUsd || 0);
  const notionalUsd = marginUsd * leverage;
  if (input.marginMode === 'cross') {
    const equity = Math.max(0, input.accountEquityUsd ?? marginUsd);
    return estimateCrossLiquidationPx(input.side, input.entryPx, notionalUsd, equity);
  }
  return estimateLiquidationPx(input.side, input.entryPx, leverage);
}

/** 现价距爆仓价的百分比空间（越大越安全） */
export function liquidationDistancePct(
  side: 'long' | 'short',
  spot: number,
  liqPx: number | null,
): number | null {
  if (!spot || !liqPx || liqPx <= 0) return null;
  if (side === 'long') {
    if (spot <= liqPx) return 0;
    return ((spot - liqPx) / spot) * 100;
  }
  if (spot >= liqPx) return 0;
  return ((liqPx - spot) / spot) * 100;
}

function rowLiquidationPx(row: RecoWhaleRow) {
  if (row.liquidationPx && row.liquidationPx > 0) return row.liquidationPx;
  if (!row.price || !row.leverage) return null;
  return estimateLiquidationPx(row.side, row.price, row.leverage);
}

function avgLiquidationDistance(rows: RecoWhaleRow[], spot: number) {
  const valid = rows
    .map((item) => {
      const liqPx = rowLiquidationPx(item);
      const dist = liquidationDistancePct(item.side, spot, liqPx);
      return dist == null ? null : { dist, weight: item.weightedUsd };
    })
    .filter((item): item is { dist: number; weight: number } => item != null);
  if (!valid.length) return null;
  const usd = valid.reduce((sum, item) => sum + item.weight, 0);
  if (usd > 0) return valid.reduce((sum, item) => sum + item.dist * item.weight, 0) / usd;
  return valid.reduce((sum, item) => sum + item.dist, 0) / valid.length;
}

function liqDistLabel(userDist: number | null, whaleDist: number | null) {
  if (userDist == null && whaleDist == null) return '暂无爆仓距离对比';
  const userText = userDist == null ? '--' : `${userDist.toFixed(1)}%`;
  const whaleText = whaleDist == null ? '--' : `${whaleDist.toFixed(1)}%`;
  return `你 ${userText} · 巨鲸约 ${whaleText}`;
}

function marginModeLabel(mode: MarginMode) {
  return mode === 'cross' ? '全仓' : '逐仓';
}

function marginModeBullet(mode: MarginMode, accountEquityUsd: number | null) {
  if (mode === 'cross') {
    const equityText =
      accountEquityUsd != null && accountEquityUsd > 0 ? formatUsd(accountEquityUsd) : '未填写';
    return `保证金模式：全仓（爆仓价按账户权益 ${equityText} 估算，含其他仓位浮亏影响）`;
  }
  return '保证金模式：逐仓（仅本仓保证金承担爆仓风险）';
}

function liqDistBullet(
  side: 'long' | 'short',
  userDist: number | null,
  whaleDist: number | null,
  marginMode: MarginMode,
) {
  if (userDist == null) return '暂无现价，无法估算你的爆仓距离';
  const modeHint = marginMode === 'cross' ? '（全仓）' : '（逐仓）';
  const base = `爆仓距离${modeHint}：你还有约 ${userDist.toFixed(1)}% 空间`;
  if (whaleDist == null) return base;
  const gap = userDist - whaleDist;
  if (Math.abs(gap) < 1) return `${base}，与巨鲸同向平均接近`;
  if (gap > 0) {
    return `${base}，比巨鲸同向平均多约 ${gap.toFixed(1)}%（你更安全）`;
  }
  const word = side === 'long' ? '下跌' : '上涨';
  return `${base}，比巨鲸同向平均少约 ${Math.abs(gap).toFixed(1)}%（${word}更易触发爆仓）`;
}

export interface UserPositionInput {
  coin: string;
  side: 'long' | 'short';
  leverage: number;
  marginUsd: number;
  entryPx: number;
  marginMode?: MarginMode;
  /** 全仓模式下用于估算爆仓价的账户总权益 */
  accountEquityUsd?: number;
}

export type PositionAlignLevel = 'strong' | 'mixed' | 'contrarian';

export interface PositionPeerRow {
  id: string;
  name: string;
  entryPx: number;
  leverage: number | null;
  usd: number;
  pnlPct: number | null;
  entryGapPct: number | null;
}

export interface PositionAnalysisResult {
  user: {
    coin: string;
    side: 'long' | 'short';
    leverage: number;
    marginUsd: number;
    marginMode: MarginMode;
    accountEquityUsd: number | null;
    notionalUsd: number;
    entryPx: number;
    spot: number;
    pnlPct: number | null;
    pnlUsd: number | null;
    liquidationPx: number | null;
  };
  whale: {
    longUsd: number;
    shortUsd: number;
    longPct: number;
    shortPct: number;
    sameSideUsd: number;
    sameSideCount: number;
    oppositeSideCount: number;
    avgEntrySameSide: number;
    whaleRows: RecoWhaleRow[];
  };
  compare: {
    alignLevel: PositionAlignLevel;
    alignLabel: string;
    sameSidePct: number;
    notionalSharePct: number | null;
    entryGapPct: number | null;
    entryGapLabel: string;
    userLiqDistPct: number | null;
    whaleLiqDistPct: number | null;
    liqDistGap: number | null;
    liqDistLabel: string;
    pnlHint: string;
    summary: string;
    bullets: string[];
    peers: PositionPeerRow[];
  };
}

function enabledWhales(whales: WhaleProfile[]) {
  return whales.filter((item) => item.enabled !== false);
}

function scopeWhales(whales: WhaleProfile[], coin?: string) {
  if (!coin) return whales;
  const key = coin.toUpperCase();
  return whales.filter((item) =>
    (item.positions || []).some((pos) => String(pos.coin).toUpperCase().replace(/^K/, '') === key),
  );
}

function alignMeta(sameSidePct: number) {
  if (sameSidePct >= 65) {
    return { level: 'strong' as const, label: '同向共振' };
  }
  if (sameSidePct >= 45) {
    return { level: 'mixed' as const, label: '方向分歧' };
  }
  return { level: 'contrarian' as const, label: '逆势持仓' };
}

function entryGapLabel(side: 'long' | 'short', gapPct: number | null) {
  if (gapPct == null) return '暂无巨鲸同向开仓均价';
  const abs = Math.abs(gapPct).toFixed(2);
  if (Math.abs(gapPct) < 0.8) return `与巨鲸同向加权均价基本一致（${formatPct(gapPct)})`;
  if (side === 'long') {
    return gapPct > 0
      ? `高于巨鲸同向加权均价 ${abs}%（追多成本偏高）`
      : `低于巨鲸同向加权均价 ${abs}%（更接近回踩区）`;
  }
  return gapPct > 0
    ? `高于巨鲸同向加权均价 ${abs}%（空单开仓偏晚）`
    : `低于巨鲸同向加权均价 ${abs}%（空单开仓更早）`;
}

function buildPeers(rows: RecoWhaleRow[], entryPx: number, spot: number) {
  return rows
    .filter((item) => item.price > 0)
    .map((item) => {
      const entryGapPct = ((entryPx - item.price) / item.price) * 100;
      return {
        id: item.id,
        name: item.name,
        entryPx: item.price,
        leverage: item.leverage,
        usd: item.usd,
        pnlPct: spot > 0 ? positionPnlPct(item.side, item.price, spot) : null,
        entryGapPct,
      };
    })
    .sort((a, b) => Math.abs(a.entryGapPct) - Math.abs(b.entryGapPct))
    .slice(0, 6);
}

function normalizeAnalysisCoin(coin: string) {
  return String(coin || '').toUpperCase().replace(/^K/, '');
}

/** 当前持仓快照：不做时间窗过滤、不做开仓衰减 */
function collectCurrentCoinPositions(whales: WhaleProfile[], coin: string): RecoWhaleRow[] {
  const key = normalizeAnalysisCoin(coin);
  const rows: RecoWhaleRow[] = [];
  for (const whale of whales) {
    for (const pos of whale.positions || []) {
      if (normalizeAnalysisCoin(pos.coin) !== key) continue;
      const usd = Number(pos.positionValue) || 0;
      if (!usd) continue;
      rows.push({
        id: whale.id,
        name: whale.name,
        coin: key,
        side: pos.side,
        price: pos.entryPx,
        leverage: pos.leverage,
        usd,
        weightedUsd: usd,
        weight: 1,
        size: Number(pos.size) || 0,
        pnl: Number(pos.unrealizedPnl) || 0,
        winRate: whale.winRate || 0,
        openTime: pos.openTime || null,
        liquidationPx:
          pos.liquidationPx == null || pos.liquidationPx === ''
            ? null
            : Number(pos.liquidationPx) || null,
      });
    }
  }
  return rows.sort((a, b) => b.usd - a.usd);
}

export function analyzeUserPosition(
  input: UserPositionInput,
  whales: WhaleProfile[],
  quotes: RecoQuotes = {},
  _options: RecoOptions = {},
): PositionAnalysisResult {
  const coinKey = normalizeAnalysisCoin(input.coin);
  const list = scopeWhales(enabledWhales(whales), coinKey);
  const rows = collectCurrentCoinPositions(list, coinKey);
  const book = coinSides(rows, coinKey);
  const sameRows = input.side === 'long' ? book.longs : book.shorts;
  const oppositeRows = input.side === 'long' ? book.shorts : book.longs;

  const spot = spotOf(input.coin, quotes, rows);
  const notionalUsd = Math.max(0, input.marginUsd) * Math.max(1, input.leverage);
  const pnlPct = spot > 0 ? positionPnlPct(input.side, input.entryPx, spot) : null;
  const pnlUsd = pnlPct == null ? null : (notionalUsd * pnlPct) / 100;

  const totalUsd = book.longUsd + book.shortUsd;
  const longPct = totalUsd ? Math.round((book.longUsd / totalUsd) * 100) : 50;
  const shortPct = totalUsd ? 100 - longPct : 50;
  const sameSideUsd = input.side === 'long' ? book.longUsd : book.shortUsd;
  const sameSidePct = totalUsd ? Math.round((sameSideUsd / totalUsd) * 100) : 50;
  const align = alignMeta(sameSidePct);

  const marginMode: MarginMode = input.marginMode === 'cross' ? 'cross' : 'isolated';
  const accountEquityUsd =
    marginMode === 'cross' ? Math.max(0, input.accountEquityUsd ?? input.marginUsd) : null;

  const avgEntrySameSide = avgEntry(sameRows);
  const entryGapPct =
    avgEntrySameSide > 0 ? ((input.entryPx - avgEntrySameSide) / avgEntrySameSide) * 100 : null;
  const userLiqPx = estimateUserLiquidationPx({
    side: input.side,
    entryPx: input.entryPx,
    leverage: input.leverage,
    marginUsd: input.marginUsd,
    marginMode,
    accountEquityUsd: accountEquityUsd ?? undefined,
  });
  const userLiqDistPct = liquidationDistancePct(input.side, spot, userLiqPx);
  const whaleLiqDistPct = spot > 0 ? avgLiquidationDistance(sameRows, spot) : null;
  const liqDistGap =
    userLiqDistPct != null && whaleLiqDistPct != null ? userLiqDistPct - whaleLiqDistPct : null;
  const notionalSharePct = sameSideUsd > 0 ? (notionalUsd / sameSideUsd) * 100 : null;

  const pnlHint =
    pnlPct == null ? '暂无现价，无法估算浮盈' : chaseHint(input.side, ((spot - input.entryPx) / input.entryPx) * 100);

  const bullets: string[] = [
    `${input.coin} 巨鲸名义多空比 ${longPct}% : ${shortPct}%（多 ${formatUsd(book.longUsd)} / 空 ${formatUsd(book.shortUsd)}）`,
    `你的方向：${input.side === 'long' ? '做多' : '做空'}（${marginModeLabel(marginMode)}），与监控巨鲸同向名义占比约 ${sameSidePct}%（${align.label}）`,
    marginModeBullet(marginMode, accountEquityUsd),
    entryGapLabel(input.side, entryGapPct),
    liqDistBullet(input.side, userLiqDistPct, whaleLiqDistPct, marginMode),
    notionalSharePct != null
      ? `名义体量：你的 ${formatUsd(notionalUsd)} 约占同向巨鲸总名义 ${notionalSharePct.toFixed(2)}%`
      : `你的名义体量：${formatUsd(notionalUsd)}`,
    `浮盈状态：${pnlHint}`,
    `同向巨鲸 ${sameRows.length} 地址，反向 ${oppositeRows.length} 地址`,
  ];

  let summary = '';
  if (align.level === 'strong') {
    summary =
      pnlPct != null && pnlPct < -4
        ? '方向与巨鲸主流一致，但现价已偏离你的成本，注意止损与仓位管理。'
        : '方向与巨鲸主流一致，可参考同向加权开仓区与爆仓距离校验自己的持仓。';
  } else if (align.level === 'mixed') {
    summary = '巨鲸在该币种上分歧较大，你的仓位需更依赖自身成本与风控，不宜盲目跟单。';
  } else {
    summary = '你当前方向与监控巨鲸主流相反，属于逆势交易，需有独立逻辑并严格控制风险。';
  }

  return {
    user: {
      coin: input.coin,
      side: input.side,
      leverage: input.leverage,
      marginUsd: input.marginUsd,
      marginMode,
      accountEquityUsd,
      notionalUsd,
      entryPx: input.entryPx,
      spot,
      pnlPct,
      pnlUsd,
      liquidationPx: userLiqPx,
    },
    whale: {
      longUsd: book.longUsd,
      shortUsd: book.shortUsd,
      longPct,
      shortPct,
      sameSideUsd,
      sameSideCount: sameRows.length,
      oppositeSideCount: oppositeRows.length,
      avgEntrySameSide,
      whaleRows: rows.filter((item) => item.coin === coinKey),
    },
    compare: {
      alignLevel: align.level,
      alignLabel: align.label,
      sameSidePct,
      notionalSharePct,
      entryGapPct,
      entryGapLabel: entryGapLabel(input.side, entryGapPct),
      userLiqDistPct,
      whaleLiqDistPct,
      liqDistGap,
      liqDistLabel: liqDistLabel(userLiqDistPct, whaleLiqDistPct),
      pnlHint,
      summary,
      bullets,
      peers: buildPeers(sameRows, input.entryPx, spot),
    },
  };
}

export function formatEntryGap(entryGapPct: number | null) {
  if (entryGapPct == null) return '--';
  return formatPct(entryGapPct);
}
