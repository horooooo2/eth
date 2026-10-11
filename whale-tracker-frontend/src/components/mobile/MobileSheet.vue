<script setup lang="ts">
const open=defineModel<boolean>({default:false});
defineProps<{title:string}>();
</script>
<template><el-dialog v-model="open" :title="title" class="h5-sheet" modal-class="h5-sheet-overlay" width="100%" append-to-body destroy-on-close><slot /><template v-if="$slots.footer" #footer><slot name="footer" /></template></el-dialog></template>
<style>
.h5-sheet-overlay .el-overlay-dialog{display:flex;align-items:flex-end;justify-content:center;overflow:hidden;padding:0;box-sizing:border-box}
.h5-sheet-overlay .h5-sheet.el-dialog{position:relative;inset:auto;display:flex;flex-direction:column;width:100%;max-width:100%;max-height:calc(100dvh - 24px - env(safe-area-inset-top));margin:0!important;padding:0!important;border-radius:16px 16px 0 0;overflow:hidden;box-sizing:border-box}
.h5-sheet-overlay .el-dialog__header{flex:none;padding:16px 52px 14px 16px;margin:0;border-bottom:1px solid var(--border)}
.h5-sheet-overlay .el-dialog__title{font-size:15px;line-height:22px}.h5-sheet-overlay .el-dialog__headerbtn{top:4px;right:4px;width:44px;height:44px}
.h5-sheet-overlay .el-dialog__body{flex:1;min-height:0;min-width:0;padding:14px 16px;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;font-size:13px;overflow-wrap:anywhere}
.h5-sheet-overlay .el-dialog__body>*{max-width:100%;box-sizing:border-box}.h5-sheet-overlay .el-dialog__footer{flex:none;padding:12px 16px calc(12px + env(safe-area-inset-bottom));border-top:1px solid var(--border)}
.h5-sheet-overlay .el-dialog__body:last-child{padding-bottom:calc(16px + env(safe-area-inset-bottom))}
.h5-sheet-overlay .el-dialog__footer button{min-height:44px;width:100%;margin:0;font-size:14px}
</style>
