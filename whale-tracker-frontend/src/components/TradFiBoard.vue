<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch as watchVue } from 'vue';
import { radarClient, sortRadarRows } from '@/utils/radarRealtime';
import { scrollRadarToTop } from '@/utils/radarScroll';
import { contractLogo } from '@/utils/contractLogo';
import CandlestickChart from './CandlestickChart.vue';
import ContractDetailLink from './ContractDetailLink.vue';
import RadarLongTrend from '@/components/RadarLongTrend.vue';
import { ElMessage } from 'element-plus';
import { fetchRadarMarketCap, fetchRadarNews, streamChatMarketBrief, type MarketChatMessage, type RadarAvailableContract, type RadarKline, type RadarNewsItem, type TradFiMarketSymbol, type TradFiQuote } from '@/api';
import { DEFAULT_RADAR_WATCH, isDefaultRadarWatch, tradfiWatch, writeTradFiWatch } from '@/utils/tradfiWatch';

const props = withDefaults(defineProps<{ active?: boolean }>(), { active: true });
type RadarInterval = '24h' | '1h' | '5m';
type AssetFilter = 'ALL' | 'CRYPTO' | 'TRADFI';
type DirectionFilter = 'ALL' | 'UP' | 'DOWN';
const trendView = ref<'short' | 'long'>('short');
const trendViews = [
  { id: 'short', label: '短期趋势' },
  { id: 'long', label: '长期趋势' },
] as const;
function handleTrendTabKey(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  trendView.value = event.key === 'Home' ? 'short' : event.key === 'End' ? 'long' : trendView.value === 'short' ? 'long' : 'short';
  void nextTick(() => document.getElementById(`radar-${trendView.value}-tab`)?.focus());
}
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
const directionFilter = ref<DirectionFilter>('ALL');
const watchPage = ref(1);
const marketPage = ref(1);
const marketSort=ref<'absoluteChange'|'price'|'change'>('absoluteChange');
const marketOrder=ref<'asc'|'desc'>('desc');
function sortMarket(key:'price'|'change'){
  if(marketSort.value===key)marketOrder.value=marketOrder.value==='desc'?'asc':'desc';
  else {marketSort.value=key;marketOrder.value='desc';}
}
watchVue([marketSort,marketOrder],()=>{marketPage.value=1;});
const chartInterval = ref<'5m' | '1h'>('1h');
const chartBars = ref<RadarKline[]>([]);
const chartLoading = ref(false);
const chartError = ref('');
const selectedMarketCap = ref<string | null>(null);
const marketCapSource = ref('');
const marketCapLoading = ref(false);
const failedLogos = ref(new Set<string>());
const WATCH_PAGE_SIZE = 6;
const MARKET_PAGE_SIZE = 10;
let started = false;
let initialLoad: Promise<void> | null = null;

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
  { id: '5m', label: '5 分钟' },
];

function changeValue(quote: TradFiQuote | undefined, interval: RadarInterval): number | null {
  if (!quote) return null;
  const raw = interval === '24h' ? quote.priceChangePercent : quote.changes?.[interval];
  if (raw == null || raw === '' || !Number.isFinite(Number(raw))) return null;
  return Number(raw);
}
function isQuoteStale(quote:TradFiQuote|undefined){
  return Boolean(!radarClient.connected.value||quote?.stale||(activeInterval.value!=='24h'
    &&(quote?.changeMeta?.[activeInterval.value]?.stale||quote?.shortStale)));
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
    .sort((a, b) => Math.abs(b.change ?? 0) - Math.abs(a.change ?? 0));
});
const filteredMarketRows = computed(() => {
  const query = searchText.value.trim().toLocaleLowerCase();
  const watched = new Set(watch.value);
  const rows=Object.keys(marketQuotes.value).map(symbol=>catalogBySymbol.value.get(symbol)).filter((market):market is TradFiMarketSymbol=>Boolean(market))
    .filter((market) => !watched.has(market.symbol))
    .filter((market) => assetFilter.value === 'ALL' || market.assetType === assetFilter.value)
    .filter((market) => !query || `${market.symbol} ${market.baseAsset} ${market.name}`.toLocaleLowerCase().includes(query))
    .map((market) => ({ symbol: market.symbol, market, quote: marketQuotes.value[market.symbol], change: changeValue(marketQuotes.value[market.symbol], activeInterval.value) }))
    .filter((row) => directionFilter.value === 'ALL' || (directionFilter.value === 'UP' ? (row.change ?? -Infinity) > 0 : (row.change ?? Infinity) < 0));
  return sortRadarRows(rows,row=>marketSort.value==='price'?row.quote?.lastPrice:marketSort.value==='change'?row.change:row.change==null?null:Math.abs(row.change),marketOrder.value);
});
const pagedWatchRows = computed(() => filteredRows.value.slice((watchPage.value - 1) * WATCH_PAGE_SIZE, watchPage.value * WATCH_PAGE_SIZE));
const pagedMarketRows = computed(() => filteredMarketRows.value.slice((marketPage.value - 1) * MARKET_PAGE_SIZE, marketPage.value * MARKET_PAGE_SIZE));
const watchPageCount = computed(() => Math.max(1, Math.ceil(filteredRows.value.length / WATCH_PAGE_SIZE)));
const marketPageCount = computed(() => Math.max(1, Math.ceil(filteredMarketRows.value.length / MARKET_PAGE_SIZE)));
const selectedRange = computed(() => {
  const quote = selectedQuote.value || selectedMarketQuote.value;
  if (activeInterval.value === '24h') return { high: quote?.highPrice24h, low: quote?.lowPrice24h, stale: isQuoteStale(quote || undefined) };
  const range = quote?.changeMeta?.[activeInterval.value];
  return { high: range?.highPrice == null ? null : String(range.highPrice), low: range?.lowPrice == null ? null : String(range.lowPrice),
    stale: isQuoteStale(quote || undefined) || range?.rangeStale !== false };
});
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
// Quote refreshes rebuild and sort rows; they must not reset navigation.
watchVue([directionFilter, assetFilter, searchText], () => {
  watchPage.value = 1;
  marketPage.value = 1;
});
watchVue(activeInterval, () => {
  watchPage.value = 1;
  marketPage.value = 1;
});
watchVue(watchPageCount, (count) => { watchPage.value = Math.min(watchPage.value, count); });
watchVue(marketPageCount, (count) => { marketPage.value = Math.min(marketPage.value, count); });

function isWatched(symbol: string) { return watch.value.some((item) => item.toUpperCase() === symbol.toUpperCase()); }
function toggleWatch(symbol: string) {
  if (isWatched(symbol)) {
    if (watch.value.length <= 1) { ElMessage.warning('至少保留 1 个关注合约'); return; }
    writeTradFiWatch(watch.value.filter((item) => item !== symbol));
    if (selected.value === symbol) selected.value = watch.value.find((item) => item !== symbol) || 'BTCUSDT';
    return;
  }
  if (watch.value.length >= 30) { ElMessage.warning('最多关注 30 个合约'); return; }
  writeTradFiWatch([...watch.value, symbol]);
}
async function openAddContractDialog() {
  addDialogVisible.value = true;addSearch.value = '';
  availableLoading.value=true;
  await radarClient.ensure();
  availableContracts.value = catalog.value.map(contract=>({...contract,lastPrice:quotes.value[contract.symbol]?.lastPrice??null,
    priceChangePercent:quotes.value[contract.symbol]?.priceChangePercent??null,quoteVolume24h:quotes.value[contract.symbol]?.quoteVolume24h??null}));
  availableLoading.value=false;availableError.value=radarClient.error.value;
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
  const market=catalogBySymbol.value.get(symbol)||availableContracts.value.find(item=>item.symbol===symbol);
  return contractLogo(symbol,assetType(symbol),market?.baseAsset);
}
function logoFailed(symbol: string) { return failedLogos.value.has(symbol); }
function markLogoFailed(symbol: string) { failedLogos.value = new Set(failedLogos.value).add(symbol); }
async function loadChart(_silent = false) {
  radarClient.selectChart(selected.value,chartInterval.value);
  applyChart();
}
function applyChart(){
  const result=radarClient.charts.value[`${selected.value}:${chartInterval.value}`];
  chartLoading.value=!result;
  chartBars.value=result?.bars||[];
  chartError.value=result?.error||(result?.stale?'行情源暂不可用，当前为缓存走势':'');
}
watchVue(radarClient.charts,applyChart);

let capRequestId = 0;
async function loadMarketCap(symbol: string, silent = false) {
  const requestId = ++capRequestId;
  if (!silent) {
    selectedMarketCap.value = null;
    marketCapSource.value = '';
  }
  marketCapLoading.value = !silent;
  try {
    const result = await fetchRadarMarketCap(symbol);
    if (requestId !== capRequestId || selected.value !== symbol) return;
    selectedMarketCap.value = result.marketCapUsd;
    marketCapSource.value = `${result.source || ''}${result.stale ? ' · 缓存数据' : ''}`;
  } catch {
    if (requestId === capRequestId && selected.value === symbol) marketCapSource.value = silent && selectedMarketCap.value != null ? '更新失败 · 保留上次数据' : '';
  } finally {
    if (requestId === capRequestId && selected.value === symbol) marketCapLoading.value = false;
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
      Promise.resolve({quotes:quotes.value[symbol]?[quotes.value[symbol]]:[]}),
      fetchRadarNews(symbol).catch((error) => ({
        symbol, items: [], source: '', updatedAt: '', error: error instanceof Error ? error.message : '相关新闻获取失败',
      })),
    ]);
    if (sequence !== aiRequestSeq) return;
    const quote = quoteResult.quotes.find((item) => item.symbol === symbol) || quotes.value[symbol];
    const changeLines = (activeInterval.value === '24h' ? [] : [activeInterval.value]).map((interval) => {
      const value = quote?.changes?.[interval as '5m' | '1h'];
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

function syncSnapshot(){
  const frame=radarClient.state.value;if(!frame)return;
  catalog.value=frame.catalog;
  quotes.value=Object.fromEntries(frame.quotes.map(quote=>[quote.symbol,quote]));
  const visible=new Set(frame.marketSymbols);
  marketQuotes.value=Object.fromEntries(frame.quotes.filter(quote=>visible.has(quote.symbol)).map(quote=>[quote.symbol,quote]));
  updatedAt.value=frame.updatedAt||'';
  marketError.value=frame.error||radarClient.error.value;
  marketLoading.value=!frame.catalog.length;
  if(frame.catalog.length&&isDefaultRadarWatch(watch.value)){
    const defaults=recommendedWatch(frame.catalog);if(defaults.length)writeTradFiWatch(defaults);
  }
  radarClient.setWatches(watch.value);
  if(started && frame.catalog.some(row=>row.symbol===selected.value) && !radarClient.charts.value[`${selected.value}:${chartInterval.value}`])void loadChart();
}
watchVue(radarClient.state,syncSnapshot);
watchVue(radarClient.error,value=>{marketError.value=value||radarClient.state.value?.error||'';});
function selectListSymbol(symbol:string,event:MouseEvent) {
  selectSymbol(symbol);
  scrollRadarToTop(event.currentTarget as Element);
}
function selectSymbol(symbol: string) {
  selected.value = symbol;
}
watchVue(watch, (symbols) => {
  radarClient.setWatches(symbols);
  if (!symbols.includes(selected.value)) selected.value = symbols[0] || 'BTCUSDT';
});
watchVue(() => [selected.value, chartInterval.value] as const, () => { chartBars.value = []; if (started) void loadChart(); });
watchVue(selected, (symbol) => { if (started) void loadMarketCap(symbol); });
watchVue(()=>props.active,value=>radarClient.setActive(value),{immediate:true});
function initialize() {
  return initialLoad ||= (async()=>{
    radarClient.setActive(props.active);
    await radarClient.ensure();syncSnapshot();
    if(!watch.value.includes(selected.value))selected.value=watch.value[0]||'BTCUSDT';
    started=true;
    await Promise.allSettled([loadChart(),loadMarketCap(selected.value)]);
  })();
}
defineExpose({ initialize });
onUnmounted(()=>{
  radarClient.setActive(false);capRequestId++;started=false;
  aiRequestSeq++;aiAbort?.abort();
});
</script>

<template>
  <div class="radar">
    <main class="radar-content">
      <nav class="trend-tabs" role="tablist" aria-label="雷达趋势范围" @keydown="handleTrendTabKey">
        <button v-for="view in trendViews" :id="`radar-${view.id}-tab`" :key="view.id" type="button" role="tab"
          :aria-selected="trendView === view.id" :aria-controls="`radar-${view.id}-panel`"
          :tabindex="trendView === view.id ? 0 : -1" :class="{ active: trendView === view.id }"
          @click="trendView = view.id">{{ view.label }}</button>
      </nav>
      <div v-show="trendView === 'short'" id="radar-short-panel" role="tabpanel" aria-labelledby="radar-short-tab">
      <section class="toolbar" aria-label="行情筛选和排序">
        <div class="filters">
          <button v-for="item in categories" :key="item.id" type="button" :class="{ active: assetFilter === item.id }" @click="assetFilter = item.id">{{ item.label }}</button>
        </div>
        <div class="periods" aria-label="榜单周期">
          <button v-for="item in intervals" :key="item.id" type="button" :class="{ active: activeInterval === item.id }" @click="activeInterval = item.id">{{ item.label }}</button>
        </div>
        <div class="periods direction-filter" aria-label="涨跌类型"><button v-for="item in [{id:'ALL',label:'涨跌全部'},{id:'UP',label:'涨幅'},{id:'DOWN',label:'跌幅'}] as const" :key="item.id" type="button" :class="{ active: directionFilter === item.id }" @click="directionFilter = item.id">{{ item.label }}</button></div>
        <label class="search"><span>⌕</span><input v-model="searchText" type="search" placeholder="搜索代码或名称"></label>
        <button type="button" class="add-contract-button" @click="openAddContractDialog">＋ 新增币种</button>
        <button type="button" class="refresh" @click="marketSort='absoluteChange';marketOrder='desc';marketPage=1">重置排序</button>
      </section>

      <section class="watch-layout">
        <section class="market-panel watch-panel">

          <div class="watch-cards">
            <article v-for="row in pagedWatchRows" :key="row.symbol" class="watch-card" :class="{ chosen: selected === row.symbol }" @click="selectSymbol(row.symbol)">
              <button type="button" class="watch-select" :aria-label="`查看 ${row.symbol}`" @click="selectSymbol(row.symbol)">
                <span class="watch-card-top"><span class="asset-logo"><img v-if="logoUrl(row.symbol) && !logoFailed(row.symbol)" :src="logoUrl(row.symbol)" :alt="`${assetLabel(row.symbol)} logo`" @error="markLogoFailed(row.symbol)"><span v-else>{{ row.symbol.replace(/USDT$/, '').slice(0, 2) }}</span></span><span class="watch-name" :title="`${assetLabel(row.symbol)} · ${row.symbol}`">{{ row.symbol.replace(/USDT$/, '') }}<small>{{ assetType(row.symbol) === 'TRADFI' ? assetLabel(row.symbol) : 'USDT 永续' }}</small></span></span>
                <span class="watch-price"><span class="watch-price-value">{{ formatPrice(row.quote?.lastPrice) }}</span><small>USDT</small></span>
                <b class="watch-change" :class="changeClass(row.change)">{{ formatChange(row.change) }}</b>
                <span class="watch-card-bottom"><span>{{ intervals.find((item) => item.id === activeInterval)?.label }}涨跌</span><b v-if="isQuoteStale(row.quote)" class="neutral">缓存</b></span>
              </button>
              <button type="button" class="watch-ai-button" :disabled="aiLoading || aiSending" @click.stop="openAiAnalysis(row.symbol)">AI 分析</button>
              <ContractDetailLink class="watch-detail" :symbol="row.symbol" :asset-type="assetType(row.symbol)" :name="assetLabel(row.symbol)" icon-only />
              <button type="button" class="follow-icon active" :aria-label="`取消关注 ${row.symbol}`" title="取消关注" @click.stop="toggleWatch(row.symbol)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.5 2.6 5.3 5.9.9-4.25 4.15 1 5.85L12 16.9l-5.25 2.8 1-5.85L3.5 9.7l5.9-.9L12 3.5Z"/></svg></button>
            </article>
            <div v-if="!pagedWatchRows.length" class="watch-empty">当前筛选没有关注标的</div>
          </div>
          <div v-if="watchPageCount > 1" class="pagination"><button type="button" :disabled="watchPage <= 1" @click="watchPage--">上一页</button><span>{{ watchPage }} / {{ watchPageCount }}</span><button type="button" :disabled="watchPage >= watchPageCount" @click="watchPage++">下一页</button></div>
        </section>

        <section class="market-panel selected-panel">
          <header class="selected-summary">
            <div class="selected-name"><span class="asset-logo large"><img v-if="logoUrl(selected) && !logoFailed(selected)" :src="logoUrl(selected)" :alt="`${assetLabel(selected)} logo`" @error="markLogoFailed(selected)"><span v-else>{{ assetLabel(selected).slice(0, 2) }}</span></span><span><b>{{ assetLabel(selected) }}</b><small>{{ selected }} · {{ selectedAsset?.assetType === 'TRADFI' ? '传统金融' : '虚拟币' }}</small></span><button type="button" class="follow-icon" :class="{ active: isWatched(selected) }" :aria-label="isWatched(selected) ? '取消关注' : '添加关注'" :title="isWatched(selected) ? '取消关注' : '添加关注'" @click="toggleWatch(selected)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.5 2.6 5.3 5.9.9-4.25 4.15 1 5.85L12 16.9l-5.25 2.8 1-5.85L3.5 9.7l5.9-.9L12 3.5Z"/></svg></button></div>
            <div class="selected-metrics"><div><span>最新价格</span><b>{{ formatPrice(selectedQuote?.lastPrice || selectedMarketQuote?.lastPrice) }}</b></div><div><span>{{ intervals.find((item) => item.id === activeInterval)?.label }}涨跌</span><b :class="changeClass(changeValue(selectedQuote || undefined, activeInterval))">{{ formatChange(changeValue(selectedQuote || undefined, activeInterval)) }}</b></div><div><span>滚动 24 小时</span><b :class="changeClass(changeValue(selectedQuote || selectedMarketQuote || undefined, '24h'))">{{ formatChange(changeValue(selectedQuote || selectedMarketQuote || undefined, '24h')) }}</b></div><div><span>24h 合约成交额</span><b>{{ formatVolume((selectedQuote || selectedMarketQuote)?.quoteVolume24h || null) }} USDT</b></div><div><span>{{ intervals.find(item=>item.id===activeInterval)?.label }}最高价</span><b>{{formatPrice(selectedRange.high)}}</b><small v-if="selectedRange.stale && selectedRange.high">缓存区间</small></div><div><span>{{ intervals.find(item=>item.id===activeInterval)?.label }}最低价</span><b>{{formatPrice(selectedRange.low)}}</b></div><div><span>市值{{ marketCapSource ? ` · ${marketCapSource}` : '' }}</span><b>{{ marketCapLoading ? '加载中…' : formatMarketCap(selectedMarketCap) }}</b></div></div>
          </header>
          <div class="chart-heading"><div><b>K 线走势</b><span>{{ chartInterval }} · {{ chartBars.length }} 根 K 线</span></div><div class="periods chart-periods"><button v-for="item in [{id:'5m',label:'5分'},{id:'1h',label:'1小时'}] as const" :key="item.id" type="button" :class="{ active: chartInterval === item.id }" @click="chartInterval = item.id">{{ item.label }}</button></div></div>
          <div class="chart-wrap">
            <div v-if="chartLoading" class="chart-state">正在加载走势图…</div>
            <div v-else-if="!chartBars.length" class="chart-state">{{ chartError || '暂无走势图数据' }}</div>
            <template v-else>
              <div v-if="chartError" class="chart-refresh-note" role="status">{{ chartError }} · 保留最近可用走势</div>
              <CandlestickChart :bars="chartBars" :symbol="selected" :interval="chartInterval" />
            </template>
          </div>
        </section>
      </section>

      <section class="market-panel">
        <header class="market-title"><div><h2>其他合约列表</h2><p>未关注的合约 · 按{{marketSort==='price'?'价格':marketSort==='change'?'涨跌幅':'涨跌幅绝对值'}}{{marketOrder==='asc'?'升序':'降序'}} · {{ filteredMarketRows.length }} 个标的</p></div><span class="source">Binance USDⓈ-M Futures · 全市场批量行情</span></header>
        <div class="table-wrap">
          <table>
            <thead><tr><th>合约</th><th>类别</th><th :aria-sort="marketSort==='price'?(marketOrder==='asc'?'ascending':'descending'):'none'"><button class="sort-heading" @click="sortMarket('price')">最新价格 {{marketSort==='price'?(marketOrder==='asc'?'↑':'↓'):'↕'}}</button></th><th :aria-sort="marketSort==='change'?(marketOrder==='asc'?'ascending':'descending'):'none'"><button class="sort-heading" @click="sortMarket('change')">{{ intervals.find((item) => item.id === activeInterval)?.label }}涨跌 {{marketSort==='change'?(marketOrder==='asc'?'↑':'↓'):'↕'}}</button></th><th>状态</th><th class="operation-cell">操作</th></tr></thead>
            <tbody>
              <tr v-for="row in pagedMarketRows" :key="row.symbol" :class="{ chosen: selected === row.symbol }" @click="selectListSymbol(row.symbol,$event)">
                <td><div class="contract-cell"><span class="asset-logo"><img v-if="logoUrl(row.symbol) && !logoFailed(row.symbol)" :src="logoUrl(row.symbol)" :alt="`${assetLabel(row.symbol)} logo`" @error="markLogoFailed(row.symbol)"><span v-else>{{ assetLabel(row.symbol).slice(0, 2) }}</span></span><span><b>{{ assetLabel(row.symbol) }}</b><small>{{ row.symbol }}</small><small v-if="row.market.radarTier === 'VOLATILE'" class="tier-label">高波动观察</small></span></div></td>
                <td><span class="type-label" :class="assetType(row.symbol) === 'TRADFI' ? 'type-tradfi' : 'type-crypto'">{{ assetType(row.symbol) === 'TRADFI' ? '传统金融' : '虚拟币' }}</span></td>
                <td class="price-cell">{{ formatPrice(row.quote?.lastPrice) }}</td>
                <td :class="changeClass(row.change)">{{ formatChange(row.change) }}</td>
                <td><span v-if="isQuoteStale(row.quote)" class="status stale">数据缓存</span><span v-else-if="row.change == null" class="status">周期数据暂无</span><span v-else class="status normal">监控中</span></td>
                <td class="operation-cell"><div class="contract-actions"><button type="button" class="follow-icon" :class="{ active: isWatched(row.symbol) }" :aria-label="isWatched(row.symbol) ? `取消关注 ${row.symbol}` : `关注 ${row.symbol}`" :title="isWatched(row.symbol) ? '取消关注' : '加入关注'" @click.stop="toggleWatch(row.symbol)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.5 2.6 5.3 5.9.9-4.25 4.15 1 5.85L12 16.9l-5.25 2.8 1-5.85L3.5 9.7l5.9-.9L12 3.5Z"/></svg></button><ContractDetailLink :symbol="row.symbol" :asset-type="assetType(row.symbol)" :name="assetLabel(row.symbol)" icon-only /></div></td>
              </tr>
              <tr v-if="!filteredMarketRows.length"><td colspan="6" class="empty-row">{{ marketLoading ? '正在获取合约行情…' : '没有符合筛选条件的合约。' }}</td></tr>
            </tbody>
          </table>
        </div>
        <div v-if="marketPageCount > 1" class="pagination list-pagination"><button type="button" :disabled="marketPage <= 1" @click="marketPage--">上一页</button><span>{{ marketPage }} / {{ marketPageCount }}</span><button type="button" :disabled="marketPage >= marketPageCount" @click="marketPage++">下一页</button></div>
        <footer class="market-foot"><span>{{ marketError || `行情更新于 ${quoteTimestamp}` }}</span><span>卡片与列表使用同一涨跌周期；短周期由服务器缓存计算，缺失时显示 —。</span></footer>
      </section>
      </div>
      <section v-show="trendView === 'long'" id="radar-long-panel"
        role="tabpanel" aria-labelledby="radar-long-tab">
        <RadarLongTrend :active="props.active" />
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
            <span class="asset-logo"><img v-if="logoUrl(contract.symbol) && !logoFailed(contract.symbol)" :src="logoUrl(contract.symbol)" :alt="`${assetLabel(contract.symbol)} logo`" @error="markLogoFailed(contract.symbol)"><span v-else>{{ assetLabel(contract.symbol).slice(0, 2) }}</span></span>
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

<style scoped src="./RadarBoard.css"></style>
<style scoped src="./RadarTheme.css"></style>
