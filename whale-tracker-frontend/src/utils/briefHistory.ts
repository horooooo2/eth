import { ref } from 'vue';
import type { MarketBriefStructured, MarketChatMessage } from '@/api';

export const MARKET_BRIEF_HISTORY_KEY = 'whale-tracker-market-brief-history';
export const MAX_BRIEF_HISTORY = 30;
/** 历史诊币有效期：1 小时后点击需重新分析 */
export const BRIEF_HISTORY_TTL_MS = 60 * 60 * 1000;

export type MarketBriefHistoryItem = {
  id: string;
  coin: string;
  /** 诊币完成时间（用于 1h 过期） */
  at: number;
  /** 最近活动时间（诊币或聊天，用于排序） */
  updatedAt?: number;
  bias?: string;
  confidence?: string;
  analysis: string;
  structured?: MarketBriefStructured | null;
  summaryBits?: string[];
  analysisId?: string;
  contextSnapshotId?: string;
  version?: string;
  contextDiffSummary?: string;
  /** 与该次诊币关联的 AI 聊天 */
  messages?: MarketChatMessage[];
};

function mapMessages(raw: unknown): MarketChatMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: String(m.content || '').slice(0, 8000),
    }))
    .slice(-40);
}

function mapItem(x: any): MarketBriefHistoryItem | null {
  if (!x || typeof x !== 'object' || !x.coin || !x.analysis) return null;
  const at = Number(x.at) || Date.now();
  return {
    id: String(x.id || `${x.coin}-${at}`),
    coin: String(x.coin || '').toUpperCase(),
    at,
    updatedAt: Number(x.updatedAt) || at,
    bias: x.bias ? String(x.bias) : undefined,
    confidence: x.confidence ? String(x.confidence) : undefined,
    analysis: String(x.analysis || ''),
    structured: x.structured || null,
    summaryBits: Array.isArray(x.summaryBits) ? x.summaryBits.map(String) : [],
    analysisId: x.analysisId ? String(x.analysisId) : undefined,
    contextSnapshotId: x.contextSnapshotId ? String(x.contextSnapshotId) : undefined,
    version: x.version ? String(x.version) : undefined,
    contextDiffSummary: x.contextDiffSummary ? String(x.contextDiffSummary) : undefined,
    messages: mapMessages(x.messages),
  };
}

/** 同币种只留最新一条，多币种合并后按 updatedAt 降序 */
function mergeLatestByCoin(list: MarketBriefHistoryItem[]): MarketBriefHistoryItem[] {
  const byCoin = new Map<string, MarketBriefHistoryItem>();
  for (const item of list) {
    const coin = String(item.coin || '').toUpperCase();
    if (!coin) continue;
    const prev = byCoin.get(coin);
    const score = Number(item.updatedAt || item.at) || 0;
    const prevScore = prev ? Number(prev.updatedAt || prev.at) || 0 : -1;
    if (!prev || score >= prevScore) byCoin.set(coin, item);
  }
  return [...byCoin.values()]
    .sort((a, b) => (Number(b.updatedAt || b.at) || 0) - (Number(a.updatedAt || a.at) || 0))
    .slice(0, MAX_BRIEF_HISTORY);
}

function safeParse(raw: string | null): MarketBriefHistoryItem[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return mergeLatestByCoin(list.map(mapItem).filter(Boolean) as MarketBriefHistoryItem[]);
  } catch {
    return [];
  }
}

function readHistory(): MarketBriefHistoryItem[] {
  try {
    return safeParse(localStorage.getItem(MARKET_BRIEF_HISTORY_KEY));
  } catch {
    return [];
  }
}

function writeHistory(list: MarketBriefHistoryItem[]) {
  try {
    const merged = mergeLatestByCoin(list);
    localStorage.setItem(MARKET_BRIEF_HISTORY_KEY, JSON.stringify(merged));
  } catch {
    /* quota */
  }
}

export const briefHistoryState = ref<MarketBriefHistoryItem[]>(readHistory());

export function isBriefHistoryFresh(item: Pick<MarketBriefHistoryItem, 'at'>, now = Date.now()) {
  const at = Number(item?.at) || 0;
  if (!at) return false;
  return now - at < BRIEF_HISTORY_TTL_MS;
}

export function briefHistoryAgeMs(item: Pick<MarketBriefHistoryItem, 'at'>, now = Date.now()) {
  return Math.max(0, now - (Number(item?.at) || 0));
}

export function refreshBriefHistory() {
  briefHistoryState.value = readHistory();
}

export function pushBriefHistory(item: Omit<MarketBriefHistoryItem, 'id'> & { id?: string }) {
  const coin = String(item.coin || '').toUpperCase();
  if (!coin || !item.analysis) return;
  const now = item.at || Date.now();
  const next: MarketBriefHistoryItem = {
    id: item.id || `${coin}-${now}`,
    coin,
    at: now,
    updatedAt: item.updatedAt || now,
    bias: item.bias,
    confidence: item.confidence,
    analysis: item.analysis,
    structured: item.structured || null,
    summaryBits: item.summaryBits || [],
    analysisId: item.analysisId,
    contextSnapshotId: item.contextSnapshotId,
    version: item.version,
    contextDiffSummary: item.contextDiffSummary,
    messages: mapMessages(item.messages),
  };
  // 同币种替换为最新诊币；多币种合并
  const rest = briefHistoryState.value.filter((x) => x.coin !== next.coin);
  briefHistoryState.value = mergeLatestByCoin([next, ...rest]);
  writeHistory(briefHistoryState.value);
}

/** 更新某币种历史条目中的聊天（不刷新诊币过期时钟 at） */
export function updateBriefHistoryMessages(coinInput: string, messages: MarketChatMessage[]) {
  const coin = String(coinInput || '').toUpperCase();
  if (!coin) return;
  const idx = briefHistoryState.value.findIndex((x) => x.coin === coin);
  if (idx < 0) return;
  const cur = briefHistoryState.value[idx];
  const next: MarketBriefHistoryItem = {
    ...cur,
    messages: mapMessages(messages),
    updatedAt: Date.now(),
  };
  const rest = briefHistoryState.value.filter((_, i) => i !== idx);
  briefHistoryState.value = mergeLatestByCoin([next, ...rest]);
  writeHistory(briefHistoryState.value);
}

export function removeBriefHistory(id: string) {
  briefHistoryState.value = briefHistoryState.value.filter((x) => x.id !== id);
  writeHistory(briefHistoryState.value);
}

export function clearBriefHistory() {
  briefHistoryState.value = [];
  writeHistory([]);
}

export function formatBriefTime(at: number) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
