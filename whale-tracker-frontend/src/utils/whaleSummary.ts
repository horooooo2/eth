import type { WhalePosition, WhaleProfile } from '@/types';
import { positionPnlPct, scopedWhaleDirection, visibleWhalePositions } from '@/utils/whaleCardUtils';
import { formatPct, formatPnl } from '@/utils/format';
import type { WhaleAlert } from '@/utils/whaleAlerts';

export interface WhaleMarketSummary {
  longUsd: number;
  shortUsd: number;
  longPct: number;
  shortPct: number;
  longAddrPct: number;
  shortAddrPct: number;
  longCount: number;
  shortCount: number;
  neutralCount: number;
  deviationPct: number;
  hint: string;
  scopeLabel: string;
}

export interface WhaleRiskSummary {
  longPnlUsd: number;
  shortPnlUsd: number;
  longPnlPct: number | null;
  shortPnlPct: number | null;
  tone: 'long_win' | 'short_win' | 'both_win' | 'both_lose' | 'mixed' | 'flat';
  label: string;
  detail: string;
  scopeLabel: string;
}

function divergenceHint(longPct: number, longAddrPct: number): string {
  const deviation = Math.abs(longPct - longAddrPct);
  if (deviation <= 20) return '';
  return longPct > longAddrPct
    ? '资金与人数分歧显著，少数巨鲸重仓押注多头'
    : '资金与人数分歧显著，少数巨鲸重仓押注空头';
}

function scopeLabel(coinFilter: string) {
  return coinFilter === 'all' ? '全部' : coinFilter.toUpperCase();
}

function collectScopedPositions(
  whales: WhaleProfile[],
  coinFilter: string,
  alerts?: WhaleAlert[],
) {
  const longPositions: WhalePosition[] = [];
  const shortPositions: WhalePosition[] = [];
  let longCount = 0;
  let shortCount = 0;
  let neutralCount = 0;

  for (const whale of whales) {
    const positions = visibleWhalePositions(whale, coinFilter, alerts);
    if (!positions.length) continue;

    const direction = scopedWhaleDirection(whale, coinFilter, alerts);
    if (direction === 'long') longCount += 1;
    else if (direction === 'short') shortCount += 1;
    else neutralCount += 1;

    for (const pos of positions) {
      if (pos.side === 'long') longPositions.push(pos);
      else shortPositions.push(pos);
    }
  }

  return { longPositions, shortPositions, longCount, shortCount, neutralCount };
}

function sumPositionUsd(positions: { positionValue?: number | null }[]) {
  return positions.reduce((sum, pos) => sum + (Number(pos.positionValue) || 0), 0);
}

function sidePnlStats(positions: WhalePosition[]) {
  let pnlUsd = 0;
  let weightedPct = 0;
  let totalUsd = 0;
  for (const pos of positions) {
    pnlUsd += Number(pos.unrealizedPnl) || 0;
    const usd = Math.abs(Number(pos.positionValue) || 0);
    const pct = positionPnlPct(pos);
    if (pct == null || !usd) continue;
    weightedPct += pct * usd;
    totalUsd += usd;
  }
  return {
    pnlUsd,
    pnlPct: totalUsd > 0 ? weightedPct / totalUsd : null,
  };
}

export function buildWhaleMarketSummary(
  whales: WhaleProfile[],
  coinFilter: string = 'all',
  alerts?: WhaleAlert[],
): WhaleMarketSummary {
  const { longPositions, shortPositions, longCount, shortCount, neutralCount } = collectScopedPositions(
    whales,
    coinFilter,
    alerts,
  );

  const longUsd = sumPositionUsd(longPositions);
  const shortUsd = sumPositionUsd(shortPositions);
  const totalUsd = longUsd + shortUsd;
  const longPct = totalUsd ? Math.round((longUsd / totalUsd) * 100) : 0;
  const shortPct = totalUsd ? 100 - longPct : 0;

  const active = longCount + shortCount;
  const longAddrPct = active ? Math.round((longCount / active) * 100) : 0;
  const shortAddrPct = active ? 100 - longAddrPct : 0;
  const deviationPct = Math.abs(longPct - longAddrPct);

  return {
    longUsd,
    shortUsd,
    longPct,
    shortPct,
    longAddrPct,
    shortAddrPct,
    longCount,
    shortCount,
    neutralCount,
    deviationPct,
    hint: divergenceHint(longPct, longAddrPct),
    scopeLabel: scopeLabel(coinFilter),
  };
}

function buildRiskDetail(longStats: ReturnType<typeof sidePnlStats>, shortStats: ReturnType<typeof sidePnlStats>) {
  const longUp = longStats.pnlUsd > 0;
  const longDown = longStats.pnlUsd < 0;
  const shortUp = shortStats.pnlUsd > 0;
  const shortDown = shortStats.pnlUsd < 0;

  if (longUp && shortDown) {
    return '多头整体浮盈、空头整体浮亏，当前价格更有利于多单持仓者。';
  }
  if (shortUp && longDown) {
    return '空头整体浮盈、多头整体浮亏，当前价格更有利于空单持仓者。';
  }
  if (longUp && shortUp) {
    return '多空两侧均在浮盈，波动扩张后需警惕一方快速回吐。';
  }
  if (longDown && shortDown) {
    return '多空两侧均在浮亏，市场波动对两侧都不友好，注意减仓与止损。';
  }
  if (Math.abs(longStats.pnlUsd) < 1 && Math.abs(shortStats.pnlUsd) < 1) {
    return '当前筛选范围内多空浮盈接近平衡，暂无明显方向性风险偏移。';
  }
  return '多空浮盈分化有限，可结合仓位价值占比判断哪一侧更拥挤。';
}

function buildRiskTone(longStats: ReturnType<typeof sidePnlStats>, shortStats: ReturnType<typeof sidePnlStats>) {
  const longUp = longStats.pnlUsd > 0;
  const longDown = longStats.pnlUsd < 0;
  const shortUp = shortStats.pnlUsd > 0;
  const shortDown = shortStats.pnlUsd < 0;

  if (longUp && shortDown) return 'long_win' as const;
  if (shortUp && longDown) return 'short_win' as const;
  if (longUp && shortUp) return 'both_win' as const;
  if (longDown && shortDown) return 'both_lose' as const;
  if (Math.abs(longStats.pnlUsd) < 1 && Math.abs(shortStats.pnlUsd) < 1) return 'flat' as const;
  return 'mixed' as const;
}

function buildRiskLabel(tone: WhaleRiskSummary['tone']) {
  if (tone === 'long_win') return '多头占优';
  if (tone === 'short_win') return '空头占优';
  if (tone === 'both_win') return '双侧浮盈';
  if (tone === 'both_lose') return '双侧浮亏';
  if (tone === 'flat') return '盈亏均衡';
  return '分化有限';
}

export function buildWhaleRiskSummary(
  whales: WhaleProfile[],
  coinFilter: string = 'all',
  alerts?: WhaleAlert[],
): WhaleRiskSummary {
  const { longPositions, shortPositions } = collectScopedPositions(whales, coinFilter, alerts);
  const longStats = sidePnlStats(longPositions);
  const shortStats = sidePnlStats(shortPositions);
  const tone = buildRiskTone(longStats, shortStats);

  return {
    longPnlUsd: longStats.pnlUsd,
    shortPnlUsd: shortStats.pnlUsd,
    longPnlPct: longStats.pnlPct,
    shortPnlPct: shortStats.pnlPct,
    tone,
    label: buildRiskLabel(tone),
    detail: buildRiskDetail(longStats, shortStats),
    scopeLabel: scopeLabel(coinFilter),
  };
}

export function formatRiskPnlLine(pnlUsd: number, pnlPct: number | null) {
  const usd = formatPnl(pnlUsd);
  if (pnlPct == null) return usd;
  return `${usd} (${formatPct(pnlPct)})`;
}

export function formatScopePositionTitle(scopeLabel: string) {
  return scopeLabel === '全部' ? '仓位价值' : `${scopeLabel} 仓位价值`;
}
