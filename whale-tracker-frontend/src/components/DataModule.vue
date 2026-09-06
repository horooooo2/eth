<script setup lang="ts">
import { ref, watch } from 'vue';
import { fetchCalendar } from '@/api';
import type { CalendarEvent, WhaleProfile } from '@/types';
import type { RecoQuotes } from '@/utils/recommend';
import XFeed from '@/components/XFeed.vue';
import { clearXUnread, xUnread } from '@/stores/xFeed';

type DataTab = 'macro' | 'x';

const props = defineProps<{
  whales: WhaleProfile[];
  loading?: boolean;
  selectedId: string;
  selectedName: string;
  updatedAt?: number;
  quotes?: RecoQuotes;
  /** 巨鲸首屏就绪后再拉 X / 宏观 */
  bootReady?: boolean;
}>();

const emit = defineEmits<{
  focusWhale: [payload: { id: string; name: string }];
}>();

const tab = ref<DataTab>('x');
const macroLoading = ref(false);
const macroError = ref('');
const macroEvents = ref<CalendarEvent[]>([]);
const macroLoaded = ref(false);

watch(tab, (t) => {
  if (t === 'x') clearXUnread();
});

function importanceStars(importance: CalendarEvent['importance']) {
  if (importance === 'high') return 3;
  if (importance === 'mid') return 2;
  return 1;
}

function starText(n: number) {
  return '★'.repeat(n) + '☆'.repeat(Math.max(0, 3 - n));
}

function countdownLabel(event: CalendarEvent) {
  if (event.isToday || event.daysUntil === 0) return '今天';
  if (event.isTomorrow || event.daysUntil === 1) return '明天';
  if (event.daysUntil < 0) return `${Math.abs(event.daysUntil)} 天前`;
  return `${event.daysUntil} 天后`;
}

async function loadMacro(force = false) {
  if (macroLoaded.value && !force) return;
  macroLoading.value = true;
  macroError.value = '';
  try {
    const data = await fetchCalendar(force);
    macroEvents.value = (data.events || [])
      .filter((item) => item.daysUntil >= 0 && item.daysUntil <= 7)
      .filter((item) => item.importance === 'high' || item.importance === 'mid')
      .slice(0, 40);
    macroLoaded.value = true;
  } catch (err) {
    macroError.value = err instanceof Error ? err.message : '宏观日历加载失败';
  } finally {
    macroLoading.value = false;
  }
}

async function onTabChange(next: string | number | boolean | undefined) {
  if (!props.bootReady) return;
  const t = (typeof next === 'string' ? next : tab.value) as DataTab;
  if (t === 'macro') await loadMacro(false);
}

watch(
  () => props.bootReady,
  (ready) => {
    if (!ready) return;
    void loadMacro(false);
  },
  { immediate: true },
);
</script>

<template>
  <el-card class="panel" shadow="never">
    <template #header>
      <div class="head">
        <el-radio-group v-model="tab" class="direction-filter" @change="onTabChange">
          <el-radio-button label="x">
            <span class="tab-label">
              X
              <i v-if="xUnread && tab !== 'x'" class="unread-dot" aria-hidden="true" />
            </span>
          </el-radio-button>
          <el-radio-button label="macro">宏观数据</el-radio-button>
        </el-radio-group>
      </div>
    </template>

    <div class="tab-stack">
      <div v-show="tab === 'macro'" class="tab-panel">
        <el-skeleton v-if="macroLoading && !macroEvents.length" :rows="8" animated />
        <el-alert
          v-else-if="macroError && !macroEvents.length"
          type="warning"
          :closable="false"
          :title="macroError"
        />
        <el-empty v-else-if="!macroEvents.length" description="暂无近期重要事件" />
        <div v-else class="list">
          <article v-for="item in macroEvents" :key="item.id" class="row macro-row">
            <div class="row-time">
              <strong>{{ item.dateLabel }}</strong>
              <span>{{ item.weekday }} · {{ countdownLabel(item) }}</span>
              <em v-if="item.time">北京时间 {{ item.time }}</em>
              <em v-else-if="item.timeNote">{{ item.timeNote }}</em>
            </div>
            <div class="row-body">
              <div class="title-line">
                <span class="stars" :title="`${importanceStars(item.importance)} 星`">
                  {{ starText(importanceStars(item.importance)) }}
                </span>
                <strong class="title">{{ item.title }}</strong>
              </div>
              <p v-if="item.note" class="note">{{ item.note }}</p>
              <div class="meta">
                <span v-if="item.previous">前值 {{ item.previous }}</span>
                <span v-if="item.forecast">预测 {{ item.forecast }}</span>
                <span v-if="item.actual">公布 {{ item.actual }}</span>
              </div>
            </div>
          </article>
        </div>
      </div>

      <div v-show="tab === 'x'" class="tab-panel transfer-panel">
        <XFeed :limit="40" :boot-ready="bootReady" :active="tab === 'x'" />
      </div>
    </div>
  </el-card>
</template>

<style scoped>
.panel {
  height: 100%;
  min-height: 0;
  min-width: 0;
  background: var(--card);
  border: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}
.panel :deep(.el-card__header) {
  padding: 12px 16px;
}
.panel :deep(.el-card__body) {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  padding: 0;
}
.head {
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
}
.head :deep(.direction-filter) {
  display: flex;
  width: 100%;
  flex-wrap: nowrap;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  background: color-mix(in srgb, var(--card) 70%, transparent);
}
.head :deep(.direction-filter .el-radio-button) {
  flex: 1 1 0;
  min-width: 0;
}
.head :deep(.direction-filter .el-radio-button__inner) {
  width: 100%;
  height: 34px;
  line-height: 34px;
  padding: 0 6px;
  border: 0;
  border-radius: 0;
  box-shadow: none !important;
  font-size: 14px;
  font-weight: 700;
  text-align: center;
  background: transparent;
  color: var(--muted);
}
.head :deep(.direction-filter .el-radio-button + .el-radio-button .el-radio-button__inner) {
  border-left: 1px solid var(--border);
}
.head :deep(.direction-filter .el-radio-button__original-radio:checked + .el-radio-button__inner) {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  border-color: transparent;
  box-shadow: none !important;
}
.tab-label {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}
.unread-dot {
  position: absolute;
  top: -2px;
  right: -10px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #e5484d;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--card) 80%, transparent);
}
.tab-stack {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template: 1fr / 1fr;
}
.tab-panel {
  grid-area: 1 / 1;
  min-height: 0;
  overflow: auto;
  padding: 8px 12px 12px;
}
.transfer-panel {
  overflow: hidden;
  display: flex;
  flex-direction: column;
  padding: 0;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.row {
  padding: 10px 8px;
  border-bottom: 1px solid var(--border);
}
.row:last-child {
  border-bottom: none;
}
.row-time {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  align-items: baseline;
  margin-bottom: 6px;
  color: var(--muted);
  font-size: 13px;
}
.row-time strong {
  color: var(--text);
  font-size: 15px;
}
.row-time em {
  font-style: normal;
  opacity: 0.85;
}
.title-line {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 4px;
}
.stars {
  flex: none;
  color: #c4a35a;
  letter-spacing: 1px;
  font-size: 14px;
  line-height: 1.4;
}
.title {
  font-size: 15px;
  line-height: 1.45;
  font-weight: 600;
}
.note {
  margin: 0 0 4px;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.5;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  font-size: 13px;
  color: var(--muted);
}
</style>
