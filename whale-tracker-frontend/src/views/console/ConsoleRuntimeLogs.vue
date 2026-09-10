<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { eventZh, reasonZh } from '@/utils/strategyDisplayZh';
import { fetchWhaleAiEngineEvents } from '@/api';

const events = ref<any[]>([]);
const err = ref('');

onMounted(async () => {
  try {
    const data = await fetchWhaleAiEngineEvents({ limit: 200 });
    events.value = Array.isArray(data.events) ? data.events : [];
  } catch (e) {
    err.value = e instanceof Error ? e.message : '加载失败';
  }
});
</script>

<template>
  <div class="page">
    <h1>运行日志</h1>
    <p class="muted">日志来自服务器 Runtime Event Persistence。关闭浏览器后仍会继续记录。</p>
    <p v-if="err" class="err">{{ err }}</p>
    <div v-if="!events.length && !err" class="empty">暂无运行事件</div>
    <table v-else>
      <thead>
        <tr><th>时间</th><th>事件</th><th>说明</th><th>策略</th><th>代码</th></tr>
      </thead>
      <tbody>
        <tr v-for="(ev, i) in events" :key="ev.event_id || i">
          <td>{{ ev.ts || ev.created_at || '—' }}</td>
          <td>{{ eventZh(ev.event_type) }}</td>
          <td>{{ reasonZh(ev.reason_code || ev.reason) || ev.message || '—' }}</td>
          <td>{{ ev.strategy_id || '—' }}</td>
          <td class="code">{{ ev.reason_code || ev.event_type || '' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.page h1 { margin: 0 0 6px; font-size: 20px; }
.muted { color: #8fa0b3; font-size: 13px; }
.err { color: #f56c6c; }
.empty { color: #8fa0b3; padding: 24px 0; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { border-bottom: 1px solid #2a3544; text-align: left; padding: 8px; }
th { color: #8fa0b3; font-weight: 600; }
.code { color: #8fa0b3; font-family: ui-monospace, monospace; }
</style>
