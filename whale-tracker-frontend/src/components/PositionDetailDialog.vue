<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { fetchWhalePosition, followCopyFromPosition, isTimeoutError, scheduleSilentRetry } from '@/api';
import PositionAnalysisDialog from '@/components/PositionAnalysisDialog.vue';
import type { WhalePosition, WhalePositionDetail, WhaleProfile, WhaleTrade } from '@/types';
import { displayAsset, hyperliquidExplorer } from '@/utils/assets';
import {
  displayEntryFillItems,
  entryFillKind,
  entryFillLabel,
  entryFillTotalCount,
} from '@/utils/whaleCardUtils';
import type { RecoOptions, RecoQuotes } from '@/utils/recommend';
import type { UserPositionInput } from '@/utils/positionAnalysis';
import {
  directionLabel,
  formatDuration,
  formatPnl,
  formatPrice,
  formatPriceGap,
  formatTime,
  formatTimeShort,
  formatUsd,
  isOpenTimeStale,
} from '@/utils/format';
import { useWhaleStore } from '@/stores/whale';
import { preferredCoinsState } from '@/utils/watchedCoins';
import { whaleCardTitle } from '@/utils/whaleReference';
import { isLoggedIn } from '@/stores/auth';

const whaleStore = useWhaleStore();

const props = withDefaults(
  defineProps<{
    whales?: WhaleProfile[];
    quotes?: RecoQuotes;
  }>(),
  {
    whales: () => [],
    quotes: () => ({}),
  },
);

const emit = defineEmits<{
  focusWhale: [payload: { id: string; name: string; coin?: string }];
  closed: [];
}>();

const visible = ref(false);
const loading = ref(false);
const error = ref('');
const whaleName = ref('');
const whaleAddress = ref('');
const activeWhale = ref<WhaleProfile | null>(null);
const detail = ref<WhalePositionDetail | null>(null);
const entryFillsExpanded = ref(false);
const analysisVisible = ref(false);
const analysisPreset = ref<Partial<UserPositionInput> | null>(null);
const copyBusy = ref(false);

const recoOptions = computed<RecoOptions>(() => ({
  coin: preferredCoinsState.value[0] || detail.value?.coin || 'BTC',
  window: 'all',
  decay: false,
}));

function fromCached(pos: WhalePosition): WhalePositionDetail {
  const leverage = pos.leverage;
  return {
    coin: pos.coin,
    coinLabel: pos.coinLabel || pos.coin,
    kind: 'perp',
    side: pos.side,
    size: pos.size,
    entryPx: pos.entryPx,
    markPx: null,
    positionValue: pos.positionValue,
    unrealizedPnl: pos.unrealizedPnl,
    liquidationPx: pos.liquidationPx == null || pos.liquidationPx === '' ? null : Number(pos.liquidationPx),
    leverage,
    leverageLabel: leverage ? `${leverage}x` : '现货',
    marginUsed: pos.marginUsed ?? (leverage ? pos.positionValue / leverage : pos.positionValue),
    openTime: pos.openTime || null,
    firstOpenTime: (pos.firstOpenTime ?? pos.openTime) || null,
    lastAddTime: pos.lastAddTime || null,
    openHistoryComplete: pos.openHistoryComplete,
    entryFills: pos.entryFills || [],
    entryFillsOmitted: pos.entryFillsOmitted || 0,
    explorerUrl: '',
  };
}

function fromTrade(trade: WhaleTrade): WhalePositionDetail {
  const px = Number(trade.price) || (trade.amount ? trade.amountUsd / trade.amount : 0);
  const closed = Math.abs(Number(trade.closedPnl) || 0) > 1;
  return {
    coin: trade.asset,
    coinLabel: trade.assetLabel || trade.asset,
    kind: trade.asset?.startsWith('@') ? 'spot' : 'perp',
    side: trade.side === 'sell' || trade.side === 'out' ? 'short' : 'long',
    size: trade.amount,
    entryPx: px || null,
    markPx: px || null,
    positionValue: trade.amountUsd,
    unrealizedPnl: Number(trade.closedPnl) || 0,
    liquidationPx: null,
    leverage: null,
    leverageLabel: trade.asset?.startsWith('@') ? '现货' : '--',
    marginUsed: trade.amountUsd,
    openTime: trade.time,
    closed,
    explorerUrl: '',
  };
}

type PositionSeed = WhalePosition | { coin: string; side?: 'long' | 'short' };

async function open(whale: WhaleProfile, pos: PositionSeed, trade?: WhaleTrade) {
  visible.value = true;
  whaleName.value = whale.name;
  whaleAddress.value = whale.address;
  activeWhale.value = whale;
  error.value = '';
  entryFillsExpanded.value = false;
  // 只有完整仓位对象才能先渲染缓存；{ coin, side } 是已平仓入口，直接等接口
  const isFullPosition = 'size' in pos && 'entryPx' in pos;
  const wantSide = 'side' in pos && pos.side ? pos.side : '';
  const cached = isFullPosition
    ? fromCached(pos as WhalePosition)
    : trade
      ? fromTrade(trade)
      : null;
  detail.value = cached;
  loading.value = true;
  try {
    const data = await fetchWhalePosition(whale.id, pos.coin, wantSide);
    detail.value = {
      ...data.position,
      explorerUrl: data.position.explorerUrl || hyperliquidExplorer(whale.address),
    };
    // 写回列表仓位，供（合）明细与卡片复用
    if (!data.position?.closed) {
      whaleStore.patchWhalePosition(whale.id, data.position.coin || pos.coin, wantSide || data.position.side || '', {
        entryFills: data.position.entryFills || [],
        entryFillsOmitted: data.position.entryFillsOmitted || 0,
        openTime: data.position.openTime ?? undefined,
        firstOpenTime: data.position.firstOpenTime ?? undefined,
        lastAddTime: data.position.lastAddTime ?? undefined,
        openHistoryComplete: data.position.openHistoryComplete,
        entryPx: data.position.entryPx ?? undefined,
        markPx: data.position.markPx ?? undefined,
        size: data.position.size,
        positionValue: data.position.positionValue ?? undefined,
        unrealizedPnl: data.position.unrealizedPnl ?? undefined,
      } as Partial<WhalePosition>);
    }
  } catch (err) {
    if (isTimeoutError(err)) {
      scheduleSilentRetry(`position-${whale.id}-${pos.coin}`, async () => {
        try {
          const data = await fetchWhalePosition(whale.id, pos.coin, wantSide);
          detail.value = data.position;
        } catch {
          // 已有缓存持仓
        }
      });
    } else if (!cached) {
      error.value = err instanceof Error ? err.message : '最新持仓刷新失败';
      if (/频繁|429/.test(error.value)) error.value = '查询过于频繁，已显示列表中的缓存数据';
    } else {
      error.value = err instanceof Error ? err.message : '未找到当前持仓，已显示成交数据';
    }
  } finally {
    loading.value = false;
  }
}

defineExpose({ open });

function pnlClass(value: number | null | undefined) {
  if (value == null || value === 0) return '';
  return value > 0 ? 'pnl-up' : 'pnl-down';
}

const title = computed(() => {
  const whale = activeWhale.value;
  const name = whale
    ? whaleCardTitle(whale)
    : whaleCardTitle({ name: whaleName.value, address: whaleAddress.value });
  if (!detail.value) return name;
  return `${name} · ${displayAsset(detail.value.coin, detail.value.coinLabel)}`;
});

const markPx = computed(() => {
  const row = detail.value;
  if (!row) return null;
  const direct = Number(row.markPx);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const entry = Number(row.entryPx) || 0;
  const size = Math.abs(Number(row.size) || 0);
  const pnl = Number(row.unrealizedPnl) || 0;
  if (!entry || !size) return null;
  return row.side === 'long' ? entry + pnl / size : entry - pnl / size;
});

const isClosed = computed(() => Boolean(detail.value?.closed));

const closedSizeText = computed(() => {
  const row = detail.value;
  const size = Math.abs(Number(row?.size) || 0);
  if (!size) return '';
  const asset = displayAsset(row?.coin || '', row?.coinLabel);
  return `（${size.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${asset}）`;
});

const roiText = computed(() => {
  const roi = Number(detail.value?.realizedRoi);
  if (!Number.isFinite(roi) || roi === 0) return '';
  const sign = roi > 0 ? '+' : '';
  return `（${sign}${roi.toFixed(2)}%）`;
});

const priceGapText = computed(() => {
  const row = detail.value;
  if (!row) return '';
  return formatPriceGap(row.entryPx, markPx.value, row.side);
});

const tpslText = computed(() => {
  const row = detail.value;
  if (!row) return '-- / --';
  const tp = row.takeProfitPx == null ? '--' : formatPrice(row.takeProfitPx);
  const sl = row.stopLossPx == null ? '--' : formatPrice(row.stopLossPx);
  return `${tp} / ${sl}`;
});

const entryFillCount = computed(() =>
  entryFillTotalCount({
    entryFills: detail.value?.entryFills || [],
    entryFillsOmitted: detail.value?.entryFillsOmitted || 0,
  }),
);

const displayEntryRows = computed(() =>
  displayEntryFillItems(detail.value?.entryFills || [], detail.value?.entryFillsOmitted || 0),
);

function toggleEntryFills() {
  if (entryFillCount.value <= 1) return;
  entryFillsExpanded.value = !entryFillsExpanded.value;
}

function locateWhaleCard() {
  const whale = activeWhale.value;
  if (!whale) return;
  const coin = detail.value?.coinLabel || detail.value?.coin || undefined;
  visible.value = false;
  emit('focusWhale', {
    id: whale.id,
    name: whale.name,
    coin: coin || undefined,
  });
}

function openPositionAnalysis() {
  const row = detail.value;
  if (!row || row.closed) return;
  const lev = Math.max(1, Number(row.leverage) || 20);
  const notional = Math.abs(Number(row.positionValue) || 0);
  const margin =
    Math.abs(Number(row.marginUsed) || 0) || (notional > 0 ? notional / lev : 500);
  analysisPreset.value = {
    coin: String(row.coinLabel || row.coin || '').split('/')[0] || 'BTC',
    side: row.side === 'short' ? 'short' : 'long',
    entryPx: Number(row.entryPx) || 0,
    leverage: lev,
    marginUsd: margin,
    accountEquityUsd: margin,
  };
  analysisVisible.value = true;
}

function openCopyPick() {
  if (!detail.value || detail.value.closed) return;
  if (!whaleAddress.value) {
    ElMessage.warning('缺少巨鲸地址，无法跟单');
    return;
  }
  if (!isLoggedIn.value) {
    ElMessage.warning('请先登录后再跟单');
    return;
  }
  // 暂只支持 OKX，跳过交易所选择弹窗
  void confirmOkxCopy();
}

async function confirmOkxCopy() {
  const row = detail.value;
  if (!row || row.closed) return;
  const coin = String(row.coinLabel || row.coin || '');
  const sideText = row.side === 'short' ? '空' : '多';
  const name = whaleName.value || '巨鲸';

  try {
    await ElMessageBox.confirm(
      `确认在 OKX 跟单「${name}」的 ${coin} ${sideText} 仓位？\n将按同方向、当前市价开仓；仓位大小=跟单本金×(巨鲸该仓保证金/巨鲸权益)×杠杆。\n开仓失败不会加入跟单列表。`,
      '确认跟单开仓',
      {
        confirmButtonText: '确认开仓',
        cancelButtonText: '取消',
        type: 'warning',
      },
    );
  } catch {
    return;
  }

  if (copyBusy.value) return;
  copyBusy.value = true;
  try {
    const result = await followCopyFromPosition({
      target: 'okx',
      whaleAddress: whaleAddress.value,
      whaleName: whaleName.value,
      whaleAccountValue: Number(activeWhale.value?.accountValue) || 0,
      whaleTotalPositionUsd:
        Math.abs(Number(activeWhale.value?.longUsd) || 0) +
        Math.abs(Number(activeWhale.value?.shortUsd) || 0),
      position: {
        coin: row.coin,
        coinLabel: row.coinLabel,
        side: row.side,
        size: row.size,
        entryPx: row.entryPx,
        markPx: markPx.value ?? row.markPx,
        positionValue: row.positionValue,
        unrealizedPnl: row.unrealizedPnl,
        leverage: row.leverage,
        marginUsed: row.marginUsed,
        liquidationPx: row.liquidationPx,
      },
    });
    if (result.snapshot) {
      window.dispatchEvent(new CustomEvent('whale-copy-update', { detail: result.snapshot }));
    }
    const n = (result.created?.length || 0) + (result.reused?.length || 0);
    const opened = Array.isArray(result.orders) ? result.orders.length : 0;
    const fails = Array.isArray(result.failures) ? result.failures : [];
    if (opened > 0 && fails.length === 0) {
      ElMessage.success(`已跟单开仓（${opened} 笔）${n ? ` · 已加入跟单列表` : ''}`);
      visible.value = false;
      window.dispatchEvent(new CustomEvent('whale-open-copy-workspace'));
    } else if (opened > 0 && fails.length) {
      ElMessage.warning(`部分开仓成功（${opened}）`);
      visible.value = false;
      window.dispatchEvent(new CustomEvent('whale-open-copy-workspace'));
    } else if (fails.length) {
      ElMessage.error(fails[0] || result.error || '开仓失败，未加入跟单列表');
    } else {
      ElMessage.warning('未开仓，未加入跟单列表');
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '跟单失败');
    try {
      const { fetchCopyTradeSnapshot } = await import('@/api');
      const snap = await fetchCopyTradeSnapshot();
      window.dispatchEvent(new CustomEvent('whale-copy-update', { detail: snap }));
    } catch {
      /* ignore */
    }
  } finally {
    copyBusy.value = false;
  }
}
</script>

<template>
  <el-dialog
    v-model="visible"
    width="560px"
    append-to-body
    class="pos-dialog"
    @closed="emit('closed')"
  >
    <template #header>
      <div class="dlg-header">
        <span class="dlg-title">{{ title }}</span>
      </div>
    </template>
    <el-skeleton v-if="loading && !detail" :rows="5" animated />
    <template v-else-if="detail">
      <el-alert
        v-if="error"
        class="dialog-alert"
        type="warning"
        :closable="false"
        :title="error"
      />
      <div class="detail">
        <div class="detail-row">
          <span>方向</span>
          <strong :class="detail.side === 'long' ? 'pnl-up' : 'pnl-down'">
            {{ directionLabel(detail.side) }}
            <el-tag v-if="isClosed" size="small" type="info">已平仓</el-tag>
          </strong>
        </div>
        <div class="detail-row entry-row">
          <span>开仓价</span>
          <div class="entry-value">
            <button
              type="button"
              class="entry-toggle"
              :class="{ multi: entryFillCount > 1, open: entryFillsExpanded }"
              @click="toggleEntryFills"
            >
              <strong>{{ detail.kind === 'spot' && !detail.entryPx ? '--' : formatPrice(detail.entryPx) }}</strong>
              <span v-if="entryFillCount > 1" class="multi-tag">（合）</span>
            </button>
          </div>
        </div>
        <ul v-if="entryFillsExpanded && entryFillCount > 1" class="entry-fills">
          <template v-for="(row, rowIndex) in displayEntryRows" :key="`${row.type}-${rowIndex}`">
            <li v-if="row.type === 'gap'" class="entry-fill-gap">...</li>
            <li v-else>
              <span class="fill-kind" :class="entryFillKind(row.fill, row.index)">
                {{ entryFillLabel(row.fill, row.index) }}
              </span>
              <span>{{ formatPrice(row.fill.price) }}</span>
              <span class="dim">· {{ formatUsd(row.fill.usd) }}</span>
              <span
                class="dim"
                :class="{ 'stale-open': entryFillKind(row.fill, row.index) === 'open' && isOpenTimeStale(row.fill.time) }"
              >· {{ formatTimeShort(row.fill.time) }}</span>
              <span v-if="row.fill.kind === 'reduce' && row.fill.closedPnl" :class="pnlClass(row.fill.closedPnl)">
                · {{ formatPnl(row.fill.closedPnl) }}
              </span>
            </li>
          </template>
        </ul>
        <div class="detail-row">
          <span>{{ isClosed ? '平仓价' : '当前币价' }}</span>
          <strong>{{ markPx ? formatPrice(markPx) : '--' }}</strong>
        </div>
        <div class="detail-row">
          <span>开仓时间</span>
          <strong
            :class="{
              'stale-open':
                detail.openHistoryComplete !== false &&
                isOpenTimeStale(detail.firstOpenTime || detail.openTime),
            }"
          >
            <template v-if="detail.openHistoryComplete === false">
              首次开仓未知
              <span v-if="detail.lastAddTime" class="gap">
                · 最近加仓 {{ formatTime(detail.lastAddTime) }}
              </span>
            </template>
            <template v-else>
              首次开仓 {{ formatTime(detail.firstOpenTime || detail.openTime || 0) }}
              <span
                v-if="
                  detail.lastAddTime &&
                  detail.lastAddTime !== (detail.firstOpenTime || detail.openTime)
                "
                class="gap"
              >
                · 最近加仓 {{ formatTime(detail.lastAddTime) }}
              </span>
            </template>
          </strong>
        </div>
        <template v-if="isClosed">
          <div class="detail-row">
            <span>平仓时间</span>
            <strong>{{ detail.closeTime ? formatTime(detail.closeTime) : '--' }}</strong>
          </div>
          <div class="detail-row">
            <span>持仓时长</span>
            <strong>{{ formatDuration(detail.holdMs) }}</strong>
          </div>
        </template>
        <div v-if="!isClosed" class="detail-row">
          <span>倍数</span>
          <strong>{{ detail.leverageLabel || '现货' }}</strong>
        </div>
        <div class="detail-row">
          <span>{{ isClosed ? '平仓规模' : '仓位价值' }}</span>
          <strong>
            {{ detail.positionValue ? formatUsd(detail.positionValue) : '--' }}
            <span v-if="isClosed && detail.size" class="gap">{{ closedSizeText }}</span>
          </strong>
        </div>
        <div v-if="!isClosed" class="detail-row">
          <span>本金</span>
          <strong>{{ detail.marginUsed ? formatUsd(detail.marginUsed) : '--' }}</strong>
        </div>
        <div class="detail-row">
          <span>{{ isClosed ? '已实现盈亏' : '目前盈亏' }}</span>
          <strong :class="pnlClass(isClosed ? detail.realizedPnl : detail.unrealizedPnl)">
            {{ formatPnl(isClosed ? detail.realizedPnl : detail.unrealizedPnl) }}
            <span v-if="isClosed && roiText" class="gap">{{ roiText }}</span>
            <span v-else-if="priceGapText" class="gap">{{ priceGapText }}</span>
            <el-tag v-if="loading" size="small" type="info" class="live-tag">刷新中</el-tag>
          </strong>
        </div>
        <div v-if="isClosed && detail.fees" class="detail-row">
          <span>手续费</span>
          <strong>{{ formatUsd(detail.fees) }}</strong>
        </div>
        <template v-if="!isClosed">
          <div class="detail-row">
            <span>爆仓价</span>
            <strong>
              {{
                detail.kind === 'spot' || detail.liquidationPx == null
                  ? '--'
                  : formatPrice(detail.liquidationPx)
              }}
            </strong>
          </div>
          <div class="detail-row">
            <span>止盈 / 止损</span>
            <strong>{{ tpslText }}</strong>
          </div>
        </template>
        <p v-if="isClosed" class="closed-note">
          数据来自该地址最近成交记录还原的最后一段「开仓 → 平仓」周期{{
            detail.entryEstimated ? '，开仓价为区间内均价，可能不完整' : ''
          }}。
        </p>
      </div>
    </template>
    <template #footer>
      <div class="actions">
        <el-button v-if="detail && !isClosed" @click="openPositionAnalysis">仓位分析</el-button>
        <el-button v-if="detail && !isClosed" type="success" :loading="copyBusy" @click="openCopyPick">
          跟单
        </el-button>
        <el-button type="primary" @click="locateWhaleCard">查看巨鲸卡片</el-button>
      </div>
    </template>
  </el-dialog>

  <PositionAnalysisDialog
    v-model="analysisVisible"
    :whales="props.whales"
    :quotes="props.quotes"
    :reco-options="recoOptions"
    :preset="analysisPreset"
    @locate-whale="emit('focusWhale', $event)"
  />
</template>

<style scoped>
.dialog-alert {
  margin-bottom: 12px;
}
.dlg-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-right: 28px;
}
.dlg-title {
  font-size: 18px;
  font-weight: 700;
  min-width: 0;
}
.detail {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.detail-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  font-size: 16px;
}
.detail-row span {
  color: var(--muted);
}
.entry-row {
  align-items: flex-start;
}
.entry-value {
  text-align: right;
}
.entry-toggle {
  border: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: default;
}
.entry-toggle.multi {
  cursor: pointer;
  color: var(--accent);
}
.entry-toggle.multi:hover {
  text-decoration: underline;
}
.multi-tag {
  margin-left: 2px;
  font-size: 13px;
  font-weight: 700;
}
.entry-fills {
  margin: -4px 0 0;
  padding: 10px 12px;
  list-style: none;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--card) 70%, transparent);
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
  max-height: 280px;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.entry-fills li {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.entry-fill-gap {
  justify-content: center;
  color: var(--muted);
  font-weight: 800;
  letter-spacing: 0.2em;
  opacity: 0.85;
  padding: 2px 0;
}
.fill-kind {
  flex: 0 0 auto;
  min-width: 2.5em;
  font-size: 11px;
  font-weight: 800;
  color: var(--muted);
}
.fill-kind.add {
  color: var(--bull);
}
.fill-kind.reduce {
  color: var(--bear);
}
.dim {
  color: var(--muted);
}
.pnl-up {
  color: var(--bull);
}
.pnl-down {
  color: var(--bear);
}
.live-tag {
  margin-left: 6px;
}
.gap {
  margin-left: 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--muted);
}
.closed-note {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}
.order-type {
  margin-left: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
}
.actions {
  display: flex;
  flex-wrap: nowrap;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
  width: 100%;
}
.actions :deep(.el-button) {
  margin: 0;
  flex: 0 0 auto;
  white-space: nowrap;
}
.stale-open {
  color: #e6a23c;
}
</style>

<style>
.pos-dialog.el-dialog {
  --el-dialog-width: 560px;
}
.pos-dialog .el-dialog__footer {
  display: flex;
  flex-wrap: nowrap;
}
.pos-dialog .el-dialog__footer .el-dialog__footer-btn,
.pos-dialog .el-dialog__footer .el-button + .el-button {
  margin-left: 0;
}
</style>
