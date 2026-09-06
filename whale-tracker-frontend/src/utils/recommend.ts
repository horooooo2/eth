import type { CalendarEvent, NewsArticle, WhaleDirection, WhaleProfile } from '@/types';
import { formatEventCountdown, formatPct, formatPrice, formatUsd } from '@/utils/format';
import { readWatchedCoins } from '@/utils/watchedCoins';

export type RecoBias = 'long' | 'short' | 'wait';

export interface RecoQuotes {
  [coin: string]: number | undefined;
}

export interface RecoWhaleRow {
  id: string;
  name: string;
  coin: string;
  side: 'long' | 'short';
  price: number;
  leverage: number | null;
  usd: number;
  weightedUsd: number;
  weight: number;
  size: number;
  pnl: number;
  winRate: number;
  openTime: number | null;
  liquidationPx: number | null;
}

export interface RecoOptions {
  sinceMs?: number;
  window?: RecoWindow;
  coin?: string;
  /** 是否启用开仓时间衰减；关闭后等权计分 */
  decay?: boolean;
}

export type RecoWindow = 'all' | '24h' | '3d' | '7d';

export interface RecoNewsRow {
  title: string;
  lean: 'long' | 'short' | 'irrelevant';
  category: string;
  keywords: string[];
  source: string;
}

export interface RecoEventRow {
  title: string;
  when: string;
  forecast: string;
  impact: string;
  lean: 'long' | 'short';
  weight: number;
  score: number;
  reason: string;
  note: string;
}

export interface RecoSignalStrength {
  long: number;
  short: number;
  label: string;
  score: number;
}

export type RecoTone = 'up' | 'down' | 'accent' | 'warn';

export interface RecoSpan {
  text: string;
  tone?: RecoTone;
}

export interface RecoLine {
  coin?: string;
  spans: RecoSpan[];
}

export interface RecoPriceRow {
  coin: string;
  spot: number;
  longEntry: number;
  shortEntry: number;
  longGap: number | null;
  shortGap: number | null;
  text: string;
}

export interface RecoNoteBlock {
  title: string;
  lines: string[];
}

export interface Recommendation {
  bias: RecoBias;
  action: string;
  text: string;
  lines: RecoLine[];
  overview: RecoLine[];
  strength: RecoSignalStrength;
  sources: {
    stats: {
      total: number;
      long: number;
      short: number;
      neutral: number;
      longPct: number;
      shortPct: number;
      longUsd: number;
      shortUsd: number;
      ratio: string;
    };
    coin: string;
    whales: RecoWhaleRow[];
    news: RecoNewsRow[];
    event: RecoEventRow | null;
    quotes: RecoQuotes;
    prices: RecoPriceRow[];
    notes: RecoNoteBlock[];
    window: RecoWindow;
    decay: boolean;
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 仅保留直接影响 BTC/ETH 的核心主题 */
const CORE_NEWS = {
  regulation: /监管|SEC|CFTC|合规|禁令|政策.*加密|加密.*政策|制裁.*币|币.*制裁|牌照|执法/,
  fed: /美联储|联储|Fed\b|FOMC|鲍威尔|Powell|降息|加息|利率决议|点阵图|缩表|QT\b|QE\b/,
  whale: /巨鲸|whale|大额转入|大额转出|转入.*交易所|转出.*交易所|冷钱包.*转入|交易所.*提币/,
  etf: /ETF|流入|流出|灰度|GBTC|IBIT|ETHA|贝莱德|BlackRock|Fidelity.*比特币|比特币.*ETF|以太坊.*ETF/,
} as const;

const BULL_NEWS = /降息|鸽派|ETF.*流入|净流入|获批|通过|宽松|买入|转入冷钱包|提币/;
const BEAR_NEWS = /加息|鹰派|监管|诉讼|流出|净流出|制裁|收紧|卖出|调查|禁令|执法/;

function openAgeWeight(
  openTime: number | null | undefined,
  now = Date.now(),
  decay = true,
) {
  if (!decay) return 1;
  const ts = Number(openTime) || 0;
  if (!ts) return 0;
  const age = now - ts;
  if (age < 0) return 1;
  if (age <= DAY_MS) return 1;
  if (age <= 3 * DAY_MS) return 0.5;
  if (age <= 7 * DAY_MS) return 0.2;
  return 0;
}

function enabledWhales(whales: WhaleProfile[]): WhaleProfile[] {
  return whales.filter((item) => item.enabled !== false);
}

function scopeWhales(whales: WhaleProfile[], coin?: string): WhaleProfile[] {
  if (!coin) return whales;
  const key = coin.toUpperCase();
  return whales.map((whale) => {
    const positions = (whale.positions || []).filter(
      (pos) => String(pos.coin).toUpperCase().replace(/^K/, '') === key,
    );
    let longUsd = 0;
    let shortUsd = 0;
    for (const pos of positions) {
      const usd = Number(pos.positionValue) || 0;
      if (pos.side === 'long') longUsd += usd;
      else shortUsd += usd;
    }
    let direction: WhaleDirection = 'neutral';
    if (longUsd > shortUsd && longUsd > 0) direction = 'long';
    else if (shortUsd > longUsd && shortUsd > 0) direction = 'short';
    return { ...whale, positions, longUsd, shortUsd, netUsd: longUsd - shortUsd, direction };
  });
}

function listPrices(values: number[]) {
  const uniq = [
    ...new Set(
      values
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)
        .map((value) => Math.round(value * 100) / 100),
    ),
  ].sort((a, b) => a - b);
  if (!uniq.length) return '';
  const shown = uniq.slice(0, 6);
  const text = shown.map((value) => formatPrice(value)).join('、');
  return uniq.length > shown.length ? `${text} 等` : text;
}

export function collectPositions(
  whales: WhaleProfile[],
  options: { sinceMs?: number; now?: number; decay?: boolean } = {},
): RecoWhaleRow[] {
  const now = options.now || Date.now();
  const decay = options.decay !== false;
  const rows: RecoWhaleRow[] = [];
  for (const whale of whales) {
    for (const pos of whale.positions || []) {
      if (!pos.positionValue) continue;
      const openTime = pos.openTime || null;
      if (options.sinceMs && Number(openTime) < options.sinceMs) continue;
      const weight = openAgeWeight(openTime, now, decay);
      if (weight <= 0) continue;
      const usd = Number(pos.positionValue) || 0;
      rows.push({
        id: whale.id,
        name: whale.name,
        coin: String(pos.coin).toUpperCase(),
        side: pos.side,
        price: pos.entryPx,
        leverage: pos.leverage,
        usd,
        weightedUsd: usd * weight,
        weight,
        size: Number(pos.size) || 0,
        pnl: Number(pos.unrealizedPnl) || 0,
        winRate: whale.winRate || 0,
        openTime,
        liquidationPx:
          pos.liquidationPx == null || pos.liquidationPx === ''
            ? null
            : Number(pos.liquidationPx) || null,
      });
    }
  }
  return rows.sort((a, b) => b.weightedUsd - a.weightedUsd);
}

export function coinSides(rows: RecoWhaleRow[], coin: string) {
  const longs = rows.filter((item) => item.coin === coin && item.side === 'long');
  const shorts = rows.filter((item) => item.coin === coin && item.side === 'short');
  return {
    coin,
    longs,
    shorts,
    longUsd: longs.reduce((sum, item) => sum + item.weightedUsd, 0),
    shortUsd: shorts.reduce((sum, item) => sum + item.weightedUsd, 0),
    longRawUsd: longs.reduce((sum, item) => sum + item.usd, 0),
    shortRawUsd: shorts.reduce((sum, item) => sum + item.usd, 0),
    count: longs.length + shorts.length,
  };
}

type CoinBook = ReturnType<typeof coinSides>;

function pickCoin(rows: RecoWhaleRow[]) {
  const watched = readWatchedCoins();
  const books = watched.map((coin) => coinSides(rows, coin));
  if (!books.length) return coinSides(rows, 'BTC');
  return [...books].sort((a, b) => b.longUsd + b.shortUsd - (a.longUsd + a.shortUsd))[0];
}

export function avgEntry(rows: RecoWhaleRow[]) {
  const valid = rows.filter((item) => item.price > 0);
  if (!valid.length) return 0;
  const usd = valid.reduce((sum, item) => sum + item.weightedUsd, 0);
  if (usd > 0) return valid.reduce((sum, item) => sum + item.price * item.weightedUsd, 0) / usd;
  return valid.reduce((sum, item) => sum + item.price, 0) / valid.length;
}

function impliedSpot(rows: RecoWhaleRow[]) {
  for (const row of rows) {
    const abs = Math.abs(row.size);
    if (!abs || !row.price) continue;
    const mark = row.side === 'long' ? row.price + row.pnl / abs : row.price - row.pnl / abs;
    if (mark > 0) return mark;
  }
  return 0;
}

export function spotOf(coin: string, quotes: RecoQuotes, rows: RecoWhaleRow[]) {
  const quoted = Number(quotes[coin as keyof RecoQuotes]) || 0;
  if (quoted > 0) return quoted;
  return impliedSpot(rows.filter((item) => item.coin === coin));
}

function gapPct(entry: number, spot: number) {
  if (!entry || !spot) return null;
  return ((spot - entry) / entry) * 100;
}

export function positionPnlPct(side: 'long' | 'short', entry: number, spot: number) {
  const gap = gapPct(entry, spot);
  if (gap == null) return null;
  return pnlPct(side, gap);
}

function pnlPct(side: 'long' | 'short', gap: number) {
  return side === 'long' ? gap : -gap;
}

function chaseScore(side: 'long' | 'short', gap: number | null) {
  if (gap == null) return 0;
  const pnl = pnlPct(side, gap);
  if (pnl >= 8) return -2;
  if (pnl >= 4) return -1;
  if (pnl <= -6) return 1;
  return 0;
}

export function chaseHint(side: 'long' | 'short', gap: number | null) {
  if (gap == null) return '';
  const pnl = pnlPct(side, gap);
  const word = side === 'long' ? '多' : '空';
  const abs = `${Math.abs(pnl).toFixed(1)}%`;
  if (pnl >= 8) return `浮盈约 ${abs}，现价追${word}性价比偏低`;
  if (pnl >= 4) return `已偏离开仓区约 ${abs}，跟${word}需谨慎`;
  if (pnl <= -6) {
    return side === 'long'
      ? `现价低于开仓约 ${abs}，更接近回踩接多`
      : `现价高于开仓约 ${abs}，空单浮亏，现价空点优于巨鲸开仓`;
  }
  return '现价接近开仓，跟单参考意义更大';
}

function span(text: string, tone?: RecoTone): RecoSpan {
  return tone ? { text, tone } : { text };
}

function linePlain(line: RecoLine) {
  return `${line.coin ? `${line.coin} ` : ''}${line.spans.map((item) => item.text).join('')}`;
}

function gapTone(side: 'long' | 'short', gap: number): RecoTone {
  const pnl = pnlPct(side, gap);
  return pnl < 0 ? 'down' : 'up';
}

function chaseTag(side: 'long' | 'short', gap: number | null): RecoSpan | null {
  if (gap == null) return null;
  const pnl = pnlPct(side, gap);
  if (pnl >= 8) return span(side === 'long' ? '不宜追多' : '不宜追空', 'warn');
  if (pnl >= 4) return span('跟单需谨慎', 'warn');
  if (pnl <= -6) {
    return side === 'long'
      ? span('回踩接多更优', 'up')
      : span('空单浮亏，现价空点更优', 'warn');
  }
  return span('接近开仓', 'accent');
}

function sideSpans(side: 'long' | 'short', rows: RecoWhaleRow[], spot: number): RecoSpan[] {
  if (!rows.length) return [];
  const gap = gapPct(avgEntry(rows), spot);
  const weighted = rows.reduce((sum, item) => sum + item.weightedUsd, 0);
  const spans: RecoSpan[] = [
    span(side === 'long' ? '开多 ' : '开空 ', side === 'long' ? 'up' : 'down'),
    span(formatUsd(weighted), side === 'long' ? 'up' : 'down'),
    span(`（${rows.length} 笔）`),
    span(' 开仓 '),
    span(listPrices(rows.map((item) => item.price)), 'accent'),
  ];
  if (gap != null) {
    spans.push(span(' 相对开仓 '), span(formatPct(pnlPct(side, gap)), gapTone(side, gap)));
    const tag = chaseTag(side, gap);
    if (tag) spans.push(span('，'), tag);
  }
  return spans;
}

function coinLine(book: CoinBook, spot: number): RecoLine | null {
  if (!book.count && !spot) return null;
  const spans: RecoSpan[] = spot
    ? [span('现价 '), span(formatPrice(spot), 'accent')]
    : [span('暂无现价')];
  const longSpans = sideSpans('long', book.longs, spot);
  const shortSpans = sideSpans('short', book.shorts, spot);
  if (longSpans.length) spans.push(span(' · '), ...longSpans);
  if (shortSpans.length) spans.push(span(' · '), ...shortSpans);
  if (!book.count) spans.push(span('，暂无监控仓位'));
  return { coin: book.coin, spans };
}

function contextSpans(
  extra: string,
  eliteBit: string,
  priceOverride: string,
  bias: RecoBias,
): RecoSpan[] {
  const spans: RecoSpan[] = [];
  const push = (item: RecoSpan) => {
    if (spans.length) spans.push(span('，'));
    spans.push(item);
  };
  if (extra) {
    const newsHit = extra.match(/，(近期核心新闻对加密偏[空多].*)$/);
    const head = newsHit ? extra.slice(0, newsHit.index) : extra;
    const news = newsHit?.[1] || '';
    const forecast = head.match(/（预期 [^）]+）/);
    if (forecast) {
      const [before, after] = [head.slice(0, forecast.index), head.slice((forecast.index || 0) + forecast[0].length)];
      if (before) spans.push(span(before));
      spans.push(span(forecast[0], 'accent'));
      if (after) spans.push(span(after));
    } else if (head) {
      spans.push(span(head));
    }
    if (news) push(span(news, /偏空/.test(news) ? 'down' : 'up'));
  }
  if (eliteBit) push(span(eliteBit, 'accent'));
  if (priceOverride) push(span(priceOverride, 'warn'));
  push(span(actionOf(bias), bias === 'long' ? 'up' : bias === 'short' ? 'down' : 'warn'));
  return spans;
}

function overviewLines(books: CoinBook[]): RecoLine[] {
  const lines = ['BTC', 'ETH']
    .map((coin) => books.find((item) => item.coin === coin))
    .filter((book): book is CoinBook => Boolean(book?.count))
    .map((book) => {
      const total = book.longUsd + book.shortUsd;
      const longShare = total ? Math.round((book.longUsd / total) * 100) : 0;
      return {
        coin: book.coin,
        spans: [
          span(`${book.coin} `),
          span('多 ', 'up'),
          span(formatUsd(book.longUsd), 'up'),
          span(`（${longShare}%）`),
          span(' · '),
          span('空 ', 'down'),
          span(formatUsd(book.shortUsd), 'down'),
          span(`（${100 - longShare}%）`),
        ],
      };
    });
  if (lines.length) return lines;
  return [{ spans: [span('当前筛选下暂无有效加权仓位')] }];
}

function packLines(
  books: CoinBook[],
  quotes: RecoQuotes,
  extra: string,
  eliteBit: string,
  priceOverride: string,
  bias: RecoBias,
): RecoLine[] {
  const lines: RecoLine[] = [];
  for (const book of books) {
    const line = coinLine(book, quotes[book.coin as 'BTC' | 'ETH'] || 0);
    if (line) lines.push(line);
  }
  const ctx = contextSpans(extra, eliteBit, priceOverride, bias);
  if (ctx.length) lines.push({ spans: ctx });
  return lines;
}

function coreNewsCategory(text: string): keyof typeof CORE_NEWS | null {
  for (const [key, pattern] of Object.entries(CORE_NEWS) as [keyof typeof CORE_NEWS, RegExp][]) {
    if (pattern.test(text)) return key;
  }
  return null;
}

const CATEGORY_LABEL: Record<keyof typeof CORE_NEWS, string> = {
  regulation: '监管政策',
  fed: '美联储',
  whale: '巨鲸转账',
  etf: 'ETF 流向',
};

function newsLean(articles: NewsArticle[], sinceMs?: number) {
  const pool = sinceMs
    ? articles.filter((item) => Number(item.publishedAt) >= sinceMs)
    : articles.slice(0, 40);
  const hits: RecoNewsRow[] = [];
  let bull = 0;
  let bear = 0;
  let skipped = 0;

  for (const item of pool) {
    const text = `${item.title || ''} ${(item.matchedKeywords || []).join(' ')}`;
    const category = coreNewsCategory(text);
    if (!category) {
      skipped += 1;
      continue;
    }
    const isBull = BULL_NEWS.test(text);
    const isBear = BEAR_NEWS.test(text);
    if (!isBull && !isBear) {
      skipped += 1;
      continue;
    }
    if (isBull) bull += 1;
    if (isBear) bear += 1;
    hits.push({
      title: item.title,
      lean: isBear && !isBull ? 'short' : 'long',
      category: CATEGORY_LABEL[category],
      keywords: item.matchedKeywords || [],
      source: item.source || '',
    });
  }

  const score = bull === bear ? 0 : bull > bear ? 1 : -1;
  return { score, bull, bear, skipped, hits: hits.slice(0, 8) };
}

function whenLabel(event: CalendarEvent) {
  return formatEventCountdown(event);
}

function parseForecastNumber(forecast?: string) {
  if (!forecast || forecast === '待公布') return null;
  const match = String(forecast).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function macroTimingWeight(daysUntil: number) {
  if (daysUntil <= 0) return 1.5;
  if (daysUntil === 1) return 1.2;
  if (daysUntil <= 3) return 1;
  return 0.7;
}

/** 必须能给出明确多空与权重，否则返回 null（隐藏宏观模块） */
function scoreMacro(event: CalendarEvent | null): RecoEventRow | null {
  if (!event || event.daysUntil < 0 || event.daysUntil > 4) return null;
  if (event.importance === 'low') return null;

  const title = event.title || '';
  const forecast = event.forecast && event.forecast !== '待公布' ? event.forecast : '';
  const value = parseForecastNumber(forecast);
  const weight = macroTimingWeight(event.daysUntil);
  let lean: 'long' | 'short' | null = null;
  let reason = '';

  if (/ISM|PMI/.test(title)) {
    if (value == null) return null;
    const prev = parseForecastNumber(event.previous);
    if (value > 50) {
      lean = 'long';
      if (prev != null && value > prev) {
        reason = `PMI ${value}（前值/对照 ${prev}）→ 高于对照，风险偏好上升`;
      } else if (prev != null && value < prev) {
        reason = `PMI ${value}（前值/对照 ${prev}）→ 仍高于 50 但弱于对照，风险偏好温和`;
      } else {
        reason = `PMI ${value} > 50，偏风险偏好`;
      }
    } else if (value < 50) {
      lean = 'short';
      if (prev != null && value < prev) {
        reason = `PMI ${value}（前值/对照 ${prev}）→ 低于 50 且弱于对照，偏避险`;
      } else {
        reason = `PMI ${value} < 50，偏避险`;
      }
    } else {
      return null;
    }
  } else if (/CPI|PCE|PPI|通胀/.test(title)) {
    if (/回落|降温|低于|不及预期/.test(`${title}${forecast}${event.note || ''}`)) {
      lean = 'long';
      reason = '通胀预期偏弱，利好风险资产';
    } else if (/升温|高于|超预期|顽固/.test(`${title}${forecast}${event.note || ''}`)) {
      lean = 'short';
      reason = '通胀预期偏强，压制风险资产';
    } else if (event.impact === 'bull') {
      lean = 'long';
      reason = '宏观标签偏多';
    } else if (event.impact === 'bear') {
      lean = 'short';
      reason = '宏观标签偏空';
    } else {
      return null;
    }
  } else if (/FOMC|利率决议|点阵图/.test(title)) {
    if (/降息/.test(`${title}${forecast}${event.note || ''}`)) {
      lean = 'long';
      reason = '利率决议偏向降息预期';
    } else if (/加息/.test(`${title}${forecast}${event.note || ''}`)) {
      lean = 'short';
      reason = '利率决议偏向加息预期';
    } else if (event.impact === 'bull') {
      lean = 'long';
      reason = '利率路径偏鸽';
    } else if (event.impact === 'bear') {
      lean = 'short';
      reason = '利率路径偏鹰';
    } else {
      return null;
    }
  } else if (/非农|ADP|就业|失业/.test(title)) {
    if (event.impact === 'bull') {
      lean = 'long';
      reason = '就业数据路径偏多风险偏好';
    } else if (event.impact === 'bear') {
      lean = 'short';
      reason = '就业数据路径偏避险';
    } else {
      return null;
    }
  } else if (event.impact === 'bull') {
    lean = 'long';
    reason = '宏观事件明确偏多';
  } else if (event.impact === 'bear') {
    lean = 'short';
    reason = '宏观事件明确偏空';
  } else {
    return null;
  }

  const base = lean === 'long' ? 1 : -1;
  const score = Math.round(base * weight * 10) / 10;
  return {
    title: event.title,
    when: `${whenLabel(event)}${event.time ? ` ${event.time}` : ''}`,
    forecast: forecast || '待公布',
    impact: lean === 'long' ? '偏多' : '偏空',
    lean,
    weight,
    score,
    reason,
    note: event.note || '',
  };
}

function nextScoredMacro(events: CalendarEvent[]) {
  const ranked = [...events]
    .map((item) => scoreMacro(item))
    .filter(Boolean) as RecoEventRow[];
  ranked.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  return ranked[0] || null;
}

function newsClause(score: number) {
  if (score > 0) return '近期核心新闻对加密偏多';
  if (score < 0) return '近期核心新闻对加密偏空';
  return '';
}

function joinClauses(parts: string[]) {
  return parts.filter(Boolean).join('，');
}

function actionOf(bias: RecoBias) {
  if (bias === 'long') return '建议做多';
  if (bias === 'short') return '建议做空';
  return '建议观望';
}

function eventClause(event: RecoEventRow | null) {
  if (!event) return '';
  return `叠加${event.when}的${event.title}${event.forecast !== '待公布' ? `（预期 ${event.forecast}）` : ''}，${event.reason}`;
}

function sideGapText(side: 'long' | 'short', rows: RecoWhaleRow[], spot: number) {
  if (!rows.length) return '';
  const entry = avgEntry(rows);
  const gap = gapPct(entry, spot);
  const prices = listPrices(rows.map((item) => item.price));
  const weighted = rows.reduce((sum, item) => sum + item.weightedUsd, 0);
  const word = side === 'long' ? '开多' : '开空';
  const count = `${formatUsd(weighted)} ${word}（${rows.length} 笔） ${prices}`;
  if (!spot || gap == null) return count;
  return `${count}，现价相对开仓 ${formatPct(pnlPct(side, gap))}，${chaseHint(side, gap)}`;
}

function buildPriceRow(book: CoinBook, spot: number): RecoPriceRow | null {
  if (!book.count) return null;
  const longEntry = avgEntry(book.longs);
  const shortEntry = avgEntry(book.shorts);
  const longGap = longEntry && spot ? gapPct(longEntry, spot) : null;
  const shortGap = shortEntry && spot ? gapPct(shortEntry, spot) : null;
  const parts = [
    spot ? `${book.coin} 现价 ${formatPrice(spot)}` : `${book.coin} 暂无现价`,
    sideGapText('long', book.longs, spot),
    sideGapText('short', book.shorts, spot),
  ];
  return {
    coin: book.coin,
    spot,
    longEntry,
    shortEntry,
    longGap,
    shortGap,
    text: parts.filter(Boolean).join('；'),
  };
}

function followScore(side: 'long' | 'short', books: CoinBook[], quotes: RecoQuotes, rows: RecoWhaleRow[]) {
  let weighted = 0;
  let weight = 0;
  for (const book of books) {
    const pack = side === 'long' ? book.longs : book.shorts;
    const usd = side === 'long' ? book.longUsd : book.shortUsd;
    if (!pack.length || !usd) continue;
    const spot = spotOf(book.coin, quotes, rows);
    const gap = gapPct(avgEntry(pack), spot);
    weighted += chaseScore(side, gap) * usd;
    weight += usd;
  }
  if (!weight) return 0;
  return Math.round(weighted / weight);
}

function buildStrength(score: number, longPct = 50, shortPct = 50): RecoSignalStrength {
  let label = '信号中性';
  if (score >= 3) label = '强多信号';
  else if (score >= 1) label = '偏多信号';
  else if (score <= -3) label = '强空信号';
  else if (score <= -1) label = '偏空信号';
  const rounded = Math.round(score * 10) / 10;
  if (longPct + shortPct > 0) {
    return { long: longPct, short: shortPct, label, score: rounded };
  }
  const long = Math.max(0, Math.min(100, Math.round(50 + score * 14)));
  return { long, short: 100 - long, label, score: rounded };
}

function signed(value: number) {
  const n = Math.round(value * 10) / 10;
  return `${n > 0 ? '+' : ''}${n}`;
}

function approxRatio(longUsd: number, shortUsd: number) {
  if (!longUsd && !shortUsd) return '0:0';
  if (!shortUsd) return '全多';
  if (!longUsd) return '全空';
  const r = longUsd / shortUsd;
  if (r >= 1) return `${Math.max(1, Math.round(r))}:1`;
  return `1:${Math.max(1, Math.round(1 / r))}`;
}

function whaleScoreReason(score: number) {
  if (score >= 2) return '多头显著占优';
  if (score === 1) return '多头略占优';
  if (score <= -2) return '空头显著占优';
  if (score === -1) return '空头略占优';
  return '多空接近';
}

function priceFollowHint(side: 'long' | 'short', gap: number | null) {
  if (gap == null) return '暂无现价对比';
  const pnl = pnlPct(side, gap);
  const abs = `${Math.abs(pnl).toFixed(2)}%`;
  if (side === 'long') {
    if (pnl >= 0 && pnl < 1.5) return `浮盈 +${abs}，接近开仓区，跟单参考意义中等`;
    if (pnl >= 1.5 && pnl < 4) return `浮盈 +${abs}，已略离开仓区`;
    if (pnl >= 4) return `浮盈 +${abs}，现价追多性价比偏低`;
    if (pnl > -4) return `浮亏 -${abs}，更接近回踩接多`;
    return `浮亏 -${abs}，回踩较深，需看是否止损`;
  }
  if (pnl >= 0 && pnl < 1.5) return `浮盈 +${abs}，接近开仓区，跟空参考意义中等`;
  if (pnl >= 1.5) return `浮盈 +${abs}，空单已有利润，追空需谨慎`;
  if (pnl > -4) return `浮亏 -${abs}，空头被套，近期可能止损`;
  return `浮亏 -${abs}，空头深套，止损/回补压力上升`;
}

function priceCompareLines(books: CoinBook[], quotes: RecoQuotes, rows: RecoWhaleRow[]) {
  const lines: string[] = [];
  for (const book of books) {
    if (!book.count) continue;
    const spot = spotOf(book.coin, quotes, rows);
    const prefix = books.length > 1 ? `${book.coin} ` : '';
    if (book.longs.length && spot) {
      const entry = avgEntry(book.longs);
      const gap = gapPct(entry, spot);
      lines.push(
        `${prefix}加权平均开多价 ≈ ${formatPrice(entry)}，现价 ${formatPrice(spot)} → ${priceFollowHint('long', gap)}`,
      );
    } else if (book.longs.length) {
      lines.push(`${prefix}加权平均开多价 ≈ ${formatPrice(avgEntry(book.longs))}，暂无现价`);
    }
    if (book.shorts.length && spot) {
      const entry = avgEntry(book.shorts);
      const gap = gapPct(entry, spot);
      lines.push(
        `${prefix}加权平均开空价 ≈ ${formatPrice(entry)}，现价 ${formatPrice(spot)} → ${priceFollowHint('short', gap)}`,
      );
    } else if (book.shorts.length) {
      lines.push(`${prefix}加权平均开空价 ≈ ${formatPrice(avgEntry(book.shorts))}，暂无现价`);
    }
  }
  if (!lines.length) lines.push('当前筛选下无有效加权仓位，暂无价格对比');
  return lines;
}

function newsNoteLine(lean: ReturnType<typeof newsLean>, newsScore: number) {
  const remain = lean.hits.length;
  if (!remain) {
    return `剔除${lean.skipped}条无关信息，剩余0条核心新闻 → ${signed(newsScore)}`;
  }
  if (lean.bull > 0 && lean.bear === 0) {
    return `剔除${lean.skipped}条无关信息，剩余${remain}条均为偏多 → ${signed(newsScore)}`;
  }
  if (lean.bear > 0 && lean.bull === 0) {
    return `剔除${lean.skipped}条无关信息，剩余${remain}条均为偏空 → ${signed(newsScore)}`;
  }
  return `剔除${lean.skipped}条无关信息，剩余偏多${lean.bull} / 偏空${lean.bear} → ${signed(newsScore)}`;
}

function macroNoteLine(event: RecoEventRow | null, eventScore: number) {
  if (!event) return '近日无明确方向的宏观事件，本项不计分 → 0';
  return `${event.reason} → ${signed(eventScore)}`;
}

function buildConclusionNotes(input: {
  longUsd: number;
  shortUsd: number;
  longPct: number;
  shortPct: number;
  longCount: number;
  shortCount: number;
  whaleScore: number;
  newsScore: number;
  eventScore: number;
  score: number;
  lean: ReturnType<typeof newsLean>;
  event: RecoEventRow | null;
  books: CoinBook[];
  quotes: RecoQuotes;
  rows: RecoWhaleRow[];
  strength: RecoSignalStrength;
  decay: boolean;
}): RecoNoteBlock[] {
  const {
    longUsd,
    shortUsd,
    longPct,
    shortPct,
    longCount,
    shortCount,
    whaleScore,
    newsScore,
    eventScore,
    score,
    lean,
    event,
    books,
    quotes,
    rows,
    strength,
    decay,
  } = input;
  const ratio = approxRatio(longUsd, shortUsd);
  const shareText =
    longUsd + shortUsd > 0
      ? longPct >= shortPct
        ? `多头占${longPct}%`
        : `空头占${shortPct}%`
      : '暂无仓位';

  return [
    {
      title: decay ? '仓位加权（时间衰减版）' : '仓位加权（等权）',
      lines: [
        decay
          ? '24h×1.0 / 3天×0.5 / 7天×0.2，超过 7 天不计'
          : '衰减已关闭，按名义本金等权计分',
        `加权多头 = ${formatUsd(longUsd)}（${longCount}笔，加权仓位净值）`,
        `加权空头 = ${formatUsd(shortUsd)}（${shortCount}笔，加权仓位净值）`,
        `多空比 = ${formatUsd(longUsd)} : ${formatUsd(shortUsd)} ≈ ${ratio}（${shareText}）`,
      ],
    },
    {
      title: '价格对比',
      lines: priceCompareLines(books, quotes, rows),
    },
    {
      title: '仓位得分',
      lines: [`${signed(whaleScore)}（${whaleScoreReason(whaleScore)}）`],
    },
    {
      title: '新闻筛选',
      lines: [newsNoteLine(lean, newsScore)],
    },
    {
      title: '宏观得分',
      lines: [macroNoteLine(event, eventScore)],
    },
    {
      title: '综合加权',
      lines: [
        `${signed(whaleScore)} + (${signed(newsScore)}) + ${signed(eventScore)} = ${signed(score)} → ${strength.label}（多 ${strength.long}% / 空 ${strength.short}%）`,
      ],
    },
  ];
}

export function buildRecommendation(
  whales: WhaleProfile[],
  articles: NewsArticle[],
  events: CalendarEvent[],
  quotes: RecoQuotes = {},
  options: RecoOptions = {},
): Recommendation {
  const now = Date.now();
  const decay = options.decay !== false;
  const list = scopeWhales(enabledWhales(whales), options.coin);
  const posRows = collectPositions(list, { sinceMs: options.sinceMs, now, decay });
  const btcBook = coinSides(posRows, 'BTC');
  const ethBook = coinSides(posRows, 'ETH');
  const books = options.coin
    ? [coinSides(posRows, options.coin)]
    : [btcBook, ethBook];
  const book = pickCoin(posRows);
  const lean = newsLean(articles, options.sinceMs);
  const event = nextScoredMacro(events);
  const extra = joinClauses([eventClause(event), newsClause(lean.score)]);

  const longUsd = posRows.filter((item) => item.side === 'long').reduce((sum, item) => sum + item.weightedUsd, 0);
  const shortUsd = posRows.filter((item) => item.side === 'short').reduce((sum, item) => sum + item.weightedUsd, 0);
  const notionalTotal = longUsd + shortUsd;
  const longPct = notionalTotal ? Math.round((longUsd / notionalTotal) * 100) : 0;
  const shortPct = notionalTotal ? 100 - longPct : 0;
  const longN = new Set(posRows.filter((item) => item.side === 'long').map((item) => item.id)).size;
  const shortN = new Set(posRows.filter((item) => item.side === 'short').map((item) => item.id)).size;
  const activeIds = new Set(posRows.map((item) => item.id));
  const neutralN = list.length - activeIds.size;

  const resolvedQuotes: RecoQuotes = {
    BTC: spotOf('BTC', quotes, posRows),
    ETH: spotOf('ETH', quotes, posRows),
  };
  const prices = books
    .map((item) => buildPriceRow(item, resolvedQuotes[item.coin as 'BTC' | 'ETH'] || 0))
    .filter(Boolean) as RecoPriceRow[];
  const overview = overviewLines(books.length ? books : [btcBook, ethBook]);
  const windowLabel: RecoWindow = options.window || (options.sinceMs ? '24h' : 'all');
  const longCount = posRows.filter((item) => item.side === 'long').length;
  const shortCount = posRows.filter((item) => item.side === 'short').length;

  const emptySources = {
    stats: {
      total: list.length,
      long: longN,
      short: shortN,
      neutral: Math.max(0, neutralN),
      longPct,
      shortPct,
      longUsd,
      shortUsd,
      ratio: `${formatUsd(longUsd)}:${formatUsd(shortUsd)}`,
    },
    coin: options.coin || book?.coin || 'BTC',
    whales: posRows,
    news: lean.hits,
    event,
    quotes: resolvedQuotes,
    prices,
    notes: [] as RecoNoteBlock[],
    window: windowLabel,
    decay,
  };

  let whaleScore = 0;
  if (notionalTotal > 0) {
    if (longPct >= 65) whaleScore = 2;
    else if (longPct >= 55) whaleScore = 1;
    else if (shortPct >= 65) whaleScore = -2;
    else if (shortPct >= 55) whaleScore = -1;
  }

  const eventScore = event?.score || 0;
  const newsScore = lean.score;
  // 综合分 = 仓位 + 新闻 + 宏观；价格对比仅说明，不入总分
  const score = whaleScore + newsScore + eventScore;

  if (notionalTotal <= 0) {
    const strength = buildStrength(score, 50, 50);
    emptySources.notes = buildConclusionNotes({
      longUsd,
      shortUsd,
      longPct: 50,
      shortPct: 50,
      longCount,
      shortCount,
      whaleScore: 0,
      newsScore,
      eventScore,
      score,
      lean,
      event,
      books,
      quotes: resolvedQuotes,
      rows: posRows,
      strength,
      decay,
    });
    return {
      bias: 'wait',
      action: actionOf('wait'),
      text: overview.map(linePlain).join(' '),
      lines: packLines(books, resolvedQuotes, joinClauses(['当前巨鲸暂无明显动向', extra]), '', '', 'wait'),
      overview,
      strength,
      sources: emptySources,
    };
  }

  let tentative: RecoBias = 'wait';
  if (score >= 1) tentative = 'long';
  else if (score <= -1) tentative = 'short';

  const chase =
    tentative === 'long'
      ? followScore('long', books, resolvedQuotes, posRows)
      : tentative === 'short'
        ? followScore('short', books, resolvedQuotes, posRows)
        : 0;

  let bias: RecoBias = tentative;
  // 价格仅作追单风险提示：极端追高/追空时降为观望
  if (tentative !== 'wait' && chase <= -2) bias = 'wait';

  const eliteSide = bias === 'long' ? 'long' : bias === 'short' ? 'short' : '';
  const eliteIds = eliteSide
    ? [
        ...new Set(
          posRows
            .filter((item) => item.side === eliteSide && (item.winRate || 0) >= 70)
            .map((item) => item.id),
        ),
      ]
    : [];
  const eliteBit = eliteIds.length >= 2 ? `其中 ${eliteIds.length} 头高胜率地址方向一致` : '';
  const priceOverride =
    tentative !== 'wait' && bias === 'wait'
      ? '开仓价与现价差距较大，不宜按原方向追单'
      : '';

  const strength = buildStrength(score, longPct, shortPct);
  emptySources.notes = buildConclusionNotes({
    longUsd,
    shortUsd,
    longPct,
    shortPct,
    longCount,
    shortCount,
    whaleScore,
    newsScore,
    eventScore,
    score,
    lean,
    event,
    books,
    quotes: resolvedQuotes,
    rows: posRows,
    strength,
    decay,
  });

  return {
    bias,
    action: actionOf(bias),
    text: overview.map(linePlain).join(' '),
    lines: packLines(books, resolvedQuotes, extra, eliteBit, priceOverride, bias),
    overview,
    strength,
    sources: emptySources,
  };
}
