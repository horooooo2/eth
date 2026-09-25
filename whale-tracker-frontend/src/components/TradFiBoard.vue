<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch as watchVue } from 'vue';
import { fetchTradFiCatalog, fetchTradFiQuotes, fetchTradFiIntel, fetchAllTradFiWhales, analyzeTradfiAi, previewTradfiAi, streamTradfiAi, type TradfiAiAnalysis, type TradfiAiPreview, type TradfiAiSubmitStage, type TradFiIntelResponse, type TradFiMarketSymbol, type TradFiQuote, type TradFiAllWhaleResponse } from '@/api';
import { ElMessageBox } from 'element-plus';
import OkxAccountPanel from '@/components/OkxAccountPanel.vue';
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
const aiMode = ref<'single' | 'ladder'>('single');
const aiAnalysis = ref<TradfiAiAnalysis | null>(null);
const aiPreview = ref<{ preview: TradfiAiPreview; fingerprint: string; configured: boolean; monitorReady: boolean; simulated: boolean | null } | null>(null);
const aiBusy = ref(false);
const aiActivity = ref<'analysis' | 'preview' | 'submit' | null>(null);
const aiError = ref('');
const aiResult = ref('');
const aiProgressVisible = ref(false);
const aiProgress = ref(0);
const aiProgressSteps = ref<Array<{ id: string; label: string; status: 'pending' | 'running' | 'done' | 'error'; detail: string }>>([]);
function resetAiProgress() { aiProgressVisible.value = false; aiProgress.value = 0; aiProgressSteps.value = []; }
function updateAiProgress(stage: TradfiAiSubmitStage) {
  aiProgress.value = Math.max(aiProgress.value, Math.min(100, stage.progress));
  const step = aiProgressSteps.value.find((item) => item.id === stage.id);
  if (step) { step.status = stage.status; step.detail = stage.message; }
  else if (stage.id === 'cleanup') aiProgressSteps.value.push({ id: stage.id, label: '核对并清理未完成订单', status: 'running', detail: stage.message });
}
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
  aiAnalysis.value = null;
  aiPreview.value = null;
  void loadIntel(symbol);
}

function openAiOrder() {
  aiAnalysis.value = null;
  aiPreview.value = null;
  aiError.value = '';
  aiResult.value = '';
  resetAiProgress();
  aiOpen.value = true;
}

function closeAiOrder() { if (!aiBusy.value) aiOpen.value = false; }

watchVue(aiMode, () => { aiAnalysis.value = null; aiPreview.value = null; aiError.value = ''; aiResult.value = ''; resetAiProgress(); });

async function generateAiPlan() {
  aiBusy.value = true;
  aiActivity.value = 'analysis';
  aiError.value = '';
  aiResult.value = '';
  aiAnalysis.value = null;
  aiPreview.value = null;
  resetAiProgress();
  try {
    aiAnalysis.value = await analyzeTradfiAi(selected.value, aiMode.value);
  } catch (err) {
    aiError.value = err instanceof Error ? err.message : 'TradFi AI 分析失败';
  } finally { aiBusy.value = false; aiActivity.value = null; }
}

async function previewAiPlan() {
  if (!aiAnalysis.value) return;
  aiBusy.value = true;
  aiActivity.value = 'preview';
  aiError.value = '';
  try {
    aiPreview.value = await previewTradfiAi(aiAnalysis.value.analysisId);
  } catch (err) {
    aiPreview.value = null;
    aiError.value = err instanceof Error ? err.message : '整套挂单预览失败';
  } finally { aiBusy.value = false; aiActivity.value = null; }
}

async function submitAiPlan() {
  const ready = aiPreview.value;
  const analysis = aiAnalysis.value;
  if (!ready || !analysis || aiBusy.value || !ready.configured || !ready.monitorReady) return;
  try {
    await ElMessageBox.confirm(
      `${ready.simulated ? '演示盘' : '实盘'} · ${ready.preview.symbol} · ${ready.preview.orders.length} 笔 Maker 挂单 · 总保证金 ${ready.preview.totalMarginUsdt.toFixed(2)} USDT · 最多预计亏损 ${ready.preview.estimatedLossUsdt.toFixed(2)} USDT。确认提交整套计划？`,
      '确认币安整套挂单', { confirmButtonText: '确认提交', cancelButtonText: '取消', type: 'warning' },
    );
  } catch { return; }
  aiBusy.value = true;
  aiActivity.value = 'submit';
  aiError.value = '';
  aiResult.value = '';
  aiProgressVisible.value = true;
  aiProgress.value = 0;
  aiProgressSteps.value = [
    { id: 'prepare', label: '核对账户与订单', status: 'pending', detail: '' },
    ...ready.preview.orders.flatMap((_, index) => [
      { id: `leg-${index}-entry`, label: `第 ${index + 1} 笔入场单`, status: 'pending' as const, detail: '' },
      { id: `leg-${index}-stop`, label: `第 ${index + 1} 笔止损单`, status: 'pending' as const, detail: '' },
      { id: `leg-${index}-take`, label: `第 ${index + 1} 笔止盈单`, status: 'pending' as const, detail: '' },
    ]),
    { id: 'verify', label: '核验全部保护单', status: 'pending', detail: '' },
  ];
  try {
    const response = await streamTradfiAi(analysis.analysisId, ready.fingerprint, updateAiProgress);
    aiProgress.value = 100;
    aiProgressSteps.value.forEach((step) => { step.status = 'done'; });
    aiResult.value = `${response.simulated ? '演示盘' : '实盘'}已提交 ${response.orders.length} 笔挂单和 ${response.protections.length} 笔保护单，请在币安订单列表核对。`;
    aiPreview.value = null;
  } catch (err) {
    aiPreview.value = null;
    const running = aiProgressSteps.value.find((step) => step.status === 'running');
    if (running) running.status = 'error';
    aiError.value = `${err instanceof Error ? err.message : '提交失败'}。请在币安核对订单状态，勿直接重复提交。`;
  } finally { aiBusy.value = false; aiActivity.value = null; }
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
        <section class="panel account-column">
          <div class="panel-head"><div><div class="panel-title">交易账户</div><div class="panel-sub">币安 · TradFi 持仓与挂单</div></div></div>
          <OkxAccountPanel exchange="tradfi" :boot-ready="true" :active="active !== false" />
        </section>
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

    <Teleport to="body">
      <div v-if="aiOpen" class="modal-cover" @click.self="closeAiOrder">
        <div class="dialog" role="dialog" aria-modal="true" aria-label="TradFi AI 分析与挂单">
          <header class="dialog-head">
            <div class="dialog-title"><span aria-hidden="true">✨</span> DeepSeek 智能投研 <span class="dialog-symbol">· {{ selected }}</span></div>
            <button type="button" class="dialog-close" aria-label="关闭" :disabled="aiBusy" @click="closeAiOrder">×</button>
          </header>

          <div class="dialog-body">
            <div v-if="aiAnalysis" class="analysis-status" :class="aiAnalysis.plan.direction === 'BUY' ? 'bull' : aiAnalysis.plan.direction === 'SELL' ? 'bear' : 'neutral'">
              <strong>{{ selected }} · {{ aiAnalysis.plan.marketState }} · {{ aiAnalysis.plan.decision }}</strong>
              <span>{{ aiAnalysis.plan.decision === '暂缓' ? '等待更清晰的机会' : aiAnalysis.plan.direction === 'BUY' ? '方向：做多' : '方向：做空' }}</span>
            </div>
            <div class="dialog-scroll">
              <div class="order-steps"><span :class="{ active: !aiAnalysis }">1 · AI 分析</span><span :class="{ active: aiAnalysis && !aiPreview }">2 · 预览订单</span><span :class="{ active: aiPreview }">3 · 确认挂单</span></div>
              <section v-if="aiProgressVisible" class="submit-progress" aria-live="polite">
                <div class="submit-progress-head"><strong>逐笔提交进度</strong><span>{{ aiProgress }}%</span></div>
                <div class="submit-progress-track"><div class="submit-progress-fill" :style="{ width: `${aiProgress}%` }" /></div>
                <div class="submit-progress-list"><div v-for="step in aiProgressSteps" :key="step.id" class="submit-progress-step" :class="step.status"><span class="submit-progress-dot" /><span>{{ step.label }}</span><small v-if="step.status !== 'pending'">{{ step.detail }}</small></div></div>
              </section>
              <template v-if="!aiAnalysis && aiActivity !== 'analysis'">
                <p class="dialog-intro">选择开单方式，AI 将以小时线判断盘中方向，用 15、5、1 分钟线寻找挂单位置，并结合日线、资讯与盘口评估风险。</p>
                <div class="mode-label">开单方式</div>
                <div class="mode-options">
                  <button type="button" class="mode-option" :class="{ active: aiMode === 'single' }" @click="aiMode = 'single'"><strong>单笔开仓</strong><span>一笔 Maker 限价挂单，附止盈止损</span></button>
                  <button type="button" class="mode-option" :class="{ active: aiMode === 'ladder' }" @click="aiMode = 'ladder'"><strong>初始单＋两档加仓</strong><span>趋势时三档；震荡时自动转为单笔试探</span></button>
                </div>
              </template>

              <div v-if="aiActivity === 'analysis'" class="loading-state"><div class="spinner" /><strong>AI 正在静默分析</strong><span>正在核对价格结构、资讯与市场数据…</span></div>
              <div v-if="aiActivity === 'preview'" class="loading-state"><div class="spinner" /><strong>正在核算订单</strong><span>读取币安实时盘口与合约规则…</span></div>

              <template v-if="aiAnalysis && aiActivity !== 'preview'">
                <p class="result-reason">{{ aiAnalysis.plan.reason || '暂无明确交易结论' }}</p>
                <div class="structure-grid">
                  <section class="structure-card"><div class="structure-head">入场 · 1 / 5 / 15 分钟</div><p>{{ aiAnalysis.plan.shortView || '数据不足' }}</p></section>
                  <section class="structure-card"><div class="structure-head">方向 · 1 小时</div><p>{{ aiAnalysis.plan.longView || '数据不足' }}</p></section>
                </div>
                <div v-if="aiAnalysis.plan.dayView" class="market-meta">日线背景：{{ aiAnalysis.plan.dayView }}</div>
                <div class="market-meta">底层市场：{{ aiAnalysis.context.underlyingSession?.type || 'UNKNOWN' }} · 现价 {{ aiAnalysis.context.referencePrice }} · 标记价 {{ aiAnalysis.context.markPrice ?? '—' }} · 指数价 {{ aiAnalysis.context.indexPrice ?? '—' }}</div>
                <div v-if="aiAnalysis.plan.thesis" class="market-meta">主要判断：{{ aiAnalysis.plan.thesis }} · 基本面 {{ aiAnalysis.plan.fundamentalBias }}</div>
                <div v-if="aiAnalysis.plan.rangeLow && aiAnalysis.plan.rangeHigh" class="market-meta">震荡区间 {{ aiAnalysis.plan.rangeLow }} – {{ aiAnalysis.plan.rangeHigh }}；只在区间边缘考虑试探。</div>

                <section v-if="aiAnalysis.plan.decision !== '暂缓'" class="plan-card">
                  <div class="plan-head"><strong>{{ aiAnalysis.plan.mode === 'probe' ? '小仓位试探计划' : aiAnalysis.plan.mode === 'ladder' ? '分批加仓计划' : '单笔开仓计划' }}</strong><span>{{ aiAnalysis.plan.direction === 'BUY' ? '做多' : '做空' }} · {{ aiAnalysis.plan.leverage }}×</span></div>
                  <div class="price-grid"><span>止损 <b>{{ aiAnalysis.plan.stop }}</b></span><span>止盈 <b>{{ aiAnalysis.plan.takeProfit }}</b></span></div>
                  <div v-for="(leg, index) in aiAnalysis.plan.orders" :key="index" class="ai-leg"><strong>{{ aiAnalysis.plan.mode === 'probe' ? '试探单' : index ? `加仓 ${index}` : '初始单' }} · {{ leg.price }}</strong><span>保证金 {{ leg.marginUsdt }} USDT</span><p>{{ leg.reason }}</p></div>
                  <p class="preview-note">失效条件：{{ aiAnalysis.plan.invalidation }}</p>
                  <p v-if="aiAnalysis.plan.mode === 'ladder'" class="preview-note">确认后全部档位会立即挂到币安；后续基本面变化不会自动重新判断或撤单。</p>
                </section>
                <div v-else class="plan-card muted-plan">当前没有可提交的挂单计划。可重新分析，等待新的市场数据。</div>

                <details v-if="aiAnalysis.plan.evidence.length" class="analysis-details"><summary>查看分析依据</summary><p v-for="(item, index) in aiAnalysis.plan.evidence" :key="index">{{ item }}</p></details>
              </template>

              <section v-if="aiPreview" class="preview-card">
                <div class="plan-head"><strong>币安订单预览</strong><span>{{ aiPreview.simulated === null ? '未配置密钥' : aiPreview.simulated ? '演示盘' : '实盘' }}</span></div>
                <div class="preview-summary"><span>总保证金 <b>{{ aiPreview.preview.totalMarginUsdt.toFixed(2) }} USDT</b></span><span>总名义价值 <b>{{ aiPreview.preview.totalNotionalUsdt.toFixed(2) }} USDT</b></span><span>预计止损亏损 <b>{{ aiPreview.preview.estimatedLossUsdt.toFixed(2) }} USDT</b></span></div>
                <div v-for="(leg, index) in aiPreview.preview.orders" :key="index" class="ai-leg"><strong>{{ aiPreview.preview.mode === 'probe' ? '试探单' : index ? `加仓 ${index}` : '初始单' }} · Maker 限价 {{ leg.price }}</strong><span>数量 {{ leg.quantity }} · 保证金 {{ leg.marginUsdt }} USDT</span></div>
                <div class="price-grid"><span>止损 <b>{{ aiPreview.preview.stopPrice }}</b></span><span>止盈 <b>{{ aiPreview.preview.takePrice }}</b></span></div>
                <p class="preview-note">现价 {{ aiPreview.preview.last }} · 全部成交均价 {{ aiPreview.preview.averagePrice.toFixed(4) }} · 未成交挂单到期 {{ new Date(aiPreview.preview.expiresAt).toLocaleString('zh-CN') }}。预计亏损未计费用与滑点。</p>
                <p v-if="!aiPreview.configured" class="order-error">请先在左下角「API 设置」配置币安 API 密钥。</p>
                <p v-if="!aiPreview.monitorReady" class="order-error">常驻订单监控未运行，当前不能提交整套挂单。</p>
              </section>

              <p v-if="aiError" class="order-error" role="alert">{{ aiError }}</p>
              <p v-if="aiResult" class="order-success" role="status">{{ aiResult }}</p>
            </div>
          </div>

          <footer class="dialog-footer">
            <p class="footer-hint">挂单直接提交到币安；止盈止损触发后按市价执行。</p>
            <div class="footer-actions">
              <button type="button" class="btn" :disabled="aiBusy" @click="closeAiOrder">关闭</button>
              <button v-if="!aiAnalysis || aiResult" type="button" class="btn primary" :disabled="aiBusy" @click="generateAiPlan">{{ aiActivity === 'analysis' ? '分析中…' : '开始 AI 分析' }}</button>
              <template v-else>
                <button type="button" class="btn" :disabled="aiBusy" @click="generateAiPlan">重新分析</button>
                <button v-if="!aiPreview" type="button" class="btn primary" :disabled="aiBusy || aiAnalysis.plan.decision === '暂缓'" @click="previewAiPlan">{{ aiActivity === 'preview' ? '预览中…' : aiAnalysis.plan.decision === '暂缓' ? '暂无可预览订单' : aiAnalysis.plan.mode === 'probe' ? '预览试探单' : '预览订单' }}</button>
                <button v-else type="button" class="btn primary" :disabled="aiBusy || !aiPreview.configured || !aiPreview.monitorReady" @click="submitAiPlan">{{ aiActivity === 'submit' ? '提交中…' : '确认在币安挂单' }}</button>
              </template>
            </div>
          </footer>
        </div>
      </div>
    </Teleport>

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
.content { box-sizing: border-box; width: 100%; height: 100%; min-height: 0; padding: 16px 0; display: flex; flex-direction: column; overflow: hidden; }
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
.main-grid { display: grid; grid-template-columns: minmax(270px, .78fr) minmax(0, 1.65fr) minmax(320px, .9fr); gap: 12px; flex: 1; min-height: 0; }
.main-grid > .panel { display: flex; flex-direction: column; min-height: 0; }
.main-grid .panel-head, .main-grid .feed-tools, .main-grid .panel-foot { flex-shrink: 0; }
.account-column :deep(.okx-panel) { flex: 1; height: auto; min-height: 0; }
.account-column :deep(.account-summary) { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 12px; }
.account-column :deep(.data-card:last-child) { grid-column: 1 / -1; }
.account-column :deep(.order-list) { padding: 10px 12px; }
.account-column :deep(.order-card) { padding: 12px; }
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
.modal-cover { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box; background: rgba(0, 0, 0, .72); }
.dialog { width: min(800px, 100%); height: 680px; max-height: 96vh; display: flex; flex-direction: column; overflow: hidden; background: var(--card); border: 1px solid var(--border); border-radius: 14px; box-shadow: 0 24px 64px rgba(0, 0, 0, .5); }
.dialog-head { flex: none; min-height: 62px; box-sizing: border-box; padding: 14px 18px; border-bottom: 1px solid var(--border); background: linear-gradient(to right, rgba(99, 102, 241, .14), transparent); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dialog-title { color: var(--text); font-size: 16px; font-weight: 750; }
.dialog-symbol { color: var(--muted); }
.dialog-close { border: 0; background: transparent; color: var(--muted); font-size: 22px; cursor: pointer; }
.dialog-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dialog-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 18px 20px; }
.order-steps { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px; }
.order-steps span { border: 1px solid var(--border); border-radius: 999px; padding: 6px 10px; color: var(--muted); font-size: 11px; }
.order-steps span.active { border-color: #818cf8; color: #c7d2fe; background: rgba(99, 102, 241, .13); }
.analysis-status { flex: none; padding: 12px 20px; border-bottom: 1px solid var(--border); background: var(--panel-2); display: flex; justify-content: space-between; gap: 12px; align-items: center; }
.analysis-status.bull { background: rgba(14, 203, 129, .12); border-bottom-color: rgba(14, 203, 129, .35); }
.analysis-status.bear { background: rgba(246, 70, 93, .12); border-bottom-color: rgba(246, 70, 93, .35); }
.analysis-status.neutral { background: rgba(132, 142, 156, .12); }
.analysis-status span { color: var(--muted); font-size: 12px; }
.dialog-intro { margin: 0 0 24px; color: var(--muted); line-height: 1.7; }
.mode-label { color: var(--text); font-weight: 700; margin-bottom: 10px; }
.mode-options, .structure-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.mode-option { min-height: 96px; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 9px; padding: 16px; text-align: left; color: var(--text); background: var(--panel-2); border: 1px solid var(--border); border-radius: 12px; cursor: pointer; }
.mode-option.active { border-color: #818cf8; background: color-mix(in srgb, #6366f1 13%, var(--panel-2)); }
.mode-option strong { font-size: 14px; }
.mode-option span { color: var(--muted); font-size: 12px; }
.loading-state { min-height: 300px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--muted); text-align: center; }
.loading-state strong { color: var(--text); font-size: 14px; }
.spinner { width: 40px; height: 40px; border: 3px solid rgba(99, 102, 241, .25); border-top-color: #818cf8; border-radius: 50%; animation: spin .9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.result-reason { margin: 0 0 14px; color: var(--text); line-height: 1.7; font-size: 13px; }
.structure-card, .plan-card, .preview-card { padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--panel-2); }
.structure-head { color: var(--text); font-weight: 750; margin-bottom: 8px; }
.structure-card p { margin: 0; color: var(--muted); line-height: 1.6; font-size: 12px; }
.market-meta { margin: 12px 0 16px; color: var(--muted); font-size: 12px; line-height: 1.6; }
.plan-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; color: var(--text); font-size: 14px; }
.plan-head span { color: #818cf8; font-size: 12px; font-weight: 700; }
.price-grid, .preview-summary { display: flex; flex-wrap: wrap; gap: 10px 18px; margin: 14px 0; color: var(--muted); font-size: 12px; }
.price-grid b, .preview-summary b { color: var(--text); }
.ai-leg { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; margin-top: 8px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; color: var(--muted); font-size: 12px; line-height: 1.6; }
.ai-leg strong { color: var(--text); }
.ai-leg p { flex-basis: 100%; margin: 0; }
.muted-plan { color: var(--muted); line-height: 1.6; }
.analysis-details { margin: 16px 0; padding-top: 12px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; }
.analysis-details summary { cursor: pointer; }
.analysis-details p { margin: 8px 0 0; line-height: 1.6; }
.preview-card { margin-top: 14px; border-color: color-mix(in srgb, #818cf8 45%, var(--border)); }
.preview-note { color: var(--muted); font-size: 12px; line-height: 1.7; }
.order-error { color: var(--red); font-size: 12px; line-height: 1.6; }
.order-success { color: var(--green); font-size: 12px; line-height: 1.6; }
.submit-progress { position: sticky; top: 0; z-index: 2; margin: 8px 0 16px; padding: 14px; border: 1px solid #818cf8; border-radius: 10px; background: var(--card); box-shadow: 0 8px 24px rgba(0, 0, 0, .2); }
.submit-progress-head { display: flex; justify-content: space-between; margin-bottom: 10px; color: var(--text); }
.submit-progress-track { height: 8px; overflow: hidden; border-radius: 8px; background: var(--panel-2); }
.submit-progress-fill { height: 100%; background: linear-gradient(90deg, #6366f1, #a855f7); transition: width .25s ease; }
.submit-progress-list { max-height: 175px; overflow-y: auto; margin-top: 10px; }
.submit-progress-step { display: flex; align-items: center; gap: 8px; padding: 3px 0; color: var(--muted); font-size: 12px; }
.submit-progress-step small { margin-left: auto; text-align: right; }
.submit-progress-step.done { color: var(--green); }
.submit-progress-step.running { color: #818cf8; }
.submit-progress-step.error { color: var(--red); }
.submit-progress-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.dialog-footer { flex: none; padding: 12px 18px; border-top: 1px solid var(--border); background: var(--card); }
.footer-hint { margin: 0 0 10px; color: var(--muted); font-size: 11px; line-height: 1.5; }
.footer-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
.footer-actions .btn { min-height: 36px; font-size: 12px; }
.footer-actions .btn.primary { background: linear-gradient(135deg, #6366f1, #a855f7); color: #fff; border-color: transparent; }
.footer-actions .btn:disabled { opacity: .5; cursor: not-allowed; }
@media (max-width: 1180px) {
  .content { overflow-y: auto; }
  .main-grid { flex: none; grid-template-columns: minmax(260px, .7fr) minmax(0, 1.3fr); grid-template-rows: minmax(420px, 60vh) minmax(320px, 45vh); }
  .main-grid > .panel:last-child { grid-column: 1 / -1; }
}
@media (max-width: 760px) {
  .content { padding: 12px 0; }
  .main-grid { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(360px, 50vh) minmax(420px, 55vh) minmax(320px, 45vh); }
  .main-grid > .panel:last-child { grid-column: auto; }
  .news-item { grid-template-columns: 60px minmax(0, 1fr); }
  .news-mark { display: none; }
  .mode-options, .structure-grid { grid-template-columns: 1fr; }
  .dialog-scroll { padding: 14px; }
  .analysis-status { align-items: flex-start; flex-direction: column; }
  .footer-actions .btn { flex: 1; }
}
</style>
