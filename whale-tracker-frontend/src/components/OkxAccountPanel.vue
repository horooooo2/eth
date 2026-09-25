<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue';
import { cancelBinanceOrder, cancelOkxOrder, fetchBinanceAccountBook, fetchOkxAiBook, fetchTradfiAccountBook, type OkxAiBook, type OkxAiOrderRecord } from '@/api';
import { formatSignedUsd, formatTimeShort, formatUsd } from '@/utils/format';

const props = defineProps<{
  bootReady?: boolean;
  active?: boolean;
  exchange?: 'binance' | 'okx' | 'tradfi';
}>();

const loading = ref(false);
const error = ref('');
const book = ref<OkxAiBook | null>(null);
const cancelingId = ref('');
let timer: ReturnType<typeof setInterval> | null = null;
let reqSeq = 0;

function valueClass(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n) || n === 0) return '';
  return n > 0 ? 'gain' : 'loss';
}

function sideLabel(row: OkxAiOrderRecord) {
  const ps = String(row.posSide || '').toLowerCase();
  if (ps === 'long' || row.side === 'buy') return '做多';
  if (ps === 'short' || row.side === 'sell') return '做空';
  return row.side || '--';
}

function stateLabel(state: string) {
  if (state === 'live') return '挂单中';
  if (state === 'partially_filled') return '部分成交';
  if (state === 'filled') return '已成交';
  if (state === 'canceled' || state === 'cancelled') return '已撤销';
  if (state === 'recorded') return '已提交';
  return state || '已提交';
}

function plainAmount(n: number | null | undefined) {
  if (n == null || !Number.isFinite(Number(n))) return '--';
  return `${Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 8 })} USDT`;
}

function notionalAmount(row: OkxAiOrderRecord) {
  const amount = Number(row.amountUsd);
  if (Number.isFinite(amount) && amount > 0) {
    return plainAmount(props.exchange === 'okx' && row.kind === 'pending' ? amount * (Number(row.leverage) || 1) : amount);
  }
  return '--';
}

function rowPnl(row: OkxAiOrderRecord) {
  if (row.realizedPnl != null && Number.isFinite(row.realizedPnl)) return row.realizedPnl;
  if (row.openUpl != null && Number.isFinite(row.openUpl)) return row.openUpl;
  return null;
}

async function load(silent = false) {
  if (!props.bootReady || props.active === false) return;
  const seq = ++reqSeq;
  if (!silent) loading.value = true;
  error.value = '';
  try {
    const data = await (props.exchange === 'tradfi' ? fetchTradfiAccountBook() : props.exchange === 'binance' ? fetchBinanceAccountBook() : fetchOkxAiBook());
    if (seq !== reqSeq) return;
    book.value = data;
  } catch (err) {
    if (seq !== reqSeq) return;
    error.value = err instanceof Error ? err.message : '交易账户加载失败';
  } finally {
    if (seq === reqSeq) loading.value = false;
  }
}

async function cancelRow(row: OkxAiOrderRecord) {
  if (row.kind !== 'pending' || !row.instId || !row.ordId || cancelingId.value) return;
  cancelingId.value = row.ordId;
  error.value = '';
  try {
    if (props.exchange === 'binance') await cancelBinanceOrder({ symbol: row.instId, orderId: row.ordId });
    else await cancelOkxOrder({ instId: row.instId, ordId: row.ordId });
    await load(true);
  } catch (err) {
    error.value = err instanceof Error ? err.message : '取消挂单失败';
  } finally {
    if (cancelingId.value === row.ordId) cancelingId.value = '';
  }
}

function startPoll() {
  stopPoll();
  if (!props.bootReady || props.active === false) return;
  timer = setInterval(() => {
    void load(true);
  }, 20_000);
}

function stopPoll() {
  if (timer) clearInterval(timer);
  timer = null;
}

watch(
  () => [props.bootReady, props.active, props.exchange] as const,
  ([ready, active]) => {
    if (!ready || active === false) {
      stopPoll();
      return;
    }
    void load(false);
    startPoll();
  },
  { immediate: true },
);

onUnmounted(stopPoll);
</script>

<template>
  <div class="okx-panel">
    <div class="account-summary">
      <div class="data-card">
        <div class="data-label">当前余额</div>
        <div class="data-value">{{ formatUsd(book?.balance.usdtEq ?? book?.balance.totalEq) }}</div>
        <div class="data-sub">可用 {{ formatUsd(book?.balance.availBal) }}</div>
      </div>
      <div class="data-card">
        <div class="data-label">当前仓位盈亏</div>
        <div class="data-value" :class="valueClass(book?.openPnl)">{{ formatSignedUsd(book?.openPnl) }}</div>
        <div class="data-sub">{{ props.exchange === 'tradfi' ? 'TradFi 持仓' : props.exchange === 'binance' ? '全部持仓' : 'AI 持仓' }}</div>
      </div>
      <div class="data-card">
        <div class="data-label">历史盈亏</div>
        <div class="data-value" :class="valueClass(book?.historyPnl)">{{ book?.historyPnl == null ? '--' : formatSignedUsd(book.historyPnl) }}</div>
        <div class="data-sub">{{ props.exchange === 'okx' ? 'AI 已平' : '暂未统计' }}</div>
      </div>
    </div>

    <p v-if="props.exchange === 'tradfi'" class="account-note">余额与币安 U 本位合约账户共用；下方只展示 TradFi 持仓与普通挂单。</p>
    <el-alert v-if="error" type="warning" :closable="false" :title="error" class="alert" />
    <el-alert v-else-if="book?.configured === false" type="info" :closable="false" title="请先在左下角「API 设置」配置币安 API 密钥" class="alert" />
    <el-skeleton v-else-if="loading && !book" :rows="6" animated class="pad" />
    <el-empty v-else-if="!book?.records.length" :description="props.exchange === 'okx' ? '暂无 AI 开单记录' : '暂无持仓或挂单'" class="pad" />
    <div v-else class="order-list">
      <article v-for="row in book.records" :key="(row.kind || 'row') + ':' + row.ordId" class="order-card">
        <div class="order-main">
          <span class="coin-name">{{ row.coin || row.instId }}</span>
          <span class="tag" :class="row.kind === 'pending' ? 'tag-pending' : 'tag-pos'">
            {{ row.kind === 'pending' ? '挂单' : '仓位' }}
          </span>
          <span class="direction" :class="sideLabel(row) === '做多' ? 'direction-long' : 'direction-short'">
            {{ sideLabel(row) }}
          </span>
          <span v-if="row.kind === 'pending'" class="status-text">{{ stateLabel(row.state) }}</span>
          <button
            v-if="row.kind === 'pending' && props.exchange !== 'tradfi'"
            type="button"
            class="cancel-btn"
            :disabled="cancelingId === row.ordId"
            @click="cancelRow(row)"
          >
            {{ cancelingId === row.ordId ? '取消中' : '取消' }}
          </button>
          <span v-else class="order-pnl" :class="valueClass(rowPnl(row))">{{ formatSignedUsd(rowPnl(row)) }}</span>
        </div>
        <div class="order-details">
          <div class="detail-item">
            {{ row.kind === 'pending' ? '委托价' : '均价' }}
            <span class="detail-value">{{ plainAmount(row.px) }}</span>
          </div>
          <div class="detail-item">
            数量 <span class="detail-value">{{ notionalAmount(row) }}</span>
          </div>
          <div class="detail-item">
            杠杆 <span class="detail-value">{{ row.leverage ? row.leverage + 'x' : '--' }}</span>
          </div>
          <div class="detail-item">
            时间 <span class="detail-value">{{ row.createdAt ? formatTimeShort(row.createdAt) : '--' }}</span>
          </div>
        </div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.okx-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--panel);
}
.account-note { margin: 0; padding: 10px 16px; color: var(--muted); font-size: 11px; line-height: 1.5; border-bottom: 1px solid var(--border); }
.account-summary {
  display: flex;
  align-items: stretch;
  gap: 8px;
  padding: 16px;
  border-bottom: 1px solid var(--border);
}
.data-card {
  flex: 1;
  min-width: 0;
  background: var(--panel-2);
  padding: 12px;
  border-radius: 8px;
  border: 1px solid transparent;
}
.data-card:hover {
  border-color: var(--border);
}
.data-label {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 6px;
  white-space: nowrap;
}
.data-value {
  font-size: 18px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--text);
  margin-bottom: 4px;
}
.data-value.loss,
.order-pnl.loss,
.direction-short {
  color: var(--red);
}
.data-value.gain,
.order-pnl.gain,
.direction-long {
  color: var(--green);
}
.data-sub {
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.alert,
.pad {
  margin: 8px 16px;
}
.order-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.order-card {
  background: var(--panel-2);
  border-radius: 8px;
  padding: 16px;
  border: 1px solid transparent;
}
.order-card:hover {
  background: var(--panel-3);
  border-color: var(--border);
}
.order-main {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.coin-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.tag {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 500;
}
.tag-pending {
  background: color-mix(in srgb, var(--yellow) 12%, transparent);
  color: var(--yellow);
  border: 1px solid color-mix(in srgb, var(--yellow) 30%, transparent);
}
.tag-pos {
  background: color-mix(in srgb, var(--green) 12%, transparent);
  color: var(--green);
  border: 1px solid color-mix(in srgb, var(--green) 30%, transparent);
}
.direction {
  font-size: 13px;
  font-weight: 600;
}
.status-text {
  color: var(--muted);
  font-size: 13px;
  margin-left: 4px;
}
.cancel-btn,
.order-pnl {
  margin-left: auto;
}
.cancel-btn {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--muted);
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
}
.cancel-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--red) 10%, transparent);
  color: var(--red);
  border-color: var(--red);
}
.cancel-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.order-pnl {
  font-size: 14px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--text);
}
.order-details {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.detail-item {
  display: flex;
  align-items: center;
  gap: 4px;
}
.detail-value {
  color: var(--text);
}
</style>
