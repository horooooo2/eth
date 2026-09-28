<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { cancelOkxOrder, fetchOkxAiBook, fetchTradfiAccountBook, previewTradfiManualAdd, submitTradfiManualAdd, syncTradfiRangePositions, type OkxAiBook, type OkxAiOrderRecord, type TradfiManualAddPreview } from '@/api';
import { formatSignedUsd, formatTimeShort } from '@/utils/format';
import { ElMessage, ElMessageBox } from 'element-plus';

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
const manualDialog = ref(false);
const manualSymbol = ref('');
const manualSide = ref<'long' | 'short'>('long');
const manualMargin = ref(20);
const manualPreview = ref<TradfiManualAddPreview | null>(null);
const manualBusy = ref(false);
const manualError = ref('');
const syncingSymbol = ref('');
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
    const existing = bySymbol.get(strategy.symbol);
    if (!strategy.enabled && !existing && !strategy.positionSync?.required) continue;
    const group = existing || {
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
  const digits = props.exchange === 'tradfi'
    ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
    : { maximumFractionDigits: 8 };
  return `${Number(n).toLocaleString('zh-CN', digits)} USDT`;
}

function notionalAmount(row: OkxAiOrderRecord) {
  if (props.exchange === 'tradfi') {
    const recordedMargin = Number(row.marginUsd);
    const leverage = Number(row.leverage);
    const calculatedMargin = Number(row.sz) * Number(row.px) / leverage;
    const margin = row.marginUsd != null && Number.isFinite(recordedMargin) && recordedMargin >= 0
      ? recordedMargin
      : Number.isFinite(calculatedMargin) && leverage > 0 ? calculatedMargin : NaN;
    return Number.isFinite(margin) ? plainAmount(margin) : '--';
  }
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
  return Number(row.px).toLocaleString('zh-CN', props.exchange === 'tradfi'
    ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
    : { maximumFractionDigits: 8 });
}

function twoDecimals(value: number | null | undefined) {
  if (value == null || !Number.isFinite(Number(value))) return '--';
  return Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function groupMode(group: TradfiGroup) {
  const strategy = group.strategy;
  if (strategy?.positionSync?.required) return strategy.positionSync.available ? '币安仓位待同步' : '等待委托完成后同步';
  const managedQty = Number(group.long?.aiQty || 0) + Number(group.short?.aiQty || 0);
  if (strategy && !strategy.enabled && managedQty > 0) return '策略已停止';
  if (strategy?.status === 'waiting') {
    const remaining = Number(strategy.cooldownUntil || 0) - clock.value;
    if (remaining > 0) return `冷却检查 · ${countdown(remaining)} 后检查开仓`;
    return '检查震荡条件';
  }
  if (strategy?.status === 'entry_pending') return '等待双向底仓成交';
  if (strategy?.long?.phase === 'close_pending' || strategy?.short?.phase === 'close_pending') return '单边止盈挂单中';
  if (strategy?.long?.phase === 'reentry_wait' || strategy?.short?.phase === 'reentry_wait') {
    const waitingLeg = strategy.long?.phase === 'reentry_wait' ? strategy.long : strategy.short;
    return reentryWaitLabel(waitingLeg).replace('止盈后冷却，等待重建', '单边止盈后冷却，等待重建底仓');
  }
  if (strategy?.long?.phase === 'reentry_pending' || strategy?.short?.phase === 'reentry_pending') return '正在重建单边底仓';
  if (strategy?.status === 'add_pending') {
    const orderLabel = strategy.manualAddPending ? '手动补仓挂单中'
      : strategy.pendingSparse ? `稀疏组单 ${strategy.pendingTierStart}-${strategy.pendingTierEnd} 档挂单中` : '补仓挂单中';
    return `${orderLabel} · 多${strategy.longAdditions ?? '—'}/${strategy.maxLongAdditions ?? 100} · 空${strategy.shortAdditions ?? '—'}/${strategy.maxShortAdditions ?? 50}`;
  }
  if (strategy?.status === 'active') {
    if (strategy.longAdditions == null && strategy.shortAdditions == null) return `策略运行中 · 已补 ${strategy.additions || 0} 档`;
    return `策略运行中 · 多${strategy.longAdditions || 0}/${strategy.maxLongAdditions ?? 100} · 空${strategy.shortAdditions || 0}/${strategy.maxShortAdditions ?? 50}`;
  }
  if (group.long?.kind === 'pending' || group.short?.kind === 'pending') return '含挂单';
  if (group.long && group.short) return '双向持仓';
  return '单向持仓';
}

function groupPnl(group: TradfiGroup) {
  return [rowPnl(group.long), rowPnl(group.short)].reduce<number>((sum, value) => sum + (Number(value) || 0), 0);
}

function groupFees(group: TradfiGroup) {
  return book.value?.feesBySymbol?.[group.instId] || { tradingFees: 0, fundingFees: 0, netCost: 0 };
}

function sideRealized(group: TradfiGroup, side: 'long' | 'short') {
  return (book.value?.trades || []).filter((trade) => trade.instId === group.instId && trade.action === 'close' && String(trade.posSide).toLowerCase() === side)
    .reduce((sum, trade) => sum + Number(trade.realizedPnl || 0), 0);
}

function legStatus(group: TradfiGroup, side: 'long' | 'short') { return group.strategy?.[side]; }
function sideStatusText(group: TradfiGroup, side: 'long' | 'short') {
  return legModeLabel(group, side);
}
function legModeLabel(group: TradfiGroup, side: 'long' | 'short') {
  const strategy = group.strategy; const leg = legStatus(group, side);
  const additions = Number(leg?.additions || 0); const max = side === 'long'
    ? Number(strategy?.maxLongAdditions || 100) : Number(strategy?.maxShortAdditions || 50);
  if (leg?.sparseMode) {
    if (strategy?.pendingSparse && strategy.pendingDirection === side) return `稀疏补仓 · ${strategy.pendingTierStart}-${strategy.pendingTierEnd}档挂单 · ${additions}/${max}`;
    if (additions >= max) return `稀疏补仓 · 已达上限 ${additions}/${max}`;
    const first = additions + 1; const last = Math.min(max, additions + 5);
    return `稀疏补仓 · 下一组${first}-${last}档 · ${additions}/${max}`;
  }
  return `${leg?.recovery ? '恢复中' : '常规'} · ${additions}/${max}`;
}
function manualAddAvailable(group: TradfiGroup, side: 'long' | 'short') {
  const strategy = group.strategy; const leg = legStatus(group, side); const position = group[side];
  return props.exchange === 'tradfi' && Boolean(strategy?.enabled) && strategy?.status === 'active'
    && !strategy.manualAddPending && leg?.phase === 'active'
    && position?.kind === 'position' && Number(rowPnl(position)) < 0;
}
function canShowManualAdd(group: TradfiGroup, side: 'long' | 'short') {
  const position = group[side];
  return props.exchange === 'tradfi' && Boolean(group.strategy)
    && position?.kind === 'position' && Number(rowPnl(position)) < 0;
}
function syncDescription(group: TradfiGroup) {
  const sync = group.strategy?.positionSync;
  if (!sync?.sides) return '';
  return (['long', 'short'] as const).filter((side) => Math.abs(sync.sides![side].delta) > 1e-9).map((side) => {
    const row = sync.sides![side]; const label = side === 'long' ? '多仓' : '空仓';
    const change = row.delta >= 0 ? `+${twoDecimals(row.delta)}` : twoDecimals(row.delta);
    return `${label}：策略 ${twoDecimals(row.expectedQty)} 张 → 币安 ${twoDecimals(row.actualQty)} 张（${change} 张），币安均价 ${twoDecimals(row.entryPrice)}，本金估算 ${twoDecimals(row.marginUsdt)}U`;
  }).join('\n');
}
async function syncGroupPositions(group: TradfiGroup) {
  if (!group.strategy?.positionSync?.required || !group.strategy.positionSync.available || syncingSymbol.value) return;
  try {
    await ElMessageBox.confirm(
      `${syncDescription(group)}\n\n确认后，策略将按币安当前实际多空仓位继续管理。自动补仓档位和历史最大浮亏会保留；同步增加的仓位计入总仓位与盈亏，但不占自动补仓档位。策略之后止盈时，可能平掉该方向同步后的全部仓位。`,
      '同步币安仓位', { type: 'warning', confirmButtonText: '确认同步并接管', cancelButtonText: '取消' });
  } catch { return; }
  syncingSymbol.value = group.instId;
  try {
    await syncTradfiRangePositions(group.instId);
    ElMessage.success('币安实际仓位已同步，策略将按当前完整仓位管理');
    await load(true);
  } catch (err) { ElMessage.error(err instanceof Error ? err.message : '同步币安仓位失败'); }
  finally { syncingSymbol.value = ''; }
}
function openManualAdd(group: TradfiGroup, side: 'long' | 'short') {
  manualSymbol.value = group.instId; manualSide.value = side;
  manualMargin.value = group.instId === 'XAGUSDT' ? 10 : 20;
  manualPreview.value = null; manualError.value = ''; manualDialog.value = true;
}
function manualDirectionLabel() { return manualSide.value === 'long' ? '多头' : '空头'; }
async function calculateManualPreview() {
  if (manualBusy.value || !(manualMargin.value > 0)) return;
  manualBusy.value = true; manualError.value = ''; manualPreview.value = null;
  try { manualPreview.value = await previewTradfiManualAdd(manualSymbol.value, manualSide.value, Number(manualMargin.value)); }
  catch (err) { manualError.value = err instanceof Error ? err.message : '补仓预估失败'; }
  finally { manualBusy.value = false; }
}
async function confirmManualAdd() {
  const preview = manualPreview.value;
  if (!preview || manualBusy.value) return;
  manualBusy.value = true; manualError.value = '';
  try {
    const result = await submitTradfiManualAdd(manualSymbol.value, manualSide.value, preview.marginUsdt, { price: preview.price, quantity: preview.quantity });
    ElMessage.success(`Maker 补仓单已提交，成交后按币安实际均价接管（${twoDecimals(Number(result.order.quantity))} 张）`);
    manualDialog.value = false; manualPreview.value = null;
    await load(true);
  } catch (err) { manualError.value = err instanceof Error ? err.message : '手动补仓提交失败'; }
  finally { manualBusy.value = false; }
}
function sideMask(group: TradfiGroup, side: 'long' | 'short') {
  const strategy = group.strategy;
  const leg = legStatus(group, side);
  if (!strategy) return '';
  if (strategy.positionSync?.required && Math.abs(Number(strategy.positionSync.sides?.[side]?.delta || 0)) > 1e-9) {
    return strategy.positionSync.available ? '检测到币安手动变更 · 请确认同步' : (strategy.positionSync.blockedReason || '委托处理中，暂不可同步');
  }
  if (!strategy.enabled && (Number(group.long?.aiQty || 0) + Number(group.short?.aiQty || 0) > 0)) return '策略已停止';
  if (!strategy.enabled && Number(group.long?.aiQty || 0) + Number(group.short?.aiQty || 0) > 0) return '策略已停止';
  if (leg?.phase === 'close_pending') return '止盈挂单中';
  if (leg?.phase === 'reentry_wait') return reentryWaitLabel(leg);
  if (leg?.phase === 'reentry_pending') return '正在重建底仓';
  if (strategy.status === 'waiting') return '等待震荡条件';
  if (strategy.status === 'entry_pending' || group[side]?.kind === 'pending') return '等待成交';
  if (!group[side]) return '等待成交';
  return '';
}

function preciseUsd(value: number | null | undefined) {
  if (value == null || !Number.isFinite(Number(value))) return '--';
  return `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function countdown(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function reentryWaitLabel(leg?: TradfiStrategy['long']) {
  const reentryAt = Number(leg?.reentryAt || 0);
  if (reentryAt <= 0) return '止盈后冷却，等待重建 · 等待开市';
  const remaining = reentryAt - clock.value;
  if (remaining > 0) return `止盈后冷却，等待重建 · 重建倒计时 ${countdown(remaining)}`;
  return '止盈后冷却，等待重建 · 正在重建';
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
        <div class="data-value">{{ preciseUsd(book?.balance.usdtEq ?? book?.balance.totalEq) }}</div>
        <div class="data-sub">可用 {{ preciseUsd(book?.balance.availBal) }}</div>
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
      <div v-if="props.exchange === 'tradfi'" class="data-card">
        <div class="data-label">手续费</div>
        <div class="data-value" :class="valueClass(-(book?.costs?.tradingFees || 0))">{{ formatSignedUsd(-(book?.costs?.tradingFees || 0)) }}</div>
        <div class="data-sub">只统计 AI 策略实际产生损耗的交易手续费</div>
      </div>
    </div>

    <p v-if="props.exchange === 'tradfi'" class="account-note">余额与币安 U 本位合约账户共用；下方展示策略管理中的 TradFi 持仓与挂单。手动仓位需确认同步后纳入管理。</p>
    <el-alert v-if="error" type="warning" :closable="false" :title="error" class="alert" />
    <el-alert v-else-if="book?.configured === false" type="info" :closable="false" title="请先在左下角「API 设置」配置币安 API 密钥" class="alert" />
    <el-skeleton v-else-if="loading && !book" :rows="6" animated class="pad" />
    <el-empty v-else-if="props.exchange === 'tradfi' ? !tradfiGroups.length : !book?.records.length" :description="props.exchange === 'tradfi' ? '暂无运行中的策略或策略开单记录' : '暂无 AI 开单记录'" class="pad" />
    <div v-else-if="props.exchange === 'tradfi'" class="order-list tradfi-order-list">
      <article v-for="group in tradfiGroups" :key="group.instId" class="asset-card">
        <div class="asset-header">
          <button v-if="group.strategy?.positionSync?.required" type="button" class="sync-position-btn" :disabled="syncingSymbol === group.instId || !group.strategy.positionSync.available" :title="group.strategy.positionSync.blockedReason || syncDescription(group)" @click="syncGroupPositions(group)">{{ syncingSymbol === group.instId ? '同步中…' : '同步' }}</button>
          <span>{{ group.coin }} <b class="asset-pnl" :class="valueClass(groupPnl(group))">{{ formatSignedUsd(groupPnl(group)) }}</b></span>
          <span v-if="group.strategy" class="asset-config">单笔：{{ twoDecimals(group.strategy.marginPerOrder) }}U · 倍数：{{ group.strategy.leverage }}X</span>
          <span class="asset-fees">手续费损耗 {{ preciseUsd(groupFees(group).tradingFees) }}</span>
          <span class="asset-mode">{{ groupMode(group) }}</span>
        </div>
        <div class="position-row">
          <section class="position-side">
            <div v-if="sideMask(group, 'long')" class="position-mask">{{ sideMask(group, 'long') }}</div>
            <div class="side-header"><span class="side-badge long">多头</span><button v-if="canShowManualAdd(group, 'long')" type="button" class="manual-add-btn" :disabled="!manualAddAvailable(group, 'long')" :title="manualAddAvailable(group, 'long') ? '使用当前策略杠杆补仓' : '策略运行中且无该方向处理中订单时可补仓'" @click="openManualAdd(group, 'long')">补仓</button></div>
            <div class="position-details">
              <span class="label">持仓价</span>
              <span class="value">{{ group.long ? entryPrice(group.long) : '—' }}</span>
              <span class="label">{{ group.long?.kind === 'pending' ? '委托本金' : '仓位价值' }}</span>
              <span class="value">{{ group.long ? notionalAmount(group.long) : '—' }}</span>
              <span class="label">盈亏</span>
              <span class="value" :class="valueClass(rowPnl(group.long))">{{ group.long ? formatSignedUsd(rowPnl(group.long)) : '—' }}</span>
              <span class="label">已实现</span>
              <span class="value" :class="valueClass(sideRealized(group, 'long'))">{{ formatSignedUsd(sideRealized(group, 'long')) }}</span>
              <span class="label">状态</span>
              <span class="value">{{ sideStatusText(group, 'long') }}<span v-if="Number(legStatus(group, 'long')?.manualMarginUsdt || 0) > 0" class="manual-amount"> 手动 · {{ twoDecimals(legStatus(group, 'long')?.manualMarginUsdt) }}U</span><span v-if="Number(legStatus(group, 'long')?.syncedManualMarginUsdt || 0) > 0" class="manual-amount"> 同步 · {{ twoDecimals(legStatus(group, 'long')?.syncedManualMarginUsdt) }}U</span></span>
            </div>
          </section>
          <section class="position-side">
            <div v-if="sideMask(group, 'short')" class="position-mask">{{ sideMask(group, 'short') }}</div>
            <div class="side-header"><span class="side-badge short">空头</span><button v-if="canShowManualAdd(group, 'short')" type="button" class="manual-add-btn" :disabled="!manualAddAvailable(group, 'short')" :title="manualAddAvailable(group, 'short') ? '使用当前策略杠杆补仓' : '策略运行中且无该方向处理中订单时可补仓'" @click="openManualAdd(group, 'short')">补仓</button></div>
            <div class="position-details">
              <span class="label">持仓价</span>
              <span class="value">{{ group.short ? entryPrice(group.short) : '—' }}</span>
              <span class="label">{{ group.short?.kind === 'pending' ? '委托本金' : '仓位价值' }}</span>
              <span class="value">{{ group.short ? notionalAmount(group.short) : '—' }}</span>
              <span class="label">盈亏</span>
              <span class="value" :class="valueClass(rowPnl(group.short))">{{ group.short ? formatSignedUsd(rowPnl(group.short)) : '—' }}</span>
              <span class="label">已实现</span>
              <span class="value" :class="valueClass(sideRealized(group, 'short'))">{{ formatSignedUsd(sideRealized(group, 'short')) }}</span>
              <span class="label">状态</span>
              <span class="value">{{ sideStatusText(group, 'short') }}<span v-if="Number(legStatus(group, 'short')?.manualMarginUsdt || 0) > 0" class="manual-amount"> 手动 · {{ twoDecimals(legStatus(group, 'short')?.manualMarginUsdt) }}U</span><span v-if="Number(legStatus(group, 'short')?.syncedManualMarginUsdt || 0) > 0" class="manual-amount"> 同步 · {{ twoDecimals(legStatus(group, 'short')?.syncedManualMarginUsdt) }}U</span></span>
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
    <Teleport to="body">
      <div v-if="manualDialog" class="manual-modal-cover" @click.self="!manualBusy && (manualDialog = false)">
        <section class="manual-dialog" role="dialog" aria-modal="true" aria-label="手动补仓">
          <header class="manual-dialog-head"><strong>{{ manualSymbol === 'XAUUSDT' ? '黄金' : '白银' }}{{ manualDirectionLabel() }}手动补仓</strong><button type="button" :disabled="manualBusy" @click="manualDialog = false">×</button></header>
          <div class="manual-dialog-body">
            <label class="manual-input-label">补仓保证金 <span><input v-model.number="manualMargin" type="number" min="0.01" step="0.01" :disabled="manualBusy" @input="manualPreview = null" /> USDT</span></label>
            <p class="manual-help">使用当前策略杠杆和 Post Only 挂单逻辑。手动补仓不占自动补仓档位；仅成交部分计入仓位和累计金额。</p>
            <button type="button" class="manual-preview-btn" :disabled="manualBusy || !(manualMargin > 0)" @click="calculateManualPreview">{{ manualBusy && !manualPreview ? '计算中…' : '计算补仓后均价' }}</button>
            <div v-if="manualPreview" class="manual-preview">
              <div><span>当前均价</span><b>{{ twoDecimals(manualPreview.currentEntryPrice) }}</b></div>
              <div><span>挂单估价</span><b>{{ twoDecimals(manualPreview.price) }}</b></div>
              <div><span>预计数量</span><b>{{ twoDecimals(manualPreview.quantity) }}</b></div>
              <div><span>当前浮亏</span><b class="loss">{{ formatSignedUsd(manualPreview.currentPnl) }}</b></div>
              <div class="projected"><span>补仓后预计均价</span><b>{{ twoDecimals(manualPreview.projectedEntryPrice) }}</b></div>
              <small>估算值；成交后以币安实际成交均价和数量更新。</small>
            </div>
            <p v-if="manualError" class="manual-error">{{ manualError }}</p>
          </div>
          <footer class="manual-dialog-footer"><button type="button" :disabled="manualBusy" @click="manualDialog = false">取消</button><button type="button" class="confirm" :disabled="manualBusy || !manualPreview" @click="confirmManualAdd">{{ manualBusy ? '处理中…' : '再次确认并挂单' }}</button></footer>
        </section>
      </div>
    </Teleport>
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
  flex-wrap: wrap;
  gap: 8px;
}
.sync-position-btn {
  padding: 4px 9px;
  border: 1px solid color-mix(in srgb, var(--yellow) 55%, var(--border));
  border-radius: 5px;
  background: color-mix(in srgb, var(--yellow) 12%, transparent);
  color: var(--yellow);
  font-size: 11px;
  cursor: pointer;
}
.sync-position-btn:disabled { opacity: .55; cursor: not-allowed; }
.asset-pnl { margin-left: 6px; font-variant-numeric: tabular-nums; }
.asset-pnl.gain { color: var(--green); }
.asset-pnl.loss { color: var(--red); }
.asset-config { margin-left: 8px; color: var(--muted); font-size: 11px; font-weight: 400; }
.asset-fees { margin-left: auto; font-size: 11px; color: var(--muted); font-weight: 400; font-variant-numeric: tabular-nums; }
.asset-mode {
  font-size: 12px;
  color: var(--muted);
  font-weight: 400;
  margin-left: 12px;
}
.takeover-btn {
  padding: 5px 9px;
  border: 1px solid color-mix(in srgb, var(--yellow) 50%, var(--border));
  border-radius: 5px;
  background: color-mix(in srgb, var(--yellow) 10%, transparent);
  color: var(--yellow);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.takeover-btn:hover { background: color-mix(in srgb, var(--yellow) 18%, transparent); }
.position-row { display: grid; grid-template-columns: 1fr 1fr; }
.position-side {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  position: relative;
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
.position-details .ownership-value { color: var(--yellow); font-size: 11px; }
.position-mask {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
  text-align: center;
  background: color-mix(in srgb, var(--panel-2) 83%, transparent);
  backdrop-filter: blur(2px);
}
.manual-add-btn {
  padding: 4px 10px;
  border: 1px solid color-mix(in srgb, var(--yellow) 45%, var(--border));
  border-radius: 5px;
  background: color-mix(in srgb, var(--yellow) 10%, transparent);
  color: var(--yellow);
  font-size: 11px;
  cursor: pointer;
}
.manual-add-btn:hover { background: color-mix(in srgb, var(--yellow) 18%, transparent); }
.manual-add-btn:disabled { opacity: .45; cursor: not-allowed; }
.manual-amount { color: var(--yellow); font-size: 11px; white-space: nowrap; }
.manual-modal-cover {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgb(0 0 0 / 64%);
}
.manual-dialog {
  width: min(460px, 100%);
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
  color: var(--text);
  box-shadow: 0 20px 70px rgb(0 0 0 / 40%);
}
.manual-dialog-head, .manual-dialog-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
}
.manual-dialog-head { border-bottom: 1px solid var(--border); }
.manual-dialog-head button {
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 22px;
  cursor: pointer;
}
.manual-dialog-body { padding: 18px; }
.manual-input-label { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; }
.manual-input-label span { display: flex; align-items: center; gap: 8px; color: var(--muted); }
.manual-input-label input { width: 130px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel-2); color: var(--text); }
.manual-help, .manual-preview small { color: var(--muted); font-size: 11px; line-height: 1.55; }
.manual-preview-btn { width: 100%; margin: 8px 0; padding: 9px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel-2); color: var(--text); cursor: pointer; }
.manual-preview-btn:disabled, .manual-dialog-footer button:disabled { opacity: .55; cursor: default; }
.manual-preview { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 16px; margin-top: 12px; padding: 12px; border: 1px solid var(--border); border-radius: 8px; font-size: 12px; }
.manual-preview > div { display: flex; flex-direction: column; gap: 4px; color: var(--muted); }
.manual-preview b { color: var(--text); font-variant-numeric: tabular-nums; }
.manual-preview b.loss { color: var(--red); }
.manual-preview .projected { grid-column: 1 / -1; padding-top: 8px; border-top: 1px solid var(--border); }
.manual-preview .projected b { color: var(--yellow); font-size: 17px; }
.manual-error { color: var(--red); font-size: 12px; }
.manual-dialog-footer { justify-content: flex-end; border-top: 1px solid var(--border); }
.manual-dialog-footer button { padding: 8px 13px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: var(--text); cursor: pointer; }
.manual-dialog-footer .confirm { border-color: var(--yellow); background: var(--yellow); color: #171717; font-weight: 600; }
</style>
