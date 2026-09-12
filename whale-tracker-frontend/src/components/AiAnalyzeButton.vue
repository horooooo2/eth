<script setup lang="ts">
import { ref } from 'vue';
import { aiKeyReady } from '@/stores/aiKey';
import AiAnalyzeDialog from '@/components/AiAnalyzeDialog.vue';

const props = defineProps<{
  source: 'x' | 'macro';
  title: string;
  content: string;
  meta?: Record<string, unknown>;
}>();

const open = ref(false);

function onClick(ev: Event) {
  ev.stopPropagation();
  open.value = true;
}
</script>

<template>
  <button
    v-if="aiKeyReady"
    type="button"
    class="ai-chip"
    title="智能分析"
    @click="onClick"
  >
    分析
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
.ai-chip:hover {
  filter: brightness(1.12);
}
</style>
