import type { CalendarEvent, WhaleProfile } from '@/types';
import { buildWhaleMarketSummary } from '@/utils/whaleSummary';
import {
  fundingAnnualizedPct,
  fundingFollowWarning,
  fundingOf,
  HIGH_FUNDING_ANNUAL_PCT,
} from '@/utils/fundingAlert';
import { readPrimaryCoin } from '@/utils/watchedCoins';

export type MacroBias = 'long' | 'short' | 'neutral';
export type ResonanceTone = 'strong' | 'soft' | 'conflict' | 'vacuum';

export interface ResonanceStatus {
  tone: ResonanceTone;
  macroBias: MacroBias;
  whaleBias: MacroBias;
  fundingHigh: boolean;
  fundingAnnualPct: number | null;
  eventTitle: string;
  label: string;
  detail: string;
}

function titleKey(title: string) {
  return String(title || '');
}

/** 硬编码：事件类型 → 好于预期 / 差于预期 的加密方向 */
function leanFromEvent(event: CalendarEvent): MacroBias {
  if (event.impact === 'bull') return 'long';
  if (event.impact === 'bear') return 'short';

  const title = titleKey(event.title);
  const note = `${event.note || ''} ${event.forecast || ''} ${event.previous || ''}`;

  // 非农 / 就业：强于预期 → 利空；弱于预期 → 利多
  if (/非农|ADP|就业|失业率/.test(title)) {
    if (/不及|低于|疲软|回落/.test(note)) return 'long';
    if (/超预期|高于|强劲|好于/.test(note)) return 'short';
    return 'neutral';
  }
  // CPI / 通胀：高于预期 → 利空
  if (/CPI|PPI|通胀|PCE/.test(title)) {
    if (/回落|降温|低于|不及/.test(note)) return 'long';
    if (/升温|高于|超预期|顽固/.test(note)) return 'short';
    return 'neutral';
  }
  // ISM / PMI：强于预期 → 利多（风险偏好）
  if (/ISM|PMI|制造业|服务业/.test(title)) {
    if (/不及|低于|收缩|回落/.test(note)) return 'short';
    if (/扩张|高于|超预期|回升/.test(note)) return 'long';
    return 'neutral';
  }
  // FOMC
  if (/FOMC|利率决议|美联储/.test(title)) {
    if (/降息/.test(`${title}${note}`)) return 'long';
    if (/加息/.test(`${title}${note}`)) return 'short';
    return 'neutral';
  }

  if (event.impact === 'volatile' || event.impact === 'liquidity') return 'neutral';
  return 'neutral';
}

function whaleNetBias(whales: WhaleProfile[]): MacroBias {
  const summary = buildWhaleMarketSummary(whales);
  if (!summary.longPct && !summary.shortPct) return 'neutral';
  if (summary.longPct >= summary.shortPct + 8) return 'long';
  if (summary.shortPct >= summary.longPct + 8) return 'short';
  return 'neutral';
}

function pickAnchorEvent(events: CalendarEvent[]): CalendarEvent | null {
  const list = [...(events || [])].filter((item) => item.importance === 'high' || item.importance === 'mid');
  // 优先：已发生或今天的高重要性事件
  const pastOrToday = list
    .filter((item) => item.daysUntil <= 0 || item.isToday)
    .sort((a, b) => a.daysUntil - b.daysUntil || String(b.date).localeCompare(String(a.date)));
  if (pastOrToday.length) return pastOrToday[pastOrToday.length - 1];
  // 否则：最近即将公布的
  const upcoming = list
    .filter((item) => item.daysUntil >= 0)
    .sort((a, b) => a.daysUntil - b.daysUntil || String(a.date).localeCompare(String(b.date)));
  return upcoming[0] || null;
}

function biasLabel(bias: MacroBias) {
  if (bias === 'long') return '利多';
  if (bias === 'short') return '利空';
  return '中性';
}

function whaleLabel(bias: MacroBias) {
  if (bias === 'long') return '做多';
  if (bias === 'short') return '做空';
  return '观望';
}

export function buildResonanceStatus(input: {
  whales: WhaleProfile[];
  events: CalendarEvent[];
  fundingRates?: Record<string, number>;
  focusCoin?: string;
}): ResonanceStatus {
  const event = pickAnchorEvent(input.events);
  const macroBias = event ? leanFromEvent(event) : 'neutral';
  const whaleBias = whaleNetBias(input.whales);
  const coin = input.focusCoin || readPrimaryCoin();
  const funding8h = fundingOf(input.fundingRates, coin);
  const annual = fundingAnnualizedPct(funding8h);
  const fundingHighFlag = annual != null && Math.abs(annual) >= HIGH_FUNDING_ANNUAL_PCT;
  const followWarn =
    whaleBias === 'long' || whaleBias === 'short'
      ? fundingFollowWarning(whaleBias, funding8h)
      : null;

  const eventTitle = event?.title || '暂无关键宏观事件';

  if (macroBias === 'neutral' || !event) {
    return {
      tone: 'vacuum',
      macroBias,
      whaleBias,
      fundingHigh: Boolean(followWarn) || fundingHighFlag,
      fundingAnnualPct: annual,
      eventTitle,
      label: '🟡 仅有巨鲸信号，宏观真空期',
      detail: followWarn
        ? `${whaleLabel(whaleBias)} · ${followWarn.text}`
        : `巨鲸净方向：${whaleLabel(whaleBias)}`,
    };
  }

  const aligned = (macroBias === 'long' && whaleBias === 'long') || (macroBias === 'short' && whaleBias === 'short');
  const conflict = (whaleBias === 'long' || whaleBias === 'short') && macroBias !== whaleBias;

  if (aligned && !followWarn) {
    return {
      tone: 'strong',
      macroBias,
      whaleBias,
      fundingHigh: false,
      fundingAnnualPct: annual,
      eventTitle,
      label: `🟢 共振${whaleLabel(whaleBias)}（宏观+巨鲸+费率）`,
      detail: `${eventTitle}→${biasLabel(macroBias)} · 巨鲸${whaleLabel(whaleBias)} · 费率正常`,
    };
  }

  if (aligned && followWarn) {
    return {
      tone: 'soft',
      macroBias,
      whaleBias,
      fundingHigh: true,
      fundingAnnualPct: annual,
      eventTitle,
      label: '🟡 方向共振但费率偏高，轻仓',
      detail: `${eventTitle}→${biasLabel(macroBias)} · ${followWarn.text}`,
    };
  }

  if (conflict) {
    return {
      tone: 'conflict',
      macroBias,
      whaleBias,
      fundingHigh: Boolean(followWarn),
      fundingAnnualPct: annual,
      eventTitle,
      label: `🔴 方向冲突：宏观${biasLabel(macroBias)}但巨鲸${whaleLabel(whaleBias)}`,
      detail: followWarn ? `${eventTitle} · ${followWarn.text}` : eventTitle,
    };
  }

  return {
    tone: 'vacuum',
    macroBias,
    whaleBias,
    fundingHigh: Boolean(followWarn),
    fundingAnnualPct: annual,
    eventTitle,
    label: '🟡 宏观已锚定，巨鲸方向尚不清晰',
    detail: `${eventTitle}→${biasLabel(macroBias)}`,
  };
}
