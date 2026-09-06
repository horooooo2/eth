<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { fetchPagedAlertHistory } from '@/api';
import { normalizeStoredAlert, type WhaleAlert } from '@/utils/whaleAlerts';
import {
  absorbOpenEvidence,
  applyFreshModeWithProgress,
  disableFreshMode,
  freshApplyBusy,
  freshApplyLabel,
  freshApplyProgress,
  freshModeEnabled,
  freshModeTitle,
  freshWindowHours,
  freshWindowMs,
  FRESH_WINDOW_PRESETS,
  rebuildFreshOpenIndex,
  type FreshWindowPreset,
} from '@/utils/freshMode';

const emit = defineEmits<{
  applied: [];
}>();

const props = defineProps<{
  reloadAlerts?: () => void | Promise<void>;
}>();

const dialogOpen = ref(false);
const draftPreset = ref<FreshWindowPreset>(2);

const activeLabel = computed(() =>
  freshModeEnabled.value ? `${freshWindowHours.value}h` : '',
);

watch(dialogOpen, (open) => {
  if (!open) return;
  draftPreset.value = freshWindowHours.value;
});

/** 刷新进入且已开启时：静默补证据，不全屏 */
onMounted(() => {
  if (!freshModeEnabled.value) return;
  void (async () => {
    try {
      const sinceMs = Date.now() - Math.max(freshWindowMs(), 2 * 3600 * 1000);
      const data = await fetchPagedAlertHistory({
        page: 1,
        limit: 100,
        kind: 'open',
        sinceMs,
      });
      const opens = (data.alerts || [])
        .map((item) => normalizeStoredAlert(item as WhaleAlert))
        .filter((item): item is WhaleAlert => Boolean(item));
      absorbOpenEvidence(opens);
      await rebuildFreshOpenIndex();
    } catch {
      // ignore
    }
  })();
});

function pickPreset(hours: FreshWindowPreset) {
  draftPreset.value = hours;
}

function onLightningClick() {
  if (freshApplyBusy.value) return;
  dialogOpen.value = true;
}

async function runApply(hours: FreshWindowPreset, successText: string) {
  dialogOpen.value = false;
  const result = await applyFreshModeWithProgress(hours, {
    fetchOpenAlerts: async (sinceMs) => {
      const data = await fetchPagedAlertHistory({
        page: 1,
        limit: 100,
        kind: 'open',
        sinceMs,
      });
      return (data.alerts || [])
        .map((item) => normalizeStoredAlert(item as WhaleAlert))
        .filter((item): item is WhaleAlert => Boolean(item));
    },
    reloadAlertPage: async () => {
      await props.reloadAlerts?.();
    },
  });
  if (result === 'ok') {
    ElMessage.success(successText);
    emit('applied');
  } else if (result === 'timeout') {
    ElMessage.warning('处理超时（约 20 秒）。可关闭闪电模式或改用更短窗口后重试');
  } else {
    ElMessage.error('闪电模式开启失败');
  }
}

function onEnable() {
  void runApply(draftPreset.value, `已开启闪电模式：近 ${draftPreset.value} 小时`);
}

function onSwitch() {
  void runApply(draftPreset.value, `已切换为近 ${draftPreset.value} 小时`);
}

function onDisable() {
  dialogOpen.value = false;
  disableFreshMode();
  ElMessage.success('已关闭闪电模式');
}
</script>

<template>
  <div class="fresh-wrap">
    <button
      type="button"
      class="fresh-btn"
      :class="{ on: freshModeEnabled }"
      :title="freshModeTitle"
      aria-label="闪电模式"
      :disabled="freshApplyBusy"
      @click="onLightningClick"
    >
      <svg class="bolt" viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="currentColor"
          d="M13 2 4.5 13.5h6L10 22l9.5-12.5h-6L13 2z"
        />
      </svg>
      <span v-if="freshModeEnabled" class="fresh-hours">{{ activeLabel }}</span>
    </button>

    <el-dialog
      v-model="dialogOpen"
      title="闪电模式"
      width="420px"
      append-to-body
      destroy-on-close
      class="fresh-dialog"
    >
      <p class="hint">
        只统计近 {{ draftPreset }} 小时内新开仓的仓位及其后续行为；更早开仓上的补仓会隐藏。
      </p>
      <div class="presets">
        <button
          v-for="h in FRESH_WINDOW_PRESETS"
          :key="h"
          type="button"
          class="chip"
          :class="{ on: draftPreset === h }"
          @click="pickPreset(h)"
        >
          {{ h }}h
        </button>
      </div>
      <template #footer>
        <template v-if="freshModeEnabled">
          <el-button type="primary" @click="onSwitch">切换</el-button>
          <el-button @click="onDisable">关闭</el-button>
        </template>
        <el-button v-else type="primary" @click="onEnable">开启</el-button>
      </template>
    </el-dialog>

    <Teleport to="body">
      <div v-if="freshApplyBusy" class="fresh-mask" role="alert" aria-live="polite">
        <div class="fresh-mask-card">
          <p class="mask-title">正在处理数据</p>
          <p class="mask-label">{{ freshApplyLabel || '请稍候…' }}</p>
          <div class="bar-track">
            <div class="bar-fill" :style="{ width: `${freshApplyProgress}%` }" />
          </div>
          <p class="mask-pct">{{ freshApplyProgress }}%</p>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.fresh-wrap {
  display: inline-flex;
  align-items: center;
}
.fresh-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  min-width: 32px;
  padding: 0 10px;
  border: 1px solid #2a3544;
  border-radius: 999px;
  background: #141a24;
  color: #6a7e9c;
  cursor: pointer;
  font: inherit;
  transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
}
.fresh-btn:disabled {
  opacity: 0.55;
  cursor: wait;
}
.fresh-btn:hover:not(:disabled) {
  color: #b0c4de;
  border-color: #3a4a5c;
}
.fresh-btn.on {
  color: #3b82f6;
  border-color: color-mix(in srgb, #3b82f6 55%, #2a3544);
  background: color-mix(in srgb, #3b82f6 14%, #141a24);
  font-weight: 800;
}
.bolt {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
.fresh-btn.on .bolt {
  filter: drop-shadow(0 0 4px color-mix(in srgb, #3b82f6 50%, transparent));
}
.fresh-hours {
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.02em;
}
.hint {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--soft, #8b9bb5);
  text-align: left;
}
.hint strong {
  color: var(--text, #e8edf5);
  font-weight: 700;
}
.presets {
  display: flex;
  flex-wrap: nowrap;
  justify-content: flex-start;
  align-items: center;
  gap: 10px;
}
.chip {
  border: 1px solid #2a3544;
  background: #1a222e;
  color: #b0c4de;
  border-radius: 999px;
  padding: 7px 14px;
  font: inherit;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  flex: 0 0 auto;
}
.chip.on {
  color: #fff;
  background: #2563eb;
  border-color: #2563eb;
}
.fresh-mask {
  position: fixed;
  inset: 0;
  z-index: 5000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, #0b0e14 72%, transparent);
  backdrop-filter: blur(3px);
}
.fresh-mask-card {
  width: min(360px, calc(100vw - 40px));
  padding: 22px 24px;
  border-radius: 14px;
  border: 1px solid #2a3544;
  background: #141a24;
  color: #e8edf5;
  text-align: center;
  box-shadow: 0 16px 48px #00000066;
}
.mask-title {
  margin: 0;
  font-size: 16px;
  font-weight: 800;
}
.mask-label {
  margin: 8px 0 16px;
  font-size: 13px;
  color: #8b9bb5;
  min-height: 1.2em;
}
.bar-track {
  height: 8px;
  border-radius: 999px;
  background: #1a222e;
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #2563eb, #60a5fa);
  transition: width 0.18s ease;
}
.mask-pct {
  margin: 10px 0 0;
  font-size: 13px;
  font-weight: 700;
  color: #b0c4de;
  font-variant-numeric: tabular-nums;
}
</style>

<style>
/* 弹窗 footer 按钮右对齐（append-to-body 时不受 scoped 限制） */
.fresh-dialog .el-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}
.fresh-dialog .el-dialog__body {
  padding-top: 12px;
}
</style>
