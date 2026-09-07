import type { WhalePosition, WhaleProfile } from '@/types';
import { formatUsd, shortAddress } from '@/utils/format';
import { positionPnlPct } from '@/utils/whaleCardUtils';

export type WhaleTitleFields = Partial<
  Pick<
    WhaleProfile,
    | 'name'
    | 'address'
    | 'winRate'
    | 'weekVlm'
    | 'monthVlm'
    | 'monthPnl'
    | 'allTimePnl'
    | 'accountValue'
    | 'closedTrades'
    | 'customName'
  >
> & {
  name?: string | null;
  address?: string | null;
};

export type ReferenceTier = 'high' | 'mid' | 'watch' | 'low';

export interface ReferenceTierInfo {
  tier: ReferenceTier;
  label: string;
  shortLabel: string;
}

const TIER_META: Record<ReferenceTier, { label: string; shortLabel: string }> = {
  high: { label: '高参考价值', shortLabel: '高' },
  mid: { label: '中参考价值', shortLabel: '中' },
  watch: { label: '待观察', shortLabel: '待观察' },
  low: { label: '低参考价值', shortLabel: '低' },
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** 自动生成的指标型名称（榜单/高频拼接），不宜直接当标题 */
export function isAutoMetricName(name: string | null | undefined) {
  const raw = String(name || '').trim();
  if (!raw) return true;
  if (/^榜单/.test(raw)) return true;
  if (/月成\$/.test(raw)) return true;
  if (/^\$[\d.]+[亿万]?[·.\-]/.test(raw)) return true;
  const stripped = raw.replace(/^高频/, '');
  if (/^\d+(\.\d+)?%[·.\-]\d+笔/.test(stripped)) return true;
  return false;
}

/** 名称是否只是地址缩写（无真实昵称） */
export function isAddressLikeName(
  name: string | null | undefined,
  address: string | null | undefined,
) {
  const cleaned = String(name || '')
    .replace(/^高频/, '')
    .trim();
  if (!cleaned) return true;
  if (isAutoMetricName(cleaned)) return true;
  if (/^[0-9a-f]{4,10}$/i.test(cleaned)) return true;
  const addr = String(address || '').toLowerCase();
  if (!addr) return false;
  const lower = cleaned.toLowerCase();
  if (lower === addr) return true;
  if (addr.endsWith(lower) && lower.length <= 10) return true;
  return false;
}

/** 无真实名称时：完整地址 */
export function formatMetricWhaleTitle(whale: WhaleTitleFields) {
  const addr = String(whale.address || '').trim();
  return addr || '--';
}

/**
 * 展示名：
 * - 自定义名 / 真实昵称 → 名称
 * - 否则 → 完整地址（不再拼 $成交·胜率·尾号）
 */
export function whaleCardTitle(whale: WhaleTitleFields) {
  const name = String(whale.name || '').trim();
  const cleaned = name.replace(/^高频/, '').trim();
  const addr = String(whale.address || '').trim();

  if (whale.customName && cleaned) return cleaned;

  const ensInline = name.match(/\b([a-z0-9-]+\.eth)\b/i);
  if (ensInline) return ensInline[1];
  if (/\.eth$/i.test(name)) return name;

  if (cleaned && !isAddressLikeName(cleaned, whale.address)) {
    return cleaned;
  }

  return addr || formatMetricWhaleTitle(whale);
}

/** 第二行：有自定义名 → 名称（地址）；否则完整地址 */
export function whaleCardIdentityLine(whale: WhaleTitleFields) {
  const addr = String(whale.address || '').trim();
  const title = whaleCardTitle(whale);
  const hasCustom =
    whale.customName === true ||
    (Boolean(String(whale.name || '').trim()) &&
      !isAddressLikeName(whale.name, whale.address) &&
      !isAutoMetricName(whale.name));
  if (hasCustom && addr) {
    const short = addr.length > 14 ? `${addr.slice(0, 8)}…${addr.slice(-4)}` : addr;
    return `${title}（${short}）`;
  }
  return addr || title || '--';
}

/**
 * 全站统一展示名：优先用当前名单实时算 whaleCardTitle，
 * 找不到再用快照 name/address 兜底（旧异动不必改库）。
 */
export function resolveWhaleTitle(
  whales: Array<WhaleTitleFields & { id?: string }> | null | undefined,
  opts: { id?: string; name?: string; address?: string } = {},
) {
  const id = String(opts.id || '').trim();
  const addr = String(opts.address || '').trim().toLowerCase();
  const list = Array.isArray(whales) ? whales : [];
  const hit =
    (id && list.find((w) => String(w.id || '') === id)) ||
    (addr && list.find((w) => String(w.address || '').toLowerCase() === addr)) ||
    null;
  if (hit) return whaleCardTitle(hit);
  return whaleCardTitle({
    name: opts.name || '',
    address: opts.address || '',
    winRate: 0,
  });
}

/** 首次建仓时间；历史不完整时返回 null（不纳入持仓天数评分） */
export function positionFirstOpenTime(
  pos: Pick<WhalePosition, 'firstOpenTime' | 'openTime' | 'openHistoryComplete'>,
): number | null {
  if (pos.openHistoryComplete === false) return null;
  const ts = Number(pos.firstOpenTime ?? pos.openTime) || 0;
  return ts > 0 ? ts : null;
}

/** 最近加仓/开仓时间（用于「最新开单」排序与展示） */
export function positionLastAddTime(
  pos: Pick<WhalePosition, 'lastAddTime' | 'firstOpenTime' | 'openTime'>,
): number | null {
  const ts = Number(pos.lastAddTime ?? pos.firstOpenTime ?? pos.openTime) || 0;
  return ts > 0 ? ts : null;
}

function positionHoldingDays(
  pos: Pick<WhalePosition, 'firstOpenTime' | 'openTime' | 'openHistoryComplete'>,
  now: number,
) {
  const open = positionFirstOpenTime(pos);
  if (!open) return null;
  return Math.max(0, (now - open) / DAY_MS);
}

/**
 * 「高」档额外约束：存在潜在扛单，或长期持仓仓位占比过高 → 降为「中」
 * - 潜在扛单：持仓 >7 天 且 浮亏 >10%（按保证金 ROE；持仓按首次建仓）
 * - 长期持仓占比：持仓 >7 天的仓位数 / 总仓位数 >30%
 * 首次建仓时间未知的仓位不计入「长期持仓」分子，也不触发扛单降级
 */
function shouldDowngradeHighForHolding(
  positions: WhalePosition[] | null | undefined,
  now = Date.now(),
): boolean {
  const list = Array.isArray(positions) ? positions : [];
  if (!list.length) return false;

  let longHoldCount = 0;
  let knownCount = 0;
  for (const pos of list) {
    const days = positionHoldingDays(pos, now);
    if (days == null) continue;
    knownCount += 1;
    if (days > 7) longHoldCount += 1;

    const pnlPct = positionPnlPct(pos);
    if (days > 7 && pnlPct != null && pnlPct < -10) {
      return true;
    }
  }

  if (!knownCount) return false;
  return longHoldCount / list.length > 0.3;
}

/**
 * 参考等级：
 * - 高：胜率≥65% 且 笔数≥300 且 回撤<35%；且当前无潜在扛单、长期持仓占比≤30%
 * - 中：胜率≥55% 且 笔数≥100 且 回撤≤45%（含从「高」因持仓约束降级）
 * - 待观察：笔数<30 或 数据不足
 * - 低：回撤>45%
 */
export function resolveReferenceTier(
  whale: Pick<WhaleProfile, 'winRate' | 'closedTrades' | 'maxDrawdown' | 'positions'>,
): ReferenceTierInfo {
  const winRate = Number(whale.winRate) || 0;
  const trades = Number(whale.closedTrades) || 0;
  const hasDd = whale.maxDrawdown != null && Number.isFinite(Number(whale.maxDrawdown));
  const drawdown = hasDd ? Number(whale.maxDrawdown) : null;
  const dataInsufficient = trades <= 0 && winRate <= 0;

  if (dataInsufficient || trades < 30) {
    return { tier: 'watch', ...TIER_META.watch };
  }
  if (drawdown != null && drawdown > 45) {
    return { tier: 'low', ...TIER_META.low };
  }
  if (winRate >= 65 && trades >= 300 && drawdown != null && drawdown < 35) {
    if (shouldDowngradeHighForHolding(whale.positions)) {
      return { tier: 'mid', ...TIER_META.mid };
    }
    return { tier: 'high', ...TIER_META.high };
  }
  if (winRate >= 55 && trades >= 100 && drawdown != null && drawdown <= 45) {
    return { tier: 'mid', ...TIER_META.mid };
  }
  return { tier: 'watch', ...TIER_META.watch };
}

/** 排序权重：高 > 中 > 待观察 > 低 */
export const REFERENCE_TIER_RANK: Record<ReferenceTier, number> = {
  high: 4,
  mid: 3,
  watch: 2,
  low: 1,
};

export function referenceTierScore(
  whale: Pick<WhaleProfile, 'winRate' | 'closedTrades' | 'maxDrawdown' | 'positions'>,
) {
  return REFERENCE_TIER_RANK[resolveReferenceTier(whale).tier];
}

export function whaleVolumeUsd(
  whale: Pick<WhaleProfile, 'weekVlm' | 'monthVlm' | 'name'>,
) {
  const month = Number(whale.monthVlm);
  if (Number.isFinite(month) && month > 0) return { usd: month, label: '月成交' };

  // 兼容旧版「榜单·月成$x亿」名称里的月成交
  const fromName = String(whale.name || '').match(/月成\$([0-9.]+)(亿|万)?/);
  if (fromName) {
    const n = Number(fromName[1]);
    if (Number.isFinite(n) && n > 0) {
      const usd = fromName[2] === '亿' ? n * 1e8 : fromName[2] === '万' ? n * 1e4 : n;
      return { usd, label: '月成交' };
    }
  }

  const week = Number(whale.weekVlm);
  if (Number.isFinite(week) && week > 0) return { usd: week, label: '周成交' };
  return { usd: 0, label: '成交' };
}

export function whaleActiveDays(whale: Pick<WhaleProfile, 'activeDays' | 'description' | 'name'>) {
  const direct = Number(whale.activeDays);
  if (Number.isFinite(direct) && direct > 0) return Math.round(direct);
  const blob = `${whale.description || ''} ${whale.name || ''}`;
  const hit = blob.match(/(\d+)\s*(?:天|d)\b/i);
  if (hit) {
    const n = Number(hit[1]);
    if (Number.isFinite(n) && n > 0 && n < 20000) return n;
  }
  return null;
}

export function formatWhaleAddressLine(address: string) {
  const short = shortAddress(address);
  if (!address) return '地址 未填写';
  return `地址 ${short}`;
}

export function formatWhaleMetricLines(
  whale: Pick<
    WhaleProfile,
    | 'winRate'
    | 'maxDrawdown'
    | 'closedTrades'
    | 'weekVlm'
    | 'monthVlm'
    | 'monthPnl'
    | 'allTimePnl'
    | 'accountValue'
    | 'activeDays'
    | 'description'
    | 'name'
  >,
) {
  const volume = whaleVolumeUsd(whale);
  const days = whaleActiveDays(whale);
  const lineAParts: string[] = [];
  if (volume.usd > 0) lineAParts.push(`${volume.label} ${formatUsd(volume.usd)}`);
  if (days != null) lineAParts.push(`${days}天`);

  const monthPnl = Number(whale.monthPnl);
  const allTimePnl = Number(whale.allTimePnl);
  const accountValue = Number(whale.accountValue);
  const trades = Number(whale.closedTrades) || 0;
  const winRateRaw = Number(whale.winRate);
  const lineBParts: string[] = [];

  /** 盈亏相对期初权益估算：pnl / (账户权益 − pnl) */
  const formatRoi = (pnl: number) => {
    if (!(Number.isFinite(accountValue) && accountValue > 0)) return '';
    const base = accountValue - pnl;
    const roi = base > Math.abs(pnl) * 0.01 ? pnl / base : pnl / accountValue;
    if (!Number.isFinite(roi)) return '';
    const pct = roi * 100;
    const sign = pct > 0 ? '+' : '';
    const body = Math.abs(pct) >= 10 ? pct.toFixed(0) : pct.toFixed(1);
    return `${sign}${body}%`;
  };

  if (Number.isFinite(monthPnl) && monthPnl !== 0) {
    const roi = formatRoi(monthPnl);
    lineBParts.push(roi ? `月盈亏 ${formatUsd(monthPnl)}（${roi}）` : `月盈亏 ${formatUsd(monthPnl)}`);
  }
  if (Number.isFinite(allTimePnl) && allTimePnl !== 0) {
    const roi = formatRoi(allTimePnl);
    lineBParts.push(roi ? `累计 ${formatUsd(allTimePnl)}（${roi}）` : `累计 ${formatUsd(allTimePnl)}`);
  }
  if (Number.isFinite(winRateRaw) && winRateRaw > 0) {
    const wr = winRateRaw <= 1 ? winRateRaw * 100 : winRateRaw;
    lineBParts.push(`胜率 ${wr.toFixed(0)}%`);
  }
  if (trades > 0) lineBParts.push(`${trades}笔`);

  return {
    volumeLine: lineAParts.join(' · '),
    statsLine: lineBParts.join(' · '),
  };
}
