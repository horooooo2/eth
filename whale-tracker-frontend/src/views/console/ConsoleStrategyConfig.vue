<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { statusZh, SECTION_ZH } from '@/utils/strategyDisplayZh';

type Detail = Record<string, any>;

const items = ref<any[]>([]);
const current = ref<Detail | null>(null);
const tab = ref<'summary' | 'structured' | 'raw' | 'effective'>('summary');
const q = ref('');
const err = ref('');

const filtered = computed(() => {
  const needle = q.value.trim().toLowerCase();
  if (!needle) return items.value;
  return items.value.filter((it) => `${it.id} ${it.name} ${it.status}`.toLowerCase().includes(needle));
});
const alpha = computed(() => filtered.value.filter((i) => i.type === 'ALPHA'));
const system = computed(() => filtered.value.filter((i) => i.type === 'SYSTEM'));

async function loadList() {
  const res = await fetch('/api/admin/strategy-configs', { cache: 'no-store' });
  const data = await res.json();
  items.value = data.items || [];
}

async function select(id: string) {
  err.value = '';
  tab.value = 'summary';
  const res = await fetch(`/api/admin/strategy-configs/${encodeURIComponent(id)}`, { cache: 'no-store' });
  current.value = await res.json();
}

function pretty(v: unknown) {
  return JSON.stringify(v ?? {}, null, 2);
}

onMounted(async () => {
  try {
    await loadList();
    if (items.value[0]) await select(items.value[0].id);
  } catch (e) {
    err.value = e instanceof Error ? e.message : '加载失败';
  }
});
</script>

<template>
  <div class="page">
    <h1>策略配置</h1>
    <p class="muted">只读。改中文概要不会改变交易生效 Hash。</p>
    <p v-if="err" class="err">{{ err }}</p>
    <div class="layout">
      <aside class="card">
        <input v-model="q" placeholder="搜索 S1 / 趋势 / S9" />
        <div class="sec">Alpha 策略</div>
        <button
          v-for="it in alpha"
          :key="it.id"
          type="button"
          class="nav-item"
          :class="{ on: current?.id === it.id }"
          @click="select(it.id)"
        >
          {{ it.id }} {{ it.name }}
        </button>
        <div class="sec">系统模块</div>
        <button
          v-for="it in system"
          :key="it.id"
          type="button"
          class="nav-item"
          :class="{ on: current?.id === it.id }"
          @click="select(it.id)"
        >
          {{ it.id }} {{ it.name }}
        </button>
      </aside>
      <section class="card" v-if="current">
        <div class="head">
          <strong>{{ current.id }} {{ current.name }}</strong>
          <span>{{ statusZh(current.release?.stage || current.status) }}</span>
        </div>
        <div class="tabs">
          <button type="button" :class="{ on: tab === 'summary' }" @click="tab = 'summary'">概要</button>
          <button type="button" :class="{ on: tab === 'structured' }" @click="tab = 'structured'">结构化视图</button>
          <button type="button" :class="{ on: tab === 'raw' }" @click="tab = 'raw'">原始配置</button>
          <button type="button" :class="{ on: tab === 'effective' }" @click="tab = 'effective'">运行生效值</button>
        </div>
        <div v-if="tab === 'summary'" class="body">
          <p>{{ current.summary_zh || current.display?.summary_zh || '暂无概要' }}</p>
          <p v-if="current.entry_summary_zh">入场：{{ current.entry_summary_zh }}</p>
          <p v-if="current.risk_summary_zh">风险：{{ current.risk_summary_zh }}</p>
          <p v-if="current.exit_summary_zh">退出：{{ current.exit_summary_zh }}</p>
        </div>
        <div v-else-if="tab === 'structured'" class="body">
          <h3>{{ SECTION_ZH.basic }}</h3>
          <p>策略 ID：{{ current.id }}</p>
          <p>名称：{{ current.name }}</p>
          <p>阶段：{{ statusZh(current.release?.stage) }}</p>
          <p>已实现：{{ current.release?.implemented ? '是' : '否' }}</p>
          <p>模拟盘允许：{{ current.release?.demo_allowed ? '是' : '否' }}</p>
          <p>实盘能力：{{ current.release?.live_allowed ? '是' : '否' }}</p>
          <h3>{{ SECTION_ZH.dependencies }}</h3>
          <p>{{ (current.dependencies || []).join('、') || '—' }}</p>
        </div>
        <pre v-else-if="tab === 'raw'" class="json">{{ pretty(current.raw_config) }}</pre>
        <pre v-else class="json">{{ pretty(current.effective_config) }}</pre>
      </section>
    </div>
  </div>
</template>

<style scoped>
.page h1 { margin: 0 0 6px; font-size: 20px; }
.muted { color: #8fa0b3; font-size: 13px; }
.err { color: #f56c6c; }
.layout { display: grid; grid-template-columns: 240px 1fr; gap: 12px; margin-top: 12px; }
.card { background: #151c26; border: 1px solid #2a3544; border-radius: 10px; padding: 12px; }
input { width: 100%; background: #0f1520; color: #eef3f8; border: 1px solid #2a3544; border-radius: 6px; padding: 6px 8px; }
.sec { color: #8fa0b3; font-size: 12px; margin: 12px 0 6px; }
.nav-item { display: block; width: 100%; text-align: left; background: transparent; color: #eef3f8; border: 0; padding: 7px 6px; cursor: pointer; }
.nav-item.on { background: #1b2430; }
.head { display: flex; justify-content: space-between; margin-bottom: 10px; }
.tabs { display: flex; gap: 6px; margin-bottom: 12px; }
.tabs button { background: #243041; color: #eef3f8; border: 1px solid #2a3544; border-radius: 6px; padding: 6px 10px; cursor: pointer; }
.tabs button.on { background: #4aa3ff; color: #fff; }
.body p { line-height: 1.6; }
.json { background: #0f1520; padding: 12px; overflow: auto; font-size: 12px; }
</style>
