export type WhaleDirection = 'long' | 'short' | 'neutral';
export type MacroBias = 'long' | 'short' | '';

export type PositionEntryFillKind = 'open' | 'add' | 'reduce';

export interface PositionEntryFill {
  time: number;
  price: number;
  size: number;
  /** 开仓 / 补仓 / 减仓；旧缓存数据可能缺失 */
  kind?: PositionEntryFillKind;
  /** 减仓成交对应的已实现盈亏 */
  closedPnl?: number;
  usd: number;
}

export interface WhalePosition {
  coin: string;
  coinLabel?: string;
  side: 'long' | 'short';
  size: number;
  entryPx: number;
  positionValue: number;
  unrealizedPnl: number;
  leverage: number | null;
  liquidationPx: string | number | null;
  marginUsed?: number | null;
  openTime?: number | null;
  /** 首次建仓时间（当前仓位周期第一笔同向成交）；历史不完整时可能仅为最早可见时间 */
  firstOpenTime?: number | null;
  /** 最近一次加仓/开仓时间（补仓不重置 firstOpenTime） */
  lastAddTime?: number | null;
  /** fills 是否完整追溯到从 0 建仓；false 时持仓天数不纳入评分 */
  openHistoryComplete?: boolean;
  /** 构成当前持仓的开仓/补仓成交（时间正序；过长时为首尾各 1000） */
  entryFills?: PositionEntryFill[];
  /** 中间被省略的成交条数 */
  entryFillsOmitted?: number;
}

export interface WhalePositionDetail {
  coin: string;
  coinLabel?: string;
  kind: 'perp' | 'spot';
  side: 'long' | 'short';
  size: number;
  entryPx: number | null;
  markPx?: number | null;
  positionValue: number | null;
  unrealizedPnl: number | null;
  liquidationPx: number | null;
  leverage: number | null;
  leverageLabel: string;
  marginUsed?: number | null;
  openTime?: number | null;
  firstOpenTime?: number | null;
  lastAddTime?: number | null;
  openHistoryComplete?: boolean;
  entryFills?: PositionEntryFill[];
  entryFillsOmitted?: number;
  stopLossPx?: number | null;
  takeProfitPx?: number | null;
  stopLossType?: string | null;
  takeProfitType?: string | null;
  closed?: boolean;
  /** 已平仓周期：平均平仓价、已实现盈亏、手续费与持仓时长 */
  closePx?: number | null;
  closeTime?: number | null;
  realizedPnl?: number | null;
  realizedRoi?: number | null;
  fees?: number | null;
  holdMs?: number | null;
  entryEstimated?: boolean;
  explorerUrl?: string;
}

export interface WhaleRiskHistorySample {
  openTime: number;
  closeTime: number;
  result: number;
}

export interface WhaleRiskHistory {
  closedTrades: WhaleRiskHistorySample[];
  avgHoldingDays: number | null;
  maxHoldingDays: number | null;
  adjustedWinRate: number | null;
  monthlyPnL: number | null;
  sampleSize: number;
}

export interface WhalePositionResponse {
  whale: {
    id: string;
    name: string;
    address: string;
  };
  updatedAt: number;
  position: WhalePositionDetail;
  /** 最近 fills 还原的已完结周期，用于时间加权胜率 */
  riskHistory?: WhaleRiskHistory;
}

export interface WhaleProfile {
  id: string;
  name: string;
  address: string;
  description: string;
  winRate: number;
  longWinRate?: number | null;
  shortWinRate?: number | null;
  topCoins?: string[];
  maxDrawdown?: number;
  closedTrades?: number;
  /** 近 24h 成交笔数（回填扫描时写入） */
  fills24h?: number;
  weekVlm?: number;
  /** 月成交额（榜单），优先于 weekVlm 展示 */
  monthVlm?: number;
  /** 账户权益（榜单） */
  accountValue?: number;
  /** 近月盈亏（榜单） */
  monthPnl?: number;
  /** 累计盈亏（榜单 allTime） */
  allTimePnl?: number;
  /** 活跃天数（首次成交至今），可选 */
  activeDays?: number;
  /** 外部脚本定期写入的排序权重，越高越靠前 */
  priority?: number;
  style?: 'stable' | 'hf';
  enabled: boolean;
  /** 后台手动添加 */
  manual?: boolean;
  /** 人工命名 */
  customName?: boolean;
  direction: WhaleDirection;
  longUsd: number;
  shortUsd: number;
  netUsd: number;
  positions: WhalePosition[];
  error?: string | null;
}

export interface WhaleTrade {
  id: string;
  time: number;
  from: string;
  to: string;
  amountUsd: number;
  amount: number;
  asset: string;
  assetLabel?: string;
  exotic?: boolean;
  blockchain: string;
  whaleId: string | null;
  whaleName: string;
  side: string;
  closedPnl: number;
  hash: string;
  source: 'hyperliquid' | 'onchain';
  price?: number;
  /** 成交前带符号仓位；≈0 视为开仓 */
  startPosition?: number | null;
  /** HL dir，如 Open Long / Open Short */
  dir?: string;
}

export interface TradeAssetOption {
  value: string;
  label: string;
  exotic: boolean;
}

export interface PagedTradesQuery {
  page?: number;
  limit?: number;
  asset?: string;
  flow?: 'all' | 'in' | 'out';
  sinceMs?: number;
  refresh?: boolean;
}

export interface PagedTradesResponse {
  whale?: {
    id: string;
    name: string;
    address: string;
  };
  trades: WhaleTrade[];
  total: number;
  page: number;
  limit: number;
  assets: string[];
  assetOptions?: TradeAssetOption[];
  updatedAt?: number;
  minUsd?: number;
}

export interface WhaleTradesResponse extends PagedTradesResponse {
  whale: {
    id: string;
    name: string;
    address: string;
  };
}

export type WhaleMode = 'stable' | 'hf';

export interface WhaleResponse {
  whales: WhaleProfile[];
  trades?: WhaleTrade[];
  activity?: WhaleTrade[];
  warnings: string[];
  minUsd: number;
  stale: boolean;
  updatedAt: number;
  mode?: WhaleMode;
  /** 分段加载进度 */
  progressive?: boolean;
  loaded?: number;
  total?: number;
  offset?: number;
  /** 下一批起始位置，与 loaded（真实已加载数）解耦 */
  nextOffset?: number;
  limit?: number;
  done?: boolean;
  /** 仍含「等待刷新」占位，需继续补齐 */
  incomplete?: boolean;
  pending?: number;
}

export interface NewsArticle {
  id: string;
  title: string;
  source: string;
  url: string;
  publishedAt: number;
  summary: string;
  matchedKeywords: string[];
}

export interface NewsResponse {
  articles: NewsArticle[];
  keywords: string[];
  sources: Record<string, number>;
  stale: boolean;
  updatedAt: number;
  warning?: string;
}

export interface NewsDetailResponse {
  id: string;
  title: string;
  source: string;
  url: string;
  publishedAt: number;
  summary: string;
  content: string;
  matchedKeywords: string[];
  fetched: boolean;
  warning?: string;
}

export interface CalendarEvent {
  id: string;
  date: string;
  dateLabel: string;
  weekday: string;
  daysUntil: number;
  isToday: boolean;
  isTomorrow: boolean;
  title: string;
  note: string;
  time?: string;
  timeNote?: string;
  tags: string[];
  impact: 'bull' | 'bear' | 'volatile' | 'watch' | 'liquidity';
  importance: 'high' | 'mid' | 'low';
  forecast?: string;
  previous?: string;
  actual?: string;
  previousDate?: string;
  source?: string;
}

export interface CalendarResponse {
  today: string;
  until: string;
  events: CalendarEvent[];
  sources?: {
    local?: number;
    api?: number;
    merged?: number;
    provider?: string;
  };
  stale?: boolean;
}

export interface WhaleConfigItem {
  id: string;
  name: string;
  address: string;
  description: string;
  winRate: number;
  maxDrawdown?: number;
  closedTrades?: number;
  weekVlm?: number;
  monthVlm?: number;
  activeDays?: number;
  priority?: number;
  style?: WhaleMode;
  enabled: boolean;
}

export interface AppConfig {
  mode?: WhaleMode;
  whales: WhaleConfigItem[];
  keywords: string[];
  keywordGroups?: {
    macro: string[];
    crypto: string[];
    event: string[];
  };
}

export interface MarketKline {
  time: number;
  close: number;
  high?: number;
  low?: number;
  volume?: number;
  quote?: number;
}

export interface MarketLevel {
  price: number;
  kind: 'resist' | 'support' | 'price';
  distancePct: number;
  label: string;
}

export interface MacroEvent {
  id: string;
  date: string;
  time: string;
  title: string;
  forecast: string;
  previous: string;
  actual?: string;
  previousDate?: string;
  severity: 'extreme' | 'high' | 'mid' | 'low';
  source: string;
}

export interface CoinMarket {
  id: string;
  name: string;
  symbol: string;
  price: number;
  high24h: number;
  low24h: number;
  change24h: number;
  volume24h: number;
  klinesHour: MarketKline[];
  klinesDay: MarketKline[];
  funding: number;
  premium: number;
  openInterest: {
    contracts: number;
    usd: number;
    hlUsd?: number;
    binanceUsd?: number;
    changePct?: number;
    history: { time: number; usd: number }[];
  };
  longShort: {
    longAccount: number;
    shortAccount: number;
    accountRatio: number;
    longPosition: number;
    shortPosition: number;
    positionRatio: number;
  };
  liquidations: {
    longUsd: number;
    shortUsd: number;
    totalUsd: number;
    count: number;
    source: string;
    sample?: boolean;
  };
  etf: {
    netUsd: number;
    netCoins: number;
    window: string;
    source: string;
  };
  whaleFlow: {
    inUsd: number;
    outUsd: number;
    netUsd: number;
    count: number;
  };
  levels: MarketLevel[];
  costDist: {
    belowPct: number;
    abovePct: number;
    buckets: { price: number; volume: number; share: number }[];
  };
  heat: {
    score: number;
    label: string;
    parts: {
      funding: number;
      longShort: number;
      range: number;
      sentiment: number;
      oi: number;
    };
  };
  bias: {
    direction: 'long' | 'short' | 'range';
    label: string;
    resonance: boolean;
    reason: string;
  };
}

export interface MarketsResponse {
  coins: CoinMarket[];
  macro: {
    events: MacroEvent[];
    treasury10y: { value: number; change: number; changePct: number } | null;
    dxy: { value: number; change: number; changePct: number } | null;
    fed: {
      title: string;
      items: { label: string; pct: number; kind: string }[];
      hikePct: number;
      cutPct: number;
      holdPct: number;
      source: string;
      previous?: {
        date: string;
        label: string;
        detail: string;
        kind: string;
      };
    };
    fearGreed: { value: number; label: string };
  };
  whale: {
    long: number;
    short: number;
    neutral: number;
    netUsd: number;
  };
  updatedAt: number;
  source: string;
  stale?: boolean;
}
