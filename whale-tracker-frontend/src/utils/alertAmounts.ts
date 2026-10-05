import type { WhaleAlertItem } from '@/utils/whaleAlerts';

/** Item amounts are atomic. Always sum the visible items after coin/side filtering. */
export function sumAlertItemNotional(items: WhaleAlertItem[]): number | null {
  const values = items.map(item => item.usd == null ? NaN : Number(item.usd)).filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + Math.abs(value), 0) : null;
}

export function sumAlertItemMargin(items: WhaleAlertItem[]): number | null {
  let total = 0;
  for (const item of items) {
    if (item.marginUsed != null && Number.isFinite(Number(item.marginUsed))) total += Math.abs(Number(item.marginUsed));
    else if (Number(item.leverage) > 0 && item.usd != null) total += Math.abs(Number(item.usd)) / Number(item.leverage);
    else return null;
  }
  return items.length ? total : null;
}
