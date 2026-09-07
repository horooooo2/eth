<script setup lang="ts">
import { ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Close } from '@element-plus/icons-vue';
import { deleteOkxExchangeKeys, lookupMarketCoin } from '@/api';
import { isLoggedIn } from '@/stores/auth';
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
  'reset-copy-api': [];
}>();

const prefsVisible = ref(false);
const saving = ref(false);
const resettingApi = ref(false);
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

async function resetCopyApi() {
  if (!isLoggedIn.value) {
    ElMessage.warning('请先登录后再重置跟单 API');
    return;
  }
  try {
    await ElMessageBox.confirm(
      '将清除已保存的 OKX API Key / Secret / Passphrase。\n清除后需重新填写才能继续跟单。',
      '重置跟单 API',
      {
        confirmButtonText: '确认重置',
        cancelButtonText: '取消',
        type: 'warning',
      },
    );
  } catch {
    return;
  }
  resettingApi.value = true;
  try {
    await deleteOkxExchangeKeys();
    prefsVisible.value = false;
    window.dispatchEvent(new CustomEvent('whale-copy-keys-reset'));
    emit('reset-copy-api');
    ElMessage.success('跟单 API 已清除，请重新配置');
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '重置失败');
  } finally {
    resettingApi.value = false;
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

        <section class="setting-block api-block">
          <h4 class="block-title">跟单 API</h4>
          <p class="intro">
            清除已保存的 OKX 密钥后可重新绑定。日常切换模拟/实盘请到跟单页点「API」。
          </p>
          <button
            type="button"
            class="dlg-btn danger"
            :disabled="!isLoggedIn || resettingApi"
            @click="resetCopyApi"
          >
            {{ resettingApi ? '重置中…' : '重置跟单 API' }}
          </button>
          <p v-if="!isLoggedIn" class="hint-dim">登录后可重置</p>
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
}
.prefs-trigger.sidebar .prefs-icon {
  width: 18px;
  height: 18px;
}
.prefs-trigger.sidebar:hover {
  background: #1a222e;
  color: #e8edf5;
}

.dialog-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 220px;
  padding: 0;
}

.setting-block {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.block-title {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  color: #e8edf5;
}

.api-block {
  padding-top: 12px;
  border-top: 1px solid #1f2937;
}

.intro {
  margin: 0;
  color: #8b9bb5;
  font-size: 13px;
  line-height: 1.5;
}

.hint-dim {
  margin: 0;
  font-size: 12px;
  color: #6a7e9c;
}

.coin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 8px;
  min-height: 140px;
  padding: 10px;
  border: 1px solid #1f2937;
  border-radius: 4px;
  background: #10171f;
  align-content: start;
}

.coin-chip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-height: 34px;
  padding: 0 8px 0 10px;
  border: 1px solid #1f2937;
  border-radius: 4px;
  background: #1a222e;
}

.coin-label {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.03em;
  color: #e8edf5;
}

.coin-empty {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100px;
  color: #6a7e9c;
  font-size: 13px;
}

.pref-add {
  display: flex;
  flex-direction: row;
  flex-wrap: nowrap;
  align-items: stretch;
  gap: 8px;
  width: 100%;
}

.pref-add :deep(.el-input) {
  flex: 1 1 auto;
  min-width: 0;
  width: auto;
}
.pref-add :deep(.el-input__wrapper) {
  min-height: 36px;
  border-radius: 4px;
  background: #10171f;
  box-shadow: 0 0 0 1px #1f2937 inset;
}
.pref-add > .dlg-btn {
  flex: 0 0 auto;
  align-self: stretch;
  white-space: nowrap;
  min-width: 72px;
  padding: 0 16px;
}

.chip-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 2px;
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
  gap: 8px;
  width: 100%;
}

.dlg-btn {
  border: 0;
  border-radius: 4px;
  padding: 8px 16px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
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
.dlg-btn.danger {
  align-self: flex-start;
  background: #3a1f24;
  color: #f0a0a8;
  border: 1px solid #5a3038;
}
.dlg-btn.danger:hover:not(:disabled) {
  background: #4a282e;
  color: #ffc0c6;
}
</style>

<style>
.coin-prefs-dialog.el-dialog {
  background: #141a24 !important;
  border: 1px solid #1f2937;
  border-radius: 6px;
  overflow: hidden;
  box-shadow: none;
}
.coin-prefs-dialog .el-dialog__header {
  padding: 14px 16px 6px;
  margin: 0;
}
.coin-prefs-dialog .el-dialog__title {
  color: #e8edf5;
  font-size: 15px;
  font-weight: 600;
}
.coin-prefs-dialog .el-dialog__body {
  padding: 8px 16px 4px;
}
.coin-prefs-dialog .el-dialog__footer {
  padding: 8px 16px 14px;
  border-top: 1px solid #1a1f2a;
}
</style>
