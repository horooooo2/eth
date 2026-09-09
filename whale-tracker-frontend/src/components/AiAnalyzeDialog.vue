<script setup lang="ts">
import { ref, watch } from 'vue';
import { analyzeWithWhaleAi } from '@/api';

const props = defineProps<{
  visible: boolean;
  source: 'x' | 'macro';
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
let reqSeq = 0;

async function runAnalyze() {
  const seq = ++reqSeq;
  loading.value = true;
  error.value = '';
  analysis.value = '';
  try {
    const data = await analyzeWithWhaleAi({
      source: props.source,
      title: props.title,
      content: props.content,
      meta: props.meta,
    });
    if (seq !== reqSeq) return;
    analysis.value = data.analysis || '';
    if (!analysis.value) error.value = '未返回分析结果';
  } catch (err) {
    if (seq !== reqSeq) return;
    error.value = err instanceof Error ? err.message : '分析失败';
  } finally {
    if (seq === reqSeq) loading.value = false;
  }
}

watch(
  () => props.visible,
  (open) => {
    if (open) void runAnalyze();
    else {
      reqSeq += 1;
      loading.value = false;
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
    class="ai-analyze-dialog"
    width="560px"
    append-to-body
    destroy-on-close
    :title="source === 'macro' ? '宏观智能分析' : '动态智能分析'"
    @update:model-value="emit('update:visible', $event)"
  >
    <div class="body">
      <div class="subject">
        <strong>{{ title || '（无标题）' }}</strong>
        <p v-if="content" class="preview">{{ content }}</p>
      </div>
      <el-skeleton v-if="loading" :rows="5" animated />
      <el-alert v-else-if="error" type="error" :closable="false" :title="error" />
      <div v-else class="result">{{ analysis }}</div>
    </div>
    <template #footer>
      <button type="button" class="ghost" @click="close">关闭</button>
      <button type="button" class="primary" :disabled="loading" @click="runAnalyze">
        {{ loading ? '分析中…' : '重新分析' }}
      </button>
    </template>
  </el-dialog>
</template>

<style scoped>
.body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.subject strong {
  display: block;
  font-size: 15px;
  line-height: 1.4;
  color: var(--text, #e6edf3);
}
.preview {
  margin: 8px 0 0;
  max-height: 88px;
  overflow: auto;
  white-space: pre-wrap;
  font-size: 12px;
  line-height: 1.5;
  color: var(--muted, #8b949e);
}
.result {
  white-space: pre-wrap;
  font-size: 14px;
  line-height: 1.7;
  color: var(--text, #e6edf3);
  max-height: min(52vh, 420px);
  overflow: auto;
}
.ghost,
.primary {
  height: 34px;
  padding: 0 14px;
  border-radius: 8px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.ghost {
  border: 1px solid var(--border, #2d333b);
  background: transparent;
  color: var(--muted, #8b949e);
  margin-right: 8px;
}
.primary {
  border: 0;
  background: #1f6feb;
  color: #fff;
}
.primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
