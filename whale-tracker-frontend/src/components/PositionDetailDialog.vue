<script setup lang="ts">
import { computed, ref, onUnmounted } from 'vue';
import { fetchWhalePosition } from '@/api';
import type { WhalePosition, WhalePositionDetail, WhaleProfile, WhaleTrade } from '@/types';
import { displayAsset, hyperliquidExplorer } from '@/utils/assets';
import {
  displayEntryFillItems,
  entryFillKind,
  entryFillLabel,
} from '@/utils/whaleCardUtils';
import {
  directionLabel,
  formatDuration,
  formatPnl,
  formatPrice,
  formatTime,
  formatTimeShort,
  formatUsd,
  isOpenTimeStale,
} from '@/utils/format';
import { useWhaleStore } from '@/stores/whale';
import { whaleCardTitle } from '@/utils/whaleReference';

const whaleStore = useWhaleStore();

const emit = defineEmits<{
  focusWhale: [payload: { id: string; name: string; coin?: string }];
  closed: [];
}>();

const visible = ref(false);
const loading = ref(false);
const historyLoading = ref(false);
let requestController: AbortController | null = null;
function cancelRequest() {
  openSeq++;
  requestController?.abort();
  loading.value = false;
  historyLoading.value = false;
}
onUnmounted(cancelRequest);
const error = ref('');
const whaleName = ref('');
const whaleAddress = ref('');
const activeWhaleId = ref('');
const activeWhale = computed(() => whaleStore.whalesById[activeWhaleId.value] || null);
const detailResponse = ref<WhalePositionDetail | null>(null);
const activePosition = ref<{ coin: string; side: string }>({ coin: '', side: '' });
let openSeq = 0;
const detail = computed({
  get(): WhalePositionDetail | null {
    const response = detailResponse.value;
    const whale = activeWhale.value;
    if (!response || !whale) return response;
    const position = whale.positions.find(pos => pos.coin === activePosition.value.coin && (!activePosition.value.side || pos.side === activePosition.value.side));
    if (!position) return response.closed ? response : { ...response, closed: true, size: 0, positionValue: 0, unrealizedPnl: 0 };
    if (response.closed) return { ...fromCached(position), closed: false, explorerUrl: hyperliquidExplorer(whale.address) };
    const live = fromCached(position);
    // Live PnL must not erase the complete history returned by the detail endpoint.
    return { ...response, ...live, markPx: response.markPx,
      entryFills: (position.entryFills?.length || 0) >= (response.entryFills?.length || 0) ? live.entryFills : response.entryFills,
      entryFillsOmitted: response.entryFillsOmitted,
      openTime: response.openTime, firstOpenTime: response.firstOpenTime,
      lastAddTime: response.lastAddTime, openHistoryComplete: response.openHistoryComplete,
      explorerUrl: response.explorerUrl || hyperliquidExplorer(whale.address) };

  },
  set(value: WhalePositionDetail | null) { detailResponse.value = value; },
});
const entryFillsExpanded = ref(false);
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
  cancelRequest();
  requestController = new AbortController();
  const signal = requestController.signal;
  const requestSeq = ++openSeq;
  const requested = whaleStore.whalesById[whale.id];
  visible.value = true;
  whaleName.value = whale.name;
  whaleAddress.value = whale.address;
  activeWhaleId.value = whale.id;
  activePosition.value = { coin: pos.coin, side: pos.side || '' };
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
  const applyDetail = (data: Awaited<ReturnType<typeof fetchWhalePosition>>) => {
    if (requestSeq !== openSeq || !visible.value) return;
    detail.value = { ...data.position, explorerUrl: data.position.explorerUrl || hyperliquidExplorer(whale.address) };
    if (!data.position.closed) {
      whaleStore.patchWhalePosition(whale.id, data.position.coin || pos.coin, wantSide || data.position.side || '', {
        entryFills: data.position.entryFills || [],
        entryFillsOmitted: data.position.entryFillsOmitted || 0,
        openTime: data.position.openTime ?? undefined,
        firstOpenTime: data.position.firstOpenTime ?? undefined,
        lastAddTime: data.position.lastAddTime ?? undefined,
        openHistoryComplete: data.position.openHistoryComplete,
      } as Partial<WhalePosition>, requested);
    }
  };
  try {
    try {
      const local = await fetchWhalePosition(whale.id, pos.coin, wantSide, { cacheOnly: true, signal });
      if (requestSeq !== openSeq || !visible.value) return;
      applyDetail(local);
      if (local.position.openHistoryComplete === true && !(local.position.entryFillsOmitted || 0) && !local.position.closed) return;
    } catch (err) {
      if (signal.aborted) return;
      // A missing local position can be resolved by the detail lookup below.
      if ((err as { response?: { status?: number } }).response?.status !== 404) throw err;
    }
    loading.value = false;
    historyLoading.value = true;
    const enriched = await fetchWhalePosition(whale.id, pos.coin, wantSide, { signal });
    applyDetail(enriched);
  } catch (err) {
    if (requestSeq !== openSeq || !visible.value || signal.aborted) return;
    error.value = detailResponse.value
      ? '历史明细暂未补齐，当前仓位仍随服务器推送更新。'
      : err instanceof Error ? err.message : '持仓详情读取失败';
  } finally {
    if (requestSeq === openSeq) { loading.value = false; historyLoading.value = false; }
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

const tpslText = computed(() => {
  const row = detail.value;
  if (!row) return '-- / --';
  const tp = row.takeProfitPx == null ? '--' : formatPrice(row.takeProfitPx);
  const sl = row.stopLossPx == null ? '--' : formatPrice(row.stopLossPx);
  return `${tp} / ${sl}`;
});

const displayEntryRows = computed(() =>
  displayEntryFillItems(detail.value?.entryFills || [], detail.value?.entryFillsOmitted || 0),
);

function toggleEntryFills() {
  entryFillsExpanded.value = !entryFillsExpanded.value;
}

async function retryEntryHistory() {
  const whale = activeWhale.value;
  if (!whale || loading.value || historyLoading.value) return;
  const request = open(whale, { coin: activePosition.value.coin, side: activePosition.value.side === 'short' ? 'short' : 'long' });
  entryFillsExpanded.value = true;
  await request;
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

</script>

<template>
  <el-dialog
    v-model="visible"
    width="min(580px, calc(100vw - 24px))"
    append-to-body
    class="pos-dialog"
    @close="cancelRequest"
    @closed="emit('closed')"
  >
    <template #header>
      <div class="dlg-header">
        <div class="position-heading"><span class="position-eyebrow">合约仓位详情</span><span class="dlg-title">{{ detail ? displayAsset(detail.coin, detail.coinLabel) : '仓位详情' }} <small v-if="detail" :class="detail.side === 'long' ? 'pnl-up' : 'pnl-down'">{{ directionLabel(detail.side) }}</small><small v-if="detail && !isClosed">{{ detail.leverageLabel || '—' }}</small><el-tag v-if="isClosed" size="small" type="info">已平仓</el-tag></span><span class="position-owner" :title="title">{{ whaleAddress ? whaleAddress.slice(0, 10) + '…' + whaleAddress.slice(-8) : whaleName }}</span></div>
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
      <div class="position-hero">
        <div class="hero-label"><span>{{ isClosed ? '已实现盈亏' : '未实现盈亏' }}</span><small v-if="loading">读取仓位…</small></div>
        <strong :class="pnlClass(isClosed ? detail.realizedPnl : detail.unrealizedPnl)">{{ formatPnl(isClosed ? detail.realizedPnl : detail.unrealizedPnl) }}</strong>
        <span v-if="isClosed && roiText" class="hero-roi">收益率 {{ roiText }}</span>
        <div class="hero-summary"><span>{{ isClosed ? '平仓规模' : '仓位价值' }}<b>{{ detail.positionValue == null ? '—' : formatUsd(detail.positionValue) }}</b></span><span v-if="!isClosed">已用保证金<b>{{ detail.marginUsed == null ? '—' : formatUsd(detail.marginUsed) }}</b></span><span v-else-if="detail.size">平仓数量<b>{{ closedSizeText }}</b></span></div>
      </div>
      <div class="detail">
        <div class="detail-row entry-row">
          <span>开仓均价</span>
          <div class="entry-value">
            <button
              type="button"
              class="entry-toggle"
              :class="{ open: entryFillsExpanded }"
              :aria-expanded="entryFillsExpanded"
              aria-controls="position-entry-history"
              title="点击查看开仓及加减仓合并记录"
              @click="toggleEntryFills"
            >
              <strong>{{ detail.kind === 'spot' && !detail.entryPx ? '--' : formatPrice(detail.entryPx) }}</strong>

            </button>
          </div>
        </div>
        <ul v-if="entryFillsExpanded" id="position-entry-history" class="entry-fills">
          <li class="entry-history-heading"><strong>开仓及加减仓记录</strong><span v-if="loading || historyLoading" role="status">正在补齐历史…</span><button v-else-if="error || !displayEntryRows.length || detail.entryFillsOmitted" type="button" class="history-retry" @click="retryEntryHistory">重新读取</button></li>
          <li v-if="!displayEntryRows.length" class="dim">{{ loading || historyLoading ? '已展开，记录返回后将在这里显示。' : '当前没有可展示的历史成交记录，不代表只有一笔开仓。' }}</li>
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
          <span>{{ isClosed ? '平仓价' : '当前参考价格' }}</span>
          <strong>{{ markPx ? formatPrice(markPx) : '--' }}</strong>
        </div>
        <div class="detail-row position-time">
          <span>建仓时间</span>
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
        <div v-if="isClosed && detail.fees" class="detail-row">
          <span>手续费</span>
          <strong>{{ formatUsd(detail.fees) }}</strong>
        </div>
        <template v-if="!isClosed">
          <div class="detail-row">
            <span>清算价格</span>
            <strong>
              {{
                detail.kind === 'spot' || detail.liquidationPx == null
                  ? '--'
                  : formatPrice(detail.liquidationPx)
              }}
            </strong>
          </div>
          <div v-if="detail.takeProfitPx != null || detail.stopLossPx != null" class="detail-row">
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
    <p v-if="historyLoading" class="history-status" role="status">正在补齐历史成交明细，当前盈亏不受影响。</p>
    <template #footer>
      <div class="actions">
        <el-button type="primary" @click="locateWhaleCard">查看巨鲸卡片</el-button>
      </div>
    </template>
  </el-dialog>

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
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px 24px;
}
.detail-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  font-size: 15px;
  min-width: 0;
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
  cursor: pointer;
  color: var(--accent);
  text-align: left;
}
.entry-toggle.multi {
  cursor: pointer;
  color: var(--accent);
}
.entry-toggle:hover {
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
  grid-column: 1 / -1;
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
.position-heading{display:grid;gap:8px}.position-eyebrow{font-size:10px;color:var(--muted);letter-spacing:1px}.dlg-title{display:flex;align-items:center;gap:10px;font-size:24px;flex-wrap:wrap}.dlg-title small{font-size:12px;border:1px solid var(--border);border-radius:5px;padding:3px 7px}.position-owner{font-size:12px;color:var(--muted);font-family:monospace;overflow-wrap:anywhere}.position-hero{padding:18px;background:var(--panel-2);border:1px solid var(--border);border-radius:10px;margin:0 0 22px}.hero-label{display:flex;justify-content:space-between;font-size:12px;color:var(--muted)}.position-hero>strong{display:block;font-size:32px;line-height:1.4;margin:5px 0 12px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.hero-summary{display:grid;grid-template-columns:1fr 1fr;gap:14px;border-top:1px solid var(--border);padding-top:13px}.hero-summary span{display:grid;gap:5px;font-size:11px;color:var(--muted)}.hero-summary b{font-size:17px;color:var(--text);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.hero-roi{font-size:12px}.detail-row>span{font-size:12px}.detail-row strong{overflow-wrap:anywhere}.position-time{grid-column:1/-1;order:2;border-top:1px solid var(--border);padding-top:14px}.position-time strong{font-size:12px;font-weight:500;line-height:1.8}.position-time .gap{display:block;margin-left:0;font-size:11px}.closed-note{grid-column:1/-1;order:3}.history-status{color:var(--muted);font-size:11px;margin:16px 0 0}.entry-fills{order:0}.entry-history-heading{justify-content:space-between}.entry-history-heading span{color:var(--muted);font-size:11px}.history-retry{border:0;background:none;color:var(--accent);cursor:pointer}.multi-tag{display:block;margin:5px 0 0;font-size:11px}.entry-toggle:focus-visible{outline:2px solid var(--accent);outline-offset:4px;border-radius:3px}.actions :deep(.el-button){border-radius:7px}.position-owner,.detail-row{min-width:0}
@media(max-width:420px){.position-hero>strong{font-size:27px}.detail{gap:15px}.hero-summary b{font-size:15px}}
</style>

<style>
.pos-dialog.el-dialog {
  max-height: calc(100dvh - 32px); overflow-y: auto; border: 1px solid var(--border); border-radius: 14px; background: var(--bg-2);
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
