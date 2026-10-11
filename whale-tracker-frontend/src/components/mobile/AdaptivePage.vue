<script setup lang="ts">
import { ref, watch, onUnmounted, nextTick, useAttrs } from 'vue';
import { ElDialog } from 'element-plus';
defineOptions({inheritAttrs:false});
const props=defineProps<{mobile?:boolean;title?:string;dirty?:boolean;busy?:boolean}>();
const open=defineModel<boolean>({default:false});
const emit=defineEmits<{close:[]}>();
const attrs=useAttrs();
const confirmLeave=ref(false), backButton=ref<HTMLButtonElement|null>(null);
const id=`h5-${Date.now()}-${Math.random()}`;
let previousFocus:HTMLElement|null=null;
function enterHistory(){
  const state={...window.history.state,h5Page:id};
  if(window.history.state?.h5Page)window.history.replaceState(state,'');
  else window.history.pushState(state,'');
}
function requestBack(){if(props.busy)return;if(props.dirty){confirmLeave.value=true;return;}open.value=false;}
function discard(){confirmLeave.value=false;open.value=false;}
function pop(){
  if(!props.mobile||!open.value||window.history.state?.h5Page===id)return;
  if(props.busy||props.dirty){enterHistory();if(!props.busy)confirmLeave.value=true;}
  else open.value=false;
}
function leaveHistory(){queueMicrotask(()=>{if(window.history.state?.h5Page===id)window.history.back();});}
window.addEventListener('popstate',pop);
watch(()=>props.mobile&&open.value,async(value,previous)=>{
  if(value){previousFocus=document.activeElement as HTMLElement;enterHistory();await nextTick();backButton.value?.focus();}
  else if(previous){confirmLeave.value=false;leaveHistory();emit('close');await nextTick();previousFocus?.focus();}
},{immediate:true});
onUnmounted(()=>{window.removeEventListener('popstate',pop);leaveHistory();});
defineExpose({requestBack});
</script>
<template>
 <Teleport v-if="mobile" to="body"><section v-if="open" v-bind="attrs" class="h5-subpage" :aria-label="title" @keydown.esc.prevent="requestBack">
  <header class="h5-subpage-nav"><button ref="backButton" type="button" :disabled="busy" aria-label="返回上一页" @click="requestBack"><svg viewBox="0 0 24 24"><path d="m14 5-7 7 7 7"/></svg>返回</button><h1>{{title}}</h1><span /></header>
  <div v-if="$slots.header" class="h5-subpage-heading"><slot name="header" /></div>
  <div class="h5-subpage-content"><slot /></div>
  <div v-if="confirmLeave" class="h5-leave-prompt" role="alert"><p>修改尚未保存，是否放弃修改？</p><button @click="confirmLeave=false">继续编辑</button><button @click="discard">放弃修改并返回</button></div>
  <footer v-else-if="$slots.footer" class="h5-subpage-footer"><slot name="footer" /></footer>
 </section></Teleport>
 <ElDialog v-else v-model="open" v-bind="attrs" :title="title" @close="emit('close')"><slot/><template v-if="$slots.header" #header><slot name="header"/></template><template v-if="$slots.footer" #footer><slot name="footer"/></template></ElDialog>
</template>
<style>
.h5-subpage{position:fixed;inset:0;z-index:2100;display:flex;flex-direction:column;width:100%;height:100dvh;box-sizing:border-box;background:var(--bg,#0b0e14);color:var(--text,#e2e8f0);padding-top:env(safe-area-inset-top);font-size:13px;overflow:hidden}
.h5-subpage-nav{display:grid;grid-template-columns:80px minmax(0,1fr) 80px;align-items:center;flex:none;min-height:52px;border-bottom:1px solid var(--border);padding:0 8px}.h5-subpage-nav h1{font-size:15px;text-align:center;margin:0}.h5-subpage-nav button{display:flex;align-items:center;gap:2px;min-height:44px;border:0;background:none;color:var(--text);font-size:13px}.h5-subpage-nav svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.7}
.h5-subpage-heading{flex:none;padding:12px 16px;border-bottom:1px solid var(--border)}.h5-subpage-content{flex:1;min-height:0;min-width:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:16px;overflow-wrap:anywhere;scrollbar-width:none}.h5-subpage-footer,.h5-leave-prompt{flex:none;border-top:1px solid var(--border);padding:12px 16px calc(12px + env(safe-area-inset-bottom));background:var(--bg)}.h5-subpage-footer button,.h5-leave-prompt button{min-height:44px}.h5-subpage-footer .footer{flex-wrap:wrap}.h5-subpage-footer .dialog-footer{display:flex;justify-content:flex-end;gap:10px}.h5-subpage input{font-size:16px}.h5-leave-prompt button{padding:8px 12px;border:1px solid var(--border);border-radius:8px;color:var(--text);background:var(--panel);margin-right:8px}
.h5-subpage .options{max-height:none;grid-template-columns:minmax(0,1fr)}.h5-subpage .chips{max-height:none}.h5-subpage.whale-validation-dialog>.h5-subpage-content{padding:0;overflow:hidden}.h5-subpage .validation-body.h5-validation-body{height:100%;max-height:none}.h5-subpage .validation-actions button{flex:1}.h5-subpage.whale-detail-dialog{--detail-bg:#0b0e14;--detail-card:#151a24;--detail-border:#232937;--detail-muted:#848e9c}.h5-subpage.whale-detail-dialog>.h5-subpage-content{padding:0 14px;overflow:hidden}
</style>
