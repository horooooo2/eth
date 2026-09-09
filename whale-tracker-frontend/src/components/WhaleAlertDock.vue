<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Close } from '@element-plus/icons-vue';
import { useWhaleStore } from '@/stores/whale';
import { alertKindLabel, isTrackedAlertKind, type WhaleAlert } from '@/utils/whaleAlerts';
import { playAlertDing, unlockAlertSound } from '@/utils/alertSound';
import { directionLabel, formatLeverage, formatPnl, formatPrice, formatTime, formatUsd, shortAddress } from '@/utils/format';
import { displayAsset } from '@/utils/assets';
import { coinMatchesWatch, watchedCoins } from '@/utils/watchedCoins';
import { isWhaleMonitored } from '@/utils/monitoredWhales';
import { resolveWhaleTitle } from '@/utils/whaleReference';

function isWhaleAlertMonitored(alert: WhaleAlert) {
  return isWhaleMonitored(alert.whaleId);
}

const props = withDefaults(
  defineProps<{
    /** 当前是否在 HL 工作区：否时不展示卡片、不播声音（由侧栏红点承接） */
    dockActive?: boolean;
  }>(),
  { dockActive: true },
);

const emit = defineEmits<{
  focusWhale: [payload: { id: string; name: string; coin?: string }];
  focusWhaleTrades: [whale: { id: string; name: string }];
}>();

const whaleStore = useWhaleStore();
const active = ref<WhaleAlert | null>(null);
const dialogVisible = ref(false);

/** 与巨鲸卡片同口径 */
function alertWhaleTitle(alert: WhaleAlert) {
  return resolveWhaleTitle(whaleStore.whales, {
    id: alert.whaleId,
    name: alert.whaleName,
    address: alert.address,
  });
}

/** 只监控关注列表中的巨鲸；仅开仓/加仓；非本工作区时隐藏卡片 */
const whaleMonitorCards = computed(() => {
  if (!props.dockActive) return [];
  return [
    ...whaleStore.alerts.filter(
      (alert) => isWhaleAlertMonitored(alert) && isTrackedAlertKind(alert.kind),
    ),
  ].sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
});

const PC_DOCK_MAX = 4;

/** 桌面端右下角：按时间取最新 N 条 */
const pcWhaleCards = computed(() => whaleMonitorCards.value.slice(0, PC_DOCK_MAX));

function leadItem(alert: WhaleAlert) {
  return alert.items.find((item) => item.price || item.leverage) || alert.items[0];
}

function alertSideClass(alert: WhaleAlert) {
  const item = leadItem(alert);
  const side = item?.side || null;
  if (side === 'long') return 'long';
  if (side === 'short') return 'short';
  // 兜底：从标题推断
  const text = `${item?.title || ''} ${alert.headline || ''}`;
  if (/开多|加仓.*多|做多/.test(text)) return 'long';
  if (/开空|加仓.*空|做空/.test(text)) return 'short';
  return 'move';
}

function kindClass(alert: WhaleAlert) {
  return alertSideClass(alert);
}

function dismiss(id: string) {
  whaleStore.dismissAlert(id);
}

function dismissAll() {
  for (const alert of whaleMonitorCards.value) {
    whaleStore.dismissAlert(alert.id);
  }
}

function openAlert(alert: WhaleAlert) {
  active.value = alert;
  dialogVisible.value = true;
}

function alertCoin(alert: WhaleAlert) {
  const item = leadItem(alert);
  return item?.coin || alert.items.find((entry) => entry.coin)?.coin;
}

function jumpToWhale(alert: WhaleAlert, closeDialog = false) {
  const found =
    whaleStore.whales.find((item) => item.id === alert.whaleId) ||
    whaleStore.displayWhales.find((item) => item.id === alert.whaleId) ||
    null;
  if (!found) {
    ElMessage.info(`未在监控列表中找到 ${alertWhaleTitle(alert)}`);
    return;
  }
  whaleStore.ensureWhaleInDisplay(found.id);
  if (closeDialog) dialogVisible.value = false;
  const coin = alertCoin(alert);
  emit('focusWhale', {
    id: found.id,
    name: found.name,
    coin: coin || undefined,
  });
}

function viewTrades() {
  if (!active.value) return;
  dialogVisible.value = false;
  emit('focusWhaleTrades', {
    id: active.value.whaleId,
    name: active.value.whaleName,
  });
}

const currentPositions = computed(() => {
  if (!active.value) return [];
  const whale = whaleStore.whales.find((item) => item.id === active.value?.whaleId);
  return [...(whale?.positions || [])]
    .filter((pos) => coinMatchesWatch(pos.coin, watchedCoins.value) || coinMatchesWatch(pos.coinLabel, watchedCoins.value))
    .sort((a, b) => (b.positionValue || 0) - (a.positionValue || 0));
});

const currentWhale = computed(() =>
  whaleStore.whales.find((item) => item.id === active.value?.whaleId) || null,
);

watch(
  () =>
    whaleStore.alerts.filter((alert) => isWhaleAlertMonitored(alert)).map((item) => item.id),
  (ids, prev) => {
    if (!props.dockActive) return;
    const prevSet = new Set(prev || []);
    if (ids.some((id) => !prevSet.has(id))) playAlertDing();
  },
);

onMounted(() => {
  window.addEventListener('pointerdown', unlockAlertSound, { once: true, capture: true });
  for (const alert of [...whaleStore.alerts]) {
    if (alert.id.startsWith('demo-')) whaleStore.dismissAlert(alert.id);
  }
});
</script>

<template>
  <div class="alert-dock-root" aria-live="polite">
    <!-- 桌面端：右下角卡片（最多 4 张，取最新） -->
    <div class="dock-wrap">
    <section v-if="pcWhaleCards.length" class="dock-section whale">
      <button
        v-if="pcWhaleCards.length > 2"
        type="button"
        class="hide-all"
        title="关闭当前全部监控卡片"
        @click.stop="dismissAll"
      >
        全部隐藏
      </button>
      <TransitionGroup name="toast" tag="div" class="dock">
        <article
          v-for="alert in pcWhaleCards"
          :key="alert.id"
          class="card whale"
          :class="kindClass(alert)"
          role="button"
          tabindex="0"
          @click="openAlert(alert)"
          @keyup.enter="openAlert(alert)"
        >
          <button class="close" type="button" title="关闭" @click.stop="dismiss(alert.id)">
            <el-icon><Close /></el-icon>
          </button>
          <div class="card-top">
            <button
              type="button"
              class="whale-link"
              :title="`定位 ${alertWhaleTitle(alert)}`"
              @click.stop="jumpToWhale(alert)"
            >
              {{ alertWhaleTitle(alert) }}
            </button>
            <span v-if="alertCoin(alert)" class="coin-tag">{{ displayAsset(alertCoin(alert)!) }}</span>
            <span class="tag">{{ alert.kindLabel }}</span>
          </div>
          <p class="addr mono">{{ shortAddress(alert.address) }}</p>
          <p class="headline">{{ alert.headline }}</p>
          <p class="specs">
            <template v-if="alertCoin(alert)">{{ displayAsset(alertCoin(alert)!) }} · </template>
            倍数 {{ formatLeverage(leadItem(alert)?.leverage) }} · 价格 {{ formatPrice(leadItem(alert)?.price) }}
          </p>
          <p class="time">{{ formatTime(alert.at) }} · 点击查看详情</p>
        </article>
      </TransitionGroup>
    </section>

    </div>

    <el-dialog
      v-model="dialogVisible"
      width="520px"
      append-to-body
      class="alert-dialog"
      destroy-on-close
    >
      <template #header>
        <template v-if="active">
          <button
            type="button"
            class="dlg-whale-link"
            :title="`定位 ${alertWhaleTitle(active)}`"
            @click="jumpToWhale(active, true)"
          >
            {{ alertWhaleTitle(active) }}
          </button>
          <template v-if="alertCoin(active)"> · {{ displayAsset(alertCoin(active)!) }}</template>
          · 异动提醒
        </template>
        <span v-else>异动提醒</span>
      </template>

      <template v-if="active">
        <p class="addr mono">{{ shortAddress(active.address) }}</p>
        <div class="items">
          <div v-for="(item, index) in active.items" :key="`${item.title}-${index}`" class="item">
            <div class="item-head">
              <strong>{{ item.title }}</strong>
              <span class="tag">{{ alertKindLabel(item.kind) }}</span>
            </div>
            <p>{{ item.detail }}</p>
            <div class="item-specs">
              <span>倍数 <strong>{{ formatLeverage(item.leverage) }}</strong></span>
              <span>价格 <strong>{{ formatPrice(item.price) }}</strong></span>
              <span v-if="item.pnl != null">盈亏 <strong :class="item.pnl >= 0 ? 'pnl-up' : 'pnl-down'">{{ formatPnl(item.pnl) }}</strong></span>
              <span v-if="item.usd">名义 <strong>{{ formatUsd(item.usd) }}</strong></span>
            </div>
          </div>
        </div>
        <div v-if="currentWhale" class="now">
          <h4>当前方向 {{ directionLabel(currentWhale.direction) }}</h4>
          <p v-if="!currentPositions.length" class="muted">暂无 {{ watchedCoins.join(' / ') }} 持仓</p>
          <ul v-else>
            <li v-for="pos in currentPositions" :key="`${pos.coin}-${pos.side}`">
              {{ displayAsset(pos.coin, pos.coinLabel) }}
              <span :class="pos.side === 'long' ? 'pnl-up' : 'pnl-down'">{{ pos.side === 'long' ? '多' : '空' }}</span>
              · {{ formatUsd(pos.positionValue) }}
              · {{ formatLeverage(pos.leverage) }}
              · {{ formatPrice(pos.entryPx) }}
            </li>
          </ul>
        </div>
      </template>

      <template #footer>
        <div class="actions">
          <el-button @click="active && jumpToWhale(active, true)">查看巨鲸仓位</el-button>
          <el-button type="primary" @click="viewTrades">查看该地址成交</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.alert-dock-root {
  display: contents;
}
.dock-wrap {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 3000;
  display: flex;
  flex-direction: row-reverse;
  align-items: flex-end;
  gap: 14px;
  max-width: calc(100vw - 32px);
  pointer-events: none;
}
.dock-section {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  width: min(360px, calc(100vw - 32px));
}
.hide-all {
  pointer-events: auto;
  width: 100%;
  margin: 0;
  padding: 7px 12px;
  border: 1px solid color-mix(in srgb, #e6a23c 40%, var(--border));
  border-radius: 10px;
  background: color-mix(in srgb, var(--card) 92%, #e6a23c);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.02em;
  cursor: pointer;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.22);
}
.hide-all:hover {
  filter: brightness(1.06);
}
.dock {
  display: flex;
  flex-direction: column-reverse;
  gap: 10px;
  pointer-events: none;
}
.card {
  pointer-events: auto;
  position: relative;
  padding: 14px 36px 12px 16px;
  border-radius: 12px;
  background: var(--card);
  border: 1px solid var(--border);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
  cursor: pointer;
  overflow: hidden;
}
.card.whale {
  border-color: color-mix(in srgb, #e6a23c 45%, var(--border));
}
.card::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  background: var(--accent);
}
.card.whale:not(.long):not(.short)::before {
  background: #e6a23c;
}
.card.long::before {
  background: var(--bull);
}
.card.short::before {
  background: var(--bear);
}
.card.long {
  background: color-mix(in srgb, var(--bull) 12%, var(--card));
  border-color: color-mix(in srgb, var(--bull) 40%, var(--border));
}
.card.short {
  background: color-mix(in srgb, var(--bear) 12%, var(--card));
  border-color: color-mix(in srgb, var(--bear) 40%, var(--border));
}
.whale-link,
.dlg-whale-link {
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--accent);
  font: inherit;
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
  text-align: left;
}
.whale-link:hover,
.dlg-whale-link:hover {
  text-decoration: underline;
}
.dlg-whale-link {
  font-size: 18px;
}
.card-top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.card-top .whale-link {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag {
  flex: 0 0 auto;
  color: var(--muted);
  font-size: 12px;
}
.coin-tag {
  flex: 0 0 auto;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 800;
  color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
.addr {
  margin: 4px 0 0;
}
.headline {
  margin: 8px 0 4px;
  font-size: 15px;
  line-height: 1.4;
}
.specs {
  margin: 0 0 4px;
  color: var(--text);
  font-size: 13px;
}
.item-specs {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 18px;
  margin-top: 8px;
  font-size: 14px;
  color: var(--muted);
}
.item-specs strong {
  color: var(--text);
  font-weight: 650;
  margin-left: 4px;
}
.time,
.muted,
.addr {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
}
.close {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.close:hover {
  color: var(--text);
}
.addr {
  margin-bottom: 12px;
}
.items {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.item {
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--bg);
  border: 1px solid var(--border);
}
.item-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}
.item p {
  margin: 0;
  font-size: 14px;
}
.now {
  margin-top: 16px;
}
.now h4 {
  margin: 0 0 8px;
  font-size: 14px;
}
.now ul {
  margin: 0;
  padding-left: 18px;
}
.now li {
  margin: 4px 0;
}
.pnl-up {
  color: var(--bull);
}
.pnl-down {
  color: var(--bear);
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
.toast-enter-active,
.toast-leave-active {
  transition: all 0.22s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(24px);
}
</style>
