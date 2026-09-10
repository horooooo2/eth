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

export type WhaleAiRuntimeLog = {
  id?: number;
  ts: number;
  lvl: 'info' | 'success' | 'warn' | 'error' | string;
  msg: string;
  source?: string;
  channel?: 'SYSTEM' | 'POSITION' | string;
  event_type?: string;
  strategy_id?: string;
  symbol?: string;
  reason_code?: string;
};

export async function fetchWhaleAiRuntimeLogs(limit = 1000) {
  const { data } = await http.get<{
    ok: boolean;
    limit: number;
    count: number;
    logs: WhaleAiRuntimeLog[];
  }>('/whale-ai/runtime-logs', { params: { limit } });
  return data;
}

export type WhaleAiEngineEvent = {
  event_id: string;
  occurred_at: string;
  created_at?: string;
  event_type: string;
  severity?: string;
  strategy_id?: string;
  symbol?: string;
  direction?: string;
  decision?: string;
  reason_code?: string;
  reason_codes?: string[];
  source_closed_candle_timestamp?: string;
  trade_intent_id?: string;
  order_intent_id?: string;
  position_id?: string;
  signal_key?: string;
  message?: string;
  display_category?: 'POSITION' | 'SYSTEM';
  display_message?: string;
  symbol_display?: string;
  details?: Record<string, unknown>;
  source?: string;
};

export async function fetchWhaleAiEngineEvents(params?: {
  limit?: number;
  before?: string;
  after?: string;
  before_event_id?: string;
  after_event_id?: string;
  strategy_id?: string;
  symbol?: string;
  event_type?: string;
  severity?: string;
}) {
  const { data } = await http.get<{
    ok: boolean;
    source?: string;
    count: number;
    limit: number;
    events: WhaleAiEngineEvent[];
    python_error?: string;
  }>('/whale-ai/engine/events', { params });
  return data;
}

export async function appendWhaleAiRuntimeLog(body: {
  lvl: string;
  msg: string;
  source?: string;
  ts?: number;
  channel?: 'SYSTEM' | 'POSITION' | string;
  event_type?: string;
  strategy_id?: string;
  symbol?: string;
  reason_code?: string;
}) {
  const { data } = await http.post<{ ok: boolean; log: WhaleAiRuntimeLog }>(
    '/whale-ai/runtime-logs',
    body,
  );
  return data;
}

export async function analyzeWithWhaleAi(body: {
  source: 'x' | 'macro';
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

/* ===== 鲸鱼AI · OKX 交易 ===== */

export type WhaleAiTradeStatus = {
  ready: boolean;
  exchange: string;
  configured: boolean;
  simulated: boolean;
  apiKeyHint: string;
  updatedAt: number;
  status: string;
  trade?: {
    configured?: boolean;
    simulated?: boolean;
    keyHint?: string;
    source?: string;
    base?: string;
  } | null;
};

export type WhaleAiExchangeKeys = {
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
    status: string;
  };
  binance: {
    exchange: 'binance';
    configured: boolean;
    enabled: boolean;
    simulated: boolean;
    apiKeyHint: string;
    hasSecret: boolean;
    hasPassphrase: boolean;
    updatedAt: number;
    ready: boolean;
    status: string;
  };
};

export async function fetchWhaleAiTradeStatus() {
  const { data } = await http.get<WhaleAiTradeStatus>('/whale-ai/trade/status');
  return data;
}

export async function saveWhaleAiTradeKeys(body: {
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
  simulated?: boolean;
  enabled?: boolean;
}) {
  const { data } = await http.put<
    { ok: boolean; verified?: boolean; warn?: string; trade?: WhaleAiTradeStatus } & WhaleAiExchangeKeys
  >('/whale-ai/trade/keys', { exchange: 'okx', ...body }, { timeout: 90_000 });
  return data;
}

export async function deleteWhaleAiTradeKeys() {
  const { data } = await http.delete<
    { ok: boolean; trade?: WhaleAiTradeStatus } & WhaleAiExchangeKeys
  >('/whale-ai/trade/keys', { params: { exchange: 'okx' } });
  return data;
}

export async function fetchWhaleAiTradeBalance(ccy = '') {
  const { data } = await http.get<
    WhaleAiTradeStatus & {
      balance: {
        totalEq: number | null;
        details: Array<{ ccy: string; eq: number; availBal: number; frozenBal: number }>;
      };
    }
  >('/whale-ai/trade/balance', {
    params: ccy ? { ccy } : undefined,
    timeout: 60_000,
  });
  return data;
}

export async function fetchWhaleAiTradePositions(instType = 'SWAP') {
  const { data } = await http.get<WhaleAiTradeStatus & { positions: Record<string, unknown>[] }>(
    '/whale-ai/trade/positions',
    { params: { instType }, timeout: 60_000 },
  );
  return data;
}

export async function fetchWhaleAiTradeOrdersPending(instType = 'SWAP') {
  const { data } = await http.get<WhaleAiTradeStatus & { orders: Record<string, unknown>[] }>(
    '/whale-ai/trade/orders-pending',
    { params: { instType }, timeout: 60_000 },
  );
  return data;
}

export async function placeWhaleAiTradeOrder(body: {
  instId: string;
  side: 'buy' | 'sell';
  sz: string | number;
  ordType?: string;
  tdMode?: string;
  posSide?: 'long' | 'short' | '';
  px?: string | number;
  lever?: number;
  setLeverage?: boolean | string | number;
  reduceOnly?: boolean;
  clOrdId?: string;
  tag?: string;
}) {
  const { data } = await http.post<{
    ok: boolean;
    order: Record<string, unknown> | null;
    error?: string;
  } & WhaleAiTradeStatus>('/whale-ai/trade/order', body, { timeout: 90_000 });
  return data;
}

export async function closeWhaleAiTradePosition(body: {
  instId: string;
  side?: 'buy' | 'sell';
  posSide?: 'long' | 'short' | '';
  sz?: string | number;
  tdMode?: string;
}) {
  const { data } = await http.post<{
    ok: boolean;
    order: Record<string, unknown> | null;
    error?: string;
  } & WhaleAiTradeStatus>('/whale-ai/trade/close', body, { timeout: 90_000 });
  return data;
}

export async function cancelWhaleAiTradeOrder(body: {
  instId: string;
  ordId?: string;
  clOrdId?: string;
}) {
  const { data } = await http.post<{ ok: boolean; result: Record<string, unknown> | null } & WhaleAiTradeStatus>(
    '/whale-ai/trade/cancel',
    body,
    { timeout: 60_000 },
  );
  return data;
}

/* ===== 鲸鱼AI · V4.1 Engine ===== */

export type V41Regime = {
  regime: 'strong_trend' | 'weak_trend' | 'range' | 'panic' | 'recovery' | string;
  direction_bias: number;
  confidence: number;
  risk_multiplier: number;
  trend_strength: number;
  breadth_24h: number;
  rv5m_ratio_30d: number;
  updated_at: string;
};

export type V41RiskBudget = {
  portfolio: {
    global_risk_limit: number;
    effective_risk_budget: number;
    risk_used: number;
    reserve_fraction: number;
    raw_sum: number;
    scale: number;
  };
  strategies: Record<
    string,
    {
      raw_share: number;
      final_share: number;
      risk_budget: number;
      risk_used: number;
      risk_cap?: number;
    }
  >;
  updated_at: string;
};

export type V41Safety = {
  level: number;
  status: string;
  reason: string | null;
  exchange_connected: boolean;
  market_data_latency_ms: number | null;
  sequence_valid: boolean;
  positions_reconciled: boolean;
  orders_reconciled: boolean;
  risk_engine_healthy: boolean;
  new_entries_enabled: boolean;
  active_incident_id: string | null;
  recovery: Record<string, unknown> | null;
  updated_at: string;
};

export type V41StrategyHealth = {
  strategy_id: string;
  name: string;
  health_score: number | null;
  state: string;
  sample_count: number;
  expectancy_R: number | null;
  updated_at: string;
};

export type V41TradeIntent = {
  intent_id: string;
  strategy_id: string;
  symbol: string;
  direction: string;
  status: string;
  created_at: string;
  expires_at: string;
  signal_age_seconds: number;
  ttl_seconds: number;
  reference_price: number;
  current_price: number;
  price_drift_bps: number;
  max_price_drift_bps: number;
  expected_edge_R: number | null;
  s3_regime: string;
  s3_direction_bias: number;
  s4_status: string;
};

export type V41Incident = {
  incident_id: string;
  type: string;
  severity: string;
  triggered_at: string;
  resolved_at: string | null;
  reason: string;
  recovery_state: string;
  manual_ack_required: boolean;
};

export type V41PersonalView = {
  engine: {
    available: boolean;
    state: string;
    alpha_execution?: 'SHADOW' | 'EXECUTE' | string;
    version: string;
    updated_at: string;
    user_id_ready?: boolean;
  };
  active_strategy: {
    id: string;
    name: string;
    description?: string;
    runtime_state: string;
    health_score: number | null;
    health_state: string;
    risk_budget_pct_equity: number;
    strategy_risk_used_pct_equity?: number;
    strategy_risk_limit_pct_equity?: number;
    expectancy_R?: number | null;
  };
  market_risk: {
    regime: string;
    direction_bias: number;
    market_data_latency_ms?: number | null;
    exchange_connected: boolean;
    positions_reconciled: boolean;
    orders_reconciled: boolean;
    risk_engine_healthy: boolean;
    safety_level: number;
    safety_status: string;
    new_entries_enabled: boolean;
    portfolio_risk_used_pct_equity: number;
    portfolio_risk_limit_pct_equity: number;
  } | null;
  signals: V41TradeIntent[];
  recent_order_intents: unknown[];
  last_update: string;
  user_id_ready?: boolean;
  account_environment?: string | null;
  live_permission?: boolean;
};

export type V41StrategyDiagnostics = {
  strategy_id: string;
  active?: boolean;
  runtime_state?: string;
  alpha_opening_enabled?: boolean;
  last_tick_at?: string | null;
  last_evaluated_at?: string | null;
  evaluation_count?: number;
  last_raw_signal_at?: string | null;
  last_trade_intent_at?: string | null;
  last_order_intent_at?: string | null;
  raw_signal_count?: number;
  trade_intent_created_count?: number;
  trade_intent_expired_count?: number;
  S3_rejected_count?: number;
  S5_rejected_count?: number;
  S6_rejected_count?: number;
  S7_rejected_count?: number;
  edge_rejected_count?: number;
  S4_rejected_count?: number;
  cost_rejected_count?: number;
  order_intent_created_count?: number;
  executed_count?: number;
  last_decision?: string;
  last_reason_codes?: string[];
  market_data?: {
    source?: string;
    instrument?: string;
    timeframe?: string;
    latest_candle_at?: string | null;
    latest_closed_candle_at?: string | null;
    candle_age_seconds?: number | null;
    bars_loaded?: number;
    closed_bars?: number;
    candle_closed?: boolean;
    state?: string;
    forming?: boolean;
    error?: string;
  };
  indicators?: Record<string, number | null | undefined>;
  gates?: Record<string, unknown>;
  decision?: {
    direction_candidate?: string;
    result?: string;
    reason_codes?: string[];
  };
  pending_log_event?: {
    channel?: string;
    event_type?: string;
    strategy_id?: string;
    symbol?: string;
    direction?: string;
    decision?: string;
    reason_codes?: string[];
    reason_code?: string;
    ts?: string;
  } | null;
  engineAvailable?: boolean;
  bridge?: V41BridgeStatus;
};

export type V41EngineSnapshot = {
  engine: {
    version: string;
    mode: string;
    state: string;
    updated_at: string;
    started_at?: string | null;
    last_tick_at?: string | null;
    active_strategy?: string;
    engine_available?: boolean;
    alpha_opening_enabled?: boolean;
    console_mode?: string;
    alpha_execution?: 'SHADOW' | 'EXECUTE';
    last_evaluated_at?: string | null;
    evaluation_count?: number;
  };
  s3: V41Regime | null;
  s5: V41RiskBudget | null;
  s6: V41Safety | null;
  s7: V41StrategyHealth[];
  trade_intents: V41TradeIntent[];
  order_intents: unknown[];
  open_positions?: unknown[];
  execution: Record<string, unknown>;
  incidents: V41Incident[];
  edge?: unknown;
  view?: V41PersonalView;
  strategy_diagnostics?: V41StrategyDiagnostics | null;
  alpha_execution?: 'SHADOW' | 'EXECUTE';
  account_environment?: 'OKX_DEMO' | 'OKX_LIVE' | null;
  live_permission?: boolean;
  qa_backend?: 'EXCHANGE' | 'INTERNAL_SIMULATOR' | null;
  user_id_ready?: boolean;
  strategy?: { id?: string; live_allowed?: boolean };
};

export type V41BridgeStatus = {
  enabled: boolean;
  connected: boolean;
  engineUrl: string;
  lastSnapshotAt: number;
  lastError: string;
  latencyMs: number;
  freshness: string;
  transport_status?: string;
  engine_runtime_status?: string;
  strategy_runtime_status?: string;
  last_tick_at?: string | null;
  last_evaluated_at?: string | null;
  last_tick_age_ms?: number | null;
  last_eval_age_ms?: number | null;
  staleMs?: number;
  offlineMs?: number;
};

export async function fetchWhaleAiEngineHealth() {
  const { data } = await http.get<{
    ok: boolean;
    health: Record<string, unknown>;
    engineAvailable?: boolean;
    bridge?: V41BridgeStatus;
    code?: string;
    message?: string;
  }>('/whale-ai/engine/health', { timeout: 5000 });
  return data;
}

export async function fetchWhaleAiEngineDashboard() {
  const { data } = await http.get<{
    snapshot: V41EngineSnapshot | null;
    view?: V41PersonalView | null;
    engine?: V41PersonalView['engine'];
    active_strategy?: V41PersonalView['active_strategy'];
    market_risk?: V41PersonalView['market_risk'];
    signals?: V41TradeIntent[];
    recent_order_intents?: unknown[];
    last_update?: string;
    engineAvailable?: boolean;
    bridge?: V41BridgeStatus;
    ok?: boolean;
    code?: string;
    message?: string;
  }>('/whale-ai/engine/dashboard', { timeout: 8000 });
  return data;
}

export async function startWhaleAiEngine() {
  const { data } = await http.post('/whale-ai/engine/start', {}, { timeout: 20_000 });
  return data;
}

export async function pauseWhaleAiEngine() {
  const { data } = await http.post('/whale-ai/engine/pause', {}, { timeout: 20_000 });
  return data;
}

export async function killWhaleAiEngine(body?: { reason?: string }) {
  const { data } = await http.post<{
    ok: boolean;
    engine?: Record<string, unknown>;
    closed?: number;
    closeErrors?: string[];
  }>('/whale-ai/engine/kill', body || {}, { timeout: 120_000 });
  return data;
}

export async function resumeWhaleAiEngine(body: { reason: string; incident_id?: string }) {
  const { data } = await http.post('/whale-ai/engine/system/resume', body, { timeout: 8000 });
  return data;
}

export async function setWhaleAiActiveStrategy(strategyId: string) {
  const { data } = await http.post(
    '/whale-ai/engine/strategy/switch',
    { strategy_id: strategyId },
    { timeout: 8000 },
  );
  return data;
}

export async function fetchWhaleAiStrategies() {
  const { data } = await http.get<{
    active_strategy_id: string;
    strategies: Array<{
      id: string;
      name: string;
      description: string;
      available: boolean;
      health_score: number;
      health_state: string;
    }>;
  }>('/whale-ai/engine/strategies', { timeout: 8000 });
  return data;
}

export async function fetchWhaleAiStrategyDiagnostics(strategyId = 'S1') {
  const sid = encodeURIComponent(String(strategyId || 'S1').trim() || 'S1');
  const { data } = await http.get<V41StrategyDiagnostics>(
    `/whale-ai/engine/strategy/${sid}/diagnostics`,
    { timeout: 8000 },
  );
  return data;
}

export async function fetchWhaleAiActiveStrategy() {
  const { data } = await http.get<{
    strategy_id: string;
    name: string;
    runtime_state: string;
    health_state: string;
    health_score: number;
    risk_budget_pct_equity: number;
    changed_at?: string;
  }>('/whale-ai/engine/strategy/active', { timeout: 8000 });
  return data;
}

/** QA-HFT-SIM — only when V41_HFT_SIM_ENABLED on server */
export async function startV41HftSim(body: {
  cycles?: number;
  seed?: number;
  inject_failures?: boolean;
  symbol?: string;
  max_position_notional_usdt?: number;
  execution_mode?: 'simulator' | 'exchange';
  exchange_environment?: 'demo' | 'live' | null;
  continuous?: boolean;
}) {
  const { data } = await http.post('/whale-ai/engine/test/hft-sim/start', body, {
    timeout: body.continuous === false ? 600_000 : 60_000,
  });
  return data;
}

export async function fetchV41HftSimCapability() {
  const { data } = await http.get('/whale-ai/engine/test/hft-sim/capability', { timeout: 8000 });
  return data as {
    enabled?: boolean;
    hft_sim_enabled?: boolean;
    qa_exchange_enabled?: boolean;
    qa_live_enabled?: boolean;
    okx_ready?: boolean;
    account_mode?: 'OKX_DEMO' | 'OKX_LIVE' | null;
    exchange_environment?: 'demo' | 'live' | null;
    live_money?: boolean;
    simulator_available?: boolean;
    exchange_available?: boolean;
    max_position_notional_usdt?: number;
  };
}

export async function stopV41HftSim() {
  const { data } = await http.post('/whale-ai/engine/test/hft-sim/stop', {}, { timeout: 8000 });
  return data;
}

export async function fetchV41HftSimStatus() {
  const { data } = await http.get('/whale-ai/engine/test/hft-sim/status', { timeout: 8000 });
  return data as {
    enabled?: boolean;
    running?: boolean;
    cycle_id?: number;
    target_cycles?: number;
    state?: string;
    position_notional_usdt?: number;
    max_position_notional_usdt?: number;
    actual_leverage?: number;
    target_leverage?: number;
    passed?: boolean | null;
    metrics?: Record<string, number>;
    is_alpha?: boolean;
    execution_target?: string;
    real_exchange_allowed?: boolean;
    console_mode?: string;
    alpha_opening_enabled?: boolean;
    active_strategy_id?: string;
    env_resolved?: string | null;
  };
}

export async function fetchV41HftSimReport() {
  const { data } = await http.get('/whale-ai/engine/test/hft-sim/report', { timeout: 15000 });
  return data;
}

export async function fetchV41WhaleBridgeTelemetry() {
  const { data } = await http.get('/whale-ai/engine/whale-bridge/telemetry', { timeout: 8000 });
  return data;
}

export type ExecutionSelectionKind = 'alpha' | 'qa_test';

export type ExecutionSelection = {
  id: string;
  kind: ExecutionSelectionKind;
  name: string;
  available: boolean;
  disabled_reason?: string | null;
  description?: string;
  paper_only?: boolean;
  release_stage?: string;
  live_allowed?: boolean;
  qa_backend?: string;
  execution_target?: string;
  max_position_notional_usdt?: number;
};

export async function fetchExecutionSelections() {
  const { data } = await http.get<{
    active_strategy_id?: string;
    console_mode?: string;
    selected_execution_id?: string;
    alpha_opening_enabled?: boolean;
    items: ExecutionSelection[];
  }>('/whale-ai/engine/execution/selections', { timeout: 8000 });
  return data;
}

export async function selectExecution(body: {
  id: string;
  reason?: string;
  operator_id?: string;
}) {
  const { data } = await http.post('/whale-ai/engine/execution/select', body, { timeout: 15000 });
  return data;
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

export async function fetchAdminStrategyConfigs() {
  const { data } = await http.get<Record<string, unknown>>('/admin/strategy-configs');
  return data;
}

export async function fetchAdminStrategyConfig(id: string) {
  const { data } = await http.get<Record<string, unknown>>(
    `/admin/strategy-configs/${encodeURIComponent(id)}`,
  );
  return data;
}

