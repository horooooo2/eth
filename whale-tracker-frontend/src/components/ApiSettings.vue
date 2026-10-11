<script setup lang="ts">
import '@/styles/settings.css';
import AdaptivePage from './mobile/AdaptivePage.vue';
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { isLoggedIn } from '@/stores/auth';
import { aiKeyHint, bindAiKey, refreshAiKeyStatus } from '@/stores/aiKey';

const props=defineProps<{ mobile?:boolean; variant?: 'default' | 'sidebar' }>();
const pagePanel=ref<InstanceType<typeof AdaptivePage>|null>(null);
const isDirty=computed(()=>!!apiKey.value.trim());
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
    <AdaptivePage class="settings-surface" ref="pagePanel" :mobile="mobile" :dirty="isDirty" :busy="saving" v-model="visible" title="AI 分析设置" width="min(520px,94vw)" append-to-body destroy-on-close>
      <p class="intro">DeepSeek 密钥用于市场简报、宏观数据及巨鲸 AI 分析。</p>
      <div v-if="isLoggedIn" class="settings-block">
        <label class="settings-label" for="settings-ai-key">DeepSeek API Key</label>
        <el-input id="settings-ai-key" v-model="apiKey" type="password" show-password autocomplete="new-password" placeholder="DeepSeek API Key（留空则不修改）" />
        <p class="settings-status">{{ aiKeyHint ? `当前密钥：${aiKeyHint}` : '尚未配置' }}</p>
      </div>
      <p v-else class="intro">登录后可配置 AI 分析密钥。</p>
      <template #footer><div class="settings-footer">
        <button type="button" class="dlg-btn ghost" @click="props.mobile ? pagePanel?.requestBack() : visible = false">取消</button>
        <button type="button" class="dlg-btn primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
      </div></template>
    </AdaptivePage>
  </div>
</template>

<style scoped>
.api-settings.sidebar { width: 100%; display: flex; justify-content: center; }
.api-trigger { border: 0; border-radius: 999px; padding: 6px 14px; min-height: 32px; background: #1a222e; color: #b0c4de; font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; }
.api-trigger.sidebar { width: 56px; height: 48px; min-height: 48px; padding: 0; border-radius: 14px; background: transparent; color: #6a7e9c; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; }
.intro { color: var(--muted); font-size: 13px; line-height: 1.6; }
</style>
