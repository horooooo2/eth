<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch as watchVue } from 'vue';
import { analyzeTradFiMarket, fetchTradFiCatalog, fetchTradFiQuotes, fetchTradFiIntel, type TradFiAiAnalysis, type TradFiIntelResponse, type TradFiMarketSymbol, type TradFiQuote } from '@/api';
import { tradfiWatch } from '@/utils/tradfiWatch';

type AssetMeta = { icon: string; name: string; category: string };
const META: Record<string, AssetMeta> = {
  XAUUSDT: { icon: 'Au', name: '黄金', category: '贵金属' },
  XAGUSDT: { icon: 'Ag', name: '白银', category: '贵金属' },
  TSLAUSDT: { icon: 'T', name: '特斯拉', category: '股票相关' },
  INTCUSDT: { icon: 'I', name: '英特尔', category: '股票相关' },
  SNDKUSDT: { icon: 'S', name: '闪迪', category: '股票相关' },
  EWYUSDT: { icon: 'E', name: '韩国 ETF', category: 'ETF 相关' },
  EWJUSDT: { icon: 'J', name: '日本 ETF', category: 'ETF 相关' },
};
const NEWS_FILTERS = ['全部', '宏观', '公司', '行业'];
const selected = ref('XAUUSDT');
const newsFilter = ref('全部');
const newsQuery = ref('');
const showAllNews = ref(false);
const watch = tradfiWatch;
const catalog = ref<TradFiMarketSymbol[]>([]);
const quotes = ref<Record<string, TradFiQuote>>({});
const marketError = ref('');
const marketLoading = ref(true);
const marketUpdatedAt = ref('');
const intel = ref<TradFiIntelResponse | null>(null);
const intelLoading = ref(false);
const intelError = ref('');
const intelCache = new Map<string, TradFiIntelResponse>();
const aiAnalyses = ref<Record<string, { analysis: TradFiAiAnalysis; analyzedAt: string }>>({});
const aiLoading = ref(false);
const aiError = ref('');
const now = ref(Date.now());
let quoteTimer = 0;
let intelTimer = 0;
let ageTimer = 0;
let intelRequestId = 0;

const catalogBySymbol = computed(() => new Map(catalog.value.map((item) => [item.symbol, item])));
function assetFor(symbol: string): AssetMeta {
  const market = catalogBySymbol.value.get(symbol);
  return META[symbol] || {
    icon: market?.baseAsset?.slice(0, 2) || 'Fi',
    name: market?.name || symbol,
    category: market?.category === 'EQUITY' ? '股票相关' : market?.category === 'COMMODITY' ? '商品' : 'TradFi',
  };
}
const asset = computed(() => assetFor(selected.value));
const currentQuote = computed(() => quotes.value[selected.value] || null);
const quoteAvailable = computed(() => Number.isFinite(Number(currentQuote.value?.lastPrice)) && currentQuote.value?.lastPrice != null);
function quotePrice(symbol: string) {
  const raw = quotes.value[symbol]?.lastPrice;
  const value = Number(raw);
  if (raw == null || raw === '' || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function quoteChange(symbol: string) {
  const raw = quotes.value[symbol]?.priceChangePercent;
  if (raw == null || !Number.isFinite(Number(raw))) return '—';
  const value = Number(raw);
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}%`;
}
function isUp(change: string) { return change.startsWith('+'); }
function quoteStatus(symbol: string) {
  if (!catalog.value.length) return '等待合约清单';
  if (!catalogBySymbol.value.has(symbol)) return '合约不可用';
  const quote = quotes.value[symbol];
  if (!quote || quote.lastPrice == null) return '行情暂不可用';
  return quote.stale ? '数据可能已过期' : '正常';
}
const quoteUpdatedAge = computed(() => {
  if (!marketUpdatedAt.value) return '等待数据';
  const timestamp = new Date(marketUpdatedAt.value).getTime();
  if (!Number.isFinite(timestamp)) return '等待数据';
  const seconds = Math.max(0, Math.floor((now.value - timestamp) / 1000));
  return seconds < 60 ? `${seconds} 秒前` : `${Math.floor(seconds / 60)} 分钟前`;
});
const quoteSource = computed(() => currentQuote.value?.source || '币安 Futures');

async function refreshQuotes() {
  if (!catalog.value.length || !watch.value.length) return;
  try {
    const result = await fetchTradFiQuotes(watch.value);
    const next = { ...quotes.value };
    for (const item of result.quotes) next[item.symbol] = item;
    quotes.value = next;
    marketUpdatedAt.value = result.updatedAt;
    marketError.value = result.quotes.length > 0 && result.quotes.every((item) => item.stale) ? '行情源暂不可用，请稍后重试' : '';
  } catch (err) {
    marketError.value = err instanceof Error ? err.message : '行情请求失败';
  }
}
async function loadMarkets() {
  marketLoading.value = true;
  try {
    const result = await fetchTradFiCatalog();
    catalog.value = result.symbols;
    marketError.value = result.stale ? '当前使用缓存的合约清单' : '';
    if (!watch.value.includes(selected.value)) selected.value = watch.value.find((symbol) => catalogBySymbol.value.has(symbol)) || watch.value[0] || 'XAUUSDT';
    await refreshQuotes();
    void loadIntel(selected.value);
  } catch (err) {
    marketError.value = err instanceof Error ? err.message : '合约清单获取失败';
  } finally {
    marketLoading.value = false;
  }
}

const fundamentals = computed(() => intel.value?.fundamentals);
const events = computed(() => intel.value?.events.items || []);
const newsRows = computed(() => {
  const q = newsQuery.value.trim().toLocaleLowerCase();
  return (intel.value?.news.items || []).filter((row) =>
    (newsFilter.value === '全部' || row.category === newsFilter.value)
    && (!q || `${row.title} ${row.summary || ''} ${row.source || ''}`.toLocaleLowerCase().includes(q)));
});
const visibleNews = computed(() => showAllNews.value ? newsRows.value : newsRows.value.slice(0, 6));
function statusLabel(stale?: boolean, error?: string, available = true) {
  if (error || !available) return '不可用';
  return stale ? '过期' : '正常';
}
function intelStatus(kind: 'news' | 'fundamentals' | 'events') {
  const data = intel.value;
  if (!data) return intelLoading.value ? '加载中' : '不可用';
  if (kind === 'fundamentals') return statusLabel(data.fundamentals.stale, data.fundamentals.error, Boolean(data.fundamentals.source || data.fundamentals.rows.length));
  if (kind === 'events') return statusLabel(data.events.stale, data.events.error, Boolean(data.events.source || data.events.items.length));
  return statusLabel(data.news.stale, data.news.error, Boolean(data.news.source || data.news.items.length));
}
function formatDate(raw: string | number | null | undefined) {
  if (raw == null || raw === '') return '时间未提供';
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : String(raw);
}
function eventTime(event: TradFiIntelResponse['events']['items'][number]) {
  const date = event.date ? new Date(`${event.date}T${event.time || '00:00:00'}`) : null;
  if (date && Number.isFinite(date.getTime())) return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  return event.time || event.date || '时间待定';
}
function hasValue(value: unknown): boolean { return value !== null && value !== undefined && value !== ''; }

// Direction fields are intentionally read only when an API actually supplies them.
type DirectionView = { direction: string; confidence: string; summary: string; periods: Array<{ label: string; value: string }> };
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function directionText(value: unknown, fallback: string) {
  if (typeof value === 'string' && value.trim()) return value;
  const obj = asRecord(value);
  if (!obj) return fallback;
  const candidate = obj.label ?? obj.direction ?? obj.bias ?? obj.value;
  return typeof candidate === 'string' && candidate.trim() ? candidate : fallback;
}
const directionView = computed<DirectionView>(() => {
  const manual = aiAnalyses.value[selected.value]?.analysis;
  if (manual) return {
    direction: manual.direction || '方向不明',
    confidence: manual.confidence || '不可评估',
    summary: manual.summary || '本次分析没有返回摘要。',
    periods: [
      { label: '超短线', value: manual.periods?.ultraShort || '数据不足' },
      { label: '短线', value: manual.periods?.short || '数据不足' },
      { label: '中长期', value: manual.periods?.mediumLong || '数据不足' },
    ],
  };
  const raw = intel.value as (TradFiIntelResponse & Record<string, unknown>) | null;
  const analysis = asRecord(raw?.analysis);
  const direction = analysis?.direction ?? raw?.direction ?? raw?.marketDirection ?? raw?.bias;
  const periods = asRecord(analysis?.periods ?? raw?.periods);
  return {
    direction: directionText(direction, '待分析'),
    confidence: directionText(analysis?.confidence ?? raw?.confidence, '不可评估'),
    summary: typeof (analysis?.summary ?? raw?.summary) === 'string'
      ? String(analysis?.summary ?? raw?.summary)
      : '当前版本已接入行情、基本面、经济事件与新闻，方向引擎尚未提供可靠结论。',
    periods: [
      { label: '超短线', value: directionText(periods?.ultraShort ?? raw?.ultraShortDirection, '数据不足') },
      { label: '短线', value: directionText(periods?.short ?? raw?.shortTermDirection, '数据不足') },
      { label: '中长期', value: directionText(periods?.long ?? raw?.mediumTermDirection ?? raw?.longTermDirection, '数据不足') },
    ],
  };
});

async function runAiAnalysis() {
  if (aiLoading.value) return;
  const symbol = selected.value;
  aiLoading.value = true;
  aiError.value = '';
  try {
    const result = await analyzeTradFiMarket(symbol);
    if (selected.value === symbol) {
      aiAnalyses.value = { ...aiAnalyses.value, [symbol]: { analysis: result.analysis, analyzedAt: result.analyzedAt } };
    }
  } catch (err) {
    if (selected.value === symbol) aiError.value = err instanceof Error ? err.message : 'AI 分析失败';
  } finally {
    aiLoading.value = false;
  }
}

async function loadIntel(symbol: string) {
  const requestId = ++intelRequestId;
  if (selected.value !== symbol) return;
  const cached = intelCache.get(symbol);
  intel.value = cached || intel.value;
  intelLoading.value = true;
  intelError.value = '';
  try {
    const data = await fetchTradFiIntel(symbol);
    if (selected.value === symbol && requestId === intelRequestId) {
      intelCache.set(symbol, data);
      intel.value = data;
    }
  } catch (err) {
    if (selected.value === symbol && requestId === intelRequestId) intelError.value = err instanceof Error ? err.message : '资讯获取失败';
  } finally {
    if (selected.value === symbol && requestId === intelRequestId) intelLoading.value = false;
  }
}
function selectAsset(symbol: string) {
  if (!watch.value.includes(symbol) && !catalogBySymbol.value.has(symbol)) return;
  selected.value = symbol;
}
watchVue(selected, (symbol) => {
  intel.value = intelCache.get(symbol) || null;
  aiError.value = '';
  newsFilter.value = '全部';
  newsQuery.value = '';
  showAllNews.value = false;
  void loadIntel(symbol);
});
watchVue(watch, (symbols) => {
  if (!symbols.includes(selected.value)) selected.value = symbols[0] || 'XAUUSDT';
  void refreshQuotes();
});
onMounted(() => {
  void loadMarkets();
  quoteTimer = window.setInterval(() => { void refreshQuotes(); }, 15_000);
  intelTimer = window.setInterval(() => { void loadIntel(selected.value); }, 5 * 60_000);
  ageTimer = window.setInterval(() => { now.value = Date.now(); }, 1000);
});
onUnmounted(() => {
  window.clearInterval(quoteTimer);
  window.clearInterval(intelTimer);
  window.clearInterval(ageTimer);
  intelRequestId += 1;
});
</script>

<template>
  <div class="tradfi">
    <div class="top-line"><strong>币安 TradFi 合约市场观察</strong><span>{{ marketLoading ? '行情加载中' : marketError || '只读市场数据' }}</span><span v-if="marketUpdatedAt">行情更新于 {{ new Date(marketUpdatedAt).toLocaleTimeString('zh-CN') }}</span><button v-if="marketError" class="retry" @click="loadMarkets">重试</button></div>
    <main class="content">
      <section class="watch-strip" aria-label="TradFi 自选行情">
        <button v-for="symbol in watch" :key="symbol" class="ticker" :class="{ active: symbol === selected }" type="button" @click="selectAsset(symbol)">
          <span class="ticker-name">{{ assetFor(symbol).name }} · {{ assetFor(symbol).category }} <small v-if="quotes[symbol]?.stale">数据可能已过期</small></span>
          <span class="ticker-bottom"><b class="mono">{{ quotePrice(symbol) }}</b><em class="mono" :class="isUp(quoteChange(symbol)) ? 'up' : quoteChange(symbol).startsWith('−') ? 'down' : 'muted'">{{ quoteChange(symbol) }}</em></span>
          <small class="ticker-symbol">{{ symbol }} · {{ quoteStatus(symbol) }}</small>
        </button>
        <div v-if="!watch.length" class="empty-inline">请在标的设置中添加 TradFi 自选</div>
      </section>

      <section class="hero" aria-label="当前选中标的概要">
        <div class="instrument"><div class="coin">{{ asset.icon }}</div><div><h1>{{ selected }}</h1><p>{{ asset.name }} · {{ asset.category }}</p></div></div>
        <div class="hero-price"><strong class="mono">{{ quoteAvailable ? quotePrice(selected) : '行情暂不可用' }}</strong><span class="mono" :class="isUp(quoteChange(selected)) ? 'up' : quoteChange(selected).startsWith('−') ? 'down' : 'muted'">{{ quoteAvailable ? `${quoteChange(selected)} · 24h` : '不显示伪造价格' }}</span></div>
        <div class="hero-stats"><div><span>标的类别</span><b>{{ asset.category }}</b></div><div><span>行情来源</span><b>{{ quoteSource }}</b></div><div><span>更新时间</span><b>{{ currentQuote?.stale ? '行情已缓存' : currentQuote?.lastPrice == null ? '行情暂不可用' : quoteUpdatedAge }}</b></div></div>
      </section>

      <section class="main-grid">
        <div class="left-stack">
          <article class="panel observation">
            <header class="panel-head"><div><h2>市场观察</h2><p>方向引擎未提供可靠结论时保持待分析</p></div><div class="observation-actions"><span class="badge">{{ asset.name }}</span><button class="analyze-btn" type="button" :disabled="aiLoading" @click="runAiAnalysis">{{ aiLoading ? '分析中…' : aiAnalyses[selected] ? '重新分析' : 'AI 分析' }}</button></div></header>
            <div class="direction-body">
              <div class="direction-top"><div><small>当前方向</small><b class="direction-value">{{ directionView.direction }}</b></div><div class="confidence"><small>方向信心</small><b>{{ directionView.confidence }}</b></div></div>
              <p class="summary">{{ directionView.summary }}</p>
              <div class="periods"><div v-for="period in directionView.periods" :key="period.label"><span>{{ period.label }}</span><b>{{ period.value }}</b></div></div>
              <div v-if="aiAnalyses[selected]" class="ai-reasons">
                <div><b>支持因素</b><span v-for="(item, index) in aiAnalyses[selected].analysis.supportingFactors || []" :key="`support-${index}`">{{ item }}</span><span v-if="!aiAnalyses[selected].analysis.supportingFactors?.length">暂无明确支持项</span></div>
                <div><b>反向因素</b><span v-for="(item, index) in aiAnalyses[selected].analysis.opposingFactors || []" :key="`oppose-${index}`">{{ item }}</span><span v-if="!aiAnalyses[selected].analysis.opposingFactors?.length">暂无明确反向项</span></div>
              </div>
              <p v-if="aiAnalyses[selected]" class="analysis-time">AI 分析于 {{ formatDate(aiAnalyses[selected].analyzedAt) }} · 仅点击按钮时调用</p>
              <p v-if="aiError" class="analysis-error">{{ aiError }}</p>
            </div>
            <footer class="panel-foot">行情、基本面、日历与新闻用于信息观察，不构成交易执行建议。</footer>
          </article>

          <article class="panel">
            <header class="panel-head"><div><h2>核心市场驱动</h2><p>显示后端实际返回的基本面字段，不自动推断利多或利空</p></div><span class="state" :class="intelStatus('fundamentals')">{{ intelStatus('fundamentals') }}</span></header>
            <div class="driver-list">
              <div v-for="(row, index) in fundamentals?.rows || []" :key="`${row.label}-${index}`" class="driver"><span>{{ row.label }}</span><b>{{ hasValue(row.value) ? row.value : '暂无数据' }}</b><small>{{ row.asOf ? `截至 ${row.asOf}` : '暂无判断' }}</small></div>
              <div v-if="!fundamentals?.rows?.length" class="empty">{{ intelLoading ? '正在加载基础面数据…' : fundamentals?.error ? '数据源暂不可用' : '暂无基础面数据' }}</div>
            </div>
            <footer v-if="fundamentals?.note || fundamentals?.source" class="panel-foot">{{ fundamentals?.source || '' }}<span v-if="fundamentals?.note"> · {{ fundamentals.note }}</span></footer>
          </article>

          <article class="panel">
            <header class="panel-head"><div><h2>关注事件</h2><p>来自经济日历的真实事件数据</p></div><span class="state" :class="intelStatus('events')">{{ intelStatus('events') }}</span></header>
            <div class="event-list">
              <div v-for="event in events.slice(0, 5)" :key="`${event.date}-${event.title}`" class="event"><time>{{ eventTime(event) }}</time><div class="event-main"><b>{{ event.title }}</b><small v-if="event.source">{{ event.source }}</small><small v-if="hasValue(event.actual) || hasValue(event.forecast) || hasValue(event.previous)"><template v-if="hasValue(event.actual)">实际 {{ event.actual }}　</template><template v-if="hasValue(event.forecast)">预期 {{ event.forecast }}　</template><template v-if="hasValue(event.previous)">前值 {{ event.previous }}</template></small></div><span class="event-status">{{ hasValue(event.actual) ? '已公布' : '待公布' }}</span></div>
              <div v-if="!events.length" class="empty">{{ intelLoading ? '正在加载经济事件…' : intel?.events.error ? '数据源暂不可用' : '近期暂无可用事件' }}</div>
            </div>
          </article>
        </div>

        <article class="panel news-panel">
          <header class="panel-head"><div><h2>相关新闻</h2><p>按标的关联度展示近期可能影响市场的信息</p></div><span class="state" :class="intelStatus('news')">{{ intelStatus('news') }} · {{ newsRows.length }} 条</span></header>
          <div class="news-tools"><div class="filters"><button v-for="item in NEWS_FILTERS" :key="item" type="button" :class="{ selected: newsFilter === item }" @click="newsFilter = item">{{ item }}</button></div><input v-model="newsQuery" type="search" placeholder="搜索当前标的资讯" aria-label="搜索资讯" /></div>
          <div class="news-list">
            <article v-for="row in visibleNews" :key="row.url" class="news-row"><time>{{ formatDate(row.publishedAt) }}</time><div class="news-content"><div class="news-title"><span class="news-tag">{{ row.category }}</span><a :href="row.url" target="_blank" rel="noopener noreferrer">{{ row.title }}</a></div><p v-if="row.summary">{{ row.summary }}</p><small>{{ row.source || '新闻来源未提供' }}</small></div></article>
            <div v-if="!newsRows.length" class="empty">{{ intelLoading ? '正在获取相关新闻…' : intelError || intel?.news.error ? '数据源暂不可用或暂无匹配资讯' : '暂未找到相关新闻' }}</div>
          </div>
          <button v-if="newsRows.length > 6" class="show-more" type="button" @click="showAllNews = !showAllNews">{{ showAllNews ? '收起资讯 ↑' : `查看全部 ${newsRows.length} 条资讯 ↓` }}</button>
          <footer class="panel-foot">来源：{{ intel?.news.source || '待连接' }} · 更新：{{ intel?.news.updatedAt ? formatDate(intel.news.updatedAt) : '—' }}。RSS 聚合内容可点击标题核对原始报道。</footer>
        </article>
      </section>
    </main>
  </div>
</template>

<style scoped>
.tradfi{--tradfi-bg:#080d14;--tradfi-panel:#0b1119;--tradfi-panel-2:#0d141e;--tradfi-line:#1f2a3a;--tradfi-line-soft:#172131;--tradfi-text:#e8edf5;--tradfi-muted:#7e8da3;--tradfi-gold:#e1b532;--tradfi-green:#35cf91;--tradfi-red:#ff5f73;height:100%;min-height:0;overflow:auto;background:var(--tradfi-bg);color:var(--tradfi-text);font-size:12px}.mono{font-variant-numeric:tabular-nums}.up{color:var(--tradfi-green)!important}.down{color:var(--tradfi-red)!important}.muted{color:var(--tradfi-muted)!important}.top-line{height:28px;display:flex;align-items:center;gap:14px;padding:0 16px;border-bottom:1px solid #111923;color:var(--tradfi-muted);font-size:10px}.top-line strong{color:var(--tradfi-gold);font-size:11px}.top-line span:last-of-type{margin-left:auto}.retry{border:0;background:none;color:var(--tradfi-gold);cursor:pointer}.content{width:min(1600px,100%);margin:0 auto;padding:0 16px 20px}.watch-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:8px;padding:10px 0}.ticker{min-width:0;border:1px solid var(--tradfi-line-soft);border-radius:7px;background:#0a1018;color:var(--tradfi-text);padding:9px 12px;text-align:left;cursor:pointer}.ticker:hover{border-color:#34445b}.ticker.active{border-color:#8f741c;box-shadow:inset 0 0 0 1px #e1b53218;background:#17160f}.ticker-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#a6b2c2;font-size:11px}.ticker-name small{color:var(--tradfi-muted);font-size:9px}.ticker-bottom{display:flex;justify-content:space-between;align-items:baseline;margin-top:5px}.ticker-bottom b{font-size:19px}.ticker-bottom em{font-style:normal;font-weight:800}.ticker-symbol{display:block;color:var(--tradfi-muted);font-size:10px;margin-top:3px}.hero{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:20px;min-height:78px;padding:10px 16px;margin-bottom:10px;border:1px solid var(--tradfi-line);border-radius:8px;background:#0c131d}.instrument{display:flex;align-items:center;gap:12px}.coin{width:40px;height:40px;flex:none;display:grid;place-items:center;border-radius:50%;background:var(--tradfi-gold);color:#17140a;font-size:15px;font-weight:900}.instrument h1{margin:0;font-size:16px}.instrument p{margin:4px 0 0;color:var(--tradfi-muted);font-size:11px}.hero-price{text-align:center;min-width:190px}.hero-price strong{display:block;font-size:26px}.hero-price span{display:block;margin-top:3px;font-weight:750}.hero-stats{justify-self:end;display:flex;gap:20px}.hero-stats div{display:grid;gap:4px}.hero-stats span{color:var(--tradfi-muted);font-size:10px}.hero-stats b{font-size:11px}.main-grid{display:grid;grid-template-columns:minmax(340px, .62fr) minmax(0,1fr);gap:10px;align-items:stretch}.left-stack{display:grid;align-content:start;gap:10px}.panel{min-width:0;overflow:hidden;border:1px solid var(--tradfi-line-soft);border-radius:8px;background:var(--tradfi-panel)}.panel-head{min-height:48px;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 13px;border-bottom:1px solid var(--tradfi-line-soft)}.panel-head h2{margin:0;font-size:14px;font-weight:800}.panel-head p{margin:3px 0 0;color:var(--tradfi-muted);font-size:10px;line-height:1.5}.badge,.state{flex:none;padding:4px 7px;border:1px solid #403719;border-radius:5px;color:var(--tradfi-gold);font-size:10px}.state.正常{color:var(--tradfi-green);border-color:#235541}.state.过期,.state.缓存{color:#e4bb4a}.state.不可用{color:var(--tradfi-red);border-color:#63313b}.direction-body{padding:13px}.direction-top{display:flex;justify-content:space-between;align-items:flex-start}.direction-top small,.confidence small{display:block;color:var(--tradfi-muted);font-size:10px}.direction-value{display:block;margin-top:5px;color:var(--tradfi-gold);font-size:24px}.confidence{text-align:right}.confidence b{display:block;margin-top:5px;font-size:13px}.summary{margin:10px 0 0;color:#a7b3c3;font-size:11px;line-height:1.65}.periods{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:12px}.periods div{padding:8px 5px;border:1px solid var(--tradfi-line-soft);border-radius:6px;background:var(--tradfi-panel-2);text-align:center}.periods span,.periods b{display:block}.periods span{color:var(--tradfi-muted);font-size:10px}.periods b{margin-top:5px;font-size:11px}.analysis-time{margin:9px 0 0;color:var(--tradfi-muted);font-size:10px}.analysis-error{margin:8px 0 0;color:var(--tradfi-red);font-size:11px}.observation-actions{display:flex;align-items:center;gap:7px}.analyze-btn{height:29px;padding:0 10px;border:1px solid #705b19;border-radius:5px;background:#e1b53212;color:var(--tradfi-gold);font-size:10px;font-weight:800;cursor:pointer}.analyze-btn:hover:not(:disabled){background:#e1b53222}.analyze-btn:disabled{opacity:.55;cursor:wait}.panel-foot{padding:8px 12px;border-top:1px solid var(--tradfi-line-soft);color:var(--tradfi-muted);font-size:10px;line-height:1.5}.driver-list,.event-list{padding:0 12px}.driver{display:grid;grid-template-columns:minmax(100px,1fr) minmax(80px,1fr) minmax(70px,auto);align-items:center;gap:8px;min-height:38px;border-bottom:1px solid var(--tradfi-line-soft)}.driver:last-child,.event:last-child{border-bottom:0}.driver span{color:#a4afbe}.driver b{font-size:11px}.driver small{color:var(--tradfi-muted);font-size:10px;text-align:right}.event{display:grid;grid-template-columns:88px minmax(0,1fr) auto;align-items:center;gap:8px;min-height:48px;border-bottom:1px solid var(--tradfi-line-soft)}.event time{color:#b59a43;font-size:10px;font-variant-numeric:tabular-nums}.event-main{min-width:0}.event-main b,.event-main small{display:block}.event-main b{font-size:11px;line-height:1.45}.event-main small{margin-top:3px;color:var(--tradfi-muted);font-size:10px;line-height:1.45}.event-status{color:#9aabc0;font-size:10px}.news-panel{display:flex;flex-direction:column;min-height:430px}.news-tools{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 12px;border-bottom:1px solid var(--tradfi-line-soft)}.filters{display:flex;gap:5px}.filters button{height:27px;padding:0 9px;border:1px solid var(--tradfi-line);border-radius:5px;background:#101722;color:var(--tradfi-muted);font-size:10px;font-weight:700;cursor:pointer}.filters button.selected{color:var(--tradfi-gold);border-color:#705b19;background:#e1b53212}.news-tools input{width:min(210px,45%);height:28px;padding:0 9px;border:1px solid var(--tradfi-line);border-radius:5px;outline:none;background:#090f16;color:var(--tradfi-text);font-size:11px}.news-list{flex:1;padding:0 13px}.news-row{display:grid;grid-template-columns:78px minmax(0,1fr);gap:10px;padding:12px 0;border-bottom:1px solid var(--tradfi-line-soft)}.news-row time{padding-top:3px;color:var(--tradfi-muted);font-size:10px}.news-content{min-width:0}.news-title{font-size:12px;line-height:1.55}.news-title a{color:#e6c44f;text-decoration:none}.news-title a:hover{color:#ffe16e;text-decoration:underline}.news-tag{display:inline-block;margin-right:7px;padding:2px 5px;border-radius:4px;background:#2a2412;color:#b8992b;font-size:9px;font-weight:800}.news-content p{margin:4px 0;color:#a4afbe;font-size:11px;line-height:1.5}.news-content small{display:block;margin-top:5px;color:var(--tradfi-muted);font-size:10px}.show-more{width:100%;height:34px;border:0;border-top:1px solid var(--tradfi-line-soft);background:#0a1119;color:#9aa8ba;font-size:10px;font-weight:700;cursor:pointer}.show-more:hover{color:var(--tradfi-text)}.empty{padding:18px 8px;color:var(--tradfi-muted);font-size:11px;text-align:center}.empty-inline{padding:12px;color:var(--tradfi-muted)}
.ai-reasons{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:10px}.ai-reasons>div{display:grid;align-content:start;gap:5px;padding:8px;border:1px solid var(--tradfi-line-soft);border-radius:6px;background:#0d151f}.ai-reasons b{font-size:10px;color:#d9e1ec}.ai-reasons span{font-size:10px;line-height:1.5;color:#95a4b8}.analysis-time{margin:9px 0 0;color:var(--tradfi-muted);font-size:10px}.analysis-error{margin:8px 0 0;color:var(--tradfi-red);font-size:11px}.observation-actions{display:flex;align-items:center;gap:7px}.analyze-btn{height:29px;padding:0 10px;border:1px solid #705b19;border-radius:5px;background:#e1b53212;color:var(--tradfi-gold);font-size:10px;font-weight:800;cursor:pointer}.analyze-btn:hover:not(:disabled){background:#e1b53222}.analyze-btn:disabled{opacity:.55;cursor:wait}
@media(max-width:900px){.content{padding:0 10px 16px}.main-grid{grid-template-columns:1fr}.left-stack{display:contents}.observation{order:0}.left-stack>.panel:nth-child(2){order:1}.left-stack>.panel:nth-child(3){order:2}.news-panel{order:3}.hero{grid-template-columns:1fr auto;}.hero-stats{grid-column:1/-1;justify-self:stretch;justify-content:space-between;border-top:1px solid var(--tradfi-line-soft);padding-top:9px}.hero-price{text-align:right}.news-panel{min-height:350px}}
@media(max-width:600px){.top-line{padding:0 10px;gap:8px}.top-line span:last-of-type{display:none}.content{padding:0 8px 12px}.watch-strip{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;padding:8px 0}.ticker{flex:0 0 220px;scroll-snap-align:start}.hero{grid-template-columns:1fr;gap:10px;padding:12px}.hero-price{text-align:left;min-width:0}.hero-price strong{font-size:23px}.hero-stats{grid-column:auto;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.hero-stats b{font-size:10px;overflow-wrap:anywhere}.driver{grid-template-columns:minmax(85px,1fr) minmax(70px,1fr);padding:5px 0}.driver small{grid-column:2;text-align:left}.event{grid-template-columns:70px minmax(0,1fr);padding:6px 0}.event-status{grid-column:2}.news-tools{align-items:stretch;flex-direction:column}.news-tools input{width:100%}.news-row{grid-template-columns:62px minmax(0,1fr);gap:7px}.news-title{font-size:11px}}
.tradfi{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;font-size:13px}.top-line{flex:none;padding-left:12px;padding-right:12px}.content{display:flex;flex:1;flex-direction:column;width:100%;min-height:0;margin:0;padding:0}.watch-strip{flex:none;padding:8px 10px}.ticker-bottom b{font-size:21px}.hero{flex:none;margin:0 10px 8px}.hero-price strong{font-size:30px}.main-grid{flex:1;min-height:0;padding:0 10px 10px;grid-template-columns:minmax(360px,.62fr) minmax(0,1fr)}.left-stack{align-content:stretch;grid-template-rows:auto auto 1fr}.panel{border-radius:7px}.panel-head h2{font-size:15px}.news-panel{height:100%}
@media(max-width:900px){.main-grid{flex:none;min-height:auto;padding:0 10px 10px}.left-stack{grid-template-rows:auto auto auto}.news-panel{height:auto}}
@media(max-width:600px){.top-line{padding-left:10px;padding-right:10px}.watch-strip{padding:8px}.hero{margin:0 8px 8px}.main-grid{padding:0 8px 8px}}
</style>
