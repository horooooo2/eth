<script setup lang="ts">
import { defineAsyncComponent, ref } from 'vue';
import StrategyHome from './StrategyHome.vue';
const TradFiReplay = defineAsyncComponent(() => import('@/views/TradFiReplay.vue'));
defineProps<{ active: boolean }>();
const page = ref<'home' | 'replay'>('home');
const replayVisited = ref(false);
function openReplay() { replayVisited.value = true; page.value = 'replay'; }
</script>
<template><div class="strategy-workspace">
  <StrategyHome v-show="page === 'home'" :active="active && page === 'home'" :replay-visited="replayVisited" @replay="openReplay" />
  <TradFiReplay v-if="replayVisited" v-show="page === 'replay'" embedded :active="active && page === 'replay'" @back="page = 'home'" />
</div></template>
<style scoped>.strategy-workspace{height:100%;min-height:0;overflow:auto}</style>
