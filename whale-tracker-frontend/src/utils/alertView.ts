import type { WhaleProfile } from '@/types';
import {
  alertEventTime,
  alertLayerOf,
  resolveAlertPos,
  type AlertLayer,
  type AlertPosView,
  type WhaleAlert,
  type WhaleAlertItem,
  type WhaleAlertKind,
} from '@/utils/whaleAlerts';

export type AlertActionType = 'open' | 'close' | 'adjust' | 'other';
export type AlertTimeBucket = 'fresh' | 'mid' | 'stale';

const MIN_USD_KEY = 'whale-tracker-alert-min-usd';

export const ALERT_MIN_USD_OPTIONS = [
  { label: '全部金额', value: 0 },
  { label: '≥ $1万', value: 10_000 },
  { label: '≥ $5万', value: 50_000 },
  { label: '≥ $10万', value: 100_000 },
] as const;

export function readAlertMinUsd() {
  const saved = Number(localStorage.getItem(MIN_USD_KEY));
  if (saved === 0 || saved === 10_000 || saved === 50_000 || saved === 100_000) return saved;
  return 0;
}

export function writeAlertMinUsd(value: number) {
  localStorage.setItem(MIN_USD_KEY, String(value));
}

export function alertActionLabel(kind: WhaleAlertKind, item?: WhaleAlertItem) {
  switch (kind) {
    case 'close':
      return '平仓';
    case 'open':
      return '开仓';
    case 'increase':
      return '加仓';
    case 'decrease':
      return '减仓';
    case 'flip':
      return '反向';
    case 'fill': {
      const title = item?.title || '';
      if (title.startsWith('卖')) return '卖出';
      if (title.startsWith('买')) return '买入';
      return '成交';
    }
    case 'transfer':
      return item?.title || '链上预警';
    default:
      return '异动';
  }
}

export function alertActionType(kind: WhaleAlertKind): AlertActionType {
  if (kind === 'close' || kind === 'decrease') return 'close';
  if (kind === 'open' || kind === 'increase') return 'open';
  if (kind === 'flip') return 'adjust';
  // fill / transfer 不做开平推断
  return 'other';
}

export function formatRelativeTime(ts: number, now = Date.now()) {
  if (!ts) return '--';
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min}分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 6) return `${hr}小时前`;
  if (hr < 24) return '今天';
  const day = Math.floor(hr / 24);
  if (day === 1) return '昨天';
  if (day < 7) return `${day}天前`;
  return `${Math.floor(day / 7)}周前`;
}

export function alertTimeBucket(ts: number, now = Date.now()): AlertTimeBucket {
  if (!ts) return 'stale';
  const hr = (now - ts) / 3_600_000;
  if (hr <= 1) return 'fresh';
  if (hr <= 6) return 'mid';
  return 'stale';
}

export function amountTierClass(usd: number | null | undefined) {
  const n = Number(usd) || 0;
  if (n >= 100_000) return 'amount-xl';
  if (n >= 50_000) return 'amount-lg';
  return '';
}

export interface AlertCardView extends AlertPosView {
  actionLabel: string;
  actionType: AlertActionType;
  kind: WhaleAlertKind;
  layer: AlertLayer;
  notionalUsd: number | null;
  marginUsd: number | null;
  relativeTime: string;
  timeBucket: AlertTimeBucket;
  amountClass: string;
  showLeverage: boolean;
  showMargin: boolean;
  eventTime: number;
  verifyText?: string;
  /** 仓位层展示多空；成交层展示买卖 */
  sideBadgeLabel: string | null;
}

export function enrichAlertView(
  alert: WhaleAlert,
  whale?: WhaleProfile | null,
  now = Date.now(),
): AlertCardView {
  const item = alert.items?.[0];
  const kind = item?.kind || alert.kind;
  const layer = alertLayerOf(alert);
  const base = resolveAlertPos(alert, whale);
  const notionalUsd = base.usd;
  const leverage = base.leverage && base.leverage > 0 ? base.leverage : null;
  const marginUsd = leverage && notionalUsd ? notionalUsd / leverage : null;
  const eventTime = alertEventTime(alert);
  const actionLabel = alertActionLabel(kind, item);

  let sideBadgeLabel: string | null = null;
  if (layer === 'fill') {
    sideBadgeLabel = actionLabel === '卖出' ? '卖出' : actionLabel === '买入' ? '买入' : null;
  } else if (layer === 'transfer') {
    sideBadgeLabel = actionLabel.includes('转入') ? '转入' : actionLabel.includes('转出') ? '转出' : null;
  } else if (base.side === 'long') {
    sideBadgeLabel = '做多';
  } else if (base.side === 'short') {
    sideBadgeLabel = '做空';
  }

  return {
    ...base,
    leverage,
    marginUsed: marginUsd,
    kind,
    layer,
    actionLabel,
    actionType: alertActionType(kind),
    notionalUsd,
    marginUsd,
    relativeTime: formatRelativeTime(eventTime, now),
    timeBucket: alertTimeBucket(eventTime, now),
    amountClass: amountTierClass(notionalUsd),
    showLeverage: layer === 'position' && Boolean(leverage),
    showMargin: layer === 'position' && Boolean(marginUsd),
    eventTime,
    verifyText: item?.verifyText,
    sideBadgeLabel,
  };
}
