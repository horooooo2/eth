/** 8h 资金费率 → 年化（每天 3 次结算） */
export function fundingAnnualizedPct(funding8h: number | null | undefined) {
  const rate = Number(funding8h);
  if (!Number.isFinite(rate)) return null;
  return rate * 3 * 365 * 100;
}

/** 年化 50% ≈ 8h 费率 0.0000457 */
export const HIGH_FUNDING_ANNUAL_PCT = 50;

export function isHighFunding(funding8h: number | null | undefined, threshold = HIGH_FUNDING_ANNUAL_PCT) {
  const annual = fundingAnnualizedPct(funding8h);
  if (annual == null) return false;
  return Math.abs(annual) >= threshold;
}

/**
 * 跟单费率风险：
 * - 做多 + 正费率过高 → 多头付费，谨慎跟多
 * - 做空 + 负费率过低（绝对值大）→ 空头付费，谨慎跟空
 */
export function fundingFollowWarning(
  side: 'long' | 'short' | null | undefined,
  funding8h: number | null | undefined,
) {
  if (!side) return null;
  const annual = fundingAnnualizedPct(funding8h);
  if (annual == null || Math.abs(annual) < HIGH_FUNDING_ANNUAL_PCT) return null;
  if (side === 'long' && annual > 0) {
    return {
      level: 'warn' as const,
      annualPct: annual,
      shortLabel: '高费率',
      text: `资金费率年化 ${annual.toFixed(1)}%，跟多需谨慎`,
    };
  }
  if (side === 'short' && annual < 0) {
    return {
      level: 'warn' as const,
      annualPct: annual,
      shortLabel: '高费率',
      text: `资金费率年化 ${annual.toFixed(1)}%，跟空需谨慎`,
    };
  }
  return null;
}

export function normalizeFundingCoin(coin: string | undefined | null) {
  return String(coin || '')
    .trim()
    .toUpperCase()
    .replace(/^K/, '')
    .replace(/[-_/]/g, '')
    .replace(/USDT$|USD$|PERP$/, '');
}

export function fundingOf(
  rates: Record<string, number> | null | undefined,
  coin: string | undefined | null,
) {
  if (!rates) return null;
  const key = normalizeFundingCoin(coin);
  if (!key) return null;
  if (Number.isFinite(rates[key])) return rates[key];
  const hit = Object.entries(rates).find(([id]) => normalizeFundingCoin(id) === key);
  return hit ? hit[1] : null;
}
