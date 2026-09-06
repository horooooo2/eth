<script setup lang="ts">
import { computed } from 'vue';
import { pnlBarWidth } from '@/utils/whaleCardUtils';

const props = withDefaults(
  defineProps<{
    pct: number | null;
    compact?: boolean;
    showLabel?: boolean;
  }>(),
  {
    compact: false,
    showLabel: true,
  },
);

const width = computed(() => pnlBarWidth(props.pct));
const label = computed(() => {
  if (props.pct == null) return '--';
  const sign = props.pct > 0 ? '+' : '';
  return `${sign}${props.pct.toFixed(1)}%`;
});
</script>

<template>
  <div class="pnl-progress" :class="{ compact, up: (pct ?? 0) > 0, down: (pct ?? 0) < 0, flat: !pct }">
    <div class="track">
      <div class="fill" :style="{ width: `${width}%` }" />
    </div>
    <span v-if="showLabel" class="label">{{ label }}</span>
  </div>
</template>

<style scoped>
.pnl-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.pnl-progress.compact {
  gap: 6px;
}
.track {
  flex: 1 1 auto;
  height: 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--border) 80%, transparent);
  overflow: hidden;
}
.compact .track {
  height: 4px;
}
.fill {
  height: 100%;
  border-radius: inherit;
  transition: width 0.2s ease;
}
.up .fill {
  background: linear-gradient(90deg, color-mix(in srgb, var(--bull) 55%, transparent), var(--bull));
}
.down .fill {
  background: linear-gradient(90deg, color-mix(in srgb, var(--bear) 55%, transparent), var(--bear));
}
.flat .fill {
  width: 0 !important;
}
.label {
  flex: 0 0 auto;
  font-size: 12px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  min-width: 3.2em;
  text-align: right;
}
.up .label {
  color: var(--bull);
}
.down .label {
  color: var(--bear);
}
.flat .label {
  color: var(--muted);
}
</style>
