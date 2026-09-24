<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch as watchVue } from 'vue';
import { fetchTradFiCatalog, fetchTradFiQuotes, fetchTradFiIntel, fetchAllTradFiWhales, previewTradfiOrder, submitTradfiOrder, type TradfiOrderInput, type TradfiOrderPlan, type TradFiIntelResponse, type TradFiMarketSymbol, type TradFiQuote, type TradFiAllWhaleResponse } from '@/api';
import { ElMessageBox } from 'element-plus';
import { tradfiWatch } from '@/utils/tradfiWatch';

const props = defineProps<{ active?: boolean }>();

type NewsRow = [tag: string, time: string, title: string, summary: string, source: string];
type Pair = [string, string];

type Asset = {
  icon: string;
  name: string;
  category: string;
  price: string;
  change: string;
  news: NewsRow[];
  fund: Pair[];
  fundNote: string;
  events: [string, string, string][];
};

const DATA: Record<string, Asset> = {
  XAUUSDT: {
    icon: 'Au',
    name: '黄金 · 贵金属',
    category: '贵金属',
    price: '3,742.18',
    change: '+0.84%',
    news: [
      ['宏观', '示例 10:30', '利率预期变化成为黄金市场焦点', '观察政策预期变化及实际利率方向，需核对原始发布内容。', '示例来源 · 宏观资讯'],
      ['行业', '示例 09:45', '黄金 ETF 持仓变动值得跟踪', '持仓变化可作为资金流向线索，不能单独推断短期价格。', '示例来源 · 行业数据'],
      ['宏观', '示例 08:15', '美元走势与黄金价格出现阶段性背离', '结合指数、收益率和时区观察，不把相关性当成交易信号。', '示例来源 · 市场观察'],
      ['行业', '示例 昨日', '央行黄金储备更新进入本周观察清单', '关注公布周期及统计口径，等待正式数值。', '示例来源 · 官方统计'],
    ],
    fund: [
      ['关键驱动', '实际利率 / 美元'],
      ['供需线索', '央行购金 / ETF 持仓'],
      ['合约观察', '指数价 / 标记价 / 资金费率'],
      ['下一公布', '待接入日历'],
    ],
    fundNote: '黄金的“基础面”侧重宏观与资金流向；此处不套用公司财报指标。',
    events: [
      ['待定', '美国通胀数据', '预期、前值与公布值待接入'],
      ['待定', '央行利率决议', '关注声明和利率路径'],
      ['待定', '黄金 ETF 持仓更新', '核对机构原始数据'],
    ],
  },
  XAGUSDT: {
    icon: 'Ag',
    name: '白银 · 贵金属',
    category: '贵金属',
    price: '42.36',
    change: '+1.26%',
    news: [
      ['行业', '示例 11:10', '工业需求展望成为白银讨论重点', '关注光伏、电子等需求预期及统计口径。', '示例来源 · 行业资讯'],
      ['宏观', '示例 09:20', '美元与利率预期影响贵金属板块', '需结合黄金白银比和成交活跃度评估。', '示例来源 · 宏观资讯'],
      ['行业', '示例 昨日', '白银库存变化进入市场观察清单', '核对仓库库存、ETF 持仓的来源与更新时间。', '示例来源 · 市场数据'],
    ],
    fund: [
      ['关键驱动', '工业需求 / 实际利率'],
      ['供需线索', '库存 / ETF 持仓'],
      ['相对指标', '金银比'],
      ['合约观察', '指数价 / 标记价'],
    ],
    fundNote: '白银同时受贵金属属性和工业需求影响，新闻需区分两类催化。',
    events: [
      ['待定', '制造业数据', '关注工业需求预期'],
      ['待定', '美国通胀数据', '关注利率预期'],
      ['待定', '库存更新', '核对统计口径'],
    ],
  },
  TSLAUSDT: {
    icon: 'T',
    name: '特斯拉 · 股票相关',
    category: '股票相关',
    price: '458.92',
    change: '−0.73%',
    news: [
      ['公司', '示例 10:05', '特斯拉季度交付数据临近公布', '正式版应连接公司公告并比较一致预期。', '示例来源 · 公司公告'],
      ['行业', '示例 08:40', '电动车行业价格竞争受到关注', '关注销量、售价和毛利率变化。', '示例来源 · 行业资讯'],
      ['公司', '示例 昨日', '分析师调整盈利预测', '区分分析师观点与公司披露事实。', '示例来源 · 市场研究'],
    ],
    fund: [
      ['财务核心', '营收 / 毛利率 / 自由现金流'],
      ['经营核心', '交付量 / 均价'],
      ['估值比较', '市值 / 盈利预期'],
      ['下一财报', '待接入日历'],
    ],
    fundNote: '股票类标的应先核对公司披露、财报日期与实际股票交易时段，再关联永续合约。',
    events: [
      ['待定', '季度交付数据', '核对公司公告'],
      ['待定', '季度财报', '实际值与一致预期'],
      ['待定', '宏观利率数据', '关注成长股估值影响'],
    ],
  },
  EWYUSDT: {
    icon: 'E',
    name: '韩国市场 · ETF 相关',
    category: 'ETF 相关',
    price: '91.47',
    change: '+0.39%',
    news: [
      ['宏观', '示例 11:00', '韩国经济数据进入本周观察清单', '需核对官方统计数据与市场预期。', '示例来源 · 官方统计'],
      ['行业', '示例 09:10', '半导体板块动向影响市场情绪', '观察 ETF 权重股与相关行业表现。', '示例来源 · 行业资讯'],
      ['宏观', '示例 昨日', '汇率变化可能影响跨市场定价', '关注标的基金交易时间和汇率折算。', '示例来源 · 市场观察'],
    ],
    fund: [
      ['宏观核心', '出口 / 通胀 / 央行政策'],
      ['基金结构', '权重股 / 行业分布'],
      ['跨市场因素', '汇率 / 交易时差'],
      ['下一数据', '待接入日历'],
    ],
    fundNote: 'ETF 相关合约要区分 ETF 净值、交易价格和永续合约价格。',
    events: [
      ['待定', '出口数据', '关注半导体与整体出口'],
      ['待定', '央行会议', '关注货币政策'],
      ['待定', 'ETF 持仓更新', '核对基金披露'],
    ],
  },
};

const NEWS_FILTERS = ['全部', '宏观', '公司', '行业'];

const selected = ref('XAUUSDT');
const newsFilter = ref('全部');
const newsQuery = ref('');
const watch = tradfiWatch;
const aiOpen = ref(false);
const aiSide = ref('做多');
const aiType = ref('限价单');
const aiMargin = ref(100);
const aiLeverage = ref('3×');
const aiLimitPrice = ref(0);
const orderPreview = ref<TradfiOrderPlan | null>(null);
const orderConfigured = ref(false);
const orderBusy = ref(false);
const orderError = ref('');
const orderResult = ref('');
let quoteTimer = 0;
let intelTimer = 0;
let intelRequestId = 0;
let whaleRequestId = 0;
let whaleTimer = 0;
const catalog = ref<TradFiMarketSymbol[]>([]);
const quotes = ref<Record<string, TradFiQuote>>({});
const marketError = ref('');
const marketLoading = ref(true);
const marketUpdatedAt = ref('');
const intel = ref<TradFiIntelResponse | null>(null);
const intelLoading = ref(false);
const intelError = ref('');
const whaleData = ref<TradFiAllWhaleResponse | null>(null);
const whaleLoading = ref(false);
const whaleError = ref('');

const catalogBySymbol = computed(() => new Map(catalog.value.map((item) => [item.symbol, item])));
function assetFor(symbol: string): Asset {
  const market = catalogBySymbol.value.get(symbol);
  if (DATA[symbol]) return DATA[symbol];
  const category = market?.category === 'EQUITY' ? '股票相关' : market?.category === 'COMMODITY' ? '商品' : 'TradFi';
  return {
    icon: market?.baseAsset?.slice(0, 2) || 'Fi',
    name: `${market?.name || symbol} · ${category}`,
    category,
    price: '', change: '', news: [], fund: [],
    fundNote: '该标的的基础面字段和新闻关联将在下一阶段接入。', events: [],
  };
}
const asset = computed(() => assetFor(selected.value));
function quoteFor(symbol: string) { return quotes.value[symbol]; }
function quotePrice(symbol: string) {
  const value = Number(quoteFor(symbol)?.lastPrice);
  if (!quoteFor(symbol)?.lastPrice || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', { maximumFractionDigits: value < 10 ? 6 : 4 });
}
function quoteChange(symbol: string) {
  const raw = quoteFor(symbol)?.priceChangePercent;
  if (raw == null || !Number.isFinite(Number(raw))) return '—';
  const value = Number(raw);
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}%`;
}
function quoteStatus(symbol: string) {
  if (!catalog.value.length) return '等待合约清单';
  if (!catalogBySymbol.value.has(symbol)) return '合约不可用';
  const quote = quoteFor(symbol);
  if (!quote) return '行情加载中';
  return quote.stale ? '行情暂不可用' : '币安行情 · 15 秒刷新';
}
async function refreshQuotes() {
  if (!catalog.value.length || !watch.value.length) return;
  try {
    const result = await fetchTradFiQuotes(watch.value);
    quotes.value = Object.fromEntries(result.quotes.map((item) => [item.symbol, item]));
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
    await refreshQuotes();
    void loadIntel(selected.value);
  } catch (err) {
    marketError.value = err instanceof Error ? err.message : '合约清单获取失败';
  } finally {
    marketLoading.value = false;
  }
}

onMounted(() => {
  if (!watch.value.includes(selected.value)) selected.value = watch.value[0];
  void loadMarkets();
  quoteTimer = window.setInterval(() => { void refreshQuotes(); }, 15_000);
  intelTimer = window.setInterval(() => { void loadIntel(selected.value); }, 5 * 60_000);
  if (props.active) void loadWhales();
  whaleTimer = window.setInterval(() => { if (props.active) void loadWhales(); }, 60_000);
});
onUnmounted(() => {
  window.clearInterval(quoteTimer);
  window.clearInterval(intelTimer);
  window.clearInterval(whaleTimer);
});
watchVue(() => props.active, (active) => { if (active) void loadWhales(); });
watchVue(watch, (symbols) => {
  if (!symbols.includes(selected.value)) selectAsset(symbols[0]);
  void refreshQuotes();
});

const newsRows = computed(() => {
  const q = newsQuery.value.trim().toLowerCase();
  return (intel.value?.news.items || []).filter((row) => {
    if (newsFilter.value !== '全部' && row.category !== newsFilter.value) return false;
    if (!q) return true;
    return `${row.title} ${row.summary}`.toLowerCase().includes(q);
  });
});

const whaleRows = computed(() => whaleData.value?.rows || []);
const selectedWhaleCode = computed(() => {
  const base = catalogBySymbol.value.get(selected.value)?.baseAsset || selected.value.replace(/USDT$/, '');
  return ({ XAU: 'GOLD', XAG: 'SILVER', XPT: 'PLATINUM', XPD: 'PALLADIUM' } as Record<string, string>)[base] || base;
});
const relatedWhaleRows = computed(() => whaleRows.value.filter((row) =>
  row.coin.split(':').pop()?.toUpperCase() === selectedWhaleCode.value,
));

function isUp(change: string) {
  return change.startsWith('+');
}

function newsTime(raw: string | null) {
  if (!raw) return '时间未提供';
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '时间未提供';
}

async function loadIntel(symbol: string) {
  const requestId = ++intelRequestId;
  intel.value = null;
  intelLoading.value = true;
  intelError.value = '';
  try {
    const data = await fetchTradFiIntel(symbol);
    if (selected.value === symbol && requestId === intelRequestId) intel.value = data;
  } catch (err) {
    if (selected.value === symbol && requestId === intelRequestId) intelError.value = err instanceof Error ? err.message : '资讯与基础面获取失败';
  } finally {
    if (selected.value === symbol && requestId === intelRequestId) intelLoading.value = false;
  }
}

async function loadWhales() {
  const requestId = ++whaleRequestId;
  whaleLoading.value = true;
  whaleError.value = '';
  try {
    const result = await fetchAllTradFiWhales();
    if (requestId === whaleRequestId) whaleData.value = result;
  } catch (err) {
    if (requestId === whaleRequestId) whaleError.value = err instanceof Error ? err.message : '大户数据获取失败';
  } finally {
    if (requestId === whaleRequestId) whaleLoading.value = false;
  }
}

function whaleAssetName(coin: string) {
  const code = coin.split(':').pop()?.toUpperCase() || coin;
  const names: Record<string, string> = {
    GOLD: '黄金', SILVER: '白银', PLATINUM: '铂金', PALLADIUM: '钯金', SNDK: '闪迪',
  };
  const name = names[code] || catalog.value.find((item) => item.baseAsset === code)?.name || code;
  return name === code ? code : `${name}（${code}）`;
}
function whaleTime(time: number | null) { return time ? new Date(time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '当前持仓'; }
function whaleUsd(value: number | null) { return value == null ? '—' : `$${Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 2 })}`; }
function whaleDirection(direction: string) {
  return ({ 'Open Long': '开多', 'Open Short': '开空', 'Close Long': '平多', 'Close Short': '平空' } as Record<string, string>)[direction] || direction;
}

function selectAsset(symbol: string) {
  if (!watch.value.includes(symbol) && !catalogBySymbol.value.has(symbol)) return;
  selected.value = symbol;
  void loadIntel(symbol);
}

watchVue([selected, aiSide, aiType, aiMargin, aiLeverage, aiLimitPrice], () => {
  orderPreview.value = null;
  orderResult.value = '';
});

function openAiOrder() {
  aiLimitPrice.value = Number(quoteFor(selected.value)?.lastPrice || 0);
  orderPreview.value = null;
  orderError.value = '';
  orderResult.value = '';
  aiOpen.value = true;
}

function orderInput(): TradfiOrderInput {
  return {
    symbol: selected.value,
    side: aiSide.value === '做多' ? 'BUY' : 'SELL',
    type: aiType.value === '限价单' ? 'LIMIT' : 'MARKET',
    marginUsdt: Number(aiMargin.value),
    leverage: Number(aiLeverage.value.replace('×', '')),
    ...(aiType.value === '限价单' ? { price: Number(aiLimitPrice.value) } : {}),
  };
}

async function previewOrder() {
  orderBusy.value = true;
  orderError.value = '';
  try {
    const result = await previewTradfiOrder(orderInput());
    orderPreview.value = result.plan;
    orderConfigured.value = result.configured;
  } catch (err) {
    orderPreview.value = null;
    orderError.value = err instanceof Error ? err.message : '订单预览失败';
  } finally {
    orderBusy.value = false;
  }
}

async function placeOrder(testOnly: boolean) {
  const plan = orderPreview.value;
  if (!plan || orderBusy.value) return;
  if (!testOnly) {
    try {
      await ElMessageBox.confirm(
        `${plan.symbol} · ${plan.side === 'BUY' ? '做多' : '做空'} · ${plan.type === 'LIMIT' ? `限价 ${plan.price}` : '市价'} · 数量 ${plan.quantity} · 杠杆 ${plan.leverage}× · ${plan.testnet ? '演示盘' : '实盘'}。确认提交？`,
        '确认币安开单', { confirmButtonText: '确认下单', cancelButtonText: '取消', type: 'warning' },
      );
    } catch { return; }
  }
  orderBusy.value = true;
  orderError.value = '';
  orderResult.value = '';
  try {
    const result = await submitTradfiOrder(orderInput(), plan, testOnly);
    orderResult.value = testOnly ? '币安测试下单通过，未进入撮合。' : `订单已提交：${result.order?.orderId || result.order?.clientOrderId || '请在币安订单列表核对'}`;
    orderPreview.value = null;
  } catch (err) {
    orderError.value = `${err instanceof Error ? err.message : '下单失败'}。请在币安订单列表核对状态，重新预览后再提交。`;
    orderPreview.value = null;
  } finally {
    orderBusy.value = false;
  }
}

</script>

<template>
  <div class="tradfi">
    <main class="content">
      <div class="market-state" role="status">
        <span>{{ marketLoading ? '正在连接币安 TradFi 行情…' : marketError || '币安 TradFi 合约行情已连接' }}</span>
        <span v-if="marketUpdatedAt">更新于 {{ new Date(marketUpdatedAt).toLocaleTimeString('zh-CN') }}</span>
        <button v-if="marketError" type="button" class="btn sm" @click="loadMarkets">重试</button>
      </div>
      <div class="strip" aria-label="TradFi 自选标的">
        <button
          v-for="symbol in watch"
          :key="symbol"
          type="button"
          class="ticker"
          :class="{ active: symbol === selected }"
          @click="selectAsset(symbol)"
        >
          <div class="ticker-top">
            <span>{{ assetFor(symbol).name }}</span>
            <span>{{ quoteStatus(symbol) }}</span>
          </div>
          <div class="ticker-main">
            <strong class="mono">{{ quotePrice(symbol) }}</strong>
            <em class="mono" :class="isUp(quoteChange(symbol)) ? 'up' : 'down'">{{ quoteChange(symbol) }}</em>
          </div>
          <small class="mono">{{ symbol }}</small>
        </button>
      </div>

      <section class="focus" aria-label="当前标的">
        <div class="focus-left">
          <div class="asset-icon">{{ asset.icon }}</div>
          <div>
            <h2>{{ selected }}</h2>
            <div class="focus-sub">{{ asset.name }}</div>
          </div>
        </div>
        <div class="focus-price">
          <strong class="mono">{{ quotePrice(selected) }}</strong>
          <small class="mono" :class="isUp(quoteChange(selected)) ? 'up' : 'down'">{{ quoteChange(selected) }} · 24h</small>
        </div>
        <div class="focus-metrics">
          <div><span>标的类别</span><b>{{ asset.category }}</b></div>
          <div><span>合约来源</span><b>{{ quoteStatus(selected) }}</b></div>
          <div><span>关联大户市场</span><b>Hyperliquid HIP-3</b></div>
        </div>
        <div class="focus-actions">
          <button type="button" class="btn primary" @click="openAiOrder">✧ AI 分析 / 开单</button>
        </div>
      </section>

      <div class="main-grid">
        <section class="panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">大户成交与持仓</div>
              <div class="panel-sub">展示与当前合约关联的 HIP-3 公开成交、持仓和挂单</div>
            </div>
            <div class="whale-head-actions">
              <span class="section-tag">{{ whaleLoading ? '正在更新' : `${relatedWhaleRows.length} 条记录` }}</span>
              <button type="button" class="btn sm" :disabled="whaleLoading" @click="loadWhales">刷新</button>
            </div>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>地址 / 平台</th>
                  <th>关联标的</th>
                  <th>记录类型</th>
                  <th>方向</th>
                  <th>名义价值</th>
                  <th>价格 / 浮盈亏</th>
                  <th>来源</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in relatedWhaleRows" :key="row.id">
                  <td class="mono muted">{{ whaleTime(row.time) }}</td>
                  <td>
                    <span class="addr mono" :title="row.address">{{ row.address.slice(0, 7) }}…{{ row.address.slice(-5) }}</span><br />
                    <span class="source">{{ row.name || 'Hyperliquid 地址' }}</span>
                  </td>
                  <td>{{ whaleAssetName(row.coin) }}<br /><span class="source mono">{{ row.coin }}</span></td>
                  <td>{{ row.type }}</td>
                  <td>
                    <span class="whale-type" :class="{ short: /空|卖|Short|Sell/i.test(row.direction), order: row.type === '挂单' }">
                      {{ whaleDirection(row.direction) }}<span v-if="row.leverage"> {{ row.leverage }}×</span>
                    </span>
                  </td>
                  <td class="mono">{{ whaleUsd(row.notionalUsd) }}</td>
                  <td class="whale-row-detail"><span v-if="row.price != null">价格 {{ row.price }}</span><br v-if="row.price != null && row.unrealizedPnlUsd != null" /><span v-if="row.unrealizedPnlUsd != null" :class="row.unrealizedPnlUsd >= 0 ? 'up' : 'down'">浮盈亏 {{ row.unrealizedPnlUsd >= 0 ? '+' : '−' }}{{ whaleUsd(row.unrealizedPnlUsd) }}</span></td>
                  <td class="source">{{ row.dex }}<br />{{ row.source }}</td>
                </tr>
                <tr v-if="!relatedWhaleRows.length">
                  <td colspan="8" class="empty">
                    {{ whaleLoading ? '正在查询公开账户数据…' : whaleError || (whaleData?.failedRequests && !whaleData?.successfulRequests ? '上游查询失败，请稍后重试' : '已扫描地址暂无该合约关联的成交、持仓或挂单') }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="panel-foot">
            当前筛选：{{ selected }} · {{ whaleData?.coverageNote || '公开账户数据仅覆盖已扫描的地址。' }}<span v-if="whaleData?.failedRequests"> · {{ whaleData.failedRequests }} 次上游请求失败，结果可能不完整。</span><span v-if="whaleData?.updatedAt"> · 更新 {{ newsTime(whaleData.updatedAt) }}</span><span v-if="whaleData?.stale"> · 当前为缓存数据</span>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">相关新闻</div>
              <div class="panel-sub">按标的关联，优先呈现可能影响价格的事件</div>
            </div>
            <span class="section-tag">{{ intelLoading ? '正在加载' : `${newsRows.length} 条资讯` }}</span>
          </div>
          <div class="feed-tools">
            <div class="chips">
              <button
                v-for="item in NEWS_FILTERS"
                :key="item"
                type="button"
                class="chip"
                :class="{ active: newsFilter === item }"
                @click="newsFilter = item"
              >
                {{ item }}
              </button>
            </div>
            <input v-model="newsQuery" class="search" placeholder="搜索当前标的资讯" aria-label="搜索资讯" />
          </div>
          <div class="news-list">
            <article v-for="row in newsRows" :key="row.url" class="news-item">
              <div class="news-time">
                <b>{{ newsTime(row.publishedAt) }}</b>
              </div>
              <div>
                <div class="news-title">
                  <span class="news-tag" :class="{ important: row.category === '宏观' }">{{ row.category }}</span>
                  <a :href="row.url" target="_blank" rel="noopener noreferrer">{{ row.title }}</a>
                </div>
                <div v-if="row.summary" class="news-summary">{{ row.summary }}</div>
                <div class="news-bottom">{{ row.source }} · 点击查看收录页面</div>
              </div>
              <span class="news-mark">RSS 收录</span>
            </article>
            <div v-if="!newsRows.length" class="empty">{{ intelLoading ? '正在获取相关新闻…' : intelError || intel?.news.error || '当前筛选下没有近期资讯' }}</div>
          </div>
          <div class="panel-foot">来源：{{ intel?.news.source || '待连接' }} · 更新：{{ intel?.news.updatedAt ? newsTime(intel.news.updatedAt) : '—' }}。RSS 为新闻聚合，点击标题核对原始报道。</div>
        </section>
      </div>
    </main>

    <div v-if="aiOpen" class="modal-cover" @click.self="aiOpen = false">
      <div class="dialog" role="dialog" aria-modal="true">
        <div class="dialog-head">
          <div>
            <div class="eyebrow">TRADFI · 币安永续合约</div>
            <h2>AI 分析 / 开单</h2>
          </div>
          <button type="button" class="btn sm" @click="aiOpen = false">×</button>
        </div>
        <div class="dialog-body">
          <p class="dialog-copy">当前标的：<b>{{ selected }}</b>。AI 策略尚未接入；下方是手动订单参数，确认后会提交到币安账户。</p>
          <div class="dialog-section">
            <h3>分析输入</h3>
            <p>相关新闻与事件时间、基础面字段、合约价格结构、已验证的大户记录。缺失字段会在正式策略中标为“无数据”，不会自动补造结论。</p>
          </div>
          <div class="dialog-section">
            <h3>当前策略状态</h3>
            <p>尚未生成 AI 开单建议。请自行选择方向、金额和价格，并核对订单预览。</p>
          </div>
          <div class="form-grid">
            <label class="field">订单方向
              <select v-model="aiSide"><option>做多</option><option>做空</option></select>
            </label>
            <label class="field">订单类型
              <select v-model="aiType"><option>限价单</option><option>市价单</option></select>
            </label>
            <label class="field">保证金（USDT）
              <input v-model.number="aiMargin" type="number" min="1" />
            </label>
            <label class="field">杠杆
              <select v-model="aiLeverage"><option>1×</option><option>2×</option><option>3×</option><option>5×</option></select>
            </label>
            <label v-if="aiType === '限价单'" class="field">限价（USDT）
              <input v-model.number="aiLimitPrice" type="number" min="0" step="any" />
            </label>
          </div>
          <div v-if="orderPreview" class="dialog-section order-preview">
            <h3>订单预览 · {{ orderPreview.testnet === null ? '未配置密钥' : orderPreview.testnet ? '演示盘' : '实盘' }}</h3>
            <p>{{ orderPreview.symbol }} · {{ orderPreview.side === 'BUY' ? '做多' : '做空' }} · {{ orderPreview.type === 'LIMIT' ? `限价 ${orderPreview.price}` : '市价' }} · 数量 {{ orderPreview.quantity }} · 预计名义价值 {{ orderPreview.estimatedNotional.toFixed(2) }} USDT · {{ orderPreview.leverage }}×</p>
            <p>参考现价 {{ orderPreview.referencePrice }} USDT。市价成交价格可能变化；当前订单不附带止损止盈。</p>
          </div>
          <p v-if="orderError" class="order-error" role="alert">{{ orderError }}</p>
          <p v-if="orderResult" class="order-success" role="status">{{ orderResult }}</p>
          <p class="note">保证金范围 1–1000 USDT。测试下单不会进入撮合；实盘确认开单会产生真实交易。</p>
          <div class="dialog-actions">
            <button type="button" class="btn" @click="aiOpen = false">返回页面</button>
            <button type="button" class="btn" :disabled="orderBusy" @click="previewOrder">{{ orderBusy ? '处理中…' : '预览订单参数' }}</button>
            <button v-if="orderPreview && orderConfigured" type="button" class="btn" :disabled="orderBusy" @click="placeOrder(true)">测试下单</button>
            <button v-if="orderPreview && orderConfigured" type="button" class="btn primary" :disabled="orderBusy" @click="placeOrder(false)">确认开单</button>
          </div>
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>
.tradfi {
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
}
.mono { font-variant-numeric: tabular-nums; }
.up { color: var(--green); }
.down { color: var(--red); }
.muted { color: var(--muted); }
.content { box-sizing: border-box; width: 100%; max-width: 1720px; height: 100%; min-height: 0; padding: 16px 28px; margin: auto; display: flex; flex-direction: column; overflow: hidden; }
.market-state { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; color: var(--muted); font-size: 10px; margin-bottom: 12px; }
.market-state, .strip, .focus { flex-shrink: 0; }
.market-state span:first-child { color: var(--yellow); }
.strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(max(130px, calc((100% - 70px) / 8)), 1fr)); gap: 10px; margin-bottom: 18px; max-height: min(330px, 38vh); overflow-y: auto; }
.ticker {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 12px 15px;
  text-align: left;
  color: var(--text);
  min-width: 0;
}
.ticker:hover, .ticker.active {
  border-color: color-mix(in srgb, var(--yellow) 70%, var(--border));
  background: color-mix(in srgb, var(--yellow) 8%, var(--card));
}
.ticker-top { display: flex; justify-content: space-between; gap: 10px; align-items: center; color: var(--muted); font-size: 11px; }
.ticker-top span:last-child { font-size: 9px; }
.ticker-main { display: flex; align-items: baseline; justify-content: space-between; gap: 5px; margin-top: 10px; }
.ticker-main strong { font-size: 19px; }
.ticker-main em { font-size: 12px; font-style: normal; font-weight: 700; }
.ticker small { color: var(--muted); font-size: 10px; display: block; margin-top: 6px; }
.focus {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 17px 20px;
  margin-bottom: 18px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
}
.focus-left { display: flex; align-items: center; gap: 15px; min-width: 0; }
.asset-icon {
  height: 43px; width: 43px; border-radius: 10px;
  background: color-mix(in srgb, var(--yellow) 16%, var(--panel-2));
  color: var(--yellow);
  display: grid; place-items: center;
  font-size: 17px; font-weight: 800; flex: none;
}
.focus h2 { margin: 0; font-size: 19px; }
.focus-sub { color: var(--muted); font-size: 11px; margin-top: 4px; }
.focus-price { text-align: right; }
.focus-price strong { display: block; font-size: 21px; }
.focus-price small { font-size: 11px; }
.focus-metrics { display: flex; gap: 22px; flex-wrap: wrap; }
.focus-metrics span { display: block; color: var(--muted); font-size: 10px; margin-bottom: 5px; }
.focus-metrics b { font-size: 12px; }
.focus-actions { display: flex; gap: 8px; align-items: center; }
.btn {
  border-radius: 6px; padding: 9px 13px; font-size: 11px; font-weight: 700;
  border: 1px solid var(--border); background: var(--panel-2); color: var(--text);
}
.btn:hover { border-color: var(--yellow); }
.btn.primary { background: var(--yellow); border-color: var(--yellow); color: #171716; }
.btn.sm { padding: 7px 10px; }
.btn.ghost { background: transparent; }
.btn:disabled { opacity: 0.5; cursor: default; }
.panel { background: var(--card); border: 1px solid var(--border); border-radius: 10px; min-width: 0; overflow: hidden; }
.panel-head { padding: 16px 18px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; gap: 15px; }
.panel-title { font-size: 15px; font-weight: 750; }
.panel-sub { font-size: 10px; color: var(--muted); margin-top: 5px; }
.section-tag { color: var(--yellow); font-size: 10px; font-weight: 700; }
.main-grid { display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(330px, 0.8fr); gap: 16px; flex: 1; min-height: 0; }
.main-grid > .panel { display: flex; flex-direction: column; min-height: 0; }
.main-grid .panel-head, .main-grid .feed-tools, .main-grid .panel-foot { flex-shrink: 0; }
.whale-head-actions { display: flex; align-items: center; gap: 10px; }
.feed-tools { padding: 12px 18px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.chips { display: flex; gap: 5px; flex-wrap: wrap; }
.chip { border: 1px solid transparent; background: var(--panel-2); border-radius: 5px; color: var(--muted); padding: 6px 10px; font-size: 10px; }
.chip.active { border-color: color-mix(in srgb, var(--yellow) 65%, var(--border)); background: color-mix(in srgb, var(--yellow) 14%, var(--panel-2)); color: var(--yellow); }
.search { width: 160px; border: 1px solid var(--border); outline: 0; background: var(--bg); color: var(--text); border-radius: 6px; padding: 7px 9px; font-size: 11px; }
.search:focus { border-color: var(--yellow); }
.news-list { padding: 0 18px; flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; }
.news-item { display: grid; grid-template-columns: 82px minmax(0, 1fr) auto; gap: 15px; padding: 17px 0; border-bottom: 1px solid var(--border); align-items: start; }
.news-item:last-child { border: 0; }
.news-time { font-size: 10px; color: var(--muted); line-height: 1.5; }
.news-time b { display: block; color: var(--text); font-size: 11px; }
.news-tag { display: inline-block; border-radius: 4px; background: var(--panel-3); color: var(--muted); font-size: 9px; padding: 3px 6px; margin-right: 6px; }
.news-tag.important { background: color-mix(in srgb, var(--yellow) 18%, var(--panel-2)); color: var(--yellow); }
.news-title { font-size: 13px; font-weight: 700; line-height: 1.5; }
.news-title a:hover, .panel-foot a:hover { color: var(--yellow); text-decoration: underline; }
.news-summary { font-size: 11px; color: var(--muted); line-height: 1.6; margin-top: 5px; }
.news-bottom { font-size: 10px; color: var(--muted); margin-top: 8px; }
.news-mark { color: var(--yellow); font-size: 10px; white-space: nowrap; }
.empty { padding: 38px 15px; text-align: center; color: var(--muted); font-size: 12px; }
.panel-foot { border-top: 1px solid var(--border); padding: 11px 18px; color: var(--muted); font-size: 10px; line-height: 1.5; }
.table-wrap { flex: 1; min-height: 0; overflow: auto; }
.table-wrap thead th { position: sticky; top: 0; z-index: 1; }
table { width: 100%; border-collapse: collapse; white-space: nowrap; text-align: left; font-size: 11px; }
th { background: var(--bg-2); color: var(--muted); font-weight: 600; font-size: 10px; padding: 11px 14px; }
td { padding: 13px 14px; border-top: 1px solid var(--border); }
tbody tr:hover { background: var(--panel-2); }
.whale-type { display: inline-block; border-radius: 4px; padding: 4px 7px; background: color-mix(in srgb, var(--green) 18%, var(--panel-2)); color: var(--green); font-size: 10px; font-weight: 700; }
.whale-type.short { background: color-mix(in srgb, var(--red) 18%, var(--panel-2)); color: var(--red); }
.whale-type.order { background: var(--panel-3); color: var(--muted); }
.addr { color: var(--text); }
.source { color: var(--muted); font-size: 10px; }
.wide-meta { color: var(--muted); font-size: 10px; }
.whale-row-detail { color: var(--muted); }
.modal-cover { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.72); z-index: 40; display: flex; align-items: center; justify-content: center; padding: 15px; }
.dialog { width: min(680px, 100%); max-height: 92vh; overflow: auto; background: var(--card); border: 1px solid var(--border-2); border-radius: 12px; box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45); }
.dialog-head { padding: 18px 20px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; gap: 10px; }
.eyebrow { font-size: 10px; letter-spacing: 0.2em; color: var(--yellow); font-weight: 800; }
.dialog-head h2 { margin: 4px 0 0; font-size: 18px; }
.dialog-body { padding: 19px 20px; }
.dialog-copy { font-size: 11px; color: var(--muted); line-height: 1.7; margin: 0 0 15px; }
.dialog-section { border: 1px solid var(--border); border-radius: 8px; padding: 14px; margin-bottom: 12px; }
.dialog-section h3 { margin: 0 0 9px; font-size: 12px; }
.dialog-section p { font-size: 11px; color: var(--muted); line-height: 1.65; margin: 0; }
.form-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
.field { display: grid; gap: 6px; color: var(--muted); font-size: 10px; }
.field input, .field select {
  width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 9px; color: var(--text); outline: 0;
}
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.note { font-size: 10px; color: var(--muted); line-height: 1.6; }
.order-preview { margin-top: 12px; }
.order-preview p + p { margin-top: 8px; }
.order-error { color: var(--red); font-size: 12px; }
.order-success { color: var(--green); font-size: 12px; }
@media (max-width: 760px) {
  .content { padding: 12px 13px; overflow-y: auto; }
  .main-grid { flex: none; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(420px, 1fr) minmax(320px, 1fr); }
  .news-item { grid-template-columns: 60px minmax(0, 1fr); }
  .news-mark { display: none; }
  .form-grid { grid-template-columns: 1fr; }
}
</style>
