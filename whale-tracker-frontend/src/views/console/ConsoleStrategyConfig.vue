<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { fetchAdminStrategyConfig, fetchAdminStrategyConfigs } from '@/api';
import {
  classify,
  filterItems,
  prettyJson,
  renderStructured,
  renderSummary,
  runtimeSyncLabel,
  statusClass,
  type StrategyConfigDetail,
  type StrategyConfigItem,
} from '@/console/strategyConfigView';

type ConfigTab = 'summary' | 'structured' | 'raw' | 'effective';

const listPayload = ref<{
  overview?: Record<string, unknown>;
  items?: StrategyConfigItem[];
  alpha?: StrategyConfigItem[];
} | null>(null);
const current = ref<StrategyConfigDetail | null>(null);
const tab = ref<ConfigTab>('summary');
const search = ref('');
const loadErr = ref('');

const items = computed(() => (listPayload.value?.items || []) as StrategyConfigItem[]);
const filtered = computed(() => filterItems(items.value, search.value));
const groups = computed(() => classify(filtered.value));
const overview = computed(() => listPayload.value?.overview || {});
const stats = computed(() => [
  ['Alpha 策略', overview.value.alpha_count],
  ['已实现', overview.value.implemented_count],
  ['Research', overview.value.research_count],
  ['Demo Allowed', overview.value.demo_allowed_count],
  ['Live Allowed', overview.value.live_allowed_count],
  ['Live Permission', overview.value.live_permission ? 'ON' : 'OFF'],
  ['当前启用', overview.value.current_active],
]);

const sync = computed(() => runtimeSyncLabel(current.value?.runtime));
const structuredHtml = computed(() => renderStructured(current.value));
const summaryHtml = computed(() => renderSummary(current.value));
const jsonText = computed(() => {
  if (!current.value) return '';
  if (tab.value === 'effective') {
    if (!current.value.runtime || !current.value.runtime.online) return '';
    return prettyJson(current.value.effective_config);
  }
  if (tab.value === 'raw') return prettyJson(current.value.raw_config);
  return '';
});
const jsonOffline = computed(
  () => tab.value === 'effective' && (!current.value?.runtime || !current.value.runtime.online),
);
const showCopy = computed(() => tab.value === 'raw' || tab.value === 'effective');

function dotClass(status: unknown) {
  return statusClass(status);
}

async function select(id: string | null | undefined) {
  if (!id) return;
  try {
    current.value = (await fetchAdminStrategyConfig(id)) as StrategyConfigDetail;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    current.value = {
      id,
      name: id,
      release: {},
      source: {},
      runtime: { online: false, state: 'OFFLINE' },
      error: { code: 'LOAD_FAILED', message },
    };
  }
}

function onStructuredClick(ev: MouseEvent) {
  const btn = (ev.target as HTMLElement).closest('[data-jump]') as HTMLElement | null;
  if (!btn) return;
  void select(btn.getAttribute('data-jump'));
}

async function copyJson() {
  const payload =
    tab.value === 'effective' ? current.value?.effective_config : current.value?.raw_config;
  try {
    await navigator.clipboard.writeText(prettyJson(payload));
  } catch {
    /* ignore */
  }
}

onMounted(async () => {
  try {
    listPayload.value = (await fetchAdminStrategyConfigs()) as typeof listPayload.value;
    const first =
      ((listPayload.value?.alpha || [])[0] || (listPayload.value?.items || [])[0] || {}).id || 'S1';
    await select(first);
  } catch (err) {
    loadErr.value = err instanceof Error ? err.message : String(err);
  }
});
</script>

<template>
  <main class="console-main">
    <div v-if="loadErr" class="err-banner show">{{ loadErr }}</div>
    <section class="banner plain">
      <div class="banner-stats cols-7">
        <div v-for="cell in stats" :key="String(cell[0])" class="bstat">
          <div class="n">{{ cell[1] }}</div>
          <div class="l">{{ cell[0] }}</div>
        </div>
      </div>
    </section>
    <div class="layout">
      <aside class="card" style="height: auto">
        <div class="card-head">
          <h2>导航</h2>
          <input v-model="search" placeholder="搜索 S1 / 趋势 / S5" style="width: 100%; margin-top: 8px" />
        </div>
        <div class="card-body">
          <div class="sec-title">Alpha 策略</div>
          <div
            v-for="it in groups.alpha"
            :key="it.id"
            class="nav-item"
            :class="{ on: current && current.id === it.id }"
            @click="select(it.id)"
          >
            <span class="dot" :class="dotClass(it.status)"></span>
            <span>{{ it.id }} {{ it.name }}</span>
            <span v-if="it.config_error" class="pill danger">CONFIG ERROR</span>
          </div>
          <div class="sec-title">系统模块</div>
          <div
            v-for="it in groups.system"
            :key="it.id"
            class="nav-item"
            :class="{ on: current && current.id === it.id }"
            @click="select(it.id)"
          >
            <span class="dot" :class="dotClass(it.status)"></span>
            <span>{{ it.id }} {{ it.name }}</span>
            <span v-if="it.config_error" class="pill danger">CONFIG ERROR</span>
          </div>
        </div>
      </aside>
      <section class="card" style="height: auto">
        <div v-if="current" class="detail-head">
          <h2>{{ current.id }} · {{ current.name }}</h2>
          <div>
            <span class="pill" :class="current.release?.stage === 'RESEARCH' ? 'warn' : 'ok'">
              {{ current.release?.stage || current.status }}
            </span>
            <span class="pill" :class="current.release?.demo_allowed ? 'ok' : 'muted'">
              {{ current.release?.demo_allowed ? 'Demo Allowed YES' : 'Demo Allowed NO' }}
            </span>
            <span class="pill" :class="current.release?.live_allowed ? 'ok' : 'muted'">
              {{ current.release?.live_allowed ? 'Live Allowed YES' : 'Live Allowed NO' }}
            </span>
            <span class="pill" :class="current.release?.live_permission ? 'ok' : 'muted'">
              {{ current.release?.live_permission ? 'Live Permission ON' : 'Live Permission OFF' }}
            </span>
            <span v-if="current.release && current.release.implemented === false" class="pill warn">
              NOT IMPLEMENTED
            </span>
          </div>
          <div class="meta">
            {{ (current.market && current.market.instrument) || '—' }} ·
            {{ (current.market && current.market.timeframe) || '—' }}<br />
            Config <b>{{ current.source && current.source.config_path }}</b>
            · Schema <b>{{ current.source && current.source.schema_version }}</b>
            · Hash <b>{{ String((current.runtime && current.runtime.disk_config_hash) || '').slice(0, 8) }}…</b>
            · Runtime
            <b>{{
              current.runtime && current.runtime.active
                ? 'ACTIVE'
                : (current.runtime && current.runtime.state) || 'OFFLINE'
            }}</b>
            · Config Sync <b :class="sync.cls">{{ sync.text }}</b>
            · Modified
            <b>{{ String((current.source && current.source.modified_at) || '').replace('T', ' ').slice(0, 16) }}</b>
            · Source <b>{{ current.source && current.source.kind }}</b>
          </div>
        </div>
        <div v-else class="detail-head">加载中…</div>
        <div class="tabs">
          <button class="tab" :class="{ on: tab === 'summary' }" type="button" @click="tab = 'summary'">
            概要
          </button>
          <button class="tab" :class="{ on: tab === 'structured' }" type="button" @click="tab = 'structured'">
            结构化视图
          </button>
          <button class="tab" :class="{ on: tab === 'raw' }" type="button" @click="tab = 'raw'">原始配置</button>
          <button class="tab" :class="{ on: tab === 'effective' }" type="button" @click="tab = 'effective'">
            运行生效值
          </button>
        </div>
        <div class="toolbar" :class="{ hidden: !showCopy }">
          <button class="ghost sm" type="button" @click="copyJson">复制 JSON</button>
        </div>
        <div class="card-body" @click="onStructuredClick">
          <div v-if="tab === 'summary'" v-html="summaryHtml"></div>
          <div v-else-if="tab === 'structured'" v-html="structuredHtml"></div>
          <div v-else-if="jsonOffline" class="empty">Runtime: OFFLINE</div>
          <pre
            v-else
            class="json"
            id="jsonView"
            spellcheck="false"
            contenteditable="false"
          >{{ jsonText }}</pre>
        </div>
      </section>
    </div>
    <section class="card" style="margin-top: 14px; height: auto">
      <div class="card-head"><h2>Overview</h2></div>
      <div class="card-body">
        <table>
          <thead>
            <tr>
              <th class="nosort">ID</th>
              <th class="nosort">名称</th>
              <th class="nosort">类型</th>
              <th class="nosort">状态</th>
              <th class="nosort">周期</th>
              <th class="nosort">Symbols</th>
              <th class="nosort">Demo Allowed</th>
              <th class="nosort">Live Allowed</th>
              <th class="nosort">Runtime</th>
              <th class="nosort">Config Sync</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="it in items"
              :key="it.id"
              class="clickable"
              @click="select(it.id)"
            >
              <td>{{ it.id }}</td>
              <td>{{ it.name }}</td>
              <td>{{ it.type }}</td>
              <td>{{ it.status }}</td>
              <td>{{ it.timeframe || '—' }}</td>
              <td>{{ (it.symbols || []).join(', ') || '—' }}</td>
              <td>{{ it.demo_allowed ? 'YES' : 'NO' }}</td>
              <td>{{ it.live_allowed ? 'YES' : 'NO' }}</td>
              <td>{{ it.runtime_active ? 'ACTIVE' : 'OFF' }}</td>
              <td>{{ it.config_error ? 'ERROR' : '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </main>
</template>
