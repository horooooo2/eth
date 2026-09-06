/** ≥ 1 亿用「亿」；≥ 1 万用「万」；不足一万保持常规展示 */
const WAN = 10_000;
const YI = 100_000_000;

function formatWanNumber(abs: number) {
  const wan = abs / WAN;
  if (wan >= 100) return wan.toFixed(0);
  if (wan >= 10) return trimTrailingZeros(wan.toFixed(1));
  return trimTrailingZeros(wan.toFixed(2));
}

/** 如 44813 万 → 4.48 亿 */
function formatYiNumber(abs: number) {
  const yi = abs / YI;
  if (yi >= 100) return yi.toFixed(0);
  if (yi >= 10) return trimTrailingZeros(yi.toFixed(1));
  return trimTrailingZeros(yi.toFixed(2));
}

export function formatUsd(value: number | null | undefined) {
  if (value == null || Number.isNaN(Number(value))) return '--';
  const n = Number(value);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= YI) {
    return `${sign}$${formatYiNumber(abs)}亿`;
  }
  if (abs >= WAN) {
    return `${sign}$${formatWanNumber(abs)}万`;
  }
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatSignedUsd(value: number | null | undefined) {
  if (value == null || Number.isNaN(Number(value))) return '--';
  const n = Number(value);
  const sign = n > 0 ? '+' : '';
  return `${sign}${formatUsd(n)}`;
}

export function formatTime(ts: number) {
  if (!ts) return '--';
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatTimeShort(ts: number) {
  if (!ts) return '--';
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const OPEN_TIME_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** 开仓时间早于当前一周以上 */
export function isOpenTimeStale(ts: number | null | undefined, now = Date.now()) {
  const time = Number(ts) || 0;
  return time > 0 && now - time > OPEN_TIME_STALE_MS;
}

export function shortAddress(value: string) {
  if (!value) return '--';
  if (value.startsWith('0x') && value.length > 12) {
    return `${value.slice(0, 6)}...${value.slice(-4)}`;
  }
  return value;
}

/** 展示用巨鲸名称，去掉配置里的「高频」前缀 */
export function displayWhaleName(name: string | null | undefined) {
  return String(name || '').replace(/^高频/, '');
}

export function formatLeverage(value: number | null | undefined) {
  if (value == null || Number.isNaN(Number(value)) || Number(value) <= 0) return '--';
  return `${Number(value)}x`;
}

function trimTrailingZeros(value: string) {
  if (!value.includes('.')) return value;
  return value.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
}

/** 按价格档位决定展示小数位：大额 2 位、中低价 4 位、极低价按交易所有效数字规则 */
export function priceDecimalPlaces(value: number | null | undefined) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return 2;
  const abs = Math.abs(n);
  if (abs >= 100) return 2;
  if (abs >= 0.01) return 4;
  return null;
}

function formatMicroPrice(value: number) {
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  let raw = abs.toPrecision(5);
  if (/e/i.test(raw)) {
    const log = Math.floor(Math.log10(abs));
    const decimals = Math.min(Math.max(4 - log, 0), 12);
    raw = abs.toFixed(decimals);
  }
  const trimmed = trimTrailingZeros(raw);
  return value < 0 ? `-${trimmed}` : trimmed;
}

function formatPriceNumber(value: number) {
  const decimals = priceDecimalPlaces(value);
  if (decimals != null) {
    return value.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }
  return formatMicroPrice(value);
}

export function formatPrice(value: number | null | undefined, _coin?: string) {
  if (value == null || Number.isNaN(Number(value))) return '--';
  return formatPriceNumber(Number(value));
}

/** 开仓价与现价差值（多：现价-开仓；空：开仓-现价） */
export function formatPriceGap(
  entry: number | null | undefined,
  mark: number | null | undefined,
  side: 'long' | 'short' | string,
) {
  const entryPx = Number(entry);
  const markPx = Number(mark);
  if (!Number.isFinite(entryPx) || !Number.isFinite(markPx)) return '';
  const gap = side === 'short' ? entryPx - markPx : markPx - entryPx;
  const sign = gap > 0 ? '+' : gap < 0 ? '-' : '';
  const absGap = Math.abs(gap);
  const decimals = priceDecimalPlaces(absGap) ?? priceDecimalPlaces(markPx) ?? priceDecimalPlaces(entryPx);
  if (decimals != null) {
    return `(${sign}${absGap.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })})`;
  }
  return `(${sign}${formatMicroPrice(absGap)})`;
}

export function formatFunding(value: number | null | undefined) {
  if (value == null || Number.isNaN(Number(value))) return '--';
  const pct = Number(value) * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(4)}%`;
}

export function formatPct(value: number | null | undefined, digits = 2) {
  if (value == null || Number.isNaN(Number(value))) return '--';
  const n = Number(value);
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
}

export function formatCompact(value: number | null | undefined) {
  if (value == null || Number.isNaN(Number(value))) return '--';
  const n = Number(value);
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= YI) return `${sign}${formatYiNumber(abs)}亿`;
  if (abs >= WAN) return `${sign}${formatWanNumber(abs)}万`;
  return `${sign}${Math.round(abs).toLocaleString('en-US')}`;
}

export function formatPnl(value: number | null | undefined) {
  if (value == null || Number.isNaN(Number(value))) return '--';
  const n = Number(value);
  const sign = n > 0 ? '+' : '';
  return `${sign}${formatUsd(n)}`;
}

/** 持仓时长：按最大单位取两级，如「3 天 5 小时」「12 分钟」 */
export function formatDuration(ms: number | null | undefined) {
  const total = Number(ms);
  if (!Number.isFinite(total) || total <= 0) return '--';
  const minutes = Math.floor(total / 60000);
  if (minutes < 1) return '不足 1 分钟';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days) return hours ? `${days} 天 ${hours} 小时` : `${days} 天`;
  if (hours) return mins ? `${hours} 小时 ${mins} 分钟` : `${hours} 小时`;
  return `${mins} 分钟`;
}

/** 相对时间：如「18天前」「3小时前」「12分钟前」 */
export function formatRelativeAgo(ts: number | null | undefined, now = Date.now()) {
  const time = Number(ts) || 0;
  if (!time) return '未知';
  const ms = Math.max(0, now - time);
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  return `${days}天前`;
}

export function directionLabel(direction: string) {
  if (direction === 'long') return '做多';
  if (direction === 'short') return '做空';
  return '观望';
}

export function formatEventCountdown(event: {
  daysUntil: number;
  isToday?: boolean;
  isTomorrow?: boolean;
}) {
  if (event.isToday || event.daysUntil === 0) return '今天';
  if (event.isTomorrow || event.daysUntil === 1) return '明天';
  if (event.daysUntil < 0) return `${Math.abs(event.daysUntil)} 天前`;
  return `${event.daysUntil} 天后`;
}
