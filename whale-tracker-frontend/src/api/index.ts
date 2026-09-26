import axios, { type AxiosError } from 'axios';
import type {
  AppConfig,
  CalendarResponse,
  NewsDetailResponse,
  NewsResponse,
  PagedTradesQuery,
  PagedTradesResponse,
  WhalePositionResponse,
  WhaleProfile,
  WhaleResponse,
  WhaleTrade,
  MarketsResponse,
} from '@/types';

const http = axios.create({
  baseURL: '/api',
  timeout: 20000,
});

export type TradFiMarketSymbol = {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  name: string;
  category: string;
  status: string;
};

export type TradFiQuote = {
  symbol: string;
  lastPrice: string | null;
  priceChangePercent: string | null;
  closeTime: number | null;
  source: string;
  stale: boolean;
  error?: string;
};

export async function fetchTradFiCatalog() {
  const { data } = await http.get<{ symbols: TradFiMarketSymbol[]; updatedAt: string; stale: boolean; source: string }>('/tradfi/catalog');
  return data;
}

export async function fetchTradFiQuotes(symbols: string[]) {
  const { data } = await http.get<{ quotes: TradFiQuote[]; invalidSymbols: string[]; updatedAt: string; source: string }>('/tradfi/quotes', {
    params: { symbols: symbols.join(',') },
  });
  return data;
}

export type TradFiIntelResponse = {
  symbol: string;
  news: {
    items: Array<{ title: string; category: string; publishedAt: string | null; source: string; url: string; summary: string }>;
    source: string | null;
    updatedAt: string | null;
    stale: boolean;
    error?: string;
  };
  fundamentals: {
    rows: Array<{ label: string; value: string; asOf: string | null; sourceUrl: string | null }>;
    source: string | null;
    sourceUrl: string | null;
    asOf: string | null;
    note: string;
    status: string;
    updatedAt: string | null;
    stale: boolean;
    error?: string;
  };
  events: {
    items: Array<{ title: string; date: string; time: string | null; forecast: string | null; previous: string | null; actual: string | null; source: string }>;
    source: string | null;
    updatedAt: string | null;
    stale: boolean;
    error?: string;
  };
};

export async function fetchTradFiIntel(symbol: string) {
  const { data } = await http.get<TradFiIntelResponse>('/tradfi/intel', { params: { symbol } });
  return data;
}

export type TradFiWhaleRow = {
  id: string;
  type: '成交' | '持仓' | '挂单';
  address: string;
  name: string;
  dex: string;
  coin: string;
  time: number | null;
  direction: string;
  price: number | null;
  size: number | null;
  notionalUsd: number | null;
  unrealizedPnlUsd: number | null;
  leverage: number | null;
  source: string;
};

export type TradFiWhaleResponse = {
  symbol: string;
  selectedMarket: { dex: string; coin: string; dayNotionalVolume: number; markPrice: number | null } | null;
  markets: Array<{ dex: string; coin: string; dayNotionalVolume: number; markPrice: number | null }>;
  rows: TradFiWhaleRow[];
  fillCount: number;
  scannedAddresses: number;
  configuredAddresses: number;
  failedRequests: number;
  successfulRequests?: number;
  coverageNote: string;
  updatedAt: string;
  stale: boolean;
  binance: { accountRatio: number | null; positionRatio: number | null; asOf: number | null; period: string; source: string; unavailable: boolean };
};

export async function fetchTradFiWhales(symbol: string, dex = '', addresses: string[] = []) {
  const { data } = await http.get<TradFiWhaleResponse>('/tradfi/whales', {
    params: { symbol, dex: dex || undefined, addresses: addresses.length ? addresses.join(',') : undefined },
    timeout: 45_000,
  });
  return data;
}

export type TradFiAllWhaleResponse = Pick<TradFiWhaleResponse,
  'rows' | 'fillCount' | 'scannedAddresses' | 'configuredAddresses' | 'failedRequests' | 'successfulRequests' | 'coverageNote' | 'updatedAt' | 'stale'
> & { markets: number };

export async function fetchAllTradFiWhales() {
  const { data } = await http.get<TradFiAllWhaleResponse>('/tradfi/whales/all', { timeout: 45_000 });
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
      return Promise.reject(new Error(`GATEWAY_${status}`));
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

export function isRetryableLoadError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err || '');
  return (
    isTimeoutError(err) ||
    msg.startsWith('GATEWAY_') ||
    /status code 50[234]|504|502|503|Gateway Timeout/i.test(msg)
  );
}

export function retryableErrorText(err: unknown, fallback: string) {
  const msg = err instanceof Error ? err.message : String(err || fallback);
  if (msg.startsWith('GATEWAY_')) {
    const code = msg.replace('GATEWAY_', '');
    return `网关超时（${code}）`;
  }
  if (msg === 'TIMEOUT') return '请求超时';
  if (/status code 504/i.test(msg)) return '网关超时（504）';
  if (/status code 502/i.test(msg)) return '网关错误（502）';
  if (/status code 503/i.test(msg)) return '服务暂不可用（503）';
  return msg || fallback;
}

export function withRetrySuffix(message: string) {
  return message.includes('正在重新请求') ? message : `${message}（正在重新请求数据）`;
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

export async function fetchWhales(refresh = false) {
  const { data } = await http.get<WhaleResponse>('/whales', {
    params: refresh ? { refresh: 1 } : undefined,
    timeout: refresh ? 120000 : 20000,
  });
  return data;
}

/** 增量成交：只拉 since 之后的新记录 */
export async function fetchActivitySince(since: number) {
  const { data } = await http.get<{
    activity: WhaleTrade[];
    since: number;
    updatedAt: number;
  }>('/whales/activity', {
    params: { since },
    timeout: 60000,
  });
  return data;
}

export async function fetchWhalesBatch(query: {
  offset?: number;
  limit?: number;
  refresh?: boolean;
} = {}) {
  const { data } = await http.get<WhaleResponse>('/whales', {
    params: {
      batch: 1,
      offset: query.offset ?? 0,
      limit: query.limit ?? 1,
      refresh: query.refresh ? 1 : undefined,
    },
    timeout: 120000,
  });
  return data;
}

export async function refreshWhaleById(id: string) {
  const { data } = await http.post<{
    whale: WhaleProfile;
    trades?: WhaleTrade[];
    updatedAt?: number;
  }>(`/whales/${encodeURIComponent(id)}/refresh`, null, { timeout: 60000 });
  return data;
}

/** 补齐异动历史：高名义巨鲸近 7 天成交 + 开仓时间（异动完整性优先） */
export async function refreshAlertHistory(query: { maxWhales?: number } = {}) {
  const { data } = await http.post<{
    whales: WhaleProfile[];
    trades?: WhaleTrade[];
    activity?: WhaleTrade[];
    enriched?: number;
    tradeCount?: number;
    warning?: string | null;
    updatedAt?: number;
  }>('/whales/alert-history/refresh', null, {
    params: { maxWhales: query.maxWhales ?? 40 },
    timeout: 180000,
  });
  return data;
}

/** 从服务端 SQLite 恢复开/补仓异动（兼容旧：只传 limit） */
export async function fetchPersistedAlertHistory(limit = 500) {
  const { data } = await http.get<{
    alerts: unknown[];
    total: number;
    retentionDays?: number;
  }>('/whales/alert-history', {
    params: { limit },
    timeout: 15000,
  });
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
    },
    timeout: 20000,
  });
  return data;
}

/** 把前端异动历史同步到服务端 SQLite */
export async function pushPersistedAlertHistory(alerts: unknown[]) {
  const { data } = await http.post<{ ok: boolean; saved: number }>(
    '/whales/alert-history',
    { alerts },
    { timeout: 20000 },
  );
  return data;
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

export async function fetchPagedTrades(query: PagedTradesQuery = {}) {
  const { data } = await http.get<PagedTradesResponse>('/whales/trades', {
    params: tradeQueryParams(query),
  });
  return data;
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

export async function fetchWhalePosition(
  id: string,
  coin: string,
  side?: 'long' | 'short' | '',
) {
  const { data } = await http.get<WhalePositionResponse>(
    `/whales/${encodeURIComponent(id)}/positions/${encodeURIComponent(coin)}`,
    { params: side ? { side } : undefined },
  );
  return data;
}

export async function fetchNews(refresh = false) {
  const { data } = await http.get<NewsResponse>('/news', {
    params: refresh ? { refresh: 1 } : undefined,
  });
  return data;
}

export async function fetchNewsDetail(id: string, url = '') {
  const { data } = await http.get<NewsDetailResponse>('/news/detail', {
    params: { id, url: url || undefined },
  });
  return data;
}

export async function fetchCalendar(refresh = false) {
  const { data } = await http.get<CalendarResponse>('/news/calendar', {
    params: refresh ? { refresh: 1 } : undefined,
  });
  return data;
}

export async function fetchWhaleAlertsFeed(query: { minUsd?: number; limit?: number } = {}) {
  const { data } = await http.get<{
    alerts: Array<{
      id: string;
      time: number;
      from: string;
      to: string;
      fromLabel?: string;
      toLabel?: string;
      flowDirection?: 'inflow' | 'outflow' | 'exchange' | 'transfer';
      exchangeName?: string;
      amountUsd: number;
      amount?: number;
      asset: string;
      blockchain: string;
      hash?: string;
    }>;
    source?: string | null;
    warning?: string | null;
    minUsd?: number;
    updatedAt?: number;
  }>('/markets/whale-alerts', {
    params: {
      minUsd: query.minUsd ?? 1_000_000,
      limit: query.limit ?? 80,
    },
    timeout: 15000,
  });
  return data;
}

export async function fetchMarkets(refresh = false, coins: string[] = []) {
  const { data } = await http.get<MarketsResponse>('/markets', {
    params: {
      refresh: refresh ? 1 : undefined,
      coins: coins.length ? coins.join(',') : undefined,
    },
    timeout: 90000,
  });
  return data;
}

/** DexPaprika 池子交易汇总的币种资金流 */
export type DexFlowCoinRow = {
  coin: string;
  buy: number;
  sell: number;
  net: number;
  changePct: number | null;
  price?: number | null;
  count?: number;
  network?: string;
  pool?: string;
  dex?: string;
  pair?: string;
  unsupported?: boolean;
  error?: string;
  period?: string;
  source?: string;
};

export type DexFlowCoinsResponse = {
  period: string;
  coins: DexFlowCoinRow[];
  updatedAt: number | null;
  accumulating?: boolean;
  errors?: Array<{ coin: string; error: string }>;
};

export async function fetchDexFlowCoins(period = '1h', coins: string[] = [], marketType: 'spot' | 'swap' = 'spot') {
  const { data } = await http.get<DexFlowCoinsResponse>('/flow/coins', {
    params: {
      period,
      coins: coins.length ? coins.join(',') : undefined,
      marketType,
    },
    timeout: 15000,
  });
  return data;
}

export type DefillamaOverview = {
  totalTvl: number;
  tvlChange1dPct: number | null;
  tvlAsOf: number | null;
  dexVolume24h: number;
  dexChange1dPct: number | null;
  stableMcap: number;
  preferredTvl?: number;
  preferredDexVolume24h?: number;
  preferredStableMcap?: number;
};

export type DefillamaProtocolRow = {
  name: string;
  slug: string;
  category: string;
  tvl: number;
  change1dPct: number | null;
  symbol: string | null;
};

export type DefillamaCoinRow = {
  coin: string;
  chain: string | null;
  unsupported?: boolean;
  chainTvl: number;
  tvlChange1dPct: number | null;
  dexVolume24h: number;
  dexChange1dPct: number | null;
  stableMcap: number;
  protocols: DefillamaProtocolRow[];
};

export type DefillamaMacroResponse = {
  ok: boolean;
  accumulating?: boolean;
  stale?: boolean;
  error?: string | null;
  overview: DefillamaOverview | null;
  coins: DefillamaCoinRow[];
  updatedAt: number | null;
  source?: string;
};

export async function fetchDefillamaMacro(coins: string[] = []) {
  const { data } = await http.get<DefillamaMacroResponse>('/flow/defillama', {
    params: {
      coins: coins.length ? coins.join(',') : undefined,
    },
    timeout: 25000,
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

export type LiquidationBucket = {
  hourAgo: number;
  from: number;
  to: number;
  longUsd: number;
  shortUsd: number;
  totalUsd: number;
  count: number;
};

export type LiquidationPeriod = {
  hours: number;
  label: string;
  longUsd: number;
  shortUsd: number;
  totalUsd: number;
  count: number;
};

export type LiquidationsResponse = {
  coin: string;
  hours: number;
  longUsd: number;
  shortUsd: number;
  totalUsd: number;
  count: number;
  source: string;
  buckets?: LiquidationBucket[];
  periods?: LiquidationPeriod[];
  updatedAt: number;
};

export async function fetchLiquidations(coin = 'BTC') {
  const { data } = await http.get<LiquidationsResponse>('/markets/liquidations', {
    params: { coin },
    timeout: 45000,
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

export async function fetchConfig() {
  const { data } = await http.get<AppConfig>('/whales/config');
  return data;
}

export async function saveConfig(payload: AppConfig) {
  const { data } = await http.post<AppConfig>('/whales/config', payload);
  return data;
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

export type XTweetUser = {
  id?: string;
  username: string;
  name: string;
  label?: string;
  description?: string;
  followers?: number;
  following?: number;
  tweets?: number;
  avatar?: string;
  verified?: boolean;
  url?: string | null;
};

export type XTweet = {
  id: string;
  text: string;
  textZh?: string;
  createdAt?: string | null;
  likes?: number;
  retweets?: number;
  replies?: number;
  views?: number;
  quotes?: number;
  isReply?: boolean;
  isQuote?: boolean;
  isRetweet?: boolean;
  lang?: string;
  url?: string | null;
  username?: string;
  label?: string;
  user?: XTweetUser;
  refKind?: 'quote' | 'retweet' | '';
  refTweet?: XTweet | null;
};

export type XFeedTweet = XTweet;

export type XTweetsResponse = {
  username: string;
  profile: XTweetUser | null;
  tweets: XTweet[];
  updatedAt?: number;
  refreshedAt?: number;
  stale?: boolean;
  source?: string;
  error?: string;
};

export type XFeedAccount = {
  username: string;
  label: string;
  name?: string;
  avatar?: string;
  url?: string;
};

export type XFeedResponse = {
  accounts: XFeedAccount[];
  tweets: XFeedTweet[];
  updatedAt?: number;
  refreshedAt?: number;
  stale?: boolean;
  source?: string;
  poll?: Record<string, unknown>;
  error?: string;
};

export async function fetchXTweets(opts?: {
  user?: string;
  limit?: number;
  refresh?: boolean;
}) {
  const { data } = await http.get<XTweetsResponse>('/x/tweets', {
    params: {
      user: opts?.user || 'cz_binance',
      limit: opts?.limit ?? 10,
      refresh: opts?.refresh ? 1 : undefined,
    },
    timeout: 90_000,
  });
  return data;
}

export async function fetchXFeed(opts?: {
  user?: string;
  limit?: number;
}) {
  const { data } = await http.get<XFeedResponse>('/x/feed', {
    params: {
      user: opts?.user || undefined,
      limit: opts?.limit ?? 40,
    },
    timeout: 30_000,
  });
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

export async function analyzeWithWhaleAi(body: {
  source: 'x' | 'macro' | 'whale';
  title?: string;
  content?: string;
  meta?: Record<string, unknown> | string;
}) {
  const { data } = await http.post<{
    ok: boolean;
    source: string;
    analysis: string;
    model?: string;
    usage?: unknown;
  }>('/whale-ai/analyze', body, { timeout: 100_000 });
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
    source: 'x' | 'macro' | 'whale';
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
  disclaimer?: string;
};

export type MarketBriefResponse = {
  ok: boolean;
  coin: string;
  analysis: string;
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

export async function fetchMarketBrief(coin: string) {
  const { data } = await http.post<MarketBriefResponse>(
    '/whale-ai/market-brief',
    { coin },
    { timeout: 130_000 },
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

export async function chatMarketBrief(body: {
  coin: string;
  message: string;
  analysis?: string;
  contextText?: string;
  messages?: MarketChatMessage[];
}) {
  const { data } = await http.post<{
    ok: boolean;
    coin: string;
    reply: string;
    model?: string;
    usage?: unknown;
  }>('/whale-ai/market-chat', body, { timeout: 100_000 });
  return data;
}

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

export type ConsoleXAccount = {
  username: string;
  label?: string;
  name?: string;
  enabled?: boolean;
};

export async function fetchXAccounts() {
  const { data } = await http.get<{
    accounts?: ConsoleXAccount[];
    poll?: Record<string, unknown>;
    updatedAt?: number;
  }>('/x/accounts');
  return data;
}

export async function fetchXStatus() {
  const { data } = await http.get<Record<string, unknown>>('/x/status');
  return data;
}

export async function addXWatchAccount(username: string, label: string) {
  const { data } = await http.post<{
    accounts?: ConsoleXAccount[];
    poll?: Record<string, unknown>;
    updatedAt?: number;
    error?: string;
  }>('/x/accounts', { username, label });
  return data;
}

export async function toggleXWatchAccount(username: string, enabled: boolean) {
  const { data } = await http.post<{
    accounts?: ConsoleXAccount[];
    poll?: Record<string, unknown>;
    error?: string;
  }>(`/x/accounts/${encodeURIComponent(username)}/toggle`, { enabled });
  return data;
}

export async function updateXWatchAccount(username: string, label: string) {
  const { data } = await http.put<{
    accounts?: ConsoleXAccount[];
    poll?: Record<string, unknown>;
    error?: string;
  }>(`/x/accounts/${encodeURIComponent(username)}`, { label });
  return data;
}

export async function deleteXWatchAccount(username: string) {
  const { data } = await http.delete<{
    accounts?: ConsoleXAccount[];
    poll?: Record<string, unknown>;
    error?: string;
  }>(`/x/accounts/${encodeURIComponent(username)}`);
  return data;
}

export async function refreshXWatchNow() {
  const { data } = await http.post<Record<string, unknown>>(
    '/x/refresh',
    {},
    { params: { force: 1 }, timeout: 90_000 },
  );
  return data;
}

export async function fetchApiHealth() {
  const { data } = await http.get<Record<string, unknown>>('/health');
  return data;
}

/* ===== 仓位建议单档刷新 ===== */
export async function refreshMarketBriefStance(body: {
  coin: string;
  horizon: 'ultra_short' | 'short' | 'mid_long';
  analysisId?: string;
  analysis?: string;
  contextText?: string;
  equityLike?: boolean;
}) {
  const { data } = await http.post<{
    ok: boolean;
    coin: string;
    horizon: string;
    leg: MarketBriefStructured['personal_stance'] extends infer P
      ? P extends { ultra_short?: infer L }
        ? L
        : never
      : never;
    analysisResult?: MarketBriefStructured | null;
    model?: string;
  }>('/whale-ai/market-brief-stance', body, { timeout: 90_000 });
  return data;
}

/* ===== OKX 密钥 / 下单 ===== */
export type OkxExchangeKeysDto = {
  okx: {
    exchange: 'okx';
    configured: boolean;
    enabled: boolean;
    simulated: boolean;
    apiKeyHint: string;
    hasSecret: boolean;
    hasPassphrase: boolean;
    updatedAt: number;
    ready: boolean;
    status?: string;
  };
  binance?: {
    exchange: 'binance'; configured: boolean; enabled: boolean; simulated: boolean;
    apiKeyHint: string; ready: boolean; status?: string;
  };
};

export async function fetchOkxKeys() {
  const { data } = await http.get<OkxExchangeKeysDto>('/okx/keys');
  return data;
}

export async function saveOkxKeys(body: {
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
  simulated?: boolean;
  enabled?: boolean;
  flagsOnly?: boolean;
}) {
  const { data } = await http.put<{ ok: boolean } & OkxExchangeKeysDto>('/okx/keys/okx', body);
  return data;
}

export async function deleteOkxKeys() {
  const { data } = await http.delete<{ ok: boolean } & OkxExchangeKeysDto>('/okx/keys/okx');
  return data;
}

export async function saveBinanceKeys(body: { apiKey?: string; apiSecret?: string; simulated?: boolean; enabled?: boolean; flagsOnly?: boolean }) {
  const { data } = await http.put<{ ok: boolean } & OkxExchangeKeysDto>('/okx/keys/binance', body);
  return data;
}

export async function deleteBinanceKeys() {
  const { data } = await http.delete<{ ok: boolean } & OkxExchangeKeysDto>('/okx/keys/binance');
  return data;
}

export type TradfiRangeEvent = { id: number; level: string; message: string; details: Record<string, unknown>; created_at: number };
export type TradfiLegStatus = { phase: string; additions: number; expectedQty: number; lastAddPrice: number; minPnl: number; recovery: boolean; recoveryArmed: boolean; recoveryPeakNetPnl: number; recoveryTrail: number; costs?: { entryFee: number; exitFee: number; fundingNet: number; estimatedCosts: number; profitTarget: number; closeTrigger: number; netPnl: number; recovery: boolean } | null };
export type TradfiRangeStatus = {
  symbol: string; enabled: boolean; status: string; simulated: boolean | null; additions: number; maxAdditions: number;
  longAdditions?: number; shortAdditions?: number; maxTotalAdditions?: number;
  marginPerOrder: number; leverage: number; comboPnl?: number | null; lastPrice?: number | null;
  netPnl?: number | null; closeTrigger?: number | null; addStep?: number | null;
  weekendMode?: boolean;
  startupProgress?: number | null; startupStep?: string;
  resumeEligible?: boolean;
  adoptedAt?: number | null; adoptedLongQty?: number; adoptedShortQty?: number;
  adoptionPositions?: { long: { quantity: number; entryPrice: number; leverage: number; unrealizedPnl: number }; short: { quantity: number; entryPrice: number; leverage: number; unrealizedPnl: number } } | null;
  recovery?: boolean; recoveryArmed?: boolean; recoveryPeakNetPnl?: number | null; recoveryTrail?: number | null;
  long?: TradfiLegStatus; short?: TradfiLegStatus;
  costs?: { entryFee?: number; exitFee?: number; slippage?: number; fundingNet?: number; estimatedCosts?: number; profitTarget?: number; closeTrigger?: number; netPnl?: number; long?: TradfiLegStatus['costs']; short?: TradfiLegStatus['costs'] } | null;
  range?: { low: number; high: number } | null; cooldownUntil?: number | null; cycleStartedAt?: number | null; lastError?: string; startedAt?: number | null; updatedAt?: number | null;
};
export type TradfiRangeResponse = { ok: boolean; strategy: TradfiRangeStatus; events: TradfiRangeEvent[] };
export async function fetchTradfiRangeStatus(symbol: string) {
  const { data } = await http.get<TradfiRangeResponse>('/tradfi/range/status', { params: { symbol }, timeout: 20_000 });
  return data;
}
export async function startTradfiRange(symbol: string) {
  const { data } = await http.post<TradfiRangeResponse>('/tradfi/range/start', { symbol }, { timeout: 20_000 });
  return data;
}
export async function startTradfiRangeWithConfig(symbol: string, body: { marginUsdt: number; leverage: number; adoptExisting?: boolean }) {
  const { data } = await http.post<TradfiRangeResponse>('/tradfi/range/start', { symbol, ...body }, { timeout: 20_000 });
  return data;
}
export async function stopTradfiRange(symbol: string) {
  const { data } = await http.post<TradfiRangeResponse>('/tradfi/range/stop', { symbol }, { timeout: 20_000 });
  return data;
}
export async function closeTradfiPositions() {
  const { data } = await http.post<{ ok: boolean; submitted: { orderId: string; symbol: string; positionSide: string; side: string; price: number; quantity: string }[] }>('/tradfi/close-all', {}, { timeout: 30_000 });
  return data;
}

export type OkxAiOrderRecord = {
  kind?: 'position' | 'pending';
  ordId: string;
  clOrdId: string;
  instId: string;
  coin: string;
  side: string;
  posSide: string;
  px: number | null;
  avgPx: number | null;
  sz: string;
  amountUsd: number | null;
  leverage: number | null;
  state: string;
  createdAt: number;
  simulated: boolean;
  source: 'ai' | 'okx' | 'binance';
  realizedPnl: number | null;
  openUpl: number | null;
};

export type OkxAiBook = {
  ok: boolean;
  configured?: boolean;
  simulated?: boolean;
  scope: 'ai-only' | 'all' | 'tradfi';
  balance: {
    totalEq: number | null;
    usdtEq: number | null;
    availBal: number | null;
  };
  openPnl: number;
  realizedPnl?: number | null;
  historyPnl: number | null;
  records: OkxAiOrderRecord[];
  trades?: BinanceAiTradeRecord[];
  strategies?: TradfiRangeStatus[];
  weekendMode?: boolean;
  costs?: { tradingFees: number; fundingFees: number; netCost: number };
  feesBySymbol?: Record<string, { tradingFees: number; fundingFees: number; netCost: number }>;
};

export type BinanceAiTradeRecord = {
  tradeId: string; orderId: string; instId: string; coin: string; side: string; posSide: string;
  action: 'open' | 'close'; source?: 'ai' | 'manual'; px: number | null; sz: string; amountUsd: number | null;
  realizedPnl: number; commission: number; commissionAsset: string; createdAt: number;
};

export async function fetchOkxAiBook() {
  const { data } = await http.get<OkxAiBook>('/okx/trade/ai-book', { timeout: 30_000 });
  return data;
}

export async function fetchTradfiAccountBook() {
  const { data } = await http.get<OkxAiBook>('/tradfi/account', { timeout: 30_000 });
  return data;
}

export type CryptoStanceOrderInput = {
  coin: string; action: string; entry: number; stop: number; takeProfit: number;
  leverage: number; amountUsd: number; execution: string; expectedPrice?: number;
  analysisId: string; horizon: 'short' | 'mid_long'; orderMode?: 'direct' | 'pending';
};

export type CryptoStancePreview = {
  ok: boolean;
  plan: { price?: string; entry?: number; last?: number; orderMode?: 'direct' | 'pending'; leverage: number; marginUsdt?: number; amountUsd?: number; estimatedLossUsdt?: number; stopPrice?: string; takePrice?: string; stop?: number; takeProfit?: number; notionalUsdt?: number; notional?: number };
};

export async function previewOkxStanceOrder(body: CryptoStanceOrderInput) {
  const { data } = await http.post<CryptoStancePreview>('/okx/trade/stance-preview', body, { timeout: 30_000 });
  return data;
}

export async function cancelOkxOrder(body: { instId: string; ordId?: string; clOrdId?: string }) {
  const { data } = await http.post<{ ok: boolean }>('/okx/trade/cancel', body);
  return data;
}

export async function fetchOkxTradeStatus() {
  const { data } = await http.get<{
    configured: boolean;
    simulated: boolean;
    base: string;
    source?: string;
  }>('/okx/trade/status');
  return data;
}

export async function placeOkxStanceOrder(body: CryptoStanceOrderInput) {
  const { data } = await http.post<{
    ok: boolean;
    order?: Record<string, unknown> | null;
    plan?: Record<string, unknown>;
    simulated?: boolean;
    error?: string;
  }>('/okx/trade/stance-order', body, { timeout: 90_000 });
  return data;
}

export type OkxStanceOrderStage = {
  id: string;
  status: 'running' | 'done' | string;
  progress?: number;
  message: string;
  last?: number;
  limitPx?: number;
  stop?: number;
  takeProfit?: number;
  orderId?: string | null;
  plan?: Record<string, unknown>;
};

export type OkxStanceOrderResult = {
  ok: boolean;
  order?: Record<string, unknown> | null;
  plan?: Record<string, unknown>;
  simulated?: boolean;
  error?: string;
};

/** SSE 挂单：取价 → 限价 Maker → 止损止盈 */
export async function streamOkxStanceOrder(
  body: CryptoStanceOrderInput,
  handlers: {
    onStage?: (stage: OkxStanceOrderStage) => void;
    onDone?: (data: OkxStanceOrderResult) => void;
    onError?: (message: string) => void;
  } = {},
  signal?: AbortSignal,
) {
  const res = await fetch('/api/okx/trade/stance-order-stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(authToken() ? { Authorization: `Bearer ${authToken()}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let msg = `挂单失败 HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  if (!res.body) throw new Error('浏览器不支持流式响应');

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let settled = false;

  const dispatchBlock = (block: string) => {
    const lines = block.split('\n');
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    let data: unknown;
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch {
      return;
    }
    if (event === 'stage') {
      handlers.onStage?.(data as OkxStanceOrderStage);
    } else if (event === 'done') {
      settled = true;
      handlers.onDone?.(data as OkxStanceOrderResult);
    } else if (event === 'error') {
      settled = true;
      const err = (data as { error?: string })?.error || '挂单失败';
      handlers.onError?.(err);
      throw new Error(err);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      if (part.trim()) dispatchBlock(part);
    }
  }
  if (buffer.trim()) dispatchBlock(buffer);
  if (!settled) throw new Error('挂单流意外结束');
}

