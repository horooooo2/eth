<script setup lang="ts">
defineProps<{active?:boolean}>();
defineEmits<{click:[]}>();
</script>
<template><button type="button" class="h5-filter-button" :class="{active}" aria-label="打开筛选" @click="$emit('click')"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M6 10h8M8 15h4"/></svg><span>筛选</span><i v-if="active"/></button></template>
<style scoped>
.h5-filter-button{display:inline-flex;align-items:center;justify-content:center;gap:5px;flex:0 0 auto;min-width:62px;min-height:44px;padding:8px!important;box-sizing:border-box;background:none;border:0;color:var(--h5-gold,#f4b35e);font:inherit;font-size:12px;white-space:nowrap;cursor:pointer}.h5-filter-button svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round}.h5-filter-button i{width:4px;height:4px;border-radius:50%;background:currentColor}
</style>
