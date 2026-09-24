<script setup lang="ts">
import { ref, watch } from 'vue';
import { fetchCalendar } from '@/api';
import type { CalendarEvent, WhaleProfile } from '@/types';
import type { RecoQuotes } from '@/utils/recommend';
import CoinFundFlow from '@/components/CoinFundFlow.vue';
import AiAnalyzeButton from '@/components/AiAnalyzeButton.vue';

type DataTab = 'macro' | 'flow';

const props = defineProps<{
  whales: WhaleProfile[];
  loading?: boolean;
  selectedId: string;
  selectedName: string;
  updatedAt?: number;
  quotes?: RecoQuotes;
  /** 巨鲸首屏就绪后再拉资金流向 / 宏观 */
  bootReady?: boolean;
}>();

const emit = defineEmits<{
  focusWhale: [payload: { id: string; name: string }];
}>();

const tab = ref<DataTab>('macro');
const macroLoading = ref(false);
const macroError = ref('');
const macroEvents = ref<CalendarEvent[]>([]);
const macroLoaded = ref(false);

function importanceStars(importance: CalendarEvent['importance']) {
  if (importance === 'high') return 3;
  if (importance === 'mid') return 2;
  return 1;
}

function starText(n: number) {
  return '★'.repeat(n) + '☆'.repeat(Math.max(0, 3 - n));
}

function macroAiContent(item: CalendarEvent) {
  const released =
    typeof item.daysUntil === 'number' &&
    (item.daysUntil < 0 || (item.daysUntil === 0 && Boolean(item.time)));
  const actualLine = item.actual
    ? `实际：${item.actual}`
    : released
      ? '实际：公布窗口已过，源站尚未回填（系统将尝试新闻补齐）'
      : '实际：待公布';
  const lines = [
    item.note || item.title,
    '',
    '【数据读数】',
    item.previous ? `前值：${item.previous}` : '',
    item.forecast ? `预测：${item.forecast}` : '',
    actualLine,
    item.importance ? `重要性：${item.importance}` : '',
    item.time || item.timeNote ? `公布时间：${item.dateLabel || ''} ${item.time || item.timeNote || ''}` : '',
  ].filter((l) => l !== undefined && l !== null);
  return lines.filter((l, i, arr) => !(l === '' && arr[i - 1] === '')).join('\n');
}

function macroAiMeta(item: CalendarEvent) {
  return {
    dateLabel: item.dateLabel,
    weekday: item.weekday,
    time: item.time || item.timeNote || '',
    importance: item.importance,
    previous: item.previous,
    forecast: item.forecast,
    actual: item.actual,
    coin: 'BTC',
  };
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 把「核心...」数据用黄色粗体高亮 */
function highlightCore(input: string) {
  const safe = escapeHtml(input || '');
  return safe.replace(/(核心[^，。；<>]*(?:[，；][^，。；<>]*)*)/g, '<span class="core">$1</span>');
}

function countdownLabel(event: CalendarEvent) {
  const d = event.daysUntil;
  if (event.isToday || d === 0) return '今天';
  if (d === -2) return '前天';
  if (d === -1) return '昨天';
  if (event.isTomorrow || d === 1) return '明天';
  if (d === 2) return '后天';
  if (d < 0) return `${Math.abs(d)} 天前`;
  return `${d} 天后`;
}

/** 距离今天 ±2 天以内：主标题直接用「今天/昨天/前天/明天/后天」 */
function isNearEvent(d: number) {
  return d >= -2 && d <= 2;
}

function primaryDateLabel(item: CalendarEvent) {
  if (isNearEvent(item.daysUntil)) return countdownLabel(item);
  return item.dateLabel;
}

function secondaryDateLabel(item: CalendarEvent) {
  if (isNearEvent(item.daysUntil)) return item.weekday;
  return `${item.weekday} · ${countdownLabel(item)}`;
}

async function loadMacro(force = false) {
  if (macroLoaded.value && !force) return;
  macroLoading.value = true;
  macroError.value = '';
  try {
    const data = await fetchCalendar(force);
    macroEvents.value = (data.events || [])
      .filter((item) => item.daysUntil >= -7 && item.daysUntil <= 7)
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
          <el-radio-button label="macro">宏观数据</el-radio-button>
          <el-radio-button label="flow">协议沉淀</el-radio-button>
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
          <article v-for="item in macroEvents" :key="item.id" class="row macro-row" :class="{ 'is-today': item.isToday }">
            <div class="row-time">
              <strong>{{ primaryDateLabel(item) }}</strong>
              <span>{{ secondaryDateLabel(item) }}</span>
              <em v-if="item.time">北京时间 {{ item.time }}</em>
              <em v-else-if="item.timeNote">{{ item.timeNote }}</em>
            </div>
            <div class="row-body">
              <div class="title-line">
                <span class="stars" :title="`${importanceStars(item.importance)} 星`">
                  {{ starText(importanceStars(item.importance)) }}
                </span>
                <strong class="title">{{ item.title }}</strong>
                <AiAnalyzeButton
                  source="macro"
                  :title="item.title"
                  :content="macroAiContent(item)"
                  :meta="macroAiMeta(item)"
                />
              </div>
              <p v-if="item.note" class="note" v-html="highlightCore(item.note)" />
              <div class="meta">
                <span v-if="item.previous" v-html="`前值 ` + highlightCore(item.previous)" />
                <span v-if="item.forecast" v-html="`预测 ` + highlightCore(item.forecast)" />
                <span v-if="item.actual" v-html="`实际 ` + highlightCore(item.actual)" />
                <span v-else-if="item.daysUntil < 0 || item.isToday" class="muted">实际待回填</span>
              </div>
            </div>
          </article>
        </div>
      </div>

      <div v-show="tab === 'flow'" class="tab-panel transfer-panel">
        <CoinFundFlow :boot-ready="bootReady" :active="tab === 'flow'" />
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
  color: var(--green);
  background: color-mix(in srgb, var(--green) 16%, transparent);
  border-color: transparent;
  box-shadow: none !important;
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
.row.macro-row.is-today {
  border: 1px solid var(--yellow);
  border-radius: 8px;
  margin: 0 -4px;
  padding: 10px 12px;
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
  color: var(--yellow);
  letter-spacing: 1px;
  font-size: 14px;
  line-height: 1.4;
}
.title {
  flex: 1;
  min-width: 0;
  font-size: 15px;
  line-height: 1.45;
  font-weight: 600;
}
.title-line :deep(.ai-chip) {
  margin-top: 2px;
}
.note {
  margin: 0 0 4px;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.5;
}
.note :deep(.core),
.meta :deep(.core) {
  color: var(--yellow);
  font-weight: 700;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  font-size: 13px;
  color: var(--muted);
}
</style>
