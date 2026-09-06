<script setup lang="ts">
import { computed, watch } from 'vue';
import { Close } from '@element-plus/icons-vue';
import { dismissOkxAlert, clearOkxAlerts, okxAlerts, type OkxOpenAlert } from '@/utils/okxAlerts';
import { isOkxTraderMonitored } from '@/utils/monitoredOkxTraders';
import { playAlertDing } from '@/utils/alertSound';
import { formatPrice, formatTime, formatUsd } from '@/utils/format';
import { freshModeEnabled, freshWindowMs } from '@/utils/freshMode';

const props = withDefaults(
  defineProps<{
    /** 当前是否在 OKX 工作区：否时不展示卡片、不播声音（由侧栏红点承接） */
    dockActive?: boolean;
  }>(),
  { dockActive: true },
);

const emit = defineEmits<{
  focusTrader: [payload: { id: string; name: string }];
}>();

const PC_DOCK_MAX = 4;

function passFreshAlert(alert: OkxOpenAlert) {
  if (!freshModeEnabled.value) return true;
  const at = Number(alert.at) || 0;
  if (!at) return false;
  const age = Date.now() - at;
  return age >= -60_000 && age <= freshWindowMs();
}

const monitoredCards = computed(() => {
  if (!props.dockActive) return [];
  void freshModeEnabled.value;
  void freshWindowMs();
  return [
    ...okxAlerts.value.filter(
      (alert) => isOkxTraderMonitored(alert.traderId) && passFreshAlert(alert),
    ),
  ].sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
});

const pcCards = computed(() => monitoredCards.value.slice(0, PC_DOCK_MAX));
const bannerAlerts = computed(() => monitoredCards.value.slice(0, 2));

function sideClass(alert: OkxOpenAlert) {
  if (alert.side === 'short') return 'short';
  if (alert.side === 'long') return 'long';
  return 'move';
}

function dismiss(id: string) {
  dismissOkxAlert(id);
}

function dismissAll() {
  // 仅清 OKX 监控卡片，不影响 HL
  clearOkxAlerts();
}

function openTrader(alert: OkxOpenAlert) {
  emit('focusTrader', { id: alert.traderId, name: alert.traderName });
}

watch(
  () =>
    okxAlerts.value
      .filter((alert) => isOkxTraderMonitored(alert.traderId) && passFreshAlert(alert))
      .map((item) => item.id),
  (ids, prev) => {
    if (!props.dockActive) return;
    const prevSet = new Set(prev || []);
    if (ids.some((id) => !prevSet.has(id))) playAlertDing();
  },
);
</script>

<template>
  <div class="okx-alert-dock" aria-live="polite">
    <div v-if="bannerAlerts.length" class="mobile-banner-stack">
      <button
        v-for="alert in bannerAlerts"
        :key="`m-${alert.id}`"
        type="button"
        class="alert-banner"
        :class="sideClass(alert)"
        @click="openTrader(alert)"
      >
        <span class="banner-channel">OKX关注</span>
        <span class="banner-kind" :class="sideClass(alert)">{{ alert.kindLabel }}</span>
        <span class="banner-name">{{ alert.traderName }}</span>
        <span v-if="alert.coin" class="banner-coin">{{ alert.coin }}</span>
        <span class="banner-text">{{ alert.headline }}</span>
        <span
          class="banner-close"
          title="关闭"
          role="button"
          tabindex="0"
          @click.stop="dismiss(alert.id)"
          @keyup.enter.stop="dismiss(alert.id)"
        >
          <el-icon><Close /></el-icon>
        </span>
      </button>
    </div>

    <div class="dock-wrap">
      <section v-if="pcCards.length" class="dock-section">
        <p class="dock-label">OKX 关注</p>
        <button
          v-if="pcCards.length > 2"
          type="button"
          class="hide-all"
          title="关闭当前全部 OKX 关注卡片"
          @click.stop="dismissAll"
        >
          全部隐藏
        </button>
        <TransitionGroup name="toast" tag="div" class="dock">
          <article
            v-for="alert in pcCards"
            :key="alert.id"
            class="card"
            :class="sideClass(alert)"
            role="button"
            tabindex="0"
            @click="openTrader(alert)"
            @keyup.enter="openTrader(alert)"
          >
            <button class="close" type="button" title="关闭" @click.stop="dismiss(alert.id)">
              <el-icon><Close /></el-icon>
            </button>
            <div class="card-top">
              <span class="name">{{ alert.traderName }}</span>
              <span v-if="alert.coin" class="coin-tag">{{ alert.coin }}</span>
              <span class="tag">{{ alert.kindLabel }}</span>
            </div>
            <p class="headline">{{ alert.headline }}</p>
            <p class="specs">
              <template v-if="alert.coin">{{ alert.coin }} · </template>
              倍数 {{ alert.lever ? `${alert.lever}x` : '—' }} · 价格
              {{ formatPrice(alert.price) }}
              <template v-if="alert.margin"> · 保证金 {{ formatUsd(alert.margin) }}</template>
            </p>
            <p class="time">{{ formatTime(alert.at) }} · 点击定位交易员</p>
          </article>
        </TransitionGroup>
      </section>
    </div>
  </div>
</template>

<style scoped>
.okx-alert-dock {
  pointer-events: none;
}
.mobile-banner-stack {
  display: none;
}
.dock-wrap {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 3100;
  display: flex;
  flex-direction: column;
  gap: 10px;
  pointer-events: none;
  max-width: min(360px, calc(100vw - 36px));
  /* 与 HL 关注卡片错开，OKX 叠在上方区域 */
  margin-bottom: min(42vh, 320px);
}
.dock-section {
  pointer-events: auto;
}
.dock-label {
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: #f15a24;
  text-transform: uppercase;
}
.hide-all {
  pointer-events: auto;
  width: 100%;
  margin: 0 0 8px;
  padding: 7px 12px;
  border: 1px solid #2a3340;
  border-radius: 10px;
  background: color-mix(in srgb, #121821 94%, #f15a24);
  color: #e0e3eb;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.02em;
  cursor: pointer;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.28);
}
.hide-all:hover {
  filter: brightness(1.08);
}
.dock {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.card {
  position: relative;
  padding: 12px 36px 12px 14px;
  border-radius: 12px;
  border: 1px solid #1e2630;
  background: color-mix(in srgb, #121821 94%, transparent);
  backdrop-filter: blur(10px);
  color: #e0e3eb;
  cursor: pointer;
  text-align: left;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}
.card.long {
  border-left: 3px solid #58bd7d;
}
.card.short {
  border-left: 3px solid #ea5a5a;
}
.card.move {
  border-left: 3px solid #f15a24;
}
.close {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #6a7282;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.close:hover {
  color: #e0e3eb;
  background: #1a222c;
}
.card-top {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}
.name {
  font-size: 13px;
  font-weight: 700;
  color: #e0e3eb;
}
.coin-tag,
.tag {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  background: #1a222c;
  color: #a0a8b8;
}
.tag {
  color: #f15a24;
}
.headline {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
}
.specs,
.time {
  margin: 0;
  font-size: 11px;
  color: #6a7282;
  line-height: 1.4;
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
@media (max-width: 768px) {
  .dock-wrap {
    display: none !important;
  }
  .mobile-banner-stack {
    display: flex;
    flex-direction: column;
    gap: 6px;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 3210;
    padding: calc(52px + env(safe-area-inset-top)) 6px 0;
    pointer-events: none;
  }
  .alert-banner {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-height: 40px;
    padding: 6px 8px 6px 10px;
    box-sizing: border-box;
    border: 1px solid #1e2630;
    border-radius: 10px;
    background: color-mix(in srgb, #121821 94%, transparent);
    backdrop-filter: blur(10px);
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .alert-banner.long {
    border-left: 3px solid #58bd7d;
  }
  .alert-banner.short {
    border-left: 3px solid #ea5a5a;
  }
  .banner-channel {
    flex-shrink: 0;
    font-size: 10px;
    font-weight: 700;
    color: #f15a24;
  }
  .banner-kind {
    flex-shrink: 0;
    font-size: 11px;
    font-weight: 700;
  }
  .banner-kind.long {
    color: #58bd7d;
  }
  .banner-kind.short {
    color: #ea5a5a;
  }
  .banner-name,
  .banner-coin {
    flex-shrink: 0;
    font-size: 12px;
    font-weight: 600;
  }
  .banner-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    color: #a0a8b8;
  }
  .banner-close {
    flex-shrink: 0;
    display: inline-flex;
    color: #6a7282;
  }
}
</style>
