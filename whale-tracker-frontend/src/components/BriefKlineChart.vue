<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';

export type ChartCandle = { t: number; o: number; h: number; l: number; c: number };
export type ChartLevel = { key: string; price: number; label: string };
export type ChartPack = { candles: ChartCandle[]; levels?: ChartLevel[] } | null;

const props = defineProps<{
  m5?: ChartPack;
  hour?: ChartPack;
  day?: ChartPack;
  modelValue?: '5m' | '1h' | '1d';
}>();

const emit = defineEmits<{
  'update:modelValue': [v: '5m' | '1h' | '1d'];
}>();

const tf = computed({
  get: () => props.modelValue || '1d',
  set: (v: '5m' | '1h' | '1d') => emit('update:modelValue', v),
});
const canvasRef = ref<HTMLCanvasElement | null>(null);
let resizeObs: ResizeObserver | null = null;

const active = computed(() => {
  if (tf.value === '5m') return props.m5;
  if (tf.value === '1h') return props.hour;
  return props.day;
});
const hasAny = computed(() =>
  Boolean(props.m5?.candles?.length || props.hour?.candles?.length || props.day?.candles?.length),
);

const LEVEL_COLOR: Record<string, string> = {
  breakout: '#f59e0b',
  breakdown: '#f6465d',
  resistance: '#f6465d',
  support: '#0ecb81',
  swingLow: '#38bdf8',
};

function draw() {
  const canvas = canvasRef.value;
  const pack = active.value;
  if (!canvas || !pack?.candles?.length) return;

  const parent = canvas.parentElement;
  const cssW = Math.max(280, parent?.clientWidth || 320);
  const cssH = 220;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  // 右侧放宽，并做标签避让，避免压力位文字被裁切
  const pad = { l: 8, r: 118, t: 14, b: 20 };
  const candles = pack.candles;
  const levels = pack.levels || [];
  let min = Math.min(...candles.map((c) => c.l));
  let max = Math.max(...candles.map((c) => c.h));
  for (const lv of levels) {
    if (Number.isFinite(lv.price)) {
      min = Math.min(min, lv.price);
      max = Math.max(max, lv.price);
    }
  }
  const span = max - min || 1;
  min -= span * 0.05;
  max += span * 0.08;
  const plotW = cssW - pad.l - pad.r;
  const plotH = cssH - pad.t - pad.b;
  const n = candles.length;
  const slot = plotW / n;
  const bodyW = Math.max(2, slot * 0.55);

  const yOf = (p: number) => pad.t + ((max - p) / (max - min)) * plotH;

  ctx.strokeStyle = 'rgba(132,142,156,0.18)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i += 1) {
    const y = pad.t + (plotH * i) / 3;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(cssW - pad.r, y);
    ctx.stroke();
  }

  candles.forEach((c, i) => {
    const x = pad.l + slot * i + slot / 2;
    const up = c.c >= c.o;
    const color = up ? '#0ecb81' : '#f6465d';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, yOf(c.h));
    ctx.lineTo(x, yOf(c.l));
    ctx.stroke();
    const y1 = yOf(Math.max(c.o, c.c));
    const y2 = yOf(Math.min(c.o, c.c));
    const h = Math.max(1, y2 - y1);
    ctx.fillRect(x - bodyW / 2, y1, bodyW, h);
  });

  // 标签纵向避让
  const labelRows = levels
    .filter((lv) => Number.isFinite(lv.price))
    .map((lv) => ({
      ...lv,
      y: yOf(lv.price),
      color: LEVEL_COLOR[lv.key] || '#a855f7',
    }))
    .sort((a, b) => a.y - b.y);

  for (let i = 1; i < labelRows.length; i += 1) {
    const gap = 15;
    if (labelRows[i].y - labelRows[i - 1].y < gap) {
      labelRows[i].y = labelRows[i - 1].y + gap;
    }
  }
  const maxY = cssH - 8;
  for (let i = labelRows.length - 1; i >= 0; i -= 1) {
    if (labelRows[i].y > maxY) labelRows[i].y = maxY - (labelRows.length - 1 - i) * 15;
  }
  for (let i = 1; i < labelRows.length; i += 1) {
    if (labelRows[i].y - labelRows[i - 1].y < 15) {
      labelRows[i].y = labelRows[i - 1].y + 15;
    }
  }

  ctx.font = '11px system-ui, sans-serif';
  for (const lv of labelRows) {
    const lineY = yOf(lv.price);
    ctx.strokeStyle = lv.color;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.l, lineY);
    ctx.lineTo(cssW - pad.r, lineY);
    ctx.stroke();
    ctx.setLineDash([]);

    // 引导线到避让后的文字位置
    if (Math.abs(lv.y - lineY) > 2) {
      ctx.strokeStyle = lv.color;
      ctx.globalAlpha = 0.45;
      ctx.beginPath();
      ctx.moveTo(cssW - pad.r, lineY);
      ctx.lineTo(cssW - pad.r + 8, lv.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = lv.color;
    const text = `${lv.label} ${lv.price}`;
    ctx.fillText(text, cssW - pad.r + 10, lv.y + 4);
  }

  const last = candles[candles.length - 1];
  if (last) {
    const y = Math.min(cssH - 8, Math.max(12, yOf(last.c)));
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText(String(last.c), 10, y);
  }
}

function scheduleDraw() {
  nextTick(() => draw());
}

watch([() => tf.value, () => props.m5, () => props.hour, () => props.day], scheduleDraw, { deep: true });

onMounted(() => {
  scheduleDraw();
  if (canvasRef.value?.parentElement && typeof ResizeObserver !== 'undefined') {
    resizeObs = new ResizeObserver(() => scheduleDraw());
    resizeObs.observe(canvasRef.value.parentElement);
  }
});

onUnmounted(() => {
  resizeObs?.disconnect();
  resizeObs = null;
});
</script>

<template>
  <div v-if="hasAny" class="kline-wrap">
    <div class="kline-tabs">
      <button type="button" class="kline-tab" :class="{ active: tf === '5m' }" @click="tf = '5m'">
        5分钟
      </button>
      <button type="button" class="kline-tab" :class="{ active: tf === '1h' }" @click="tf = '1h'">
        小时线
      </button>
      <button type="button" class="kline-tab" :class="{ active: tf === '1d' }" @click="tf = '1d'">
        日线
      </button>
    </div>
    <div v-if="active?.candles?.length" class="kline-canvas-box">
      <canvas ref="canvasRef" />
    </div>
    <div v-else class="kline-empty">当前周期暂无 K 线数据</div>
    <div v-if="active?.levels?.length" class="kline-legend">
      <span v-for="lv in active.levels" :key="lv.key + '-' + lv.price" class="leg" :data-k="lv.key">
        {{ lv.label }} {{ lv.price }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.kline-wrap {
  margin-bottom: 10px;
  max-width: 100%;
  overflow-x: hidden;
}

.kline-tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.kline-tab {
  height: 28px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  font-weight: 650;
  cursor: pointer;
}

.kline-tab.active {
  color: var(--text);
  border-color: color-mix(in srgb, #6366f1 45%, var(--border));
  background: color-mix(in srgb, #6366f1 14%, var(--panel-2));
}

.kline-canvas-box {
  width: 100%;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--panel-2) 92%, #000 8%);
  overflow: hidden;
}

.kline-empty {
  font-size: 12px;
  color: var(--soft);
  padding: 20px;
  text-align: center;
  border: 1px dashed var(--border);
  border-radius: 10px;
}

.kline-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
  max-width: 100%;
}

.leg {
  font-size: 11px;
  color: var(--muted);
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
}

.leg[data-k='support'],
.leg[data-k='swingLow'] {
  color: #0ecb81;
  border-color: rgba(14, 203, 129, 0.35);
}

.leg[data-k='resistance'],
.leg[data-k='breakdown'] {
  color: #f6465d;
  border-color: rgba(246, 70, 93, 0.35);
}

.leg[data-k='breakout'] {
  color: #f59e0b;
  border-color: rgba(245, 158, 11, 0.4);
}
</style>
