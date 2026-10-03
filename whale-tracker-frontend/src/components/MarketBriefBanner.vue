<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import {
  fetchMarketBriefAnalysis,
  streamMarketBrief,
  type MarketBriefResponse,
  type MarketBriefStructured,
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
const techTf = ref<'5m' | '1h' | '1d'>('1d');

let reqSeq = 0;
let stepTimer: ReturnType<typeof setInterval> | null = null;
let abortCtrl: AbortController | null = null;

const preferredCoins = computed(() => preferredCoinsState.value);
const historyList = computed(() => briefHistoryState.value);
const streamProgressSections = computed(() => {
  const text = streamDraft.value;
  if (!text.trim()) return [];
  const matches: Array<{ label: string; text: string }> = [];
  const labels: Record<string, string> = {
    summary: '综合摘要',
    analysis: '方向分析',
    observation: '市场观察',
    focus: '关注条件',
    limitation: '数据限制',
  };
  const pattern = /"(summary|analysis|observation|focus|limitation)"\s*:\s*"((?:\\.|[^"\\])*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const key = match[1];
    const encoded = match[2];
    let value = '';
    try {
      value = JSON.parse(`"${encoded}"`);
    } catch {
      value = encoded.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    value = value.trim();
    if (value) matches.push({ label: labels[key], text: value });
  }
  if (matches.length) return matches.slice(-8);
  // 兼容流式服务回退到非 JSON 文本的情况。
  if (!text.trimStart().startsWith('{')) return [{ label: 'AI 实时输出', text: text.trim() }];
  return [];
});

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

const chartPacks = computed(() => {
  const c = result.value?.contextSummary?.charts;
  return {
    m5: c?.m5 || null,
    hour: c?.hour || null,
    day: c?.day || null,
  };
});

const directionAssessment = computed(() => result.value?.directionAssessment || null);
const directionAnalysis = computed(() => structured.value?.direction_analysis || null);
const horizonCards = computed(() => {
  const h = directionAssessment.value?.horizons;
  if (!h) return [];
  const ai = directionAnalysis.value?.horizons || {};
  return [
    { id: 'ultra_short', label: '超短线', period: '5分钟级', value: h.ultra_short, analysis: ai.ultra_short },
    { id: 'short_term', label: '短线', period: '小时级', value: h.short_term, analysis: ai.short_term },
    { id: 'medium_long', label: '中长期', period: '日线级', value: h.medium_long, analysis: ai.medium_long },
  ].filter((x) => x.value);
});
const aiModuleCards = computed(() => {
  const modules = directionAnalysis.value?.module_analysis || {};
  const quality = directionAssessment.value?.modules || {};
  const labels: Record<string, string> = { technical: '技术结构', derivatives: '衍生品仓位', flow: '主动买卖', whales: '巨鲸观测', news: '新闻事件', cross: '跨市场' };
  return Object.entries(labels).map(([id, label]) => ({ id, label, analysis: modules[id], quality: quality[id]?.quality ?? 0 }));
});
const timeframeCards = computed(() => {
  const rows = directionAnalysis.value?.timeframes || {};
  const labels: Record<string, string> = { m5: '5分钟', hour: '1小时', day: '日线' };
  return Object.entries(labels).map(([id, label]) => ({ id, label, ...rows[id] }));
});

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
    directionAssessment: data.directionAssessment || null,
    contextSummary: data.contextSummary,
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
    directionAssessment: item.directionAssessment || null,
    analysisId: item.analysisId,
    contextSnapshotId: item.contextSnapshotId,
    version: item.version,
    contextDiff: item.contextDiffSummary
      ? { changed: true, summary: item.contextDiffSummary }
      : null,
    contextText: '',
    contextSummary: item.contextSummary,
  };
  phase.value = 'result';
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
          directionAssessment: meta.directionAssessment,
        };
        stopLoadingSteps();
        phase.value = 'streaming';
        statusMessage.value = '正在生成分析内容…';
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
    error.value = err instanceof Error ? err.message : '生成方向分析失败';
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
                AI 深度诊币 · 市场方向研判
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
            <div ref="streamScrollRef" class="result-scroll">
              <div v-if="phase === 'streaming'" class="stream-banner">
                <span class="stream-dot" />
                正在接收 AI 分析过程，生成结束后自动展开完整研判页面…
              </div>

              <section v-if="phase === 'streaming'" class="streaming-analysis" aria-live="polite" aria-label="AI 流式分析过程">
                <div v-if="streamProgressSections.length" class="streaming-sections">
                  <article v-for="(section, index) in streamProgressSections" :key="`${section.label}-${index}`" class="streaming-section">
                    <strong>{{ section.label }}</strong>
                    <p>{{ section.text }}<span v-if="index === streamProgressSections.length - 1" class="stream-cursor" aria-hidden="true">▍</span></p>
                  </article>
                </div>
                <div v-else class="stream-waiting"><span class="spinner small" />{{ statusMessage || 'AI 正在组织方向依据与风险说明…' }}</div>
              </section>

              <div v-else-if="structured || sections.length" class="research-dashboard">
                <section class="dashboard-hero">
                  <article class="panel hero-main">
                    <div class="coin-row">
                      <div class="coin-left"><div class="coin-logo">{{ coin.slice(0, 1) }}</div><div><div class="coin-name">{{ coin }} 市场研判</div><div class="coin-symbol">{{ coin }} · 多周期方向与市场信息</div></div></div>
                      <div><div class="price">{{ result?.contextSummary?.price ? formatPrice(result.contextSummary.price) : '价格暂无' }}</div><div class="change">24h {{ result?.contextSummary?.change24hPct == null ? '—' : `${result.contextSummary.change24hPct}%` }}</div></div>
                    </div>
                    <div class="meta-strip">
                      <span class="chip" :class="result?.contextSummary?.hasTech ? 'good' : 'warn'">{{ result?.contextSummary?.hasTech ? 'K线数据可用' : 'K线数据不足' }}</span>
                      <span class="chip">新闻 {{ result?.contextSummary?.newsCount ?? 0 }} 条</span>
                      <span class="chip">巨鲸多/空 {{ result?.contextSummary?.whaleLong ?? 0 }}/{{ result?.contextSummary?.whaleShort ?? 0 }}</span>
                      <span class="chip" :class="directionAssessment?.regime ? 'good' : 'warn'">{{ directionAssessment?.regime || '市场状态待确认' }}</span>
                      <span class="chip">更新于 {{ directionAssessment?.asOf ? new Date(directionAssessment.asOf).toLocaleString() : '—' }}</span>
                    </div>
                    <div class="summary-box">
                      <div><h3>AI 市场摘要</h3><p>{{ directionAnalysis?.summary || 'AI 尚未生成本周期的综合摘要。' }}</p></div>
                      <div class="state-block"><div class="state-label">程序方向 · 短线</div><div class="state-value">{{ directionAssessment?.horizons?.short_term?.direction === 'DATA_INSUFFICIENT' ? '数据不足' : directionAssessment?.horizons?.short_term?.direction || '评估中' }}</div><div class="state-sub">AI 解释不改变程序评估</div></div>
                    </div>
                  </article>
                  <article class="panel quality">
                    <div><div class="panel-title">数据覆盖与信心</div><div class="panel-sub">信心由覆盖率与有效模块方向一致性计算</div></div>
                    <div class="quality-main"><div class="ring" :style="{ '--quality': `${directionAssessment?.horizons?.short_term?.confidence || 0}%` }"><b>{{ directionAssessment?.horizons?.short_term?.confidence ?? 0 }}<small>%</small></b></div><div class="quality-info"><strong>短线信心度</strong><p>覆盖率 {{ Math.round((directionAssessment?.horizons?.short_term?.coverage || 0) * 100) }}%。低覆盖时系统标记数据不足。</p></div></div>
                    <div class="mini-bars"><div v-for="(item, key) in directionAssessment?.modules || {}" :key="key" class="mini-bar"><span>{{ key }}</span><div class="track"><div class="fill" :style="{ width: `${Math.round((item.quality || 0) * 100)}%` }" /></div><b>{{ Math.round((item.quality || 0) * 100) }}</b></div></div>
                  </article>
                </section>

                <div class="section-title-row"><div><h2>多周期方向</h2><p>评分范围 −1 至 +1；方向阈值固定，数据不足不降级为中性。</p></div><span class="asof">{{ directionAssessment?.version || 'Direction Engine' }}</span></div>
                <section class="direction-grid">
                  <article v-for="card in horizonCards" :key="card.id" class="panel direction-card" :class="biasClass(card.value?.direction)">
                    <div class="dir-head"><div><small>{{ card.period }}</small><h3>{{ card.label }}</h3></div><span class="dir-badge" :class="biasClass(card.value?.direction)">{{ card.value?.direction === 'DATA_INSUFFICIENT' ? '数据不足' : card.value?.direction }}</span></div>
                    <div class="score-row"><div class="score">{{ Number(card.value?.score || 0).toFixed(2) }}<span>/ 1</span></div><div class="confidence"><b>{{ card.value?.confidence ?? 0 }}%</b><small>信心 · 覆盖 {{ Math.round((card.value?.coverage || 0) * 100) }}%</small></div></div>
                    <div class="axis"><i class="marker" :style="{ left: `${Math.max(0, Math.min(100, ((card.value?.score || 0) + 1) * 50))}%` }" /></div><div class="axis-labels"><span>偏空</span><span>中性</span><span>偏多</span></div>
                    <div class="horizon-ai-analysis"><p>{{ card.analysis?.analysis || 'AI 尚未提供该周期的具体分析。' }}</p><div class="horizon-points"><div><b>支持</b><span>{{ card.analysis?.bull_points?.join('；') || '暂无明确支持项' }}</span></div><div><b>反向</b><span>{{ card.analysis?.bear_points?.join('；') || '暂无明确反向项' }}</span></div></div><small>关注：{{ card.analysis?.focus || '暂无后续观察条件' }}</small></div>
                  </article>
                </section>

                <section class="two-col">
                  <article class="panel structure"><div class="panel-title">价格结构与周期信号</div><div class="panel-sub">程序指标与 AI 逐周期解读，图表周期可切换</div><BriefKlineChart v-model="techTf" :m5="chartPacks.m5" :hour="chartPacks.hour" :day="chartPacks.day" /><div class="timeframe-analysis-grid"><div v-for="tf in timeframeCards" :key="tf.id" class="timeframe-analysis"><strong>{{ tf.label }}</strong><span>{{ tf.status || tf.state || '数据不足' }}</span><p>{{ tf.analysis || '该周期暂无可用解读。' }}</p><small v-for="(metric, idx) in tf.metrics || []" :key="idx">{{ metric }}</small></div></div></article>
                  <article class="panel regime"><div class="panel-title">市场状态</div><div class="panel-sub">AI 对趋势、波动与结构阶段的解读，数值仍以原始数据为准</div><div class="regime-grid"><div class="regime-item"><span>趋势</span><b class="info">{{ directionAnalysis?.market_state?.trend || directionAssessment?.regime || '数据不足' }}</b></div><div class="regime-item"><span>波动</span><b>{{ directionAnalysis?.market_state?.volatility || '数据不足' }}</b></div><div class="regime-item"><span>结构</span><b>{{ directionAnalysis?.market_state?.structure || '数据不足' }}</b></div><div class="regime-item"><span>阶段</span><b>{{ directionAnalysis?.market_state?.phase || '数据不足' }}</b></div><div class="regime-item regime-wide"><span>观察</span><b>{{ directionAnalysis?.market_state?.observation || '等待 AI 根据数据填写市场状态分析。' }}</b></div><div class="regime-item"><span>资金费率</span><b>{{ result?.contextSummary?.fundingPct == null ? '暂无' : `${result.contextSummary.fundingPct}%` }}</b></div><div class="regime-item"><span>交易所多空</span><b>{{ result?.contextSummary?.exchangeLongPct == null ? '暂无' : `${result.contextSummary.exchangeLongPct}% 多` }}</b></div><div class="regime-item"><span>新闻 / 宏观</span><b>{{ (result?.contextSummary?.newsCount ?? 0) + (result?.contextSummary?.webNewsCount ?? 0) }} / {{ result?.contextSummary?.macroCount ?? 0 }} 条</b></div></div></article>
                </section>

                <section class="panel evidence-panel"><div class="panel-title">多空证据与关键观察</div><div class="panel-sub">AI 需分别列出支持和反对当前方向的事实，避免只给单边结论</div><div class="evidence-list"><div class="evidence-item bias-evidence bull-evidence"><span class="ev-num">多</span><div><strong>看多依据</strong><ul><li v-for="(item, idx) in directionAnalysis?.bull_evidence || []" :key="idx">{{ item }}</li></ul><p v-if="!directionAnalysis?.bull_evidence?.length">当前没有足够的明确看多证据。</p></div></div><div class="evidence-item bias-evidence bear-evidence"><span class="ev-num">空</span><div><strong>看空依据</strong><ul><li v-for="(item, idx) in directionAnalysis?.bear_evidence || []" :key="idx">{{ item }}</li></ul><p v-if="!directionAnalysis?.bear_evidence?.length">当前没有足够的明确看空证据。</p></div></div></div></section>

                <div class="section-title-row"><div><h2>分析模块</h2><p>每项展示 AI 对真实输入数据的具体解读与数据限制</p></div></div>
                <section class="module-grid"><article v-for="module in aiModuleCards" :key="module.id" class="panel module-card"><div class="module-head"><div class="module-title"><span class="mod-ico">{{ module.quality > 0 ? '●' : '—' }}</span><div><strong>{{ module.label }}</strong><small>数据质量 {{ Math.round(module.quality * 100) }}%</small></div></div><span class="status-pill" :class="module.quality > 0 ? '' : 'warn'">{{ module.analysis?.status || (module.quality > 0 ? '可用' : '数据不足') }}</span></div><div class="module-desc module-summary">{{ module.analysis?.summary || 'AI 未返回该模块的具体分析。' }}</div><ul v-if="module.analysis?.facts?.length" class="module-facts"><li v-for="(fact, idx) in module.analysis.facts" :key="idx">{{ fact }}</li></ul><div v-if="module.analysis?.limitation" class="module-limitation">限制：{{ module.analysis.limitation }}</div></article></section>

                <section class="risk-grid"><article class="panel info-card"><h3>不确定性与数据限制</h3><div class="callout">{{ directionAssessment?.note || '方向分数是研究用指标，存在数据滞后、口径差异和快速变化风险。' }}</div><ul class="risk-list"><li v-for="(item, idx) in directionAnalysis?.data_limitations || []" :key="`d-${idx}`">{{ item }}</li><li v-for="(item, idx) in structured?.risks_and_invalidation || []" :key="`r-${idx}`">{{ item }}</li><li>本页面用于市场方向研判，不提供交易执行建议。</li></ul></article><article class="panel info-card"><h3>中长期方向解读</h3><p>{{ directionAnalysis?.horizons?.medium_long?.analysis || '暂无中长期方向解读。' }}</p><div class="focus-callout">关注：{{ directionAnalysis?.horizons?.medium_long?.focus || '暂无' }}</div></article></section>
              </div>

              <div v-else-if="phase === 'result'" class="panel empty-analysis"><strong>本次分析暂未生成结构化结果</strong><p>{{ result?.analysis || '请尝试重新分析。' }}</p></div>
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
  background: rgba(3, 8, 17, 0.84);
  backdrop-filter: blur(10px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  box-sizing: border-box;
}

.modal {
  width: min(1560px, calc(100vw - 32px));
  height: min(1040px, calc(100dvh - 32px));
  max-height: calc(100dvh - 32px);
  background: #08111f;
  color: #eef4ff;
  border: 1px solid #20314b;
  border-radius: 20px;
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
  background: radial-gradient(ellipse at 0 0, rgba(49, 214, 214, 0.12), transparent 50%), #0b1628;
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

.streaming-analysis { min-height: 220px; padding: 8px 2px 28px; }
.streaming-sections { display: grid; gap: 12px; }
.streaming-section { padding: 14px 16px; border: 1px solid var(--border); border-radius: 10px; background: var(--panel-2); }
.streaming-section strong { color: var(--accent, #a5b4fc); font-size: 12px; }
.streaming-section p { margin: 8px 0 0; color: var(--text); font-size: 13px; line-height: 1.75; white-space: pre-wrap; overflow-wrap: anywhere; }
.stream-waiting { display: flex; align-items: center; justify-content: center; gap: 10px; min-height: 170px; color: var(--muted); font-size: 13px; }
.spinner.small { width: 20px; height: 20px; border-width: 2px; }
.stream-cursor { color: #a5b4fc; animation: stream-cursor-blink 1s step-end infinite; }
@keyframes stream-cursor-blink { 50% { opacity: 0; } }

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
    height: 100dvh;
    max-height: 100dvh;
    width: 100vw;
    border-radius: 0;
  }
}

.direction-dashboard { display: grid; gap: 16px; color: #eef4ff; }
.direction-topline { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:20px 22px; border:1px solid #20314b; border-radius:16px; background:linear-gradient(120deg,rgba(49,214,214,.08),transparent 55%),#0f1b2e; }
.direction-topline > div:first-child { display:grid; gap:6px; }
.direction-topline strong { font-size:22px; }
.eyebrow { color:#8fa2bd; font-size:11px; font-weight:800; letter-spacing:.13em; text-transform:uppercase; }
.eyebrow small { margin-left:8px; color:#6e819d; font-size:10px; letter-spacing:0; }
.asof { color:#8fa2bd; font-size:12px; }
.horizon-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
.horizon-card,.direction-panel { border:1px solid #20314b; border-radius:16px; background:#0f1b2e; }
.horizon-card { min-height:148px; padding:18px; display:flex; flex-direction:column; gap:12px; }
.horizon-card.tone-buy { border-color:rgba(41,211,145,.42); }
.horizon-card.tone-sell { border-color:rgba(255,100,124,.42); }
.horizon-direction { font-size:25px; }
.tone-buy .horizon-direction { color:#29d391; }
.tone-sell .horizon-direction { color:#ff647c; }
.tone-wait .horizon-direction { color:#f7c65f; }
.horizon-metrics { display:flex; justify-content:space-between; color:#9dafc8; font-size:12px; }
.coverage-track { height:5px; border-radius:5px; overflow:hidden; background:#20314b; }
.coverage-track i { display:block; height:100%; border-radius:inherit; background:linear-gradient(90deg,#31d6d6,#5c8dff); }
.direction-lower { display:grid; grid-template-columns:1.5fr 1fr; gap:12px; }
.direction-panel { padding:18px; min-width:0; }
.evidence-line { padding-top:14px; margin-top:12px; border-top:1px solid #20314b; }
.evidence-line > strong { font-size:13px; }
.evidence-line ul { margin:8px 0 0; padding-left:18px; color:#bdcbe0; font-size:12px; line-height:1.65; }
.evidence-line small { color:#778ba7; }
.quality-panel p { display:flex; justify-content:space-between; margin:11px 0; padding-bottom:8px; border-bottom:1px solid #20314b; color:#afbed4; font-size:12px; }
.quality-panel b { color:#31d6d6; }
.quality-panel > small { display:block; color:#8296b2; line-height:1.6; }
.interpretation-card { border-color:#20314b; color:#c2cfe2; }
.interpretation-card p { line-height:1.7; }
.analysis-details { border-color:#20314b; }
.modal :deep(.modal-body), .modal :deep(.result-scroll) { background:#08111f; }
.modal :deep(.simple-card), .modal :deep(.coin-analysis), .modal :deep(.analysis-tab-panel) { background:#0f1b2e; border-color:#20314b; color:#dce7f7; }
.modal :deep(.analysis-tab) { color:#9dafc8; }
.modal :deep(.analysis-tab.active) { color:#31d6d6; border-color:#31d6d6; }
@media (max-width: 900px) { .horizon-grid { grid-template-columns:1fr; } .direction-lower { grid-template-columns:1fr; } }

/* Layout inspired by the supplied AI direction dashboard reference. */
.result-scroll { padding:24px 28px 18px; background:radial-gradient(circle at 76% -10%,rgba(54,98,180,.14),transparent 32%),linear-gradient(180deg,#07101d,#091322); }
.research-dashboard { max-width:1680px; margin:0 auto; display:grid; gap:0; color:#eef4ff; }
.panel { min-width:0; background:linear-gradient(180deg,rgba(17,31,52,.97),rgba(12,24,42,.97)); border:1px solid rgba(76,105,143,.3); border-radius:18px; box-shadow:0 16px 40px rgba(0,0,0,.2); }
.dashboard-hero { display:grid; grid-template-columns:minmax(0,1.6fr) minmax(285px,.65fr); gap:16px; }
.hero-main { padding:22px; }
.coin-row { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; }
.coin-left { display:flex; align-items:center; gap:14px; }
.coin-logo { width:46px; height:46px; flex:0 0 auto; border-radius:50%; display:grid; place-items:center; background:linear-gradient(145deg,#f2b93b,#f7931a); color:#111; font-weight:950; font-size:20px; }
.coin-name { font-size:22px; font-weight:900; }.coin-symbol { color:#8fa2bd; font-size:12px; margin-top:3px; }
.price { font-size:27px; font-weight:900; text-align:right; }.change { color:#29d391; text-align:right; font-size:12px; font-weight:750; margin-top:5px; }
.meta-strip { display:flex; flex-wrap:wrap; gap:8px; margin:18px 0; padding-top:16px; border-top:1px solid rgba(90,115,148,.2); }
.chip { padding:7px 10px; border:1px solid rgba(76,105,143,.32); border-radius:999px; background:#0b1728; color:#aabbd0; font-size:11px; font-weight:700; }.chip.good { color:#9de8cb; border-color:rgba(41,211,145,.28); background:rgba(41,211,145,.07); }.chip.warn { color:#f3d997; border-color:rgba(247,198,95,.26); background:rgba(247,198,95,.06); }
.summary-box { display:grid; grid-template-columns:minmax(0,1.4fr) minmax(140px,.6fr); gap:16px; align-items:center; padding:16px; border:1px solid rgba(93,132,188,.22); border-radius:15px; background:linear-gradient(135deg,rgba(50,84,139,.12),rgba(49,214,214,.035)); }.summary-box h3 { margin:0 0 8px; font-size:13px; }.summary-box p,.info-card p { margin:0; color:#afbdd0; font-size:12px; line-height:1.78; }
.state-block { text-align:right; }.state-label { color:#8fa2bd; font-size:10px; font-weight:800; letter-spacing:1px; }.state-value { margin-top:7px; font-size:17px; font-weight:900; }.state-sub { color:#7f93ae; font-size:10px; margin-top:5px; }
.quality { padding:20px; display:flex; flex-direction:column; justify-content:space-between; }.panel-title { color:#dce7f6; font-size:12px; font-weight:850; }.panel-sub { margin-top:4px; color:#8fa2bd; font-size:10px; line-height:1.5; }
.quality-main { display:flex; align-items:center; gap:18px; margin:17px 0 13px; }.ring { width:96px; height:96px; flex:0 0 auto; display:grid; place-items:center; position:relative; border-radius:50%; background:conic-gradient(#31d6d6 var(--quality),#1a2a42 var(--quality) 100%); }.ring::after { content:''; position:absolute; width:74px; height:74px; border-radius:50%; background:#0f1b2e; }.ring b { z-index:1; font-size:24px; }.ring small { font-size:10px; color:#8fa2bd; }.quality-info { min-width:0; }.quality-info strong { font-size:13px; }.quality-info p { color:#8fa2bd; font-size:11px; line-height:1.55; margin:6px 0 0; }
.mini-bars { display:grid; gap:8px; }.mini-bar { display:grid; grid-template-columns:64px 1fr 28px; gap:8px; align-items:center; color:#8fa2bd; font-size:10px; }.mini-bar b { text-align:right; }.track { height:6px; border-radius:999px; background:#19283d; overflow:hidden; }.fill { height:100%; border-radius:inherit; background:linear-gradient(90deg,#4f86ff,#31d6d6); }
.section-title-row { display:flex; justify-content:space-between; align-items:end; gap:14px; margin:24px 0 12px; }.section-title-row h2 { margin:0; font-size:14px; }.section-title-row p { margin:4px 0 0; color:#8fa2bd; font-size:10px; }
.direction-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; }.direction-card { padding:18px; position:relative; overflow:hidden; }.direction-card::after { content:''; position:absolute; right:-34px; top:-34px; width:110px; height:110px; border-radius:50%; background:radial-gradient(circle,rgba(92,141,255,.13),transparent 68%); pointer-events:none; }
.dir-head { display:flex; justify-content:space-between; align-items:start; gap:10px; }.dir-head small { color:#8fa2bd; font-size:10px; }.dir-head h3 { margin:3px 0 0; font-size:13px; }.dir-badge { padding:6px 9px; border-radius:9px; font-size:11px; font-weight:900; background:rgba(247,198,95,.08); color:#efd17f; border:1px solid rgba(247,198,95,.18); }.dir-badge.tone-buy { color:#67e4b6; background:rgba(41,211,145,.1); border-color:rgba(41,211,145,.2); }.dir-badge.tone-sell { color:#ff8295; background:rgba(255,100,124,.1); border-color:rgba(255,100,124,.2); }
.score-row { display:flex; justify-content:space-between; align-items:end; margin:17px 0 10px; }.score { font-size:30px; font-weight:950; letter-spacing:-1px; }.score span { margin-left:4px; color:#8fa2bd; font-size:12px; font-weight:700; }.confidence { text-align:right; }.confidence b { font-size:15px; }.confidence small { display:block; margin-top:2px; color:#8fa2bd; font-size:9px; }
.axis { height:10px; position:relative; border-radius:999px; background:linear-gradient(90deg,rgba(255,100,124,.8),#34465f 50%,rgba(41,211,145,.8)); }.axis::after { content:''; position:absolute; left:50%; top:-3px; width:1px; height:16px; background:#94a8c3; opacity:.65; }.marker { position:absolute; top:-4px; width:18px; height:18px; border:3px solid #0f1b2e; border-radius:50%; background:#f3f7ff; transform:translateX(-50%); box-shadow:0 3px 12px rgba(0,0,0,.4); }.axis-labels { display:flex; justify-content:space-between; margin-top:5px; color:#71849e; font-size:9px; }.dir-note { min-height:36px; margin:12px 0 0; color:#9dafc6; font-size:11px; line-height:1.6; }
.two-col { display:grid; grid-template-columns:1.05fr .95fr; gap:14px; margin-top:14px; }.structure,.regime { padding:18px; min-width:0; }.structure :deep(.brief-kline-chart) { margin-top:12px; }.align-row { display:flex; justify-content:space-between; align-items:center; margin-top:15px; padding-top:14px; border-top:1px solid rgba(90,115,148,.2); }.align-row span { color:#8fa2bd; font-size:10px; }.align-row b { font-size:11px; color:#bad0f1; }
.regime-grid { display:grid; grid-template-columns:1fr 1fr; gap:9px; margin-top:14px; }.regime-item { padding:12px; border-radius:12px; background:#0b1728; border:1px solid rgba(87,113,147,.22); }.regime-item span { color:#8fa2bd; font-size:9px; letter-spacing:.5px; }.regime-item b { display:block; margin-top:5px; font-size:11px; }.regime-item .info { color:#80a9ff; }
.evidence-panel { padding:18px; margin-top:14px; }.evidence-list { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:9px; margin-top:12px; }.evidence-item { display:flex; gap:10px; align-items:flex-start; padding:13px 14px; border:1px solid rgba(87,113,147,.22); border-radius:12px; background:#0b1728; }.ev-num { width:23px; height:23px; flex:0 0 auto; display:grid; place-items:center; border-radius:8px; background:#13253f; color:#7ba6ff; font-size:10px; font-weight:900; }.evidence-item strong { display:block; font-size:11px; }.evidence-item p { margin:5px 0 0; color:#8fa2bd; font-size:10.5px; line-height:1.55; }
.risk-grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-top:14px; }.info-card { padding:18px; }.info-card h3 { margin:0 0 12px; font-size:12px; }.info-card p + p { margin-top:10px; }.callout { border-left:3px solid #f7c65f; border-radius:0 11px 11px 0; padding:12px 13px; background:rgba(247,198,95,.05); color:#d5c18a; font-size:10px; line-height:1.6; }.risk-list { margin:11px 0 0; padding-left:18px; color:#8fa2bd; font-size:10px; line-height:1.7; }
.empty-analysis { margin:24px; padding:28px; color:#c7d5e8; }.empty-analysis p { white-space:pre-wrap; color:#8fa2bd; line-height:1.7; }.research-dashboard ~ .disclaimer { margin-top:16px; color:#7488a3; border-color:#20314b; font-size:10px; }
.modal-header { min-height:66px; padding:14px 22px; border-color:rgba(90,115,148,.2); }.modal-title { font-size:15px; letter-spacing:.1px; }.modal-body,.result-layout { background:#08111f; }
@media (max-width:1100px) { .dashboard-hero { grid-template-columns:1fr; }.quality { gap:14px; }.direction-grid { grid-template-columns:1fr; }.dir-note { min-height:0; } }
@media (max-width:760px) { .result-scroll { padding:14px; }.two-col,.risk-grid,.evidence-list { grid-template-columns:1fr; }.coin-row { align-items:flex-start; }.coin-name { font-size:18px; }.price { font-size:20px; }.summary-box { grid-template-columns:1fr; }.state-block { text-align:left; }.section-title-row { align-items:flex-start; }.section-title-row .asof { display:none; } }.horizon-ai-analysis { margin-top:13px; padding-top:12px; border-top:1px solid rgba(90,115,148,.2); color:#aebed3; font-size:11px; line-height:1.65; }.horizon-ai-analysis p { margin:0; }.horizon-points { display:grid; gap:6px; margin-top:10px; }.horizon-points div { display:grid; grid-template-columns:42px 1fr; gap:8px; }.horizon-points b { color:#29d391; font-size:10px; }.horizon-points div + div b { color:#ff8295; }.horizon-points span { color:#8fa2bd; }.horizon-ai-analysis > small { display:block; margin-top:8px; color:#d9be77; }
.timeframe-analysis-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; margin-top:10px; }.timeframe-analysis { min-width:0; padding:11px; border:1px solid rgba(87,113,147,.22); border-radius:11px; background:#0b1728; }.timeframe-analysis strong { display:block; font-size:11px; }.timeframe-analysis > span { display:inline-block; margin-top:6px; color:#31d6d6; font-size:10px; }.timeframe-analysis p { margin:7px 0; color:#9dafc6; font-size:10px; line-height:1.55; }.timeframe-analysis small { display:block; color:#7489a4; font-size:9px; line-height:1.5; }
.regime-wide { grid-column:1 / -1; }.regime-wide b { line-height:1.6; font-weight:600; color:#afbdd0; }.bias-evidence { min-height:100%; }.bias-evidence ul { margin:5px 0 0; padding-left:17px; color:#a9bad0; font-size:10.5px; line-height:1.7; }.bull-evidence .ev-num { color:#67e4b6; }.bear-evidence .ev-num { color:#ff8295; }
.module-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; }.module-card { padding:17px; }.module-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }.module-title { display:flex; align-items:center; gap:9px; }.mod-ico { width:30px; height:30px; flex:0 0 auto; display:grid; place-items:center; border-radius:9px; background:#13243c; border:1px solid rgba(87,113,147,.22); color:#31d6d6; }.module-title strong { display:block; font-size:11px; }.module-title small { display:block; margin-top:3px; color:#8fa2bd; font-size:9px; }.status-pill { padding:5px 7px; border-radius:8px; background:rgba(41,211,145,.08); color:#68ddb3; font-size:9px; font-weight:900; }.status-pill.warn { background:rgba(247,198,95,.08); color:#e6c66f; }.module-summary { margin-top:14px; color:#9dafc6; font-size:10.5px; line-height:1.65; }.module-facts { margin:9px 0 0; padding-left:17px; color:#8fa2bd; font-size:10px; line-height:1.6; }.module-limitation { margin-top:9px; padding-top:8px; border-top:1px solid rgba(90,115,148,.16); color:#d4bb78; font-size:9px; line-height:1.5; }.focus-callout { margin-top:12px; padding:10px; border-radius:10px; background:#0b1728; color:#aebed3; font-size:10px; line-height:1.6; }
@media (max-width:760px) { .two-col,.risk-grid,.evidence-list,.module-grid { grid-template-columns:1fr; }.timeframe-analysis-grid { grid-template-columns:1fr; } }.pick-body { width:min(980px,100%); margin:0 auto; padding:28px; gap:18px; overflow-y:auto; }
.pick-body .intro { padding:18px 20px; border:1px solid #20314b; border-radius:15px; background:linear-gradient(120deg,rgba(49,214,214,.07),transparent),#0f1b2e; color:#afbdd0; line-height:1.65; }
.pick-body .block { padding:17px; border:1px solid rgba(76,105,143,.3); border-radius:15px; background:#0f1b2e; }
.pick-body .block-label { color:#dce7f6; font-size:12px; font-weight:850; letter-spacing:.3px; }
.pick-body .coin-chip { border-color:#20314b; background:#0b1728; color:#9dafc6; }.pick-body .coin-chip.active { border-color:rgba(92,141,255,.55); background:linear-gradient(135deg,rgba(72,120,238,.28),rgba(102,89,235,.2)); color:#eef4ff; }
.pick-body .custom-input { min-height:40px; border:1px solid #20314b; border-radius:10px; background:#0b1728; color:#eef4ff; padding:0 12px; }.pick-body .primary-btn { align-self:flex-start; min-height:42px; padding:0 18px; border-radius:11px; background:linear-gradient(135deg,#4878ee,#6659eb); }
.pick-body .history-block { padding:17px; }.pick-body .history-item { border-color:#20314b; background:#0b1728; color:#dce7f6; }.pick-body .history-item:hover { border-color:#3d6bb2; background:#122038; }
.modal-title { color:#eef4ff; }.ai-spark { color:#31d6d6; }</style>
