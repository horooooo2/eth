<script setup lang="ts">
import {computed,ref,watch} from 'vue';
import {contractLogo} from '@/utils/contractLogo';
const props=withDefaults(defineProps<{symbol:string;assetType?:string;large?:boolean}>(),{assetType:'TRADFI',large:false});
const failed=ref(false),loaded=ref(false);
const src=computed(()=>contractLogo(props.symbol,props.assetType));
watch(src,()=>{failed.value=false;loaded.value=false;},{flush:'sync'});
</script>
<template><span class="contract-logo" :class="{large}"><img v-if="src&&!failed" :key="src" :src="src" :style="{opacity:loaded?1:0}" @load="loaded=true" :alt="`${symbol} Logo`" loading="lazy" referrerpolicy="no-referrer" @error="failed=true"><svg v-if="!src||failed||!loaded" viewBox="0 0 24 24" role="img" :aria-label="`${symbol} 合约图标`"><path d="M3 20h18M5 20V8l7-4 7 4v12M9 10v2m6-2v2m-6 3v2m6-2v2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></span></template>
<style scoped>.contract-logo{position:relative;width:34px;height:34px;display:grid;place-items:center;flex-shrink:0;overflow:hidden;border:1px solid #2b394b;border-radius:50%;background:#182333;color:#a9c8f0;font-size:10px;font-weight:800}.contract-logo svg{width:22px;height:22px}.contract-logo.large{width:36px;height:36px}.contract-logo img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}</style>
