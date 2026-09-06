<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ArrowRight } from '@element-plus/icons-vue';
import type { WhaleProfile, WhaleTrade } from '@/types';
import type { WhaleAlert } from '@/utils/whaleAlerts';
import {
  formatPrice,
  formatUsd,
  formatLeverage,
  isOpenTimeStale,
} from '@/utils/format';
import type { RecoQuotes } from '@/utils/recommend';
import { preferredCoinsState } from '@/utils/watchedCoins';
import {
  filterFreshAlerts,
  filterFreshTrades,
  filterFreshWhales,
} from '@/utils/freshMode';
import { resolveWhaleTitle } from '@/utils/whaleReference';
import {
  readResonanceConfig,
  scanResonanceSignals,
  WINDOW_HOUR_OPTIONS,
  writeResonanceWindowHours,
  type ResonanceSignal,
  type ResonanceOpenRow,
} from '@/utils/whaleResonanceSignal';

const props = defineProps<{
  whales: WhaleProfile[];
  activity: WhaleTrade[];
  alerts: WhaleAlert[];
  quotes: RecoQuotes;
  ready: boolean;
  updatedAt?: number;
}>();

const emit = defineEmits<{
  focusWhale: [whale: Pick<WhaleProfile, 'id' | 'name'> & { coin?: string }];
}>();

const listVisible = ref(false);
const detailVisible = ref(false);
const windowHours = ref(readResonanceConfig().windowHours);
const activeSignal = ref<ResonanceSignal | null>(null);

watch(windowHours, (value) => writeResonanceWindowHours(value));

const scan = computed(() =>
  scanResonanceSignals({
    whales: filterFreshWhales(props.whales, Date.now(), props.alerts),
    activity: filterFreshTrades(props.activity, props.whales, Date.now(), props.alerts),
    alerts: filterFreshAlerts(props.alerts, props.whales),
    config: { ...readResonanceConfig(), windowHours: windowHours.value },
    watchedCoins: preferredCoinsState.value,
  }),
);

function signalKindLabel(kind: ResonanceSignal['kind']) {
  return kind === 'accumulation' ? '持续加仓' : '共振信号';
}

function openList() {
  if (!scan.value.primary) return;
  openDetail(scan.value.primary);
}

function openDetail(signal: ResonanceSignal) {
  activeSignal.value = signal;
  detailVisible.value = true;
}

function closeList() {
  listVisible.value = false;
  detailVisible.value = false;
  activeSignal.value = null;
}

function closeDetail() {
  detailVisible.value = false;
}

function formatMdOnly(ts: number) {
  if (!ts) return '--';
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatLiq(px: number | null | undefined) {
  if (!px || px <= 0) return '--';
  return formatPrice(px);
}

function onAddressClick(row: ResonanceOpenRow) {
  emit('focusWhale', { id: row.whaleId, name: row.whaleName, coin: row.coin });
  closeList();
  closeDetail();
}

function rowWhaleTitle(row: ResonanceOpenRow) {
  return resolveWhaleTitle(props.whales, {
    id: row.whaleId,
    name: row.whaleName,
    address: row.address,
  });
}

</script>

<template>
  <div v-if="ready" class="resonance-wrap notice-wrap">
    <div class="resonance-banner">
      <div class="banner-toolbar">
        <div class="window-box" @click.stop>
          <el-select v-model="windowHours" class="window-select" placeholder="时间范围">
            <el-option
              v-for="opt in WINDOW_HOUR_OPTIONS"
              :key="opt.value"
              :label="opt.label"
              :value="opt.value"
            />
          </el-select>
        </div>
      </div>

      <div
        class="signal-area"
        :class="{ clickable: Boolean(scan.primary) }"
        role="button"
        :tabindex="scan.primary ? 0 : -1"
        @click="openList"
        @keydown.enter.prevent="openList"
      >
        <template v-if="scan.primary">
          <div
            class="signal-record"
            :class="[scan.primary.side, scan.primary.kind]"
          >
            <span class="record-tag" :class="scan.primary.kind">{{ signalKindLabel(scan.primary.kind) }}</span>
            <span class="record-text">{{ scan.primary.bannerText }}</span>
          </div>
        </template>
        <span v-else class="empty-text">{{ scan.emptyText }}</span>
      </div>
    </div>

    <el-dialog
      v-model="listVisible"
      width="min(720px, 94vw)"
      append-to-body
      class="resonance-list-dialog"
      @close="closeList"
    >
      <template #header>
        <div class="dlg-head">
          <span class="dlg-title">共振信号</span>
          <span class="dlg-count">{{ scan.signals.length }} 条</span>
        </div>
      </template>

      <div class="signal-list">
        <button
          v-for="signal in scan.signals"
          :key="signal.id"
          type="button"
          class="signal-list-item"
          :class="[signal.side, signal.kind]"
          @click="openDetail(signal)"
        >
          <span class="record-tag" :class="signal.kind">{{ signalKindLabel(signal.kind) }}</span>
          <span class="record-text">{{ signal.bannerText }}</span>
          <el-icon class="record-arrow"><ArrowRight /></el-icon>
        </button>
      </div>

      <template #footer>
        <el-button @click="closeList">关闭</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="detailVisible"
      width="min(920px, 94vw)"
      append-to-body
      class="resonance-dialog"
      :class="activeSignal?.side || 'idle'"
      :show-close="false"
      @close="closeDetail"
    >
      <template #header>
        <div class="dlg-head">
          <div>
            <span class="dlg-title">{{ activeSignal ? signalKindLabel(activeSignal.kind) + '明细' : '信号明细' }}</span>
            <p v-if="activeSignal" class="dlg-sub">{{ activeSignal.bannerText }}</p>
          </div>
        </div>
      </template>

      <div v-if="activeSignal" class="detail-table-wrap">
        <table class="detail-table">
          <thead>
            <tr>
              <th>巨鲸</th>
              <th>币种</th>
              <th>方向</th>
              <th>开仓价</th>
              <th>名义本金</th>
              <th>开仓时间</th>
              <th>倍数</th>
              <th>爆仓价</th>
              <th>胜率</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in activeSignal.rows"
              :key="row.whaleId"
            >
              <td class="clickable-cell" @click="onAddressClick(row)">{{ rowWhaleTitle(row) }}</td>
              <td>{{ row.coin }}</td>
              <td :class="row.side === 'long' ? 'up' : 'down'">
                {{ row.side === 'long' ? '🟢多' : '🔴空' }}
              </td>
              <td>{{ formatPrice(row.price) }}</td>
              <td>
                {{ formatUsd(row.notionalUsd) }}
                <span v-if="(row.openCount || 0) > 1" class="open-count">{{ row.openCount }}笔</span>
              </td>
              <td :class="{ 'stale-open': isOpenTimeStale(row.time) }">
                <template v-if="(row.openCount || 0) > 1">{{ row.openCount }}笔 · </template>{{ formatMdOnly(row.time) }}
              </td>
              <td>{{ formatLeverage(row.leverage) }}</td>
              <td>{{ formatLiq(row.liquidationPx) }}</td>
              <td>{{ row.winRate }}%</td>
            </tr>
          </tbody>
        </table>
        <p class="hint">点击名称可定位到中间巨鲸卡片</p>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.resonance-wrap {
  width: 100%;
  max-width: 100%;
  min-width: 0;
}
.resonance-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  max-width: 100%;
  height: 44px;
  padding: 0 8px 0 10px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--card);
  box-sizing: border-box;
}
.banner-toolbar {
  display: contents;
}
.window-box {
  flex: 0 0 auto;
  width: 108px;
}
.window-select {
  width: 100%;
}
.window-select :deep(.el-select__wrapper) {
  min-height: 30px;
  box-shadow: none;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--card) 85%, transparent);
}
.signal-area {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
  height: 100%;
}
.signal-area.clickable {
  cursor: pointer;
}
.signal-area.clickable:hover .record-text {
  color: var(--accent);
}
.empty-text {
  color: var(--muted);
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.signal-record {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
}
.record-tag {
  flex: none;
  font-size: 11px;
  font-weight: 700;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--muted);
  white-space: nowrap;
}
.record-tag.accumulation {
  color: #c4a35a;
  border-color: color-mix(in srgb, #c4a35a 45%, var(--border));
}
.record-text {
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.signal-record.long .record-text {
  color: var(--bull);
}
.signal-record.short .record-text {
  color: var(--bear);
}
.dlg-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.dlg-title {
  font-size: 17px;
  font-weight: 700;
}
.dlg-count {
  color: var(--muted);
  font-size: 13px;
}
.dlg-sub {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.4;
}
.signal-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.signal-list-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--card) 88%, #000 12%);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.signal-list-item:hover {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
}
.record-arrow {
  margin-left: auto;
  color: var(--muted);
}
.detail-table-wrap {
  overflow: auto;
}
.detail-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.detail-table th,
.detail-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  text-align: left;
  white-space: nowrap;
}
.detail-table th {
  color: var(--muted);
  font-weight: 600;
}
.mono {
  font-variant-numeric: tabular-nums;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.clickable-cell {
  cursor: pointer;
  color: var(--accent);
}
.clickable-cell:hover {
  text-decoration: underline;
}
.up {
  color: var(--bull);
}
.down {
  color: var(--bear);
}
.open-count {
  margin-left: 4px;
  color: var(--muted);
  font-size: 12px;
}
.stale-open {
  color: #c4a35a;
}
.hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--muted);
}
</style>
