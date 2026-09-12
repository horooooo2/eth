<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router';
import '@/styles/console.css';
</script>

<template>
  <div class="console-shell">
    <header class="console-top">
      <div class="console-top-left">
        <div>
          <h1>数据管理后台</h1>
          <div class="sub">巨鲸 / 新闻 / 用户管理中心</div>
        </div>
        <nav class="console-nav">
          <RouterLink class="nav-link" to="/console/data">数据看板</RouterLink>
        </nav>
      </div>
      <RouterLink class="btn ghost" to="/">返回主站</RouterLink>
    </header>
    <RouterView />
  </div>
</template>
