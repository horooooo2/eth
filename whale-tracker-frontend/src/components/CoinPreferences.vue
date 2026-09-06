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
    ElMessage.warning('至少保留一个币种');
    return;
  }
  draftCoins.value = draftCoins.value.filter((item) => item !== id);
}

async function confirmPrefs() {
  const appliedCoins = readWatchedCoins();
  const coinsChanged = JSON.stringify(draftCoins.value) !== JSON.stringify(appliedCoins);

  if (!coinsChanged) {
    closePrefs();
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
  <div class="coin-prefs">
    <button type="button" class="prefs-trigger" title="币种偏好设置" @click="openPrefs">
      币种
    </button>
    <el-dialog
      v-model="prefsVisible"
      title="币种偏好设置"
      width="min(520px, 94vw)"
      class="coin-prefs-dialog"
      append-to-body
      :show-close="false"
      @close="resetDraft"
    >
      <div class="dialog-body">
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

.dialog-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 260px;
  padding: 4px 2px 8px;
}

.intro {
  margin: 0;
  color: #8b9bb5;
  font-size: 13px;
  line-height: 1.6;
}

.coin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(108px, 1fr));
  gap: 10px;
  min-height: 160px;
  padding: 14px;
  border: 1px solid #1f2937;
  border-radius: 14px;
  background: #10171f;
  align-content: start;
}

.coin-chip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 40px;
  padding: 0 12px;
  border: 1px solid #1f2937;
  border-radius: 999px;
  background: #1a222e;
}

.coin-label {
  font-size: 14px;
  font-weight: 800;
  letter-spacing: 0.04em;
  color: #e8edf5;
}

.coin-empty {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 120px;
  color: #6a7e9c;
  font-size: 14px;
}

.pref-add {
  display: flex;
  gap: 10px;
}

.pref-add .el-input {
  flex: 1 1 auto;
}
.pref-add :deep(.el-input__wrapper) {
  min-height: 42px;
  border-radius: 12px;
  background: #10171f;
  box-shadow: 0 0 0 1px #1f2937 inset;
}

.chip-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: #6a7e9c;
  cursor: pointer;
  flex-shrink: 0;
}

.chip-remove:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.chip-remove:hover:not(:disabled) {
  color: #f0f4fa;
  background: #2a3a52;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  width: 100%;
}

.dlg-btn {
  border: 0;
  border-radius: 12px;
  padding: 10px 18px;
  font: inherit;
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
}
.dlg-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.dlg-btn.ghost {
  background: #1a222e;
  color: #b0c4de;
}
.dlg-btn.ghost:hover:not(:disabled) {
  background: #2a3a52;
  color: #f0f4fa;
}
.dlg-btn.primary {
  background: #2a4a6a;
  color: #f0f4fa;
}
.dlg-btn.primary:hover:not(:disabled) {
  background: #345878;
}

:deep(.coin-prefs-dialog .el-dialog__footer) {
  padding: 8px 20px 18px;
}
</style>

<style>
.coin-prefs-dialog.el-dialog {
  background: #141a24 !important;
  border: 1px solid #1f2937;
  border-radius: 16px;
  overflow: hidden;
}
.coin-prefs-dialog .el-dialog__header {
  padding: 16px 20px 8px;
  margin: 0;
}
.coin-prefs-dialog .el-dialog__title {
  color: #e8edf5;
  font-weight: 700;
}
.coin-prefs-dialog .el-dialog__body {
  padding: 8px 20px;
}
.coin-prefs-dialog .el-dialog__footer {
  padding: 8px 20px 18px;
}
</style>
