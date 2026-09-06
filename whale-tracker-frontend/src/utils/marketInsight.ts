import type { CoinMarket } from '@/types';
import { formatFunding, formatPct, formatPrice } from '@/utils/format';

export type InsightTone = 'bull' | 'bear' | 'neutral' | 'warn';

export interface InsightSection {
  key: 'sentiment' | 'cost' | 'levels';
  title: string;
  lines: string[];
}

export interface CoinKeyInsight {
  tone: InsightTone;
  summary: string;
  sections: InsightSection[];
}

function longPct(coin: CoinMarket) {
  const long = coin.longShort.longAccount;
  if (long > 0 && long <= 1) return long * 100;
  const ratio = coin.longShort.accountRatio;
  if (ratio > 0) return (ratio / (1 + ratio)) * 100;
  return 0;
}

function nearestLevels(coin: CoinMarket) {
  const supports = coin.levels.filter((item) => item.kind === 'support');
  const resists = coin.levels.filter((item) => item.kind === 'resist');
  return {
    support: supports[0] || null,
    resist: resists[0] || null,
  };
}

function dominantCostBucket(coin: CoinMarket) {
  const buckets = [...(coin.costDist.buckets || [])].sort((a, b) => b.volume - a.volume);
  return buckets[0] || null;
}

export function buildCoinKeyInsight(coin: CoinMarket): CoinKeyInsight {
  const belowPct = coin.costDist.belowPct || 0;
  const abovePct = coin.costDist.abovePct || 100 - belowPct;
  const accountLongPct = longPct(coin);
  const { support, resist } = nearestLevels(coin);
  const costPeak = dominantCostBucket(coin);
  const funding = coin.funding || 0;

  const sentimentLines: string[] = [
    `综合情绪 ${coin.heat.label}（${coin.heat.score}/100），倾向 ${coin.bias.label}。`,
    `资金费率 ${formatFunding(funding)}，${funding > 0.00005 ? '多头付费偏高，追多成本抬升' : funding < -0.00003 ? '空头付费，轧空弹性更大' : '费率中性，情绪未极端化'}。`,
    `多空人数比 ${coin.longShort.accountRatio ? coin.longShort.accountRatio.toFixed(2) : '--'}（多 ${accountLongPct.toFixed(1)}% / 空 ${(100 - accountLongPct).toFixed(1)}%）。`,
  ];
  if (coin.bias.reason) sentimentLines.push(coin.bias.reason);

  const costLines: string[] = [
    `近 90 日成交成本：现价下方 ${belowPct.toFixed(1)}% / 上方 ${abovePct.toFixed(1)}%。`,
  ];
  if (belowPct >= 58) {
    costLines.push('多数筹码成本低于现价，回调更容易获得承接，偏多结构更稳。');
  } else if (abovePct >= 58) {
    costLines.push('多数筹码成本高于现价，反弹上方套牢盘较重，上行需放量消化。');
  } else {
    costLines.push('成本分布较均衡，价格更容易在区间内反复震荡。');
  }
  if (costPeak) {
    costLines.push(
      `成交密集区约 $${formatPrice(costPeak.price)}，占比 ${(costPeak.share * 100).toFixed(1)}%，可视为短期成本中枢。`,
    );
  }

  const levelLines: string[] = [];
  if (resist) {
    levelLines.push(
      `最近阻力 ${resist.label} $${formatPrice(resist.price)}（${formatPct(resist.distancePct)}）。`,
    );
  }
  if (support) {
    levelLines.push(
      `最近支撑 ${support.label} $${formatPrice(support.price)}（${formatPct(support.distancePct)}）。`,
    );
  }
  if (resist && support) {
    const span = resist.price - support.price;
    const pos = span > 0 ? ((coin.price - support.price) / span) * 100 : 50;
    if (pos >= 72) {
      levelLines.push('现价贴近区间上沿，突破需放量，否则易在阻力区回落。');
    } else if (pos <= 28) {
      levelLines.push('现价贴近区间下沿，跌破支撑会放大止损盘，反弹需先站回密集成本区。');
    } else {
      levelLines.push('现价处于支撑与阻力之间，短线更看关键位得失而非单边趋势。');
    }
  } else {
    levelLines.push(`24h 区间 $${formatPrice(coin.low24h)} - $${formatPrice(coin.high24h)}。`);
  }

  let tone: InsightTone = 'neutral';
  if (coin.bias.direction === 'long' && coin.heat.score >= 55) tone = 'bull';
  else if (coin.bias.direction === 'short' || coin.heat.score <= 42) tone = 'bear';
  else if (coin.heat.score >= 68 || coin.heat.score <= 32) tone = 'warn';

  let summary = `情绪${coin.heat.label}、成本${belowPct >= 55 ? '偏厚支撑' : abovePct >= 55 ? '上方承压' : '均衡'}。`;
  if (support && resist) {
    summary += ` 关注 ${support.label} 与 ${resist.label} 之间的突破方向。`;
  }
  if (coin.openInterest.changePct && Math.abs(coin.openInterest.changePct) >= 3) {
    summary += ` 持仓量 24h ${formatPct(coin.openInterest.changePct)}，${coin.openInterest.changePct > 0 ? '新增杠杆需防快速洗仓' : '去杠杆后波动或收敛'}。`;
  }

  return {
    tone,
    summary,
    sections: [
      { key: 'sentiment', title: '情绪研判', lines: sentimentLines },
      { key: 'cost', title: '成本结构', lines: costLines },
      { key: 'levels', title: '关键价位', lines: levelLines },
    ],
  };
}
