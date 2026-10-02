<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import {
  fetchWhaleOpenOrders,
  fetchWhaleEquityHistory,
  fetchWhalePerpMarkPrices,
  fetchWhaleTrades,
  fetchWhaleTransfers,
  type WhaleOpenOrder,
  type WhaleEquityHistoryPoint,
  type WhaleEquityHistoryRange,
  type WhaleTransfer,
} from '@/api';
import type { PagedTradesResponse, WhaleProfile, WhaleTrade } from '@/types';
import { formatRelativeAgo, formatTimeShort, formatUsd } from '@/utils/format';

const props = defineProps<{ modelValue: boolean; whale: WhaleProfile | null; snapshotUpdatedAt?: number }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const activeTab = ref('contracts');
const tradePage = ref(1);
const tradeLimit = 30;
const tradesResult = ref<PagedTradesResponse | null>(null);
const tradesLoading = ref(false);
const transfers = ref<WhaleTransfer[]>([]);
const transfersLoading = ref(false);
const transfersLoadedFor = ref('');
const tradeError = ref('');
const transferError = ref('');
const perpMarkPrices = ref<Record<string, number | null>>({});
const pricesLoadedFor = ref('');
const pricesLoading = ref(false);
const openOrders = ref<WhaleOpenOrder[]>([]);
const ordersLoading = ref(false);
const ordersError = ref('');
const ordersLoadedFor = ref('');
const equityRange = ref<WhaleEquityHistoryRange>('30d');
const equityPoints = ref<WhaleEquityHistoryPoint[]>([]);
const equityLoading = ref(false);
const equityError = ref('');
let equityRequestSeq = 0;
let tradeRequestSeq = 0;
let transferRequestSeq = 0;
let orderRequestSeq = 0;
let priceRequestSeq = 0;

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
});

const positions = computed(() => props.whale?.positions || []);
const accountLongUsd = computed(() => Number(props.whale?.longUsd) || 0);
const accountShortUsd = computed(() => Number(props.whale?.shortUsd) || 0);
const grossPositionUsd = computed(() => accountLongUsd.value + accountShortUsd.value);
const longPct = computed(() => grossPositionUsd.value > 0 ? accountLongUsd.value / grossPositionUsd.value * 100 : null);
const shortPct = computed(() => longPct.value == null ? null : 100 - longPct.value);
const longBarPct = computed(() => grossPositionUsd.value > 0 ? accountLongUsd.value / grossPositionUsd.value * 100 : 0);
const shortBarPct = computed(() => grossPositionUsd.value > 0 ? accountShortUsd.value / grossPositionUsd.value * 100 : 0);
const netPositionBias = computed(() => accountLongUsd.value - accountShortUsd.value);
const totalUnrealizedPnl = computed(() => positions.value.length
  ? positions.value.reduce((sum, pos) => sum + (Number(pos.unrealizedPnl) || 0), 0)
  : null);
const netBiasLabel = computed(() => {
  if (longPct.value == null) return '数据不足';
  if (longPct.value >= 65) return '偏多';
  if (longPct.value <= 35) return '偏空';
  return '多空均衡';
});
const addressShort = computed(() => {
  const address = props.whale?.address || '';
  return address.length > 18 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address || '地址缺失';
});
const equityChart = computed(() => {
  const points = equityPoints.value;
  if (!points.length) return { line: '', area: '', plotted: [], yLabels: [], xLabels: [] as string[] };
  const rangeMs: Record<Exclude<WhaleEquityHistoryRange, 'all'>, number> = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  };
  const rangeStart = equityRange.value === 'all' ? points[0].time : Date.now() - rangeMs[equityRange.value];
  const visible = points.filter((point) => point.time >= rangeStart);
  const plottedPoints = visible.length ? visible : points.slice(-1);
  const start = plottedPoints[0].time;
  const end = plottedPoints[plottedPoints.length - 1].time;
  const { min, max } = points.reduce((range, point) => ({
    min: Math.min(range.min, point.contractEquity),
    max: Math.max(range.max, point.contractEquity),
  }), { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY });
  const spread = max - min || Math.max(Math.abs(max) * 0.01, 1);
  const plotted = plottedPoints.map((point, index) => ({
    ...point,
    x: 90 + (plottedPoints.length === 1 ? 450 : (point.time - start) / Math.max(end - start, 1) * 880),
    y: 24 + (1 - (point.contractEquity - min) / spread) * 218,
    key: `${point.time}-${index}`,
  }));
  const line = plotted.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const area = plotted.length > 1 ? `${line} L${plotted[plotted.length - 1].x.toFixed(1)},264 L${plotted[0].x.toFixed(1)},264 Z` : '';
  const moneyAxis = [max, (max + min) / 2, min].map((value) => formatMoney(value));
  const dateAxis = plotted.length > 1
    ? [formatChartDate(plotted[0].time), formatChartDate(plotted[Math.floor((plotted.length - 1) / 2)].time), formatChartDate(plotted[plotted.length - 1].time)]
    : [formatChartDate(plotted[0].time)];
  return { line, area, plotted, yLabels: moneyAxis, xLabels: dateAxis };
});
const equityDataRows = computed(() => {
  const points = equityPoints.value;
  if (points.length <= 5) return points;
  const indexes = Array.from({ length: 5 }, (_, index) => Math.round(index * (points.length - 1) / 4));
  return [...new Set(indexes)].map((index) => points[index]);
});
function formatMoney(value: unknown) {
  if (value == null || value === '') return '—';
  const amount = Number(value);
  return Number.isFinite(amount) ? formatUsd(amount) : '—';
}

function formatChartDate(value: number) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit',
    ...(equityRange.value === '24h' ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(date);
}

function formatChartTooltip(point: WhaleEquityHistoryPoint) {
  const date = new Date(point.time);
  return `${new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)} · ${formatMoney(point.contractEquity)}`;
}

function formatPrice(value: unknown) {
  if (value == null || value === '') return '—';
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount === 0) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: amount < 1 ? 6 : 2 }).format(amount);
}

function formatQty(value: unknown) {
  if (value == null || value === '') return '—';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(amount);
}

function formatLeverage(value: unknown) {
  if (value == null || value === '') return '—';
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? `${amount}x` : '—';
}

function formatPercent(value: unknown, allowFraction = false) {
  if (value == null || value === '') return '—';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return `${(allowFraction && amount <= 1 ? amount * 100 : amount).toFixed(1)}%`;
}

function sideLabel(side: string) {
  return side === 'long' ? '多头' : side === 'short' ? '空头' : '—';
}

function signedClass(value: unknown) {
  const amount = Number(value);
  return amount > 0 ? 'positive' : amount < 0 ? 'negative' : '';
}

function positionRoe(position: { unrealizedPnl?: number | null; marginUsed?: number | null }) {
  const margin = Number(position.marginUsed);
  const pnl = Number(position.unrealizedPnl);
  return Number.isFinite(margin) && margin > 0 && Number.isFinite(pnl) ? `${(pnl / margin * 100).toFixed(2)}%` : '—';
}

function liquidationDistance(position: { side?: string; coin?: string; liquidationPx?: string | number | null }) {
  const mark = Number(perpMarkPrices.value[String(position.coin || '')]);
  const liquidation = Number(position.liquidationPx);
  if (!Number.isFinite(mark) || mark <= 0 || !Number.isFinite(liquidation) || liquidation <= 0) return '—';
  const pct = position.side === 'short' ? (liquidation - mark) / mark * 100 : (mark - liquidation) / mark * 100;
  return `${Math.max(0, pct).toFixed(2)}%`;
}

function holdDuration(position: { firstOpenTime?: number | null; openTime?: number | null; openHistoryComplete?: boolean }) {
  if (position.openHistoryComplete === false) return '历史不完整';
  const startedAt = Number(position.firstOpenTime || position.openTime);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return '—';
  const minutes = Math.max(0, Math.floor((Date.now() - startedAt) / 60_000));
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}小时`;
  return `${Math.floor(hours / 24)}天`;
}

async function loadTrades() {
  if (!props.whale?.id) return;
  const requestSeq = ++tradeRequestSeq;
  const whaleId = props.whale.id;
  const page = tradePage.value;
  tradesLoading.value = true;
  tradeError.value = '';
  try {
    const result = await fetchWhaleTrades(whaleId, { page, limit: tradeLimit });
    if (requestSeq === tradeRequestSeq) tradesResult.value = result;
  } catch (error) {
    if (requestSeq === tradeRequestSeq) tradeError.value = error instanceof Error ? error.message : '成交记录加载失败';
  } finally {
    if (requestSeq === tradeRequestSeq) tradesLoading.value = false;
  }
}

async function loadTransfers() {
  if (!props.whale?.id || transfersLoadedFor.value === props.whale.id || transfersLoading.value) return;
  const requestSeq = ++transferRequestSeq;
  const whaleId = props.whale.id;
  transfersLoading.value = true;
  transferError.value = '';
  try {
    const result = await fetchWhaleTransfers(whaleId, { days: 30, limit: 100 });
    if (requestSeq !== transferRequestSeq) return;
    transfers.value = result.transfers || [];
    transfersLoadedFor.value = whaleId;
  } catch (error) {
    if (requestSeq === transferRequestSeq) transferError.value = error instanceof Error ? error.message : '资金记录加载失败';
  } finally {
    if (requestSeq === transferRequestSeq) transfersLoading.value = false;
  }
}

async function loadPerpMarkPrices() {
  if (!props.whale?.id || pricesLoadedFor.value === props.whale.id || pricesLoading.value) return;
  const requestSeq = ++priceRequestSeq;
  const whaleId = props.whale.id;
  pricesLoading.value = true;
  try {
    const result = await fetchWhalePerpMarkPrices(whaleId);
    if (requestSeq !== priceRequestSeq) return;
    perpMarkPrices.value = result.perpMarkPrices || {};
    pricesLoadedFor.value = whaleId;
  } catch {
    // Keep market prices unavailable if the upstream price request fails.
  } finally {
    if (requestSeq === priceRequestSeq) pricesLoading.value = false;
  }
}

async function loadEquityHistory() {
  if (!props.whale?.id || !props.modelValue) return;
  const requestSeq = ++equityRequestSeq;
  const whaleId = props.whale.id;
  const range = equityRange.value;
  equityLoading.value = true;
  equityError.value = '';
  try {
    const result = await fetchWhaleEquityHistory(whaleId, range);
    if (requestSeq !== equityRequestSeq) return;
    equityPoints.value = result.points || [];
  } catch (error) {
    if (requestSeq !== equityRequestSeq) return;
    equityError.value = error instanceof Error ? error.message : '合约权益历史读取失败';
    equityPoints.value = [];
  } finally {
    if (requestSeq === equityRequestSeq) equityLoading.value = false;
  }
}

function setEquityRange(range: WhaleEquityHistoryRange) {
  equityRange.value = range;
}

async function loadOrders() {
  if (!props.whale?.id || ordersLoadedFor.value === props.whale.id || ordersLoading.value) return;
  const requestSeq = ++orderRequestSeq;
  const whaleId = props.whale.id;
  ordersLoading.value = true;
  ordersError.value = '';
  try {
    const result = await fetchWhaleOpenOrders(whaleId);
    if (requestSeq !== orderRequestSeq) return;
    openOrders.value = result.orders || [];
    ordersLoadedFor.value = whaleId;
  } catch (error) {
    if (requestSeq === orderRequestSeq) ordersError.value = error instanceof Error ? error.message : '未完成订单加载失败';
  } finally {
    if (requestSeq === orderRequestSeq) ordersLoading.value = false;
  }
}

function setTab(tab: string) {
  activeTab.value = tab;
  if (tab === 'transfers') void loadTransfers();
  if (tab === 'trades' && !tradesResult.value) void loadTrades();
  if (tab === 'orders') void loadOrders();
}

function changeTradePage(page: number) {
  tradePage.value = page;
  void loadTrades();
}

watch(() => [props.modelValue, props.whale?.id] as const, ([isOpen, id], previous) => {
  if (!isOpen || !id) return;
  const changedWhale = previous?.[1] !== id;
  if (changedWhale) {
    tradeRequestSeq += 1;
    transferRequestSeq += 1;
    orderRequestSeq += 1;
    priceRequestSeq += 1;
    activeTab.value = 'contracts';
    tradePage.value = 1;
    tradesResult.value = null;
    tradesLoading.value = false;
    transfers.value = [];
    transfersLoadedFor.value = '';
    transferError.value = '';
    transfersLoading.value = false;
    perpMarkPrices.value = {};
    pricesLoadedFor.value = '';
    pricesLoading.value = false;
    openOrders.value = [];
    ordersLoadedFor.value = '';
    ordersError.value = '';
    ordersLoading.value = false;
  }
  void loadPerpMarkPrices();
}, { immediate: true });

watch(() => [props.modelValue, props.whale?.id, equityRange.value] as const, ([isOpen, id]) => {
  if (isOpen && id) void loadEquityHistory();
}, { immediate: true });

async function copyAddress() {
  const address = props.whale?.address || '';
  if (!address) return;
  try {
    await navigator.clipboard.writeText(address);
    ElMessage.success('地址已复制');
  } catch {
    ElMessage.warning('复制失败，请手动复制地址');
  }
}
</script>

<template>
  <el-dialog v-model="visible" class="whale-detail-dialog" fullscreen destroy-on-close>
    <template #header>
      <div class="dialog-header" v-if="whale">
        <div class="identity">
          <div class="name-line">
            <strong>{{ whale.customName ? whale.name : (whale.name || addressShort) }}</strong>
            <el-tag size="small" type="warning" effect="dark">巨鲸</el-tag>
            <span v-if="whale.style" class="subtle">{{ whale.style === 'hf' ? '高频' : '稳健' }}</span>
          </div>
          <button class="address-button" type="button" @click="copyAddress">{{ addressShort }} <span>复制</span></button>
        </div>
        <div class="updated">列表快照 {{ snapshotUpdatedAt ? formatRelativeAgo(snapshotUpdatedAt) : '时间未知' }}{{ whale.error ? ' · 部分数据异常' : '' }}</div>
      </div>
    </template>

    <template v-if="whale">
      <section class="metrics-grid">
        <div class="left-metrics">
          <article class="asset-card">
            <div class="card-title">合约账户权益 <span class="source-tag">合约快照</span></div>
            <div class="asset-total">{{ whale.contractAccountValue == null ? '—' : formatMoney(whale.contractAccountValue) }}</div>
            <div class="account-switch"><span class="selected">合约仓位 {{ formatMoney(grossPositionUsd) }}</span></div>
          </article>
          <article class="sentiment-card">
            <div class="sentiment-box">
              <div class="sentiment-text">
                <div class="sentiment-value" :class="longPct == null ? '' : longPct >= 50 ? 'positive' : 'negative'">{{ netBiasLabel }}</div>
                <div class="sentiment-caption">多空仓位价值偏差</div>
              </div>
              <div class="bias-net" :class="signedClass(netPositionBias)">
                <small>净偏差</small>
                <b>{{ grossPositionUsd > 0 ? formatMoney(Math.abs(netPositionBias)) : '—' }}</b>
                <small>{{ netPositionBias > 0 ? '多头占优' : netPositionBias < 0 ? '空头占优' : grossPositionUsd > 0 ? '多空相等' : '暂无仓位' }}</small>
              </div>
            </div>
            <div class="bias-bar" role="img" :aria-label="`多头 ${formatMoney(accountLongUsd)}，空头 ${formatMoney(accountShortUsd)}`">
              <span class="bias-bar-long" :style="{ width: `${longBarPct}%` }" />
              <span class="bias-bar-short" :style="{ width: `${shortBarPct}%` }" />
            </div>
            <div class="bias-detail">
              <span class="positive"><b>多头</b><strong>{{ formatMoney(accountLongUsd) }}</strong><small>{{ longPct == null ? '—' : `${longPct.toFixed(1)}%` }}</small></span>
              <span class="negative"><b>空头</b><strong>{{ formatMoney(accountShortUsd) }}</strong><small>{{ shortPct == null ? '—' : `${shortPct.toFixed(1)}%` }}</small></span>
            </div>
          </article>
          <div class="stats-row">
            <article class="stat-card">
              <span class="stat-label">盈亏（近月）</span>
              <strong :class="signedClass(whale.monthPnl)">{{ whale.monthPnl == null ? '—' : formatMoney(whale.monthPnl) }}</strong>
              <small>累计 {{ whale.allTimePnl == null ? '—' : formatMoney(whale.allTimePnl) }}</small>
            </article>
            <article class="stat-card">
              <span class="stat-label">交易量（近月）</span>
              <strong>{{ whale.monthVlm == null ? '—' : formatMoney(whale.monthVlm) }}</strong>
              <small>无榜单值时不估算</small>
            </article>
          </div>
          <p class="data-note">盈亏和交易量来自巨鲸榜单快照；合约账户权益来自最近一次成功的合约账户快照。</p>
        </div>

        <article class="chart-card">
          <div class="chart-header">
            <div class="chart-title-area"><span>合约账户权益历史 · 官方数据</span><strong>{{ equityPoints.length ? formatMoney(equityPoints[equityPoints.length - 1].contractEquity) : '暂无官方历史值' }}</strong></div>
            <div class="time-filters">
              <button v-for="item in [{ id: '24h', label: '24小时' }, { id: '7d', label: '7天' }, { id: '30d', label: '30天' }, { id: 'all', label: '全部' }]" :key="item.id" type="button" :class="{ selected: equityRange === item.id }" @click="setEquityRange(item.id as WhaleEquityHistoryRange)">{{ item.label }}</button>
            </div>
          </div>
          <div class="chart-container">
            <svg v-if="equityChart.line" class="equity-chart" viewBox="0 0 1000 300" preserveAspectRatio="none" aria-label="合约账户权益历史曲线">
              <defs><linearGradient id="equityArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2962ff" stop-opacity=".32" /><stop offset="100%" stop-color="#2962ff" stop-opacity="0" /></linearGradient></defs>
              <g v-for="(label, index) in equityChart.yLabels" :key="`y-${index}`"><text x="4" :y="[29, 138, 247][index]" class="chart-axis-label">{{ label }}</text><line x1="86" x2="990" :y1="[24, 133, 242][index]" :y2="[24, 133, 242][index]" class="chart-axis-grid" /></g>
              <path v-if="equityChart.area" :d="equityChart.area" fill="url(#equityArea)" />
              <path :d="equityChart.line" fill="none" stroke="#4b83ff" stroke-width="2.5" vector-effect="non-scaling-stroke" />
              <circle v-for="point in equityChart.plotted" :key="point.key" :cx="point.x" :cy="point.y" r="3.5" class="equity-point"><title>{{ formatChartTooltip(point) }}</title></circle>
              <g v-for="(label, index) in equityChart.xLabels" :key="`x-${index}`"><text :x="[90, 530, 970][index]" y="292" :text-anchor="['start', 'middle', 'end'][index]" class="chart-axis-label">{{ label }}</text></g>
            </svg>
            <div v-if="equityLoading" class="chart-empty"><b>正在读取权益历史…</b></div>
            <div v-else-if="equityError" class="chart-empty"><b>权益历史暂不可用</b><span>{{ equityError }}</span></div>
            <div v-else-if="equityPoints.length < 2" class="chart-empty"><b>{{ equityPoints.length ? '历史点不足以绘制曲线' : '官方暂无历史权益数据' }}</b><span>{{ equityPoints.length ? 'Hyperliquid 当前仅返回一个合约权益历史点' : '请确认钱包地址及 Hyperliquid 是否提供该账户的历史记录' }}</span></div>
          </div>
          <div v-if="equityPoints.length" class="equity-data-list" aria-label="权益历史采样数据">
            <div v-for="(point, index) in equityDataRows" :key="`${point.time}-${index}`"><span>{{ formatChartDate(point.time) }}</span><strong>{{ formatMoney(point.contractEquity) }}</strong></div>
          </div>
          <div class="chart-foot"><span>Hyperliquid 官方 portfolio / perp 历史</span><span>当前浮动盈亏 {{ totalUnrealizedPnl == null ? '—' : formatMoney(totalUnrealizedPnl) }}</span></div>
        </article>
      </section>

      <nav class="detail-tabs" aria-label="巨鲸详情分类">
        <button v-for="tab in [{ id: 'contracts', label: `合约 (${positions.length})` }, { id: 'results', label: `结果 (${whale.closedTrades ?? '—'})` }, { id: 'closed', label: '已关闭交易' }, { id: 'orders', label: `未完成订单 (${ordersLoadedFor === whale.id ? openOrders.length : '—'})` }, { id: 'trades', label: '成交记录' }, { id: 'transfers', label: '资金记录' }]" :key="tab.id" :class="{ active: activeTab === tab.id }" @click="setTab(tab.id)">{{ tab.label }}</button>
      </nav>

      <section v-if="activeTab === 'contracts'" class="tab-panel">
        <div class="table-summary">
          <span><small>多头价值</small><b class="positive">{{ formatMoney(accountLongUsd) }}</b></span>
          <span><small>空头价值</small><b class="negative">{{ formatMoney(accountShortUsd) }}</b></span>
          <span><small>仓位合计</small><b>{{ formatMoney(grossPositionUsd) }}</b></span>
          <span><small>总资金费</small><b class="missing-field">接口未接入</b></span>
          <span><small>总浮动盈亏</small><b :class="signedClass(totalUnrealizedPnl)">{{ totalUnrealizedPnl == null ? '—' : formatMoney(totalUnrealizedPnl) }}</b></span>
        </div>
        <div v-if="positions.length" class="table-scroll">
          <table>
            <thead><tr><th>币种</th><th>数量</th><th>价值</th><th>均价 / 标记价</th><th>盈亏 / ROE</th><th>资金费率</th><th>清算距离</th><th>杠杆</th><th>方向 / 时长</th></tr></thead>
            <tbody>
              <tr v-for="pos in positions" :key="`${pos.coin}-${pos.side}`">
                <td><div class="coin-cell"><b>{{ pos.coinLabel || pos.coin }}</b><small :class="pos.side === 'long' ? 'positive' : 'negative'">{{ sideLabel(pos.side) }}</small></div></td>
                <td>{{ formatQty(pos.size) }}</td>
                <td>{{ formatMoney(pos.positionValue) }}</td>
                <td>{{ formatPrice(pos.entryPx) }}<small class="sub-row">标记价 {{ pricesLoading && perpMarkPrices[pos.coin] == null ? '读取中…' : formatPrice(perpMarkPrices[pos.coin]) }}</small></td>
                <td :class="signedClass(pos.unrealizedPnl)">{{ formatMoney(pos.unrealizedPnl) }}<small class="sub-row">ROE {{ positionRoe(pos) }}</small></td>
                <td class="missing-field">—</td>
                <td>{{ formatPrice(pos.liquidationPx) }}<small class="sub-row">距离 {{ liquidationDistance(pos) }}</small></td>
                <td>{{ formatLeverage(pos.leverage) }}</td>
                <td><span :class="pos.side === 'long' ? 'positive' : 'negative'">{{ sideLabel(pos.side) }}</span><small class="sub-row">{{ holdDuration(pos) }}</small></td>
              </tr>
            </tbody>
          </table>
        </div>
        <el-empty v-else description="当前快照没有可展示的合约仓位" :image-size="64" />
        <p class="footnote">仓位来自当前缓存快照。当前可计算数量、名义价值、均价、未实现盈亏、杠杆、爆仓价与有完整建仓记录的持仓时长；标记价、资金费、清算距离依赖数据源补充，ROE 仅在有保证金数据时计算。</p>
      </section>

      <section v-else-if="activeTab === 'trades'" class="tab-panel">
        <div class="panel-heading"><strong>成交记录</strong><span>本地已采集数据 · {{ tradesResult?.total ?? '—' }} 条</span></div>
        <div v-if="tradesLoading" class="loading-state">正在读取成交记录…</div>
        <el-alert v-else-if="tradeError" :title="tradeError" type="warning" :closable="false" />
        <div v-else-if="tradesResult?.trades.length" class="table-scroll">
          <table>
            <thead><tr><th>时间</th><th>币种</th><th>方向</th><th>成交价</th><th>数量</th><th>名义金额</th><th>已实现盈亏</th></tr></thead>
            <tbody>
              <tr v-for="trade in tradesResult.trades as WhaleTrade[]" :key="trade.id">
                <td>{{ formatTimeShort(trade.time) }}</td><td>{{ trade.assetLabel || trade.asset }}</td>
                <td :class="/long|buy|open long/i.test(`${trade.side} ${trade.dir}`) ? 'positive' : 'negative'">{{ trade.dir || trade.side || '—' }}</td>
                <td>{{ formatPrice(trade.price) }}</td><td>{{ formatQty(trade.amount) }}</td>
                <td>{{ formatMoney(trade.amountUsd) }}</td><td :class="signedClass(trade.closedPnl)">{{ formatMoney(trade.closedPnl) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <el-empty v-else-if="!tradesLoading" description="当前保留范围内没有成交记录" :image-size="64" />
        <div v-if="(tradesResult?.total || 0) > tradeLimit" class="pager">
          <el-pagination small layout="prev, pager, next" :current-page="tradePage" :page-size="tradeLimit" :total="tradesResult?.total || 0" @current-change="changeTradePage" />
        </div>
        <p class="footnote">成交历史读取本地缓存与数据库，不会因打开弹窗而无限回溯链上数据。</p>
      </section>

      <section v-else-if="activeTab === 'transfers'" class="tab-panel">
        <div class="panel-heading"><strong>资金记录</strong><span>最近30天 · 最多100条</span></div>
        <div v-if="transfersLoading" class="loading-state">正在读取资金记录…</div>
        <el-alert v-else-if="transferError" :title="transferError" type="warning" :closable="false" />
        <div v-else-if="transfers.length" class="table-scroll">
          <table>
            <thead><tr><th>时间</th><th>类型</th><th>资产</th><th>金额</th><th>方向</th><th>对手地址</th></tr></thead>
            <tbody><tr v-for="item in transfers" :key="item.id"><td>{{ formatTimeShort(item.time) }}</td><td>{{ item.typeLabel || item.type }}</td><td>{{ item.asset }}</td><td>{{ formatMoney(item.amountUsd) }}</td><td :class="item.direction === 'in' ? 'positive' : item.direction === 'out' ? 'negative' : ''">{{ item.direction === 'in' ? '转入' : item.direction === 'out' ? '转出' : '内部' }}</td><td class="mono">{{ item.peer || '—' }}</td></tr></tbody>
          </table>
        </div>
        <el-empty v-else-if="!transfersLoading" description="最近30天没有可展示的资金记录" :image-size="64" />
        <p class="footnote">资金记录由 Hyperliquid 账本接口按需查询；不包含资金费记录。</p>
      </section>

      <section v-else-if="activeTab === 'results'" class="tab-panel">
        <div class="results-grid">
          <article><small>已完成交易数</small><b>{{ whale.closedTrades == null || whale.closedTrades === 0 ? '—' : whale.closedTrades }}</b></article>
          <article><small>历史胜率</small><b>{{ !whale.closedTrades ? '—' : formatPercent(whale.winRate, true) }}</b></article>
          <article><small>近月盈亏</small><b :class="signedClass(whale.monthPnl)">{{ whale.monthPnl == null ? '—' : formatMoney(whale.monthPnl) }}</b></article>
          <article><small>历史最大回撤</small><b>{{ !whale.closedTrades ? '—' : formatPercent(whale.maxDrawdown) }}</b></article>
        </div>
        <p class="footnote">这些是巨鲸榜单统计值，统计周期与口径由上游决定；不是本地重算的完整交易绩效。</p>
      </section>

      <section v-else-if="activeTab === 'orders'" class="tab-panel">
        <div class="panel-heading"><strong>未完成订单（含条件单）</strong><span>Hyperliquid 实时查询 · 上游短缓存</span></div>
        <div v-if="ordersLoading" class="loading-state">正在读取未完成订单…</div>
        <el-alert v-else-if="ordersError" :title="ordersError" type="warning" :closable="false" />
        <div v-else-if="openOrders.length" class="table-scroll">
          <table>
            <thead><tr><th>币种</th><th>方向</th><th>订单类型</th><th>价格 / 触发价</th><th>数量</th><th>名义金额</th><th>标记</th></tr></thead>
            <tbody><tr v-for="order in openOrders" :key="order.id"><td>{{ order.coinLabel }}</td><td :class="order.side === '买入' ? 'positive' : 'negative'">{{ order.side }}</td><td>{{ order.orderType }}</td><td>{{ formatPrice(order.price) }}</td><td>{{ formatQty(order.size) }}</td><td>{{ order.notionalUsd == null ? '—' : formatMoney(order.notionalUsd) }}</td><td>{{ order.reduceOnly ? '只减仓' : order.triggerCondition || '—' }}</td></tr></tbody>
          </table>
        </div>
        <el-empty v-else-if="!ordersLoading" description="当前没有未完成订单" :image-size="64" />
        <p class="footnote">订单来自 frontendOpenOrders 接口，包含可能存在的止损/止盈条件单；此页面不会执行任何订单操作。</p>
      </section>

      <section v-else class="tab-panel unavailable-panel">
        <strong>已关闭交易明细</strong>
        <p>当前成交历史尚未按仓位周期完整归并。榜单提供已完成交易数、胜率和回撤汇总，但无法保证逐笔平仓明细完整，因此这里不把减仓成交冒充完整交易。</p>
      </section>
    </template>
  </el-dialog>
</template>

<style>
.whale-detail-dialog.el-dialog { --detail-bg: #0b0e14; --detail-card: #151a24; --detail-border: #232937; --detail-muted: #848e9c; width: 100vw !important; height: 100vh; max-height: 100vh; margin: 0 !important; background: var(--detail-bg); color: #e2e8f0; border: 0; border-radius: 0; display: flex; flex-direction: column; }
.whale-detail-dialog .el-dialog__header { flex: none; margin: 0; padding: 20px 24px 14px; border-bottom: 1px solid var(--detail-border); }
.whale-detail-dialog .el-dialog__body { flex: 1; min-height: 0; padding: 20px 24px 26px; overflow: auto; color: inherit; }
.whale-detail-dialog .el-dialog__headerbtn .el-dialog__close { color: #c5cfdb; }
.whale-detail-dialog .dialog-header, .whale-detail-dialog .name-line { display: flex; align-items: center; }
.whale-detail-dialog .dialog-header { justify-content: space-between; gap: 20px; }
.whale-detail-dialog .identity { display: grid; gap: 8px; }
.whale-detail-dialog .name-line { gap: 10px; font-size: 20px; }
.whale-detail-dialog .address-button { width: fit-content; border: 0; padding: 0; color: var(--detail-muted); background: transparent; font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; cursor: pointer; }
.whale-detail-dialog .address-button span { margin-left: 8px; color: #58a6ff; }
.whale-detail-dialog .updated, .whale-detail-dialog .subtle, .whale-detail-dialog .footnote { color: var(--detail-muted); font-size: 12px; }
.whale-detail-dialog .overview-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.whale-detail-dialog .metric-card { display: flex; flex-direction: column; gap: 8px; min-width: 0; padding: 17px; border: 1px solid var(--detail-border); border-radius: 12px; background: var(--detail-card); }
.whale-detail-dialog .metric-label, .whale-detail-dialog .metric-card small { color: var(--detail-muted); font-size: 12px; }
.whale-detail-dialog .metric-card strong { overflow: hidden; text-overflow: ellipsis; font: 700 21px ui-monospace, SFMono-Regular, Consolas, monospace; }
.whale-detail-dialog .metric-card small { line-height: 1.4; }
.whale-detail-dialog .positive { color: #0ecb81 !important; }
.whale-detail-dialog .negative { color: #f6465d !important; }
.whale-detail-dialog .direction-strip { display: flex; align-items: center; gap: 14px; margin: 14px 0; padding: 14px 16px; border: 1px solid var(--detail-border); border-radius: 10px; background: var(--detail-card); font-size: 13px; }
.whale-detail-dialog .direction-title { color: #dce5ef; font-weight: 600; }
.whale-detail-dialog .direction-bar { flex: 1; height: 8px; overflow: hidden; border-radius: 99px; background: #f6465d; }
.whale-detail-dialog .direction-bar i { display: block; height: 100%; border-radius: inherit; background: #0ecb81; }
.whale-detail-dialog .direction-note { margin-left: auto; }
.whale-detail-dialog .chart-placeholder { min-height: 155px; padding: 18px; border: 1px solid var(--detail-border); border-radius: 12px; background: linear-gradient(180deg, #142238 0%, var(--detail-card) 100%); }
.whale-detail-dialog .chart-placeholder > div { display: flex; justify-content: space-between; color: var(--detail-muted); font-size: 12px; }
.whale-detail-dialog .chart-placeholder strong { color: #e6edf5; font-size: 14px; }
.whale-detail-dialog .chart-placeholder p { display: grid; place-items: center; min-height: 90px; margin: 0; color: var(--detail-muted); font-size: 13px; text-align: center; }
.whale-detail-dialog .detail-tabs { display: flex; gap: 6px; margin-top: 20px; border-bottom: 1px solid var(--detail-border); overflow-x: auto; }
.whale-detail-dialog .detail-tabs button { flex: none; padding: 11px 15px; border: 0; border-radius: 8px 8px 0 0; color: var(--detail-muted); background: transparent; cursor: pointer; }
.whale-detail-dialog .detail-tabs button.active { color: #e6edf5; background: var(--detail-card); font-weight: 600; }
.whale-detail-dialog .tab-panel { min-height: 240px; padding-top: 16px; }
.whale-detail-dialog .table-summary { display: flex; flex-wrap: wrap; gap: 28px; padding: 14px 16px; border: 1px solid var(--detail-border); border-bottom: 0; border-radius: 10px 10px 0 0; background: var(--detail-card); }
.whale-detail-dialog .table-summary span { display: grid; gap: 5px; }
.whale-detail-dialog .table-summary small, .whale-detail-dialog .panel-heading span { color: var(--detail-muted); font-size: 11px; }
.whale-detail-dialog .table-summary b { font: 600 13px ui-monospace, SFMono-Regular, Consolas, monospace; }
.whale-detail-dialog .table-scroll { overflow: auto; border: 1px solid var(--detail-border); border-radius: 0 0 10px 10px; }
.whale-detail-dialog .table-scroll table { width: 100%; border-collapse: collapse; white-space: nowrap; }
.whale-detail-dialog .table-scroll th, .whale-detail-dialog .table-scroll td { padding: 12px 14px; border-bottom: 1px solid #222b38; text-align: right; font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; }
.whale-detail-dialog .table-scroll th { position: sticky; top: 0; color: var(--detail-muted); background: #131a24; font: 500 11px system-ui, sans-serif; }
.whale-detail-dialog .table-scroll th:first-child, .whale-detail-dialog .table-scroll td:first-child { text-align: left; }
.whale-detail-dialog .table-scroll tr:last-child td { border-bottom: 0; }
.whale-detail-dialog .table-scroll tbody tr:hover { background: #1b2533; }
.whale-detail-dialog .footnote { margin: 12px 0 0; line-height: 1.6; }
.whale-detail-dialog .panel-heading { display: flex; justify-content: space-between; margin: 0 0 12px; }
.whale-detail-dialog .loading-state { display: grid; min-height: 160px; place-items: center; color: var(--detail-muted); }
.whale-detail-dialog .pager { display: flex; justify-content: flex-end; padding-top: 14px; }
.whale-detail-dialog .unavailable-panel { display: grid; align-content: center; justify-items: center; gap: 10px; color: var(--detail-muted); text-align: center; }
.whale-detail-dialog .unavailable-panel strong { color: #e6edf5; }
.whale-detail-dialog .unavailable-panel p { max-width: 540px; font-size: 13px; line-height: 1.7; }
.whale-detail-dialog .metrics-grid { display: grid; grid-template-columns: 340px minmax(0, 1fr); gap: 20px; }
.whale-detail-dialog .left-metrics { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.whale-detail-dialog .asset-card, .whale-detail-dialog .sentiment-card, .whale-detail-dialog .chart-card { border: 1px solid var(--detail-border); border-radius: 14px; background: var(--detail-card); }
.whale-detail-dialog .asset-card { display: flex; flex-direction: column; gap: 14px; padding: 19px; }
.whale-detail-dialog .card-title { display: flex; justify-content: space-between; align-items: center; color: var(--detail-muted); font-size: 13px; }
.whale-detail-dialog .source-tag { padding: 3px 7px; border-radius: 5px; background: #202a38; font-size: 10px; }
.whale-detail-dialog .asset-total { overflow: hidden; color: #e2e8f0; font: 700 26px ui-monospace, SFMono-Regular, Consolas, monospace; text-overflow: ellipsis; }
.whale-detail-dialog .account-switch { display: flex; gap: 5px; padding: 4px; border-radius: 8px; background: #0b0e14; }
.whale-detail-dialog .account-switch span { flex: 1; padding: 8px 5px; border-radius: 5px; color: var(--detail-muted); font-size: 11px; text-align: center; }
.whale-detail-dialog .account-switch .selected { color: #e2e8f0; background: #252e3c; }
.whale-detail-dialog .account-switch .unavailable { color: #7e8998; }
.whale-detail-dialog .sentiment-card { padding: 12px; }
.whale-detail-dialog .sentiment-box { display: flex; justify-content: space-between; align-items: center; padding: 14px; border: 1px solid var(--detail-border); border-radius: 9px; background: #10151e; }
.whale-detail-dialog .sentiment-text { display: flex; flex-direction: column; gap: 5px; }
.whale-detail-dialog .sentiment-value { color: #bdc8d6; font-size: 17px; font-weight: 700; }
.whale-detail-dialog .sentiment-caption { color: var(--detail-muted); font-size: 11px; }
.whale-detail-dialog .bias-net { display: grid; gap: 3px; text-align: right; }
.whale-detail-dialog .bias-net b { color: #dce5ef; font: 700 12px ui-monospace, SFMono-Regular, Consolas, monospace; }
.whale-detail-dialog .bias-net small { color: var(--detail-muted); font-size: 9px; }
.whale-detail-dialog .bias-bar { display: flex; height: 8px; margin: 13px 3px 0; overflow: hidden; border-radius: 99px; background: #242c38; }
.whale-detail-dialog .bias-bar-long { background: #0ecb81; transition: width .2s ease; }
.whale-detail-dialog .bias-bar-short { background: #f6465d; transition: width .2s ease; }
.whale-detail-dialog .bias-detail { display: flex; justify-content: space-between; gap: 10px; padding: 10px 3px 0; font: 600 11px ui-monospace, SFMono-Regular, Consolas, monospace; }
.whale-detail-dialog .bias-detail > span { display: grid; gap: 4px; }
.whale-detail-dialog .bias-detail > span:last-child { text-align: right; }
.whale-detail-dialog .bias-detail strong { color: #dce5ef; font-size: 11px; }
.whale-detail-dialog .bias-detail small { color: var(--detail-muted); font-size: 10px; }
.whale-detail-dialog .stats-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.whale-detail-dialog .stat-card { display: flex; min-width: 0; flex-direction: column; gap: 8px; padding: 14px; border: 1px solid var(--detail-border); border-radius: 12px; background: var(--detail-card); }
.whale-detail-dialog .stat-label, .whale-detail-dialog .stat-card small { color: var(--detail-muted); font-size: 11px; }
.whale-detail-dialog .stat-card strong { overflow: hidden; font: 700 15px ui-monospace, SFMono-Regular, Consolas, monospace; text-overflow: ellipsis; }
.whale-detail-dialog .data-note { margin: 0; color: var(--detail-muted); font-size: 10px; line-height: 1.5; }
.whale-detail-dialog .chart-card { display: flex; min-height: 330px; flex-direction: column; gap: 18px; padding: 21px; }
.whale-detail-dialog .chart-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.whale-detail-dialog .chart-title-area { display: flex; flex-direction: column; gap: 7px; }
.whale-detail-dialog .chart-title-area > span { color: var(--detail-muted); font-size: 12px; }
.whale-detail-dialog .chart-title-area > strong { color: #e2e8f0; font: 700 21px ui-monospace, SFMono-Regular, Consolas, monospace; }
.whale-detail-dialog .time-filters { display: flex; flex-wrap: wrap; gap: 3px; padding: 4px; border-radius: 7px; background: #0b0e14; }
.whale-detail-dialog .time-filters button { padding: 6px 8px; border: 0; border-radius: 4px; color: var(--detail-muted); background: transparent; font-size: 10px; cursor: pointer; }
.whale-detail-dialog .time-filters button.selected { color: #e2e8f0; background: #273140; }
.whale-detail-dialog .chart-container { position: relative; display: grid; flex: 1; min-height: 195px; place-items: center; overflow: hidden; }
.whale-detail-dialog .equity-chart { position: absolute; inset: 0; width: 100%; height: 100%; }
.whale-detail-dialog .chart-axis-label { fill: #8994a3; font: 11px system-ui, sans-serif; }
.whale-detail-dialog .chart-axis-grid { stroke: #293240; stroke-dasharray: 3 5; stroke-width: 1; }
.whale-detail-dialog .equity-point { fill: #172b52; stroke: #74a0ff; stroke-width: 2; vector-effect: non-scaling-stroke; }
.whale-detail-dialog .equity-data-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; }
.whale-detail-dialog .equity-data-list > div { display: grid; gap: 5px; min-width: 0; padding: 8px 10px; border: 1px solid var(--detail-border); border-radius: 8px; background: #10151e; }
.whale-detail-dialog .equity-data-list span { overflow: hidden; color: var(--detail-muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.whale-detail-dialog .equity-data-list strong { overflow: hidden; color: #dce5ef; font: 600 11px ui-monospace, SFMono-Regular, Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
.whale-detail-dialog .chart-empty { z-index: 1; display: grid; gap: 8px; justify-items: center; padding: 14px; border: 1px solid rgba(40, 50, 65, .75); border-radius: 10px; background: rgba(16, 21, 30, .9); text-align: center; }
.whale-detail-dialog .chart-empty b { color: #c9d4e2; font-size: 13px; }
.whale-detail-dialog .chart-empty span { color: var(--detail-muted); font-size: 11px; }
.whale-detail-dialog .chart-foot { display: flex; justify-content: space-between; gap: 10px; color: var(--detail-muted); font-size: 11px; }
.whale-detail-dialog .coin-cell { display: flex; flex-direction: column; gap: 5px; text-align: left; }
.whale-detail-dialog .coin-cell b { color: #e2e8f0; font: 600 13px system-ui, sans-serif; }
.whale-detail-dialog .coin-cell small, .whale-detail-dialog .sub-row { display: block; margin-top: 5px; color: #717d8d; font-size: 10px; }
.whale-detail-dialog .missing-field { color: #778392 !important; }
.whale-detail-dialog .results-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.whale-detail-dialog .results-grid article { display: flex; flex-direction: column; gap: 10px; padding: 18px; border: 1px solid var(--detail-border); border-radius: 11px; background: var(--detail-card); }
.whale-detail-dialog .results-grid small { color: var(--detail-muted); font-size: 12px; }
.whale-detail-dialog .results-grid b { color: #e2e8f0; font: 700 18px ui-monospace, SFMono-Regular, Consolas, monospace; }
@media (max-width: 760px) {
  .whale-detail-dialog.el-dialog { width: 100vw !important; height: 100vh; max-height: 100vh; top: 0; }
  .whale-detail-dialog .el-dialog__header { padding: 16px 16px 12px; }
  .whale-detail-dialog .el-dialog__body { padding: 14px 14px 20px; }
  .whale-detail-dialog .metrics-grid { grid-template-columns: 1fr; }
  .whale-detail-dialog .chart-card { min-height: 270px; }
  .whale-detail-dialog .chart-header { flex-direction: column; }
  .whale-detail-dialog .time-filters { align-self: stretch; justify-content: space-between; }
  .whale-detail-dialog .overview-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .whale-detail-dialog .results-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .whale-detail-dialog .metric-card { padding: 13px; }
  .whale-detail-dialog .metric-card strong { font-size: 16px; }
  .whale-detail-dialog .direction-strip { flex-wrap: wrap; gap: 9px; }
  .whale-detail-dialog .direction-bar { order: 5; flex-basis: 100%; }
  .whale-detail-dialog .direction-note { width: 100%; margin: 0; }
  .whale-detail-dialog .updated { display: none; }
}
</style>
