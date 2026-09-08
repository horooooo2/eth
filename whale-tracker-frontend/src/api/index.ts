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
  (error: AxiosError<{ error?: string }>) => {
    const code = error.code || '';
    const status = error.response?.status;
    const raw = error.response?.data?.error || error.message || '请求失败';
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
    return Promise.reject(new Error(message));
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

/* ===== OKX 跟单监控 ===== */

export type OkxTrader = {
  id: string;
  uniqueCode: string;
  name: string;
  avatar?: string;
  rank: number;
  pnl: number;
  pnlRatio: number;
  winRatio: number;
  aum: number;
  copyTraderNum: number;
  maxCopyTraderNum: number;
  isFull?: boolean;
  leadDays: number;
  ccy: string;
  instruments: string[];
  pnlRatios?: Array<{ beginTs: number; pnlRatio: number }>;
  maxDrawdown?: number;
  copyPnl?: number;
  openCount?: number;
  openMargin?: number;
  openUpl?: number;
  lastOpenAt?: number;
};

export type OkxOpenEvent = {
  id: string;
  at: number;
  traderId: string;
  traderName: string;
  kind: 'open' | 'close';
  status: 'open' | 'closed';
  coin: string;
  instId: string;
  side: 'long' | 'short';
  lever: number;
  margin: number;
  size: number;
  openAvgPx: number;
  closeAvgPx: number;
  markPx: number;
  liqPx?: number;
  mgnMode?: '' | 'cross' | 'isolated';
  /** 维持保证金率（ecotrade 多为百分数如 52.2；偶发小数） */
  mgnRatio?: number;
  pnl: number;
  pnlRatio: number;
  openTime: number | null;
  closeTime: number | null;
  subPosId: string;
};

export type OkxLeadRow = {
  key: string;
  label: string;
  value: string;
  tone: 'up' | 'down' | 'neutral' | 'warn';
};

export type OkxDashboardResponse = {
  traders: OkxTrader[];
  opens: OkxOpenEvent[];
  positions?: OkxOpenEvent[];
  positionsByTrader?: Record<string, OkxOpenEvent[]>;
  meta?: Record<string, unknown>;
  updatedAt?: number;
  stale?: boolean;
  error?: string;
};

export async function fetchOkxDashboard(refresh = false) {
  const { data } = await http.get<OkxDashboardResponse>('/okx', {
    params: refresh ? { refresh: 1 } : undefined,
    timeout: 120_000,
  });
  return data;
}

export async function fetchOkxOpens(traderId = '', limit = 120) {
  const { data } = await http.get<{
    opens: OkxOpenEvent[];
    total: number;
    traderId: string | null;
    updatedAt?: number;
    stale?: boolean;
  }>('/okx/opens', {
    params: {
      ...(traderId ? { traderId } : {}),
      limit,
    },
  });
  return data;
}

export async function fetchOkxTraderDetail(traderId: string, lastDays = '3') {
  const { data } = await http.get<{
    trader: OkxTrader;
    stats: Record<string, number | string> | null;
    weekly: Array<{ beginTs: number; pnl: number; pnlRatio: number }>;
    rows: OkxLeadRow[];
    positions: OkxOpenEvent[];
    opens: OkxOpenEvent[];
    updatedAt: number;
  }>(`/okx/traders/${encodeURIComponent(traderId)}/detail`, {
    params: { lastDays },
  });
  return data;
}

/* ===== OKX 交易（服务端代理，需登录） ===== */

export type OkxTradeStatus = {
  configured: boolean;
  simulated: boolean;
  base: string;
  hasProxy?: boolean;
};

export type OkxTradeBalanceDetail = {
  ccy: string;
  eq: number;
  availBal: number;
  frozenBal: number;
};

export type OkxPlaceOrderInput = {
  instId: string;
  side: 'buy' | 'sell';
  posSide?: 'long' | 'short' | '';
  tdMode?: 'cross' | 'isolated' | 'cash';
  ordType?: 'market' | 'limit' | 'ioc' | 'fok' | 'post_only';
  sz: string;
  px?: string;
  lever?: number | string;
  reduceOnly?: boolean;
  clOrdId?: string;
};

export async function fetchOkxTradeStatus() {
  const { data } = await http.get<OkxTradeStatus>('/okx/trade/status');
  return data;
}

export async function fetchOkxTradeBalance(ccy = '') {
  const { data } = await http.get<
    OkxTradeStatus & {
      balance: { totalEq: number | null; details: OkxTradeBalanceDetail[] };
    }
  >('/okx/trade/balance', {
    params: ccy ? { ccy } : undefined,
  });
  return data;
}

export async function fetchOkxTradePositions(instType = 'SWAP') {
  const { data } = await http.get<OkxTradeStatus & { positions: Record<string, unknown>[] }>(
    '/okx/trade/positions',
    { params: { instType } },
  );
  return data;
}

export async function placeOkxOrder(body: OkxPlaceOrderInput) {
  const { data } = await http.post<{
    ok: boolean;
    order: Record<string, unknown> | null;
    simulated?: boolean;
    error?: string;
  }>('/okx/trade/order', body, { timeout: 90_000 });
  return data;
}

export async function cancelOkxOrder(body: { instId: string; ordId?: string; clOrdId?: string }) {
  const { data } = await http.post<{ ok: boolean; result: Record<string, unknown> | null }>(
    '/okx/trade/cancel',
    body,
  );
  return data;
}

/* ===== HL → 交易所跟单 ===== */

export type CopyExchange = 'okx' | 'binance';

export type CopyTaskDto = {
  id: string;
  userId?: string;
  name: string;
  exchange: CopyExchange;
  enabled: boolean;
  whaleAddress: string;
  followCapitalUsd: number;
  maxLeverage: number;
  maxNotionalUsd: number;
  note: string;
  updatedAt: number;
};

export type CopyPositionDto = {
  id: string;
  taskId: string;
  coin: string;
  side: 'long' | 'short';
  lever: number;
  mgnMode?: string;
  marginUsd: number;
  size: number;
  notionalUsd?: number;
  entryPx: number;
  markPx: number;
  liqPx: number;
  mgnRatio: number;
  uPnl: number;
  pnlRatio: number;
  status: 'open' | 'closed';
  instId?: string;
};

export type CopyRecordDto = {
  id: string;
  taskId: string;
  at: number;
  kind: 'open' | 'add' | 'close' | 'margin';
  coin: string;
  side: 'long' | 'short';
  lever?: number;
  marginUsd?: number;
  px?: number;
  note?: string;
  status?: 'ok' | 'fail';
};

export type ExchangeKeysDto = {
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

export async function fetchCopyTradeSnapshot() {
  const { data } = await http.get<{
    tasks: CopyTaskDto[];
    positions: CopyPositionDto[];
    records: CopyRecordDto[];
    updatedAt: number;
    trade?: { configured?: boolean; simulated?: boolean; keyHint?: string; source?: string };
    exchangeKeys?: ExchangeKeysDto;
    exchangeKeysReady?: boolean;
  }>('/copy-trade');
  return data;
}

export async function fetchExchangeKeys() {
  const { data } = await http.get<ExchangeKeysDto>('/copy-trade/exchange-keys');
  return data;
}

export async function saveOkxExchangeKeys(body: {
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
  simulated?: boolean;
  enabled?: boolean;
}) {
  const { data } = await http.put<
    { ok: boolean; verified?: boolean; warn?: string } & ExchangeKeysDto
  >('/copy-trade/exchange-keys/okx', body, { timeout: 90_000 });
  return data;
}

export async function deleteOkxExchangeKeys() {
  const { data } = await http.delete<{ ok: boolean } & ExchangeKeysDto>(
    '/copy-trade/exchange-keys/okx',
  );
  return data;
}

export async function saveCopyTask(task: Partial<CopyTaskDto> & { whaleAddress?: string }) {
  const { data } = await http.post<{ ok: boolean; task: CopyTaskDto }>('/copy-trade/tasks', task);
  return data;
}

export async function deleteCopyTask(id: string) {
  const { data } = await http.delete<{ ok: boolean }>(`/copy-trade/tasks/${encodeURIComponent(id)}`);
  return data;
}

export async function closeCopyPosition(id: string) {
  const { data } = await http.post<{
    ok: boolean;
    order?: { instId: string; sz: number; ordId: string | null; side: string };
    snapshot?: {
      tasks: CopyTaskDto[];
      positions: CopyPositionDto[];
      records: CopyRecordDto[];
      updatedAt: number;
    };
    error?: string;
  }>(`/copy-trade/positions/${encodeURIComponent(id)}/close`, {}, { timeout: 90_000 });
  return data;
}

export async function syncCopyTasks(tasks: CopyTaskDto[]) {
  const { data } = await http.put<{ ok: boolean; tasks: CopyTaskDto[] }>('/copy-trade/tasks', {
    tasks,
  });
  return data;
}

export async function followCopyFromPosition(body: {
  target: 'all' | 'okx' | 'binance';
  whaleAddress: string;
  whaleName?: string;
  whaleAccountValue?: number;
  whaleTotalPositionUsd?: number;
  /** 跟单本金（USDT），等同跟单任务里的 followCapitalUsd */
  followCapitalUsd?: number;
  position: {
    coin: string;
    coinLabel?: string;
    side: 'long' | 'short';
    size?: number;
    entryPx?: number | null;
    markPx?: number | null;
    positionValue?: number | null;
    unrealizedPnl?: number | null;
    leverage?: number | null;
    marginUsed?: number | null;
    liquidationPx?: number | string | null;
  };
}) {
  const { data } = await http.post<{
    ok: boolean;
    created: CopyTaskDto[];
    reused: CopyTaskDto[];
    positions: CopyPositionDto[];
    orders?: Array<{
      exchange: string;
      instId: string;
      sz: number;
      ordId: string | null;
      side: string;
      lever: number;
      notional: number;
    }>;
    failures?: string[];
    error?: string;
    snapshot?: {
      tasks: CopyTaskDto[];
      positions: CopyPositionDto[];
      records: CopyRecordDto[];
      updatedAt: number;
    };
  }>('/copy-trade/follow', body, { timeout: 90_000 });
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

