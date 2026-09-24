<script setup lang="ts">
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { aiKeyReady } from '@/stores/aiKey';
import AiAnalyzeDialog from '@/components/AiAnalyzeDialog.vue';

const props = defineProps<{
  source: 'x' | 'macro' | 'whale';
  title: string;
  content: string;
  meta?: Record<string, unknown>;
  /** 按钮文案，默认「分析」；巨鲸列表可用「AI」 */
  label?: string;
}>();

const open = ref(false);

function onClick(ev: Event) {
  ev.stopPropagation();
  if (!aiKeyReady.value) {
    ElMessage.warning('请先在侧栏「币种偏好」中配置 DeepSeek API Key');
    return;
  }
  open.value = true;
}
</script>

<template>
  <button
    type="button"
    class="ai-chip"
    :class="{ whale: source === 'whale' }"
    :title="source === 'whale' ? 'AI 分析该巨鲸' : '智能分析'"
    @click="onClick"
  >
    {{ label || '分析' }}
  </button>
  <AiAnalyzeDialog
    v-if="aiKeyReady"
    v-model:visible="open"
    :source="props.source"
    :title="props.title"
    :content="props.content"
    :meta="props.meta"
  />
</template>

<style scoped>
.ai-chip {
  flex: 0 0 auto;
  height: 20px;
  padding: 0 7px;
  border: 1px solid color-mix(in srgb, #1f6feb 55%, var(--border, #2d333b));
  border-radius: 6px;
  background: color-mix(in srgb, #1f6feb 16%, transparent);
  color: #79b8ff;
  font: inherit;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.04em;
  line-height: 18px;
  cursor: pointer;
}
.ai-chip.whale {
  height: 24px;
  padding: 0 8px;
  border-radius: 999px;
  border-color: color-mix(in srgb, #a855f7 50%, var(--border, #2d333b));
  background: color-mix(in srgb, #a855f7 16%, transparent);
  color: #c4b5fd;
}
.ai-chip:hover {
  filter: brightness(1.12);
}
</style>
