<script setup lang="ts">
import {ref,onMounted,onUnmounted,watch,nextTick} from 'vue';
const props=defineProps<{refresh?:()=>Promise<unknown>;more?:()=>Promise<unknown>|void;hasMore?:boolean;busy?:boolean;refreshText?:string;resetKey?:unknown}>();
const root=ref<HTMLElement|null>(null),end=ref<HTMLElement|null>(null),pull=ref(0),working=ref(false),error=ref(''),notice=ref(''),failedAction=ref<'refresh'|'more'>('refresh');
let startY:number|null=null,startX=0,lastRefresh=0,observer:IntersectionObserver|undefined,disposed=false;
function start(e:TouchEvent){if(e.touches.length!==1||working.value||props.busy||!props.refresh||!root.value||root.value.scrollTop>0)return;startY=e.touches[0]!.clientY;startX=e.touches[0]!.clientX;}
function move(e:TouchEvent){if(startY==null||e.touches.length!==1)return;const dy=e.touches[0]!.clientY-startY,dx=Math.abs(e.touches[0]!.clientX-startX);if(dy<0||dx>Math.abs(dy)||root.value!.scrollTop>0){startY=null;pull.value=0;return;}if(e.cancelable)e.preventDefault();pull.value=Math.min(90,dy*.45);}
async function refresh(){if(!props.refresh||working.value||props.busy)return;if(Date.now()-lastRefresh<10000){notice.value='刚刚已刷新，请稍后再试';return;}lastRefresh=Date.now();failedAction.value='refresh';working.value=true;error.value='';notice.value='正在刷新…';try{await props.refresh();if(!disposed)notice.value=props.refreshText||'刷新完成';}catch(e){if(!disposed){error.value=e instanceof Error?e.message:'刷新失败，请重试';notice.value='';}}finally{if(!disposed)working.value=false;}}
function release(){const ready=pull.value>=58;startY=null;pull.value=0;if(ready)void refresh();}
function cancel(){startY=null;pull.value=0;}
async function loadMore(){if(!props.hasMore||!props.more||working.value||props.busy||disposed||!root.value?.clientHeight)return;failedAction.value='more';working.value=true;error.value='';try{await props.more();}catch(e){if(!disposed)error.value=e instanceof Error?e.message:'加载失败，请重试';}finally{if(!disposed)working.value=false;}}
function visibleEnd(){if(!root.value||!end.value||!root.value.clientHeight)return false;return end.value.getBoundingClientRect().top<=root.value.getBoundingClientRect().bottom+40;}
function scroll(){if(!error.value&&visibleEnd())void loadMore();}
onMounted(()=>{root.value?.addEventListener('touchmove',move,{passive:false});observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)&&!error.value)void loadMore();},{root:root.value,rootMargin:'40px'});if(end.value)observer.observe(end.value);});
watch(()=>props.resetKey,()=>{if(root.value)root.value.scrollTop=0;error.value='';notice.value='';});
watch(()=>props.hasMore,async()=>{await nextTick();scroll();});
onUnmounted(()=>{disposed=true;observer?.disconnect();root.value?.removeEventListener('touchmove',move);});
</script>
<template><div ref="root" class="h5-pull-scroll" @scroll.passive="scroll" @touchstart.passive="start" @touchend="release" @touchcancel="cancel"><div class="h5-pull-indicator" :style="{height:pull+'px'}" aria-live="polite">{{pull>=58?'松开刷新':'下拉刷新'}}</div><p v-if="notice" class="h5-refresh-note" role="status">{{notice}}</p><slot/><p v-if="error" class="h5-load-error" role="alert">{{error}} <button @click="failedAction==='more'?loadMore():refresh()">重试</button></p><div ref="end" class="h5-load-end"><button v-if="hasMore" :disabled="working||busy" @click="loadMore">{{working||busy?'加载中…':'上拉加载更多'}}</button><span v-else-if="more">已显示全部</span></div></div></template>
