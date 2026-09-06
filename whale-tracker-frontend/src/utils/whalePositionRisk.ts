import type { WhalePosition, WhaleProfile } from '@/types';
import { formatPct, formatUsd, shortAddress } from '@/utils/format';
import { liquidationDistancePct } from '@/utils/positionAnalysis';
import { positionPnlPct } from '@/utils/recommend';

const DAY_MS = 24 * 60 * 60 * 1000;

export type CredibilityTier = 'high' | 'mid' | 'watch' | 'low';
export type TradeRiskLevel = 'low' | 'medium' | 'high' | 'extreme';

export interface ClosedTradeSample {
  openTime: number;
  closeTime: number;
  /** >0 盈利 */
  result: number;
}

export interface WhalePositionRiskHistorical {
  winRate: number | null;
  maxDrawdown: number | null;
  totalTrades: number | null;
  monthlyPnL: number | null;
  avgHoldingDays: number | null;
  maxHoldingDays: number | null;
  adjustedWinRate: number | null;
  adjustedSource: 'weighted' | 'raw' | 'missing';
  adjustedNote: string;
}

export interface WhalePositionRiskCurrent {
  unrealizedPnlPct: number | null;
  positionRatio: number | null;
  liquidationDistance: number | null;
  direction: 'long' | 'short';
  crowdDirection: 'long' | 'short' | 'mixed' | null;
  crowdRatio: number | null;
  openTime: string | null;
  openTimeMs: number | null;
  firstOpenTimeMs: number | null;
  lastAddTimeMs: number | null;
  openHistoryComplete: boolean | null;
  leverage: number | null;
  holdingDays: number | null;
  isPotentialBagholding: boolean;
}

export interface DimensionScore {
  key: string;
  label: string;
  weight: number;
  /** 有效权重（缺失维度重分配后） */
  effectiveWeight: number;
  score: number | null;
  missing: boolean;
  missingLabel?: string;
  detail: string;
}

export interface CredibilityCard {
  tier: CredibilityTier;
  label: string;
  color: string;
  historical: WhalePositionRiskHistorical;
  bullets: string[];
}

export interface TradeRiskCard {
  score: number;
  level: TradeRiskLevel;
  levelLabel: string;
  advice: string;
  current: WhalePositionRiskCurrent;
  dimensions: DimensionScore[];
  warnings: string[];
  summary: string;
}

export interface WhalePositionRiskResult {
  historical: WhalePositionRiskHistorical;
  current: WhalePositionRiskCurrent;
  credibility: CredibilityCard;
  tradeRisk: TradeRiskCard;
  followAdvice: string;
}

export interface BuildRiskInput {
  whale: WhaleProfile;
  coin: string;
  side: 'long' | 'short';
  entryPx: number;
  spot: number;
  notionalUsd: number;
  liquidationPx?: number | null;
  leverage?: number | null;
  /** @deprecated 请优先传 firstOpenTime */
  openTime?: number | null;
  firstOpenTime?: number | null;
  lastAddTime?: number | null;
  openHistoryComplete?: boolean | null;
  whales: WhaleProfile[];
  /** 可选：已完结周期，用于时间加权胜率 */
  closedTrades?: ClosedTradeSample[];
  /** 后端 riskHistory 补充字段 */
  monthlyPnL?: number | null;
  avgHoldingDays?: number | null;
  maxHoldingDays?: number | null;
  now?: number;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function normalizeCoin(coin: string) {
  return String(coin || '')
    .toUpperCase()
    .replace(/^K/, '');
}

function numOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 时间加权胜率：持仓越久，该笔胜负权重越低 */
export function getAdjustedWinRate(
  rawWinRate: number | null,
  trades: ClosedTradeSample[] | undefined,
): Pick<
  WhalePositionRiskHistorical,
  'adjustedWinRate' | 'adjustedSource' | 'adjustedNote' | 'avgHoldingDays' | 'maxHoldingDays'
> {
  const list = Array.isArray(trades) ? trades : [];
  if (!list.length) {
    return {
      adjustedWinRate: rawWinRate,
      adjustedSource: rawWinRate == null ? 'missing' : 'raw',
      adjustedNote:
        rawWinRate == null
          ? '缺少胜率与平仓明细，无法计算时间加权胜率'
          : '缺少逐笔持仓时长，暂用原始胜率（可能含扛单胜）',
      avgHoldingDays: null,
      maxHoldingDays: null,
    };
  }

  let weightedSum = 0;
  let totalWeight = 0;
  let holdSum = 0;
  let holdCount = 0;
  let maxHold = 0;

  for (const trade of list) {
    const open = Number(trade.openTime) || 0;
    const close = Number(trade.closeTime) || 0;
    if (!open || !close || close <= open) continue;
    const holdingDays = (close - open) / DAY_MS;
    holdSum += holdingDays;
    holdCount += 1;
    maxHold = Math.max(maxHold, holdingDays);

    let weight = 1;
    if (holdingDays > 14) weight = 0.3;
    else if (holdingDays > 7) weight = 0.5;
    else if (holdingDays > 3) weight = 0.7;

    weightedSum += (Number(trade.result) > 0 ? 1 : 0) * weight;
    totalWeight += weight;
  }

  if (totalWeight <= 0) {
    return {
      adjustedWinRate: rawWinRate,
      adjustedSource: rawWinRate == null ? 'missing' : 'raw',
      adjustedNote: '平仓样本无效，暂用原始胜率',
      avgHoldingDays: null,
      maxHoldingDays: null,
    };
  }

  return {
    adjustedWinRate: (weightedSum / totalWeight) * 100,
    adjustedSource: 'weighted',
    adjustedNote: `基于 ${holdCount} 笔已完结周期的持仓时长加权`,
    avgHoldingDays: holdCount ? holdSum / holdCount : null,
    maxHoldingDays: holdCount ? maxHold : null,
  };
}

export function resolveCredibilityTier(historical: WhalePositionRiskHistorical): CredibilityCard {
  const trades = historical.totalTrades;
  const dd = historical.maxDrawdown;
  const wr = historical.adjustedWinRate;
  const insufficient =
    trades == null ||
    trades < 50 ||
    (wr == null && (historical.winRate == null || historical.winRate <= 0));

  let tier: CredibilityTier = 'watch';
  let label = '⚪ 数据不足';
  let color = 'watch';

  if (insufficient) {
    tier = 'watch';
    label = '⚪ 数据不足';
    color = 'watch';
  } else if ((dd != null && dd > 50) || (wr != null && wr < 45)) {
    tier = 'low';
    label = '🔴 低可信度';
    color = 'low';
  } else if (wr != null && wr >= 65 && dd != null && dd < 30 && (trades || 0) >= 500) {
    tier = 'high';
    label = '🟢 高可信度';
    color = 'high';
  } else if (wr != null && wr >= 55 && dd != null && dd < 40 && (trades || 0) >= 100) {
    tier = 'mid';
    label = '🟡 中可信度';
    color = 'mid';
  } else if ((trades || 0) < 50) {
    tier = 'watch';
    label = '⚪ 数据不足';
    color = 'watch';
  } else {
    tier = 'watch';
    label = '⚪ 待观察';
    color = 'watch';
  }

  const bullets: string[] = [];
  if (historical.winRate != null) {
    bullets.push(
      historical.adjustedSource === 'weighted' && historical.adjustedWinRate != null
        ? `时间加权胜率：原始 ${historical.winRate.toFixed(0)}% → 调整后 ${historical.adjustedWinRate.toFixed(0)}%`
        : `胜率：${historical.winRate.toFixed(0)}%（${historical.adjustedNote}）`,
    );
  } else {
    bullets.push('胜率：数据缺失');
  }
  if (dd != null) bullets.push(`历史最大回撤：${dd.toFixed(0)}%`);
  else bullets.push('回撤：数据缺失');
  if (trades != null) bullets.push(`总笔数：${trades}`);
  else bullets.push('总笔数：数据缺失');
  if (historical.monthlyPnL != null) bullets.push(`近30天盈亏：${formatUsd(historical.monthlyPnL)}`);
  if (historical.avgHoldingDays != null) {
    bullets.push(`平均持仓：${historical.avgHoldingDays.toFixed(1)} 天`);
  }

  return { tier, label, color, historical, bullets };
}

function scorePnl(pnlPct: number | null): Omit<DimensionScore, 'effectiveWeight'> {
  if (pnlPct == null) {
    return {
      key: 'pnl',
      label: '浮盈/浮亏',
      weight: 0.25,
      score: null,
      missing: true,
      missingLabel: '数据缺失，不纳入评分',
      detail: '暂无现价或开仓价，浮盈浮亏未知',
    };
  }
  let score = 50;
  let detail = `浮盈 ${formatPct(pnlPct)}`;
  if (pnlPct <= -15) {
    score = 88;
    detail = `浮亏 ${formatPct(pnlPct)}，亏损较深`;
  } else if (pnlPct <= -5) {
    // 浮亏 5–15%：中高风险（约 55–70）
    score = 55 + ((-5 - pnlPct) / 10) * 15;
    detail = `浮亏 ${formatPct(pnlPct)}，中高风险区间`;
  } else if (pnlPct < 0) {
    score = 45;
    detail = `小幅浮亏 ${formatPct(pnlPct)}`;
  } else if (pnlPct >= 5) {
    score = 22;
    detail = `浮盈 ${formatPct(pnlPct)}，短期压力相对较低`;
  } else {
    score = 35;
    detail = `小幅浮盈 ${formatPct(pnlPct)}`;
  }
  return {
    key: 'pnl',
    label: '浮盈/浮亏',
    weight: 0.25,
    score: clamp(score, 0, 100),
    missing: false,
    detail,
  };
}

function scorePositionRatio(ratio: number | null): Omit<DimensionScore, 'effectiveWeight'> {
  if (ratio == null) {
    return {
      key: 'ratio',
      label: '仓位占比',
      weight: 0.2,
      score: null,
      missing: true,
      missingLabel: '数据缺失，不纳入评分',
      detail: '总仓位未知，无法计算占比',
    };
  }
  let score = 40;
  let detail = `仓位占比 ${ratio.toFixed(0)}%`;
  if (ratio > 50) {
    score = 85;
    detail = `仓位占比 ${ratio.toFixed(0)}%，偏重仓`;
  } else if (ratio >= 20) {
    score = 65;
    detail = `仓位占比 ${ratio.toFixed(0)}%，权重中等`;
  } else {
    score = 28;
    detail = `仓位占比 ${ratio.toFixed(1)}%，偏轻仓`;
  }
  return {
    key: 'ratio',
    label: '仓位占比',
    weight: 0.2,
    score,
    missing: false,
    detail,
  };
}

function scoreLiqDist(dist: number | null): Omit<DimensionScore, 'effectiveWeight'> {
  if (dist == null) {
    return {
      key: 'liq',
      label: '爆仓距离',
      weight: 0.2,
      score: null,
      missing: true,
      missingLabel: '数据缺失，不纳入评分',
      detail: '爆仓价或现价缺失',
    };
  }
  let score = 40;
  let detail = `距爆仓约 ${dist.toFixed(1)}%`;
  if (dist < 20) {
    score = 95;
    detail = `距爆仓仅 ${dist.toFixed(1)}%，空间极紧`;
  } else if (dist <= 40) {
    score = 40 + ((40 - dist) / 20) * 35;
    detail = `距爆仓 ${dist.toFixed(1)}%，偏近`;
  } else {
    score = 25;
    detail = `距爆仓 ${dist.toFixed(1)}%，缓冲尚可`;
  }
  return {
    key: 'liq',
    label: '爆仓距离',
    weight: 0.2,
    score: clamp(score, 0, 100),
    missing: false,
    detail,
  };
}

function scoreCrowd(
  sameSidePct: number | null,
  againstTrend: boolean | null,
): Omit<DimensionScore, 'effectiveWeight'> {
  if (sameSidePct == null || againstTrend == null) {
    return {
      key: 'crowd',
      label: '方向拥挤度',
      weight: 0.15,
      score: null,
      missing: true,
      missingLabel: '数据缺失，不纳入评分',
      detail: '群体多空结构未知',
    };
  }
  let score = 45;
  let detail = `同向约 ${sameSidePct}%`;
  if (againstTrend && sameSidePct < 30) {
    score = 82;
    detail = `逆势且同向仅 ${sameSidePct}%`;
  } else if (sameSidePct > 70) {
    score = 28;
    detail = `同向 ${sameSidePct}%，一致性较高`;
  } else if (againstTrend) {
    score = 68;
    detail = `偏逆势（同向 ${sameSidePct}%）`;
  } else if (sameSidePct >= 55) {
    score = 38;
    detail = `同向有支撑（${sameSidePct}%）`;
  }
  return {
    key: 'crowd',
    label: '方向拥挤度',
    weight: 0.15,
    score,
    missing: false,
    detail,
  };
}

function scoreHolding(
  holdingDays: number | null,
  pnlPct: number | null,
  openHistoryComplete: boolean | null,
): Omit<DimensionScore, 'effectiveWeight'> {
  if (openHistoryComplete === false || holdingDays == null) {
    return {
      key: 'hold',
      label: '持仓时间',
      weight: 0.2,
      score: null,
      missing: true,
      missingLabel:
        openHistoryComplete === false
          ? '首次建仓时间未知（成交历史不完整），不纳入评分'
          : '开仓时间未知，不纳入评分',
      detail:
        openHistoryComplete === false
          ? '无法从成交记录完整追溯首次建仓'
          : '开仓时间数据缺失',
    };
  }
  const losing = pnlPct != null && pnlPct < 0;
  let score = 35;
  let detail = `持仓约 ${holdingDays.toFixed(1)} 天`;
  if (holdingDays > 14 && losing) {
    score = 92;
    detail = `持仓 ${holdingDays.toFixed(0)} 天且浮亏，扛单风险高`;
  } else if (holdingDays > 7 && losing) {
    score = 78;
    detail = `持仓 ${holdingDays.toFixed(0)} 天且浮亏，风险抬升`;
  } else if (holdingDays < 3) {
    score = 22;
    detail = `持仓 ${holdingDays.toFixed(1)} 天，时效较新`;
  } else if (holdingDays > 14) {
    score = 55;
    detail = `持仓 ${holdingDays.toFixed(0)} 天，需关注是否僵持`;
  }
  return {
    key: 'hold',
    label: '持仓时间',
    weight: 0.2,
    score,
    missing: false,
    detail,
  };
}

function finalizeDimensions(raw: Array<Omit<DimensionScore, 'effectiveWeight'>>): DimensionScore[] {
  const activeWeight = raw.filter((d) => !d.missing).reduce((s, d) => s + d.weight, 0);
  return raw.map((d) => ({
    ...d,
    effectiveWeight: d.missing || activeWeight <= 0 ? 0 : d.weight / activeWeight,
  }));
}

function levelFromTradeScore(score: number): {
  level: TradeRiskLevel;
  label: string;
  advice: string;
} {
  if (score >= 80) {
    return { level: 'extreme', label: '极高风险', advice: '不建议跟单，风险收益比很差' };
  }
  if (score >= 60) {
    return { level: 'high', label: '高风险', advice: '不建议跟单，除非有独立逻辑' };
  }
  if (score >= 40) {
    return { level: 'medium', label: '中风险', advice: '仅可极小仓试错，不宜重仓跟单' };
  }
  return { level: 'low', label: '低风险', advice: '可谨慎小仓跟单，仍需自设止损' };
}

function detectBagholding(holdingDays: number | null, pnlPct: number | null): boolean {
  if (holdingDays == null || pnlPct == null) return false;
  // 首次建仓超 7 天且浮亏 >10%
  return holdingDays > 7 && pnlPct < -10;
}

function buildCrowd(
  coin: string,
  side: 'long' | 'short',
  whales: WhaleProfile[],
) {
  const key = normalizeCoin(coin);
  let longUsd = 0;
  let shortUsd = 0;
  for (const whale of whales) {
    if (whale.enabled === false) continue;
    for (const pos of whale.positions || []) {
      if (normalizeCoin(pos.coinLabel || pos.coin) !== key) continue;
      const usd = Math.abs(Number(pos.positionValue) || 0);
      if (!usd) continue;
      if (pos.side === 'long') longUsd += usd;
      else if (pos.side === 'short') shortUsd += usd;
    }
  }
  const total = longUsd + shortUsd;
  if (total <= 0) {
    return {
      crowdDirection: null as 'long' | 'short' | 'mixed' | null,
      crowdRatio: null as number | null,
      againstTrend: null as boolean | null,
    };
  }
  const longPct = (longUsd / total) * 100;
  const shortPct = 100 - longPct;
  const crowdDirection: 'long' | 'short' | 'mixed' =
    longPct >= 58 ? 'long' : shortPct >= 58 ? 'short' : 'mixed';
  const crowdRatio = side === 'long' ? longPct : shortPct;
  const againstTrend =
    crowdDirection === 'mixed' ? false : crowdDirection !== side;
  return { crowdDirection, crowdRatio, againstTrend };
}

export function whaleBookNotional(whale: WhaleProfile | null | undefined) {
  if (!whale) return 0;
  return (whale.positions || []).reduce(
    (sum, pos) => sum + Math.abs(Number(pos.positionValue) || 0),
    0,
  );
}

export function buildWhalePositionRisk(input: BuildRiskInput): WhalePositionRiskResult {
  const now = input.now || Date.now();
  const whale = input.whale;
  const rawWr = numOrNull(whale.winRate);
  const dd = numOrNull(whale.maxDrawdown);
  const trades = numOrNull(whale.closedTrades);
  const adjusted = getAdjustedWinRate(rawWr, input.closedTrades);

  const historical: WhalePositionRiskHistorical = {
    winRate: rawWr,
    maxDrawdown: dd,
    totalTrades: trades,
    monthlyPnL: input.monthlyPnL ?? null,
    avgHoldingDays: adjusted.avgHoldingDays ?? input.avgHoldingDays ?? null,
    maxHoldingDays: adjusted.maxHoldingDays ?? input.maxHoldingDays ?? null,
    adjustedWinRate: adjusted.adjustedWinRate,
    adjustedSource: adjusted.adjustedSource,
    adjustedNote: adjusted.adjustedNote,
  };

  const openHistoryComplete =
    input.openHistoryComplete == null ? null : Boolean(input.openHistoryComplete);
  const firstOpenMs =
    openHistoryComplete === false
      ? 0
      : Number(input.firstOpenTime) || Number(input.openTime) || 0;
  const lastAddMs = Number(input.lastAddTime) || firstOpenMs || 0;
  const holdingDays =
    openHistoryComplete === false
      ? null
      : firstOpenMs > 0
        ? Math.max(0, (now - firstOpenMs) / DAY_MS)
        : null;
  const spot = Number(input.spot) || 0;
  const entryPx = Number(input.entryPx) || 0;
  const pnlPct =
    spot > 0 && entryPx > 0 ? positionPnlPct(input.side, entryPx, spot) : null;
  const book = whaleBookNotional(whale);
  const notional = Math.abs(Number(input.notionalUsd) || 0);
  const positionRatio = book > 0 && notional > 0 ? clamp((notional / book) * 100, 0, 100) : null;
  const liqDist =
    spot > 0
      ? liquidationDistancePct(
          input.side,
          spot,
          input.liquidationPx == null ? null : Number(input.liquidationPx),
        )
      : null;
  const crowd = buildCrowd(input.coin, input.side, input.whales);
  const isPotentialBagholding = detectBagholding(holdingDays, pnlPct);

  const current: WhalePositionRiskCurrent = {
    unrealizedPnlPct: pnlPct,
    positionRatio,
    liquidationDistance: liqDist,
    direction: input.side,
    crowdDirection: crowd.crowdDirection,
    crowdRatio: crowd.crowdRatio,
    openTime: firstOpenMs > 0 ? new Date(firstOpenMs).toISOString() : null,
    openTimeMs: firstOpenMs > 0 ? firstOpenMs : null,
    firstOpenTimeMs: firstOpenMs > 0 ? firstOpenMs : null,
    lastAddTimeMs: lastAddMs > 0 ? lastAddMs : null,
    openHistoryComplete,
    leverage: numOrNull(input.leverage),
    holdingDays,
    isPotentialBagholding,
  };

  const credibility = resolveCredibilityTier(historical);

  const dims = finalizeDimensions([
    scorePnl(pnlPct),
    scorePositionRatio(positionRatio),
    scoreLiqDist(liqDist),
    scoreCrowd(crowd.crowdRatio, crowd.againstTrend),
    scoreHolding(holdingDays, pnlPct, openHistoryComplete),
  ]);

  const active = dims.filter((d) => !d.missing && d.score != null);
  const score =
    active.length === 0
      ? 50
      : Math.round(
          clamp(
            active.reduce((sum, d) => sum + (d.score || 0) * d.effectiveWeight, 0),
            0,
            100,
          ),
        );

  const meta = levelFromTradeScore(score);
  const warnings: string[] = [];
  if (pnlPct != null && pnlPct <= -10) {
    warnings.push(`⚠️ 浮亏超过 10%（${formatPct(pnlPct)}），仓位压力上升`);
  }
  if (positionRatio != null && positionRatio >= 35) {
    warnings.push(`⚠️ 仓位较重（占比约 ${positionRatio.toFixed(0)}%）`);
  }
  if (liqDist != null && liqDist < 40) {
    warnings.push(`⚠️ 爆仓距离偏近（约 ${liqDist.toFixed(1)}%）`);
  }
  if (crowd.againstTrend && crowd.crowdRatio != null) {
    warnings.push(`⚠️ 与市场主流方向相反（同向约 ${crowd.crowdRatio.toFixed(0)}%）`);
  }
  if (isPotentialBagholding) {
    warnings.push('⚠️ 持仓时间偏长且浮亏，存在扛单嫌疑');
  }
  for (const d of dims) {
    if (d.missing) warnings.push(`ℹ️ ${d.label}：${d.missingLabel || '数据缺失，不纳入评分'}`);
  }

  let summary = '综合浮盈、仓位占比、爆仓距离、拥挤度与持仓时间后给出当前交易风险。';
  if (isPotentialBagholding) {
    summary = '长持仓浮亏特征明显，更像扛单而非高效交易，跟单性价比偏差。';
  } else if (score >= 60) {
    summary = '当前交易风险偏高，不建议直接复制该仓位。';
  } else if (score < 40) {
    summary = '当前交易风险相对可控，仍需独立止损与仓位管理。';
  }

  const tradeRisk: TradeRiskCard = {
    score,
    level: meta.level,
    levelLabel: meta.label,
    advice: meta.advice,
    current,
    dimensions: dims,
    warnings,
    summary,
  };

  let followAdvice = meta.advice;
  if (credibility.tier === 'low' || tradeRisk.level === 'extreme') {
    followAdvice = '高风险，不建议跟单';
  } else if (credibility.tier === 'high' && tradeRisk.level === 'low') {
    followAdvice = '可信度较好且仓位风险偏低，可小仓位试单';
  } else if (tradeRisk.level === 'high' || tradeRisk.level === 'medium') {
    followAdvice = '风险偏高，不建议重仓跟单';
  } else if (credibility.tier === 'watch') {
    followAdvice = '巨鲸历史数据不足，即使仓位风险不高也仅可观望';
  }

  return {
    historical,
    current,
    credibility,
    tradeRisk,
    followAdvice,
  };
}

export function findMatchedPosition(
  whale: WhaleProfile,
  coin: string,
  side: 'long' | 'short',
): WhalePosition | null {
  const key = normalizeCoin(coin);
  return (
    (whale.positions || []).find(
      (pos) => normalizeCoin(pos.coinLabel || pos.coin) === key && pos.side === side,
    ) || null
  );
}

export function formatWhaleShort(whale: WhaleProfile) {
  return shortAddress(whale.address) || whale.name || whale.id;
}
