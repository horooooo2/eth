import type { WhaleProfile, WhaleTrade } from '@/types';
import { positionPnlPct, type RecoQuotes } from '@/utils/recommend';
import { tradeFillSide } from '@/utils/whaleAlerts';

export type TimeBucket = 'fresh' | 'mid' | 'old' | 'stale';

export interface EnrichedTrade {
  trade: WhaleTrade;
  side: 'long' | 'short';
  entryPx: number | null;
  markPx: number | null;
  openTime: number;
  timeBucket: TimeBucket;
  pnlPct: number | null;
  isClosing: boolean;
}

function coinKey(value: string) {
  return String(value || '').toUpperCase();
}

export function findWhalePosition(whale: WhaleProfile | undefined, asset: string) {
  if (!whale) return null;
  const key = coinKey(asset);
  return (
    whale.positions.find(
      (pos) =>
        coinKey(pos.coin) === key || coinKey(pos.coinLabel || '') === key,
    ) || null
  );
}

export function isClosingTrade(trade: WhaleTrade) {
  return Math.abs(Number(trade.closedPnl) || 0) > 1;
}

export function tradeOpenTime(trade: WhaleTrade, whale?: WhaleProfile) {
  const pos = findWhalePosition(whale, trade.asset);
  if (pos?.openTime && Number(pos.openTime) > 0 && !isClosingTrade(trade)) {
    return Number(pos.openTime);
  }
  return trade.time;
}

export function tradeEntryPrice(trade: WhaleTrade, whale?: WhaleProfile) {
  const pos = findWhalePosition(whale, trade.asset);
  if (!isClosingTrade(trade) && pos?.entryPx) return Number(pos.entryPx);
  return Number(trade.price) || (pos?.entryPx ? Number(pos.entryPx) : null) || null;
}

export function tradeMarkPrice(
  trade: WhaleTrade,
  whale: WhaleProfile | undefined,
  quotes: RecoQuotes,
  markCache?: Record<string, number>,
) {
  const pos = findWhalePosition(whale, trade.asset);
  if (pos?.entryPx && pos.size) {
    const abs = Math.abs(pos.size);
    if (abs > 0) {
      const mark =
        pos.side === 'long'
          ? pos.entryPx + pos.unrealizedPnl / abs
          : pos.entryPx - pos.unrealizedPnl / abs;
      if (mark > 0) return mark;
    }
  }
  const key = coinKey(trade.asset);
  if (key === 'BTC' && quotes.BTC) return quotes.BTC;
  if (key === 'ETH' && quotes.ETH) return quotes.ETH;
  if (markCache?.[key]) return markCache[key];
  return Number(trade.price) || null;
}

export function openTimeBucket(ts: number, now = Date.now()): TimeBucket {
  const age = now - ts;
  if (age <= 24 * 60 * 60 * 1000) return 'fresh';
  if (age <= 3 * 24 * 60 * 60 * 1000) return 'mid';
  if (age <= 7 * 24 * 60 * 60 * 1000) return 'old';
  return 'stale';
}

export function timeBucketLabel(bucket: TimeBucket) {
  if (bucket === 'fresh') return '24h内';
  if (bucket === 'mid') return '3天内';
  if (bucket === 'old') return '7天内';
  return '7天+';
}

export function enrichTrade(
  trade: WhaleTrade,
  whale: WhaleProfile | undefined,
  quotes: RecoQuotes,
  markCache?: Record<string, number>,
): EnrichedTrade {
  const side = tradeFillSide(trade);
  const closing = isClosingTrade(trade);
  const entryPx = tradeEntryPrice(trade, whale);
  const markPx = tradeMarkPrice(trade, whale, quotes, markCache);
  const openTime = tradeOpenTime(trade, whale);
  const pnlPct =
    entryPx && markPx && !closing ? positionPnlPct(side, entryPx, markPx) : null;
  return {
    trade,
    side,
    entryPx,
    markPx,
    openTime,
    timeBucket: openTimeBucket(openTime),
    pnlPct,
    isClosing: closing,
  };
}
