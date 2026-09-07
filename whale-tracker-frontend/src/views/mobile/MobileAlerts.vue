<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { fetchPagedAlertHistory } from '@/api';
import { useWhaleStore } from '@/stores/whale';
import {
  normalizeStoredAlert,
  scopeAlertToSide,
  type AlertLayer,
  type WhaleAlert,
} from '@/utils/whaleAlerts';
import { enrichAlertView } from '@/utils/alertView';
import { formatTimeShort, formatUsd } from '@/utils/format';
import { resolveWhaleTitle } from '@/utils/whaleReference';

const PAGE_SIZE = 20;
const whaleStore = useWhaleStore();
const router = useRouter();

const page = ref(1);
const total = ref(0);
const loading = ref(false);
const alerts = ref<WhaleAlert[]>([]);
const sideFilter = ref<'all' | 'long' | 'short'>('all');

/** 驱动「N分钟前」相对时间定时重算 */
const nowTick = ref(Date.now());
let nowTickTimer: ReturnType<typeof setInterval> | undefined;

const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));

/** 与 PC NewsList.sideBadgeClass 一致 */
function sideBadgeClass(view: {
  layer: AlertLayer;
  side: 'long' | 'short' | null;
  actionLabel: string;
}) {
  if (view.layer === 'fill') {
    return view.actionLabel === '卖出' ? 'short' : 'long';
  }
  if (view.layer === 'transfer') {
    return view.actionLabel.includes('转出') ? 'short' : 'long';
  }
  return view.side || '';
}

function actionTypeClass(type: string) {
  if (type === 'open') return 'action-open';
  if (type === 'close') return 'action-close';
  return 'action-other';
}

const rows = computed(() =>
  alerts.value.map((alert) => {
    const scoped =
      sideFilter.value === 'all' ? alert : scopeAlertToSide(alert, sideFilter.value);
    const whale =
      whaleStore.enabledWhales.find((w) => w.id === scoped.whaleId) ||
      whaleStore.displayWhales.find((w) => w.id === scoped.whaleId);
    const view = enrichAlertView(scoped, whale || null, nowTick.value);
    return {
      alert: scoped,
      view,
      title: resolveWhaleTitle(whaleStore.enabledWhales, {
        id: scoped.whaleId,
        name: scoped.whaleName,
      }),
    };
  }),
);

async function loadAlerts() {
  loading.value = true;
  try {
    const data = await fetchPagedAlertHistory({
      page: page.value,
      limit: PAGE_SIZE,
      side: sideFilter.value,
    });
    alerts.value = (data.alerts || [])
      .map((item) => normalizeStoredAlert(item as WhaleAlert))
      .filter((item): item is WhaleAlert => Boolean(item));
    total.value = Number(data.total) || alerts.value.length;
  } catch {
    alerts.value = [];
    total.value = 0;
  } finally {
    loading.value = false;
  }
}

function openWhale(id: string) {
  void router.push({ name: 'm-home', query: { id } });
}

watch([page, sideFilter], () => {
  void loadAlerts();
});

onMounted(() => {
  void loadAlerts();
  nowTickTimer = setInterval(() => {
    nowTick.value = Date.now();
  }, 30_000);
});

onUnmounted(() => {
  if (nowTickTimer) clearInterval(nowTickTimer);
});
</script>

<template>
  <div class="m-alerts">
    <div class="m-card-title">异动记录 · 开/加仓</div>
    <div class="side-tabs">
      <button type="button" :class="{ on: sideFilter === 'all' }" @click="sideFilter = 'all'; page = 1">
        全部
      </button>
      <button type="button" :class="{ on: sideFilter === 'long' }" @click="sideFilter = 'long'; page = 1">
        做多
      </button>
      <button type="button" :class="{ on: sideFilter === 'short' }" @click="sideFilter = 'short'; page = 1">
        做空
      </button>
    </div>

    <div class="list-area" v-loading="loading">
      <div v-if="!loading && !rows.length" class="m-empty">暂无异动</div>
      <div v-else-if="rows.length" class="alert-list">
        <button
          v-for="row in rows"
          :key="row.alert.id"
          type="button"
          class="alert-item"
          @click="openWhale(row.alert.whaleId)"
        >
          <div class="a-top">
            <div class="a-badges">
              <span
                v-if="row.view.sideBadgeLabel"
                class="side-badge"
                :class="sideBadgeClass(row.view)"
              >
                {{ row.view.sideBadgeLabel }}
              </span>
              <span class="action-badge" :class="actionTypeClass(row.view.actionType)">
                {{ row.view.actionLabel }}
              </span>
              <span v-if="row.view.coin && row.view.coin !== '--'" class="a-coin">
                {{ row.view.coin }}
              </span>
            </div>
            <span class="a-usd">{{ row.view.usd != null ? formatUsd(row.view.usd) : '--' }}</span>
          </div>
          <div class="a-bot">
            <span class="a-name">{{ row.title }}</span>
            <span class="a-time">{{ formatTimeShort(row.view.eventTime) }}</span>
          </div>
        </button>
      </div>
      <div v-else class="m-empty">加载中…</div>
    </div>

    <div v-if="total > PAGE_SIZE" class="m-pager">
      <button type="button" class="pg" :disabled="page <= 1" @click="page = 1">首页</button>
      <button type="button" class="pg" :disabled="page <= 1" @click="page -= 1">上一页</button>
      <span class="pg-info">{{ page }}/{{ pageCount }} · {{ total }}</span>
      <button type="button" class="pg" :disabled="page >= pageCount" @click="page += 1">下一页</button>
    </div>
  </div>
</template>

<style scoped>
.m-card-title {
  font-size: 13px;
  font-weight: 700;
  color: #8b9bb5;
  margin-bottom: 10px;
}
.side-tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
}
.side-tabs button {
  border: 0;
  border-radius: 999px;
  padding: 5px 12px;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  background: #1a222e;
  color: #8b9bb5;
}
.side-tabs button.on {
  background: #2a3a52;
  color: #f0f4fa;
}
.list-area {
  position: relative;
  min-height: 120px;
}
.alert-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.alert-item {
  text-align: left;
  border: 1px solid #1a222e;
  background: #10171f;
  border-radius: 14px;
  padding: 12px;
  color: inherit;
  font: inherit;
}
.a-top,
.a-bot {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
}
.a-bot {
  margin-top: 6px;
  font-size: 12px;
  color: #8b9bb5;
}
.a-badges {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.side-badge {
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 800;
  line-height: 1.2;
  color: #fff;
}
.side-badge.long {
  background: #4ade80;
}
.side-badge.short {
  background: #f87171;
}
.action-badge {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  border: 1px solid #2a3544;
  color: #b0c4de;
}
.action-badge.action-open {
  color: #4ade80;
  border-color: color-mix(in srgb, #4ade80 40%, #2a3544);
}
.action-badge.action-close {
  color: #f87171;
  border-color: color-mix(in srgb, #f87171 40%, #2a3544);
}
.a-coin {
  font-size: 12px;
  font-weight: 800;
  color: #e8edf5;
}
.a-usd {
  font-size: 13px;
  font-weight: 700;
  flex-shrink: 0;
}
.a-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 70%;
}
.m-empty {
  text-align: center;
  color: #6a7e9c;
  font-size: 13px;
  padding: 24px 8px;
}
.m-pager {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.pg {
  border: 0;
  border-radius: 999px;
  padding: 4px 12px;
  background: #1a222e;
  color: #b0c4de;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
}
.pg:disabled {
  opacity: 0.4;
}
.pg-info {
  font-size: 12px;
  color: #e8edf5;
  font-weight: 600;
}
</style>
