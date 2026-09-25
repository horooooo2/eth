<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { cancelOkxOrder, fetchOkxAiBook, fetchTradfiAccountBook, type OkxAiBook, type OkxAiOrderRecord } from '@/api';
import { formatSignedUsd, formatTimeShort, formatUsd } from '@/utils/format';

const props = defineProps<{
  bootReady?: boolean;
  active?: boolean;
  exchange?: 'okx' | 'tradfi';
}>();
const emit = defineEmits<{ loaded: [book: OkxAiBook] }>();

const loading = ref(false);
const error = ref('');
const book = ref<OkxAiBook | null>(null);
const cancelingId = ref('');
let timer: ReturnType<typeof setInterval> | null = null;
let reqSeq = 0;

type TradfiStrategy = NonNullable<OkxAiBook['strategies']>[number];
type TradfiGroup = { instId: string; coin: string; long?: OkxAiOrderRecord; short?: OkxAiOrderRecord; strategy?: TradfiStrategy };
const clock = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | null = null;
const tradfiGroups = computed<TradfiGroup[]>(() => {
  const bySymbol = new Map<string, TradfiGroup>();
  for (const row of book.value?.records || []) {
    const key = row.instId;
    if (!key) continue;
    const group = bySymbol.get(key) || { instId: key, coin: row.coin || key.replace(/USDT$/, '') };
    const isLong = String(row.posSide).toLowerCase() === 'long' || (String(row.posSide).toLowerCase() === 'both' && row.side === 'buy');
    const side = isLong ? 'long' : 'short';
    const current = group[side];
    if (!current || (current.kind !== 'position' && row.kind === 'position')) group[side] = row;
    bySymbol.set(key, group);
  }
  for (const strategy of book.value?.strategies || []) {
    if (!strategy.enabled) continue;
    const group = bySymbol.get(strategy.symbol) || {
      instId: strategy.symbol,
      coin: strategy.symbol === 'XAUUSDT' ? '黄金（GOLD）' : strategy.symbol === 'XAGUSDT' ? '白银（SILVER）' : strategy.symbol,
    };
    group.strategy = strategy;
    bySymbol.set(strategy.symbol, group);
  }
  return [...bySymbol.values()];
});

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

function rowPnl(row?: OkxAiOrderRecord) {
  if (!row) return null;
  if (row.realizedPnl != null && Number.isFinite(row.realizedPnl)) return row.realizedPnl;
  if (row.openUpl != null && Number.isFinite(row.openUpl)) return row.openUpl;
  return null;
}

function entryPrice(row?: OkxAiOrderRecord) {
  if (!row || row.px == null || !Number.isFinite(Number(row.px))) return '—';
  return Number(row.px).toLocaleString('zh-CN', { maximumFractionDigits: 8 });
}

function groupMode(group: TradfiGroup) {
  const strategy = group.strategy;
  if (strategy?.status === 'waiting') {
    const remaining = Number(strategy.cooldownUntil || 0) - clock.value;
    if (remaining > 0) return `冷却检查 · ${countdown(remaining)} 后检查开仓`;
    return '检查震荡条件';
  }
  if (strategy?.status === 'entry_pending') return '等待双向底仓成交';
  if (strategy?.status === 'add_pending') return `第 ${(strategy.additions || 0) + 1} 档补仓挂单中`;
  if (strategy?.status === 'active') return `策略运行中 · 已补 ${strategy.additions || 0} 档`;
  if (group.long?.kind === 'pending' || group.short?.kind === 'pending') return '含挂单';
  if (group.long && group.short) return '双向持仓';
  return '单向持仓';
}

function countdown(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

async function load(silent = false) {
  if (!props.bootReady || props.active === false) return;
  const seq = ++reqSeq;
  if (!silent) loading.value = true;
  error.value = '';
  try {
    const data = await (props.exchange === 'tradfi' ? fetchTradfiAccountBook() : fetchOkxAiBook());
    if (seq !== reqSeq) return;
    book.value = data;
    emit('loaded', data);
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
    await cancelOkxOrder({ instId: row.instId, ordId: row.ordId });
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

clockTimer = setInterval(() => { clock.value = Date.now(); }, 1000);
onUnmounted(() => { stopPoll(); if (clockTimer) clearInterval(clockTimer); });
defineExpose({ reload: () => load(true) });
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
        <div class="data-sub">{{ props.exchange === 'tradfi' ? '策略持仓' : 'AI 持仓' }}</div>
      </div>
      <div class="data-card">
        <div class="data-label">历史盈亏</div>
        <div class="data-value" :class="valueClass(book?.historyPnl)">{{ book?.historyPnl == null ? '--' : formatSignedUsd(book.historyPnl) }}</div>
        <div class="data-sub">{{ props.exchange === 'okx' ? 'AI 已平' : '暂未统计' }}</div>
      </div>
    </div>

    <p v-if="props.exchange === 'tradfi'" class="account-note">余额与币安 U 本位合约账户共用；下方只展示本站自动策略提交的 TradFi 持仓与挂单。</p>
    <el-alert v-if="error" type="warning" :closable="false" :title="error" class="alert" />
    <el-alert v-else-if="book?.configured === false" type="info" :closable="false" title="请先在左下角「API 设置」配置币安 API 密钥" class="alert" />
    <el-skeleton v-else-if="loading && !book" :rows="6" animated class="pad" />
    <el-empty v-else-if="props.exchange === 'tradfi' ? !tradfiGroups.length : !book?.records.length" :description="props.exchange === 'tradfi' ? '暂无运行中的策略或策略开单记录' : '暂无 AI 开单记录'" class="pad" />
    <div v-else-if="props.exchange === 'tradfi'" class="order-list tradfi-order-list">
      <article v-for="group in tradfiGroups" :key="group.instId" class="asset-card">
        <div class="asset-header">
          <span>{{ group.coin }}</span>
          <span class="asset-mode">{{ groupMode(group) }}</span>
        </div>
        <div class="position-row">
          <section class="position-side">
            <div class="side-header"><span class="side-badge long">多头</span></div>
            <div class="position-details">
              <span class="label">持仓价</span>
              <span class="value">
                {{ group.long ? entryPrice(group.long) : '—' }}
                <span v-if="group.long?.leverage" class="leverage-tag">{{ group.long.leverage }}x</span>
              </span>
              <span class="label">名义价值</span>
              <span class="value">{{ group.long ? notionalAmount(group.long) : '—' }}</span>
              <span class="label">盈亏</span>
              <span class="value" :class="valueClass(rowPnl(group.long))">{{ group.long ? formatSignedUsd(rowPnl(group.long)) : '—' }}</span>
            </div>
          </section>
          <section class="position-side">
            <div class="side-header"><span class="side-badge short">空头</span></div>
            <div class="position-details">
              <span class="label">持仓价</span>
              <span class="value">
                {{ group.short ? entryPrice(group.short) : '—' }}
                <span v-if="group.short?.leverage" class="leverage-tag">{{ group.short.leverage }}x</span>
              </span>
              <span class="label">名义价值</span>
              <span class="value">{{ group.short ? notionalAmount(group.short) : '—' }}</span>
              <span class="label">盈亏</span>
              <span class="value" :class="valueClass(rowPnl(group.short))">{{ group.short ? formatSignedUsd(rowPnl(group.short)) : '—' }}</span>
            </div>
          </section>
        </div>
      </article>
    </div>
    <div v-else class="order-list">
      <article v-for="row in (book?.records || [])" :key="(row.kind || 'row') + ':' + row.ordId" class="order-card">
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
            v-if="row.kind === 'pending'"
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
  flex-wrap: nowrap;
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
.tradfi-order-list { gap: 16px; }
.asset-card {
  background: var(--panel-2);
  border-radius: 8px;
  border: 1px solid var(--border);
  overflow: hidden;
}
.asset-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  font-weight: 600;
  font-size: 14px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: var(--text);
}
.asset-mode {
  font-size: 12px;
  color: var(--muted);
  font-weight: 400;
}
.position-row { display: grid; grid-template-columns: 1fr 1fr; }
.position-side {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.position-side:first-child { border-right: 1px solid var(--border); }
.side-header { display: flex; justify-content: space-between; align-items: center; }
.side-badge {
  font-size: 13px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 4px;
}
.side-badge.long {
  background: color-mix(in srgb, var(--green) 10%, transparent);
  color: var(--green);
}
.side-badge.short {
  background: color-mix(in srgb, var(--red) 10%, transparent);
  color: var(--red);
}
.position-details {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 8px 16px;
  font-size: 13px;
  align-items: center;
}
.position-details .label { color: var(--muted); }
.position-details .value {
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--text);
}
.position-details .value.gain { color: var(--green); }
.position-details .value.loss { color: var(--red); }
.leverage-tag {
  font-size: 11px;
  background: var(--border);
  padding: 1px 4px;
  border-radius: 3px;
  color: var(--muted);
  margin-left: 6px;
}
</style>
