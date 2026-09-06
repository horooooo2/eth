import type { PositionEntryFill, WhaleProfile } from '@/types';
import { formatLeverage, formatPct, formatPrice, formatUsd } from '@/utils/format';
import { chaseHint, positionPnlPct, type RecoQuotes } from '@/utils/recommend';
import { liquidationDistancePct } from '@/utils/positionAnalysis';

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_MS = 7 * DAY_MS;

export type CopyTradeRiskLevel = 'low' | 'medium' | 'high' | 'extreme';
export type WhaleTradeStyle = 'stable' | 'hf' | 'unknown';
export type RecentActionTone = 'adding' | 'reducing' | 'holding' | 'mixed' | 'unknown';

export interface CopyTradeRiskInput {
  whaleId: string;
  whaleName: string;
  coin: string;
  side: 'long' | 'short';
  leverage: number | null;
  entryPx: number;
  openTime: number | null;
  spot: number;
  notionalUsd: number;
  liquidationPx?: number | null;
  style?: WhaleTradeStyle | 'stable' | 'hf' | null;
  entryFills?: PositionEntryFill[];
  /** 该巨鲸全部持仓名义（用于仓位占比） */
  whaleBookUsd?: number;
}

export interface CopyTradeRiskResult {
  score: number;
  level: CopyTradeRiskLevel;
  levelLabel: string;
  advice: string;
  summary: string;
  ageDays: number | null;
  ageWeight: number;
  ageLabel: string;
  styleLabel: string;
  recentAction: RecentActionTone;
  recentActionLabel: string;
  positionSharePct: number | null;
  cohort: {
    longUsd: number;
    shortUsd: number;
    longPct: number;
    shortPct: number;
    sameSidePct: number;
    trendLabel: string;
    sameSideCount: number;
    oppositeSideCount: number;
    crowdRatio: string;
  };
  bullets: string[];
}

function normalizeCoin(coin: string) {
  return String(coin || '')
    .toUpperCase()
    .replace(/^K/, '');
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function levelFromScore(score: number): { level: CopyTradeRiskLevel; label: string; advice: string } {
  if (score <= 28) return { level: 'low', label: '低风险', advice: '可谨慎小仓跟单，仍需自设止损' };
  if (score <= 48) return { level: 'medium', label: '中等风险', advice: '适合观望或轻仓试错，不宜重仓跟单' };
  if (score <= 68) return { level: 'high', label: '高风险', advice: '不建议直接跟单，除非有独立逻辑' };
  return { level: 'extreme', label: '极高风险', advice: '跟单性价比很差，建议放弃跟单' };
}

function resolveSpot(coin: string, spot: number, quotes: RecoQuotes) {
  if (spot > 0) return spot;
  const key = normalizeCoin(coin);
  const direct = Number(quotes[key]) || Number(quotes[coin]) || 0;
  return direct > 0 ? direct : 0;
}

function resolveStyle(raw: CopyTradeRiskInput['style']): WhaleTradeStyle {
  if (raw === 'stable' || raw === 'hf') return raw;
  return 'unknown';
}

function styleLabel(style: WhaleTradeStyle) {
  if (style === 'stable') return '偏长线/稳健';
  if (style === 'hf') return '偏短线/高频';
  return '风格未知';
}

/**
 * 持仓时长按交易风格解读，不再一刀切“越久越过期”。
 * - 稳健：长持更像趋势确认，仅极轻提示
 * - 高频：长持且无近期动作才算信号衰减
 */
function holdContext(
  openTime: number | null | undefined,
  style: WhaleTradeStyle,
  now = Date.now(),
) {
  const ts = Number(openTime) || 0;
  if (!ts) {
    return {
      days: null as number | null,
      weight: 0.85,
      scoreDelta: 3,
      label: '开仓时间未知，时长仅作弱参考',
    };
  }
  const days = Math.max(0, now - ts) / DAY_MS;
  if (style === 'stable') {
    if (days <= 14) {
      return { days, weight: 1, scoreDelta: 0, label: `持仓约 ${days.toFixed(1)} 天，稳健风格下属正常持有` };
    }
    if (days <= 60) {
      return {
        days,
        weight: 1,
        scoreDelta: -2,
        label: `持仓约 ${days.toFixed(0)} 天：稳健/趋势风格下更像方向确认，而非信号过期`,
      };
    }
    return {
      days,
      weight: 0.95,
      scoreDelta: -1,
      label: `持仓约 ${days.toFixed(0)} 天：长线持有，需结合近期加减仓判断是否仍有效`,
    };
  }
  if (style === 'hf') {
    if (days <= 3) return { days, weight: 1, scoreDelta: 0, label: `持仓约 ${days.toFixed(1)} 天，短线时效尚可` };
    if (days <= 7) {
      return { days, weight: 0.85, scoreDelta: 4, label: `持仓约 ${days.toFixed(1)} 天，短线仓位已偏旧` };
    }
    if (days <= 30) {
      return {
        days,
        weight: 0.55,
        scoreDelta: 10,
        label: `持仓约 ${days.toFixed(0)} 天：短线风格下参考价值下降，需看近期是否仍在操作`,
      };
    }
    return {
      days,
      weight: 0.35,
      scoreDelta: 14,
      label: `持仓约 ${days.toFixed(0)} 天：短线风格下信号衰减明显，除非近期仍有加仓`,
    };
  }
  // unknown：轻量提示，不做重罚
  if (days <= 14) return { days, weight: 1, scoreDelta: 0, label: `持仓约 ${days.toFixed(1)} 天` };
  if (days <= 45) {
    return {
      days,
      weight: 0.9,
      scoreDelta: 3,
      label: `持仓约 ${days.toFixed(0)} 天：风格未知，时长仅作弱参考，重点看近期行为`,
    };
  }
  return {
    days,
    weight: 0.85,
    scoreDelta: 5,
    label: `持仓约 ${days.toFixed(0)} 天：不宜因“旧仓”直接否定，需看加减仓与仓位占比`,
  };
}

function inferFillKind(fill: PositionEntryFill, index: number): PositionEntryFill['kind'] {
  if (fill.kind === 'open' || fill.kind === 'add' || fill.kind === 'reduce') return fill.kind;
  if (index === 0) return 'open';
  if (Number(fill.closedPnl) && Math.abs(Number(fill.closedPnl)) > 0) return 'reduce';
  return 'add';
}

function analyzeRecentAction(
  fills: PositionEntryFill[] | undefined,
  now = Date.now(),
): {
  tone: RecentActionTone;
  label: string;
  addUsd: number;
  reduceUsd: number;
  scoreDelta: number;
} {
  const list = Array.isArray(fills) ? fills : [];
  if (!list.length) {
    return {
      tone: 'unknown',
      label: '近期操作未知（缺少入场成交明细），无法判断浮盈后是加仓还是减仓',
      addUsd: 0,
      reduceUsd: 0,
      scoreDelta: 6,
    };
  }

  const since = now - RECENT_MS;
  let addUsd = 0;
  let reduceUsd = 0;
  let recentCount = 0;
  list.forEach((fill, index) => {
    const t = Number(fill.time) || 0;
    if (!t || t < since) return;
    const kind = inferFillKind(fill, index);
    if (kind === 'open') return;
    const usd = Math.abs(Number(fill.usd) || 0);
    if (!usd) return;
    recentCount += 1;
    if (kind === 'reduce') reduceUsd += usd;
    else addUsd += usd;
  });

  if (!recentCount) {
    return {
      tone: 'holding',
      label: '近 7 天无明显加减仓，属于继续持有；信号是否有效取决于其风格与历史止盈习惯',
      addUsd: 0,
      reduceUsd: 0,
      scoreDelta: 2,
    };
  }

  const net = addUsd - reduceUsd;
  const total = addUsd + reduceUsd;
  if (total > 0 && Math.abs(net) / total < 0.2) {
    return {
      tone: 'mixed',
      label: `近 7 天有加有减（加 ${formatUsd(addUsd)} / 减 ${formatUsd(reduceUsd)}），方向意图不清晰`,
      addUsd,
      reduceUsd,
      scoreDelta: 7,
    };
  }
  if (reduceUsd > addUsd * 1.15) {
    return {
      tone: 'reducing',
      label: `近 7 天以减仓为主（减 ${formatUsd(reduceUsd)} > 加 ${formatUsd(addUsd)}），浮盈后更像逐步止盈，方向信号转弱`,
      addUsd,
      reduceUsd,
      scoreDelta: 16,
    };
  }
  if (addUsd > reduceUsd * 1.15) {
    return {
      tone: 'adding',
      label: `近 7 天以加仓为主（加 ${formatUsd(addUsd)} > 减 ${formatUsd(reduceUsd)}），浮盈后仍加仓，信心偏强`,
      addUsd,
      reduceUsd,
      scoreDelta: -10,
    };
  }
  return {
    tone: 'holding',
    label: '近 7 天操作有限，整体仍偏持有',
    addUsd,
    reduceUsd,
    scoreDelta: 2,
  };
}

function positionShare(
  notionalUsd: number,
  whaleBookUsd: number | undefined,
): { pct: number | null; label: string; scoreDelta: number } {
  const book = Math.max(0, Number(whaleBookUsd) || 0);
  const usd = Math.max(0, Number(notionalUsd) || 0);
  if (!book || !usd) {
    return { pct: null, label: '仓位占比未知', scoreDelta: 2 };
  }
  const pct = clamp((usd / book) * 100, 0, 100);
  if (pct >= 45) {
    return {
      pct,
      label: `约占该巨鲸总仓位 ${pct.toFixed(0)}%，属于核心仓，方向表达较强`,
      scoreDelta: -5,
    };
  }
  if (pct >= 20) {
    return {
      pct,
      label: `约占该巨鲸总仓位 ${pct.toFixed(0)}%，仓位权重中等`,
      scoreDelta: 0,
    };
  }
  if (pct >= 8) {
    return {
      pct,
      label: `约占该巨鲸总仓位 ${pct.toFixed(0)}%，偏卫星仓，跟单时勿当成主叙事`,
      scoreDelta: 4,
    };
  }
  return {
    pct,
    label: `约占该巨鲸总仓位 ${pct.toFixed(1)}%，权重很低，跟单参考意义有限`,
    scoreDelta: 8,
  };
}

function crowdMeta(sameSideCount: number, oppositeSideCount: number, sameSidePct: number) {
  const opp = Math.max(1, oppositeSideCount);
  const ratio = sameSideCount / opp;
  const crowdRatio =
    oppositeSideCount === 0
      ? `${sameSideCount}:0`
      : `${sameSideCount}:${oppositeSideCount}`;
  // 适中同向略有支撑；极端拥挤提高踩踏风险
  let scoreDelta = 0;
  let note = '';
  if (sameSidePct >= 88 || ratio >= 10) {
    scoreDelta = 12;
    note = `同向极度拥挤（${crowdRatio}，同向约 ${sameSidePct}%），反向波动时踩踏风险高`;
  } else if (sameSidePct >= 75 || ratio >= 5) {
    scoreDelta = 7;
    note = `同向拥挤偏高（${crowdRatio}，同向约 ${sameSidePct}%），一致性过强时需防踩踏`;
  } else if (sameSidePct >= 58) {
    scoreDelta = -4;
    note = `同向有支撑（${crowdRatio}，同向约 ${sameSidePct}%），拥挤度尚可`;
  } else if (sameSidePct >= 45) {
    scoreDelta = 4;
    note = `多空分歧（${crowdRatio}，同向约 ${sameSidePct}%）`;
  } else {
    scoreDelta = 14;
    note = `该巨鲸偏逆势（${crowdRatio}，同向仅约 ${sameSidePct}%）`;
  }
  return { crowdRatio, scoreDelta, note };
}

export function analyzeCopyTradeRisk(
  input: CopyTradeRiskInput,
  whales: WhaleProfile[],
  quotes: RecoQuotes = {},
  now = Date.now(),
): CopyTradeRiskResult {
  const coin = normalizeCoin(input.coin);
  const spot = resolveSpot(input.coin, input.spot, quotes);
  const style = resolveStyle(input.style);
  const hold = holdContext(input.openTime, style, now);
  const recent = analyzeRecentAction(input.entryFills, now);
  const share = positionShare(input.notionalUsd, input.whaleBookUsd);
  const leverage = Math.max(0, Number(input.leverage) || 0);

  // 群体多空：用当前名义，不做“越旧越作废”的强折扣（避免把趋势仓抹掉）
  let longUsd = 0;
  let shortUsd = 0;
  let sameSideCount = 0;
  let oppositeSideCount = 0;
  for (const whale of whales) {
    if (whale.enabled === false) continue;
    for (const pos of whale.positions || []) {
      if (normalizeCoin(pos.coin) !== coin) continue;
      const usd = Number(pos.positionValue) || 0;
      if (!usd) continue;
      if (pos.side === 'long') longUsd += usd;
      else if (pos.side === 'short') shortUsd += usd;
      if (pos.side === input.side) sameSideCount += 1;
      else oppositeSideCount += 1;
    }
  }

  const totalUsd = longUsd + shortUsd;
  const longPct = totalUsd ? Math.round((longUsd / totalUsd) * 100) : 50;
  const shortPct = totalUsd ? 100 - longPct : 50;
  const sameSideUsd = input.side === 'long' ? longUsd : shortUsd;
  const sameSidePct = totalUsd ? Math.round((sameSideUsd / totalUsd) * 100) : 50;
  const trendSide: 'long' | 'short' | 'mixed' =
    totalUsd <= 0 ? 'mixed' : longPct >= 58 ? 'long' : shortPct >= 58 ? 'short' : 'mixed';
  const trendLabel =
    trendSide === 'long' ? '偏多' : trendSide === 'short' ? '偏空' : '震荡分歧';
  const crowd = crowdMeta(sameSideCount, oppositeSideCount, sameSidePct);

  const pnlPct = spot > 0 && input.entryPx > 0 ? positionPnlPct(input.side, input.entryPx, spot) : null;
  const chaseText =
    spot > 0 && input.entryPx > 0
      ? chaseHint(input.side, ((spot - input.entryPx) / input.entryPx) * 100)
      : '暂无现价，追价风险未知';
  const liqDist =
    spot > 0
      ? liquidationDistancePct(
          input.side,
          spot,
          input.liquidationPx == null ? null : Number(input.liquidationPx),
        )
      : null;

  let score = 34;

  // 1) 群体走势：适中同向略减风险；极端拥挤反而加风险
  score += crowd.scoreDelta;
  if (trendSide === 'mixed') score += 5;
  else if (trendSide !== input.side) score += 14;
  else score -= 4;

  // 2) 持仓时长 × 风格（弱权重）
  score += hold.scoreDelta;
  // 短线仓位若仍在加仓，抵消部分时长惩罚
  if (style === 'hf' && recent.tone === 'adding' && hold.days != null && hold.days > 7) {
    score -= 8;
  }
  // 长线仓位若浮盈后减仓，时长“确认”失效
  if (style === 'stable' && recent.tone === 'reducing') {
    score += 8;
  }

  // 3) 近期行为（核心）
  score += recent.scoreDelta;
  if (pnlPct != null && pnlPct >= 4 && recent.tone === 'reducing') score += 6;
  if (pnlPct != null && pnlPct >= 4 && recent.tone === 'adding') score -= 4;
  if (pnlPct != null && pnlPct >= 4 && recent.tone === 'holding') score += 2;

  // 4) 仓位占比
  score += share.scoreDelta;

  // 5) 盈亏比 / 追价
  if (pnlPct != null) {
    if (pnlPct >= 12) score += 16;
    else if (pnlPct >= 8) score += 12;
    else if (pnlPct >= 4) score += 7;
    else if (pnlPct >= 1.5) score += 3;
    else if (pnlPct <= -6) score -= 3;
  } else {
    score += 3;
  }

  // 6) 杠杆
  if (leverage >= 40) score += 14;
  else if (leverage >= 25) score += 9;
  else if (leverage >= 15) score += 5;
  else if (leverage >= 8) score += 2;
  else if (leverage > 0 && leverage <= 5) score -= 2;

  // 7) 爆仓距离
  if (liqDist != null) {
    if (liqDist < 3) score += 14;
    else if (liqDist < 6) score += 8;
    else if (liqDist < 10) score += 4;
    else if (liqDist > 25) score -= 3;
  }

  score = Math.round(clamp(score, 0, 100));
  const meta = levelFromScore(score);
  const sideText = input.side === 'long' ? '做多' : '做空';

  const bullets = [
    `目标仓位：${sideText} · ${formatLeverage(leverage || null)} · 开仓 ${formatPrice(input.entryPx) || '--'} · 现价 ${formatPrice(spot) || '--'}`,
    `交易风格：${styleLabel(style)}；${hold.label}`,
    `近期行为：${recent.label}`,
    `仓位占比：${share.label}`,
    `群体结构：多 ${longPct}% / 空 ${shortPct}%（${formatUsd(longUsd)} / ${formatUsd(shortUsd)}）；${crowd.note}`,
    `整体走势：${trendLabel}；地址同向 ${sameSideCount} / 反向 ${oppositeSideCount}`,
    pnlPct == null ? '盈亏比：暂无现价' : `相对开仓浮盈约 ${formatPct(pnlPct)} · ${chaseText}`,
    liqDist == null
      ? '爆仓距离：暂无'
      : `距爆仓约 ${liqDist.toFixed(1)}%${liqDist < 8 ? '（空间偏紧）' : ''}`,
    `风险分 ${score}/100（重点：近期行为 > 盈亏比/拥挤度 > 风格化持仓时长）`,
  ];

  let summary = '';
  if (recent.tone === 'reducing' && (pnlPct == null || pnlPct > 0)) {
    summary =
      '该巨鲸在浮盈区更偏减仓/止盈，当前“仍偏多/偏空”的静态持仓信号参考价值下降，不宜再追单复制。';
  } else if (recent.tone === 'adding' && trendSide === input.side) {
    summary =
      pnlPct != null && pnlPct >= 8
        ? '近期仍在加仓，方向信念较强，但现价已明显偏离开仓区，跟单需接受较差盈亏比与拥挤踩踏风险。'
        : '近期仍在加仓且与群体走势同向，跟单条件相对更好，仍需控制杠杆与仓位。';
  } else if (recent.tone === 'holding' && style === 'stable' && hold.days != null && hold.days > 30) {
    summary =
      '长线风格下长期持有并不等于过期；关键是确认其未在高位减仓。若继续持有且仓位占比不低，更像趋势仓，但仍要评估追价成本。';
  } else if (crowd.scoreDelta >= 10 && pnlPct != null && pnlPct >= 4) {
    summary = '同向拥挤过高且已有明显浮盈，追单性价比与踩踏风险都不利，建议观望或等待回撤。';
  } else if (trendSide !== input.side && trendSide !== 'mixed') {
    summary = '该巨鲸方向与当前群体走势相反，跟单属于逆势复制，风险显著抬升。';
  } else {
    summary =
      '综合近期加减仓、仓位占比、拥挤度、盈亏比与风格化持仓时长后给出评级；时长不再单独决定“是否过期”。';
  }

  return {
    score,
    level: meta.level,
    levelLabel: meta.label,
    advice: meta.advice,
    summary,
    ageDays: hold.days,
    ageWeight: hold.weight,
    ageLabel: hold.label,
    styleLabel: styleLabel(style),
    recentAction: recent.tone,
    recentActionLabel: recent.label,
    positionSharePct: share.pct,
    cohort: {
      longUsd,
      shortUsd,
      longPct,
      shortPct,
      sameSidePct,
      trendLabel,
      sameSideCount,
      oppositeSideCount,
      crowdRatio: crowd.crowdRatio,
    },
    bullets,
  };
}

export function whaleBookNotionalUsd(whale: WhaleProfile | null | undefined) {
  if (!whale) return 0;
  return (whale.positions || []).reduce((sum, pos) => sum + Math.abs(Number(pos.positionValue) || 0), 0);
}
