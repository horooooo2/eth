<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  streamChatMarketBrief,
  fetchMarketBriefAnalysis,
  streamMarketBrief,
  streamOkxStanceOrder,
  type MarketBriefResponse,
  type MarketBriefStructured,
  type MarketChatMessage,
  type OkxStanceOrderStage,
} from '@/api';
import { preferredCoinsState, normalizeCoinId } from '@/utils/watchedCoins';
import {
  briefHistoryState,
  pushBriefHistory,
  updateBriefHistoryMessages,
  removeBriefHistory,
  clearBriefHistory,
  formatBriefTime,
  isBriefHistoryFresh,
  type MarketBriefHistoryItem,
} from '@/utils/briefHistory';
import { aiKeyReady } from '@/stores/aiKey';
import { formatPrice } from '@/utils/format';
import { highlightBriefHtml, highlightNumbersHtml } from '@/utils/briefHighlight';
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

const REANALYZE_RE =
  /重新分析|再分析|重新诊币|刷新分析|更新分析|重新生成|再生成|重新解读|再解读|重新跑|再跑一遍/;

const open = ref(false);
const phase = ref<Phase>('pick');
const coin = ref(preferredCoinsState.value[0] || 'BTC');
const customCoin = ref('');
const loading = ref(false);
const chatBusy = ref(false);
const error = ref('');
const result = ref<MarketBriefResponse | null>(null);
const streamDraft = ref('');
const statusMessage = ref('');
const chatInput = ref('');
const chatMessages = ref<MarketChatMessage[]>([]);
const loadingStepIdx = ref(0);
const chatListRef = ref<HTMLElement | null>(null);
const streamScrollRef = ref<HTMLElement | null>(null);
const analysisTab = ref('short');
const techTf = ref<'5m' | '1h' | '1d'>('1d');

let reqSeq = 0;
let stepTimer: ReturnType<typeof setInterval> | null = null;
let abortCtrl: AbortController | null = null;
let chatAbortCtrl: AbortController | null = null;

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

const stanceBasis = computed(() => {
  const raw: unknown = personalStance.value?.basis;
  if (Array.isArray(raw) && raw.length) {
    return raw.map((s) => String(s || '').trim()).filter(Boolean);
  }
  if (typeof raw === 'string' && raw.trim()) {
    return raw
      .split(/[+＋、,，/|｜]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // 旧结果兜底：按已有模块文案推断
  const s = structured.value;
  const items: string[] = [];
  if (s?.market_sentiment?.details || s?.market_sentiment?.funding_rate || s?.market_sentiment?.long_short_ratio) {
    items.push('市场情绪');
  }
  if (s?.news_analysis?.details || s?.news_analysis?.sentiment) items.push('新闻内容');
  if (s?.technical?.hourly) items.push('小时线走势');
  else if (s?.technical?.m5) items.push('5分钟走势');
  if (s?.technical?.daily) items.push('日线走势');
  if (s?.whales?.site || s?.whales?.external || s?.whales?.details) items.push('巨鲸仓位');
  if (s?.derivatives?.funding) items.push('资金费率');
  if (s?.derivatives?.liquidations) items.push('爆仓数据');
  return items.length ? items : ['市场情绪', '新闻内容', '小时线走势'];
});

const stanceCards = computed(() => {
  const ps = personalStance.value;
  return [
    { id: 'ultra_short', header: '超短线 (5分钟)', leg: ps?.ultra_short },
    { id: 'short', header: '短期', leg: ps?.short },
    { id: 'mid_long', header: '中长期', leg: ps?.mid_long },
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
    tabs.push({ id: 'stance', label: '仓位建议' });
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

const orderDialogVisible = ref(false);
const orderAmount = ref('10');
const orderSubmitting = ref(false);
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
  leg: NonNullable<MarketBriefStructured['personal_stance']>['ultra_short'];
} | null>(null);

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

function openOrderDialog(card: {
  id: string;
  header: string;
  leg: NonNullable<MarketBriefStructured['personal_stance']>['ultra_short'];
}) {
  if (isWaitAction(card.leg?.action)) {
    ElMessage.warning('当前仍为观望，请点顶部「重新分析」生成做多/做空方案');
    return;
  }
  if (card.leg?.entry == null || card.leg?.stop == null || card.leg?.take_profit == null) {
    ElMessage.warning('缺少开仓/止损/止盈价，请先刷新该周期建议');
    return;
  }
  orderTarget.value = card;
  orderAmount.value = '10';
  orderDialogVisible.value = true;
}

async function confirmStanceOrder() {
  const card = orderTarget.value;
  const coin = result.value?.coin;
  if (!card?.leg || !coin) return;
  const amount = Number(orderAmount.value);
  if (!(amount > 0) || amount > 100) {
    ElMessage.warning('请输入 0~100 的 USDT 金额');
    return;
  }
  const isLong = /做多|^long$|^buy$/i.test(String(card.leg.action));
  try {
    await ElMessageBox.confirm(
      `将以限价 Maker 挂单（非市价），降低手续费。\n币种 ${coin} · ${card.leg.action}\n参考开仓 ${fmtStancePrice(card.leg.entry)} · 杠杆 ${card.leg.leverage ?? '—'}x\n止损 ${fmtStancePrice(card.leg.stop)} · 止盈 ${fmtStancePrice(card.leg.take_profit)}\n保证金 ${amount} USDT\n挂单逻辑：先取最新价，再${isLong ? '低于现价挂买单' : '高于现价挂卖单'}，并附带止损止盈。`,
      '确认挂单开仓',
      { type: 'warning', confirmButtonText: '开始挂单', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }

  orderDialogVisible.value = false;
  resetOrderProgress();
  orderProgressVisible.value = true;
  orderSubmitting.value = true;

  try {
    await streamOkxStanceOrder(
      {
        coin,
        action: String(card.leg.action),
        entry: Number(card.leg.entry),
        stop: Number(card.leg.stop),
        takeProfit: Number(card.leg.take_profit),
        leverage: Number(card.leg.leverage) || 5,
        amountUsd: amount,
      },
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

function saveHistory(data: MarketBriefResponse, messages: MarketChatMessage[] = []) {
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
    // 新诊币默认清空旧聊天；若显式传入则保留
    messages,
  });
}

function persistChatMessages() {
  const c = result.value?.coin || coin.value;
  if (!c) return;
  updateBriefHistoryMessages(c, chatMessages.value);
}

function openHistory(item: MarketBriefHistoryItem) {
  coin.value = item.coin;
  customCoin.value = '';
  streamDraft.value = '';
  error.value = '';

  if (!isBriefHistoryFresh(item)) {
    chatMessages.value = [];
    ElMessage.info(`${item.coin} 历史已超过 1 小时，正在重新分析…`);
    phase.value = 'loading';
    void runBrief();
    return;
  }

  chatMessages.value = Array.isArray(item.messages) ? [...item.messages] : [];
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
  void scrollChat();
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

const summaryBits = computed(() => {
  const bits: string[] = [];
  if (result.value?.version) bits.push(result.value.version);
  if (result.value?.contextDiff?.summary) bits.push(result.value.contextDiff.summary);
  const s = result.value?.contextSummary;
  if (!s) return bits;
  if (s.price != null) bits.push(`现价 ${formatPrice(s.price)}`);
  if (s.fundingPct != null) bits.push(`费率 ${s.fundingPct}%`);
  if (s.hasTech) bits.push('含技术面');
  if (s.hasLiq) bits.push(`爆仓 $${Math.round(s.liqTotalUsd || 0)}`);
  bits.push(`站内新闻 ${s.newsCount}`);
  if (s.webNewsCount) bits.push(`网络新闻 ${s.webNewsCount}`);
  bits.push(`巨鲸 多${s.whaleLong}/空${s.whaleShort}`);
  if (s.exchangeLongPct != null && s.exchangeShortPct != null) {
    bits.push(`账户多/空 ${s.exchangeLongPct}%/${s.exchangeShortPct}%`);
  }
  bits.push(`异动 ${s.alertCount}`);
  if (s.hasDefi) bits.push('含链上沉淀');
  if (s.equityLike) bits.push('公司类标的');
  if (s.cached) bits.push('缓存命中');
  return bits;
});

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
  chatAbortCtrl?.abort();
  chatAbortCtrl = null;
  chatBusy.value = false;
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
  statusMessage.value = '正在准备数据（强制开单）…';
  chatMessages.value = [];
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
        statusMessage.value = 'DeepSeek 正在撰写…';
      },
      onDelta: (text) => {
        if (seq !== reqSeq || !text) return;
        streamDraft.value += text;
        if (result.value) {
          result.value = {
            ...result.value,
            analysis: streamDraft.value,
            structured: null,
            analysisResult: null,
          };
        }
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
    if (streamDraft.value && result.value) {
      result.value = {
        ...result.value,
        analysis: streamDraft.value,
      };
      phase.value = 'result';
    } else {
      phase.value = 'pick';
    }
  } finally {
    if (seq === reqSeq) {
      loading.value = false;
      stopLoadingSteps();
      abortCtrl = null;
    }
  }
}

async function scrollChat() {
  await nextTick();
  const el = chatListRef.value;
  if (el) el.scrollTop = el.scrollHeight;
}

async function sendChat() {
  const text = chatInput.value.trim();
  if (!text || chatBusy.value || loading.value || !result.value) return;
  if (!aiKeyReady.value) {
    ElMessage.warning('请先配置 DeepSeek API Key');
    return;
  }
  if (REANALYZE_RE.test(text)) {
    chatInput.value = '';
    ElMessage.info('正在重新拉取关键数据并生成新版本分析…');
    await runBrief();
    return;
  }
  chatInput.value = '';
  chatMessages.value.push({ role: 'user', content: text });
  chatMessages.value.push({ role: 'assistant', content: '' });
  const assistantIdx = chatMessages.value.length - 1;
  await scrollChat();
  chatBusy.value = true;
  chatAbortCtrl?.abort();
  chatAbortCtrl = new AbortController();
  const history = chatMessages.value.slice(0, -2);
  try {
    await streamChatMarketBrief(
      {
        coin: result.value.coin,
        message: text,
        analysis: result.value.analysis,
        contextText: result.value.contextText,
        messages: history,
      },
      {
        signal: chatAbortCtrl.signal,
        onDelta: (chunk) => {
          const cur = chatMessages.value[assistantIdx];
          if (!cur || cur.role !== 'assistant') return;
          chatMessages.value[assistantIdx] = {
            role: 'assistant',
            content: (cur.content || '') + chunk,
          };
          void scrollChat();
        },
        onDone: (data) => {
          const finalText = String(data.reply || chatMessages.value[assistantIdx]?.content || '').trim();
          chatMessages.value[assistantIdx] = {
            role: 'assistant',
            content: finalText || '（无回复）',
          };
          persistChatMessages();
          void scrollChat();
        },
      },
    );
    persistChatMessages();
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return;
    chatMessages.value.splice(assistantIdx, 1);
    chatMessages.value.pop();
    chatInput.value = text;
    ElMessage.error(err instanceof Error ? err.message : '对话失败');
  } finally {
    chatBusy.value = false;
    chatAbortCtrl = null;
  }
}

function backToPick() {
  phase.value = 'pick';
  error.value = '';
  chatAbortCtrl?.abort();
  chatAbortCtrl = null;
}

onUnmounted(() => {
  stopLoadingSteps();
  abortCtrl?.abort();
  chatAbortCtrl?.abort();
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
                  :disabled="loading || chatBusy || phase === 'streaming'"
                  @click="() => runBrief()"
                >
                  重新分析
                </button>
                <button type="button" class="ghost-btn ghost-sm" :disabled="loading || chatBusy" @click="backToPick">
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
                <span class="sentiment-text" v-html="highlightBriefHtml(sentiment.label)" />
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
                {{ statusMessage || 'DeepSeek 正在撰写…' }}
              </div>

              <div v-if="summaryBits.length" class="meta">
                <span
                  v-for="bit in summaryBits"
                  :key="bit"
                  class="chip"
                  v-html="highlightNumbersHtml(bit)"
                />
              </div>

              <!-- 流式草稿：边生成边显示 -->
              <div v-if="phase === 'streaming'" class="stream-draft coin-analysis">
                <div class="coin-desc" v-html="highlightBriefHtml(streamDraft || '…')" />
                <span class="caret">▍</span>
              </div>

              <!-- JSON / Markdown：Tab 切换 -->
              <div v-else-if="structured || sections.length" class="analysis-tabs-wrap">
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

                    <div v-show="analysisTab === 'stance'" class="tab-pane stance-section">
                      <div class="stance-row">
                        <div v-for="card in stanceCards" :key="card.id" class="stance-card-col">
                          <div class="stance-card-header">
                            <span>{{ card.header }}</span>
                            <div class="stance-card-actions">
                              <button
                                type="button"
                                class="stance-icon-btn"
                                title="限价挂单开仓"
                                :disabled="loading || chatBusy"
                                @click="openOrderDialog(card)"
                              >
                                $
                              </button>
                            </div>
                          </div>
                          <div class="stance-action-row">
                            <span class="action-badge" :class="stanceActionClass(card.leg?.action)">
                              {{ card.leg?.action || '观望' }}
                            </span>
                          </div>
                          <div class="sl-tp-info">
                            <span class="muted">开仓</span>
                            <span class="value">{{ fmtStancePrice(card.leg?.entry) }}</span>
                            <span class="muted">·</span>
                            <span class="muted">杠杆</span>
                            <span class="value">{{ card.leg?.leverage != null ? `${card.leg.leverage}x` : '—' }}</span>
                            <br />
                            <span class="muted">止损</span>
                            <span class="value" :class="{ green: card.leg?.stop != null }">
                              {{ fmtStancePrice(card.leg?.stop) }}
                            </span>
                            <span class="muted">·</span>
                            <span class="muted">止盈</span>
                            <span class="value" :class="{ green: card.leg?.take_profit != null }">
                              {{ fmtStancePrice(card.leg?.take_profit) }}
                            </span>
                          </div>
                          <p
                            class="stance-analysis"
                            v-html="highlightBriefHtml(card.leg?.note || '暂无说明')"
                          />
                        </div>
                      </div>
                      <div class="stance-basis">
                        <span class="stance-basis-label">分析依据</span>
                        <div class="stance-basis-chips">
                          <template v-for="(item, idx) in stanceBasis" :key="item">
                            <span v-if="idx > 0" class="stance-basis-plus">+</span>
                            <span class="stance-basis-chip">{{ item }}</span>
                          </template>
                        </div>
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

              <div class="disclaimer">
                {{
                  structured?.disclaimer ||
                  '以上分析由 DeepSeek 基于站内数据与网络检索生成，仅供研究参考，不构成投资建议。'
                }}
              </div>
            </div>

            <div v-if="phase === 'result'" class="chat-panel">
              <div class="chat-toolbar">
                <div class="chat-label">与 AI 继续探讨</div>
              </div>
              <div ref="chatListRef" class="chat-list">
                <div v-if="!chatMessages.length" class="chat-empty">
                  例如：这个止损合理吗？也可点顶部「重新分析」刷新简报。
                </div>
                <div
                  v-for="(m, idx) in chatMessages"
                  :key="idx"
                  class="chat-bubble"
                  :class="[m.role, { pending: chatBusy && idx === chatMessages.length - 1 && m.role === 'assistant' && !m.content }]"
                >
                  <template v-if="m.content">{{ m.content }}</template>
                  <template v-else-if="chatBusy && m.role === 'assistant'">思考中…</template>
                </div>
              </div>
              <div class="chat-input-row">
                <input
                  v-model="chatInput"
                  class="chat-input"
                  placeholder="输入问题，或说「重新分析」"
                  :disabled="chatBusy || loading"
                  maxlength="500"
                  @keydown.enter.prevent="sendChat"
                />
                <button
                  type="button"
                  class="send-btn"
                  :disabled="chatBusy || loading || !chatInput.trim()"
                  @click="sendChat"
                >
                  发送
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <el-dialog
      v-model="orderDialogVisible"
      title="按 AI 建议挂单开仓"
      width="420px"
      append-to-body
      destroy-on-close
    >
      <div v-if="orderTarget?.leg" class="order-dlg-body">
        <p>
          {{ result?.coin }} · <strong>{{ orderTarget.leg.action }}</strong> ·
          {{ orderTarget.header }}
        </p>
        <p class="order-meta">
          参考开仓 {{ fmtStancePrice(orderTarget.leg.entry) }} · 杠杆
          {{ orderTarget.leg.leverage != null ? `${orderTarget.leg.leverage}x` : '—' }}
        </p>
        <p class="order-meta">
          止损 {{ fmtStancePrice(orderTarget.leg.stop) }} · 止盈
          {{ fmtStancePrice(orderTarget.leg.take_profit) }}
        </p>
        <label class="order-amount-label">保证金金额（USDT，最大 100）</label>
        <el-input v-model="orderAmount" type="number" min="1" max="100" step="1" />
        <p class="order-hint">
          使用限价 Maker 挂单（非市价）：先取最新价，做多低于现价 / 做空高于现价挂单，并附带 AI
          止损止盈。需先在侧栏「API 设置」配置 OKX 密钥。
        </p>
      </div>
      <template #footer>
        <button type="button" class="dlg-btn ghost" @click="orderDialogVisible = false">取消</button>
        <button
          type="button"
          class="dlg-btn primary"
          :disabled="orderSubmitting"
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
  width: min(1120px, 100%);
  height: 1000px;
  max-height: min(1000px, 96vh);
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

.custom-input,
.chat-input {
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

.custom-input:focus,
.chat-input:focus {
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

.primary-btn,
.send-btn {
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

.primary-btn:disabled,
.send-btn:disabled {
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

.chat-panel {
  flex-shrink: 0;
  border-top: 1px solid var(--border);
  background: color-mix(in srgb, var(--card) 88%, #6366f1 6%);
  padding: 10px 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: min(42vh, 420px);
  min-height: 280px;
}

.chat-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.chat-label {
  font-size: 12px;
  font-weight: 700;
  color: var(--soft);
}

.ghost-sm {
  height: 28px;
  padding: 0 10px;
  font-size: 12px;
  border-radius: 8px;
}

.chat-list {
  flex: 1;
  min-height: 160px;
  max-height: none;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-right: 2px;
}

.chat-empty {
  font-size: 12px;
  color: var(--soft);
  padding: 8px 2px;
}

.chat-bubble {
  max-width: 92%;
  padding: 8px 10px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.chat-bubble.user {
  align-self: flex-end;
  background: color-mix(in srgb, #6366f1 35%, var(--panel));
  color: var(--text);
}

.chat-bubble.assistant {
  align-self: flex-start;
  background: var(--panel-2);
  border: 1px solid var(--border);
  color: var(--muted);
}

.chat-bubble.pending {
  opacity: 0.75;
  font-style: italic;
}

.chat-input-row {
  display: flex;
  gap: 8px;
}

.send-btn {
  flex: 0 0 auto;
  width: 72px;
  height: 36px;
}

@media (max-width: 640px) {
  .modal {
    height: min(1000px, 94vh);
    max-height: 94vh;
    width: 100%;
  }
  .chat-panel {
    max-height: 220px;
  }
}
</style>
