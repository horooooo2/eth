<script setup lang="ts">
import {computed,ref,watch} from 'vue';
import {contractLogoCandidates} from '@/utils/contractLogo';
const props=withDefaults(defineProps<{symbol:string;assetType?:string;baseAsset?:string;large?:boolean}>(),{assetType:'TRADFI',large:false});
const index=ref(0),loaded=ref(false);
const candidates=computed(()=>contractLogoCandidates(props.symbol,props.assetType,props.baseAsset));
const src=computed(()=>candidates.value[index.value]||'');
watch(()=>candidates.value.join('|'),()=>{index.value=0;loaded.value=false;},{flush:'sync'});
watch(src,()=>{loaded.value=false;},{flush:'sync'});
function failed(event:Event){if((event.target as HTMLImageElement).getAttribute('src')!==src.value)return;index.value++;}
</script>
<template><span class="contract-logo" :class="{large}"><img v-if="src" :key="src" :src="src" :style="{opacity:loaded?1:0}" @load="loaded=true" :alt="`${symbol} Logo`" loading="lazy" referrerpolicy="no-referrer" @error="failed"><span v-if="!src||!loaded" class="logo-fallback" :title="`${symbol} · 暂无品牌图标`">{{symbol.replace(/USDT$/i,'').slice(0,3)}}</span></span></template>
<style scoped>.contract-logo{position:relative;width:34px;height:34px;display:grid;place-items:center;flex-shrink:0;overflow:hidden;border:1px solid #2b394b;border-radius:50%;background:#182333;color:#a9c8f0;font-size:10px;font-weight:800}.contract-logo svg{width:22px;height:22px}.contract-logo.large{width:36px;height:36px}.contract-logo img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}</style>
