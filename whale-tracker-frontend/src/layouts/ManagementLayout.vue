<script setup lang="ts">
import { RouterLink, RouterView, useRoute } from 'vue-router';

const route = useRoute();

const nav = [
  { to: '/console', label: '总览', match: ['console-overview'] },
  { to: '/console/control', label: '策略控制', match: ['console-control'] },
  { to: '/console/config', label: '策略配置', match: ['console-config'] },
  { to: '/console/logs', label: '运行日志', match: ['console-logs'] },
  { to: '/console/data', label: '数据库看板', match: ['console-data'] },
  { to: '/console/status', label: '系统状态', match: ['console-status'] },
];

function isOn(item: (typeof nav)[number]) {
  return item.match.includes(String(route.name || ''));
}
</script>

<template>
  <div class="mgmt">
    <aside class="nav">
      <div class="brand">WhaleTracker</div>
      <div class="brand-sub">统一管理系统</div>
      <RouterLink
        v-for="item in nav"
        :key="item.to"
        :to="item.to"
        class="nav-item"
        :class="{ on: isOn(item) }"
      >
        {{ item.label }}
      </RouterLink>
      <RouterLink class="nav-item secondary" to="/whales">巨鲸监控</RouterLink>
    </aside>
    <main class="main">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.mgmt {
  display: grid;
  grid-template-columns: 220px 1fr;
  min-height: 100vh;
  background: #0c1118;
  color: #eef3f8;
}
.nav {
  border-right: 1px solid #2a3544;
  background: #151c26;
  padding: 18px 12px;
}
.brand {
  font-weight: 700;
  font-size: 15px;
  padding: 0 10px;
}
.brand-sub {
  color: #8fa0b3;
  font-size: 12px;
  padding: 4px 10px 16px;
}
.nav-item {
  display: block;
  color: #8fa0b3;
  text-decoration: none;
  padding: 9px 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  font-size: 14px;
}
.nav-item.on {
  color: #fff;
  background: #1b2430;
  border-color: #2a3544;
}
.nav-item.secondary {
  margin-top: 18px;
  font-size: 13px;
}
.main {
  min-width: 0;
  padding: 16px 18px 32px;
}
</style>
