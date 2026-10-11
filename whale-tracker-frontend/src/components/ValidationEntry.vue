<script setup lang="ts">
import {openValidation,validationStatus,validationRunning} from '@/stores/validationUi';
defineProps<{coin?:string;navigation?:boolean}>();
</script>
<template><button type="button" class="validation-entry" :class="{navigation,compact:coin!==undefined}" :title="validationStatus" :aria-label="validationRunning?'数据验证：正在验证':'数据验证'" :disabled="coin==='all'" @click="openValidation(coin)"><span v-if="coin===undefined" class="validation-mark" aria-hidden="true"><i v-if="validationRunning" class="validation-pulse"/><svg v-else viewBox="0 0 20 20"><path d="M4 3h12v14H4zM7 7h6M7 11l2 2 4-4"/></svg></span><span class="validation-label">数据验证</span></button></template>
<style scoped>
.validation-entry{display:flex;align-items:center;gap:8px;width:100%;padding:10px 8px;background:var(--panel-2);border:1px solid var(--border);border-radius:8px;color:var(--text);font:inherit;text-align:left;cursor:pointer;box-sizing:border-box;margin-bottom:8px}
.validation-entry.compact{width:auto;flex:none;margin:0;padding:8px 10px;min-height:40px;font-size:12px}
.validation-entry.navigation{min-height:44px;padding:12px 8px;border:0;background:transparent;color:var(--muted);font-size:13px;margin-bottom:6px;white-space:nowrap}
.validation-entry.navigation:hover{background:var(--panel-2);color:var(--text)}.validation-entry:focus-visible{outline:2px solid var(--yellow);outline-offset:2px}
.validation-mark{display:grid;place-items:center;width:20px;height:20px;flex:none}.validation-mark svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.validation-pulse{position:relative;width:6px;height:6px;border-radius:50%;background:var(--green,#34d399);color:var(--green,#34d399);box-shadow:0 0 6px currentColor}
.validation-pulse::before,.validation-pulse::after{content:'';position:absolute;inset:0;border:1px solid currentColor;border-radius:50%;animation:validation-entry-ripple 2.8s ease-out infinite;pointer-events:none}.validation-pulse::after{animation-delay:1.4s;opacity:0}
@keyframes validation-entry-ripple{0%{transform:scale(1);opacity:.55}70%{opacity:.12}100%{transform:scale(3.4);opacity:0}}
@media(prefers-reduced-motion:reduce){.validation-pulse::before,.validation-pulse::after{animation:none;display:none}}
@media(max-width:1000px){.validation-entry.navigation{justify-content:center;padding:12px 0}.navigation .validation-label{display:none}}
.validation-entry:disabled{opacity:.45;cursor:default}
</style>
