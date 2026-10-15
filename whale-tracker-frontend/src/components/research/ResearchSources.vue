<script setup lang="ts">
import type { ResearchModel } from '@/composables/useContractResearch';
defineProps<{ model: ResearchModel; ids?: string[] }>();
</script>
<template>
  <div v-if="ids?.length" class="research-source-links">
    <template v-for="id in ids" :key="id">
      <a v-if="model.safeUrl(model.sourceById(id)?.url)" :href="model.safeUrl(model.sourceById(id)?.url)" target="_blank" rel="noopener noreferrer">{{ model.sourceById(id)?.title || '查看来源' }} ↗</a>
      <span v-else>{{ model.sourceById(id)?.title || id }}</span>
    </template>
  </div>
</template>
