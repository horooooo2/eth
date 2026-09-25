<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  fetchMarketBriefAnalysis,
  streamMarketBrief,
  streamOkxStanceOrder,
  fetchOkxKeys,
  placeBinanceStanceOrder,
  previewBinanceStanceOrder,
  previewOkxStanceOrder,
  type CryptoStanceOrderInput,
  type CryptoStancePreview,
  type MarketBriefResponse,
  type MarketBriefStructured,
  type OkxStanceOrderStage,
} from '@/api';
import { preferredCoinsState, normalizeCoinId } from '@/utils/watchedCoins';
import {
  briefHistoryState,
  pushBriefHistory,
  removeBriefHistory,
  clearBriefHistory,
  formatBriefTime,
  isBriefHistoryFresh,
  type MarketBriefHistoryItem,
} from '@/utils/briefHistory';
import { aiKeyReady } from '@/stores/aiKey';
import { formatPrice } from '@/utils/format';
import { highlightBriefHtml } from '@/utils/briefHighlight';
import BriefKlineChart from '@/components/BriefKlineChart.vue';

type BiasTag = 'buy' | 'sell' | 'wait';
type Phase = 'pick' | 'loading' | 'streaming' | 'result';

type ParsedSection = {
  key: string;
  title: string;
  body: string;
  tag: BiasTag | null;
  tagLabel: string;
};

const LOADING_STEPS = [
  '正在读取 K 线指标与爆仓数据…',
  '解析站外大户与主动买卖…',
  '检索新闻与跨市场基准…',
  'DeepSeek 即将开始流式生成…',
];

const open = ref(false);
const phase = ref<Phase>('pick');
const coin = ref(preferredCoinsState.value[0] || 'BTC');
const customCoin = ref('');
const loading = ref(false);
const error = ref('');
const result = ref<MarketBriefResponse | null>(null);
const streamDraft = ref('');
const statusMessage = ref('');
const loadingStepIdx = ref(0);
const streamScrollRef = ref<HTMLElement | null>(null);
const analysisTab = ref('short');
const techTf = ref<'5m' | '1h' | '1d'>('1d');

let reqSeq = 0;
let stepTimer: ReturnType<typeof setInterval> | null = null;
let abortCtrl: AbortController | null = null;

const preferredCoins = computed(() => preferredCoinsState.value);
const historyList = computed(() => briefHistoryState.value);

function ensureCoin() {
  const list = preferredCoinsState.value;
  if (!list.length) {
    if (!coin.value) coin.value = 'BTC';
    return;
  }
  if (!coin.value) coin.value = list[0];
}

watch(preferredCoinsState, () => ensureCoin(), { immediate: true });

function selectPreferred(id: string) {
  coin.value = id;
  customCoin.value = '';
}

function applyCustomCoin() {
  const id = normalizeCoinId(customCoin.value);
  if (!id || id.length < 2) {
    ElMessage.warning('请输入有效币种代码，如 SOL');
    return;
  }
  coin.value = id;
  customCoin.value = id;
}

function detectBias(text: string): { tag: BiasTag; label: string } | null {
  const t = String(text || '');
  if (/偏多|看多|逢低买|买入|做多|上行/.test(t) && !/偏空|看空|卖出|做空/.test(t.slice(0, 80))) {
    if (/观望|等待|回调做多/.test(t.slice(0, 120))) return { tag: 'wait', label: '观望 / 回调做多' };
    return { tag: 'buy', label: '偏多' };
  }
  if (/偏空|看空|卖出|做空|下行/.test(t)) return { tag: 'sell', label: '偏空' };
  if (/观望|震荡|中性/.test(t)) return { tag: 'wait', label: '观望 / 震荡' };
  return null;
}

function parseSections(analysis: string): ParsedSection[] {
  const raw = String(analysis || '').trim();
  if (!raw) return [];
  const parts = raw.split(/^##\s+/m).filter(Boolean);
  const mapped: ParsedSection[] = [];
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const title = (nl >= 0 ? part.slice(0, nl) : part).trim();
    const body = (nl >= 0 ? part.slice(nl + 1) : '').trim();
    if (!title) continue;
    const bias = detectBias(`${title}\n${body}`);
    let key = 'other';
    if (/短期/.test(title)) key = 'short';
    else if (/中长期|中长/.test(title)) key = 'mid';
    else if (/技术/.test(title)) key = 'tech';
    else if (/新闻/.test(title)) key = 'news';
    else if (/情绪|多空/.test(title)) key = 'sentiment';
    else if (/证据|依据/.test(title)) key = 'evidence';
    else if (/风险|失效/.test(title)) key = 'risk';
    mapped.push({
      key,
      title,
      body,
      tag: bias?.tag || null,
      tagLabel: bias?.label || '',
    });
  }
  if (!mapped.length) {
    return [{ key: 'other', title: '分析结果', body: raw, tag: null, tagLabel: '' }];
  }
  return mapped;
}

const sections = computed(() => parseSections(result.value?.analysis || ''));

const structured = computed<MarketBriefStructured | null>(() => {
  const s = result.value?.analysisResult || result.value?.structured;
  if (!s || typeof s !== 'object') return null;
  if (!s.short_term && !s.mid_long_term && !s.technical) return null;
  return s;
});

const sentiment = computed(() => {
  const st = structured.value?.short_term;
  if (st?.bias || st?.direction || st?.confidence) {
    const biasText = st.direction || st.bias || '';
    const tag = /偏多|看多/.test(biasText)
      ? 'buy'
      : /偏空|看空|承压/.test(biasText)
        ? 'sell'
        : 'wait';
    const tone = tag === 'buy' ? 'bull' : tag === 'sell' ? 'bear' : 'neutral';
    const emoji = tag === 'buy' ? '🟢' : tag === 'sell' ? '🔴' : '🟡';
    const level = (/低|中|高/.exec(st.confidence || '')?.[0] || '') as '' | '低' | '中' | '高';
    return {
      label: `${emoji} 市场情绪：${biasText || '待解读'}`,
      tone,
      confidence: level ? `AI 信心：${level}` : st.confidence ? `AI 信心：${st.confidence}` : 'AI 信心：见正文',
      confidenceLevel: level,
    };
  }
  const short = sections.value.find((s) => s.key === 'short');
  const mid = sections.value.find((s) => s.key === 'mid');
  const bias = short?.tag
    ? { tag: short.tag, label: short.tagLabel }
    : mid?.tag
      ? { tag: mid.tag, label: mid.tagLabel }
      : detectBias(result.value?.analysis || '');
  if (!bias) {
    return {
      label: '市场情绪：待解读',
      tone: 'neutral' as const,
      confidence: '—',
      confidenceLevel: '' as '' | '低' | '中' | '高',
    };
  }
  const tone = bias.tag === 'buy' ? 'bull' : bias.tag === 'sell' ? 'bear' : 'neutral';
  const emoji = bias.tag === 'buy' ? '🟢' : bias.tag === 'sell' ? '🔴' : '🟡';
  const confMatch = String(result.value?.analysis || '').match(/信心[：:]\s*(低|中|高)/);
  const level = (confMatch?.[1] || '') as '' | '低' | '中' | '高';
  return {
    label: `${emoji} 市场情绪：${bias.label}`,
    tone,
    confidence: level ? `AI 信心：${level}` : 'AI 信心：见正文',
    confidenceLevel: level,
  };
});

const chartPacks = computed(() => {
  const c = result.value?.contextSummary?.charts;
  return {
    m5: c?.m5 || null,
    hour: c?.hour || null,
    day: c?.day || null,
  };
});

const activeTechText = computed(() => {
  const t = structured.value?.technical;
  if (!t) return '';
  if (techTf.value === '5m') return t.m5 || '';
  if (techTf.value === '1h') return t.hourly || '';
  return t.daily || '';
});

const activeTechLabel = computed(() => {
  if (techTf.value === '5m') return '5分钟';
  if (techTf.value === '1h') return '小时线';
  return '日线';
});

const personalStance = computed(() => structured.value?.personal_stance || null);

const stanceCards = computed(() => {
  const ps = personalStance.value;
  return [
    { id: 'short', header: '短线 · 1小时', leg: ps?.short },
    { id: 'mid_long', header: '长线 · 日线', leg: ps?.mid_long },
  ];
});

type AnalysisTab = { id: string; label: string };

const analysisTabs = computed<AnalysisTab[]>(() => {
  const s = structured.value;
  if (s) {
    const tabs: AnalysisTab[] = [
      { id: 'short', label: '短期看法' },
      { id: 'mid', label: '中长期' },
      { id: 'tech', label: '技术分析' },
      { id: 'news', label: '新闻分析' },
      { id: 'sentiment', label: '市场情绪' },
    ];
    if (s.key_evidence?.length) tabs.push({ id: 'evidence', label: '关键证据' });
    if (s.risks_and_invalidation?.length) tabs.push({ id: 'risk', label: '风险失效' });
    return tabs;
  }
  return sections.value.map((sec) => ({
    id: sec.key,
    label: sec.title.replace(/^[\u{1F300}-\u{1FAFF}\u2600-\u27BF]\s*/u, '') || sec.title,
  }));
});

watch(
  analysisTabs,
  (tabs) => {
    if (!tabs.length) return;
    if (!tabs.some((t) => t.id === analysisTab.value)) {
      analysisTab.value = tabs[0].id;
    }
  },
  { immediate: true },
);

function stanceActionClass(action?: string) {
  const t = String(action || '');
  if (/做多/.test(t)) return 'long';
  if (/做空/.test(t)) return 'short';
  return 'wait';
}

function fmtStancePrice(v: number | null | undefined) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return formatPrice(Number(v));
}

function isWaitAction(action?: string) {
  return !action || /观望/.test(action);
}

function canUsePending(leg: NonNullable<MarketBriefStructured['personal_stance']>['short']) {
  if (!leg || leg.execution !== '等待触发' || leg.entry_validation?.decision !== '支持') return false;
  const validation = leg.entry_validation;
  if (!validation.technical || !validation.sentiment || !validation.news_macro || !validation.positioning) return false;
  if (![validation.sentiment, validation.news_macro, validation.positioning].some((item) => !/暂无|缺失|无数据|unavailable|未接入/i.test(String(item)))) return false;
  const direction = structured.value?.mid_long_term?.direction;
  if (leg.action === '做多' ? direction !== '偏多' : leg.action === '做空' ? direction !== '偏空' : true) return false;
  return Number(leg.entry) > 0 && Number(leg.stop) > 0 && Number(leg.take_profit) > 0;
}

const orderDialogVisible = ref(false);
const orderAmount = ref('10');
const availableOrderExchanges = ref<Array<'binance' | 'okx'>>([]);
const selectedOrderExchange = ref<'binance' | 'okx'>('binance');
const orderExchangeSimulation = ref<{ binance: boolean; okx: boolean }>({ binance: true, okx: true });
const orderSubmitting = ref(false);
const orderPreview = ref<CryptoStancePreview['plan'] | null>(null);
const orderPreviewBusy = ref(false);
const orderPreviewError = ref('');
const orderMode = ref<'direct' | 'pending'>('direct');
let orderPreviewSeq = 0;
const orderProgressVisible = ref(false);
const orderProgress = ref(0);
const orderProgressError = ref('');
const orderProgressDone = ref(false);
const orderProgressSteps = ref<
  { id: string; label: string; status: 'pending' | 'running' | 'done' | 'error'; detail?: string }[]
>([]);
const orderTarget = ref<{
  id: string;
  header: string;
  leg: NonNullable<MarketBriefStructured['personal_stance']>['short'];
} | null>(null);

const orderPreviewPrice = computed(() => Number(orderPreview.value?.price ?? orderPreview.value?.entry));
const orderDistancePct = computed(() => {
  const last = Number(orderPreview.value?.last);
  const price = orderPreviewPrice.value;
  return last > 0 && Number.isFinite(price) ? ((price - last) / last * 100) : null;
});
const orderLeverage = computed(() => 5);

function stanceOrderInput(): CryptoStanceOrderInput | null {
  const leg = orderTarget.value?.leg;
  const targetCoin = result.value?.coin;
  const analysisId = result.value?.analysisId;
  const horizon = orderTarget.value?.id;
  if (!leg || !targetCoin || !analysisId || (horizon !== 'short' && horizon !== 'mid_long') || leg.entry == null || leg.stop == null || leg.take_profit == null) return null;
  return {
    coin: targetCoin,
    analysisId,
    horizon,
    action: String(leg.action),
    execution: String(leg.execution || '禁止下单'),
    orderMode: orderMode.value,
    entry: Number(leg.entry),
    stop: Number(leg.stop),
    takeProfit: Number(leg.take_profit),
    leverage: orderLeverage.value,
    amountUsd: Number(orderAmount.value),
  };
}

async function refreshOrderPreview() {
  const seq = ++orderPreviewSeq;
  orderPreview.value = null;
  orderPreviewError.value = '';
  const payload = stanceOrderInput();
  if (!payload || !availableOrderExchanges.value.includes(selectedOrderExchange.value)) return;
  if (!(payload.amountUsd > 0) || payload.amountUsd > 100) {
    orderPreviewError.value = '本金必须在 0～100 USDT 之间';
    return;
  }
  orderPreviewBusy.value = true;
  try {
    const response = selectedOrderExchange.value === 'binance'
      ? await previewBinanceStanceOrder(payload)
      : await previewOkxStanceOrder(payload);
    if (seq === orderPreviewSeq) orderPreview.value = response.plan;
  } catch (err) {
    if (seq === orderPreviewSeq) orderPreviewError.value = err instanceof Error ? err.message : '无法预览订单';
  } finally {
    if (seq === orderPreviewSeq) orderPreviewBusy.value = false;
  }
}

watch([orderAmount, selectedOrderExchange], () => {
  if (orderDialogVisible.value) void refreshOrderPreview();
});

const ORDER_STEP_DEFS = [
  { id: 'price', label: '获取当前最新价格' },
  { id: 'limit', label: '按多空方向挂限价单（Maker）' },
  { id: 'sltp', label: '设置止损 / 止盈' },
  { id: 'done', label: '提交完成' },
] as const;

function resetOrderProgress() {
  orderProgress.value = 0;
  orderProgressError.value = '';
  orderProgressDone.value = false;
  orderProgressSteps.value = ORDER_STEP_DEFS.map((s) => ({
    id: s.id,
    label: s.label,
    status: 'pending' as const,
  }));
}

function applyOrderStage(stage: OkxStanceOrderStage) {
  if (typeof stage.progress === 'number') {
    orderProgress.value = Math.max(orderProgress.value, Math.min(100, stage.progress));
  }
  const mapId = stage.id === 'init' ? 'price' : stage.id;
  const idx = orderProgressSteps.value.findIndex((s) => s.id === mapId);
  if (idx < 0) return;
  for (let i = 0; i < idx; i++) {
    if (orderProgressSteps.value[i].status !== 'done') {
      orderProgressSteps.value[i] = { ...orderProgressSteps.value[i], status: 'done' };
    }
  }
  const cur = orderProgressSteps.value[idx];
  const nextStatus =
    stage.status === 'done' || stage.id === 'done'
      ? 'done'
      : stage.status === 'error'
        ? 'error'
        : 'running';
  orderProgressSteps.value[idx] = {
    ...cur,
    status: nextStatus,
    detail: stage.message || cur.detail,
  };
}

async function openOrderDialog(card: {
  id: string;
  header: string;
  leg: NonNullable<MarketBriefStructured['personal_stance']>['short'];
}, mode: 'direct' | 'pending' = 'direct') {
  if (mode === 'pending' && !canUsePending(card.leg)) {
    ElMessage.warning('AI 尚未验证这个挂单价，或方向与中长期判断不一致，请重新分析');
    return;
  }
  if (!card.leg?.execution) {
    ElMessage.warning('这份分析没有新的开单状态，请重新分析后再预览订单');
    return;
  }
  if (mode === 'direct' && card.leg?.execution !== '现在可开') {
    ElMessage.warning(card.leg?.trigger || card.leg?.note || '尚未达到开单条件，请重新分析');
    return;
  }
  if (isWaitAction(card.leg?.action)) {
    ElMessage.warning('当前仍为观望，请点顶部「重新分析」生成做多/做空方案');
    return;
  }
  if (card.leg?.entry == null || card.leg?.stop == null || card.leg?.take_profit == null) {
    ElMessage.warning('缺少开仓/止损/止盈价，请先刷新该周期建议');
    return;
  }
  orderTarget.value = card;
  orderMode.value = mode;
  orderAmount.value = '10';
  try {
    const keys = await fetchOkxKeys();
    availableOrderExchanges.value = ([
      ...(keys.binance?.ready ? ['binance' as const] : []),
      ...(keys.okx?.ready ? ['okx' as const] : []),
    ]);
    orderExchangeSimulation.value = { binance: Boolean(keys.binance?.simulated), okx: Boolean(keys.okx?.simulated) };
    selectedOrderExchange.value = availableOrderExchanges.value[0] || 'binance';
  } catch (err) {
    availableOrderExchanges.value = [];
    ElMessage.warning(err instanceof Error ? err.message : '读取交易所配置失败');
  }
  orderDialogVisible.value = true;
  await refreshOrderPreview();
}

async function confirmStanceOrder() {
  if (orderSubmitting.value) return;
  const card = orderTarget.value;
  const coin = result.value?.coin;
  if (!card?.leg || !coin) return;
  const payload = stanceOrderInput();
  if (!availableOrderExchanges.value.includes(selectedOrderExchange.value)) {
    ElMessage.warning('请先在左下角「API 设置」配置币安或 OKX API 密钥');
    return;
  }
  if (!payload || !(payload.amountUsd > 0) || payload.amountUsd > 100) {
    ElMessage.warning('请输入 0~100 的 USDT 金额');
    return;
  }
  if (!orderPreview.value || !Number.isFinite(orderPreviewPrice.value)) {
    ElMessage.warning(orderPreviewError.value || '请等待真实订单预览完成');
    return;
  }
  const previewPrice = orderPreviewPrice.value;
  const previewLoss = Number(orderPreview.value.estimatedLossUsdt);
  const exchange = selectedOrderExchange.value;
  orderSubmitting.value = true;
  try {
    await ElMessageBox.confirm(
      `交易所 ${exchange === 'binance' ? '币安' : 'OKX'} · ${orderExchangeSimulation.value[exchange] ? '演示盘' : '实盘'}\n${coin} · ${card.leg.action} · ${card.header}\n实际委托价 ${fmtStancePrice(previewPrice)} · 本金 ${payload.amountUsd} USDT · 杠杆 ${payload.leverage}x\n止损 ${fmtStancePrice(card.leg.stop)} · 止盈 ${fmtStancePrice(card.leg.take_profit)}\n预计到止损亏损 ${Number.isFinite(previewLoss) ? previewLoss.toFixed(2) : '—'} USDT（未计手续费与滑点）${orderMode.value === 'pending' ? '\n挂单会立即提交交易所，价格触及时即可成交，不等待复合条件确认。' : ''}`,
      orderMode.value === 'pending' ? '确认交易所限价挂单' : '确认挂单开仓',
      { type: 'warning', confirmButtonText: '开始挂单', cancelButtonText: '取消' },
    );
  } catch {
    orderSubmitting.value = false;
    return;
  }

  orderDialogVisible.value = false;
  resetOrderProgress();
  orderProgressVisible.value = true;
  orderSubmitting.value = true;

  try {
    payload.expectedPrice = previewPrice;
    if (exchange === 'binance') {
      applyOrderStage({ id: 'price', status: 'running', progress: 15, message: '读取币安行情与合约规则…' });
      const data = await placeBinanceStanceOrder(payload);
      orderProgress.value = 100;
      orderProgressDone.value = true;
      orderProgressSteps.value = orderProgressSteps.value.map((step) => ({ ...step, status: 'done' as const }));
      ElMessage.success(`${data.simulated ? '币安演示盘' : '币安实盘'}挂单成功 ${String(data.order?.orderId || '')}`);
      return;
    }
    await streamOkxStanceOrder(
      payload,
      {
        onStage: applyOrderStage,
        onDone: (data) => {
          orderProgress.value = 100;
          orderProgressDone.value = true;
          orderProgressSteps.value = orderProgressSteps.value.map((s) =>
            s.status === 'error' ? s : { ...s, status: 'done' as const },
          );
          const ordId = String(data.order?.ordId || '');
          const px = data.plan && typeof data.plan.entry === 'number' ? data.plan.entry : '';
          ElMessage.success(
            (data.simulated ? '模拟盘挂单成功' : '挂单成功') +
              (ordId ? ` ${ordId}` : '') +
              (px ? ` · 限价 ${px}` : ''),
          );
        },
        onError: (message) => {
          orderProgressError.value = message;
          const running = orderProgressSteps.value.find((s) => s.status === 'running');
          if (running) {
            running.status = 'error';
            running.detail = message;
          }
        },
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : '挂单失败';
    orderProgressError.value = msg;
    ElMessage.error(msg);
  } finally {
    orderSubmitting.value = false;
  }
}

function biasFromResult(data: MarketBriefResponse) {
  const st = data.analysisResult?.short_term || data.structured?.short_term;
  if (st?.direction || st?.bias) {
    return { bias: st.direction || st.bias, confidence: st.confidence };
  }
  const m = String(data.analysis || '').match(/方向倾向[：:]\s*([^\s｜|]+)(?:\s*[｜|]\s*信心[：:]\s*(低|中|高))?/);
  const conf = String(data.analysis || '').match(/信心[：:]\s*(低|中|高)/);
  return {
    bias: m?.[1] || '',
    confidence: m?.[2] || conf?.[1] || '',
  };
}

function saveHistory(data: MarketBriefResponse) {
  if (!data?.analysis) return;
  const { bias, confidence } = biasFromResult(data);
  const bits: string[] = [];
  const s = data.contextSummary;
  if (s?.price != null) bits.push(`现价 ${formatPrice(s.price)}`);
  if (bias) bits.push(bias);
  if (confidence) bits.push(`信心${confidence}`);
  pushBriefHistory({
    coin: data.coin,
    at: Date.now(),
    bias,
    confidence,
    analysis: data.analysis,
    structured: data.analysisResult || data.structured || null,
    summaryBits: bits,
    analysisId: data.analysisId,
    contextSnapshotId: data.contextSnapshotId,
    version: data.version,
    contextDiffSummary: data.contextDiff?.summary,
    messages: [],
  });
}

function openHistory(item: MarketBriefHistoryItem) {
  coin.value = item.coin;
  customCoin.value = '';
  streamDraft.value = '';
  error.value = '';

  if (/^\s*\{\s*["']short_term["']\s*:/.test(item.structured?.short_term?.summary || item.analysis || '')) {
    result.value = null;
    phase.value = 'pick';
    error.value = '这条历史分析的格式不完整，请重新分析';
    return;
  }

  if (!isBriefHistoryFresh(item)) {
    ElMessage.info(`${item.coin} 历史已超过 1 小时，正在重新分析…`);
    phase.value = 'loading';
    void runBrief();
    return;
  }

  result.value = {
    ok: true,
    coin: item.coin,
    analysis: item.analysis,
    structured: item.structured || null,
    analysisResult: item.structured || null,
    analysisId: item.analysisId,
    contextSnapshotId: item.contextSnapshotId,
    version: item.version,
    contextDiff: item.contextDiffSummary
      ? { changed: true, summary: item.contextDiffSummary }
      : null,
    contextText: '',
    contextSummary: undefined,
  };
  phase.value = 'result';
}

function shortTermBias(st?: MarketBriefStructured['short_term'] | MarketBriefStructured['mid_long_term']) {
  return st?.direction || st?.bias || '';
}

function shortTermBody(st?: MarketBriefStructured['short_term'] | MarketBriefStructured['mid_long_term']) {
  return st?.summary || st?.reason || '';
}

function deleteHistory(id: string, ev: Event) {
  ev.stopPropagation();
  removeBriefHistory(id);
}

function biasClass(bias?: string) {
  const t = String(bias || '');
  if (/偏多|看多|利好/.test(t)) return 'tone-buy';
  if (/偏空|看空|承压|利空/.test(t)) return 'tone-sell';
  return 'tone-wait';
}

function startLoadingSteps() {
  stopLoadingSteps();
  loadingStepIdx.value = 0;
  stepTimer = setInterval(() => {
    loadingStepIdx.value = (loadingStepIdx.value + 1) % LOADING_STEPS.length;
  }, 1200);
}

function stopLoadingSteps() {
  if (stepTimer) {
    clearInterval(stepTimer);
    stepTimer = null;
  }
}

function openModal() {
  open.value = true;
  if (!result.value) {
    phase.value = 'pick';
    error.value = '';
  } else {
    phase.value = 'result';
  }
}

function closeModal() {
  open.value = false;
  if (loading.value) {
    reqSeq += 1;
    loading.value = false;
    stopLoadingSteps();
    abortCtrl?.abort();
    abortCtrl = null;
    phase.value = result.value ? 'result' : 'pick';
  }
}

async function runBrief() {
  if (!aiKeyReady.value) {
    ElMessage.warning('请先在侧栏「API 设置」中配置 DeepSeek API Key');
    return;
  }
  if (customCoin.value.trim()) applyCustomCoin();
  const target = normalizeCoinId(coin.value);
  if (!target) {
    ElMessage.warning('请选择或输入币种');
    return;
  }
  coin.value = target;

  const seq = ++reqSeq;
  abortCtrl?.abort();
  abortCtrl = new AbortController();
  loading.value = true;
  error.value = '';
  result.value = null;
  streamDraft.value = '';
  statusMessage.value = '正在分析价格、情绪与事件…';
  phase.value = 'loading';
  startLoadingSteps();
  let liveAnalysisId = '';

  try {
    await streamMarketBrief(target, {
      signal: abortCtrl.signal,
      forceRefresh: true,
      forceTradeDecision: true,
      onStatus: (s) => {
        if (seq !== reqSeq) return;
        if (s.message) statusMessage.value = s.message;
        if ((s as { analysisId?: string }).analysisId) {
          liveAnalysisId = String((s as { analysisId?: string }).analysisId);
        }
      },
      onMeta: (meta) => {
        if (seq !== reqSeq) return;
        if ((meta as { analysisId?: string }).analysisId) {
          liveAnalysisId = String((meta as { analysisId?: string }).analysisId);
        }
        result.value = {
          ok: true,
          coin: meta.coin || target,
          analysis: '',
          structured: null,
          analysisResult: null,
          analysisId: liveAnalysisId || undefined,
          contextSnapshotId: (meta as { contextSnapshotId?: string }).contextSnapshotId,
          version: (meta as { version?: string }).version,
          contextDiff: (meta as { contextDiff?: MarketBriefResponse['contextDiff'] }).contextDiff,
          contextSummary: meta.contextSummary,
        };
        stopLoadingSteps();
        phase.value = 'streaming';
        statusMessage.value = '正在生成交易计划…';
      },
      onDelta: (text) => {
        if (seq !== reqSeq || !text) return;
        streamDraft.value += text;
        phase.value = 'streaming';
        nextTick(() => {
          const el = streamScrollRef.value;
          if (el) el.scrollTop = el.scrollHeight;
        });
      },
      onDone: (data) => {
        if (seq !== reqSeq) return;
        const unified = {
          ...data,
          structured: data.analysisResult || data.structured || null,
          analysisResult: data.analysisResult || data.structured || null,
        };
        result.value = unified;
        streamDraft.value = unified.analysis || streamDraft.value;
        phase.value = 'result';
        statusMessage.value = '';
        if (!unified.analysis) error.value = '未返回分析结果';
        else saveHistory(unified);
      },
    });
  } catch (err) {
    if (seq !== reqSeq) return;
    if ((err as Error)?.name === 'AbortError') return;
    // 断线：按 analysisId 查询，不自动重跑 DeepSeek
    if (liveAnalysisId) {
      try {
        const recovered = await fetchMarketBriefAnalysis(liveAnalysisId);
        if (recovered?.status === 'done' && (recovered.analysis || recovered.analysisResult)) {
          const unified = {
            ...recovered,
            ok: true,
            analysis: recovered.analysis || '',
            structured: recovered.analysisResult || recovered.structured || null,
            analysisResult: recovered.analysisResult || recovered.structured || null,
          } as MarketBriefResponse;
          result.value = unified;
          phase.value = 'result';
          saveHistory(unified);
          return;
        }
        if (recovered?.status === 'failed') {
          error.value = recovered.error || '上次分析失败，请手动重新分析';
          phase.value = 'pick';
          return;
        }
      } catch {
        /* fallthrough */
      }
    }
    error.value = err instanceof Error ? err.message : '生成建议失败';
    result.value = null;
    phase.value = 'pick';
  } finally {
    if (seq === reqSeq) {
      loading.value = false;
      stopLoadingSteps();
      abortCtrl = null;
    }
  }
}

function backToPick() {
  phase.value = 'pick';
  error.value = '';
}

onUnmounted(() => {
  stopLoadingSteps();
  abortCtrl?.abort();
});
</script>

<template>
  <div class="ai-launcher">
    <button type="button" class="ai-fab" title="AI 深度诊币" @click="openModal">
      <span class="ai-spark" aria-hidden="true">✨</span>
      AI 深度诊币
    </button>

    <Teleport to="body">
      <div v-if="open" class="overlay" @click.self="closeModal">
        <div class="modal" role="dialog" aria-modal="true" aria-label="AI 深度诊币">
          <header class="modal-header">
            <div class="modal-title-row">
              <div class="modal-title">
                <span class="ai-spark">✨</span>
                DeepSeek 智能投研
                <em v-if="phase !== 'pick'">· {{ coin }}</em>
              </div>
              <div v-if="phase !== 'pick'" class="header-actions">
                <button
                  type="button"
                  class="ghost-btn ghost-sm"
                  :disabled="loading || phase === 'streaming'"
                  @click="() => runBrief()"
                >
                  重新分析
                </button>
                <button type="button" class="ghost-btn ghost-sm" :disabled="loading" @click="backToPick">
                  换币种
                </button>
              </div>
            </div>
            <button type="button" class="close-btn" aria-label="关闭" @click="closeModal">×</button>
          </header>

          <!-- 选币 -->
          <div v-if="phase === 'pick'" class="modal-body pick-body">
            <p class="intro">选择偏好币种，或输入自定义代码后开始诊币。</p>

            <div class="block">
              <div class="block-label">偏好币种</div>
              <div class="chip-row">
                <button
                  v-for="id in preferredCoins"
                  :key="id"
                  type="button"
                  class="coin-chip"
                  :class="{ active: coin === id && !customCoin }"
                  @click="selectPreferred(id)"
                >
                  {{ id }}
                </button>
                <span v-if="!preferredCoins.length" class="muted">暂无偏好，可在下方自定义</span>
              </div>
            </div>

            <div class="block">
              <div class="block-label">自定义币种</div>
              <div class="custom-row">
                <input
                  v-model="customCoin"
                  class="custom-input"
                  placeholder="例如 SOL / HYPE / ARB"
                  maxlength="16"
                  @keydown.enter.prevent="applyCustomCoin"
                />
                <button type="button" class="ghost-btn" @click="applyCustomCoin">使用</button>
              </div>
              <p v-if="customCoin && normalizeCoinId(customCoin) === coin" class="muted tiny">
                当前将分析：{{ coin }}
              </p>
            </div>

            <el-alert
              v-if="error"
              type="error"
              :closable="false"
              :title="error"
              class="err"
            />
            <el-alert
              v-if="!aiKeyReady"
              type="warning"
              :closable="false"
              title="未配置 DeepSeek Key，请先到侧栏「币种偏好」绑定"
              class="err"
            />

            <button type="button" class="primary-btn" :disabled="loading" @click="() => runBrief()">
              开始诊币 · {{ coin || '—' }}
            </button>

            <div v-if="historyList.length" class="block history-block">
              <div class="history-head">
                <div class="block-label">历史诊币</div>
                <button type="button" class="ghost-btn ghost-sm" @click="clearBriefHistory">清空</button>
              </div>
              <div class="history-list">
                <button
                  v-for="item in historyList"
                  :key="item.id"
                  type="button"
                  class="history-item"
                  @click="openHistory(item)"
                >
                  <div class="history-main">
                    <span class="history-coin">{{ item.coin }}</span>
                    <span v-if="item.version" class="history-conf">{{ item.version }}</span>
                    <span v-if="!isBriefHistoryFresh(item)" class="history-expired">已过期</span>
                    <span v-if="item.bias" class="history-bias">{{ item.bias }}</span>
                    <span v-if="item.confidence" class="history-conf">信心{{ item.confidence }}</span>
                    <span v-if="item.messages?.length" class="history-conf">聊{{ item.messages.length }}</span>
                  </div>
                  <div class="history-meta">
                    <span>{{ formatBriefTime(item.at) }}</span>
                    <span
                      class="history-del"
                      title="删除"
                      @click="deleteHistory(item.id, $event)"
                    >×</span>
                  </div>
                  <div v-if="item.contextDiffSummary" class="history-diff">{{ item.contextDiffSummary }}</div>
                </button>
              </div>
            </div>
          </div>

          <!-- 加载：仅数据打包阶段 -->
          <div v-else-if="phase === 'loading'" class="modal-body loading-state">
            <div class="spinner" />
            <div class="loading-step">{{ statusMessage || LOADING_STEPS[loadingStepIdx] }}</div>
            <p class="loading-sub">正在汇总站内与站外数据…</p>
          </div>

          <!-- 结果 + 流式打字 + 对话 -->
          <div v-else class="modal-body result-layout">
            <div
              v-if="phase === 'result' || phase === 'streaming'"
              class="sentiment-sticky"
              :class="sentiment.tone"
            >
              <div class="sticky-main">
                <span class="sticky-coin">{{ coin }}</span>
                <span v-if="result?.version" class="sticky-ver">{{ result.version }}</span>
                <span class="sentiment-text">短线判断：{{ shortTermBias(structured?.short_term) || '分析中' }}</span>
              </div>
              <div
                class="confidence"
                :class="{
                  'conf-low': sentiment.confidenceLevel === '低',
                  'conf-mid': sentiment.confidenceLevel === '中',
                  'conf-high': sentiment.confidenceLevel === '高',
                }"
              >
                {{ phase === 'streaming' ? '生成中…' : sentiment.confidence }}
              </div>
            </div>

            <div ref="streamScrollRef" class="result-scroll">
              <div v-if="phase === 'streaming'" class="stream-banner">
                <span class="stream-dot" />
                正在分析价格结构、情绪与事件…
              </div>

              <div v-if="phase === 'streaming'" class="quiet-analysis">AI 正在静默分析，完成后显示交易结论。</div>

              <div v-else-if="structured || sections.length" class="simple-result">
                <p v-if="structured?.event_reaction && !/暂无|unavailable/i.test(structured.event_reaction)" class="simple-event">事件反应：{{ structured.event_reaction }}</p>
                <div v-if="structured" class="simple-cards">
                  <div v-for="card in stanceCards" :key="card.id" class="simple-card">
                    <div class="simple-card-head"><strong>{{ card.header }}</strong><span :class="stanceActionClass(card.leg?.action)">{{ card.leg?.action || '数据不足' }} · {{ card.leg?.execution || '禁止下单' }}</span></div>
                    <div class="simple-prices">
                      <span>参考入场 <b>{{ fmtStancePrice(card.leg?.entry) }}</b></span>
                      <span>止损 <b>{{ fmtStancePrice(card.leg?.stop) }}</b></span>
                      <span>止盈 <b>{{ fmtStancePrice(card.leg?.take_profit) }}</b></span>
                    </div>
                    <p class="simple-note">{{ card.leg?.note || (card.id === 'short' ? shortTermBody(structured.short_term) : shortTermBody(structured.mid_long_term)) }}</p>
                    <p v-if="card.leg?.execution === '等待触发' && card.leg?.trigger" class="simple-note">触发条件：{{ card.leg.trigger }}</p>
                    <details v-if="card.leg?.entry_validation" class="entry-validation">
                      <summary>查看入场价验证 · {{ card.leg.entry_validation.decision }}</summary>
                      <p>技术：{{ card.leg.entry_validation.technical || '暂无' }}</p>
                      <p>情绪：{{ card.leg.entry_validation.sentiment || '暂无' }}</p>
                      <p>新闻宏观：{{ card.leg.entry_validation.news_macro || '暂无' }}</p>
                      <p>大户与资金：{{ card.leg.entry_validation.positioning || '暂无' }}</p>
                    </details>
                    <button v-if="card.leg?.execution === '现在可开'" type="button" class="primary-btn simple-order-btn" @click="openOrderDialog(card, 'direct')">预览订单</button>
                    <div v-else-if="card.leg?.execution === '等待触发'" class="order-choice-row">
                      <button type="button" class="primary-btn simple-order-btn" disabled>预览订单 · 待条件满足</button>
                      <button type="button" class="primary-btn simple-order-btn" :disabled="!canUsePending(card.leg)" @click="openOrderDialog(card, 'pending')">挂单模式</button>
                    </div>
                    <p v-if="card.leg?.execution === '等待触发' && !canUsePending(card.leg)" class="order-hint">挂单价缺少综合验证，或与中长期方向不一致；请重新分析。</p>
                  </div>
                </div>
                <div v-else class="simple-card"><strong>{{ sentiment.label }}</strong><p class="simple-note">结构化计划未生成，请重新分析后再预览订单。</p></div>
                <details class="analysis-details"><summary>查看分析依据</summary>
                <div class="analysis-tabs-wrap">
                <div class="analysis-tabs" role="tablist">
                  <button
                    v-for="tab in analysisTabs"
                    :key="tab.id"
                    type="button"
                    role="tab"
                    class="analysis-tab"
                    :class="{ active: analysisTab === tab.id }"
                    :aria-selected="analysisTab === tab.id"
                    @click="analysisTab = tab.id"
                  >
                    {{ tab.label }}
                  </button>
                </div>

                <div class="analysis-tab-panel">
                  <template v-if="structured">
                    <div v-show="analysisTab === 'short'" class="tab-pane">
                      <div class="coin-analysis" :class="biasClass(shortTermBias(structured.short_term))">
                        <div class="coin-header">
                          <span
                            class="tag"
                            :class="biasClass(shortTermBias(structured.short_term)) === 'tone-buy' ? 'tag-buy' : biasClass(shortTermBias(structured.short_term)) === 'tone-sell' ? 'tag-sell' : 'tag-wait'"
                            v-html="highlightBriefHtml(shortTermBias(structured.short_term) || '观望')"
                          />
                        </div>
                        <div
                          class="coin-desc"
                          v-html="highlightBriefHtml(shortTermBody(structured.short_term))"
                        />
                      </div>
                    </div>

                    <div v-show="analysisTab === 'mid'" class="tab-pane">
                      <div class="coin-analysis" :class="biasClass(shortTermBias(structured.mid_long_term))">
                        <div v-if="shortTermBias(structured.mid_long_term)" class="coin-header">
                          <span
                            class="tag"
                            :class="biasClass(shortTermBias(structured.mid_long_term)) === 'tone-buy' ? 'tag-buy' : biasClass(shortTermBias(structured.mid_long_term)) === 'tone-sell' ? 'tag-sell' : 'tag-wait'"
                            v-html="highlightBriefHtml(shortTermBias(structured.mid_long_term))"
                          />
                        </div>
                        <div
                          class="coin-desc"
                          v-html="highlightBriefHtml(shortTermBody(structured.mid_long_term))"
                        />
                      </div>
                    </div>

                    <div v-show="analysisTab === 'tech'" class="tab-pane tech-pane">
                      <BriefKlineChart
                        v-model="techTf"
                        :m5="chartPacks.m5"
                        :hour="chartPacks.hour"
                        :day="chartPacks.day"
                      />
                      <div class="coin-analysis">
                        <div class="coin-desc tech-desc">
                          <template v-if="activeTechText">
                            <strong>{{ activeTechLabel }}：</strong>
                            <span v-html="highlightBriefHtml(activeTechText)" />
                          </template>
                          <template v-else>当前周期暂无文字分析</template>
                        </div>
                      </div>
                    </div>

                    <div v-show="analysisTab === 'news'" class="tab-pane">
                      <div class="coin-analysis" :class="biasClass(structured.news_analysis?.sentiment)">
                        <div v-if="structured.news_analysis?.sentiment" class="coin-header">
                          <span
                            class="tag tag-wait"
                            v-html="highlightBriefHtml(structured.news_analysis.sentiment)"
                          />
                        </div>
                        <div
                          class="coin-desc"
                          v-html="highlightBriefHtml(structured.news_analysis?.details)"
                        />
                      </div>
                    </div>

                    <div v-show="analysisTab === 'sentiment'" class="tab-pane">
                      <div class="coin-analysis">
                        <div class="coin-desc">
                          <p v-if="structured.market_sentiment?.long_short_ratio">
                            多空：
                            <span v-html="highlightBriefHtml(structured.market_sentiment.long_short_ratio)" />
                          </p>
                          <p v-if="structured.market_sentiment?.funding_rate">
                            费率：
                            <span v-html="highlightBriefHtml(structured.market_sentiment.funding_rate)" />
                          </p>
                          <p v-if="structured.market_sentiment?.liquidations">
                            爆仓：
                            <span v-html="highlightBriefHtml(structured.market_sentiment.liquidations)" />
                          </p>
                          <p
                            v-if="structured.market_sentiment?.details"
                            v-html="highlightBriefHtml(structured.market_sentiment.details)"
                          />
                        </div>
                      </div>
                    </div>

                    <div v-show="analysisTab === 'evidence'" class="tab-pane">
                      <div class="coin-analysis">
                        <ul class="bullet-list">
                          <li
                            v-for="(e, i) in structured.key_evidence || []"
                            :key="i"
                            v-html="highlightBriefHtml(e)"
                          />
                        </ul>
                      </div>
                    </div>

                    <div v-show="analysisTab === 'risk'" class="tab-pane">
                      <div class="coin-analysis risk">
                        <ul class="bullet-list">
                          <li
                            v-for="(e, i) in structured.risks_and_invalidation || []"
                            :key="i"
                            v-html="highlightBriefHtml(e)"
                          />
                        </ul>
                      </div>
                    </div>

                  </template>

                  <template v-else>
                    <div
                      v-for="sec in sections"
                      v-show="analysisTab === sec.key"
                      :key="sec.key"
                      class="tab-pane"
                    >
                      <div
                        class="coin-analysis"
                        :class="[
                          sec.key,
                          sec.tag === 'buy' ? 'tone-buy' : sec.tag === 'sell' ? 'tone-sell' : sec.tag === 'wait' ? 'tone-wait' : '',
                        ]"
                      >
                        <div
                          v-if="sec.tagLabel && (sec.key === 'short' || sec.key === 'mid')"
                          class="coin-header"
                        >
                          <span
                            class="tag"
                            :class="sec.tag === 'buy' ? 'tag-buy' : sec.tag === 'sell' ? 'tag-sell' : 'tag-wait'"
                          >
                            {{ sec.tagLabel }}
                          </span>
                        </div>
                        <div class="coin-desc" v-html="highlightBriefHtml(sec.body)" />
                      </div>
                    </div>
                  </template>
                </div>
                </div>
                </details>
              </div>

              <div class="disclaimer">
                {{
                  structured?.disclaimer ||
                  '以上分析由 DeepSeek 基于站内数据与网络检索生成，仅供研究参考，不构成投资建议。'
                }}
              </div>
            </div>

          </div>
        </div>
      </div>
    </Teleport>

    <el-dialog
      v-model="orderDialogVisible"
      :title="orderMode === 'pending' ? 'AI 挂单模式 · 交易所限价委托' : '按 AI 建议挂单开仓'"
      width="420px"
      append-to-body
      destroy-on-close
    >
      <div v-if="orderTarget?.leg" class="order-dlg-body">
        <p>
          {{ result?.coin }} · <strong>{{ orderTarget.leg.action }}</strong> ·
          {{ orderTarget.header }}
        </p>
        <p class="order-meta">AI 挂单价 {{ fmtStancePrice(orderTarget.leg.entry) }} · 按交易所精度委托 {{ orderPreview ? fmtStancePrice(orderPreviewPrice) : '计算中…' }}</p>
        <p v-if="orderPreview && orderDistancePct != null" class="order-meta">当前价 {{ fmtStancePrice(orderPreview.last) }} · 委托价较现价 {{ Math.abs(orderDistancePct).toFixed(2) }}% {{ orderDistancePct < 0 ? '更低' : '更高' }}</p>
        <p class="order-hint">入场单只做 Maker；盘口变化导致委托会立即成交时，交易所可能取消挂单。止盈止损触发后按市价执行。</p>
        <p v-if="orderMode === 'pending'" class="order-hint">点击确认后立即向交易所提交限价单。价格触及时可能成交，无需等待上方复合触发条件。</p>
        <p class="order-meta">杠杆 {{ orderLeverage }}x（AI 策略固定）</p>
        <p class="order-meta">
          止损 {{ fmtStancePrice(orderTarget.leg.stop) }} · 止盈
          {{ fmtStancePrice(orderTarget.leg.take_profit) }}
        </p>
        <label class="order-amount-label">保证金金额（USDT，最大 100）</label>
        <el-input v-model="orderAmount" type="number" min="1" max="100" step="1" />
        <div v-if="availableOrderExchanges.length" class="order-exchange-picker">
          <button v-for="exchange in availableOrderExchanges" :key="exchange" type="button" :class="{ selected: selectedOrderExchange === exchange }" @click="selectedOrderExchange = exchange">{{ exchange === 'binance' ? '币安' : 'OKX' }}</button>
        </div>
        <el-alert v-else type="info" :closable="false" title="请先在左下角「API 设置」配置币安或 OKX API 密钥" />
        <p v-if="orderPreviewBusy" class="order-hint">正在读取实时行情并核算订单…</p>
        <el-alert v-if="orderPreviewError" type="error" :closable="false" :title="orderPreviewError" />
        <p v-if="orderPreview" class="order-hint">预计到止损亏损 {{ Number(orderPreview.estimatedLossUsdt || 0).toFixed(2) }} USDT（未计费用与滑点）。止盈止损必须被交易所接受。</p>
      </div>
      <template #footer>
        <button type="button" class="dlg-btn ghost" @click="orderDialogVisible = false">取消</button>
        <button
          type="button"
          class="dlg-btn primary"
          :disabled="orderSubmitting || orderPreviewBusy || !orderPreview || !availableOrderExchanges.length"
          @click="confirmStanceOrder"
        >
          {{ orderSubmitting ? '挂单中…' : '确认挂单' }}
        </button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="orderProgressVisible"
      title="挂单进度"
      width="440px"
      append-to-body
      :close-on-click-modal="!orderSubmitting"
      :close-on-press-escape="!orderSubmitting"
      :show-close="!orderSubmitting"
    >
      <div class="order-progress-body">
        <div class="order-progress-bar-track">
          <div class="order-progress-bar-fill" :style="{ width: `${orderProgress}%` }" />
        </div>
        <p class="order-progress-pct">{{ Math.round(orderProgress) }}%</p>
        <ul class="order-progress-steps">
          <li
            v-for="step in orderProgressSteps"
            :key="step.id"
            class="order-progress-step"
            :class="step.status"
          >
            <span class="step-dot" />
            <div class="step-text">
              <strong>{{ step.label }}</strong>
              <span v-if="step.detail" class="step-detail">{{ step.detail }}</span>
            </div>
          </li>
        </ul>
        <p v-if="orderProgressError" class="order-progress-error">{{ orderProgressError }}</p>
        <p v-else-if="orderProgressDone" class="order-progress-ok">挂单已提交，等待成交。</p>
      </div>
      <template #footer>
        <button
          type="button"
          class="dlg-btn primary"
          :disabled="orderSubmitting"
          @click="orderProgressVisible = false"
        >
          {{ orderSubmitting ? '进行中…' : '关闭' }}
        </button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.ai-launcher {
  position: relative;
  z-index: 2;
  flex: none;
}

.ai-fab {
  height: 36px;
  padding: 0 14px;
  border: none;
  border-radius: 999px;
  color: #fff;
  font: inherit;
  font-size: 13px;
  font-weight: 750;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  background: linear-gradient(135deg, #6366f1, #a855f7, #ec4899);
  box-shadow: 0 0 12px rgba(99, 102, 241, 0.4);
  animation: ai-pulse 2s infinite;
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}

.ai-fab:hover {
  transform: translateY(-1px);
  box-shadow: 0 0 18px rgba(99, 102, 241, 0.55);
}

.ai-spark {
  font-size: 13px;
  line-height: 1;
}

@keyframes ai-pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.4);
  }
  70% {
    box-shadow: 0 0 0 10px rgba(99, 102, 241, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(99, 102, 241, 0);
  }
}

.overlay {
  position: fixed;
  inset: 0;
  z-index: 1200;
  background: rgba(0, 0, 0, 0.58);
  backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px 16px;
  box-sizing: border-box;
}

.modal {
  width: min(800px, 100%);
  height: 680px;
  max-height: min(680px, 96vh);
  background: var(--card, #15191e);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: modal-in 0.28s ease;
}

@keyframes modal-in {
  from {
    opacity: 0;
    transform: translateY(12px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.modal-header {
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  background: linear-gradient(to right, rgba(99, 102, 241, 0.14), transparent);
  flex-shrink: 0;
}

.modal-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  flex-wrap: wrap;
}

.modal-title {
  font-size: 16px;
  font-weight: 750;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
  min-width: 0;
}

.modal-title em {
  font-style: normal;
  color: var(--muted);
  font-weight: 650;
}

.header-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

.close-btn {
  background: none;
  border: none;
  color: var(--muted);
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
}

.close-btn:hover {
  color: var(--text);
}

.modal-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.pick-body {
  padding: 18px 20px 20px;
  gap: 16px;
}

.intro {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}

.block-label {
  font-size: 12px;
  font-weight: 700;
  color: var(--soft);
  margin-bottom: 8px;
}

.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.coin-chip {
  height: 32px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}

.coin-chip.active {
  border-color: transparent;
  color: #fff;
  background: linear-gradient(135deg, #6366f1, #a855f7);
}

.custom-row {
  display: flex;
  gap: 8px;
}

.custom-input {
  flex: 1;
  min-width: 0;
  height: 36px;
  padding: 0 12px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-2, #0b0e11);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  outline: none;
}

.custom-input:focus {
  border-color: color-mix(in srgb, #6366f1 60%, var(--border));
}

.ghost-btn {
  height: 36px;
  padding: 0 12px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  font-weight: 650;
  cursor: pointer;
}

.ghost-btn:hover:not(:disabled) {
  background: var(--panel-2);
}

.primary-btn {
  height: 40px;
  border: none;
  border-radius: 10px;
  color: #fff;
  font: inherit;
  font-size: 14px;
  font-weight: 750;
  cursor: pointer;
  background: linear-gradient(135deg, #6366f1, #a855f7, #ec4899);
}

.primary-btn {
  width: 100%;
  margin-top: 4px;
}

.history-block {
  margin-top: 8px;
  border-top: 1px solid var(--border);
  padding-top: 14px;
}

.history-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.history-head .block-label {
  margin-bottom: 0;
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 200px;
  overflow-y: auto;
}

.history-item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.history-item:hover {
  border-color: color-mix(in srgb, #6366f1 45%, var(--border));
}

.history-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.history-coin {
  font-weight: 800;
  font-size: 13px;
}

.history-bias,
.history-conf {
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
}

.history-expired {
  font-size: 11px;
  color: #f59e0b;
  white-space: nowrap;
}

.history-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  font-size: 11px;
  color: var(--soft);
}

.history-diff {
  flex: 1 0 100%;
  width: 100%;
  margin-top: 2px;
  font-size: 11px;
  color: var(--muted);
  line-height: 1.35;
  text-align: left;
}

.history-del {
  display: inline-flex;
  width: 18px;
  height: 18px;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 14px;
  line-height: 1;
  color: var(--muted);
}

.history-del:hover {
  color: var(--red, #f6465d);
  background: rgba(246, 70, 93, 0.12);
}

.primary-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

.muted {
  color: var(--muted);
  font-size: 12px;
}

.tiny {
  margin: 6px 0 0;
}

.err {
  margin-top: 4px;
}

.loading-state {
  align-items: center;
  justify-content: center;
  min-height: 320px;
  gap: 14px;
  color: var(--muted);
  text-align: center;
  padding: 24px;
}

.spinner {
  width: 42px;
  height: 42px;
  border: 3px solid rgba(99, 102, 241, 0.25);
  border-radius: 50%;
  border-top-color: #6366f1;
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.loading-step {
  font-size: 14px;
  color: var(--text);
  font-weight: 650;
}

.loading-sub {
  margin: 0;
  font-size: 12px;
  color: var(--soft);
}

.result-layout {
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.sentiment-sticky {
  flex-shrink: 0;
  z-index: 3;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.18);
}

.sentiment-sticky.bull {
  background: rgba(14, 203, 129, 0.12);
  border-bottom-color: rgba(14, 203, 129, 0.35);
}

.sentiment-sticky.bear {
  background: rgba(246, 70, 93, 0.12);
  border-bottom-color: rgba(246, 70, 93, 0.35);
}

.sentiment-sticky.neutral {
  background: rgba(132, 142, 156, 0.12);
  border-bottom-color: rgba(132, 142, 156, 0.28);
}

.sticky-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}

.sticky-coin {
  font-weight: 800;
  font-size: 14px;
  color: var(--text);
}

.sticky-ver {
  font-size: 11px;
  font-weight: 700;
  color: var(--muted);
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid var(--border);
}

.result-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 18px 10px;
}

.stream-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, #6366f1 35%, var(--border));
  background: color-mix(in srgb, #6366f1 10%, var(--panel-2));
  color: var(--text);
  font-size: 13px;
  font-weight: 650;
}

.stream-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #a855f7;
  box-shadow: 0 0 0 0 rgba(168, 85, 247, 0.5);
  animation: stream-pulse 1.2s ease infinite;
}

@keyframes stream-pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(168, 85, 247, 0.45);
  }
  70% {
    box-shadow: 0 0 0 8px rgba(168, 85, 247, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(168, 85, 247, 0);
  }
}

.stream-draft {
  min-height: 180px;
  border-left-color: #a855f7;
}

.caret {
  display: inline-block;
  margin-left: 2px;
  color: #a855f7;
  animation: blink 1s step-end infinite;
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}

.sentiment-box {
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--border);
  background: var(--panel-2);
}

.sentiment-box.bull {
  background: rgba(14, 203, 129, 0.1);
  border-color: rgba(14, 203, 129, 0.3);
}

.sentiment-box.bear {
  background: rgba(246, 70, 93, 0.1);
  border-color: rgba(246, 70, 93, 0.3);
}

.sentiment-box.neutral {
  background: rgba(132, 142, 156, 0.1);
  border-color: rgba(132, 142, 156, 0.25);
}

.sentiment-text {
  font-weight: 750;
  font-size: 15px;
  color: var(--text);
}

:deep(.hl-num) {
  font-weight: 800;
  color: #fbbf24;
  background: color-mix(in srgb, #f59e0b 18%, transparent);
  padding: 0 2px;
  border-radius: 3px;
}

:deep(.hl-key) {
  font-weight: 800;
  color: var(--text);
  background: color-mix(in srgb, #f59e0b 22%, transparent);
  padding: 0 3px;
  border-radius: 3px;
}

:deep(.hl-bull) {
  color: #0ecb81;
  font-weight: 750;
}

:deep(.hl-bear) {
  color: #f6465d;
  font-weight: 750;
}

:deep(.hl-neutral) {
  color: #f59e0b;
  font-weight: 700;
}

.stance-section {
  max-width: 100%;
  overflow-x: hidden;
}

.stance-row {
  display: flex;
  flex-direction: row;
  gap: 12px;
  align-items: stretch;
}

.stance-card-col {
  flex: 1;
  min-width: 0;
  background: #1e1e1e;
  border: 1px solid #333;
  border-radius: 8px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.25);
}

.stance-card-header {
  font-size: 13px;
  color: #888;
  margin-bottom: 8px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.stance-card-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.stance-icon-btn {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  border: 1px solid #3a3a3a;
  background: #2a2a2a;
  color: #c8d0da;
  font: inherit;
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
  padding: 0;
}
.stance-icon-btn:hover:not(:disabled) {
  border-color: #3b82f6;
  color: #93c5fd;
}
.stance-icon-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.stance-action-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.action-badge {
  display: inline-block;
  background: #2c3e50;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 700;
}

.action-badge.wait {
  color: #f39c12;
}

.action-badge.long {
  background: #1e3a2f;
  color: #2ecc71;
}

.action-badge.short {
  background: #3a1e1e;
  color: #e74c3c;
}

.open-order-btn {
  display: none;
}

.order-dlg-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  color: var(--text, #e6edf3);
  font-size: 14px;
}
.order-meta {
  margin: 0;
  color: var(--muted, #8b949e);
  font-size: 13px;
}
.order-amount-label {
  font-size: 13px;
  color: var(--muted, #8b949e);
}
.order-exchange-picker { display: flex; gap: 8px; }
.order-exchange-picker button { border: 1px solid var(--border); background: var(--panel-2); color: var(--muted); border-radius: 6px; padding: 6px 16px; cursor: pointer; }
.order-exchange-picker button.selected { color: var(--text); border-color: var(--accent); }
.order-hint {
  margin: 0;
  font-size: 12px;
  color: var(--muted, #8b949e);
  line-height: 1.45;
}
.order-progress-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  color: var(--text, #e6edf3);
}
.order-progress-bar-track {
  height: 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--border, #30363d) 80%, transparent);
  overflow: hidden;
}
.order-progress-bar-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #0ecb81, #6366f1);
  transition: width 0.35s ease;
}
.order-progress-pct {
  margin: 0;
  font-size: 12px;
  color: var(--muted, #8b949e);
}
.order-progress-steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.order-progress-step {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  font-size: 13px;
}
.order-progress-step .step-dot {
  width: 10px;
  height: 10px;
  margin-top: 4px;
  border-radius: 50%;
  flex: none;
  background: #484f58;
}
.order-progress-step.running .step-dot {
  background: #6366f1;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.25);
}
.order-progress-step.done .step-dot {
  background: #0ecb81;
}
.order-progress-step.error .step-dot {
  background: #f6465d;
}
.order-progress-step .step-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.order-progress-step .step-detail {
  color: var(--muted, #8b949e);
  font-size: 12px;
  line-height: 1.4;
}
.order-progress-error {
  margin: 0;
  color: #f6465d;
  font-size: 13px;
  line-height: 1.4;
}
.order-progress-ok {
  margin: 0;
  color: #0ecb81;
  font-size: 13px;
}
.dlg-btn {
  height: 34px;
  padding: 0 14px;
  border-radius: 8px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  margin-left: 8px;
}
.dlg-btn.ghost {
  border: 1px solid #2d333b;
  background: transparent;
  color: #8b9bb4;
}
.dlg-btn.primary {
  border: 0;
  background: #1f6feb;
  color: #fff;
}
.dlg-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.sl-tp-info {
  font-size: 13px;
  color: #e0e0e0;
  margin-bottom: 10px;
  padding-bottom: 10px;
  border-bottom: 1px dashed #333;
  line-height: 1.7;
}

.sl-tp-info .muted {
  color: #888;
  margin-right: 2px;
}

.sl-tp-info .value {
  font-weight: 700;
  margin-right: 6px;
  color: #e0e0e0;
}

.sl-tp-info .value.green {
  color: #2ecc71;
}

.stance-analysis {
  font-size: 13px;
  line-height: 1.65;
  color: #e0e0e0;
  margin: 0;
  flex-grow: 1;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.stance-basis {
  margin-top: 14px;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, #6366f1 35%, var(--border, #30363d));
  background: color-mix(in srgb, #6366f1 8%, transparent);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.stance-basis-label {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: #a5b4fc;
}
.stance-basis-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.stance-basis-chip {
  font-size: 13px;
  font-weight: 600;
  color: #e6edf3;
  padding: 4px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, #6366f1 18%, transparent);
  border: 1px solid color-mix(in srgb, #6366f1 40%, transparent);
}
.stance-basis-plus {
  color: #8b949e;
  font-weight: 700;
  font-size: 14px;
}

@media (max-width: 900px) {
  .stance-row {
    flex-direction: column;
  }
}

.sentiment-box.bull .sentiment-text {
  color: var(--green, #0ecb81);
}

.sentiment-box.bear .sentiment-text {
  color: var(--red, #f6465d);
}

.confidence {
  font-size: 13px;
  font-weight: 800;
  white-space: nowrap;
  letter-spacing: 0.02em;
  color: var(--muted);
}

.confidence.conf-low {
  color: #f59e0b;
  text-shadow: 0 0 12px rgba(245, 158, 11, 0.35);
}

.confidence.conf-mid {
  color: #38bdf8;
}

.confidence.conf-high {
  color: #0ecb81;
  text-shadow: 0 0 12px rgba(14, 203, 129, 0.3);
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 14px;
}

.chip {
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--muted);
  font-size: 12px;
}

.analysis-tabs-wrap {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  flex: 1;
}

.simple-result { display: flex; flex-direction: column; gap: 18px; }
.simple-event { margin: 0; padding: 10px 13px; background: var(--panel-2); border-radius: 8px; font-size: 13px; line-height: 1.5; }
.simple-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 12px; }
.simple-card { border: 1px solid var(--border); background: var(--panel); border-radius: 12px; padding: 16px; }
.simple-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.simple-card-head .long { color: #21b67a; }
.simple-card-head .short { color: #e46a68; }
.simple-prices { display: flex; flex-wrap: wrap; gap: 8px 14px; margin: 14px 0; font-size: 13px; color: var(--muted); }
.simple-prices b { color: var(--text); }
.simple-note { color: var(--muted); font-size: 13px; line-height: 1.5; min-height: 38px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.simple-order-btn { width: 100%; margin-top: 4px; }
.order-choice-row { display: flex; gap: 8px; }
.order-choice-row .simple-order-btn { flex: 1; min-width: 0; font-size: 12px; }
.entry-validation { margin: 6px 0; padding: 6px 8px; border: 1px solid var(--border); border-radius: 8px; font-size: 12px; color: var(--muted); }
.entry-validation summary { cursor: pointer; }
.entry-validation p { margin: 5px 0; line-height: 1.45; }
.quiet-analysis { color: var(--muted); padding: 28px 0; text-align: center; }
.analysis-details { border-top: 1px solid var(--border); padding-top: 12px; }
.analysis-details summary { cursor: pointer; color: var(--muted); font-size: 13px; }
.analysis-details .analysis-tabs-wrap { margin-top: 14px; }

.analysis-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-bottom: 2px;
}

.analysis-tab {
  height: 34px;
  padding: 0 14px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--muted);
  font: inherit;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  white-space: nowrap;
}

.analysis-tab:hover {
  color: var(--text);
  border-color: color-mix(in srgb, #6366f1 40%, var(--border));
}

.analysis-tab.active {
  color: #fff;
  border-color: transparent;
  background: linear-gradient(135deg, #6366f1, #a855f7);
}

.analysis-tab-panel {
  flex: 1;
  min-height: 360px;
  height: 360px;
  overflow-x: hidden;
  overflow-y: auto;
  max-width: 100%;
}

.tech-pane,
.tech-desc {
  max-width: 100%;
  overflow-x: hidden;
  word-break: break-word;
  overflow-wrap: anywhere;
  white-space: normal;
}

.tab-pane {
  animation: tab-in 0.18s ease;
}

@keyframes tab-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.analysis-section {
  margin-bottom: 16px;
}

.section-title {
  font-size: 14px;
  color: #a855f7;
  font-weight: 750;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.section-title.risk {
  color: var(--red, #f6465d);
}

.coin-analysis {
  background: var(--panel-2);
  border-radius: 8px;
  padding: 14px;
  border-left: 3px solid #6366f1;
}

.coin-analysis.tone-buy {
  border-left-color: var(--green, #0ecb81);
}

.coin-analysis.tone-sell {
  border-left-color: var(--red, #f6465d);
}

.coin-analysis.tone-wait {
  border-left-color: #a855f7;
}

.coin-analysis.risk {
  background: rgba(246, 70, 93, 0.08);
  border: 1px solid rgba(246, 70, 93, 0.28);
  border-left-width: 3px;
}

.coin-header {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  font-weight: 750;
  margin-bottom: 8px;
  font-size: 14px;
  color: var(--text);
}

.tag {
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 700;
}

.tag-buy {
  background: rgba(14, 203, 129, 0.18);
  color: var(--green, #0ecb81);
}

.tag-sell {
  background: rgba(246, 70, 93, 0.18);
  color: var(--red, #f6465d);
}

.tag-wait {
  background: rgba(132, 142, 156, 0.18);
  color: var(--muted);
}

.coin-desc {
  font-size: 14px;
  color: var(--muted);
  line-height: 1.7;
  white-space: pre-wrap;
}

.coin-desc p {
  margin: 0 0 10px;
}

.coin-desc p:last-child {
  margin-bottom: 0;
}

.bullet-list {
  margin: 0;
  padding-left: 18px;
  color: var(--muted);
  font-size: 14px;
  line-height: 1.7;
}

.bullet-list li + li {
  margin-top: 6px;
}

.coin-analysis.risk .coin-desc {
  color: #ffb3c1;
}

.disclaimer {
  margin: 4px 0 10px;
  font-size: 13px;
  color: var(--soft);
  text-align: center;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}

.ghost-sm {
  height: 28px;
  padding: 0 10px;
  font-size: 12px;
  border-radius: 8px;
}

@media (max-width: 640px) {
  .modal {
    height: min(680px, 94vh);
    max-height: 94vh;
    width: 100%;
  }
}
</style>
