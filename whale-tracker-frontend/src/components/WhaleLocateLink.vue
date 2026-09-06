<script setup lang="ts">
import { computed } from 'vue';
import { resolveWhaleTitle, type WhaleTitleFields } from '@/utils/whaleReference';

const props = defineProps<{
  id: string;
  name: string;
  address?: string;
  coin?: string;
  title?: string;
  whales?: Array<WhaleTitleFields & { id?: string }>;
}>();

const emit = defineEmits<{
  locate: [payload: { id: string; name: string; coin?: string }];
}>();

const displayTitle = computed(() =>
  resolveWhaleTitle(props.whales, {
    id: props.id,
    name: props.name,
    address: props.address,
  }),
);

function onClick() {
  emit('locate', { id: props.id, name: props.name, coin: props.coin });
}
</script>

<template>
  <button
    type="button"
    class="whale-locate-link"
    :title="title || `点击定位 ${displayTitle}`"
    @click.stop="onClick"
  >
    <slot>{{ displayTitle }}</slot>
  </button>
</template>

<style scoped>
.whale-locate-link {
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--accent);
  font: inherit;
  font-weight: 700;
  cursor: pointer;
  text-align: inherit;
}
.whale-locate-link:hover {
  text-decoration: underline;
}
</style>
