<script setup lang="ts">
import { onMounted, ref } from 'vue';

const browse = ref<any>(null);
const monitor = ref<any>(null);
const err = ref('');

onMounted(async () => {
  try {
    const [b, m] = await Promise.all([
      fetch('/api/data/browse?limit=200', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/data/monitor', { cache: 'no-store' }).then((r) => r.json()),
    ]);
    browse.value = b;
    monitor.value = m;
  } catch (e) {
    err.value = e instanceof Error ? e.message : '加载失败';
  }
});
</script>

<template>
  <div class="page">
    <h1>数据库看板</h1>
    <p class="muted">已迁入统一管理 Shell，不再使用 iframe。</p>
    <p v-if="err" class="err">{{ err }}</p>
    <div class="grid">
      <section class="card">
        <h2>用户</h2>
        <p>{{ (browse?.users || []).length }} 条</p>
      </section>
      <section class="card">
        <h2>巨鲸</h2>
        <p>{{ (browse?.whales || []).length }} 条</p>
      </section>
      <section class="card">
        <h2>监控</h2>
        <p>{{ monitor ? '已连接' : '—' }}</p>
      </section>
    </div>
    <section class="card wide">
      <h2>巨鲸列表</h2>
      <table>
        <thead><tr><th>名称</th><th>地址</th></tr></thead>
        <tbody>
          <tr v-for="w in (browse?.whales || []).slice(0, 50)" :key="w.id || w.address">
            <td>{{ w.name || w.label || '—' }}</td>
            <td class="code">{{ w.address || w.id }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<style scoped>
.page h1 { margin: 0 0 6px; font-size: 20px; }
.muted { color: #8fa0b3; font-size: 13px; }
.err { color: #f56c6c; }
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 12px 0; }
.card { background: #151c26; border: 1px solid #2a3544; border-radius: 10px; padding: 12px; }
.card.wide { margin-top: 12px; }
.card h2 { margin: 0 0 8px; font-size: 13px; color: #8fa0b3; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { border-bottom: 1px solid #2a3544; text-align: left; padding: 6px; }
.code { font-family: ui-monospace, monospace; color: #8fa0b3; }
</style>
