<script setup lang="ts">
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { isLoggedIn } from '@/stores/auth';
import { aiKeyHint, bindAiKey, refreshAiKeyStatus } from '@/stores/aiKey';

defineProps<{ variant?: 'default' | 'sidebar' }>();
const visible = ref(false);
const saving = ref(false);
const apiKey = ref('');
async function open() {
  apiKey.value = '';
  visible.value = true;
  if (isLoggedIn.value) void refreshAiKeyStatus(true);
}
async function save() {
  if (!isLoggedIn.value) { ElMessage.warning('请先登录'); return; }
  if (!apiKey.value.trim()) { visible.value = false; return; }
  saving.value = true;
  try {
    const result = await bindAiKey(apiKey.value.trim());
    if (!result.ok) throw new Error(result.warn || 'AI 密钥保存失败');
    apiKey.value = '';
    visible.value = false;
    ElMessage.success('AI 分析密钥已保存');
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '保存失败'); }
  finally { saving.value = false; }
}
</script>

<template>
  <div class="api-settings" :class="{ sidebar: variant === 'sidebar' }">
    <slot name="trigger" :open="open"><button type="button" class="api-trigger" :class="{ sidebar: variant === 'sidebar' }" title="AI 分析设置" @click="open">
      {{ variant === 'sidebar' ? 'AI' : 'AI 分析设置' }}
    </button></slot>
    <el-dialog v-model="visible" title="AI 分析设置" width="420px" append-to-body destroy-on-close>
      <p class="intro">DeepSeek 密钥用于市场简报、宏观数据及巨鲸 AI 分析；交易所 API 配置已从网站移除。</p>
      <template v-if="isLoggedIn">
        <el-input v-model="apiKey" type="password" show-password autocomplete="new-password" placeholder="DeepSeek API Key（留空则不修改）" />
        <p class="intro">{{ aiKeyHint ? `当前密钥：${aiKeyHint}` : '尚未配置' }}</p>
      </template>
      <p v-else class="intro">登录后可配置 AI 分析密钥。</p>
      <template #footer>
        <button type="button" class="dlg-btn ghost" @click="visible = false">取消</button>
        <button type="button" class="dlg-btn primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.api-settings.sidebar { width: 100%; display: flex; justify-content: center; }
.api-trigger { border: 0; border-radius: 999px; padding: 6px 14px; min-height: 32px; background: #1a222e; color: #b0c4de; font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; }
.api-trigger.sidebar { width: 56px; height: 48px; min-height: 48px; padding: 0; border-radius: 14px; background: transparent; color: #6a7e9c; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; }
.intro { color: var(--muted); font-size: 13px; line-height: 1.6; }
.dlg-btn { border: 1px solid var(--border); border-radius: 7px; padding: 8px 14px; cursor: pointer; }
.dlg-btn.ghost { color: var(--text); background: transparent; }
.dlg-btn.primary { color: var(--accent-contrast, #111); background: var(--accent); }
</style>
