<script setup lang="ts">
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Close } from '@element-plus/icons-vue';
import { lookupMarketCoin } from '@/api';
import {
  MAX_PREFERRED_COINS,
  readWatchedCoins,
  writePreferredCoins,
} from '@/utils/watchedCoins';

const props = defineProps<{
  variant?: 'default' | 'sidebar';
}>();

const emit = defineEmits<{
  change: [];
}>();

const prefsVisible = ref(false);
const saving = ref(false);
const prefAddSymbol = ref('');
const prefAddLoading = ref(false);
const draftCoins = ref<string[]>([]);

function normalizeInput(raw: string) {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[-_/]/g, '')
    .replace(/USDT$|USD$|PERP$/, '')
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 12);
}

function resetDraft() {
  draftCoins.value = [...readWatchedCoins()];
  prefAddSymbol.value = '';
}

function openPrefs() {
  resetDraft();
  prefsVisible.value = true;
}

function closePrefs() {
  prefsVisible.value = false;
  resetDraft();
}

async function submitPrefAdd() {
  const id = normalizeInput(prefAddSymbol.value);
  if (!id || id.length < 2) {
    ElMessage.error('请输入币种，例如 ZEC');
    return;
  }
  if (draftCoins.value.includes(id)) {
    ElMessage.warning('该币种已在偏好列表中');
    prefAddSymbol.value = '';
    return;
  }
  if (draftCoins.value.length >= MAX_PREFERRED_COINS) {
    ElMessage.warning(`最多添加 ${MAX_PREFERRED_COINS} 个币种`);
    return;
  }
  prefAddLoading.value = true;
  try {
    const found = await lookupMarketCoin(id);
    draftCoins.value = [...draftCoins.value, found.id];
    prefAddSymbol.value = '';
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '币种输入错误，请检查后再试');
  } finally {
    prefAddLoading.value = false;
  }
}

function removeDraftCoin(id: string) {
  if (draftCoins.value.length <= 1) {
    ElMessage.warning('至少保留 1 个币种');
    return;
  }
  draftCoins.value = draftCoins.value.filter((item) => item !== id);
}

async function confirmPrefs() {
  if (saving.value) return;
  if (!draftCoins.value.length) {
    ElMessage.warning('至少保留 1 个币种');
    return;
  }
  saving.value = true;
  try {
    writePreferredCoins(draftCoins.value);
    prefsVisible.value = false;
    emit('change');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="coin-prefs" :class="{ sidebar: props.variant === 'sidebar' }">
    <button
      type="button"
      class="prefs-trigger"
      :class="{ sidebar: props.variant === 'sidebar' }"
      title="设置"
      @click="openPrefs"
    >
      <svg
        v-if="props.variant === 'sidebar'"
        class="prefs-icon"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          fill="currentColor"
          d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.07 7.07 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.8a.5.5 0 0 0-.49.42l-.36 2.54c-.6.24-1.14.55-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.48a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.83 14.58a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.43.34.68.22l2.39-.96c.49.39 1.03.7 1.63.94l.36 2.54c.05.24.25.42.49.42h3.8c.24 0 .44-.18.49-.42l.36-2.54c.6-.24 1.14-.55 1.63-.94l2.39.96c.25.12.54.02.68-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z"
        />
      </svg>
      <span>{{ props.variant === 'sidebar' ? '设置' : '币种' }}</span>
    </button>
    <el-dialog
      v-model="prefsVisible"
      title="设置"
      width="min(520px, 94vw)"
      class="coin-prefs-dialog"
      append-to-body
      :show-close="false"
      @close="resetDraft"
    >
      <div class="dialog-body">
        <section class="setting-block">
          <h4 class="block-title">币种偏好</h4>
          <p class="intro">
            全站分析与异动记录的币种筛选，均按此列表执行。至少保留 1 个币种。
          </p>

          <div class="coin-grid">
            <div v-for="id in draftCoins" :key="id" class="coin-chip">
              <span class="coin-label">{{ id }}</span>
              <button
                type="button"
                class="chip-remove"
                title="移除币种"
                :disabled="draftCoins.length <= 1"
                @click="removeDraftCoin(id)"
              >
                <el-icon><Close /></el-icon>
              </button>
            </div>
            <div v-if="!draftCoins.length" class="coin-empty">暂无币种</div>
          </div>

          <div class="pref-add">
            <el-input
              v-model="prefAddSymbol"
              size="large"
              placeholder="输入币种代码，例如 ZEC、SOL"
              maxlength="16"
              @keyup.enter="submitPrefAdd"
            />
            <button type="button" class="dlg-btn primary" :disabled="prefAddLoading" @click="submitPrefAdd">
              {{ prefAddLoading ? '…' : '添加' }}
            </button>
          </div>
        </section>
      </div>

      <template #footer>
        <div class="dialog-footer">
          <button type="button" class="dlg-btn ghost" @click="closePrefs">取消</button>
          <button type="button" class="dlg-btn primary" :disabled="saving" @click="confirmPrefs">
            {{ saving ? '…' : '确认' }}
          </button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.coin-prefs {
  display: inline-flex;
  align-items: center;
}

.prefs-trigger {
  border: 0;
  border-radius: 999px;
  padding: 6px 14px;
  min-height: 32px;
  background: #1a222e;
  color: #b0c4de;
  font: inherit;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.prefs-trigger:hover {
  background: #2a3a52;
  color: #f0f4fa;
}
.coin-prefs.sidebar {
  width: 100%;
  display: flex;
  justify-content: center;
}
.prefs-trigger.sidebar {
  width: 56px;
  height: 48px;
  min-height: 48px;
  padding: 0;
  border-radius: 14px;
  background: transparent;
  color: #6a7e9c;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.prefs-trigger.sidebar:hover {
  background: #1a222e;
  color: #e8edf5;
}
.prefs-icon {
  width: 18px;
  height: 18px;
}

.dialog-body {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.setting-block {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.block-title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: #e8edf5;
}
.intro {
  margin: 0;
  color: #8b9bb4;
  font-size: 13px;
  line-height: 1.5;
}
.coin-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.coin-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px 6px 12px;
  border-radius: 999px;
  background: #1a222e;
  border: 1px solid #2a3548;
}
.coin-label {
  font-size: 13px;
  font-weight: 700;
  color: #e8edf5;
}
.chip-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: #8b9bb4;
  cursor: pointer;
}
.chip-remove:hover:not(:disabled) {
  color: #f56c6c;
  background: rgba(245, 108, 108, 0.12);
}
.chip-remove:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.coin-empty {
  color: #6a7e9c;
  font-size: 13px;
}
.pref-add {
  display: flex;
  gap: 8px;
  align-items: center;
}
.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.dlg-btn {
  border: 0;
  border-radius: 10px;
  padding: 8px 16px;
  font: inherit;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}
.dlg-btn.primary {
  background: #3d7eff;
  color: #fff;
}
.dlg-btn.primary:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.dlg-btn.ghost {
  background: #1a222e;
  color: #b0c4de;
}
.dlg-btn.ghost:hover {
  background: #2a3a52;
}
</style>
