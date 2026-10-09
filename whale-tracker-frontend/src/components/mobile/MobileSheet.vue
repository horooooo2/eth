<script setup lang="ts">
const open=defineModel<boolean>({default:false});
defineProps<{title:string}>();
</script>
<template><el-dialog v-model="open" :title="title" class="h5-sheet" width="100%" append-to-body destroy-on-close><slot /></el-dialog></template>
