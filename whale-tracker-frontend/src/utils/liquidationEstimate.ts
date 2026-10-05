// Legacy approximation for resonance display only; not an exchange liquidation quote.
const MAINTENANCE_MARGIN_RATE = 0.004;
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

