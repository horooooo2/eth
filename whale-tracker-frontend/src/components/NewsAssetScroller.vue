<script setup lang="ts">
import {ref,onMounted,onUnmounted,watch,nextTick} from 'vue';
const props=defineProps<{count:number}>();
const host=ref<HTMLElement|null>(null),canLeft=ref(false),canRight=ref(false);
let viewport:HTMLElement|null=null,observer:ResizeObserver|undefined;
function update(){if(!viewport)return;canLeft.value=viewport.scrollLeft>1;canRight.value=viewport.scrollLeft+viewport.clientWidth<viewport.scrollWidth-1;}
function move(direction:number){if(!viewport)return;viewport.scrollBy({left:direction*Math.max(120,viewport.clientWidth*.8),behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});}
onMounted(()=>{viewport=host.value?.firstElementChild as HTMLElement|null;if(!viewport)return;viewport.addEventListener('scroll',update,{passive:true});observer=new ResizeObserver(update);observer.observe(viewport);update();});
watch(()=>props.count,async()=>{await nextTick();update();});
onUnmounted(()=>{viewport?.removeEventListener('scroll',update);observer?.disconnect();});
</script>
<template><div class="news-asset-navigation"><button class="asset-arrow" aria-label="标的向左滚动" :disabled="!canLeft" @click="move(-1)"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12 4-6 6 6 6"/></svg></button><div ref="host" class="asset-scroll-host"><slot/></div><button class="asset-arrow" aria-label="标的向右滚动" :disabled="!canRight" @click="move(1)"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m8 4 6 6-6 6"/></svg></button></div></template>
<style scoped>
.news-asset-navigation{display:grid;grid-template-columns:28px minmax(0,1fr) 28px;gap:6px;align-items:center;flex:none;min-width:0;margin-bottom:14px}.asset-scroll-host{min-width:0}.asset-scroll-host :deep(.asset-strip),.asset-scroll-host :deep(.h5-assets){margin-bottom:0;padding-bottom:2px;scrollbar-width:none}.asset-scroll-host :deep(.asset-strip::-webkit-scrollbar),.asset-scroll-host :deep(.h5-assets::-webkit-scrollbar){display:none}.news-asset-navigation>.asset-arrow{display:grid;place-items:center;width:28px;min-height:44px;padding:0;border:1px solid var(--border);border-radius:7px;background:var(--workspace-surface);color:var(--text);cursor:pointer}.asset-arrow svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}.news-asset-navigation>.asset-arrow:disabled{opacity:.25;cursor:default}.asset-arrow:focus-visible{outline:2px solid #f4b35e;outline-offset:2px}
</style>
