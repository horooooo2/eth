<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { fetchEngineDashboard, whaleAiEngineSnapshot, whaleAiEngineState, whaleAiUserIdReady, whaleAiAlphaExecution } from '@/stores/whaleAi';
import { statusZh, eventZh, reasonZh } from '@/utils/strategyDisplayZh';
import { fetchWhaleAiEngineEvents } from '@/api';

const events = ref<any[]>([]);

onMounted(() => {
  void fetchEngineDashboard();
  void fetchWhaleAiEngineEvents({ limit: 20 })
    .then((data) => {
      events.value = Array.isArray(data.events) ? data.events : [];
    })
    .catch(() => {
      events.value = [];
    });
});

const snap = computed(() => whaleAiEngineSnapshot.value || {});
const engine = computed(() => (snap.value as any).engine || {});
const s5 = computed(() => (snap.value as any).s5 || {});
const s6 = computed(() => (snap.value as any).s6 || (snap.value as any).safety || {});
const pos = computed(() => ((snap.value as any).open_positions || []) as any[]);
const recovery = computed(() => (snap.value as any).recovery || s6.value.recovery || {});
const env = computed(() => String((snap.value as any).account_environment || ''));
</script>

<template>
  <div class="page">
    <h1>总览</h1>
    <p class="muted">打开本页不会自动启动引擎、选择策略或下单。</p>
    <div class="grid">
      <section class="card"><h2>Engine 状态</h2><p>{{ statusZh(whaleAiEngineState) }}</p></section>
      <section class="card"><h2>当前 Alpha</h2><p>{{ (snap as any).active_strategy || engine.active_strategy || '—' }}</p></section>
      <section class="card"><h2>Alpha 执行</h2><p>{{ statusZh(whaleAiAlphaExecution) }}</p></section>
      <section class="card"><h2>交易环境</h2><p>{{ statusZh(env) || '—' }}</p></section>
      <section class="card"><h2>OKX 账户</h2><p>{{ env === 'OKX_LIVE' ? '实盘' : env === 'OKX_DEMO' ? '模拟盘' : '—' }}</p></section>
      <section class="card"><h2>Live 权限</h2><p>{{ (snap as any).live_permission ? '开启' : '关闭' }}</p></section>
      <section class="card"><h2>交易用户</h2><p>{{ whaleAiUserIdReady ? '已绑定' : '尚未绑定交易操作用户' }}</p></section>
      <section class="card"><h2>执行恢复</h2><p>{{ statusZh(recovery.state || recovery.status) || '—' }}</p></section>
      <section class="card"><h2>S5 风险</h2><p>组合已用 {{ s5.portfolio?.risk_used ?? s5.portfolio_risk_used_pct_equity ?? '—' }}</p></section>
      <section class="card"><h2>S6 状态</h2><p>{{ statusZh(s6.status) }} · 等级 {{ s6.level ?? '—' }}</p></section>
      <section class="card"><h2>当前归属仓位</h2><p>{{ pos.length ? pos.map((p) => `${p.symbol} ${p.side} ${p.quantity}`).join('；') : '空仓' }}</p></section>
      <section class="card"><h2>Runtime Event</h2><p>{{ events.length ? '已记录' : '暂无' }}</p></section>
    </div>
    <section class="card wide">
      <h2>最近策略决策 / 交易事件</h2>
      <p v-if="!events.length" class="muted">暂无事件</p>
      <ul v-else>
        <li v-for="(ev, i) in events.slice(0, 12)" :key="ev.event_id || i">
          {{ eventZh(ev.event_type) }} · {{ reasonZh(ev.reason_code) || statusZh(ev.decision) || '—' }}
          <span class="code">{{ ev.reason_code || ev.event_type }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.page h1 { margin: 0 0 6px; font-size: 20px; }
.muted { color: #8fa0b3; margin: 0 0 16px; font-size: 13px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
.card { background: #151c26; border: 1px solid #2a3544; border-radius: 10px; padding: 12px 14px; }
.card.wide { margin-top: 12px; }
.card h2 { margin: 0 0 8px; font-size: 12px; color: #8fa0b3; font-weight: 600; }
.card p { margin: 0; font-size: 15px; }
ul { margin: 0; padding-left: 18px; font-size: 13px; }
li { margin: 4px 0; }
.code { color: #8fa0b3; font-family: ui-monospace, monospace; margin-left: 8px; font-size: 12px; }
</style>
