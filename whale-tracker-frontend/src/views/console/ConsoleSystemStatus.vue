<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { fetchEngineDashboard, whaleAiEngineSnapshot, whaleAiEngineBridge, whaleAiEngineState, whaleAiUserIdReady } from '@/stores/whaleAi';
import { statusZh } from '@/utils/strategyDisplayZh';

onMounted(() => { void fetchEngineDashboard(); });
const snap = computed(() => whaleAiEngineSnapshot.value as any);
const bridge = computed(() => whaleAiEngineBridge.value as any);
</script>

<template>
  <div class="page">
    <h1>系统状态</h1>
    <div class="grid">
      <section class="card"><h2>Engine</h2><p>{{ statusZh(whaleAiEngineState) }}</p></section>
      <section class="card"><h2>传输</h2><p>{{ statusZh(bridge?.transport_status || (bridge?.connected ? 'CONNECTED' : 'OFFLINE')) }}</p></section>
      <section class="card"><h2>交易用户</h2><p>{{ whaleAiUserIdReady ? '已绑定' : '尚未绑定交易操作用户' }}</p></section>
      <section class="card"><h2>配置来源</h2><p>{{ snap?.config_source_kind || 'MODULAR_JSON' }}</p></section>
      <section class="card"><h2>配置状态</h2><p>{{ statusZh(snap?.config_status || 'OK') }}</p></section>
    </div>
  </div>
</template>

<style scoped>
.page h1 { margin: 0 0 16px; font-size: 20px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
.card { background: #151c26; border: 1px solid #2a3544; border-radius: 10px; padding: 12px 14px; }
.card h2 { margin: 0 0 8px; font-size: 12px; color: #8fa0b3; }
.card p { margin: 0; }
</style>
