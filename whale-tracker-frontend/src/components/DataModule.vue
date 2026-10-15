<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { fetchCalendar } from '@/api';
import type { CalendarEvent, WhaleProfile } from '@/types';
import type { RecoQuotes } from '@/utils/recommend';
import AiAnalyzeButton from '@/components/AiAnalyzeButton.vue';

const props = defineProps<{
  mobile?: boolean;
  active?: boolean;
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

const macroLoading = ref(false);
const macroError = ref('');
const macroEvents = ref<CalendarEvent[]>([]);
const macroLoaded = ref(false);

/** 同类发布只展示代表指标；完整采集与宏观对照历史由后端独立保留。 */
function isRepresentativeMacro(item: CalendarEvent) {
  const title = item.title.trim();
  if (/\bCPI\b|零售销售|Retail Sales/i.test(title)) {
    return ['零售销售（环比）', 'CPI（同比）', '核心 CPI（环比）'].includes(title);
  }
  return true;
}

function importanceStars(importance: CalendarEvent['importance']) {
  if (importance === 'high') return 3;
  if (importance === 'mid') return 2;
  return 1;
}

function starText(n: number) {
  return '★'.repeat(n) + '☆'.repeat(Math.max(0, 3 - n));
}

/** 日历注释可能含旧读数；统一使用独立字段，注释仅保留影响逻辑。 */
function macroNote(item: CalendarEvent) {
  return String(item.note || '').replace(
    /^(?:(?:预期|预测|前值|实际(?:值)?)\s*[:：]?\s*(?:[+\-−]?\d|待公布|待回填|未公布|暂无|—|--)[^·；;\n]*(?:[·；;]\s*|$))+/u,
    '',
  ).trim();
}

function macroAiContent(item: CalendarEvent) {
  const released = eventReleased(item);
  const actualLine = item.actual
    ? `实际：${item.actual}`
    : released
      ? '实际：公布窗口已过，源站尚未回填（系统将尝试新闻补齐）'
      : '实际：待公布';
  const lines = [
    macroNote(item) || item.title,
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
    note: macroNote(item),
    date: item.date,
    released: eventReleased(item),
    actualSource: item.actualSource || item.source,
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

function eventReleased(item: CalendarEvent) {
  if (!item.time || !/^\d{2}:\d{2}$/.test(item.time)) return item.daysUntil < 0;
  return Date.now() >= Date.parse(`${item.date}T${item.time}:00+08:00`);
}
async function loadMacro(force = false) {
  if (macroLoading.value) return;
  if (macroLoaded.value && !force) return;
  macroLoading.value = true;
  macroError.value = '';
  try {
    // Display refresh respects the shared server cache; each viewer does not force upstream fetches.
    const data = await fetchCalendar(false);
    macroEvents.value = (data.events || [])
      .filter((item) => item.daysUntil >= -7 && item.daysUntil <= 7)
      .filter((item) => item.importance === 'high' || item.importance === 'mid')
      .filter(isRepresentativeMacro)
      .slice(0, 40);
    macroLoaded.value = true;
  } catch (err) {
    macroError.value = err instanceof Error ? err.message : '宏观日历加载失败';
  } finally {
    macroLoading.value = false;
  }
}

let initialLoad: Promise<void> | null = null;
function initialize() { return initialLoad ||= loadMacro(false); }
let refreshTimer: ReturnType<typeof setInterval> | undefined;
function refreshVisible() {
  if (initialLoad && props.active !== false && !document.hidden) void loadMacro(true);
}
watch(() => props.active, active => { if (active) refreshVisible(); });
onMounted(() => {
  refreshTimer = setInterval(refreshVisible, 120000);
  document.addEventListener('visibilitychange', refreshVisible);
});
onUnmounted(() => {
  clearInterval(refreshTimer); document.removeEventListener('visibilitychange', refreshVisible);
});
defineExpose({ initialize });
</script>

<template>
  <el-card class="panel" :class="{'h5-macro-panel':mobile}" shadow="never">
    <div class="tab-stack">
      <div class="tab-panel">
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
                  :mobile="mobile"
                  :title="item.title"
                  :content="macroAiContent(item)"
                  :meta="macroAiMeta(item)"
                />
              </div>
              <dl class="macro-readings" aria-label="事件数据">
                <div><dt>前值</dt><dd>{{ item.previous || '未提供' }}</dd></div>
                <div><dt>预测</dt><dd>{{ item.forecast || '未提供' }}</dd></div>
                <div><dt>实际</dt><dd>{{ item.actual || (eventReleased(item) ? '待回填' : '待公布') }}</dd></div>
              </dl>
              <p v-if="macroNote(item)" class="note">{{ macroNote(item) }}</p>
              <p v-if="item.actualSource === 'BLS'" class="macro-source" title="根据 BLS 官方 CPI 指数计算，保留一位小数">来源 BLS</p>
            </div>
          </article>
        </div>
      </div>

    </div>
  </el-card>
</template>

<style scoped>
.panel.h5-macro-panel{border:0;background:transparent;border-radius:0}.h5-macro-panel .tab-panel{padding:0 0 12px}.h5-macro-panel .row{padding:12px 0}.h5-macro-panel .title{font-size:14px}.h5-macro-panel .note{font-size:12px;line-height:1.7}.h5-macro-panel .row-time{font-size:11px}.h5-macro-panel .row-time strong{font-size:13px}

.account-exchange-tabs { display: flex; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--border); }
.account-exchange-tabs button { border: 1px solid var(--border); background: var(--panel-2); color: var(--muted); border-radius: 6px; padding: 6px 18px; cursor: pointer; }
.account-exchange-tabs button.selected { color: var(--text); border-color: var(--accent); }
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
  font-weight: 700;
}
.title-line :deep(.ai-chip) {
  margin-top: 2px;
}
.note {
  margin: 10px 0 0;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.macro-readings {
  display: grid;
  grid-template-columns: repeat(3,minmax(0,1fr));
  gap: 0;
  margin: 12px 0 0;
  padding: 10px 0;
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  border: 1px solid var(--border);
  border-radius: 7px;
}
.macro-readings > div { min-width: 0; padding: 0 10px; }
.macro-readings > div + div { border-left: 1px solid var(--border); }
.macro-readings dt { font-size: 11px; color: var(--muted); margin-bottom: 5px; }
.macro-readings dd {
  margin: 0;
  color: #fff;
  font-size: 14px;
  font-weight: 700;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.macro-source {
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--muted);
}
</style>
