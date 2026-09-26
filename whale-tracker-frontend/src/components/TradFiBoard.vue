<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch as watchVue } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { closeTradfiPositions, fetchTradFiCatalog, fetchTradFiQuotes, fetchTradFiIntel, fetchTradfiRangeStatus, startTradfiRangeWithConfig, stopTradfiRange, type BinanceAiTradeRecord, type OkxAiBook, type TradfiRangeResponse, type TradFiIntelResponse, type TradFiMarketSymbol, type TradFiQuote } from '@/api';
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
const strategyOpen = ref(false);
const strategyBusy = ref(false);
const strategyError = ref('');
const strategyData = ref<TradfiRangeResponse | null>(null);
const strategyMargin = ref(10);
const strategyLeverage = ref(10);
const showStartupProgress = ref(false);
const closingAll = ref(false);
const accountBook = ref<OkxAiBook | null>(null);
const accountPanel = ref<{ reload: () => void } | null>(null);
let quoteTimer = 0;
let intelTimer = 0;
let intelRequestId = 0;
let strategyTimer = 0;
const catalog = ref<TradFiMarketSymbol[]>([]);
const quotes = ref<Record<string, TradFiQuote>>({});
const marketError = ref('');
const marketLoading = ref(true);
const marketUpdatedAt = ref('');
const intel = ref<TradFiIntelResponse | null>(null);
const intelLoading = ref(false);
const intelError = ref('');
const strategySupported = computed(() => selected.value === 'XAUUSDT' || selected.value === 'XAGUSDT');
const tradeRows = computed(() => (accountBook.value?.trades || []).filter((row) => row.instId === selected.value).slice(0, 50));
const historyTab = ref<'trades' | 'logs'>('trades');
const strategyLogs = computed(() => strategyData.value?.events || []);
const startupLogs = computed(() => strategyLogs.value.filter((row) => row.details?.phase === 'startup').slice().reverse());
const startupProgress = computed(() => Math.max(0, Math.min(100, Number(strategyData.value?.strategy.startupProgress || 0))));
const accountWeekendMode = computed(() => Boolean(accountBook.value?.weekendMode ?? strategyData.value?.strategy.weekendMode));

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
  if (props.active && strategySupported.value) void loadStrategy();
  strategyTimer = window.setInterval(() => { if (props.active && strategySupported.value) void loadStrategy(true); }, 15_000);
});
onUnmounted(() => { window.clearInterval(quoteTimer); window.clearInterval(intelTimer); window.clearInterval(strategyTimer); });
watchVue(() => props.active, (active) => { if (active && strategySupported.value) void loadStrategy(); });
watchVue(watch, (symbols) => { if (!symbols.includes(selected.value)) selectAsset(symbols[0]); void refreshQuotes(); });

const newsRows = computed(() => {
  const q = newsQuery.value.trim().toLowerCase();
  return (intel.value?.news.items || []).filter((row) => (newsFilter.value === '全部' || row.category === newsFilter.value) && (!q || `${row.title} ${row.summary}`.toLowerCase().includes(q)));
});
function isUp(change: string) { return change.startsWith('+'); }
function newsTime(raw: string | number | null) {
  if (!raw) return '时间未提供';
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '时间未提供';
}
async function loadIntel(symbol: string) {
  const requestId = ++intelRequestId; intel.value = null; intelLoading.value = true; intelError.value = '';
  try { const data = await fetchTradFiIntel(symbol); if (selected.value === symbol && requestId === intelRequestId) intel.value = data; }
  catch (err) { if (selected.value === symbol && requestId === intelRequestId) intelError.value = err instanceof Error ? err.message : '资讯获取失败'; }
  finally { if (selected.value === symbol && requestId === intelRequestId) intelLoading.value = false; }
}
function selectAsset(symbol: string) {
  if (!watch.value.includes(symbol) && !catalogBySymbol.value.has(symbol)) return;
  selected.value = symbol; strategyData.value = null; strategyError.value = ''; void loadIntel(symbol);
  if (symbol === 'XAUUSDT' || symbol === 'XAGUSDT') void loadStrategy();
}
async function loadStrategy(silent = false) {
  if (!strategySupported.value) return;
  if (!silent) strategyBusy.value = true;
  try { strategyData.value = await fetchTradfiRangeStatus(selected.value); strategyError.value = ''; }
  catch (err) { strategyError.value = err instanceof Error ? err.message : '震荡策略状态加载失败'; }
  finally { if (!silent) strategyBusy.value = false; }
}
async function openStrategy() {
  strategyOpen.value = true;
  await loadStrategy();
  if (!strategyData.value?.strategy.enabled) {
    strategyMargin.value = Number(strategyData.value?.strategy.marginPerOrder || 10);
    strategyLeverage.value = Number(strategyData.value?.strategy.leverage || 10);
  }
}
function closeStrategy() { if (!strategyBusy.value) strategyOpen.value = false; }
function onAccountLoaded(book: OkxAiBook) { accountBook.value = book; }
function tradeDirection(row: BinanceAiTradeRecord) {
  const direction = row.posSide === 'short' ? '空' : row.posSide === 'long' ? '多' : row.side === 'sell' ? '空' : '多';
  return row.source === 'manual' ? `${direction}手动平仓` : `${direction}${row.action === 'close' ? '平仓' : '开仓'}`;
}
function tradeTagClass(row: BinanceAiTradeRecord) {
  return row.posSide === 'short' || (row.posSide !== 'long' && row.side === 'sell') ? 'short' : 'long';
}
function tradeAmount(value: number | null) { return value == null ? '—' : `${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} U`; }
function tradeFee(row: BinanceAiTradeRecord) {
  const fee = Number(row.commission);
  if (!Number.isFinite(fee)) return '—';
  return `-${fee.toLocaleString('zh-CN', { maximumFractionDigits: 8 })} ${row.commissionAsset || 'USDT'}`;
}
function tradePrice(value: number | null) { return value == null ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: 6 }); }
function tradeTime(raw: number | null) {
  if (!raw) return '—';
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return '—';
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}
function tradeClock(raw: number | null) {
  if (!raw) return '—';
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return '—';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
function logLevelLabel(level: string) {
  if (level === 'error') return '异常';
  if (level === 'warn') return '提醒';
  if (level === 'success') return '完成';
  if (level === 'trade') return '交易';
  return '运行';
}
function pnlClass(value: number | null) {
  if (value == null || !Number.isFinite(value) || value === 0) return 'pnl-zero';
  return value > 0 ? 'pnl-positive' : 'pnl-negative';
}
async function toggleStrategy() {
  if (!strategySupported.value || strategyBusy.value) return;
  strategyBusy.value = true; strategyError.value = '';
  try {
    if (strategyData.value?.strategy.enabled) {
      strategyData.value = await stopTradfiRange(selected.value);
      showStartupProgress.value = false;
    } else {
      showStartupProgress.value = true;
      let adoptExisting = false;
      for (let pass = 0; pass < 2; pass += 1) {
        strategyData.value = await startTradfiRangeWithConfig(selected.value, { marginUsdt: Number(strategyMargin.value), leverage: Number(strategyLeverage.value), adoptExisting });
        for (let attempt = 0; attempt < 90 && strategyData.value?.strategy.status === 'initializing'; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 500));
          strategyData.value = await fetchTradfiRangeStatus(selected.value);
        }
        if (strategyData.value?.strategy.status !== 'adoption_required') break;
        const positions = strategyData.value.strategy.adoptionPositions;
        const summary = `多仓 ${positions?.long.quantity || 0}（均价 ${positions?.long.entryPrice || '—'}）\n空仓 ${positions?.short.quantity || 0}（均价 ${positions?.short.entryPrice || '—'}）`;
        try {
          await ElMessageBox.confirm(`检测到来源不明确的现有仓位：\n${summary}\n\n确认后，策略将按币安实际仓位继续补仓与止盈。`, '确认接管现有仓位', { type: 'warning', confirmButtonText: '确认接管', cancelButtonText: '取消' });
        } catch {
          strategyError.value = '已取消接管，现有仓位保持人工管理';
          break;
        }
        adoptExisting = true;
      }
    }
  }
  catch (err) { strategyError.value = err instanceof Error ? err.message : '震荡策略操作失败'; }
  finally { strategyBusy.value = false; }
}
async function closeAllPositions() {
  if (closingAll.value) return;
  try {
    await ElMessageBox.confirm('将撤销本站震荡策略的未成交入场单，并为黄金、白银策略持仓提交接近市价的 Post Only 平仓单。订单需要等待成交。', '确认一键平仓', { type: 'warning', confirmButtonText: '提交平仓单', cancelButtonText: '取消' });
  } catch { return; }
  closingAll.value = true;
  try {
    const result = await closeTradfiPositions();
    ElMessage.success(result.submitted.length ? `已提交 ${result.submitted.length} 笔 Maker 平仓单` : '没有可平的策略仓位或挂单');
    void loadStrategy(true);
    void accountPanel.value?.reload();
  } catch (err) { ElMessage.error(err instanceof Error ? err.message : '一键平仓提交失败'); }
  finally { closingAll.value = false; }
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
          <button v-if="strategySupported" type="button" class="btn primary" @click="openStrategy">震荡交易</button>
        </div>
      </section>

      <div class="main-grid">
        <section class="panel history-panel">
          <div class="panel-head">
            <div>
              <div class="history-tabs" role="tablist" aria-label="策略记录">
                <button type="button" :class="{ active: historyTab === 'trades' }" @click="historyTab = 'trades'">交易记录</button>
                <button type="button" :class="{ active: historyTab === 'logs' }" @click="historyTab = 'logs'">运行日志</button>
              </div>
              <div class="panel-sub">{{ historyTab === 'trades' ? '币安成功成交明细' : '当前标的策略运行记录' }}</div>
            </div>
            <div class="panel-count">{{ historyTab === 'trades' ? `${tradeRows.length} 条` : `${strategyLogs.length} 条` }}</div>
          </div>
          <div v-show="historyTab === 'trades'" class="history-list">
            <div class="record-table-head">
              <span>品种/方向</span><span>成交价</span><span>数量 / 成交额</span><span>已实现盈亏</span><span>时间</span>
            </div>
            <article v-for="row in tradeRows" :key="row.tradeId" class="record-row">
              <div class="record-symbol"><span>{{ row.coin }}</span><span class="tag" :class="tradeTagClass(row)">{{ tradeDirection(row) }}</span></div>
              <div class="record-price">{{ tradePrice(row.px) }}</div>
              <div class="record-amount">{{ row.sz }} / {{ tradeAmount(row.amountUsd) }}</div>
              <div class="record-pnl" :class="pnlClass(row.realizedPnl)" :title="`交易费用 ${tradeFee(row)}`">
                <span>{{ tradeAmount(row.realizedPnl) }}</span><small>{{ tradeFee(row) }}</small>
              </div>
              <div class="record-time" :title="tradeTime(row.createdAt)">{{ tradeClock(row.createdAt) }}</div>
            </article>
            <div v-if="!tradeRows.length" class="empty">暂无该标的策略成交记录</div>
          </div>
          <div v-show="historyTab === 'logs'" class="history-list log-list">
            <article v-for="row in strategyLogs" :key="row.id" class="strategy-log-row" :class="`level-${row.level}`">
              <div class="log-top"><span class="log-level">{{ logLevelLabel(row.level) }}</span><time>{{ tradeTime(row.created_at) }}</time></div>
              <p>{{ row.message }}</p>
            </article>
            <div v-if="!strategyLogs.length" class="empty">暂无该标的策略运行记录</div>
          </div>
        </section>
        <section class="panel account-panel">
          <div class="panel-head">
            <div>
              <div class="account-title-line">
                <div class="panel-title">交易账户</div>
                <span v-if="accountWeekendMode" class="weekend-warning" title="周末流动性模式：暂停新建底仓和止盈后的仓位重建；已有仓位继续补仓与止盈。">
                  <b>?</b> 周末流动性模式：暂停新建底仓和止盈后的仓位重建；已有仓位继续补仓与止盈。
                </span>
              </div>
              <div class="panel-sub">币安 · TradFi 自动策略持仓与挂单</div>
            </div>
            <button type="button" class="btn-close-all" :disabled="closingAll" @click="closeAllPositions">{{ closingAll ? '提交中…' : '一键平仓' }}</button>
          </div>
          <OkxAccountPanel ref="accountPanel" exchange="tradfi" :boot-ready="true" :active="active !== false" @loaded="onAccountLoaded" />
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
      <div v-if="strategyOpen" class="modal-cover" @click.self="closeStrategy">
        <div class="dialog strategy-dialog" role="dialog" aria-modal="true" aria-label="震荡交易">
          <header class="dialog-head"><div class="dialog-title">震荡交易 <span class="dialog-symbol">· {{ selected }}</span></div><button type="button" class="dialog-close" :disabled="strategyBusy" @click="closeStrategy">×</button></header>
          <div class="dialog-scroll">
            <section class="strategy-state">
              <strong>{{ strategyData?.strategy.status === 'initializing' ? '启动检查中' : strategyData?.strategy.enabled ? '服务器运行中' : strategyData?.strategy.status === 'adoption_required' ? '等待确认接管' : strategyData?.strategy.status === 'manual' ? '人工接管' : '未运行' }}</strong>
              <span>{{ strategyData?.strategy.simulated == null ? '币安账户待核对' : strategyData.strategy.simulated ? '演示盘' : '实盘' }}</span>
            </section>
            <section v-if="showStartupProgress || strategyData?.strategy.status === 'initializing'" class="startup-progress" aria-live="polite">
              <div class="startup-progress-head"><strong>启动检查进度</strong><span>{{ startupProgress }}%</span></div>
              <div class="startup-progress-track"><div class="startup-progress-fill" :style="{ width: `${startupProgress}%` }" /></div>
              <div class="startup-current">{{ strategyData?.strategy.startupStep || '等待服务器开始检查' }}</div>
              <div class="startup-log-list">
                <div v-for="row in startupLogs" :key="row.id" class="startup-log-item" :class="`level-${row.level}`">
                  <i /> <span>{{ row.message }}</span><time>{{ tradeClock(row.created_at) }}</time>
                </div>
              </div>
            </section>
            <div class="strategy-config">
              <label>单边保证金 <input v-model.number="strategyMargin" type="number" min="1" max="20" step="1" :disabled="strategyData?.strategy.enabled || strategyData?.strategy.resumeEligible || strategyBusy" /><b>USDT</b></label>
              <label>杠杆 <input v-model.number="strategyLeverage" type="number" min="1" max="50" step="1" :disabled="strategyData?.strategy.enabled || strategyData?.strategy.resumeEligible || strategyBusy" /><b>×</b></label>
              <span>{{ strategyData?.strategy.enabled ? '策略运行中，参数已锁定' : strategyData?.strategy.resumeEligible ? '恢复接管时沿用暂停前参数' : '启动后参数锁定' }}</span>
            </div>
            <div class="strategy-metrics">
              <div><span>单笔保证金</span><b>{{ strategyData?.strategy.marginPerOrder ?? strategyMargin }} USDT</b></div><div><span>杠杆</span><b>{{ strategyData?.strategy.leverage ?? strategyLeverage }}×</b></div>
              <div><span>已补仓</span><b v-if="strategyData?.strategy.longAdditions == null && strategyData?.strategy.shortAdditions == null">{{ strategyData?.strategy.additions || 0 }} / 20</b><b v-else>多 {{ strategyData?.strategy.longAdditions || 0 }}/20 · 空 {{ strategyData?.strategy.shortAdditions || 0 }}/20</b></div><div><span>下一档间距</span><b>{{ strategyData?.strategy.addStep == null ? '—' : `${Number(strategyData.strategy.addStep).toFixed(2)}` }}</b></div>
              <div><span>多头净盈亏</span><b>{{ strategyData?.strategy.long?.costs == null ? '—' : `${Number(strategyData.strategy.long.costs.netPnl).toFixed(2)} U` }}</b></div><div><span>空头净盈亏</span><b>{{ strategyData?.strategy.short?.costs == null ? '—' : `${Number(strategyData.strategy.short.costs.netPnl).toFixed(2)} U` }}</b></div>
            </div>
            <p v-if="strategyData?.strategy.weekendMode" class="market-meta">周末流动性模式：暂停新建底仓和止盈后的仓位重建；已有仓位继续补仓与止盈。</p>
            <p class="dialog-intro">服务器24小时识别震荡结构，建立双向底仓；补仓间距为 15 分钟 ATR 的 0.6 倍，并限制在现价的 0.08%～0.35%。多头、空头各自最多补仓 20 次。任一侧达到单边净利润目标后以 Maker 平仓，10 秒后按初始金额和杠杆建立同方向新底仓；另一侧状态保留。</p>
            <p v-if="strategyData?.strategy.long?.costs || strategyData?.strategy.short?.costs" class="market-meta">多头：{{ strategyData.strategy.long?.recovery ? `恢复中，目标 ${Number(strategyData.strategy.long.costs?.profitTarget || 0).toFixed(2)}U，ATR 回撤 ${Number(strategyData.strategy.long.recoveryTrail || 0).toFixed(2)}U` : `常规目标 ${Number(strategyData.strategy.long?.costs?.profitTarget || 0).toFixed(2)}U` }}。空头：{{ strategyData.strategy.short?.recovery ? `恢复中，目标 ${Number(strategyData.strategy.short.costs?.profitTarget || 0).toFixed(2)}U，ATR 回撤 ${Number(strategyData.strategy.short.recoveryTrail || 0).toFixed(2)}U` : `常规目标 ${Number(strategyData.strategy.short?.costs?.profitTarget || 0).toFixed(2)}U` }}。</p>
            <p v-if="strategyData?.strategy.range" class="market-meta">当前参考区间：{{ strategyData.strategy.range.low }} – {{ strategyData.strategy.range.high }} · 最新价 {{ strategyData.strategy.lastPrice ?? '—' }}</p>
            <p v-if="strategyData?.strategy.lastError || strategyError" class="order-error">{{ strategyError || strategyData?.strategy.lastError }}</p>
          </div>
          <footer class="dialog-footer"><p class="footer-hint">暂停策略会撤销已知挂单并保留已成交仓位；再次启动时按实际仓位恢复接管。</p><div class="footer-actions"><button class="btn" :disabled="strategyBusy" @click="closeStrategy">关闭</button><button class="btn primary" :disabled="strategyBusy" @click="toggleStrategy">{{ strategyBusy ? '处理中…' : strategyData?.strategy.enabled ? '暂停策略' : strategyData?.strategy.resumeEligible ? '恢复并接管仓位' : '启动24H策略' }}</button></div></footer>
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
.panel { background: var(--card); border: 1px solid var(--border); border-radius: 8px; min-width: 0; overflow: hidden; }
.panel-head { padding: 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; gap: 15px; }
.panel-title { font-size: 16px; font-weight: 600; }
.account-title-line { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.weekend-warning { display: inline-flex; align-items: center; gap: 5px; color: var(--yellow); font-size: 11px; font-weight: 600; line-height: 1.4; }
.weekend-warning b { width: 15px; height: 15px; display: inline-grid; place-items: center; border: 1px solid currentColor; border-radius: 50%; font-size: 10px; }
.panel-sub { font-size: 12px; color: var(--muted); margin-top: 4px; }
.panel-count { font-size: 12px; color: var(--muted); margin: 0; }
.history-tabs { display: inline-flex; align-items: center; gap: 4px; }
.history-tabs button {
  border: 0;
  border-radius: 5px;
  padding: 5px 9px;
  background: transparent;
  color: var(--muted);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.history-tabs button:hover { color: var(--text); background: var(--panel-2); }
.history-tabs button.active { color: var(--yellow); background: color-mix(in srgb, var(--yellow) 12%, transparent); }
.section-tag { color: var(--yellow); font-size: 10px; font-weight: 700; }
.main-grid { display: grid; grid-template-columns: minmax(420px, 460px) minmax(0, 1.65fr) minmax(320px, .9fr); gap: 16px; flex: 1; min-height: 0; }
.main-grid > .panel { display: flex; flex-direction: column; min-height: 0; }
.main-grid .panel-head, .main-grid .feed-tools, .main-grid .panel-foot { flex-shrink: 0; }
.history-panel { min-width: 0; }
.history-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.history-list::-webkit-scrollbar { width: 6px; }
.history-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
.record-table-head,
.record-row {
  display: grid;
  grid-template-columns: 88px 64px minmax(92px, 1fr) 70px 40px;
  column-gap: 4px;
  align-items: center;
  font-variant-numeric: tabular-nums;
}
.record-table-head {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 8px 10px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  color: var(--muted);
  font-size: 11px;
}
.record-table-head > span:not(:first-child) { text-align: right; }
.record-row {
  min-height: 48px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  transition: background-color .15s;
}
.record-row:hover { background: color-mix(in srgb, var(--panel-3) 78%, var(--panel-2)); }
.record-symbol {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  font-weight: 600;
  min-width: 0;
}
.tag {
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  margin-left: 6px;
}
.tag.long { background: color-mix(in srgb, var(--green) 10%, transparent); color: var(--green); }
.tag.short { background: color-mix(in srgb, var(--red) 10%, transparent); color: var(--red); }
.record-price,
.record-amount,
.record-pnl,
.record-time { text-align: right; min-width: 0; }
.record-price { color: var(--text); }
.record-amount { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.record-pnl { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; font-weight: 600; }
.record-pnl small { color: var(--muted); font-size: 10px; font-weight: 400; }
.record-time { color: var(--muted); font-size: 11px; }
.log-list { padding: 0 10px; gap: 0; }
.strategy-log-row { padding: 11px 4px; border-bottom: 1px solid var(--border); }
.strategy-log-row:last-child { border-bottom: 0; }
.log-top { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.log-level { border-radius: 3px; padding: 2px 5px; color: var(--muted); background: var(--panel-2); font-size: 10px; font-weight: 600; }
.level-trade .log-level, .level-success .log-level { color: var(--green); background: color-mix(in srgb, var(--green) 10%, transparent); }
.level-warn .log-level { color: var(--yellow); background: color-mix(in srgb, var(--yellow) 10%, transparent); }
.level-error .log-level { color: var(--red); background: color-mix(in srgb, var(--red) 10%, transparent); }
.log-top time { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.strategy-log-row p { margin: 7px 0 0; color: var(--text); font-size: 12px; line-height: 1.5; }
.pnl-positive { color: var(--green); }
.pnl-negative { color: var(--red); }
.pnl-zero { color: var(--muted); opacity: .6; }
.btn-close-all {
  background: transparent;
  color: var(--red);
  border: 1px solid var(--red);
  padding: 6px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  transition: background-color .2s;
}
.btn-close-all:hover:not(:disabled) { background: color-mix(in srgb, var(--red) 10%, transparent); }
.btn-close-all:disabled { opacity: .5; cursor: default; }
.account-panel :deep(.okx-panel) { flex: 1; height: auto; min-height: 0; background: transparent; }
.account-panel :deep(.account-note) { display: none; }
.account-panel :deep(.account-summary) {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  padding: 16px;
  border-bottom: 1px solid var(--border);
}
.account-panel :deep(.data-card) {
  background: var(--panel-2);
  padding: 16px;
  border-radius: 6px;
  border: 0;
}
.account-panel :deep(.data-card:hover) { border: 0; }
.account-panel :deep(.data-label) { font-size: 12px; margin-bottom: 8px; }
.account-panel :deep(.data-value) { font-size: 22px; font-weight: 700; margin-bottom: 0; }
.account-panel :deep(.data-sub) { margin-top: 6px; color: color-mix(in srgb, var(--muted) 70%, transparent); }
.account-panel :deep(.tradfi-order-list) { padding: 16px; gap: 16px; }
.strategy-state { display: flex; justify-content: space-between; gap: 12px; padding: 16px; border: 1px solid var(--border); border-radius: 10px; background: var(--panel-2); }
.strategy-state span { color: var(--muted); }
.startup-progress { margin-top: 14px; padding: 14px; border: 1px solid color-mix(in srgb, var(--yellow) 34%, var(--border)); border-radius: 9px; background: color-mix(in srgb, var(--yellow) 5%, var(--panel-2)); }
.startup-progress-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 9px; font-size: 12px; }
.startup-progress-head span { color: var(--yellow); font-variant-numeric: tabular-nums; }
.startup-progress-track { height: 6px; overflow: hidden; border-radius: 999px; background: var(--panel); }
.startup-progress-fill { height: 100%; border-radius: inherit; background: linear-gradient(90deg, #dba91f, var(--yellow)); transition: width .25s ease; }
.startup-current { margin-top: 9px; color: var(--muted); font-size: 11px; }
.startup-log-list { max-height: 150px; margin-top: 10px; overflow-y: auto; border-top: 1px solid var(--border); }
.startup-log-item { display: grid; grid-template-columns: 8px minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 7px 1px; color: var(--muted); font-size: 11px; border-bottom: 1px solid color-mix(in srgb, var(--border) 65%, transparent); }
.startup-log-item i { width: 6px; height: 6px; border-radius: 50%; background: var(--yellow); }
.startup-log-item.level-success i { background: var(--green); }
.startup-log-item.level-warn i, .startup-log-item.level-error i { background: var(--red); }
.startup-log-item time { color: var(--muted); font-variant-numeric: tabular-nums; }
.strategy-config { display: flex; align-items: end; gap: 12px; margin: 14px 0; padding: 12px; border: 1px solid var(--border); border-radius: 9px; background: var(--panel-2); }
.strategy-config label { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
.strategy-config input { width: 66px; padding: 6px 7px; color: var(--text); background: var(--panel); border: 1px solid var(--border); border-radius: 5px; }
.strategy-config input:disabled { opacity: .65; cursor: not-allowed; }
.strategy-config span { margin-left: auto; color: var(--muted); font-size: 11px; }
.strategy-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 14px 0; }
.strategy-metrics div { padding: 13px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-2); }
.strategy-metrics span { display: block; color: var(--muted); font-size: 11px; margin-bottom: 7px; }
.strategy-dialog { height: auto; min-height: 470px; }
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
.modal-cover { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box; background: rgba(0, 0, 0, .72); }
.dialog { width: min(800px, 100%); height: 680px; max-height: 96vh; display: flex; flex-direction: column; overflow: hidden; background: var(--card); border: 1px solid var(--border); border-radius: 14px; box-shadow: 0 24px 64px rgba(0, 0, 0, .5); }
.dialog-head { flex: none; min-height: 62px; box-sizing: border-box; padding: 14px 18px; border-bottom: 1px solid var(--border); background: linear-gradient(to right, rgba(99, 102, 241, .14), transparent); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dialog-title { color: var(--text); font-size: 16px; font-weight: 750; }
.dialog-symbol { color: var(--muted); }
.dialog-close { border: 0; background: transparent; color: var(--muted); font-size: 22px; cursor: pointer; }
.dialog-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.dialog-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 18px 20px; }
.dialog-intro { margin: 0 0 24px; color: var(--muted); line-height: 1.7; }
.market-meta { margin: 12px 0 16px; color: var(--muted); font-size: 12px; line-height: 1.6; }
.order-error { color: var(--red); font-size: 12px; line-height: 1.6; }
.dialog-footer { flex: none; padding: 12px 18px; border-top: 1px solid var(--border); background: var(--card); }
.footer-hint { margin: 0 0 10px; color: var(--muted); font-size: 11px; line-height: 1.5; }
.footer-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
.footer-actions .btn { min-height: 36px; font-size: 12px; }
.footer-actions .btn.primary { background: linear-gradient(135deg, #6366f1, #a855f7); color: #fff; border-color: transparent; }
.footer-actions .btn:disabled { opacity: .5; cursor: not-allowed; }
@media (max-width: 1180px) {
  .content { overflow-y: auto; }
  .main-grid { flex: none; grid-template-columns: minmax(400px, .85fr) minmax(0, 1.3fr); grid-template-rows: minmax(420px, 60vh) minmax(320px, 45vh); }
  .main-grid > .panel:last-child { grid-column: 1 / -1; }
}
@media (max-width: 760px) {
  .content { padding: 12px 0; }
  .main-grid { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(360px, 50vh) minmax(420px, 55vh) minmax(320px, 45vh); }
  .main-grid > .panel:last-child { grid-column: auto; }
  .account-panel :deep(.account-summary) { grid-template-columns: 1fr; }
  .account-panel :deep(.position-row) { grid-template-columns: 1fr; }
  .account-panel :deep(.position-side:first-child) { border-right: 0; border-bottom: 1px solid var(--border); }
  .news-item { grid-template-columns: 60px minmax(0, 1fr); }
  .news-mark { display: none; }
  .dialog-scroll { padding: 14px; }
  .strategy-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .footer-actions .btn { flex: 1; }
}
</style>
