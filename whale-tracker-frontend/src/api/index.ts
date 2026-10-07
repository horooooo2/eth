import axios, { type AxiosError } from 'axios';
import type { WhaleBootstrap } from '@/utils/whaleState';
import type {
  CalendarResponse,
  PagedTradesQuery,
  PagedTradesResponse,
  WhalePositionResponse,
} from '@/types';

export const http = axios.create({
  baseURL: '/api',
  timeout: 20000,
});

export type TradFiMarketSymbol = {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  name: string;
  category: string;
  assetType?: 'CRYPTO' | 'TRADFI';
  radarTier?: 'CORE' | 'VOLATILE';
  status: string;
};

export type RadarAvailableContract = TradFiMarketSymbol & {
  lastPrice: string | null;
  priceChangePercent: string | null;
  quoteVolume24h: string | null;
};

export type TradFiQuote = {
  symbol: string;
  lastPrice: string | null;
  priceChangePercent: string | null;
  quoteVolume24h?: string | null;
  closeTime: number | null;
  source: string;
  stale: boolean;
  changes?: Partial<Record<'5m' | '15m' | '1h', number | null>>;
  error?: string;
};

export async function fetchRadarCatalog(includeSymbols: string[] = []) {
  const { data } = await http.get<{ symbols: TradFiMarketSymbol[]; updatedAt: string; stale: boolean; source: string }>('/tradfi/radar/catalog', {
    params: includeSymbols.length ? { symbols: includeSymbols.join(',') } : undefined,
  });
  return data;
}

export async function fetchRadarAvailableContracts() {
  const { data } = await http.get<{ contracts: RadarAvailableContract[]; updatedAt: string; stale: boolean; source: string }>('/tradfi/radar/available');
  return data;
}

export async function fetchRadarQuotes(symbols: string[]) {
  const { data } = await http.get<{ quotes: TradFiQuote[]; invalidSymbols: string[]; updatedAt: string; source: string }>('/tradfi/radar/quotes', {
    params: { symbols: symbols.join(',') },
  });
  return data;
}

export async function fetchRadarMarket(interval: '24h' | '1h' | '15m' | '5m' = '24h') {
  const { data } = await http.get<{ quotes: TradFiQuote[]; updatedAt: string; stale: boolean; source: string }>('/tradfi/radar/market', { params: { interval } });
  return data;
}

export async function fetchRadarMarketCap(symbol: string) {
  const { data } = await http.get<{ symbol: string; marketCapUsd: string | null; source: string | null; updatedAt: string | null; stale?: boolean }>('/tradfi/radar/market-cap', { params: { symbol } });
  return data;
}

export type RadarNewsItem = { title: string; category: string; publishedAt: string | null; source: string; url: string; summary: string };
export async function fetchRadarNews(symbol: string) {
  const { data } = await http.get<{ symbol: string; items: RadarNewsItem[]; source: string; updatedAt: string; stale?: boolean; error?: string }>('/tradfi/radar/news', { params: { symbol } });
  return data;
}

export type RadarKline = { openTime: number; open: number; high: number; low: number; close: number; volume: number; closeTime: number };
export async function fetchRadarKlines(symbol: string, interval: '5m' | '15m' | '1h') {
  const { data } = await http.get<{ symbol: string; interval: string; available: boolean; stale: boolean; bars: RadarKline[]; error?: string }>('/tradfi/radar/klines', { params: { symbol, interval } });
  return data;
}

http.interceptors.request.use((config) => {
  try {
    const token = localStorage.getItem('whale-tracker-auth-token');
    if (token) {
      config.headers = config.headers || {};
      config.headers.Authorization = `Bearer ${token}`;
    }
  } catch {
    // ignore
  }
  return config;
});

http.interceptors.response.use(
  (response) => response,
  (error: AxiosError<{ error?: string; code?: string; message?: string; details?: unknown }>) => {
    const code = error.code || '';
    const status = error.response?.status;
    const data = error.response?.data;
    const raw =
      (typeof data?.error === 'string' ? data.error : undefined) ||
      data?.message ||
      error.message ||
      '请求失败';
    if (
      code === 'ECONNABORTED' ||
      code === 'ETIMEDOUT' ||
      /timeout|timed out/i.test(raw)
    ) {
      return Promise.reject(new Error('TIMEOUT'));
    }
    if (status === 504 || status === 502 || status === 503) {
      const gatewayError = new Error(`GATEWAY_${status}`) as Error & { details?: unknown };
      gatewayError.details = data;
      return Promise.reject(gatewayError);
    }
    const message =
      status === 429 || /429|过于频繁/.test(raw) ? '查询过于频繁，请稍后再试' : raw;
    const enriched = new Error(message) as Error & { code?: string; details?: unknown };
    enriched.code = data?.code || (typeof data?.details === 'object' && data?.details
      ? (data.details as { code?: string }).code
      : undefined);
    enriched.details = data;
    return Promise.reject(enriched);
  },
);

export function isTimeoutError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err || '');
  return msg === 'TIMEOUT' || /timeout|timed out|ECONNABORTED|ETIMEDOUT/i.test(msg);
}

const silentRetryTimers = new Map<string, number>();

export function scheduleSilentRetry(key: string, run: () => void, delayMs = 4000) {
  if (typeof window === 'undefined') return;
  if (silentRetryTimers.has(key)) return;
  const timer = window.setTimeout(() => {
    silentRetryTimers.delete(key);
    run();
  }, delayMs);
  silentRetryTimers.set(key, timer);
}

export async function fetchWhaleBootstrap() {
  const { data } = await http.get<WhaleBootstrap>('/whales/bootstrap', { timeout: 20000 });
  return data;
}

export type AlertHistoryQuery = {
  page?: number;
  limit?: number;
  whaleId?: string;
  kind?: 'all' | 'open' | 'increase';
  coin?: string;
  /** 多币种（「全部」= 偏好币种列表），逗号分隔或数组 */
  coins?: string | string[];
  side?: 'all' | 'long' | 'short';
  minUsd?: number;
  sinceMs?: number;
  excludeExotic?: boolean;
};

/** 异动服务端分页 */
export async function fetchPagedAlertHistory(query: AlertHistoryQuery = {}) {
  const coinsParam = Array.isArray(query.coins)
    ? query.coins.filter(Boolean).join(',')
    : String(query.coins || '').trim();
  const { data } = await http.get<{
    alerts: unknown[];
    total: number;
    page: number;
    limit: number;
    retentionDays?: number;
    epoch: string;
    seq: number;
    facets?: {
      all: number;
      byCoin: Record<string, number>;
      long: number;
      short: number;
    };
  }>('/whales/alert-history', {
    params: {
      paged: 1,
      page: query.page ?? 1,
      limit: query.limit ?? 50,
      whaleId: query.whaleId || undefined,
      kind: query.kind && query.kind !== 'all' ? query.kind : undefined,
      coin: query.coin && query.coin !== 'all' ? query.coin : undefined,
      coins: coinsParam || undefined,
      side: query.side && query.side !== 'all' ? query.side : undefined,
      minUsd: query.minUsd || undefined,
      sinceMs: query.sinceMs || undefined,
      excludeExotic: query.excludeExotic ? 1 : undefined,
    },
    timeout: 20000,
  });
  return data;
}

/** 服务端异动资金聚合，避免从浏览器本地历史推导实时横幅。 */
export async function fetchAlertFlowSummary(query: { window: '15m' | '1h' | '4h' | '24h'; coin?: string }) {
  const { data } = await http.get<{
    longUsd: number; shortUsd: number; netUsd: number; events: number; whales: number;
    sinceMs: number; untilMs: number;
  }>('/whales/alert-history/summary', { params: query, timeout: 15000 });
  return data;
}

export type DirectionRow = {
  coin: string; whaleId?: string; addLong: number; addShort: number; reduceLong: number; reduceShort: number;
  net: number; lastAt: number; legs: number; longAccounts: number; shortAccounts: number; concentration: number | null;
};
export type DirectionSummary = { coins: DirectionRow[]; accounts: DirectionRow[]; sinceMs: number; untilMs: number; asOf: number };
const pendingStatistics = new Map<string, Promise<unknown>>();
function shareStatistics<T>(key: string, request: () => Promise<T>): Promise<T> {
  const pending = pendingStatistics.get(key);
  if (pending) return pending as Promise<T>;
  const task = Promise.resolve().then(request).finally(() => pendingStatistics.delete(key));
  pendingStatistics.set(key, task);
  return task;
}

export async function fetchDirectionSummary(window: string) {
  return shareStatistics('direction:' + window, async () =>
    (await http.get<DirectionSummary>('/whales/direction-summary', { params: { window }, timeout: 15000 })).data);
}

export type WhaleServerSummary = {
  freshness?: { total: number; freshCount: number; staleCount: number; unknownCount: number; oldestObservedAt: number | null; newestObservedAt: number | null; maxAgeMs: number };
  alertTotal: number;
  total: number; knownCount: number; longUsd: number; shortUsd: number;
  longPnlUsd: number; shortPnlUsd: number; longPnlPct: number | null; shortPnlPct: number | null;
  longPct: number; shortPct: number; longAddrPct: number; shortAddrPct: number;
  longCount: number; shortCount: number; neutralCount: number; deviationPct: number;
  hint: string; scopeLabel: string; positionCount: number; updatedAt: number; stale: boolean;
};

export async function fetchWhaleResonance(windowHours: number, coins: string[]) {
  return shareStatistics(JSON.stringify(['resonance', windowHours, [...coins].sort()]), async () => {
  const { data } = await http.get<import('@/utils/whaleResonanceSignal').ResonanceScanResult>('/whales/resonance', {
    params: { windowHours, coins: coins.join(',') }, timeout: 20000,
  });
  return data;
  });
}

function tradeQueryParams(query: PagedTradesQuery = {}) {
  return {
    page: query.page,
    limit: query.limit,
    asset: query.asset || undefined,
    flow: query.flow && query.flow !== 'all' ? query.flow : undefined,
    sinceMs: query.sinceMs || undefined,
    refresh: query.refresh ? 1 : undefined,
  };
}

export async function fetchWhaleTrades(id: string, query: PagedTradesQuery = {}) {
  const { data } = await http.get<PagedTradesResponse>(
    `/whales/${encodeURIComponent(id)}/trades`,
    { params: tradeQueryParams(query) },
  );
  return data;
}

export type WhaleTransfer = {
  id: string;
  time: number;
  hash?: string;
  type: string;
  typeLabel: string;
  direction: 'in' | 'out' | 'transfer';
  amountUsd: number;
  asset: string;
  peer?: string;
  whaleId: string;
  whaleName: string;
  address: string;
};

export async function fetchWhaleTransfers(
  id: string,
  query: { days?: number; limit?: number } = {},
) {
  const { data } = await http.get<{
    whale: { id: string; name: string; address: string };
    transfers: WhaleTransfer[];
    days: number;
    updatedAt: number;
  }>(`/whales/${encodeURIComponent(id)}/transfers`, {
    params: {
      days: query.days ?? 30,
      limit: query.limit ?? 100,
    },
    timeout: 45000,
  });
  return data;
}

export async function fetchWhalePerpMarkPrices(id: string) {
  const { data } = await http.get<{
    perpMarkPrices: Record<string, number | null>;
    updatedAt: number;
    source: string;
  }>(`/whales/${encodeURIComponent(id)}/market-prices`, { timeout: 45000 });
  return data;
}

export type WhaleEquityHistoryRange = '24h' | '7d' | '30d' | 'all';
export type WhaleEquityHistoryPoint = { time: number; contractEquity: number };

export async function fetchWhaleEquityHistory(id: string, range: WhaleEquityHistoryRange = 'all') {
  const { data } = await http.get<{
    points: WhaleEquityHistoryPoint[];
    range: WhaleEquityHistoryRange;
    updatedAt: number;
    source: string;
  }>(`/whales/${encodeURIComponent(id)}/equity-history`, { params: { range } });
  return data;
}

export type WhaleOpenOrder = {
  id: string;
  coin: string;
  coinLabel: string;
  side: string;
  size: number | null;
  price: number | null;
  notionalUsd: number | null;
  orderType: string;
  reduceOnly: boolean;
  triggerCondition?: string | null;
  timestamp: number | null;
};

export async function fetchWhaleOpenOrders(id: string) {
  const { data } = await http.get<{
    whale: { id: string; name: string; address: string };
    orders: WhaleOpenOrder[];
    updatedAt: number;
    source: string;
  }>(`/whales/${encodeURIComponent(id)}/orders`, { timeout: 45000 });
  return data;
}

export async function fetchWhalePosition(
  id: string,
  coin: string,
  side?: 'long' | 'short' | '',
  options: { cacheOnly?: boolean; signal?: AbortSignal } = {},
) {
  const { data } = await http.get<WhalePositionResponse>(
    `/whales/${encodeURIComponent(id)}/positions/${encodeURIComponent(coin)}`,
    { params: { side: side || undefined, view: options.cacheOnly ? 'cached' : undefined }, signal: options.signal },
  );
  return data;
}

export async function fetchCalendar(refresh = false) {
  const { data } = await http.get<CalendarResponse>('/news/calendar', {
    params: refresh ? { refresh: 1 } : undefined,
  });
  return data;
}

export type QuotesResponse = Record<string, number> & {
  funding?: Record<string, number>;
  updatedAt?: number;
};

export async function fetchQuotes(coins: string[] = []) {
  const { data } = await http.get<QuotesResponse>('/markets/quotes', {
    params: {
      coins: coins.length ? coins.join(',') : undefined,
    },
    timeout: 12000,
  });
  return data;
}

export async function lookupMarketCoin(symbol: string) {
  const { data } = await http.get<{ ok: boolean; id: string; symbol: string; name: string; price: number }>(
    '/markets/lookup',
    {
      params: { symbol },
      timeout: 15000,
    },
  );
  return data;
}

export async function searchMarketCoins(query: string) {
  const { data } = await http.get<{ items: Array<{ id: string; symbol: string; name: string }> }>('/markets/search', {
    params: { q: query },
    timeout: 15000,
  });
  return data.items;
}

/* —— 登录 / 用户设置 —— */
export async function loginAuth(username: string, password: string) {
  const { data } = await http.post<{
    ok: boolean;
    token: string;
    expiresAt: number;
    user: { id: string; username: string; createdAt: number };
    settings?: Record<string, unknown>;
  }>('/auth/login', { username, password });
  return data;
}

export async function logoutAuth() {
  const { data } = await http.post<{ ok: boolean }>('/auth/logout');
  return data;
}

export async function fetchAuthMe() {
  const { data } = await http.get<{
    ok: boolean;
    user: { id: string; username: string; createdAt: number };
    expiresAt: number;
    settings: Record<string, unknown>;
    settingsUpdatedAt: number;
  }>('/auth/me');
  return data;
}

export async function saveAuthSettings(settings: Record<string, unknown>) {
  const { data } = await http.put<{
    ok: boolean;
    settings: Record<string, unknown>;
    updatedAt: number;
  }>('/auth/settings', { settings });
  return data;
}

export async function createAuthUser(username: string, password: string) {
  const { data } = await http.post<{
    ok: boolean;
    user: { id: string; username: string; createdAt: number };
  }>('/auth/users', { username, password });
  return data;
}

export async function listAuthUsers() {
  const { data } = await http.get<{
    users: Array<{ id: string; username: string; createdAt: number }>;
  }>('/auth/users');
  return data;
}

export type WhaleAiKeyStatus = {
  provider: string;
  configured: boolean;
  apiKeyHint: string;
  updatedAt: number;
  ready: boolean;
};

export async function fetchWhaleAiKeyStatus() {
  const { data } = await http.get<WhaleAiKeyStatus>('/whale-ai/key');
  return data;
}

export async function saveWhaleAiKey(apiKey: string) {
  const { data } = await http.put<
    { ok: boolean; verified?: boolean; warn?: string } & WhaleAiKeyStatus
  >('/whale-ai/key', { apiKey }, { timeout: 30_000 });
  return data;
}

export async function deleteWhaleAiKey() {
  const { data } = await http.delete<{ ok: boolean } & WhaleAiKeyStatus>('/whale-ai/key');
  return data;
}

export type AnalyzeStreamHandlers = {
  onStatus?: (payload: { stage?: string; message?: string }) => void;
  onDelta?: (text: string) => void;
  onDone?: (payload: {
    ok?: boolean;
    source?: string;
    analysis?: string;
    model?: string;
  }) => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
};

/** POST SSE 流式分析（新闻 / 宏观 / 巨鲸） */
export async function streamAnalyzeWithWhaleAi(
  body: {
    source: 'macro' | 'whale';
    title?: string;
    content?: string;
    meta?: Record<string, unknown> | string;
  },
  handlers: AnalyzeStreamHandlers = {},
) {
  const res = await fetch('/api/whale-ai/analyze-stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(authToken() ? { Authorization: `Bearer ${authToken()}` } : {}),
    },
    body: JSON.stringify(body),
    signal: handlers.signal,
  });

  if (!res.ok) {
    let msg = `流式分析失败 HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) msg = String(j.error);
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('浏览器不支持流式响应');

  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;

  const handleEvent = (event: string, rawData: string) => {
    let data: any = rawData;
    try {
      data = JSON.parse(rawData);
    } catch {
      /* keep string */
    }
    if (event === 'status') handlers.onStatus?.(data);
    else if (event === 'delta') handlers.onDelta?.(String(data?.text || ''));
    else if (event === 'done') {
      finished = true;
      handlers.onDone?.(data);
    } else if (event === 'error') {
      const msg = String(data?.error || '流式分析失败');
      handlers.onError?.(msg);
      throw new Error(msg);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split(/\n\n/);
      buffer = chunks.pop() || '';
      for (const chunk of chunks) {
        const parsed = parseSseChunk(chunk);
        if (!parsed) continue;
        handleEvent(parsed.event, parsed.data);
      }
    }
    if (buffer.trim()) {
      const parsed = parseSseChunk(buffer);
      if (parsed) handleEvent(parsed.event, parsed.data);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }

  if (!finished) {
    throw new Error('流式连接已结束，但未收到完整结果');
  }
}

export type MarketBriefStructured = {
  short_term?: {
    bias?: string;
    direction?: string;
    confidence?: string;
    reason?: string;
    summary?: string;
  };
  mid_long_term?: { bias?: string; direction?: string; reason?: string; summary?: string };
  technical?: { m5?: string; hourly?: string; daily?: string };
  derivatives?: { funding?: string; liquidations?: string; taker?: string; details?: string };
  whales?: { site?: string; external?: string; details?: string };
  news_analysis?: { sentiment?: string; details?: string };
  market_sentiment?: {
    long_short_ratio?: string;
    funding_rate?: string;
    liquidations?: string;
    details?: string;
  };
  event_reaction?: string;
  personal_stance?: {
    headline?: string;
    /** 开单依据维度，如 市场情绪 / 新闻内容 / 小时线走势 */
    basis?: string[];
    ultra_short?: {
      action?: string;
      execution?: string;
      trigger?: string;
      entry?: number | null;
      leverage?: number | null;
      stop?: number | null;
      take_profit?: number | null;
      note?: string;
    };
    short?: {
      action?: string;
      execution?: string;
      trigger?: string;
      entry_validation?: { technical?: string; sentiment?: string; news_macro?: string; positioning?: string; decision?: string };
      entry?: number | null;
      leverage?: number | null;
      stop?: number | null;
      take_profit?: number | null;
      note?: string;
    };
    mid_long?: {
      action?: string;
      execution?: string;
      trigger?: string;
      entry_validation?: { technical?: string; sentiment?: string; news_macro?: string; positioning?: string; decision?: string };
      entry?: number | null;
      leverage?: number | null;
      stop?: number | null;
      take_profit?: number | null;
      note?: string;
    };
  };
  key_evidence?: string[];
  risks_and_invalidation?: string[];
  direction_analysis?: {
    summary?: string;
    market_state?: { trend?: string; volatility?: string; structure?: string; phase?: string; observation?: string };
    horizons?: Record<string, {
      analysis?: string;
      bull_points?: string[];
      bear_points?: string[];
      focus?: string;
      direction?: string;
      score?: number | null;
      confidence?: number | null;
      coverage?: number | null;
    }>;
    timeframes?: Record<string, { status?: string; state?: string; analysis?: string; metrics?: string[] }>;
    module_analysis?: Record<string, { status?: string; summary?: string; facts?: string[]; limitation?: string }>;
    bull_evidence?: string[];
    bear_evidence?: string[];
    data_limitations?: string[];
  };
  disclaimer?: string;
};

export type MarketBriefResponse = {
  ok: boolean;
  coin: string;
  analysis: string;
  directionAssessment?: {
    version?: string;
    asOf?: number;
    regime?: string;
    note?: string;
    horizons?: Record<string, { score?: number; direction?: string; confidence?: number; coverage?: number; evidence?: Array<{ module?: string; score?: number; quality?: number; detail?: string }> }>;
    modules?: Record<string, { quality?: number; detail?: string }>;
  } | null;
  structured?: MarketBriefStructured | null;
  analysisResult?: MarketBriefStructured | null;
  analysisId?: string;
  contextSnapshotId?: string;
  version?: string;
  contextDiff?: { changed?: boolean; summary?: string; changes?: unknown[] } | null;
  capability?: unknown;
  contextText?: string;
  model?: string;
  usage?: unknown;
  parseMode?: string;
  contextSummary?: {
    price: number | null;
    change24hPct?: number | null;
    fundingPct: number | null;
    newsCount: number;
    webNewsCount?: number;
    newsMode?: string;
    macroCount: number;
    whaleLong: number;
    whaleShort: number;
    exchangeLongPct?: number | null;
    exchangeShortPct?: number | null;
    hasTech?: boolean;
    hasLiq?: boolean;
    liqTotalUsd?: number | null;
    alertCount: number;
    hasDefi: boolean;
    equityLike?: boolean;
    status?: Record<string, string> | null;
    hasExternalCrowd?: boolean;
    sources: string[];
    asOf: number;
    cached?: boolean;
    charts?: {
      m5?: { candles: { t: number; o: number; h: number; l: number; c: number }[]; levels?: { key: string; price: number; label: string }[] } | null;
      hour?: { candles: { t: number; o: number; h: number; l: number; c: number }[]; levels?: { key: string; price: number; label: string }[] } | null;
      day?: { candles: { t: number; o: number; h: number; l: number; c: number }[]; levels?: { key: string; price: number; label: string }[] } | null;
    } | null;
  };
};

export async function fetchMarketBriefAnalysis(analysisId: string) {
  const { data } = await http.get<MarketBriefResponse & { status?: string; error?: string }>(
    `/whale-ai/market-brief-analysis/${encodeURIComponent(analysisId)}`,
    { timeout: 20000 },
  );
  return data;
}

function authToken() {
  try {
    return localStorage.getItem('whale-tracker-auth-token') || '';
  } catch {
    return '';
  }
}

/** 解析 SSE 块（event + data） */
function parseSseChunk(chunk: string): { event: string; data: string } | null {
  const lines = chunk.split(/\r?\n/);
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  return { event, data: dataLines.join('\n') };
}

export type MarketBriefStreamHandlers = {
  onStatus?: (payload: {
    stage?: string;
    message?: string;
    analysisId?: string;
    contextSnapshotId?: string;
  }) => void;
  onMeta?: (payload: {
    coin: string;
    contextText?: string;
    contextSummary?: MarketBriefResponse['contextSummary'];
    directionAssessment?: MarketBriefResponse['directionAssessment'];
    equityLike?: boolean;
    analysisId?: string;
    contextSnapshotId?: string;
    version?: string;
    contextDiff?: MarketBriefResponse['contextDiff'];
  }) => void;
  onDelta?: (text: string) => void;
  onDone?: (payload: MarketBriefResponse) => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
  forceRefresh?: boolean;
  analysisId?: string;
};

/** POST SSE 流式诊币 */
export async function streamMarketBrief(
  coin: string,
  handlers: MarketBriefStreamHandlers & {
    forceRefresh?: boolean;
    forceTradeDecision?: boolean;
    analysisId?: string;
  } = {},
) {
  const res = await fetch('/api/whale-ai/market-brief-stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(authToken() ? { Authorization: `Bearer ${authToken()}` } : {}),
    },
    body: JSON.stringify({
      coin,
      forceRefresh: Boolean(handlers.forceRefresh),
      forceTradeDecision: Boolean(handlers.forceTradeDecision),
      analysisId: handlers.analysisId || undefined,
    }),
    signal: handlers.signal,
  });

  if (!res.ok) {
    let msg = `流式诊币失败 HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) msg = String(j.error);
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('浏览器不支持流式响应');

  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;

  const handleEvent = (event: string, rawData: string) => {
    let data: any = rawData;
    try {
      data = JSON.parse(rawData);
    } catch {
      /* keep string */
    }
    if (event === 'status') handlers.onStatus?.(data);
    else if (event === 'meta') handlers.onMeta?.(data);
    else if (event === 'delta') handlers.onDelta?.(String(data?.text || ''));
    else if (event === 'done') {
      finished = true;
      handlers.onDone?.(data as MarketBriefResponse);
    } else if (event === 'error') {
      const msg = String(data?.error || '流式诊币失败');
      handlers.onError?.(msg);
      throw new Error(msg);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split(/\n\n/);
      buffer = chunks.pop() || '';
      for (const chunk of chunks) {
        const parsed = parseSseChunk(chunk);
        if (!parsed) continue;
        handleEvent(parsed.event, parsed.data);
      }
    }
    if (buffer.trim()) {
      const parsed = parseSseChunk(buffer);
      if (parsed) handleEvent(parsed.event, parsed.data);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }

  if (!finished) {
    throw new Error('流式连接已结束，但未收到完整结果');
  }
}

export type MarketChatMessage = { role: 'user' | 'assistant'; content: string };

export type MarketChatStreamHandlers = {
  onStatus?: (payload: { stage?: string; message?: string }) => void;
  onDelta?: (text: string) => void;
  onDone?: (payload: { ok?: boolean; coin?: string; reply?: string; model?: string }) => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
};

/** POST SSE 流式诊币追问 */
export async function streamChatMarketBrief(
  body: {
    coin: string;
    message: string;
    analysis?: string;
    contextText?: string;
    messages?: MarketChatMessage[];
  },
  handlers: MarketChatStreamHandlers = {},
) {
  const res = await fetch('/api/whale-ai/market-chat-stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(authToken() ? { Authorization: `Bearer ${authToken()}` } : {}),
    },
    body: JSON.stringify(body),
    signal: handlers.signal,
  });

  if (!res.ok) {
    let msg = `流式对话失败 HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) msg = String(j.error);
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('浏览器不支持流式响应');

  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;

  const handleEvent = (event: string, rawData: string) => {
    let data: any = rawData;
    try {
      data = JSON.parse(rawData);
    } catch {
      /* keep string */
    }
    if (event === 'status') handlers.onStatus?.(data);
    else if (event === 'delta') handlers.onDelta?.(String(data?.text || ''));
    else if (event === 'done') {
      finished = true;
      handlers.onDone?.(data);
    } else if (event === 'error') {
      const msg = String(data?.error || '流式对话失败');
      handlers.onError?.(msg);
      throw new Error(msg);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split(/\n\n/);
      buffer = chunks.pop() || '';
      for (const chunk of chunks) {
        const parsed = parseSseChunk(chunk);
        if (!parsed) continue;
        handleEvent(parsed.event, parsed.data);
      }
    }
    if (buffer.trim()) {
      const parsed = parseSseChunk(buffer);
      if (parsed) handleEvent(parsed.event, parsed.data);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }

  if (!finished) {
    throw new Error('流式连接已结束，但未收到完整回复');
  }
}

export async function deleteAuthUser(id: string) {
  const { data } = await http.delete<{
    ok?: boolean;
    user?: { id: string; username: string };
    error?: string;
  }>(`/auth/users/${encodeURIComponent(id)}`);
  return data;
}

export async function updateAuthUserPassword(id: string, password: string) {
  const { data } = await http.put<{
    ok?: boolean;
    user?: { id: string; username: string };
    error?: string;
  }>(`/auth/users/${encodeURIComponent(id)}/password`, { password });
  return data;
}

export async function fetchDataBrowse(limit = 500) {
  const { data } = await http.get<Record<string, unknown>>('/data/browse', {
    params: { limit },
  });
  return data;
}

export async function fetchDataMonitor() {
  const { data } = await http.get<{
    socket?: Array<Record<string, unknown>>;
    requests?: Array<Record<string, unknown>>;
    errors?: Array<Record<string, unknown>>;
    limits?: Record<string, number>;
  }>('/data/monitor');
  return data;
}

export async function resetSiteData(rounds = 3) {
  const { data } = await http.post<Record<string, unknown>>(
    '/data/reset',
    {},
    { params: { rounds }, timeout: 120_000 },
  );
  return data;
}

export async function addManualWhale(address: string, name: string) {
  const { data } = await http.post<{
    ok?: boolean;
    whale?: { name?: string };
    error?: string;
  }>('/whales/manual', { address, name });
  return data;
}

export async function renameWhale(id: string, name: string) {
  const { data } = await http.patch<{
    ok?: boolean;
    whale?: { name?: string };
    error?: string;
  }>(`/whales/${encodeURIComponent(id)}/name`, { name });
  return data;
}

export async function fetchApiHealth() {
  const { data } = await http.get<Record<string, unknown>>('/health');
  return data;
}
