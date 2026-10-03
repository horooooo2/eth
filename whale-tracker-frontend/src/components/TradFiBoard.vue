<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch as watchVue } from 'vue';
import { ElMessage } from 'element-plus';
import { fetchRadarAvailableContracts, fetchRadarCatalog, fetchRadarKlines, fetchRadarMarket, fetchRadarMarketCap, fetchRadarNews, fetchRadarQuotes, streamChatMarketBrief, type MarketChatMessage, type RadarAvailableContract, type RadarKline, type RadarNewsItem, type TradFiMarketSymbol, type TradFiQuote } from '@/api';
import { DEFAULT_RADAR_WATCH, isDefaultRadarWatch, tradfiWatch, writeTradFiWatch } from '@/utils/tradfiWatch';

type RadarInterval = '24h' | '1h' | '15m' | '5m';
type AssetFilter = 'ALL' | 'CRYPTO' | 'TRADFI';
type DirectionFilter = 'ALL' | 'UP' | 'DOWN';
const watch = tradfiWatch;
const catalog = ref<TradFiMarketSymbol[]>([]);
const quotes = ref<Record<string, TradFiQuote>>({});
const marketQuotes = ref<Record<string, TradFiQuote>>({});
const marketLoading = ref(true);
const marketError = ref('');
const updatedAt = ref('');
const selected = ref('BTCUSDT');
const activeInterval = ref<RadarInterval>('1h');
const assetFilter = ref<AssetFilter>('ALL');
const searchText = ref('');
const anomalyOnly = ref(false);
const anomalyThreshold = ref(2);
const directionFilter = ref<DirectionFilter>('ALL');
const watchPage = ref(1);
const marketPage = ref(1);
const chartInterval = ref<'5m' | '15m' | '1h'>('15m');
const chartBars = ref<RadarKline[]>([]);
const chartLoading = ref(false);
const chartError = ref('');
const selectedMarketCap = ref<string | null>(null);
const marketCapSource = ref('');
const marketCapLoading = ref(false);
const chartHover = ref<{ index: number; x: number; y: number } | null>(null);
const failedLogos = ref(new Set<string>());
const WATCH_PAGE_SIZE = 6;
const MARKET_PAGE_SIZE = 10;
let refreshTimer = 0;
let refreshInFlight = false;
let refreshQueued = false;
let chartRequestId = 0;
const REFRESH_INTERVAL_MS = 15_000;
const addDialogVisible = ref(false);
const addSearch = ref('');
const availableContracts = ref<RadarAvailableContract[]>([]);
const availableLoading = ref(false);
const availableError = ref('');
const aiDialogVisible = ref(false);
const aiSymbol = ref('');
const aiLoading = ref(false);
const aiSending = ref(false);
const aiStatus = ref('');
const aiError = ref('');
const aiContextText = ref('');
const aiContextSummary = ref('');
const aiNews = ref<RadarNewsItem[]>([]);
const aiNewsSource = ref('');
const aiNewsError = ref('');
const aiInput = ref('');
const aiMessages = ref<Array<MarketChatMessage & { pending?: boolean }>>([]);
const aiChatScroll = ref<HTMLElement | null>(null);
let aiAbort: AbortController | null = null;
let aiRequestSeq = 0;

const catalogBySymbol = computed(() => new Map(catalog.value.map((item) => [item.symbol, item])));
const selectedQuote = computed(() => quotes.value[selected.value] || null);
const selectedAsset = computed(() => catalogBySymbol.value.get(selected.value) || null);
const categories = [
  { id: 'ALL' as const, label: '全部' },
  { id: 'CRYPTO' as const, label: '虚拟币' },
  { id: 'TRADFI' as const, label: '传统金融' },
];
const intervals: Array<{ id: RadarInterval; label: string }> = [
  { id: '24h', label: '24 小时' },
  { id: '1h', label: '1 小时' },
  { id: '15m', label: '15 分钟' },
  { id: '5m', label: '5 分钟' },
];

function changeValue(quote: TradFiQuote | undefined, interval: RadarInterval): number | null {
  if (!quote) return null;
  const raw = interval === '24h' ? quote.priceChangePercent : quote.changes?.[interval];
  if (raw == null || raw === '' || !Number.isFinite(Number(raw))) return null;
  return Number(raw);
}
function formatChange(value: number | null) {
  if (value == null) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}
function changeClass(value: number | null) {
  return value == null ? 'neutral' : value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral';
}
function formatPrice(raw: string | null | undefined) {
  if (raw == null || raw === '' || !Number.isFinite(Number(raw))) return '—';
  const price = Number(raw);
  const digits = price >= 1000 ? 2 : price >= 1 ? 3 : 6;
  return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits });
}
function assetType(symbol: string): 'CRYPTO' | 'TRADFI' {
  const market = catalogBySymbol.value.get(symbol) || availableContracts.value.find((item) => item.symbol === symbol);
  return market?.assetType === 'TRADFI' ? 'TRADFI' : 'CRYPTO';
}
function assetLabel(symbol: string) {
  const market = catalogBySymbol.value.get(symbol) || availableContracts.value.find((item) => item.symbol === symbol);
  const baseAsset = market?.baseAsset || symbol.replace(/USDT$/, '');
  if (market?.assetType === 'TRADFI' && market.name && market.name !== baseAsset) {
    return `${baseAsset}（${market.name}）`;
  }
  return baseAsset;
}
const filteredRows = computed(() => {
  const query = searchText.value.trim().toLocaleLowerCase();
  return watch.value
    .filter((symbol) => assetFilter.value === 'ALL' || assetType(symbol) === assetFilter.value)
    .filter((symbol) => {
      if (!query) return true;
      const market = catalogBySymbol.value.get(symbol);
      return `${symbol} ${market?.baseAsset || ''} ${market?.name || ''}`.toLocaleLowerCase().includes(query);
    })
    .map((symbol) => ({ symbol, quote: quotes.value[symbol], change: changeValue(quotes.value[symbol], activeInterval.value) }))
    .filter((row) => directionFilter.value === 'ALL' || (directionFilter.value === 'UP' ? (row.change ?? -Infinity) > 0 : (row.change ?? Infinity) < 0))
    .filter((row) => !anomalyOnly.value || (row.change != null && Math.abs(row.change) >= Math.max(0, Number(anomalyThreshold.value) || 0)))
    .sort((a, b) => Math.abs(b.change ?? -1) - Math.abs(a.change ?? -1));
});
const filteredMarketRows = computed(() => {
  const query = searchText.value.trim().toLocaleLowerCase();
  const watched = new Set(watch.value);
  return catalog.value
    .filter((market) => !watched.has(market.symbol))
    .filter((market) => assetFilter.value === 'ALL' || market.assetType === assetFilter.value)
    .filter((market) => !query || `${market.symbol} ${market.baseAsset} ${market.name}`.toLocaleLowerCase().includes(query))
    .map((market) => ({ symbol: market.symbol, market, quote: marketQuotes.value[market.symbol], change: changeValue(marketQuotes.value[market.symbol], '24h') }))
    .filter((row) => directionFilter.value === 'ALL' || (directionFilter.value === 'UP' ? (row.change ?? -Infinity) > 0 : (row.change ?? Infinity) < 0))
    .filter((row) => !anomalyOnly.value || (row.change != null && Math.abs(row.change) >= Math.max(0, Number(anomalyThreshold.value) || 0)))
    .sort((a, b) => Math.abs(b.change ?? -1) - Math.abs(a.change ?? -1));
});
const pagedWatchRows = computed(() => filteredRows.value.slice((watchPage.value - 1) * WATCH_PAGE_SIZE, watchPage.value * WATCH_PAGE_SIZE));
const pagedMarketRows = computed(() => filteredMarketRows.value.slice((marketPage.value - 1) * MARKET_PAGE_SIZE, marketPage.value * MARKET_PAGE_SIZE));
const watchPageCount = computed(() => Math.max(1, Math.ceil(filteredRows.value.length / WATCH_PAGE_SIZE)));
const marketPageCount = computed(() => Math.max(1, Math.ceil(filteredMarketRows.value.length / MARKET_PAGE_SIZE)));
const selectedMarketQuote = computed(() => marketQuotes.value[selected.value]);
const quoteTimestamp = computed(() => updatedAt.value ? new Date(updatedAt.value).toLocaleTimeString('zh-CN') : '—');
const availableMatches = computed(() => {
  const query = addSearch.value.trim().toLocaleLowerCase();
  const watchedSymbols = new Set(watch.value.map((symbol) => symbol.toUpperCase()));
  const seen = new Set<string>();
  return availableContracts.value
    .filter((contract) => {
      const symbol = contract.symbol.toUpperCase();
      if (watchedSymbols.has(symbol) || seen.has(symbol)) return false;
      seen.add(symbol);
      return true;
    })
    .filter((contract) => !query || `${contract.symbol} ${contract.baseAsset} ${contract.name}`.toLocaleLowerCase().includes(query))
    .slice(0, query ? 100 : 40);
});
const chartPoints = computed(() => {
  const bars = chartBars.value;
  if (!bars.length) return [];
  const min = Math.min(...bars.map((bar) => bar.low));
  const max = Math.max(...bars.map((bar) => bar.high));
  const span = max - min || Math.max(max * 0.001, 1);
  return bars.map((bar, index) => ({
    x: 12 + index * (776 / Math.max(1, bars.length - 1)),
    y: 12 + ((max - bar.close) / span) * 176,
    bar,
  }));
});
const chartPath = computed(() => chartPoints.value.map((point, index) => `${index ? 'L' : 'M'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' '));
const hoveredBar = computed(() => chartHover.value ? chartPoints.value[chartHover.value.index]?.bar || null : null);
const chartTooltipStyle = computed(() => chartHover.value ? { left: `${chartHover.value.x}%`, top: `${chartHover.value.y}%` } : {});

watchVue([filteredRows, directionFilter, assetFilter, searchText, anomalyOnly], () => { watchPage.value = 1; });
watchVue([filteredMarketRows, directionFilter, assetFilter, searchText, anomalyOnly], () => { marketPage.value = 1; });

function isWatched(symbol: string) { return watch.value.some((item) => item.toUpperCase() === symbol.toUpperCase()); }
function toggleWatch(symbol: string) {
  if (isWatched(symbol)) {
    if (watch.value.length <= 1) { ElMessage.warning('至少保留 1 个关注合约'); return; }
    if (quotes.value[symbol]) marketQuotes.value = { ...marketQuotes.value, [symbol]: quotes.value[symbol] };
    writeTradFiWatch(watch.value.filter((item) => item !== symbol));
    if (selected.value === symbol) selected.value = watch.value.find((item) => item !== symbol) || 'BTCUSDT';
    return;
  }
  if (watch.value.length >= 30) { ElMessage.warning('最多关注 30 个合约'); return; }
  writeTradFiWatch([...watch.value, symbol]);
}
async function openAddContractDialog() {
  addDialogVisible.value = true;
  addSearch.value = '';
  if (availableContracts.value.length || availableLoading.value) return;
  availableLoading.value = true;
  availableError.value = '';
  try {
    const result = await fetchRadarAvailableContracts();
    availableContracts.value = result.contracts;
    if (result.stale) availableError.value = '正在显示缓存的合约清单';
  } catch (error) {
    availableError.value = error instanceof Error ? error.message : '可添加合约获取失败';
  } finally {
    availableLoading.value = false;
  }
}
function addContract(contract: RadarAvailableContract) {
  if (isWatched(contract.symbol)) { ElMessage.info('该合约已在关注列表中'); return; }
  if (watch.value.length >= 30) { ElMessage.warning('最多关注 30 个合约'); return; }
  catalog.value = [...catalog.value.filter((item) => item.symbol !== contract.symbol), contract];
  const snapshot: TradFiQuote = {
    symbol: contract.symbol,
    lastPrice: contract.lastPrice,
    priceChangePercent: contract.priceChangePercent,
    quoteVolume24h: contract.quoteVolume24h,
    closeTime: null,
    source: 'Binance USDⓈ-M Futures',
    stale: false,
  };
  quotes.value = { ...quotes.value, [contract.symbol]: snapshot };
  marketQuotes.value = { ...marketQuotes.value, [contract.symbol]: snapshot };
  writeTradFiWatch([...watch.value, contract.symbol]);
  selected.value = contract.symbol;
  addDialogVisible.value = false;
  void refreshQuotes();
}
function formatVolume(raw: string | null | undefined) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toFixed(0);
}
function formatMarketCap(raw: string | null) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}
function logoUrl(symbol: string) {
  const market = catalogBySymbol.value.get(symbol) || availableContracts.value.find((item) => item.symbol === symbol);
  const base = market?.baseAsset || symbol.replace(/USDT$/, '');
  if (assetType(symbol) === 'TRADFI') {
    const domains: Record<string, string> = {
      XAU: 'cmegroup.com', XAG: 'cmegroup.com', CL: 'cmegroup.com', WTI: 'cmegroup.com', USOIL: 'cmegroup.com', XTI: 'cmegroup.com',
      BZ: 'ice.com', BRENT: 'ice.com',
      QQQ: 'invesco.com', SPY: 'ssga.com', NVDA: 'nvidia.com', AAPL: 'apple.com', MSFT: 'microsoft.com',
      AMZN: 'amazon.com', AVGO: 'broadcom.com', AMD: 'amd.com', META: 'meta.com', SPCX: 'spacex.com',
      SNDK: 'sandisk.com', SKHYNIX: 'skhynix.com', TSLA: 'tesla.com', INTC: 'intel.com',
    };
    const domain = domains[base];
    if (domain) return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
  }
  return `https://assets.coincap.io/assets/icons/${base.toLowerCase()}@2x.png`;
}
function logoFailed(symbol: string) { return failedLogos.value.has(symbol); }
function markLogoFailed(symbol: string) { failedLogos.value = new Set(failedLogos.value).add(symbol); }
function formatChartDate(timestamp: number) {
  return new Date(timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function handleChartMove(event: PointerEvent) {
  if (!chartPoints.value.length) return;
  const svg = event.currentTarget as SVGSVGElement;
  const bounds = svg.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  const index = Math.round(ratio * (chartPoints.value.length - 1));
  chartHover.value = { index, x: Math.max(14, Math.min(86, ratio * 100)), y: 15 };
}
function clearChartHover() { chartHover.value = null; }
async function loadChart() {
  const symbol = selected.value;
  const requestId = ++chartRequestId;
  chartLoading.value = true;
  chartError.value = '';
  chartHover.value = null;
  try {
    const result = await fetchRadarKlines(symbol, chartInterval.value);
    if (requestId !== chartRequestId || selected.value !== symbol) return;
    chartBars.value = result.available ? result.bars : [];
    if (!result.available) chartError.value = result.error || '暂无走势图数据';
  } catch (error) {
    if (requestId === chartRequestId && selected.value === symbol) chartError.value = error instanceof Error ? error.message : '走势图请求失败';
  } finally {
    if (requestId === chartRequestId) chartLoading.value = false;
  }
}

async function loadMarketCap(symbol: string) {
  selectedMarketCap.value = null;
  marketCapSource.value = '';
  marketCapLoading.value = true;
  try {
    const result = await fetchRadarMarketCap(symbol);
    if (selected.value !== symbol) return;
    selectedMarketCap.value = result.marketCapUsd;
    marketCapSource.value = result.source || '';
  } catch {
    if (selected.value === symbol) marketCapSource.value = '';
  } finally {
    if (selected.value === symbol) marketCapLoading.value = false;
  }
}

function closeAiDialog() {
  aiDialogVisible.value = false;
  aiRequestSeq += 1;
  aiAbort?.abort();
  aiAbort = null;
}

function scrollAiToBottom() {
  window.requestAnimationFrame(() => {
    if (aiChatScroll.value) aiChatScroll.value.scrollTop = aiChatScroll.value.scrollHeight;
  });
}

function baseSymbol(symbol: string) {
  return catalogBySymbol.value.get(symbol)?.baseAsset
    || availableContracts.value.find((item) => item.symbol === symbol)?.baseAsset
    || symbol.replace(/USDT$/, '');
}

async function openAiAnalysis(symbol: string) {
  aiAbort?.abort();
  const sequence = ++aiRequestSeq;
  const controller = new AbortController();
  aiAbort = controller;
  aiSymbol.value = symbol;
  aiDialogVisible.value = true;
  aiLoading.value = true;
  aiSending.value = false;
  aiStatus.value = '正在收集行情与相关新闻…';
  aiError.value = '';
  aiContextText.value = '';
  aiContextSummary.value = '';
  aiNews.value = [];
  aiNewsSource.value = '';
  aiNewsError.value = '';
  aiMessages.value = [];
  const prompt = `请帮我分析${assetLabel(symbol)}（${symbol}）近期这次涨跌。希望像一篇有依据的简短市场观察：开头先给判断，再分层说明最重要的新闻催化、可能的市场逻辑、其他背景，以及风险和仍不确定的地方，最后用一两句话总结。重要新闻事实请用[新闻1]这样的编号标注，编号对应弹窗里的相关新闻列表。可以写具体事件和数据，但必须能从提供的新闻或行情里核实；不要补造机构评级、目标价、估值或公司说法。没有足够新闻证据时请坦白说明。不要做技术分析，不使用K线、指标、支撑阻力等说法。中文表达自然易懂，像认真和我聊市场，不要写成模板化研报，也不要把猜测说成事实。`;
  try {
    const [quoteResult, newsResult] = await Promise.all([
      fetchRadarQuotes([symbol]),
      fetchRadarNews(symbol).catch((error) => ({
        symbol, items: [], source: '', updatedAt: '', error: error instanceof Error ? error.message : '相关新闻获取失败',
      })),
    ]);
    if (sequence !== aiRequestSeq) return;
    const quote = quoteResult.quotes.find((item) => item.symbol === symbol) || quotes.value[symbol];
    if (quote) quotes.value = { ...quotes.value, [symbol]: quote };
    const changeLines = ['5m', '15m', '1h'].map((interval) => {
      const value = quote?.changes?.[interval as '5m' | '15m' | '1h'];
      return `${interval} 涨跌：${formatChange(value == null ? null : Number(value))}`;
    });
    aiNews.value = newsResult.items;
    aiNewsSource.value = newsResult.source;
    aiNewsError.value = newsResult.error || '';
    const newsLines = newsResult.items.length
      ? newsResult.items.slice(0, 8).map((item, index) => `${index + 1}. ${item.title}｜来源：${item.source || newsResult.source || '未知'}｜发布时间：${item.publishedAt || '未知'}｜摘要：${item.summary || '新闻源仅提供标题，缺少摘要正文。'}｜链接：${item.url}`)
      : [`未找到可用相关新闻。${newsResult.error ? `新闻源请求失败：${newsResult.error}` : ''}`];
    aiContextText.value = [
      `标的：${assetLabel(symbol)} (${symbol})`,
      `资产类型：${assetType(symbol) === 'TRADFI' ? '传统金融永续合约' : '虚拟币永续合约'}`,
      `行情源：Binance USDⓈ-M Futures；采集时间：${new Date().toISOString()}`,
      `最新价格：${formatPrice(quote?.lastPrice)}`,
      `24 小时涨跌：${formatChange(quote?.priceChangePercent == null ? null : Number(quote.priceChangePercent))}`,
      ...changeLines,
      '【雷达相关新闻依据】',
      `新闻来源：${newsResult.source || '未取得'}；检索时间：${newsResult.updatedAt || '未知'}；新闻源异常：${newsResult.error || '无'}`,
      ...newsLines,
      '分析限制：只依据当前行情变化和以上新闻标题、摘要及来源，不做技术分析。新闻报道与价格变化之间未必存在已证实因果；如果无法建立可靠关联，明确说暂时无法确认。引用编号按新闻顺序对应。',
    ].join('\n\n');
    aiContextSummary.value = `${assetLabel(symbol)} · 最新 ${formatPrice(quote?.lastPrice)} · 24h ${formatChange(quote?.priceChangePercent == null ? null : Number(quote.priceChangePercent))} · 已检索 ${newsResult.items.length} 条相关新闻`;
    aiMessages.value = [{ role: 'user', content: prompt }, { role: 'assistant', content: '' }];
    aiStatus.value = 'AI 正在核对新闻与行情变化…';
    await streamChatMarketBrief({
      coin: baseSymbol(symbol), message: prompt, contextText: aiContextText.value, messages: [],
    }, {
      signal: controller.signal,
      onDelta: (text) => {
        if (sequence === aiRequestSeq && aiMessages.value.length) {
          const last = aiMessages.value[aiMessages.value.length - 1];
          last.content += text;
          scrollAiToBottom();
        }
      },
      onDone: (payload) => {
        if (sequence === aiRequestSeq && payload.reply && aiMessages.value.length) {
          aiMessages.value[aiMessages.value.length - 1].content = payload.reply;
        }
      },
    });
  } catch (error) {
    if (sequence === aiRequestSeq && (error as Error)?.name !== 'AbortError') {
      aiError.value = error instanceof Error ? error.message : 'AI 分析失败';
    }
  } finally {
    if (sequence === aiRequestSeq) {
      aiLoading.value = false;
      aiStatus.value = '';
    }
  }
}

async function sendAiMessage() {
  const message = aiInput.value.trim();
  if (!message || aiLoading.value || aiSending.value || !aiContextText.value) return;
  const history = aiMessages.value.filter((item) => !item.pending).slice(-12)
    .map(({ role, content }) => ({ role, content }));
  aiMessages.value.push({ role: 'user', content: message }, { role: 'assistant', content: '', pending: true });
  aiInput.value = '';
  aiSending.value = true;
  aiError.value = '';
  aiStatus.value = 'AI 正在回复…';
  const sequence = ++aiRequestSeq;
  const controller = new AbortController();
  aiAbort = controller;
  try {
    await streamChatMarketBrief({
      coin: baseSymbol(aiSymbol.value), message, contextText: aiContextText.value,
      messages: history,
    }, {
      signal: controller.signal,
      onDelta: (text) => {
        if (sequence === aiRequestSeq) {
          aiMessages.value[aiMessages.value.length - 1].content += text;
          scrollAiToBottom();
        }
      },
      onDone: (payload) => {
        if (sequence === aiRequestSeq && payload.reply) aiMessages.value[aiMessages.value.length - 1].content = payload.reply;
      },
    });
  } catch (error) {
    if (sequence === aiRequestSeq && (error as Error)?.name !== 'AbortError') {
      aiError.value = error instanceof Error ? error.message : 'AI 回复失败';
    }
  } finally {
    if (sequence === aiRequestSeq) {
      aiSending.value = false;
      aiStatus.value = '';
      aiMessages.value = aiMessages.value.map((item) => ({ ...item, pending: false }));
    }
  }
}

function recommendedWatch(symbols: TradFiMarketSymbol[]) {
  const available = new Map(symbols.map((item) => [item.symbol, item]));
  return DEFAULT_RADAR_WATCH.filter((symbol) => available.has(symbol));
}

async function refreshQuotes() {
  if (refreshInFlight) { refreshQueued = true; return; }
  refreshInFlight = true;
  try {
    const [result, selectedResult, marketResult] = await Promise.all([
      watch.value.length ? fetchRadarQuotes(watch.value) : Promise.resolve({ quotes: [], invalidSymbols: [], updatedAt: new Date().toISOString() }),
      selected.value && !watch.value.includes(selected.value) ? fetchRadarQuotes([selected.value]) : Promise.resolve({ quotes: [], invalidSymbols: [], updatedAt: new Date().toISOString() }),
      fetchRadarMarket(),
    ]);
    const next = { ...quotes.value };
    for (const quote of [...result.quotes, ...selectedResult.quotes]) next[quote.symbol] = quote;
    quotes.value = next;
    marketQuotes.value = { ...marketQuotes.value, ...Object.fromEntries(marketResult.quotes.map((quote) => [quote.symbol, quote])) };
    updatedAt.value = marketResult.updatedAt || result.updatedAt;
    marketError.value = marketResult.stale || (result.quotes.length && result.quotes.every((quote) => quote.stale))
      ? '行情源暂不可用，正在保留最近一次数据' : '';
    if (result.invalidSymbols.length) {
      marketError.value = `部分合约暂不可用：${result.invalidSymbols.join('、')}`;
    }
  } catch (error) {
    marketError.value = error instanceof Error ? error.message : '行情请求失败';
  } finally {
    refreshInFlight = false;
    if (refreshQueued) {
      refreshQueued = false;
      void refreshQuotes();
    }
  }
}

async function loadCatalog() {
  marketLoading.value = true;
  try {
    const result = await fetchRadarCatalog(watch.value);
    catalog.value = result.symbols;
    if (isDefaultRadarWatch(watch.value)) {
      const defaults = recommendedWatch(result.symbols);
      if (defaults.length) writeTradFiWatch(defaults);
    } else {
      const available = new Set(result.symbols.map((item) => item.symbol));
      const supportedWatches = watch.value.filter((symbol) => available.has(symbol));
      if (supportedWatches.length !== watch.value.length) {
        writeTradFiWatch(supportedWatches.length ? supportedWatches : recommendedWatch(result.symbols));
      }
    }
    if (!watch.value.includes(selected.value)) selected.value = watch.value[0] || 'BTCUSDT';
    marketError.value = result.stale ? '合约清单使用缓存数据' : '';
    await refreshQuotes();
  } catch (error) {
    marketError.value = error instanceof Error ? error.message : '合约清单获取失败';
  } finally {
    marketLoading.value = false;
  }
}

function selectSymbol(symbol: string) {
  selected.value = symbol;
  if (!quotes.value[symbol]) void refreshQuotes();
}
watchVue(watch, (symbols) => {
  if (!symbols.includes(selected.value)) selected.value = symbols[0] || 'BTCUSDT';
  void refreshQuotes();
});
watchVue(() => [selected.value, chartInterval.value] as const, () => { void loadChart(); });
watchVue(selected, (symbol) => { void loadMarketCap(symbol); }, { immediate: true });
onMounted(() => {
  void loadCatalog().then(() => loadChart());
  refreshTimer = window.setInterval(() => { void refreshQuotes(); }, REFRESH_INTERVAL_MS);
});
onUnmounted(() => {
  window.clearInterval(refreshTimer);
  aiRequestSeq += 1;
  aiAbort?.abort();
});
</script>

<template>
  <div class="radar">
    <main class="radar-content">
      <section class="toolbar" aria-label="行情筛选和排序">
        <div class="filters">
          <button v-for="item in categories" :key="item.id" type="button" :class="{ active: assetFilter === item.id }" @click="assetFilter = item.id">{{ item.label }}</button>
        </div>
        <div class="periods" aria-label="榜单周期">
          <button v-for="item in intervals" :key="item.id" type="button" :class="{ active: activeInterval === item.id }" @click="activeInterval = item.id">{{ item.label }}</button>
        </div>
        <div class="periods direction-filter" aria-label="涨跌类型"><button v-for="item in [{id:'ALL',label:'涨跌全部'},{id:'UP',label:'涨幅'},{id:'DOWN',label:'跌幅'}] as const" :key="item.id" type="button" :class="{ active: directionFilter === item.id }" @click="directionFilter = item.id">{{ item.label }}</button></div>
        <label class="search"><span>⌕</span><input v-model="searchText" type="search" placeholder="搜索代码或名称"></label>
        <button type="button" class="refresh" :disabled="refreshInFlight" @click="refreshQuotes">{{ refreshInFlight ? '更新中…' : '刷新行情' }}</button>
        <label class="threshold"><input v-model="anomalyOnly" type="checkbox"><span>只看异动</span></label>
        <label v-if="anomalyOnly" class="threshold-value"><input v-model.number="anomalyThreshold" type="number" min="0.1" step="0.1"><span>%</span></label>
        <button type="button" class="add-contract-button" @click="openAddContractDialog">＋ 新增币种</button>
      </section>

      <section class="watch-layout">
        <section class="market-panel watch-panel">
          <header class="market-title"><div><h2>我的关注</h2><p>{{ filteredRows.length }} 个标的 · {{ intervals.find((item) => item.id === activeInterval)?.label }}波动</p></div><span class="source">右上角书签可取消关注</span></header>
          <div class="watch-cards">
            <article v-for="row in pagedWatchRows" :key="row.symbol" class="watch-card" :class="{ chosen: selected === row.symbol }" @click="selectSymbol(row.symbol)">
              <button type="button" class="watch-select" :aria-label="`查看 ${row.symbol}`" @click="selectSymbol(row.symbol)">
                <span class="watch-card-top"><span class="asset-logo"><img v-if="!logoFailed(row.symbol)" :src="logoUrl(row.symbol)" :alt="`${assetLabel(row.symbol)} logo`" @error="markLogoFailed(row.symbol)"><span v-else>{{ assetLabel(row.symbol).slice(0, 2) }}</span></span><span class="watch-name">{{ assetLabel(row.symbol) }}<small>{{ row.symbol }}</small></span><b class="watch-change" :class="changeClass(row.change)">{{ formatChange(row.change) }}</b></span>
                <span class="watch-card-bottom"><span>最新 {{ formatPrice(row.quote?.lastPrice) }}</span><b :class="changeClass(row.change)">{{ intervals.find((item) => item.id === activeInterval)?.label }} {{ formatChange(row.change) }}</b></span>
              </button>
              <button type="button" class="watch-ai-button" :disabled="aiLoading || aiSending" @click.stop="openAiAnalysis(row.symbol)">AI 分析</button>
              <button type="button" class="follow-icon active" :aria-label="`取消关注 ${row.symbol}`" title="取消关注" @click.stop="toggleWatch(row.symbol)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.5 2.6 5.3 5.9.9-4.25 4.15 1 5.85L12 16.9l-5.25 2.8 1-5.85L3.5 9.7l5.9-.9L12 3.5Z"/></svg></button>
            </article>
            <div v-if="!pagedWatchRows.length" class="watch-empty">当前筛选没有关注标的</div>
          </div>
          <div v-if="watchPageCount > 1" class="pagination"><button type="button" :disabled="watchPage <= 1" @click="watchPage--">上一页</button><span>{{ watchPage }} / {{ watchPageCount }}</span><button type="button" :disabled="watchPage >= watchPageCount" @click="watchPage++">下一页</button></div>
        </section>

        <section class="market-panel selected-panel">
          <header class="selected-summary">
            <div class="selected-name"><span class="asset-logo large"><img v-if="!logoFailed(selected)" :src="logoUrl(selected)" :alt="`${assetLabel(selected)} logo`" @error="markLogoFailed(selected)"><span v-else>{{ assetLabel(selected).slice(0, 2) }}</span></span><span><b>{{ assetLabel(selected) }}</b><small>{{ selected }} · {{ selectedAsset?.assetType === 'TRADFI' ? '传统金融' : '虚拟币' }}</small></span><button type="button" class="follow-icon" :class="{ active: isWatched(selected) }" :aria-label="isWatched(selected) ? '取消关注' : '添加关注'" :title="isWatched(selected) ? '取消关注' : '添加关注'" @click="toggleWatch(selected)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.5 2.6 5.3 5.9.9-4.25 4.15 1 5.85L12 16.9l-5.25 2.8 1-5.85L3.5 9.7l5.9-.9L12 3.5Z"/></svg></button></div>
            <div class="selected-metrics"><div><span>最新价格</span><b>{{ formatPrice(selectedQuote?.lastPrice || selectedMarketQuote?.lastPrice) }}</b></div><div><span>{{ intervals.find((item) => item.id === activeInterval)?.label }}涨跌</span><b :class="changeClass(changeValue(selectedQuote || undefined, activeInterval))">{{ formatChange(changeValue(selectedQuote || undefined, activeInterval)) }}</b></div><div><span>滚动 24 小时</span><b :class="changeClass(changeValue(selectedQuote || selectedMarketQuote || undefined, '24h'))">{{ formatChange(changeValue(selectedQuote || selectedMarketQuote || undefined, '24h')) }}</b></div><div><span>24h 合约成交额</span><b>{{ formatVolume((selectedQuote || selectedMarketQuote)?.quoteVolume24h || null) }} USDT</b></div><div><span>市值{{ marketCapSource ? ` · ${marketCapSource}` : '' }}</span><b>{{ marketCapLoading ? '加载中…' : formatMarketCap(selectedMarketCap) }}</b></div></div>
          </header>
          <div class="chart-heading"><div><b>价格走势</b><span>{{ chartInterval }} · {{ chartBars.length }} 根 K 线</span></div><div class="periods chart-periods"><button v-for="item in [{id:'5m',label:'5分'},{id:'15m',label:'15分'},{id:'1h',label:'1小时'}] as const" :key="item.id" type="button" :class="{ active: chartInterval === item.id }" @click="chartInterval = item.id">{{ item.label }}</button></div></div>
          <div class="chart-wrap">
            <div v-if="chartLoading" class="chart-state">正在加载走势图…</div>
            <div v-else-if="chartError || !chartPoints.length" class="chart-state">{{ chartError || '暂无走势图数据' }}</div>
            <template v-else>
              <svg class="price-chart" viewBox="0 0 800 220" preserveAspectRatio="none" @pointermove="handleChartMove" @pointerleave="clearChartHover">
                <line v-for="y in [12,56,100,144,188]" :key="y" x1="12" :y1="y" x2="788" :y2="y" class="chart-gridline" />
                <path :d="`${chartPath} L 788 200 L 12 200 Z`" class="chart-area" />
                <path :d="chartPath" class="chart-line" />
                <line v-if="chartHover" :x1="chartPoints[chartHover.index]?.x" y1="8" :x2="chartPoints[chartHover.index]?.x" y2="200" class="chart-crosshair" />
                <circle v-if="chartHover" :cx="chartPoints[chartHover.index]?.x" :cy="chartPoints[chartHover.index]?.y" r="4" class="chart-point" />
              </svg>
              <div v-if="hoveredBar" class="chart-tooltip" :style="chartTooltipStyle"><b>{{ formatPrice(String(hoveredBar.close)) }} USDT</b><span>{{ formatChartDate(hoveredBar.openTime) }}</span></div>
              <div class="chart-axis"><span>{{ chartBars.length ? formatChartDate(chartBars[0].openTime) : '' }}</span><span>{{ chartBars.length ? formatChartDate(chartBars[chartBars.length - 1].openTime) : '' }}</span></div>
            </template>
          </div>
        </section>
      </section>

      <section class="market-panel">
        <header class="market-title"><div><h2>其他合约列表</h2><p>未关注的全部合约，按滚动 24 小时涨跌幅排序 · {{ filteredMarketRows.length }} 个标的</p></div><span class="source">Binance USDⓈ-M Futures · 全市场批量行情</span></header>
        <div class="table-wrap">
          <table>
            <thead><tr><th>合约</th><th>类别</th><th>最新价格</th><th>24 小时涨跌</th><th>状态</th><th class="follow-cell">关注</th></tr></thead>
            <tbody>
              <tr v-for="row in pagedMarketRows" :key="row.symbol" :class="{ chosen: selected === row.symbol, anomalous: row.change != null && Math.abs(row.change) >= Math.max(0, Number(anomalyThreshold) || 0) }" @click="selectSymbol(row.symbol)">
                <td><div class="contract-cell"><span class="asset-logo"><img v-if="!logoFailed(row.symbol)" :src="logoUrl(row.symbol)" :alt="`${assetLabel(row.symbol)} logo`" @error="markLogoFailed(row.symbol)"><span v-else>{{ assetLabel(row.symbol).slice(0, 2) }}</span></span><span><b>{{ assetLabel(row.symbol) }}</b><small>{{ row.symbol }}</small><small v-if="row.market.radarTier === 'VOLATILE'" class="tier-label">高波动观察</small></span></div></td>
                <td><span class="type-label" :class="assetType(row.symbol) === 'TRADFI' ? 'type-tradfi' : 'type-crypto'">{{ assetType(row.symbol) === 'TRADFI' ? '传统金融' : '虚拟币' }}</span></td>
                <td class="price-cell">{{ formatPrice(row.quote?.lastPrice) }}</td>
                <td :class="changeClass(changeValue(row.quote, '24h'))">{{ formatChange(changeValue(row.quote, '24h')) }}</td>
                <td><span v-if="row.quote?.stale" class="status stale">数据缓存</span><span v-else-if="row.change != null && Math.abs(row.change) >= Math.max(0, Number(anomalyThreshold) || 0)" class="status alert">波动异动</span><span v-else class="status normal">监控中</span></td>
                <td class="follow-cell"><button type="button" class="follow-icon" :class="{ active: isWatched(row.symbol) }" :aria-label="isWatched(row.symbol) ? `取消关注 ${row.symbol}` : `关注 ${row.symbol}`" :title="isWatched(row.symbol) ? '取消关注' : '加入关注'" @click.stop="toggleWatch(row.symbol)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.5 2.6 5.3 5.9.9-4.25 4.15 1 5.85L12 16.9l-5.25 2.8 1-5.85L3.5 9.7l5.9-.9L12 3.5Z"/></svg></button></td>
              </tr>
              <tr v-if="!filteredMarketRows.length"><td colspan="6" class="empty-row">{{ marketLoading ? '正在获取合约行情…' : anomalyOnly ? '暂无达到阈值的未关注合约，可调低异动阈值或取消异动筛选。' : '没有符合筛选条件的合约。' }}</td></tr>
            </tbody>
          </table>
        </div>
        <div v-if="marketPageCount > 1" class="pagination list-pagination"><button type="button" :disabled="marketPage <= 1" @click="marketPage--">上一页</button><span>{{ marketPage }} / {{ marketPageCount }}</span><button type="button" :disabled="marketPage >= marketPageCount" @click="marketPage++">下一页</button></div>
        <footer class="market-foot"><span>{{ marketError || `异动阈值：${Number(anomalyThreshold).toFixed(1)}% / 24 小时；行情更新于 ${quoteTimestamp}` }}</span><span>关注标的展示所选短周期变化；全市场列表采用批量滚动 24 小时行情，降低数据源请求量。</span></footer>
      </section>
    </main>

    <div v-if="addDialogVisible" class="dialog-shade" @click.self="addDialogVisible = false">
      <section class="radar-dialog add-dialog" role="dialog" aria-modal="true" aria-label="新增合约">
        <header class="dialog-header"><div><h2>新增合约</h2><p>从币安当前可交易的 USDT 永续合约中选择</p></div><button type="button" class="dialog-close" aria-label="关闭" @click="addDialogVisible = false">×</button></header>
        <label class="add-search"><span>⌕</span><input v-model="addSearch" type="search" placeholder="搜索代码或名称"></label>
        <p class="add-help">列表按 24 小时成交额排序；添加后会保存到本机关注列表，并加载实时行情、K 线和图标。</p>
        <div class="add-results">
          <p v-if="availableLoading" class="dialog-state">正在获取合约与行情…</p>
          <p v-else-if="availableError && !availableContracts.length" class="dialog-state error">{{ availableError }}</p>
          <p v-else-if="!availableMatches.length" class="dialog-state">没有匹配的可添加合约</p>
          <button v-for="contract in availableMatches" :key="contract.symbol" type="button" class="candidate-row" @click="addContract(contract)">
            <span class="asset-logo"><img v-if="!logoFailed(contract.symbol)" :src="logoUrl(contract.symbol)" :alt="`${assetLabel(contract.symbol)} logo`" @error="markLogoFailed(contract.symbol)"><span v-else>{{ assetLabel(contract.symbol).slice(0, 2) }}</span></span>
            <span class="candidate-name"><b>{{ assetLabel(contract.symbol) }}</b><small>{{ contract.symbol }} · {{ contract.assetType === 'TRADFI' ? '传统金融' : '虚拟币' }}</small></span>
            <span class="candidate-market"><b :class="changeClass(Number(contract.priceChangePercent))">{{ formatChange(contract.priceChangePercent == null ? null : Number(contract.priceChangePercent)) }}</b><small>24h · 成交额 {{ formatVolume(contract.quoteVolume24h) }} USDT</small></span>
            <span class="candidate-add">添加</span>
          </button>
        </div>
        <footer class="dialog-footer"><span>{{ availableError }}</span><button type="button" @click="addDialogVisible = false">关闭</button></footer>
      </section>
    </div>

    <div v-if="aiDialogVisible" class="dialog-shade ai-shade" @click.self="closeAiDialog">
      <section class="radar-dialog ai-dialog" role="dialog" aria-modal="true" :aria-label="`${assetLabel(aiSymbol)} AI 行情分析`">
        <header class="dialog-header"><div><h2>{{ assetLabel(aiSymbol) }} · AI 行情分析</h2><p>{{ aiSymbol }} · 结合行情与近期新闻，不做技术分析</p></div><button type="button" class="dialog-close" aria-label="关闭" @click="closeAiDialog">×</button></header>
        <div class="ai-market-context">{{ aiContextSummary || '正在收集行情与相关新闻…' }}</div>
        <section class="ai-news-evidence"><header><b>相关新闻依据</b><span>{{ aiNewsSource || (aiNewsError ? '新闻源暂不可用' : '正在检索…') }}</span></header><a v-for="(item, index) in aiNews.slice(0, 8)" :key="`${item.url}-${index}`" :href="item.url" target="_blank" rel="noopener noreferrer"><span><i>[新闻{{ index + 1 }}]</i> {{ item.title }}</span><small>{{ item.source || aiNewsSource }} · {{ item.publishedAt ? new Date(item.publishedAt).toLocaleString('zh-CN') : '时间未知' }}{{ item.summary ? ` · ${item.summary}` : '' }}</small></a><p v-if="!aiNews.length && aiContextText">{{ aiNewsError ? `暂时无法取得相关新闻：${aiNewsError}` : '没有找到近期相关报道，AI 会明确说明暂无新闻依据。' }}</p></section>
        <div ref="aiChatScroll" class="ai-chat-messages">
          <article v-for="(message, index) in aiMessages" :key="`${message.role}-${index}`" class="chat-message" :class="message.role">
            <b>{{ message.role === 'user' ? '你' : 'AI' }}</b><p>{{ message.content || (aiLoading || aiSending ? '正在生成…' : '暂无回复') }}</p>
          </article>
          <p v-if="!aiMessages.length && aiLoading" class="dialog-state">{{ aiStatus || 'AI 正在分析…' }}</p>
        </div>
        <p v-if="aiStatus && aiMessages.length" class="ai-status"><span class="live-dot" />{{ aiStatus }}</p>
        <p v-if="aiError" class="ai-error">{{ aiError }}</p>
        <form class="ai-composer" @submit.prevent="sendAiMessage">
          <textarea v-model="aiInput" rows="2" :disabled="!aiContextText || aiLoading || aiSending" placeholder="继续追问，例如：这次上涨更像短线挤仓还是趋势延续？" @keydown.enter.exact.prevent="sendAiMessage" />
          <button type="submit" :disabled="!aiInput.trim() || aiLoading || aiSending || !aiContextText">{{ aiSending ? '回复中…' : '发送' }}</button>
        </form>
      </section>
    </div>
  </div>
</template>

<style scoped>
.radar{--bg:#090e15;--surface:#0d141e;--surface2:#111a26;--line:#1d2938;--line-soft:#172230;--text:#e7edf5;--muted:#8593a6;--green:#34d399;--red:#fb7185;--gold:#d9b454;width:100%;height:100%;min-height:0;overflow:auto;background:var(--bg);color:var(--text);font-size:13px;font-variant-numeric:tabular-nums}.radar-head{position:sticky;top:0;z-index:3;min-height:66px;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 22px;border-bottom:1px solid var(--line);background:#0a1018}.brand,.brand>div,.head-status,.focus-instrument,.focus-instrument>div,.market-title,.market-title>div{display:flex;align-items:center}.brand{gap:11px}.brand-mark{width:35px;height:35px;display:grid;place-items:center;border:1px solid #6c5927;border-radius:9px;background:#2a2314;color:var(--gold);font-weight:900;font-size:17px}.brand>div{align-items:flex-start;flex-direction:column;gap:2px}.brand h1,.market-title h2,.leader-panel h2{margin:0;font-size:16px;font-weight:800}.brand p,.market-title p{margin:0;color:var(--muted);font-size:11px}.head-status{gap:9px;color:#aeb9c8;font-size:11px}.live-dot,.leader-dot{width:7px;height:7px;border-radius:50%;background:var(--green)}.updated{margin-left:7px;color:var(--muted)}.refresh{height:30px;padding:0 11px;border:1px solid #334152;border-radius:6px;background:#131c28;color:var(--text);font:inherit;font-weight:700;cursor:pointer}.refresh:hover{border-color:#72829a}.refresh:disabled{opacity:.55;cursor:wait}.radar-content{max-width:1600px;margin:auto;padding:13px 18px 22px}.focus-bar{display:grid;grid-template-columns:1.4fr 1fr 1fr 1fr;align-items:center;gap:14px;min-height:90px;padding:12px 16px;border:1px solid var(--line);border-radius:9px;background:var(--surface)}.focus-instrument{gap:11px}.focus-instrument>div{align-items:flex-start;flex-direction:column;gap:4px}.focus-instrument b{font-size:16px}.focus-instrument>div span,.focus-price>span,.focus-change>span{color:var(--muted);font-size:10px}.asset-badge{width:35px;height:35px;display:grid;place-items:center;border-radius:9px;font-size:12px;font-weight:900}.asset-badge.crypto{background:#16283a;color:#73b8ff}.asset-badge.traditional{background:#2c2515;color:var(--gold)}.focus-price,.focus-change{display:flex;flex-direction:column;gap:4px;padding-left:15px;border-left:1px solid var(--line)}.focus-price b,.focus-change b{font-size:19px}.focus-change b{font-size:18px}.positive{color:var(--green)!important}.negative{color:var(--red)!important}.neutral{color:var(--muted)!important}.toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 1px}.filters,.periods{display:flex;gap:4px;padding:3px;border:1px solid var(--line);border-radius:7px;background:var(--surface)}.filters button,.periods button{height:27px;padding:0 10px;border:0;border-radius:5px;background:transparent;color:#95a2b4;font:inherit;font-size:11px;font-weight:700;cursor:pointer}.filters button:hover,.periods button:hover{color:var(--text)}.filters button.active,.periods button.active{background:#263244;color:#f2f5fa}.periods button.active{color:#f1cf74}.search{height:33px;display:flex;align-items:center;gap:7px;min-width:160px;padding:0 9px;border:1px solid var(--line);border-radius:6px;background:var(--surface)}.search span{color:#718096;font-size:18px}.search input{width:155px;border:0;outline:0;background:transparent;color:var(--text);font:inherit;font-size:11px}.search input::placeholder{color:#718096}.threshold{display:flex;align-items:center;gap:6px;color:#adb8c7;font-size:11px;cursor:pointer}.threshold input{accent-color:#d9b454;cursor:pointer}.threshold-value{height:30px;display:flex;align-items:center;gap:5px;padding:0 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--muted);font-size:11px}.threshold-value input{width:45px;border:0;outline:0;background:transparent;color:var(--text);font:inherit}.leader-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:11px}.leader-panel,.market-panel{min-width:0;border:1px solid var(--line-soft);border-radius:8px;background:var(--surface)}.leader-panel{padding:0 12px 5px}.leader-panel>header{height:39px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line-soft);color:var(--muted);font-size:10px}.leader-panel>header>div{display:flex;align-items:center;gap:8px}.leader-panel h2{font-size:12px}.up-dot{background:var(--green)}.down-dot{background:var(--red)}.leader-row{width:100%;min-height:38px;display:grid;grid-template-columns:28px minmax(95px,1fr) minmax(75px,auto) minmax(70px,auto);align-items:center;gap:8px;padding:4px 2px;border:0;border-bottom:1px solid #151f2b;background:transparent;color:var(--text);text-align:left;font:inherit;cursor:pointer}.leader-row:last-of-type{border-bottom:0}.leader-row:hover,.leader-row.selected{background:#141e2b}.rank{color:#66768b;font-size:10px}.leader-name{display:flex;min-width:0;flex-direction:column;gap:2px}.leader-name b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.leader-name small{color:var(--muted);font-size:9px}.leader-price{color:#c5ceda;font-size:10px;text-align:right}.leader-change{text-align:right;font-size:12px}.leader-empty{padding:14px 2px;color:var(--muted);font-size:11px}.market-title{justify-content:space-between;gap:12px;padding:12px 14px;border-bottom:1px solid var(--line-soft)}.market-title>div{align-items:flex-start;flex-direction:column;gap:4px}.market-title h2{font-size:13px}.source{color:var(--muted);font-size:10px}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;white-space:nowrap}thead{background:#0b121b}th{height:35px;padding:0 12px;color:#8290a4;font-size:10px;font-weight:700;text-align:right}th:first-child,td:first-child{text-align:left;padding-left:14px}th:nth-child(2){text-align:left}td{height:45px;padding:0 12px;border-top:1px solid #141f2d;color:#c6d0dd;font-size:11px;text-align:right}tbody tr{cursor:pointer}tbody tr:hover{background:#111a25}tbody tr.chosen{background:#141e2a}tbody tr.anomalous td:first-child{box-shadow:inset 2px 0 #d9b454}.contract-cell{display:flex;align-items:center;gap:9px}.asset-badge.small{width:27px;height:27px;border-radius:7px;font-size:9px}.contract-cell>span:last-child{display:flex;flex-direction:column;gap:3px}.contract-cell b{font-size:11px}.contract-cell small{color:var(--muted);font-size:9px}.type-label{padding:3px 6px;border-radius:4px;font-size:9px}.type-crypto{background:#152337;color:#82baff}.type-tradfi{background:#2a2416;color:#dfc16b}.price-cell{color:#e0e6ef}.status{display:inline-flex;align-items:center;padding:3px 6px;border-radius:4px;font-size:9px}.status.normal{background:#14231f;color:#7dc8a3}.status.alert{background:#302817;color:#e0c46c}.status.stale{background:#29212a;color:#c4a3ca}.empty-row{height:95px;text-align:center!important;color:var(--muted)}.market-foot{display:flex;justify-content:space-between;gap:14px;padding:9px 13px;border-top:1px solid var(--line-soft);color:#738196;font-size:9px;line-height:1.5}@media(max-width:850px){.radar-head{align-items:flex-start;flex-direction:column;padding:11px 14px}.head-status{flex-wrap:wrap}.updated{margin-left:0}.radar-content{padding:10px}.focus-bar{grid-template-columns:1fr 1fr}.focus-price,.focus-change{padding-left:10px}.leader-grid{grid-template-columns:1fr}.toolbar{gap:7px}.market-foot{flex-direction:column}}@media(max-width:560px){.focus-bar{grid-template-columns:1fr 1fr;gap:10px}.focus-instrument{grid-column:1/-1}.focus-price{padding-left:0;border-left:0}.filters,.periods{max-width:100%;overflow:auto}.filters button,.periods button{padding:0 7px}.search{flex:1}.search input{width:100%;min-width:40px}.source{display:none}th,td{padding:0 8px}.market-title{padding:11px}}
.radar{
  overflow-x:hidden;
  overflow-y:auto;
  overscroll-behavior:contain;
  scrollbar-gutter:stable;
}
.watch-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(185px,1fr));gap:8px;padding:10px}
.watch-card{min-width:0;display:flex;flex-direction:column;align-items:stretch;gap:5px;padding:10px 11px;border:1px solid #223044;border-radius:7px;background:#101925;color:var(--text);text-align:left;font:inherit;cursor:pointer;transition:border-color .15s,background .15s}
.watch-card:hover,.watch-card.chosen{border-color:#6d5929;background:#171e27}
.watch-card-top,.watch-card-bottom{display:flex;align-items:center;gap:6px}
.watch-card-top{justify-content:space-between}
.watch-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:800}
.watch-price{font-size:16px;line-height:1.2}
.watch-symbol{color:var(--muted);font-size:9px}
.watch-card-bottom{justify-content:space-between;padding-top:6px;border-top:1px solid var(--line-soft);color:var(--muted);font-size:9px}
.watch-card-bottom b{font-size:10px}
.watch-empty{padding:14px;color:var(--muted);font-size:11px}
.radar{display:flex;flex-direction:column;overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable;overscroll-behavior:contain}
.radar-content{width:min(100%,1600px);box-sizing:border-box;flex:none}
.head-actions{display:flex;align-items:center;gap:10px}
.watch-layout{display:grid;grid-template-columns:minmax(300px,.85fr) minmax(380px,1.35fr);align-items:stretch;gap:10px}
.watch-panel,.selected-panel{min-width:0;overflow:hidden}
.watch-cards{grid-template-columns:repeat(auto-fill,minmax(145px,1fr));align-content:start;min-height:80px}
.watch-card{position:relative;min-height:98px;padding:0;overflow:hidden}
.watch-select{width:100%;height:100%;display:flex;flex-direction:column;justify-content:space-between;gap:10px;padding:11px 34px 10px 10px;border:0;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}
.watch-card-top{min-width:0;justify-content:flex-start}
.watch-name{display:flex;min-width:0;flex:1;flex-direction:column;gap:3px}
.watch-name small{color:var(--muted);font-size:9px;font-weight:500}
.watch-change{margin-left:auto;font-size:11px;white-space:nowrap}
.watch-card-bottom{width:100%;justify-content:space-between;gap:5px;font-size:9px;white-space:nowrap}
.watch-card-bottom span{overflow:hidden;text-overflow:ellipsis}
.follow-icon{width:28px;height:28px;display:grid;place-items:center;flex:none;padding:0;border:1px solid #2a3646;border-radius:6px;background:#111a26;color:#8c9aab;cursor:pointer}
.follow-icon:hover{border-color:#d2b35d;color:#e7cc76}
.follow-icon.active{border-color:#65542c;background:#2a2417;color:#e6c968}
.follow-icon svg{width:15px;height:15px;fill:transparent;stroke:currentColor;stroke-width:1.8;stroke-linejoin:round}
.follow-icon.active svg{fill:currentColor}
.watch-card>.follow-icon{position:absolute;top:7px;right:7px;width:23px;height:23px;border:0;background:transparent}
.watch-card>.follow-icon svg{width:14px;height:14px}
.asset-logo{width:27px;height:27px;display:grid;place-items:center;flex:none;overflow:hidden;border:1px solid #2b394b;border-radius:50%;background:#182333;color:#a9c8f0;font-size:9px;font-weight:800}
.asset-logo img{width:100%;height:100%;object-fit:cover}
.asset-logo.large{width:36px;height:36px;font-size:11px}
.selected-summary{padding:13px 14px;border-bottom:1px solid var(--line-soft)}
.selected-name{display:flex;align-items:center;gap:9px}
.selected-name>span:nth-child(2){display:flex;min-width:0;flex-direction:column;gap:3px}
.selected-name>span:nth-child(2) b{font-size:14px}
.selected-name small{color:var(--muted);font-size:10px}
.selected-name .follow-icon{margin-left:auto}
.selected-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:14px}
.selected-metrics>div{display:flex;min-width:0;flex-direction:column;gap:5px;padding-left:10px;border-left:1px solid var(--line)}
.selected-metrics>div:first-child{padding-left:0;border-left:0}
.selected-metrics span{color:var(--muted);font-size:9px}
.selected-metrics b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}
.chart-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px 0}
.chart-heading>div:first-child{display:flex;align-items:baseline;gap:8px}
.chart-heading b{font-size:11px}
.chart-heading span{color:var(--muted);font-size:9px}
.chart-periods{flex:none}
.chart-periods button{height:23px;padding:0 8px;font-size:9px}
.chart-wrap{position:relative;min-height:210px;padding:7px 12px 25px}
.price-chart{width:100%;height:190px;display:block;overflow:visible;touch-action:pan-y}
.chart-gridline{stroke:#1c2938;stroke-width:1;vector-effect:non-scaling-stroke}
.chart-area{fill:rgba(75,150,220,.09);stroke:none}
.chart-line{fill:none;stroke:#67b5ff;stroke-width:2;vector-effect:non-scaling-stroke}
.chart-crosshair{stroke:#d5b85f;stroke-width:1;stroke-dasharray:4 4;vector-effect:non-scaling-stroke}
.chart-point{fill:#f0d16e;stroke:#111923;stroke-width:2;vector-effect:non-scaling-stroke}
.chart-tooltip{position:absolute;z-index:2;display:flex;flex-direction:column;gap:4px;min-width:130px;padding:8px 10px;border:1px solid #4b627d;border-radius:6px;background:rgba(9,15,23,.96);box-shadow:0 6px 18px #0006;pointer-events:none;transform:translate(-50%,0)}
.chart-tooltip b{color:#edf5ff;font-size:11px}
.chart-tooltip span{color:#aab8c9;font-size:9px}
.chart-axis{position:absolute;right:13px;bottom:7px;left:13px;display:flex;justify-content:space-between;color:var(--muted);font-size:9px}
.chart-state{height:190px;display:grid;place-items:center;color:var(--muted);font-size:11px}
.pagination{display:flex;align-items:center;justify-content:center;gap:10px;padding:8px 10px;border-top:1px solid var(--line-soft);color:var(--muted);font-size:10px}
.pagination button{height:25px;padding:0 9px;border:1px solid #2a3646;border-radius:5px;background:#111a26;color:#c5d0de;font:inherit;cursor:pointer}
.pagination button:disabled{opacity:.4;cursor:not-allowed}
.list-pagination{border-top:0;border-bottom:1px solid var(--line-soft)}
.follow-cell{width:54px;text-align:center!important}
.tier-label{width:max-content;padding:2px 5px;border-radius:4px;background:#2b2119;color:#e5a76f!important;font-size:9px!important}
th.follow-cell,td.follow-cell{padding:0 8px;text-align:center}
@media(max-width:980px){.watch-layout{grid-template-columns:minmax(0,1fr)}.watch-cards{grid-template-columns:repeat(auto-fill,minmax(165px,1fr))}}
@media(max-width:560px){.radar-content{padding:9px}.watch-cards{grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;padding:8px}.watch-card{min-height:94px}.selected-metrics{gap:5px}.selected-metrics>div{padding-left:6px}.selected-metrics b{font-size:12px}.chart-wrap{padding-right:7px;padding-left:7px}.market-foot{flex-direction:column}.direction-filter{max-width:100%;overflow:auto}}
.radar-content{width:100%;max-width:none;margin:0;padding-right:0;padding-left:0}
.toolbar{padding-right:0;padding-left:0}
.watch-card{min-height:112px}
.watch-select{gap:12px;padding:13px 38px 12px 12px}
.watch-name{font-size:13px}
.watch-name small{font-size:11px}
.watch-change{font-size:13px}
.watch-card-bottom{font-size:11px}
.watch-card-bottom b{font-size:12px}
.asset-logo{width:31px;height:31px;font-size:10px}
.market-title h2{font-size:15px}
.market-title p{font-size:12px}
.table-wrap th,.table-wrap td{height:54px;text-align:center;font-size:13px;vertical-align:middle}
.table-wrap th{height:42px;font-size:12px}
.table-wrap th:first-child,.table-wrap td:first-child{padding-left:12px;text-align:center}
.table-wrap .contract-cell{justify-content:center}
.table-wrap .contract-cell b{font-size:13px}
.table-wrap .contract-cell small{font-size:11px}
.table-wrap .type-label,.table-wrap .status{font-size:11px}
.table-wrap .follow-cell{width:72px;text-align:center}
.pagination{font-size:12px}
.pagination button{height:30px;padding:0 12px}
.watch-layout{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}
.watch-cards{grid-template-columns:repeat(auto-fill,minmax(175px,1fr));gap:10px}
.watch-card{min-height:128px}
.watch-select{padding:15px 40px 14px 14px}
.watch-name{font-size:14px}
.watch-change{font-size:14px}
.watch-card-bottom{font-size:12px}
.watch-card-bottom b{font-size:13px}
.asset-logo{width:34px;height:34px}
.table-wrap th:first-child,.table-wrap td:first-child{text-align:left;padding-left:20px}
.table-wrap .contract-cell{justify-content:flex-start}
.add-contract-button{height:32px;padding:0 13px;border:1px solid #65542c;border-radius:6px;background:#282315;color:#e6c968;font:inherit;font-weight:700;cursor:pointer}
.add-contract-button:hover{border-color:#d2b35d;background:#342d1b}
.watch-panel,.selected-panel{min-height:540px}
.watch-cards{grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px}
.watch-card{min-height:170px}
.watch-select{padding-bottom:44px}
.watch-ai-button{position:absolute;right:9px;bottom:9px;height:27px;padding:0 11px;border:1px solid #354760;border-radius:5px;background:#172538;color:#a9d0ff;font:inherit;font-size:11px;font-weight:700;cursor:pointer}
.watch-ai-button:hover{border-color:#5798dc;background:#1b2d43}
.watch-ai-button:disabled{opacity:.6;cursor:wait}
.chart-wrap{min-height:330px}
.price-chart{height:300px}
.chart-state{height:300px}
.selected-metrics{grid-template-columns:repeat(5,minmax(0,1fr))}
@media(max-width:720px){.selected-metrics{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(max-width:560px){.selected-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
.watch-layout{grid-template-columns:minmax(0,45fr) minmax(0,55fr)}
.watch-cards{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding:8px}
.watch-panel>.pagination{gap:7px;padding:4px 7px;font-size:11px}
.watch-panel>.pagination button{height:24px;padding:0 8px}
@media(max-width:980px){.watch-layout{grid-template-columns:minmax(0,1fr)}}
@media(max-width:720px){.watch-cards{grid-template-columns:repeat(2,minmax(0,1fr))}}
.dialog-shade{position:fixed;inset:0;z-index:1500;display:grid;place-items:center;padding:20px;background:rgba(2,6,12,.76);backdrop-filter:blur(4px)}
.radar-dialog{width:min(720px,96vw);max-height:min(84vh,820px);display:flex;flex-direction:column;overflow:hidden;border:1px solid #2a394d;border-radius:12px;background:#0d141e;color:var(--text);box-shadow:0 20px 70px #0009}
.dialog-header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:17px 20px;border-bottom:1px solid var(--line)}
.dialog-header h2{margin:0;font-size:17px}
.dialog-header p{margin:5px 0 0;color:var(--muted);font-size:11px}
.dialog-close{width:32px;height:32px;border:1px solid #2a394d;border-radius:6px;background:#111a26;color:#c5ceda;font-size:22px;cursor:pointer}
.add-search{display:flex;align-items:center;gap:8px;height:39px;margin:15px 18px 6px;padding:0 11px;border:1px solid #2b394c;border-radius:7px;background:#0a111a}
.add-search span{color:#8190a4;font-size:19px}
.add-search input{width:100%;border:0;outline:0;background:transparent;color:var(--text);font:inherit}
.add-help{margin:4px 20px 10px;color:var(--muted);font-size:11px}
.add-results{min-height:120px;overflow:auto;border-top:1px solid var(--line-soft)}
.candidate-row{width:100%;min-height:62px;display:flex;align-items:center;gap:12px;padding:8px 20px;border:0;border-bottom:1px solid #182331;background:transparent;color:var(--text);text-align:left;font:inherit;cursor:pointer}
.candidate-row:hover{background:#141f2d}
.candidate-name,.candidate-market{display:flex;min-width:0;flex-direction:column;gap:4px}
.candidate-name{flex:1}
.candidate-name b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.candidate-name small,.candidate-market small{color:var(--muted);font-size:10px}
.candidate-market{text-align:right}
.candidate-market b{font-size:12px}
.candidate-add{padding:5px 10px;border:1px solid #65542c;border-radius:5px;color:#e6c968;font-size:11px}
.dialog-state{padding:28px 16px;color:var(--muted);text-align:center;font-size:12px}
.dialog-state.error,.ai-error{color:#fda4af}
.dialog-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:48px;padding:8px 18px;border-top:1px solid var(--line-soft);color:var(--muted);font-size:11px}
.dialog-footer button{height:30px;padding:0 14px;border:1px solid #344356;border-radius:5px;background:#141e2b;color:var(--text);cursor:pointer}
.ai-dialog{width:min(860px,96vw);height:min(82vh,800px)}
.ai-market-context{max-height:120px;overflow:auto;padding:11px 18px;border-bottom:1px solid var(--line-soft);background:#0a1119;color:#aab7c8;font-size:10px;line-height:1.6;white-space:pre-wrap}
.ai-news-evidence{max-height:150px;overflow:auto;padding:8px 18px;border-bottom:1px solid var(--line-soft);background:#0c131d}
.ai-news-evidence header{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:5px;color:#d9e2ed;font-size:10px}
.ai-news-evidence header span,.ai-news-evidence a small{color:var(--muted);font-size:9px}
.ai-news-evidence a{display:flex;flex-direction:column;gap:3px;padding:5px 0;border-top:1px solid #172230;color:#b8d6fa;text-decoration:none;font-size:10px;line-height:1.45}
.ai-news-evidence a:hover{color:#e6c968}
.ai-news-evidence a small{color:var(--muted)}
.ai-news-evidence p{margin:6px 0 2px;color:var(--muted);font-size:10px}
.ai-chat-messages{flex:1;min-height:100px;overflow:auto;padding:16px 18px}
.chat-message{max-width:90%;margin:0 0 13px;padding:11px 13px;border:1px solid #243247;border-radius:8px;background:#111a26}
.chat-message.user{margin-left:auto;border-color:#35517a;background:#14233a}
.chat-message>b{color:#9dc5ff;font-size:11px}
.chat-message>p{margin:6px 0 0;color:#dce5f1;font-size:13px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}
.ai-status{display:flex;align-items:center;gap:8px;margin:0;padding:0 18px 8px;color:var(--muted);font-size:11px}
.ai-status .live-dot{flex:none}
.ai-error{margin:0;padding:5px 18px 8px;font-size:11px}
.ai-composer{display:flex;align-items:flex-end;gap:9px;padding:12px 15px;border-top:1px solid var(--line)}
.ai-composer textarea{flex:1;min-height:46px;max-height:120px;resize:vertical;padding:10px;border:1px solid #2b394c;border-radius:7px;outline:0;background:#0a1119;color:var(--text);font:inherit;font-size:12px;line-height:1.5}
.ai-composer textarea:focus{border-color:#527fb5}
.ai-composer button{height:38px;padding:0 17px;border:1px solid #5579a5;border-radius:6px;background:#203653;color:#e2efff;font:inherit;font-weight:700;cursor:pointer}
.ai-composer button:disabled{opacity:.45;cursor:not-allowed}
@media(max-width:980px){.watch-layout{grid-template-columns:minmax(0,1fr)}}
@media(max-width:720px){.watch-panel,.selected-panel{min-height:480px}.watch-cards{grid-template-columns:repeat(2,minmax(0,1fr))}.dialog-shade{padding:8px}.radar-dialog{width:100%;max-height:92vh}.ai-dialog{height:90vh}.candidate-row{gap:8px;padding:8px 12px}.candidate-market small{max-width:135px;white-space:normal;text-align:right}}
</style>
