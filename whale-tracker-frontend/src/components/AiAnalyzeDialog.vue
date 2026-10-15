<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { streamAnalyzeWithWhaleAi } from '@/api';
import { formatAnalyzeBodyHtml, parseAnalyzeSections } from '@/utils/briefHighlight';
import AdaptivePage from './mobile/AdaptivePage.vue';

const props = defineProps<{
  visible: boolean;
  source: 'macro' | 'whale';
  title: string;
  content: string;
  meta?: Record<string, unknown>;
  mobile?: boolean;
}>();

const emit = defineEmits<{
  'update:visible': [value: boolean];
}>();

const loading = ref(false);
const error = ref('');
const analysis = ref('');
const statusMsg = ref('');
const activeTab = ref('');
let reqSeq = 0;
let abortCtrl: AbortController | null = null;

const isLarge = computed(
  () => props.source === 'whale' || props.source === 'macro',
);

const dialogTitle = computed(() =>
  props.source === 'macro'
    ? '宏观智能分析'
    : props.source === 'whale'
      ? '巨鲸智能分析'
      : '动态智能分析',
);

const dialogWidth = computed(() => (props.source === 'macro' ? '720px' : isLarge.value ? '780px' : '520px'));
const open = computed({ get: () => props.visible, set: (value) => emit('update:visible', value) });
const macroMeta = computed(() => props.meta || {});
const macroImportance = computed(() => ({high:'高 (High)', mid:'中 (Mid)', low:'低 (Low)'}[String(macroMeta.value.importance)] || '未提供'));
const macroTime = computed(() => [macroMeta.value.date || macroMeta.value.dateLabel, macroMeta.value.time].filter(Boolean).join(' · ') || '时间待确认');
const macroNote = computed(() => String(macroMeta.value.note || props.content.split('【数据读数】')[0] || '').trim());
const macroReadings = computed(() => [
  { label:'前值', value:macroMeta.value.previous ?? '未提供' },
  { label:'预测', value:macroMeta.value.forecast ?? '未提供' },
  { label:'实际值', value:macroMeta.value.actual || (macroMeta.value.released ? '待回填' : '待公布'), actual:true },
]);
// 仅拆分日历已有的因果链，不根据指标名称或样例推断方向。
const macroScenarios = computed(() => {
  const scenarios = macroNote.value.split(/[；;\n]+/).map(text => {
    const steps = text.split(/→|⇒|->/).map(s => s.trim()).filter(Boolean);
    const conclusion = steps.at(-1) || '';
    const bull = /利多|偏多|利好|上涨/.test(conclusion), bear = /利空|偏空|承压|下跌/.test(conclusion);
    return { text, steps, tone:bull === bear ? 'neutral' : bull ? 'bullish' : 'bearish' };
  }).filter(item => item.text.trim());
  return scenarios.some(item => item.steps.length > 1) ? scenarios : [];
});

type InfoRow = { label: string; value: string; highlight?: boolean };

const infoRows = computed<InfoRow[]>(() => {
  const meta = (props.meta || {}) as Record<string, unknown>;
  if (props.source === 'whale') {
    const dir =
      String(meta.directionLabel || '') ||
      (meta.direction === 'long'
        ? '做多'
        : meta.direction === 'short'
          ? '做空'
          : meta.direction === 'mixed'
            ? '多空混合'
            : '');
    const rows: InfoRow[] = [
      { label: '名称', value: String(meta.name || props.title || '—') },
      { label: '地址', value: String(meta.address || '—') },
      { label: '综合方向', value: dir || '—', highlight: /做多|做空/.test(dir) },
      { label: '持仓数', value: String(meta.positionCount ?? '—') },
    ];
    if (meta.statsLine) rows.push({ label: '账户业绩', value: String(meta.statsLine) });
    if (meta.volumeLine) rows.push({ label: '成交活跃', value: String(meta.volumeLine) });
    if (meta.referenceLabel) {
      rows.push({ label: '可靠度', value: String(meta.referenceLabel), highlight: meta.referenceTier === 'high' });
    }
    return rows;
  }

  const preview = String(props.content || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
  return [
    { label: '标题', value: props.title || '（无标题）' },
    {
      label: '来源',
      value: props.source === 'macro' ? '宏观日历' : '巨鲸分析',
    },
    ...(preview
      ? [{ label: '摘要', value: preview + (props.content.length > 220 ? '…' : '') }]
      : []),
  ];
});

/** 固定类型 Tab（与 Prompt 章节对齐） */
const typeDefs = computed(() => {
  if (props.source === 'whale') {
    return [
      { key: 'structure', shortTitle: '仓位结构', match: /仓位结构/ },
      { key: 'bias', shortTitle: '方向倾向', match: /方向倾向/ },
      { key: 'risk', shortTitle: '风险点', match: /风险点/ },
      { key: 'signal', shortTitle: '可观察信号', match: /可观察信号|观察信号/ },
      { key: 'reliability', shortTitle: '巨鲸可靠度', match: /巨鲸可靠度|可靠度/ },
    ];
  }
  return [
    { key: 'summary', shortTitle: '要点摘要', match: /要点摘要|要点/ },
    { key: 'bias', shortTitle: '方向倾向', match: /方向倾向/ },
    { key: 'focus', shortTitle: '信心关注', match: /信心|关注点/ },
    { key: 'risk', shortTitle: '风险提示', match: /风险提示|风险/ },
    { key: 'outlook', shortTitle: '走向预判', match: /走向预判|走势预判|预判/ },
  ];
});

const parsedSections = computed(() => parseAnalyzeSections(analysis.value));

const tabs = computed(() => {
  const parsed = parsedSections.value;
  const matched = new Set<string>();

  const list = typeDefs.value.map((def) => {
    const hit = parsed.find(
      (s) =>
        def.match.test(s.shortTitle) ||
        def.match.test(s.title) ||
        s.key.includes(def.shortTitle),
    );
    if (hit) matched.add(hit.key);
    return {
      key: def.key,
      shortTitle: def.shortTitle,
      html: hit?.html || '',
      empty: !hit?.html,
    };
  });

  // 未归类章节 →「其他」
  const leftovers = parsed.filter(
    (s) => !matched.has(s.key) && s.html && s.key !== 'all',
  );
  if (leftovers.length) {
    list.push({
      key: 'other',
      shortTitle: '其他',
      html: leftovers
        .map((s) => `<p class="analysis-p"><strong>${s.shortTitle}</strong></p>${s.html}`)
        .join(''),
      empty: false,
    });
  }

  // 流式尚未拆出章节标题：整段草稿放进第一个 Tab
  if (analysis.value && (parsed.length === 0 || (parsed.length === 1 && parsed[0].key === 'all'))) {
    list[0].html =
      parsed[0]?.key === 'all' ? parsed[0].html : formatAnalyzeBodyHtml(analysis.value);
    list[0].empty = !list[0].html;
  }

  return list;
});

const activeHtml = computed(() => tabs.value.find((t) => t.key === activeTab.value)?.html || '');

watch(
  tabs,
  (list) => {
    if (!list.length) return;
    if (!list.some((t) => t.key === activeTab.value)) {
      const withContent = list.find((t) => t.html);
      activeTab.value = withContent?.key || list[0].key;
    }
  },
  { immediate: true },
);

async function runAnalyze() {
  abortCtrl?.abort();
  const seq = ++reqSeq;
  const ctrl = new AbortController();
  abortCtrl = ctrl;
  loading.value = true;
  error.value = '';
  analysis.value = '';
  activeTab.value = typeDefs.value[0]?.key || '';
  statusMsg.value = 'DeepSeek 正在分析…';
  try {
    await streamAnalyzeWithWhaleAi(
      {
        source: props.source,
        title: props.title,
        content: props.content,
        meta: props.meta,
      },
      {
        signal: ctrl.signal,
        onStatus: (p) => {
          if (seq !== reqSeq) return;
          statusMsg.value = p.message || '分析中…';
        },
        onDelta: (text) => {
          if (seq !== reqSeq) return;
          analysis.value += text;
        },
        onDone: (payload) => {
          if (seq !== reqSeq) return;
          if (payload.analysis) analysis.value = payload.analysis;
          statusMsg.value = '';
        },
        onError: (msg) => {
          if (seq !== reqSeq) return;
          error.value = msg;
        },
      },
    );
    if (seq !== reqSeq) return;
    if (!analysis.value) error.value = '未返回分析结果';
  } catch (err) {
    if (seq !== reqSeq) return;
    if (ctrl.signal.aborted) return;
    error.value = err instanceof Error ? err.message : '分析失败';
  } finally {
    if (seq === reqSeq) {
      loading.value = false;
      statusMsg.value = '';
    }
  }
}

watch(
  () => props.visible,
  (open) => {
    if (open) void runAnalyze();
    else {
      reqSeq += 1;
      abortCtrl?.abort();
      abortCtrl = null;
      loading.value = false;
      statusMsg.value = '';
    }
  },
);

function close() {
  emit('update:visible', false);
}
onUnmounted(() => { reqSeq++; abortCtrl?.abort(); });
</script>

<template>
  <AdaptivePage
    v-model="open"
    :mobile="mobile && source === 'macro'"
    class="ai-analyze-modal"
    :class="{ large: isLarge, 'macro-analyze-modal': source === 'macro' }"
    :width="dialogWidth"
    append-to-body
    destroy-on-close
    :show-close="false"
    :title="dialogTitle"
  >
    <template #header>
      <div class="modal-header-inner">
        <h2 class="modal-title">{{ dialogTitle }}<span v-if="source === 'macro'" class="macro-title-tag">{{ macroMeta.coin || 'BTC' }} · 宏观事件</span></h2>
        <button type="button" class="close-btn" aria-label="关闭" @click="close">&times;</button>
      </div>
    </template>

    <div class="modal-body" :class="{ large: isLarge }">
      <dl v-if="source === 'macro'" class="macro-meta-grid">
        <div><dt>标题</dt><dd>{{ title || '（无标题）' }}</dd></div>
        <div><dt>来源</dt><dd>宏观日历<span v-if="macroMeta.actualSource"> · {{ macroMeta.actualSource }}</span></dd></div>
        <div><dt>重要性</dt><dd class="macro-importance">{{ macroImportance }}</dd></div>
        <div><dt>公布时间（北京时间）</dt><dd>{{ macroTime }}</dd></div>
        <div v-if="macroNote" class="macro-meta-summary"><dt>摘要</dt><dd>{{ macroNote }}</dd></div>
      </dl>
      <div v-else-if="infoRows.length" class="info-block">
        <div v-for="(row, i) in infoRows" :key="i" class="info-item">
          <span class="info-label">{{ row.label }}:</span>
          <span class="info-value" :class="{ highlight: row.highlight }">{{ row.value }}</span>
        </div>
      </div>

      <div class="type-tabs" role="tablist">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          type="button"
          role="tab"
          class="type-tab"
          :class="{ active: activeTab === tab.key, empty: tab.empty && !loading }"
          :aria-selected="activeTab === tab.key"
          @click="activeTab = tab.key"
        >
          {{ tab.shortTitle }}
        </button>
      </div>

      <div class="tab-panel" role="tabpanel">
        <template v-if="source === 'macro' && activeTab === 'summary'">
          <div class="macro-data-grid" aria-label="事件数据读数">
            <div v-for="reading in macroReadings" :key="reading.label" class="macro-data-box"><span>{{ reading.label }}</span><strong :class="{actual:reading.actual}">{{ reading.value === '' ? '未提供' : reading.value }}</strong></div>
          </div>
          <section v-if="macroScenarios.length" class="macro-scenarios">
            <h3 class="macro-section-title">逻辑链场景参考 <small>来自宏观日历</small></h3>
            <div class="macro-logic-grid"><article v-for="(scenario,index) in macroScenarios" :key="index" class="macro-logic-card" :class="scenario.tone"><strong>{{ scenario.steps[0] }}</strong><ol><li v-for="(step,i) in scenario.steps.slice(1)" :key="i">{{ step }}</li></ol></article></div>
          </section>
        </template>
        <h3 v-if="source === 'macro'" class="macro-section-title">{{ activeTab === 'summary' ? 'AI 要点分析' : tabs.find(tab => tab.key === activeTab)?.shortTitle }}</h3>
        <div v-if="loading && !analysis" class="stream-status">
          <span class="pulse" />
          {{ statusMsg || '分析中…' }}
        </div>
        <div v-else-if="error && !analysis" class="stream-error">{{ error }}</div>
        <template v-else>
          <div v-if="activeHtml" class="analysis-stream" v-html="activeHtml" />
          <div v-else-if="loading" class="stream-status mild">
            <span class="pulse" />
            该分类内容生成中…
          </div>
          <div v-else class="tab-empty">暂无该分类内容</div>
          <span v-if="loading && analysis" class="stream-cursor" aria-hidden="true">▍</span>
        </template>
        <div v-if="error && analysis" class="stream-error inline">{{ error }}</div>
      </div>
    </div>

    <template #footer>
      <div class="modal-footer-inner">
        <button type="button" class="btn btn-secondary" @click="close">关闭</button>
        <button type="button" class="btn btn-primary" :disabled="loading" @click="runAnalyze">
          {{ loading ? '分析中…' : '重新分析' }}
        </button>
      </div>
    </template>
  </AdaptivePage>
</template>

<style>
.ai-analyze-modal.el-dialog {
  --aa-bg: #1a1c23;
  --aa-header: #23262f;
  --aa-text: #e2e8f0;
  --aa-muted: #94a3b8;
  --aa-border: #2d3341;
  --aa-blue: #3b82f6;
  background: var(--aa-bg) !important;
  border: 1px solid var(--aa-border);
  border-radius: 12px;
  box-shadow:
    0 20px 25px -5px rgba(0, 0, 0, 0.5),
    0 10px 10px -5px rgba(0, 0, 0, 0.3);
  overflow: hidden;
  max-height: 92vh;
  margin-top: 4vh !important;
}
.ai-analyze-modal.large.el-dialog {
  max-height: 94vh;
  margin-top: 2.5vh !important;
}
.ai-analyze-modal .el-dialog__header {
  margin: 0;
  padding: 0;
  background: var(--aa-header, #23262f);
  border-bottom: 1px solid var(--aa-border, #2d3341);
}
.ai-analyze-modal .el-dialog__body {
  padding: 0;
  background: var(--aa-bg, #1a1c23);
  color: var(--aa-text, #e2e8f0);
}
.ai-analyze-modal .el-dialog__footer {
  padding: 0;
  background: var(--aa-header, #23262f);
  border-top: 1px solid var(--aa-border, #2d3341);
}
.macro-analyze-modal {
  --aa-bg: #131823;
  --aa-header: #131823;
  --aa-base: #0b0e14;
  --aa-card: #1a202c;
  --aa-border: #2a2f3e;
  --aa-muted: #8f9bb3;
  --aa-text: #e2e8f0;
  --aa-blue: #3b82f6;
}
.macro-analyze-modal.el-dialog {
  --aa-bg: #131823;
  --aa-header: #131823;
  --aa-border: #2a2f3e;
  display: flex;
  flex-direction: column;
  padding: 0;
  width: min(720px, calc(100vw - 32px));
  max-width: calc(100vw - 32px);
  max-height: 92dvh !important;
  margin-top: 4dvh !important;
  box-shadow: 0 20px 50px rgba(0,0,0,.6);
}
.macro-analyze-modal .el-dialog__header,
.macro-analyze-modal .el-dialog__footer { flex: none; }
.macro-analyze-modal .el-dialog__body { flex: 1; min-height: 0; overflow: hidden; }
.macro-analyze-modal.h5-subpage { background: var(--aa-bg); }
.macro-analyze-modal.h5-subpage > .h5-subpage-heading { display: none; }
.macro-analyze-modal.h5-subpage > .h5-subpage-content { padding: 0; overflow: hidden; }
.macro-analyze-modal.h5-subpage > .h5-subpage-footer { padding: 0 0 env(safe-area-inset-bottom); background: var(--aa-base); }
.macro-analyze-modal .h5-subpage-nav { border-color: var(--aa-border); }
</style>

<style scoped>
.modal-header-inner {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 22px;
}
.modal-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #e2e8f0;
}
.close-btn {
  background: none;
  border: none;
  color: #94a3b8;
  font-size: 20px;
  cursor: pointer;
  padding: 0;
  line-height: 1;
}
.close-btn:hover {
  color: #fff;
}

.modal-body {
  padding: 18px 22px 20px;
  display: flex;
  flex-direction: column;
  min-height: min(52vh, 480px);
  max-height: min(68vh, 600px);
  font-size: 14px;
  line-height: 1.6;
  color: #e2e8f0;
}
.modal-body.large {
  min-height: min(66vh, 640px);
  max-height: min(80vh, 780px);
}

.info-block {
  background: #212530;
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 14px;
  font-size: 13px;
  flex-shrink: 0;
}
.info-item {
  display: flex;
  margin-bottom: 6px;
  gap: 8px;
}
.info-item:last-child {
  margin-bottom: 0;
}
.info-label {
  color: #94a3b8;
  width: 72px;
  flex-shrink: 0;
}
.info-value {
  color: #94a3b8;
  word-break: break-all;
}
.info-value.highlight {
  color: #e2e8f0;
  font-weight: 600;
}

.type-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 14px;
  padding-bottom: 12px;
  border-bottom: 1px solid #2d3341;
  flex-shrink: 0;
}
.type-tab {
  height: 30px;
  padding: 0 12px;
  border-radius: 6px;
  border: 1px solid #2d3341;
  background: transparent;
  color: #94a3b8;
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.15s,
    border-color 0.15s;
}
.type-tab:hover {
  color: #e2e8f0;
  border-color: #3f4756;
}
.type-tab.active {
  background: rgba(255, 255, 255, 0.06);
  border-color: #3f4756;
  color: #e2e8f0;
  font-weight: 600;
}
.type-tab.empty {
  opacity: 0.55;
}

.tab-panel {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
}
.tab-panel::-webkit-scrollbar {
  width: 6px;
}
.tab-panel::-webkit-scrollbar-thumb {
  background: #3f4756;
  border-radius: 3px;
}

.stream-status {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #94a3b8;
  font-size: 13px;
  padding: 16px 0;
}
.stream-status.mild {
  padding: 12px 0;
}
.pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #94a3b8;
  animation: aa-pulse 1s ease-in-out infinite;
}
@keyframes aa-pulse {
  0%,
  100% {
    opacity: 0.35;
    transform: scale(0.85);
  }
  50% {
    opacity: 1;
    transform: scale(1);
  }
}
.stream-error {
  color: #ef4444;
  font-size: 13px;
  padding: 8px 0;
}
.stream-error.inline {
  margin-top: 8px;
}
.stream-cursor {
  display: inline-block;
  margin-left: 2px;
  color: #94a3b8;
  animation: aa-blink 0.9s step-end infinite;
}
@keyframes aa-blink {
  50% {
    opacity: 0;
  }
}
.tab-empty {
  color: #64748b;
  font-size: 13px;
  padding: 20px 0;
}

.analysis-stream {
  color: #94a3b8;
}
.analysis-stream :deep(.analysis-list) {
  margin: 0;
  padding-left: 20px;
}
.analysis-stream :deep(.analysis-list li) {
  margin-bottom: 10px;
}
.analysis-stream :deep(.analysis-list li::marker) {
  color: #64748b;
}
.analysis-stream :deep(.analysis-p) {
  margin: 0 0 10px;
}
.analysis-stream :deep(.text-key),
.analysis-stream :deep(strong) {
  color: #e2e8f0;
  font-weight: 600;
}

.modal-footer-inner {
  padding: 16px 22px;
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}
.btn {
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  border: none;
  transition: all 0.2s ease;
}
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.btn-secondary {
  background: transparent;
  color: #94a3b8;
  border: 1px solid #2d3341;
}
.btn-secondary:hover {
  background: rgba(255, 255, 255, 0.05);
  color: #e2e8f0;
}
.btn-primary {
  background: transparent;
  color: #e2e8f0;
  border: 1px solid #3f4756;
}
.btn-primary:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.06);
}

.macro-analyze-modal .modal-header-inner { padding: 16px 24px; gap: 12px; }
.macro-analyze-modal .modal-title { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font-size: 18px; font-weight: 700; }
.macro-title-tag { color: #f59e0b; background: rgba(245,158,11,.1); padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; }
.macro-analyze-modal .close-btn { display: grid; place-items: center; flex: none; width: 32px; height: 32px; border-radius: 6px; }
.macro-analyze-modal .close-btn:hover { background: #242c3d; }
.macro-analyze-modal .modal-body.large { box-sizing: border-box; padding: 24px; gap: 20px; min-height: 0; max-height: calc(92dvh - 144px); overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: #2a2f3e transparent; }
.macro-meta-grid { margin: 0; padding: 16px; display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 14px 24px; border: 1px solid var(--aa-border); background: var(--aa-base); border-radius: 8px; flex: none; }
.macro-meta-grid > div { min-width: 0; }
.macro-meta-grid dt { margin: 0 0 6px; color: var(--aa-muted); font-size: 11px; }
.macro-meta-grid dd { margin: 0; font-size: 13px; font-weight: 500; color: var(--aa-text); overflow-wrap: anywhere; }
.macro-meta-grid .macro-importance { color: #f59e0b; font-weight: 600; }
.macro-meta-summary { grid-column: 1 / -1; }
.macro-meta-summary dd { font-size: 12px; line-height: 1.8; color: var(--aa-muted); }
.macro-analyze-modal .type-tabs { flex-wrap: nowrap; gap: 5px; margin: 0; padding: 0 0 8px; border-color: var(--aa-border); overflow-x: auto; scrollbar-width: none; }
.macro-analyze-modal .type-tab { height: 32px; padding: 0 10px; border: 0; flex: none; }
.macro-analyze-modal .type-tab.active { background: var(--aa-blue); color: white; }
.macro-analyze-modal .type-tab:hover:not(.active) { background: #242c3d; }
.macro-analyze-modal .tab-panel { overflow: visible; flex: none; padding: 0; }
.macro-data-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 12px; margin-bottom: 20px; }
.macro-data-box { padding: 12px 8px; border: 1px solid var(--aa-border); border-radius: 8px; background: var(--aa-base); text-align: center; display: flex; flex-direction: column; gap: 6px; }
.macro-data-box > span { color: var(--aa-muted); font-size: 11px; }
.macro-data-box strong { color: var(--aa-text); font: 700 17px/1.5 Consolas, monospace; overflow-wrap: anywhere; }
.macro-data-box strong.actual { color: #f59e0b; }
.macro-section-title { font-size: 13px; font-weight: 500; color: var(--aa-muted); margin: 0 0 10px; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.macro-section-title small { color: var(--aa-muted); font-size: 10px; opacity: .8; }
.macro-scenarios { margin: 0 0 20px; }
.macro-logic-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 12px; }
.macro-logic-card { background: var(--aa-card); padding: 14px; border: 1px solid var(--aa-border); border-top: 3px solid var(--aa-blue); border-radius: 8px; overflow-wrap: anywhere; }
.macro-logic-card > strong { font-size: 12px; color: var(--aa-text); font-weight: 600; }
.macro-logic-card ol { margin: 10px 0 0; padding: 0 0 0 12px; border-left: 2px dashed var(--aa-border); list-style: none; }
.macro-logic-card li { color: var(--aa-muted); font-size: 12px; line-height: 1.8; margin-top: 5px; }
.macro-logic-card li::before { content: '↳'; margin-right: 6px; color: var(--aa-muted); }
.macro-logic-card.bearish { border-top-color: #ff4d4d; }
.macro-logic-card.bullish { border-top-color: #00e676; }
.macro-logic-card.bearish li:last-child { color: #ff4d4d; }
.macro-logic-card.bullish li:last-child { color: #00e676; }
.macro-analyze-modal .analysis-stream { font-size: 13px; line-height: 1.9; color: var(--aa-muted); overflow-wrap: anywhere; }
.macro-analyze-modal .analysis-stream :deep(.analysis-list) { padding: 0; list-style: none; }
.macro-analyze-modal .analysis-stream :deep(.analysis-list li),
.macro-analyze-modal .analysis-stream :deep(.analysis-p) { padding: 12px 14px; margin: 0 0 10px; border: 1px solid var(--aa-border); background: var(--aa-card); border-radius: 8px; }
.macro-analyze-modal .stream-status,
.macro-analyze-modal .stream-error,
.macro-analyze-modal .tab-empty { border: 1px solid var(--aa-border); border-radius: 8px; padding: 14px; margin: 0; background: var(--aa-base); }
.macro-analyze-modal .modal-footer-inner { padding: 16px 24px; background: var(--aa-base); }
.macro-analyze-modal .btn-secondary { border-color: var(--aa-border); color: var(--aa-text); }
.macro-analyze-modal .btn-primary { background: var(--aa-blue); color: white; border: 1px solid var(--aa-blue); }
.macro-analyze-modal .btn-primary:hover:not(:disabled) { background: #2563eb; }
.macro-analyze-modal button:focus-visible { outline: 2px solid var(--aa-blue); outline-offset: 3px; }
@media (max-width:767px) {
  .macro-analyze-modal .modal-body.large { height: 100%; max-height: none; padding: 16px; gap: 18px; }
  .macro-meta-grid { padding: 14px; gap: 14px 16px; }
  .macro-meta-grid dd { font-size: 12px; }
  .macro-data-grid { gap: 8px; }
  .macro-data-box strong { font-size: 16px; }
  .macro-logic-grid { grid-template-columns: minmax(0,1fr); }
  .macro-analyze-modal .type-tab { min-height: 40px; padding: 0 12px; }
  .macro-analyze-modal .modal-footer-inner { padding: 12px 16px; }
  .macro-analyze-modal .btn { min-height: 44px; flex: 1; }
}
@media (prefers-reduced-motion:reduce) {
  .macro-analyze-modal .pulse, .macro-analyze-modal .stream-cursor { animation: none; }
}
</style>
