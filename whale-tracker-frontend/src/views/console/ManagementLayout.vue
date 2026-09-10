<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router';
import '@/styles/console.css';
</script>

<template>
  <div class="console-shell">
    <header class="console-top">
      <div class="console-top-left">
        <div>
          <h1>交易系统管理后台</h1>
          <div class="sub">AI 交易管理中心</div>
        </div>
        <nav class="console-nav">
          <RouterLink class="nav-link" to="/console/data">数据看板</RouterLink>
          <RouterLink class="nav-link" to="/console/strategy-config">策略配置</RouterLink>
        </nav>
      </div>
      <RouterLink class="btn ghost" to="/">返回主站</RouterLink>
    </header>
    <RouterView />
  </div>
</template>
