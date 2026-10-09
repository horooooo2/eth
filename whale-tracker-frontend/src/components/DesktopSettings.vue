<script setup lang="ts">
import { ref } from 'vue';
import CoinPreferences from './CoinPreferences.vue';
import NewsPreferences from './NewsPreferences.vue';
import ApiSettings from './ApiSettings.vue';
defineProps<{ username?:string; activeMarket:'virtual'|'tradfi' }>();
const emit=defineEmits<{logout:[]}>();
const visible=ref(false);
</script>
<template>
  <div class="desktop-settings">
    <button type="button" class="settings-trigger" title="设置" @click="visible=true">
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M3 15h14"/><circle cx="7" cy="5" r="2"/><circle cx="13" cy="15" r="2"/></svg><span>设置</span>
    </button>
    <el-dialog v-model="visible" title="设置" width="min(480px,94vw)" append-to-body destroy-on-close>
      <div class="settings-account"><span class="account-avatar">{{(username||'U').slice(0,1).toUpperCase()}}</span><div><strong>{{username||'当前账户'}}</strong><small>个人工作区</small></div></div>
      <div class="settings-group">
        <CoinPreferences :active-market="activeMarket"><template #trigger="{open}"><button type="button" class="settings-row" @click="open"><span><b>币种与合约偏好</b><small>管理虚拟币和雷达关注标的</small></span><span aria-hidden="true">›</span></button></template></CoinPreferences>
        <NewsPreferences><template #default="{open}"><button type="button" class="settings-row" @click="open"><span><b>新闻标的管理</b><small>管理新闻与评论关注的标的</small></span><span aria-hidden="true">›</span></button></template></NewsPreferences>
        <ApiSettings><template #trigger="{open}"><button type="button" class="settings-row" @click="open"><span><b>AI 分析设置</b><small>配置个人 DeepSeek 密钥</small></span><span aria-hidden="true">›</span></button></template></ApiSettings>
      </div>
      <div class="settings-group"><button type="button" class="settings-row logout" @click="emit('logout')"><span><b>退出登录</b><small>退出当前账户</small></span><span aria-hidden="true">↗</span></button></div>
    </el-dialog>
  </div>
</template>
<style scoped>
.desktop-settings{width:100%}.settings-trigger{width:100%;min-height:44px;display:flex;gap:8px;align-items:center;padding:12px 8px;border:0;border-radius:8px;background:transparent;color:var(--muted);font:inherit;font-size:13px;cursor:pointer}.settings-trigger:hover{background:var(--panel-2);color:var(--text)}.settings-trigger svg{width:20px;height:20px;flex:none;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round}.settings-trigger:focus-visible,.settings-row:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.settings-account{display:flex;align-items:center;gap:12px;padding:5px 0 23px;color:var(--text)}.account-avatar{display:grid;place-items:center;width:44px;height:44px;border:1px solid var(--border);border-radius:12px;background:var(--panel-2);color:var(--yellow);font-size:18px}.settings-account small{display:block;margin-top:5px;color:var(--muted);font-size:12px}.settings-group{border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:15px}.settings-group :deep(.api-settings){border-top:1px solid var(--border)}.settings-row{width:100%;display:flex;align-items:center;justify-content:space-between;gap:15px;padding:17px 15px;border:0;background:transparent;color:var(--text);font:inherit;text-align:left;cursor:pointer}.settings-row:hover{background:var(--panel-2)}.settings-row b{font-size:13px;font-weight:550}.settings-row small{display:block;margin-top:5px;color:var(--muted);font-size:11px}.logout b{color:var(--red)}
.settings-group :deep(.coin-prefs){width:100%;display:flex}.settings-trigger{box-sizing:border-box}
@media(max-width:1000px){.settings-trigger{justify-content:center;padding:12px 0}.settings-trigger>span{display:none}}
</style>
