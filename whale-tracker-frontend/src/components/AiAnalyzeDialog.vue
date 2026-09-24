<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { streamAnalyzeWithWhaleAi } from '@/api';
import { formatAnalyzeBodyHtml, parseAnalyzeSections } from '@/utils/briefHighlight';

const props = defineProps<{
  visible: boolean;
  source: 'x' | 'macro' | 'whale';
  title: string;
  content: string;
  meta?: Record<string, unknown>;
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
  () => props.source === 'whale' || props.source === 'x' || props.source === 'macro',
);

const dialogTitle = computed(() =>
  props.source === 'macro'
    ? '宏观智能分析'
    : props.source === 'whale'
      ? '巨鲸智能分析'
      : '动态智能分析',
);

const dialogWidth = computed(() => (isLarge.value ? '780px' : '520px'));

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
      value: props.source === 'macro' ? '宏观日历' : 'X 动态',
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
</script>

<template>
  <el-dialog
    :model-value="visible"
    class="ai-analyze-modal"
    :class="{ large: isLarge }"
    :width="dialogWidth"
    append-to-body
    destroy-on-close
    :show-close="false"
    :title="dialogTitle"
    @update:model-value="emit('update:visible', $event)"
  >
    <template #header>
      <div class="modal-header-inner">
        <h2 class="modal-title">{{ dialogTitle }}</h2>
        <button type="button" class="close-btn" aria-label="关闭" @click="close">&times;</button>
      </div>
    </template>

    <div class="modal-body" :class="{ large: isLarge }">
      <div v-if="infoRows.length" class="info-block">
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
  </el-dialog>
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
  color: #fff;
  display: flex;
  align-items: center;
  gap: 8px;
}
.modal-title::before {
  content: '';
  display: inline-block;
  width: 4px;
  height: 16px;
  background: #3b82f6;
  border-radius: 2px;
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
  color: #e2e8f0;
  word-break: break-all;
}
.info-value.highlight {
  color: #10b981;
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
  background: rgba(59, 130, 246, 0.18);
  border-color: #3b82f6;
  color: #93c5fd;
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
  background: #3b82f6;
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
  color: #3b82f6;
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

.analysis-stream :deep(.analysis-list) {
  margin: 0;
  padding-left: 20px;
}
.analysis-stream :deep(.analysis-list li) {
  margin-bottom: 10px;
}
.analysis-stream :deep(.analysis-list li::marker) {
  color: #3b82f6;
}
.analysis-stream :deep(.analysis-p) {
  margin: 0 0 10px;
}
.analysis-stream :deep(.text-green) {
  color: #10b981;
  font-weight: 600;
}
.analysis-stream :deep(.text-red) {
  color: #ef4444;
  font-weight: 600;
}
.analysis-stream :deep(.text-yellow) {
  color: #f59e0b;
  font-weight: 600;
}
.analysis-stream :deep(.text-blue) {
  color: #3b82f6;
  font-weight: 500;
}
.analysis-stream :deep(.data-badge) {
  display: inline-block;
  background: rgba(255, 255, 255, 0.05);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  margin: 0 2px;
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
  background: #3b82f6;
  color: #fff;
}
.btn-primary:hover:not(:disabled) {
  background: #2563eb;
}
</style>
